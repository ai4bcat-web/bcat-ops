/**
 * Posting a recovered Amazon dispute onto a driver's weekly settlement.
 *
 * A PAID dispute is money Amazon sent for a specific trip, so it rides that driver's
 * check as a 100% credit under reason DISPUTE — on whichever Sunday week staff pick,
 * which is usually the settlement being built now, not the week the shipment ran.
 *
 * The dispute row stores the credit's id, so re-saving the sheet moves/re-prices that
 * one credit instead of paying the driver a second time.
 */
import type { DriverPayCreditInput } from './apiClient'
import type { AmazonDispute } from '@/types/dispute'

/** Reason code the settlement, PDF and CSV print as "Dispute". */
export const DISPUTE_REASON_CODE = 'DISPUTE'

const norm = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')

export interface DriverLike {
  id: string
  name: string
  active?: boolean | null
}

/**
 * The driver whose settlement a dispute belongs on. Portal rows carry a typed name and
 * no driver id, so match on the name exactly (case- and spacing-insensitive), preferring
 * active drivers when a retired namesake exists. An unknown or ambiguous name returns
 * null — staff then pick the pay account by hand rather than crediting the wrong person.
 */
export function matchDisputeDriver<T extends DriverLike>(driverName: string, drivers: T[]): T | null {
  const target = norm(driverName ?? '')
  if (!target) return null
  const hits = drivers.filter((d) => norm(d.name ?? '') === target)
  const active = hits.filter((d) => d.active !== false)
  const pool = active.length > 0 ? active : hits
  return pool.length === 1 ? pool[0] : null
}

/** Dollars to credit: what Amazon actually sent, falling back to what was requested. */
export function disputeRecoveredAmount(
  dispute: Pick<AmazonDispute, 'resolvedAmount' | 'amountRequested'>,
): number | null {
  for (const value of [dispute.resolvedAmount, dispute.amountRequested]) {
    if (value != null && Number.isFinite(value) && value > 0) return Math.round(value * 100) / 100
  }
  return null
}

/**
 * The note after "Dispute —" on the statement line: the trip it recovers, and the
 * shipment date when the trip number is missing, so a driver can tie the credit to a run.
 */
export function disputeCreditNote(
  dispute: Pick<AmazonDispute, 'tripNumber' | 'shipmentDate'>,
): string {
  const trip = dispute.tripNumber?.trim()
  const shipped = dispute.shipmentDate?.trim()
  if (trip && shipped) return `Trip ${trip} · ${shipped}`
  if (trip) return `Trip ${trip}`
  if (shipped) return `Shipment ${shipped}`
  return 'Amazon recovery'
}

/**
 * The credit row for a recovered dispute. `amount` is the recovery in dollars; the
 * caller resolves it (and the driver) first, because a dispute with no recovered amount
 * must not reach the check at all.
 */
export function disputeCreditInput({ dispute, driverId, periodStart, amount, actorEmail }: {
  dispute: Pick<AmazonDispute, 'tripNumber' | 'shipmentDate'>
  driverId: string
  periodStart: string
  amount: number
  actorEmail?: string | null
}): DriverPayCreditInput {
  return {
    driverId,
    periodStart,
    kind: 'CREDIT',
    reasonCode: DISPUTE_REASON_CODE,
    label: disputeCreditNote(dispute),
    amount,
    date: /^\d{4}-\d{2}-\d{2}$/.test(dispute.shipmentDate ?? '') ? dispute.shipmentDate! : null,
    loadRef: dispute.tripNumber?.trim() || null,
    createdBy: actorEmail ?? null,
  }
}
