/**
 * What the factoring queue is worth, by bucket.
 *
 * Money for this lives in two different places and the difference is not an inconsistency
 * to paper over — it is the difference between what we INTEND to invoice and what OTR has
 * actually been told.
 *
 *  - Not yet submitted (NEED_TO_FACTOR) has no `otrAmount`, because nothing has been sent.
 *    The only figure available is the rate on the load it resolves to, which is what we
 *    expect to invoice.
 *  - Submitted (PENDING_WITH_OTR, FACTORED) carries `otrAmount` — the figure OTR holds.
 *    That is the number that matters once it is theirs, and it is used in preference to
 *    the load even when both exist, because a load edited after submission does not change
 *    what was invoiced.
 *
 * Rows that can be valued neither way are counted separately rather than silently treated
 * as zero. A total that quietly omits rows reads as money that does not exist, and the
 * whole point of the card is to be trusted about an amount.
 *
 * Pure: no store, no clock, no network.
 */
import type { FactoringItem, FactoringItemStatus, Load } from '../types'

export interface BucketTotal {
  count: number
  /** Cents. Only the rows that could be valued. */
  amount: number
  /** Rows with no figure available at all — neither an OTR amount nor a load rate. */
  unvalued: number
}

export interface FactoringTotals {
  needToFactor: BucketTotal
  pendingWithOtr: BucketTotal
  factored: BucketTotal
  /** Billed by hand because OTR will not buy the broker (or by choice); still owed. */
  manualInvoice: BucketTotal
  invoicedManually: BucketTotal
  /** Everything still owed to us: waiting to send, plus sent and not yet paid. */
  outstandingAmount: number
  outstandingCount: number
}

const EMPTY = (): BucketTotal => ({ count: 0, amount: 0, unvalued: 0 })

/** What one row is worth, and whether anything could say. */
export function itemAmount(
  item: Pick<FactoringItem, 'status' | 'otrAmount' | 'loadId'>,
  loadRateById: Map<string, number | null | undefined>,
): number | null {
  // Submitted: OTR's figure wins, even when the load also has a rate.
  if (typeof item.otrAmount === 'number' && item.otrAmount > 0) return item.otrAmount
  const rate = item.loadId ? loadRateById.get(item.loadId) : null
  return typeof rate === 'number' && rate > 0 ? rate : null
}

export function factoringTotals(
  items: Pick<FactoringItem, 'status' | 'otrAmount' | 'loadId'>[],
  loads: Pick<Load, 'id' | 'rate'>[],
): FactoringTotals {
  const rateById = new Map<string, number | null | undefined>(loads.map((l) => [l.id, l.rate]))
  const buckets: Record<string, BucketTotal> = {
    NEED_TO_FACTOR: EMPTY(), PENDING_WITH_OTR: EMPTY(), FACTORED: EMPTY(),
    MANUAL_INVOICE: EMPTY(), INVOICED_MANUALLY: EMPTY(),
  }

  for (const item of items) {
    const bucket = buckets[item.status as FactoringItemStatus]
    // ARCHIVED is deliberately absent: it is out of the working queue and out of the money.
    if (!bucket) continue
    bucket.count++
    const amount = itemAmount(item, rateById)
    if (amount === null) bucket.unvalued++
    else bucket.amount += amount
  }

  const needToFactor = buckets.NEED_TO_FACTOR
  const pendingWithOtr = buckets.PENDING_WITH_OTR
  const factored = buckets.FACTORED
  const manualInvoice = buckets.MANUAL_INVOICE
  const invoicedManually = buckets.INVOICED_MANUALLY

  return {
    needToFactor,
    pendingWithOtr,
    factored,
    manualInvoice,
    invoicedManually,
    // A manual invoice not yet sent is still money owed; one sent by hand is out of our hands like a factored one.
    outstandingAmount: needToFactor.amount + pendingWithOtr.amount + manualInvoice.amount,
    outstandingCount: needToFactor.count + pendingWithOtr.count + manualInvoice.count,
  }
}
