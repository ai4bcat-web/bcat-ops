/**
 * Move to manual invoice — for a load OTR rejected (Ryne 2026-11-14, changed 2026-11-19).
 *
 * One press does what the office did by hand across three screens:
 *   1. the invoice STAYS on the books. It was sent, so it is owed until a payment, credit, write-off or void
 *      ends it, whatever OTR did (Ryne 2026-11-19). It used to be voided and the load put back in Ready to
 *      invoice, which took the receivable out of Open AR until a replacement was sent. Now it is changed in
 *      place: no longer factored, its remit-to is ours, its PDF is redrawn without the OTR stamp, and, if it
 *      had been e-mailed telling the customer to pay the factor, it becomes the next revision so the office
 *      sends the corrected copy. An order with no invoice yet simply goes back on the UNBILLED rung;
 *   2. the customer's payment method becomes Manual (billingMethod MANUAL, factored false),
 *      so the invoice — and every bill after it — prints our remit-to and is e-mailed to the customer's AP;
 *   3. the reason is kept on the customer: a line at the top of its notes, and the AuditLog
 *      change (History tab) with before/after for each field and the same sentence as reason.
 * The queue row is archived, so it leaves OTR rejected; its OTR reason stays on it, and the
 * shipment page keeps showing it.
 *
 * Refused unless OTR actually turned the row down (`isOtrRejected`, recomputed here from
 * the row, never trusted from the page), and when the invoice is already paid.
 */
import { assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { auditCustomerChange } from '../_shared/customerAudit'
import { isOtrRejected, otrRejectionReason } from '../../../src/lib/otrRejection'
import { manualInvoiceChangeNote, notesWithChange } from '../../../src/lib/manualInvoiceMove'
import type { FactoringItem } from '../../../src/types'
import {
  CUSTOMER_TABLE_NAME,
  FACTORING_ITEM_TABLE_NAME,
  INVOICE_TABLE_NAME,
  LOAD_TABLE_NAME,
  ORDER_TABLE_NAME,
  getById,
  getDivision,
  getSettings,
  nowIso,
  numberOrNull,
  transact,
  updateTx,
  writeAudit,
  type Row,
} from './store'
import { rerenderInvoicePdf } from './invoices'
import { remitToFor } from '../../../src/lib/invoiceBuild'
import { factorItemWasSubmitted, isOutstandingInvoice } from '../../../src/lib/invoiceOutstanding'

export async function moveToManualInvoice(input: Row, caller: Caller): Promise<Row> {
  const itemId = assertString(input.factoringItemId, 'factoringItemId')
  const itemRow = await getById(FACTORING_ITEM_TABLE_NAME, itemId)
  if (!itemRow) throw new Error(`Factoring row not found: ${itemId}`)
  const item = itemRow as unknown as FactoringItem
  if (!isOtrRejected(item)) throw new Error(`PRO ${item.proNumber} is not rejected by OTR; it stays on the factoring queue`)
  const otrReason = otrRejectionReason(item) ?? 'OTR rejected it'

  const load = item.loadId ? await getById(LOAD_TABLE_NAME, String(item.loadId)) : null
  const orderId = optionalString(item.orderId, 100) ?? optionalString(load?.orderId, 100)
  const order = orderId ? await getById(ORDER_TABLE_NAME, orderId) : null
  if (!order) throw new Error(`PRO ${item.proNumber} has no order in BCAT Ops to put back in Ready to invoice`)
  const customerId = optionalString(order.customerId, 100) ?? optionalString(item.customerId, 100)
  const customer = customerId ? await getById(CUSTOMER_TABLE_NAME, customerId) : null
  if (!customer) throw new Error(`PRO ${item.proNumber} has no customer record to change to manual invoice`)

  const now = nowIso()
  const note = manualInvoiceChangeNote({ at: now, by: caller.email, pro: item.proNumber, reason: otrReason })

  // 1. The invoice stays owed. A live invoice is changed in place (below, in the same transaction as the customer and the
  //    queue row); only an order that has no live invoice goes back on the UNBILLED rung.
  const invoiceId = optionalString(order.invoiceId, 100)
  const invoice = invoiceId ? await getById(INVOICE_TABLE_NAME, invoiceId) : null
  const keepInvoice = Boolean(invoice && isOutstandingInvoice({ status: invoice.status as never, balanceCents: numberOrNull(invoice.balanceCents) ?? 0 }))
  const invoiceWrites: ReturnType<typeof updateTx>[] = []
  let keptInvoiceId: string | null = null
  if (invoice && keepInvoice) {
    // Changing a live invoice's billing was always an admin act (it was a void); the permission is unchanged.
    if (!caller.isAdmin) throw new Error('Forbidden: only an admin can move a live invoice to manual invoice')
    const division = invoice.divisionKey ? await getDivision(String(invoice.divisionKey)) : null
    const settings = await getSettings()
    const remitTo = remitToFor(division as never, { billingMethod: 'MANUAL', factored: false }, settings as never)
    const sentToCustomer = Boolean(invoice.sentAt || invoice.markedSentAt || (numberOrNull(invoice.sentCount) ?? 0) > 0)
    // What the OTR leg was, kept on the invoice itself: the queue row is archived and the invoice drops its pointer to it.
    const handedToOtr = factorItemWasSubmitted(item) || Boolean(invoice.factorSubmittedAt)
    keptInvoiceId = String(invoice.id)
    invoiceWrites.push(updateTx(
      INVOICE_TABLE_NAME,
      keptInvoiceId,
      {
        factored: false,
        remitTo,
        // The copy the customer holds told them to pay the factor: this is the corrected one.
        ...(sentToCustomer ? { revision: (numberOrNull(invoice.revision) ?? 1) + 1 } : {}),
        ...(handedToOtr && !invoice.factorSubmittedAt ? { factorSubmittedAt: String(item.otrSubmittedAt ?? now) } : {}),
        updatedAt: now,
        updatedBy: caller.email,
        version: (numberOrNull(invoice.version) ?? 1) + 1,
      },
      {
        remove: ['factoringItemId'],
        // Still owed, and nobody paid or voided it between the read and this write.
        condition: 'attribute_exists(id) AND (#st = :issued OR #st = :partial)',
        extraValues: { ':issued': { S: 'ISSUED' }, ':partial': { S: 'PARTIAL' } },
      },
    ))
    const written = invoiceWrites[0].Update
    if (written?.ExpressionAttributeNames) written.ExpressionAttributeNames['#st'] = 'status'
    if (order.factoringItemId) {
      invoiceWrites.push(updateTx(ORDER_TABLE_NAME, String(order.id), { updatedAt: now, updatedBy: caller.email, version: (numberOrNull(order.version) ?? 1) + 1 }, { remove: ['factoringItemId'] }))
    }
  } else if (order.arStatus !== 'UNBILLED' || order.invoiceId) {
    if (invoice && invoice.status === 'PAID') throw new Error(`Invoice ${String(invoice.number ?? invoice.id)} is already paid; there is nothing to re-invoice`)
    await transact([updateTx(ORDER_TABLE_NAME, String(order.id), {
      arStatus: 'UNBILLED',
      arStatusChangedAt: now,
      readyToInvoiceAt: now,
      updatedAt: now,
      updatedBy: caller.email,
      version: (numberOrNull(order.version) ?? 1) + 1,
    }, { remove: ['invoiceId', 'invoiceNumber', 'invoicedAt', 'arBalanceCents', 'factoringItemId'] })], 'order back to ready to invoice')
  }

  // 2 + 3. The customer's payment method and the reason, through the customer audit helper.
  const before: Row = { billingMethod: customer.billingMethod ?? null, factored: customer.factored ?? null, notes: customer.notes ?? null }
  const after: Row = { billingMethod: 'MANUAL', factored: false, notes: notesWithChange(optionalString(customer.notes, 10_000), note) }
  await transact([
    ...invoiceWrites,
    updateTx(CUSTOMER_TABLE_NAME, String(customer.id), { ...after, updatedAt: now }),
    // The queue row leaves OTR rejected; its OTR reason stays on it for the shipment page.
    updateTx(FACTORING_ITEM_TABLE_NAME, itemId, { status: 'ARCHIVED', updatedAt: now }),
  ], 'manual invoice move')
  await auditCustomerChange(
    (entityType, entityId, action, changes) => writeAudit(entityType, entityId, action, caller, changes),
    { customerId: String(customer.id), before, after, source: 'OTR rejected → manual invoice', reason: note, name: String(customer.name ?? '') },
  )
  await writeAudit('FactoringItem', itemId, 'MOVE_TO_MANUAL_INVOICE', caller, {
    proNumber: item.proNumber, otrReason, orderId: order.id, customerId: customer.id, keptInvoice: keptInvoiceId,
    statusBefore: item.status,
  })
  // The PDF prints the remit-to and the OTR stamp, so it is redrawn now that the invoice is ours to collect. Best effort like
  // every issue path: a failure leaves the invoice owed with its old PDF, repaired by Regenerate PDF.
  if (keptInvoiceId) await rerenderInvoicePdf(keptInvoiceId, caller).catch(() => undefined)
  // `voidedInvoice` stays in the answer, always null now: the invoice is no longer voided.
  return { proNumber: item.proNumber, orderId: order.id, customerId: customer.id, voidedInvoice: null, keptInvoiceId, note }
}
