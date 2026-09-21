/**
 * Posting a recovered Amazon dispute onto a driver's weekly settlement.
 *
 * Amazon pays a won dispute the way it pays freight, so the recovery rides the check as
 * an ordinary shipment row on the settlement week staff pick — labelled DISPUTE with the
 * shipment's date — and runs through the driver's pay split like every other load.
 *
 * The dispute row stores the trip's id, so re-saving the sheet moves/re-prices that one
 * trip instead of paying the driver a second time.
 */
import type { AmazonTrip } from './apiClient'
import type { AmazonDispute } from '@/types/dispute'

export type DisputeTripInput = Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>

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
 * How the recovery reads in the settlement's LOAD column: "DISPUTE 2026-09-09" — the
 * shipment's own date, falling back to the disputed pay period when the date is blank.
 */
export function disputeTripLabel(dispute: Pick<AmazonDispute, 'shipmentDate' | 'payPeriod'>): string {
  const date = dispute.shipmentDate?.trim() || dispute.payPeriod?.trim()
  return date ? `DISPUTE ${date}` : 'DISPUTE'
}

/**
 * The shipment row for a recovered dispute. `amount` is the recovery in dollars and
 * becomes the row's freight, so the driver earns their normal percentage of it; the
 * caller resolves the amount and the driver first, because a dispute with no recovered
 * amount must not reach the check at all.
 */
export function disputeTripInput({ dispute, driverId, periodStart, amount }: {
  dispute: Pick<AmazonDispute, 'tripNumber' | 'shipmentDate' | 'payPeriod'>
  driverId: string
  periodStart: string
  amount: number
}): DisputeTripInput {
  const trip = dispute.tripNumber?.trim()
  return {
    driverId,
    periodStart,
    loadId: disputeTripLabel(dispute),
    origin: null,
    destination: null,
    miles: null,
    equipment: null,
    freightAmount: amount,
    ratePerMile: null,
    dispatcher: null,
    status: 'Completed',
    notes: trip ? `Amazon dispute — Trip ${trip}` : 'Amazon dispute',
  }
}
