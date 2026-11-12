/**
 * OTR funded it, so the customer's invoice is paid.
 *
 * A factored invoice is paid by OTR, not the customer: when OTR's board says Approved the
 * factoring row turns FACTORED (otr-actions sync). This pass finds open invoices whose
 * factoring row is FACTORED and posts one FACTOR payment for the balance, dated the day OTR
 * funded it and referenced by OTR's invoice id.
 *
 * Idempotent by construction: the payment id is derived from the invoice id, so a second
 * pass (or a person pressing the button while the schedule runs) finds it already posted.
 * Reads open invoices through the `arOpen` index rather than scanning the factoring table.
 */
import { FACTORING_ITEM_TABLE_NAME, INVOICE_TABLE_NAME, getById, numberOrNull, queryIndex, type Row } from './store'
import { recordPayment } from './payments'
import type { Caller } from '../_shared/actionInputs'

export const SYSTEM_CALLER: Caller = { email: 'system:otr-funded', sub: 'system', groups: [], isAdmin: true }

export interface SettleResult {
  checked: number
  settled: { invoiceId: string; number: string | null; amountCents: number; otrInvoiceId: string | null }[]
  failed: { invoiceId: string; error: string }[]
}

/** The day OTR funded it: when the row turned FACTORED, else when its status was last synced. */
export function fundedDateOf(item: Row): string {
  const at = [item.factoredAt, item.otrStatusSyncedAt, item.updatedAt].find((v) => typeof v === 'string' && v)
  return String(at ?? new Date().toISOString()).slice(0, 10)
}

export async function settleFactoredInvoices(caller: Caller = SYSTEM_CALLER): Promise<SettleResult> {
  const open = await queryIndex(INVOICE_TABLE_NAME, 'invoicesByArOpenAndDueAt', 'arOpen', 'OPEN')
  const result: SettleResult = { checked: 0, settled: [], failed: [] }
  for (const invoice of open) {
    const itemId = typeof invoice.factoringItemId === 'string' ? invoice.factoringItemId : null
    if (!itemId || invoice.status === 'VOID') continue
    const balanceCents = numberOrNull(invoice.balanceCents) ?? 0
    if (balanceCents <= 0) continue
    result.checked++
    const item = await getById(FACTORING_ITEM_TABLE_NAME, itemId)
    if (!item || item.status !== 'FACTORED') continue
    const invoiceId = String(invoice.id)
    const otrInvoiceId = item.otrInvoiceId != null ? String(item.otrInvoiceId) : null
    try {
      await recordPayment({
        customerId: String(invoice.customerId),
        receivedAt: fundedDateOf(item),
        method: 'FACTOR',
        reference: otrInvoiceId ? `OTR ${otrInvoiceId}` : 'OTR',
        amountCents: balanceCents,
        applications: [{ invoiceId, amountCents: balanceCents }],
        creditApplications: [],
        note: 'Funded by OTR (factored)',
        clientRequestId: `otr-${invoiceId}`.slice(0, 64),
      }, caller)
      result.settled.push({ invoiceId, number: typeof invoice.number === 'string' ? invoice.number : null, amountCents: balanceCents, otrInvoiceId })
    } catch (err) {
      result.failed.push({ invoiceId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  console.log('[settle-factored]', { checked: result.checked, settled: result.settled.length, failed: result.failed.length })
  return result
}
