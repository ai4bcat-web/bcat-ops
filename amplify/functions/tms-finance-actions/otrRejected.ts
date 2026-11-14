/**
 * Move to manual invoice — for a load OTR rejected (Ryne 2026-11-14).
 *
 * One press does what the office did by hand across three screens:
 *   1. the load goes back to Ready to invoice: a live invoice that told the customer to pay
 *      the factor is voided (an admin act, through the ordinary void), otherwise the order
 *      is simply put back on the UNBILLED rung;
 *   2. the customer's payment method becomes Manual (billingMethod MANUAL, factored false),
 *      so the re-issued bill — and every bill after it — prints our remit-to and is e-mailed
 *      to the customer's AP;
 *   3. the reason is kept on the customer: a line at the top of its notes, and the AuditLog
 *      change (History tab) with before/after for each field and the same sentence as reason.
 * The queue row is archived, so it leaves OTR rejected; its OTR reason stays on it, and the
 * shipment page keeps showing it.
 *
 * Refused unless OTR actually turned the row down (`isOtrRejected`, recomputed here from
 * the row, never trusted from the page), and when money was already taken on the invoice.
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
  nowIso,
  numberOrNull,
  transact,
  updateTx,
  writeAudit,
  type Row,
} from './store'
import { voidInvoice } from './invoices'

const LIVE_INVOICE = new Set(['ISSUED', 'PARTIAL', 'DRAFT'])

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

  // 1. Back to Ready to invoice. A live invoice is voided by the ordinary void (admin only, refuses money
  //    taken); OTR has already turned this bill down, so its OTR invoice id does not hold the void back.
  const invoiceId = optionalString(order.invoiceId, 100)
  const invoice = invoiceId ? await getById(INVOICE_TABLE_NAME, invoiceId) : null
  let voided: string | null = null
  if (invoice && LIVE_INVOICE.has(String(invoice.status ?? ''))) {
    await voidInvoice({ invoiceId: String(invoice.id), reason: note }, caller, { otrRejected: true })
    voided = String(invoice.number ?? invoice.id)
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
    updateTx(CUSTOMER_TABLE_NAME, String(customer.id), { ...after, updatedAt: now }),
    // The queue row leaves OTR rejected; its OTR reason stays on it for the shipment page.
    updateTx(FACTORING_ITEM_TABLE_NAME, itemId, { status: 'ARCHIVED', updatedAt: now }),
  ], 'manual invoice move')
  await auditCustomerChange(
    (entityType, entityId, action, changes) => writeAudit(entityType, entityId, action, caller, changes),
    { customerId: String(customer.id), before, after, source: 'OTR rejected → manual invoice', reason: note, name: String(customer.name ?? '') },
  )
  await writeAudit('FactoringItem', itemId, 'MOVE_TO_MANUAL_INVOICE', caller, {
    proNumber: item.proNumber, otrReason, orderId: order.id, customerId: customer.id, voidedInvoice: voided,
    statusBefore: item.status,
  })
  return { proNumber: item.proNumber, orderId: order.id, customerId: customer.id, voidedInvoice: voided, note }
}
