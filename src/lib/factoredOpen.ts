/**
 * Where a factored, still-open invoice stands with OTR (Ryne 2026-11-15).
 *
 * "Pending with OTR" meant two different sets: on the Receivables card every factored invoice not
 * yet marked paid, in the factoring queue every row OTR had not funded. Both screens now read these
 * buckets, so the same words mean the same invoices. "Waiting on OTR approval" is the one the queue
 * and the card share: submitted, OTR has not approved it, and it is not dead, duplicate or refused.
 */
import type { FactoringItem } from '@/types'
import { isOtrRejected } from './otrRejection'
import { otrStatusMeta } from './otrInvoiceStatus'

export type FactoredBucket = 'WAITING' | 'APPROVED' | 'REJECTED' | 'NOT_SENT' | 'MANUAL' | 'NO_RECORD' | 'OTHER'

export const FACTORED_BUCKET_ORDER: readonly FactoredBucket[] = ['WAITING', 'APPROVED', 'REJECTED', 'NOT_SENT', 'MANUAL', 'NO_RECORD', 'OTHER']

export const FACTORED_BUCKET_LABEL: Record<FactoredBucket, string> = {
  WAITING: 'Waiting on OTR approval',
  APPROVED: 'Approved by OTR, not marked paid',
  REJECTED: 'OTR rejected',
  NOT_SENT: 'Not sent to OTR yet',
  MANUAL: 'Manually invoiced',
  NO_RECORD: 'Factored, no OTR record (imported)',
  OTHER: 'Other OTR status',
}

export const FACTORED_BUCKET_TITLE: Record<FactoredBucket, string> = {
  WAITING: 'Submitted to OTR and not approved yet. Same as "Waiting on OTR approval" in the factoring queue.',
  APPROVED: 'OTR approved it. Marking it paid is done by hand.',
  REJECTED: 'OTR marked it Dead, will not buy it, or refused it. Same as the OTR rejected tab.',
  NOT_SENT: 'In the factoring queue, not submitted to OTR yet.',
  MANUAL: 'Taken out of the OTR queue to be invoiced by hand.',
  NO_RECORD: 'Marked factored with no factoring queue row: brought over from Aljex or the AR sheet.',
  OTHER: 'OTR says Duplicate, or the row was archived.',
}

type Item = Pick<FactoringItem, 'status' | 'otrStatus' | 'brokerCheckResult' | 'manualReason' | 'otrError' | 'brokerMcChecked'>

/** Submitted, OTR has not approved it, and it is not finished (Dead / Duplicate) or refused. */
export function isWaitingOnOtr(item: Item): boolean {
  if (item.status !== 'PENDING_WITH_OTR') return false
  const meta = otrStatusMeta(item.otrStatus)
  if (meta?.code === 3 || meta?.terminal) return false
  return !isOtrRejected(item)
}

export function factoredBucketOf(item: Item | null | undefined): FactoredBucket {
  if (!item) return 'NO_RECORD'
  if (isWaitingOnOtr(item)) return 'WAITING'
  if (item.status === 'FACTORED' || otrStatusMeta(item.otrStatus)?.code === 3) return 'APPROVED'
  if (item.status === 'MANUAL_INVOICE' || item.status === 'INVOICED_MANUALLY') return 'MANUAL'
  if (isOtrRejected(item)) return 'REJECTED'
  if (item.status === 'NEED_TO_FACTOR') return 'NOT_SENT'
  return 'OTHER'
}

export interface BucketTotal { count: number; cents: number }

/** Open (sent or partly paid) invoice balances by factoring queue row, in cents. */
export function openBalanceByFactoringItem(
  invoices: readonly { factoringItemId?: string | null; status: string; balanceCents: number }[],
): Map<string, number> {
  const map = new Map<string, number>()
  for (const inv of invoices) {
    if (!inv.factoringItemId || (inv.status !== 'ISSUED' && inv.status !== 'PARTIAL')) continue
    map.set(inv.factoringItemId, (map.get(inv.factoringItemId) ?? 0) + inv.balanceCents)
  }
  return map
}

export type FactoredBuckets = Record<FactoredBucket, BucketTotal>

export function emptyFactoredBuckets(): FactoredBuckets {
  return Object.fromEntries(FACTORED_BUCKET_ORDER.map((b) => [b, { count: 0, cents: 0 }])) as FactoredBuckets
}

/**
 * The factoring queue's "Waiting on OTR approval", in the money the Receivables card uses: the open
 * invoice's balance where the row has one, else what was sent to OTR.
 */
export function waitingOnOtrTotal<T extends Item & { id: string }>(
  items: readonly T[],
  openBalanceCentsByItemId: ReadonlyMap<string, number>,
  amountDollars: (item: T) => number,
): BucketTotal {
  let count = 0
  let cents = 0
  for (const item of items) {
    if (!isWaitingOnOtr(item)) continue
    count += 1
    cents += openBalanceCentsByItemId.get(item.id) ?? Math.round(amountDollars(item) * 100)
  }
  return { count, cents }
}
