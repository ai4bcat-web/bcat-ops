/**
 * A load is not paid until its POD is on file.
 *
 * That is the rule the office works to: the proof of delivery is what lets the load
 * be invoiced, and paying a driver for a load that cannot be invoiced puts the money
 * out before it comes in. So a delivered load with no POD is HELD rather than dropped
 * — it still shows on the settlement, it just does not count toward the check until
 * the POD arrives.
 *
 * Holding is self-healing. A settlement is recomputed from current data every time it
 * is opened, so the week a POD lands the load moves from held to payable on its own.
 * Nothing has to be re-run and no held load is ever forgotten.
 *
 * The dangerous failure here is not a missing POD, it is a POD store we cannot read.
 * PODs come from JobsDone, an external integration; if it is down, every load looks
 * POD-less and an entire week of drivers would go unpaid. So "we could not check" is a
 * distinct state from "there is no POD", and it never holds anyone's pay.
 */

/** What a trip needs to expose for the hold rule. Deliberately minimal. */
export interface HoldableTrip {
  freightAmount: number
  readiness?: { missingDocuments: Array<'POD' | 'Rate confirmation'> }
}

export type PayHoldReason = 'NO_POD' | 'NOT_DELIVERED'

export const PAY_HOLD_LABEL: Record<PayHoldReason, string> = {
  NO_POD: 'POD required',
  /*
   * Booked for a day that has not happened yet.
   *
   * The driver app used to drop these loads entirely, so a driver looking at their week
   * saw two shipments while the office saw four. Hiding work a driver is about to run —
   * and the money on it — made the app look wrong and the week look emptier than it is.
   * They are shown, with the pay they WILL earn, and marked as not on this check.
   */
  NOT_DELIVERED: 'Not delivered yet',
}

export interface PayHoldOptions {
  /**
   * False when the POD store could not be read. Every trip is then treated as
   * payable, because a broken integration must never withhold a driver's pay.
   */
  podsKnown: boolean
}

/** Why this trip is held, or null when it is payable. */
export function tripHoldReason(trip: HoldableTrip, opts: PayHoldOptions): PayHoldReason | null {
  if (!opts.podsKnown) return null
  // No readiness means the load behind the trip could not be resolved, so nothing is
  // known about its documents either. Unknown is not the same as absent.
  if (!trip.readiness) return null
  return trip.readiness.missingDocuments.includes('POD') ? 'NO_POD' : null
}

export interface SplitTrips<T extends HoldableTrip> {
  /** Counts toward the check. */
  payable: T[]
  /** Shown, explained, and excluded from the check. */
  held: Array<{ trip: T; reason: PayHoldReason }>
  /** Freight dollars sitting in `held`, for the "waiting on paperwork" line. */
  heldFreight: number
}

export function splitPayableTrips<T extends HoldableTrip>(
  trips: T[],
  opts: PayHoldOptions,
): SplitTrips<T> {
  const payable: T[] = []
  const held: Array<{ trip: T; reason: PayHoldReason }> = []

  for (const trip of trips) {
    const reason = tripHoldReason(trip, opts)
    if (reason) held.push({ trip, reason })
    else payable.push(trip)
  }

  const heldFreight = Math.round(held.reduce((s, h) => s + (h.trip.freightAmount || 0), 0) * 100) / 100
  return { payable, held, heldFreight }
}
