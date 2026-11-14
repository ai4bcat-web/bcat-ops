/**
 * Ryne 2026-11-14: Ready to invoice has no Generate button. A load's invoice is made when Load Review releases
 * it (the review's `releaseToBilling` step); this is the catch-up for an order that reached Ready to invoice
 * without one (that step failed, or a voided invoice sent the order back). The page asks the server to generate
 * the missing invoices once per order per visit; generating never sends anything.
 */
import type { ArQueueRow } from './arQueue'
import { isFactorBilled, type FactorBillingCustomer } from '@/lib/factorBilling'

/**
 * Ryne 2026-11-14: a factored load's invoice is never e-mailed: it goes through the OTR queue. A row bills through
 * OTR when its invoice or order is factored, or its customer is factor-billed.
 */
export function billsThroughOtr(row: Pick<ArQueueRow, 'factored'>, customer: FactorBillingCustomer | null | undefined): boolean {
  return row.factored || isFactorBilled(customer)
}

/**
 * The Sent column's words for a row with no e-mail on record. A factored row is never "Not sent": it is in the OTR
 * queue once it has a factoring row, and "Factored via OTR" (no e-mail needed) before that.
 */
export function unsentLabel(row: Pick<ArQueueRow, 'invoiceId' | 'invoice' | 'factorItem'>, throughOtr: boolean): string {
  if (throughOtr) return row.factorItem || row.invoice?.factoringItemId ? 'In OTR queue' : 'Factored via OTR'
  return row.invoiceId ? 'Not sent' : '—'
}

/** A folded-in factoring queue row (`factor:` key) has no order of its own to invoice. */
export const isQueueOnlyRow = (row: Pick<ArQueueRow, 'orderId'>): boolean => row.orderId.startsWith('factor:')

/**
 * The Ready to invoice orders that still need their invoice made: no invoice yet, a real order, nothing the row
 * already says is missing (its reasons are on screen; the server would refuse the same way), and not tried
 * already this visit (a refusal is shown on the row with Retry rather than asked again on every render).
 */
export function ordersNeedingInvoice(
  rows: readonly (Pick<ArQueueRow, 'orderId' | 'invoice'> & { reasons?: readonly string[] })[],
  attempted: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (row.invoice || isQueueOnlyRow(row) || attempted.has(row.orderId) || (row.reasons?.length ?? 0) > 0) continue
    out.push(row.orderId)
  }
  return [...new Set(out)]
}
