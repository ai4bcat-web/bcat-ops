/**
 * Change how an unsent invoice is billed — factored or by hand — and keep drafts in step with the customer
 * (Ryne 2026-11-16: "I changed the customer profile to manually invoice, but it's still showing as factor").
 *
 * An invoice copies its customer's billing method when it is made: the printed remit-to, `Invoice.factored`, the
 * factoring queue row and the order's pointer to that row. Editing the customer afterwards changed none of them, so
 * a draft kept saying "Factor next" for a customer who is now billed by hand. Two actions fix that:
 *
 *   SET_INVOICE_METHOD   one invoice, from the "Change method" link: this invoice only (pinned, a later customer edit
 *                        leaves it) or the customer's profile too.
 *   SYNC_CUSTOMER_METHOD every unsent draft of one customer follows the customer's current method; the customer save
 *                        in the app calls it. Pinned drafts, and anything sent, paid or already with OTR, are left alone.
 *
 * To MANUAL the queue row is ARCHIVED (the same park the OTR-rejected move uses), the invoice loses `factored` and its
 * pointer to the row, the order loses its pointer, and the remit-to is the one `remitToFor` gives a manual invoice. To
 * FACTOR the existing Send to Factor does the work (gate, queue row, re-address). Neither e-mails anyone or calls OTR;
 * the PDF is redrawn because it prints the remit-to.
 */
import { assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { auditCustomerChange } from '../_shared/customerAudit'
import { remitToFor } from '../../../src/lib/invoiceBuild'
import {
  METHOD_FOLLOWED_CUSTOMER,
  METHOD_PIN_FACTOR,
  METHOD_PIN_MANUAL,
  currentInvoiceMethod,
  isMethodPinned,
  methodChangeBlocker,
  methodForLoad,
  type InvoiceMethod,
} from '../../../src/lib/invoiceMethod'
import { apEmailList, type ApEmailFields } from '../../../src/lib/apEmails'
import type { InvoiceRecord } from '../../../src/types/tms'
import {
  CUSTOMER_TABLE_NAME,
  FACTORING_ITEM_TABLE_NAME,
  IDX_LOADS_BY_SHIPMENT,
  INVOICE_TABLE_NAME,
  LOAD_TABLE_NAME,
  NULL_TYPE_VALUE,
  ORDER_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  getById,
  getDivision,
  getSettings,
  nowIso,
  numberOrNull,
  queryIndex,
  transact,
  unsetCondition,
  updateTx,
  writeAudit,
  type Row,
} from './store'
import { rerenderInvoicePdf } from './invoices'
import { sendToFactor } from './factor'

const IDX_INVOICES_BY_CUSTOMER = 'invoicesByCustomerIdAndIssuedAt'

const METHODS: readonly InvoiceMethod[] = ['FACTOR', 'MANUAL']

function assertMethod(value: unknown): InvoiceMethod {
  const method = typeof value === 'string' ? (value.trim().toUpperCase() as InvoiceMethod) : null
  if (!method || !METHODS.includes(method)) throw new Error('method must be FACTOR or MANUAL')
  return method
}

/**
 * The queue row for this invoice: the one it points at, else the one filed under its load's PRO (the row id Send to Factor
 * uses). A row already parked or pinned has no pointer left, so the PRO is how a later sync finds it again.
 */
async function queueRowOf(invoice: Row, shipment: Row | null): Promise<Row | null> {
  const ids = new Set<string>()
  const pointer = optionalString(invoice.factoringItemId, 100)
  if (pointer) ids.add(pointer)
  if (invoice.shipmentId) {
    const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', String(invoice.shipmentId))
    for (const load of loads) {
      const pro = optionalString(load.aljexId, 100)
      if (pro && (!load.orderId || load.orderId === invoice.orderId)) ids.add(pro)
    }
  }
  for (const id of [optionalString(shipment?.number, 100), optionalString(invoice.shipmentNumber, 100)]) if (id) ids.add(id)
  for (const id of ids) {
    const row = await getById(FACTORING_ITEM_TABLE_NAME, id)
    if (row && (!row.invoiceId || row.invoiceId === invoice.id)) return row
  }
  return null
}

export interface MethodChange {
  invoiceId: string
  number: string
  from: InvoiceMethod
  to: InvoiceMethod
  warnings: string[]
}

/** Put one unsent draft on the manual path. Writes nothing when it already is. */
async function alignToManual(invoice: Row, order: Row | null, item: Row | null, pin: 'invoice' | 'customer', caller: Caller): Promise<boolean> {
  const alreadyManual = currentInvoiceMethod({ factored: invoice.factored as boolean | null, factoringItemId: optionalString(invoice.factoringItemId, 100) }) === 'MANUAL'
  const division = invoice.divisionKey ? await getDivision(String(invoice.divisionKey)) : null
  const settings = await getSettings()
  const remitTo = remitToFor(division as never, { billingMethod: 'MANUAL', factored: false }, settings as never)
  const now = nowIso()
  const reason = pin === 'invoice' ? METHOD_PIN_MANUAL : METHOD_FOLLOWED_CUSTOMER

  const writes = []
  if (!alreadyManual) {
    writes.push(
      updateTx(
        INVOICE_TABLE_NAME,
        String(invoice.id),
        { factored: false, remitTo, updatedAt: now, updatedBy: caller.email, version: (numberOrNull(invoice.version) ?? 1) + 1 },
        {
          remove: ['factoringItemId'],
          // Still a draft: not voided or paid meanwhile, and nobody e-mailed it between the read and this write.
          condition: `attribute_exists(id) AND #st = :issued AND ${unsetCondition('sentAt')} AND ${unsetCondition('markedSentAt')}`,
          extraValues: { ':issued': { S: 'ISSUED' }, ':nullType': NULL_TYPE_VALUE },
        },
      ),
    )
    if (order && order.factoringItemId) {
      writes.push(updateTx(ORDER_TABLE_NAME, String(order.id), { updatedAt: now, updatedBy: caller.email, version: (numberOrNull(order.version) ?? 1) + 1 }, { remove: ['factoringItemId'] }))
    }
  }
  if (item && (item.status !== 'ARCHIVED' || item.manualReason !== reason)) {
    writes.push(
      updateTx(FACTORING_ITEM_TABLE_NAME, String(item.id), { status: 'ARCHIVED', manualReason: reason, updatedAt: now }, { remove: ['otrError'] }),
    )
  }
  if (writes.length === 0) return false
  // The invoice update's condition names the status attribute.
  const invoiceWrite = writes[0].Update
  if (!alreadyManual && invoiceWrite?.ExpressionAttributeNames) invoiceWrite.ExpressionAttributeNames['#st'] = 'status'
  await transact(writes, 'invoice to manual')
  await writeAudit('Invoice', String(invoice.id), 'SET_INVOICE_METHOD', caller, {
    to: 'MANUAL',
    from: alreadyManual ? 'MANUAL' : 'FACTOR',
    pinned: pin === 'invoice',
    factoringItemId: item ? String(item.id) : null,
    remitToWas: (invoice.remitTo as Row | undefined)?.name ?? null,
    remitToNow: remitTo.name || null,
  })
  if (!alreadyManual) await rerenderInvoicePdf(String(invoice.id), caller).catch(() => undefined)
  return !alreadyManual
}

/** Put one unsent draft through the factor with the ordinary Send to Factor (its gate, its queue row, its re-address). */
async function alignToFactor(invoice: Row, item: Row | null, pin: 'invoice' | 'customer', caller: Caller): Promise<boolean> {
  const alreadyFactor = currentInvoiceMethod({ factored: invoice.factored as boolean | null, factoringItemId: optionalString(invoice.factoringItemId, 100) }) === 'FACTOR'
  if (!alreadyFactor || (item && item.status === 'ARCHIVED')) {
    await sendToFactor({ invoiceId: String(invoice.id) }, caller)
  }
  if (pin === 'invoice') {
    const fresh = (await getById(INVOICE_TABLE_NAME, String(invoice.id))) ?? invoice
    const row = fresh.factoringItemId ? await getById(FACTORING_ITEM_TABLE_NAME, String(fresh.factoringItemId)) : null
    if (row && row.status === 'NEED_TO_FACTOR' && row.manualReason !== METHOD_PIN_FACTOR) {
      await transact([updateTx(FACTORING_ITEM_TABLE_NAME, String(row.id), { manualReason: METHOD_PIN_FACTOR, updatedAt: nowIso() })], 'pin factor')
    }
  } else {
    const fresh = (await getById(INVOICE_TABLE_NAME, String(invoice.id))) ?? invoice
    const row = fresh.factoringItemId ? await getById(FACTORING_ITEM_TABLE_NAME, String(fresh.factoringItemId)) : null
    // Following the customer: a pin left by an earlier "this invoice only" choice is cleared.
    if (row && isMethodPinned(row as never)) {
      await transact([updateTx(FACTORING_ITEM_TABLE_NAME, String(row.id), { updatedAt: nowIso() }, { remove: ['manualReason'] })], 'unpin')
    }
  }
  return !alreadyFactor || Boolean(item && item.status === 'ARCHIVED')
}

/** What the person should know after a switch to MANUAL: the e-mail address it needs, and a remit-to that is still blank. */
function manualWarnings(customer: Row | null, invoice: Row): string[] {
  const out: string[] = []
  if (customer && apEmailList(customer as unknown as ApEmailFields).length === 0) {
    out.push(`${String(customer.name ?? 'This customer')} has no AP e-mail on file, so this invoice cannot be e-mailed yet.`)
  }
  const remit = invoice.remitTo as Row | undefined
  if (!remit || !String(remit.name ?? '').trim()) {
    out.push('No remit-to is set for this division (Settings, Divisions), so the invoice prints no "pay to" line.')
  }
  return out
}

export async function setInvoiceMethod(input: Row, caller: Caller): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const method = assertMethod(input.method)
  const scope = input.scope === 'invoice' ? 'invoice' : 'customer'

  const invoice = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`)
  const [order, shipment, customer] = await Promise.all([
    invoice.orderId ? getById(ORDER_TABLE_NAME, String(invoice.orderId)) : Promise.resolve(null),
    invoice.shipmentId ? getById(SHIPMENT_TABLE_NAME, String(invoice.shipmentId)) : Promise.resolve(null),
    invoice.customerId ? getById(CUSTOMER_TABLE_NAME, String(invoice.customerId)) : Promise.resolve(null),
  ])
  const item = await queueRowOf(invoice, shipment)
  const blocker = methodChangeBlocker(invoice as unknown as InvoiceRecord, item as never)
  if (blocker) throw new Error(blocker)

  const from = currentInvoiceMethod({ factored: invoice.factored as boolean | null, factoringItemId: optionalString(invoice.factoringItemId, 100) })
  const changed = method === 'MANUAL'
    ? await alignToManual(invoice, order, item, scope, caller)
    : await alignToFactor(invoice, item, scope, caller)

  // The customer's profile follows only when asked: "this invoice only" never touches it.
  let customerChanged = false
  if (scope === 'customer' && customer) {
    const now = nowIso()
    const before: Row = { billingMethod: customer.billingMethod ?? null, factored: customer.factored ?? null }
    const after: Row = method === 'MANUAL' ? { billingMethod: 'MANUAL', factored: false } : { billingMethod: 'FACTOR', factored: true }
    if (before.billingMethod !== after.billingMethod || before.factored !== after.factored) {
      await transact([updateTx(CUSTOMER_TABLE_NAME, String(customer.id), { ...after, updatedAt: now, updatedBy: caller.email })], 'customer method')
      await auditCustomerChange(
        (entityType, entityId, action, changes) => writeAudit(entityType, entityId, action, caller, changes),
        {
          customerId: String(customer.id),
          before,
          after,
          source: 'Change method on an invoice',
          reason: `Invoice ${String(invoice.number)} switched to ${method === 'MANUAL' ? 'manual invoice' : 'the factor'}`,
          name: String(customer.name ?? ''),
        },
      )
      customerChanged = true
    }
  }

  const fresh = (await getById(INVOICE_TABLE_NAME, invoiceId)) ?? invoice
  return {
    invoice: fresh,
    changed,
    customerChanged,
    from,
    to: method,
    warnings: method === 'MANUAL' ? manualWarnings(customer, fresh) : [],
  }
}

/**
 * Every unsent draft of this customer follows the customer's current method. A draft whose method somebody chose by hand,
 * anything sent, paid or with OTR, and anything a switch refuses (a FACTOR the gate will not take) is left as it is and
 * listed under `skipped` with the reason.
 */
export async function syncCustomerMethod(input: Row, caller: Caller): Promise<Row> {
  const customerId = assertString(input.customerId, 'customerId')
  const customer = await getById(CUSTOMER_TABLE_NAME, customerId)
  if (!customer) throw new Error(`Customer not found: ${customerId}`)

  const invoices = await queryIndex(INVOICE_TABLE_NAME, IDX_INVOICES_BY_CUSTOMER, 'customerId', customerId)
  const changed: MethodChange[] = []
  const skipped: { invoiceId: string; why: string }[] = []

  for (const invoice of invoices) {
    if (invoice.status !== 'ISSUED') continue
    const shipment = invoice.shipmentId ? await getById(SHIPMENT_TABLE_NAME, String(invoice.shipmentId)) : null
    const item = await queueRowOf(invoice, shipment)
    if (methodChangeBlocker(invoice as unknown as InvoiceRecord, item as never)) continue // not a draft: its method is a fact
    if (isMethodPinned(item as never)) {
      skipped.push({ invoiceId: String(invoice.id), why: 'Its method was chosen for this invoice only' })
      continue
    }
    const want = methodForLoad(customer as never, shipment?.revDivision as string | null | undefined)
    const have = currentInvoiceMethod({ factored: invoice.factored as boolean | null, factoringItemId: optionalString(invoice.factoringItemId, 100) })
    // An archived row on a manual invoice that already matches needs nothing.
    if (want === have && !(want === 'FACTOR' && item?.status === 'ARCHIVED')) continue
    try {
      const order = invoice.orderId ? await getById(ORDER_TABLE_NAME, String(invoice.orderId)) : null
      const moved = want === 'MANUAL' ? await alignToManual(invoice, order, item, 'customer', caller) : await alignToFactor(invoice, item, 'customer', caller)
      if (moved) {
        const fresh = (await getById(INVOICE_TABLE_NAME, String(invoice.id))) ?? invoice
        changed.push({ invoiceId: String(invoice.id), number: String(invoice.number ?? invoice.id), from: have, to: want, warnings: want === 'MANUAL' ? manualWarnings(customer, fresh) : [] })
      }
    } catch (err) {
      skipped.push({ invoiceId: String(invoice.id), why: err instanceof Error ? err.message : String(err) })
    }
  }
  return { customerId, changed, skipped }
}
