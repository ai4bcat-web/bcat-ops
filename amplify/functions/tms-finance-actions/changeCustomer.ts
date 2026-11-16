/**
 * CHANGE_INVOICE_CUSTOMER (Ryne 2026-11-16): the invoice went to the wrong customer. Move it, and its shipment,
 * to the right one IN PLACE — same invoice number, same lines and amount, same invoice date — re-deriving what
 * follows the customer (bill-to, terms, due date, remit-to, factored) the way GENERATE_INVOICE does
 * (src/lib/invoiceCustomerChange.ts). A sent invoice becomes 'Rev N'. Nothing is e-mailed here; the screen
 * opens the normal send review and a person presses Send.
 *
 * Refused when money is applied (credit memo + replacement instead), when the invoice is void or carried over
 * from Aljex, and once it is with OTR. An unsubmitted factoring row follows the customer: kept and retargeted
 * when the new customer is factored too, parked (ARCHIVED, unlinked — what a void does) when the new customer is
 * billed by hand. A newly factored invoice with no row waits for Factor, which makes one.
 *
 * The moving-the-whole-shipment-with-a-credit-memo path is still REPOINT_INVOICED_CUSTOMER (repoint.ts).
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { assertString, optionalString, type Caller } from '../_shared/actionInputs'
import {
  invoiceCustomerChangeRefusal,
  planInvoiceCustomerChange,
  retargetSearchKey,
  targetCustomerRefusal,
  type ChangeFactoringRow,
  type ChangeInvoice,
  type ChangeTarget,
} from '../../../src/lib/invoiceCustomerChange'
import type { Division, TmsSettings } from '../../../src/types/tms'
import {
  CUSTOMER_TABLE_NAME,
  FACTORING_ITEM_TABLE_NAME,
  IDX_LOADS_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  INVOICE_TABLE_NAME,
  LOAD_TABLE_NAME,
  ORDER_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  getById,
  getDivision,
  getSettings,
  nowIso,
  numberOrNull,
  queryIndex,
  transact,
  updateTx,
  writeAudit,
  type Row,
} from './store'
import { rerenderInvoicePdf } from './invoices'

const MAX_REASON = 1000

function versionCondition(row: Row): { condition: string; extraValues?: Record<string, { N: string }> } {
  const version = numberOrNull(row.version)
  return version != null
    ? { condition: 'version = :priorVersion', extraValues: { ':priorVersion': { N: String(version) } } }
    : { condition: 'attribute_exists(id)' }
}

export async function changeInvoiceCustomer(input: Row, caller: Caller): Promise<Row> {
  const invoiceId = assertString(input.invoiceId, 'invoiceId')
  const customerId = assertString(input.customerId, 'customerId')
  const billToId = optionalString(input.billToId, 64) ?? null
  const reason = optionalString(input.reason, MAX_REASON)
  if (!reason) throw new Error('Changing the customer needs a reason')

  const invoiceRow = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!invoiceRow) throw new Error(`Invoice not found: ${invoiceId}`)
  const invoice = invoiceRow as unknown as ChangeInvoice & { orderId: string; shipmentId: string; version?: number | null; divisionKey?: string | null }

  const factoringRow = invoice.factoringItemId
    ? ((await getById(FACTORING_ITEM_TABLE_NAME, invoice.factoringItemId)) as unknown as (ChangeFactoringRow & Row) | null)
    : null
  const refusal = invoiceCustomerChangeRefusal(invoice, factoringRow)
  if (refusal) throw new Error(refusal)

  const targetRow = await getById(CUSTOMER_TABLE_NAME, customerId)
  const target = targetRow as unknown as ChangeTarget | null
  const targetRefusal = targetCustomerRefusal(invoice, target ? { ...target, id: customerId, name: String(target.name ?? customerId) } : null, billToId)
  if (targetRefusal) throw new Error(targetRefusal)
  const targetCustomer = { ...(target as ChangeTarget), id: customerId, name: String(target!.name ?? customerId) }

  const [order, shipment, settings] = await Promise.all([
    getById(ORDER_TABLE_NAME, invoice.orderId),
    getById(SHIPMENT_TABLE_NAME, invoice.shipmentId),
    getSettings(),
  ])
  if (!order) throw new Error(`Order not found: ${invoice.orderId}`)
  if (!shipment) throw new Error(`Shipment not found: ${invoice.shipmentId}`)
  if (order.invoiceId !== invoiceId) throw new Error('This invoice is no longer the bill on its order; refresh and try again')
  const division = invoice.divisionKey ? ((await getDivision(invoice.divisionKey)) as unknown as Division | null) : null

  const plan = planInvoiceCustomerChange({
    invoice,
    target: targetCustomer,
    billToId,
    revDivision: (shipment.revDivision as string | null | undefined) ?? null,
    division,
    settings: settings as unknown as TmsSettings | null,
    factoringRow,
  })

  const now = nowIso()
  const writes: TransactWriteItem[] = []

  // The invoice: who it is owed by and what follows from that. Number, lines, amount and dates stay.
  const invoicePatch: Row = {
    customerId: plan.customerId,
    customerName: plan.customerName,
    billTo: plan.billTo as unknown as Row,
    termsDays: plan.termsDays,
    termsText: plan.termsText,
    dueAt: plan.dueAt,
    remitTo: plan.remitTo as unknown as Row,
    factored: plan.factored,
    revision: plan.revision,
    updatedAt: now,
    updatedBy: caller.email,
    version: (numberOrNull(invoice.version) ?? 1) + 1,
  }
  if (plan.billToId) invoicePatch.billToId = plan.billToId
  const invoiceRemove: string[] = []
  if (!plan.billToId) invoiceRemove.push('billToId')
  if (plan.factoring === 'ARCHIVE') invoiceRemove.push('factoringItemId')
  const invVersion = versionCondition(invoiceRow)
  writes.push(updateTx(INVOICE_TABLE_NAME, invoiceId, invoicePatch, {
    remove: invoiceRemove,
    condition: `${invVersion.condition} AND paidCents = :zero AND writtenOffCents = :zero`,
    extraValues: { ...(invVersion.extraValues ?? {}), ':zero': { N: '0' } },
  }))

  // The order the bill is for.
  const orderPatch: Row = {
    customerId: plan.customerId,
    customerName: plan.customerName,
    updatedAt: now,
    updatedBy: caller.email,
    version: (numberOrNull(order.version) ?? 1) + 1,
  }
  if (plan.billToId) orderPatch.billToId = plan.billToId
  const orderRemove: string[] = []
  if (!plan.billToId) orderRemove.push('billToId')
  if (plan.factoring === 'ARCHIVE') orderRemove.push('factoringItemId')
  const ordVersion = versionCondition(order)
  writes.push(updateTx(ORDER_TABLE_NAME, String(order.id), orderPatch, {
    remove: orderRemove,
    condition: `${ordVersion.condition} AND invoiceId = :invoiceId`,
    extraValues: { ...(ordVersion.extraValues ?? {}), ':invoiceId': { S: invoiceId } },
  }))

  // The shipment and its loads follow when every one of its orders now names the new customer. A shipment
  // split across customers (one order each) keeps its header and only this order's loads move.
  const orders = await queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', invoice.shipmentId)
  const wholeShipment = orders.every((row) => String(row.id) === String(order.id) || String(row.customerId ?? '') === plan.customerId)
  if (wholeShipment) {
    const shpVersion = versionCondition(shipment)
    writes.push(updateTx(SHIPMENT_TABLE_NAME, String(shipment.id), {
      customerId: plan.customerId,
      customerName: plan.customerName,
      searchKey: retargetSearchKey(shipment.searchKey as string | null, shipment.customerName as string | null, plan.customerName),
      updatedAt: now,
      updatedBy: caller.email,
      version: (numberOrNull(shipment.version) ?? 1) + 1,
    }, { condition: shpVersion.condition, extraValues: shpVersion.extraValues }))
  }
  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', invoice.shipmentId)
  for (const load of loads) {
    if (!wholeShipment && load.orderId != null && String(load.orderId) !== String(order.id)) continue
    writes.push(updateTx(LOAD_TABLE_NAME, String(load.id), {
      customerId: plan.customerId,
      customer: plan.customerName,
      updatedAt: now,
      updatedBy: caller.email,
    }, { condition: 'attribute_exists(id)' }))
  }

  // The factoring queue row, only while nothing has been submitted to OTR (the refusal above made sure).
  if (factoringRow && plan.factoring === 'RETARGET') {
    writes.push(updateTx(FACTORING_ITEM_TABLE_NAME, String(factoringRow.id), { customerId: plan.customerId, updatedAt: now }, {
      condition: '(attribute_not_exists(otrInvoiceId) OR attribute_type(otrInvoiceId, :nullType))',
      extraValues: { ':nullType': { S: 'NULL' } },
    }))
  }
  if (factoringRow && plan.factoring === 'ARCHIVE') {
    writes.push(updateTx(FACTORING_ITEM_TABLE_NAME, String(factoringRow.id), { status: 'ARCHIVED', updatedAt: now }, {
      remove: ['invoiceId'],
      condition: '(attribute_not_exists(otrInvoiceId) OR attribute_type(otrInvoiceId, :nullType))',
      extraValues: { ':nullType': { S: 'NULL' } },
    }))
  }

  await transact(writes, 'change invoice customer')
  await writeAudit('Invoice', invoiceId, 'CHANGE_INVOICE_CUSTOMER', caller, {
    reason,
    before: {
      customerId: invoice.customerId,
      customerName: invoice.customerName ?? null,
      billToId: invoice.billToId ?? null,
      termsDays: invoice.termsDays ?? null,
      dueAt: invoice.dueAt ?? null,
      factored: invoice.factored === true,
      revision: invoice.revision ?? 1,
    },
    after: {
      customerId: plan.customerId,
      customerName: plan.customerName,
      billToId: plan.billToId,
      termsDays: plan.termsDays,
      dueAt: plan.dueAt,
      factored: plan.factored,
      revision: plan.revision,
    },
    factoring: plan.factoring,
    factoringItemId: factoringRow?.id ?? null,
    wholeShipment,
  })

  // The PDF is re-rendered for the new bill-to; a renderer failure leaves the invoice changed and repairable
  // (Regenerate PDF), the same as every other issue path.
  const fresh = await rerenderInvoicePdf(invoiceId, caller)
  return { invoice: fresh, plan: plan as unknown as Row, wholeShipment }
}
