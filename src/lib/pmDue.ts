/**
 * When a truck's next preventive maintenance is due.
 *
 * One rule, shared by the fleet manager's dashboard and the Ivan driver app, so the number
 * a driver reads on their phone is the same number the office is looking at. A driver
 * seeing "1,200 mi to PM" while the dashboard says something else is worse than the driver
 * not seeing it at all.
 *
 * The current odometer comes SOLELY from Motive (TruckLocation.odometer, refreshed by the
 * location sync) — never a manual or fuel-card figure. The last PM odometer and date are
 * the only values a human enters.
 */

/** The Ivan (LOCAL) fleet runs a PM every 25,000 miles. */
export const PM_INTERVAL_MI = 25_000

/** Within this many miles of the next PM, it is "due soon" rather than merely scheduled. */
export const PM_DUE_SOON_MI = 2_000

export type PmState =
  /** Past the interval — the PM is owed now. */
  | 'OVERDUE'
  /** Inside PM_DUE_SOON_MI of the next one. */
  | 'DUE_SOON'
  | 'OK'
  /** No last-PM reading on the truck, or Motive has not reported an odometer. */
  | 'UNKNOWN'

export interface PmStatus {
  state: PmState
  /** Odometer at which the next PM falls due, or null when the last PM is unrecorded. */
  nextDueAt: number | null
  /** Miles left before it is due; negative once overdue. Null when either input is missing. */
  remaining: number | null
  currentOdometer: number | null
  lastPmMileage: number | null
  lastPmDate: string | null
  /** One line already phrased for a driver. */
  label: string
}

export interface PmInputs {
  lastPmMileage?: number | null
  lastPmDate?: string | null
  /** Motive's odometer for the truck. */
  currentOdometer?: number | null
}

const nf = new Intl.NumberFormat('en-US')
const mi = (n: number) => `${nf.format(Math.round(n))} mi`

/**
 * The PM position of one truck.
 *
 * UNKNOWN rather than a guess whenever either half is missing: a truck with no last-PM
 * reading has no schedule to be measured against, and a truck Motive has not reported on
 * has no present position on that schedule. Showing "25,000 mi to go" for a truck whose
 * last PM was simply never entered would read as reassurance nobody earned.
 */
export function pmStatus(input: PmInputs): PmStatus {
  const lastPmMileage =
    typeof input.lastPmMileage === 'number' && input.lastPmMileage > 0 ? input.lastPmMileage : null
  const currentOdometer =
    typeof input.currentOdometer === 'number' && input.currentOdometer > 0 ? input.currentOdometer : null
  const lastPmDate = input.lastPmDate?.trim() || null

  const nextDueAt = lastPmMileage == null ? null : lastPmMileage + PM_INTERVAL_MI
  const remaining = nextDueAt == null || currentOdometer == null ? null : nextDueAt - currentOdometer

  if (remaining == null) {
    return {
      state: 'UNKNOWN',
      nextDueAt,
      remaining: null,
      currentOdometer,
      lastPmMileage,
      lastPmDate,
      label:
        lastPmMileage == null
          ? 'Next PM not scheduled — no last PM on file for this truck'
          : `Next PM at ${mi(nextDueAt!)} — waiting on an odometer reading`,
    }
  }

  if (remaining <= 0) {
    return {
      state: 'OVERDUE',
      nextDueAt, remaining, currentOdometer, lastPmMileage, lastPmDate,
      label: `PM overdue by ${mi(Math.abs(remaining))} — it was due at ${mi(nextDueAt!)}`,
    }
  }
  if (remaining <= PM_DUE_SOON_MI) {
    return {
      state: 'DUE_SOON',
      nextDueAt, remaining, currentOdometer, lastPmMileage, lastPmDate,
      label: `PM due in ${mi(remaining)} — at ${mi(nextDueAt!)}`,
    }
  }
  return {
    state: 'OK',
    nextDueAt, remaining, currentOdometer, lastPmMileage, lastPmDate,
    label: `Next PM in ${mi(remaining)} — at ${mi(nextDueAt!)}`,
  }
}
