/**
 * What the queue is worth, per status.
 *
 * "How much is sitting in Need to factor" is the question the queue could not answer. The
 * counts were there, but a count of invoices is not money, and the amount is the only
 * figure anyone actually plans around.
 *
 * The rate comes from the same place the invoice gets it — the resolved OTR payload — so
 * the total is of the amounts that would actually be submitted, not of a second number
 * kept beside them.
 *
 * Rows with no rate are counted separately and never treated as zero. A total that
 * silently swallows the rows it could not price reads as complete and is not, and the
 * whole point of the figure is that someone trusts it.
 */
import type { OtrReadiness } from '@/lib/otrInvoice'
import type { FactoringItem, FactoringItemStatus } from '@/types'

export interface StatusTotal {
  count: number
  /** Dollars, summed over the rows that have a rate. */
  total: number
  /** How many rows in this status have no rate at all. */
  missingRate: number
}

export const EMPTY_TOTAL: StatusTotal = { count: 0, total: 0, missingRate: 0 }

/** The invoice amount in dollars, or null when nothing has resolved one yet. */
export function invoiceAmountOf(item: FactoringItem): number | null {
  const readiness = item.otrReadiness
  if (!readiness || typeof readiness !== 'object') return null
  const raw = (readiness as OtrReadiness).payload?.InvoiceAmount
  if (raw == null) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  // Strip currency formatting, but a string with no digits in it is not a zero invoice —
  // Number('') is 0, which would quietly join the total as real money.
  const digits = String(raw).replace(/[^0-9.-]/g, '')
  if (!/\d/.test(digits)) return null
  const amount = Number(digits)
  return Number.isFinite(amount) ? amount : null
}

/** Per-status totals plus an ALL bucket, keyed the way the filter tabs are. */
export function totalsByStatus(
  items: FactoringItem[],
): Record<FactoringItemStatus | 'ALL', StatusTotal> {
  const out: Record<FactoringItemStatus | 'ALL', StatusTotal> = {
    ALL: { ...EMPTY_TOTAL },
    NEED_TO_FACTOR: { ...EMPTY_TOTAL },
    PENDING_WITH_OTR: { ...EMPTY_TOTAL },
    FACTORED: { ...EMPTY_TOTAL },
  }

  for (const item of items) {
    const amount = invoiceAmountOf(item)
    const buckets: Array<StatusTotal | undefined> = [out.ALL, out[item.status]]
    for (const bucket of buckets) {
      if (!bucket) continue
      bucket.count++
      if (amount == null) bucket.missingRate++
      else bucket.total += amount
    }
  }
  return out
}

/** "$12,480.00" — whole dollars and cents, because this is money someone reconciles. */
export function money(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}
