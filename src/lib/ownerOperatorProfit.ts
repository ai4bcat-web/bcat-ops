import { OWNER_OP_FIRST_PERIOD } from './ownerOperatorTrips'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Inclusive day count between two YYYY-MM-DD dates (UTC, calendar days). */
function inclusiveDays(start: string, end: string): number {
  const s = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10))
  const e = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10))
  return Math.floor((e - s) / 86_400_000) + 1
}

/** Inclusive 7-day window from a period start (YYYY-MM-DD). */
function periodEnd(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

/** One driver's company economics for one owner-operator pay week. */
export interface OwnerOpWeekProfit {
  periodStart: string
  driverId:    string
  driverName:  string
  gross:       number   // freight billed (revenue this driver generated)
  expenses:    number   // fuel + fixed + one-off deductions + costs recovered via debits
  driverPay:   number   // the driver's check this week (after credits and debits)
  profit:      number   // to the company = gross − driverPay − expenses
}

/** Aggregate of driver-week rows whose pay week falls in [startIso, endIso]. */
export interface OwnerOperatorAgg {
  revenue:   number
  driverPay: number
  expenses:  number
  profit:    number
  rows:      OwnerOpWeekProfit[]
}

/**
 * Aggregate owner-operator driver-week rows over a date range.
 *
 * The non-prorated form is used for weekly views (start === end). The prorated form
 * splits a boundary week by overlapping calendar days, matching the fleet engine's
 * pay proration so monthly totals are consistent.
 */
export function aggregateOwnerOperator(
  rows: OwnerOpWeekProfit[],
  startIso: string,
  endIso: string,
  opts?: { prorate?: boolean },
): OwnerOperatorAgg {
  const prorate = opts?.prorate ?? false
  if (!prorate) {
    const inRange = rows.filter((r) => r.periodStart >= startIso && r.periodStart <= endIso)
    return {
      revenue:   round2(inRange.reduce((s, r) => s + r.gross, 0)),
      driverPay: round2(inRange.reduce((s, r) => s + r.driverPay, 0)),
      expenses:  round2(inRange.reduce((s, r) => s + r.expenses, 0)),
      profit:    round2(inRange.reduce((s, r) => s + r.profit, 0)),
      rows:      inRange,
    }
  }

  const scaled: OwnerOpWeekProfit[] = []
  for (const r of rows) {
    const rEnd = periodEnd(r.periodStart)
    const oStart = r.periodStart > startIso ? r.periodStart : startIso
    const oEnd = rEnd < endIso ? rEnd : endIso
    if (oStart > oEnd) continue
    const overlapDays = inclusiveDays(oStart, oEnd)
    const totalDays = inclusiveDays(r.periodStart, rEnd)
    const f = overlapDays / totalDays
    const gross = round2(r.gross * f)
    const driverPay = round2(r.driverPay * f)
    const expenses = round2(r.expenses * f)
    scaled.push({
      ...r,
      gross,
      driverPay,
      expenses,
      profit: round2(gross - driverPay - expenses),
    })
  }
  return {
    revenue:   round2(scaled.reduce((s, r) => s + r.gross, 0)),
    driverPay: round2(scaled.reduce((s, r) => s + r.driverPay, 0)),
    expenses:  round2(scaled.reduce((s, r) => s + r.expenses, 0)),
    profit:    round2(scaled.reduce((s, r) => s + r.profit, 0)),
    rows:      scaled,
  }
}

/**
 * Distinct owner-operator pay weeks (Sunday starts) for which a driver has delivered
 * loads, restricted to weeks on or after the changeover date and sorted newest first.
 */
export function ownerOperatorWeeksFromLoads(
  loads: { deliveryDriverId?: string | null; deliveryAppt?: string | null }[],
  driverId: string,
): string[] {
  const weeks = new Set<string>()
  for (const load of loads) {
    if (load.deliveryDriverId !== driverId || !load.deliveryAppt) continue
    const date = load.deliveryAppt.slice(0, 10)
    if (!date || date < OWNER_OP_FIRST_PERIOD) continue
    const d = new Date(`${date}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - d.getUTCDay())
    weeks.add(d.toISOString().slice(0, 10))
  }
  return [...weeks].sort((a, b) => (a < b ? 1 : -1))
}
