/**
 * Miles per gallon by truck, from Motive.
 *
 * Both halves come from Motive and cover the same period: miles from the IFTA summary,
 * gallons from vehicle utilisation (driving fuel PLUS idle fuel). Idle is included
 * deliberately — a truck idling at a dock burns fuel no mile accounts for, and leaving it
 * out would flatter every figure, on a local fleet that idles by a lot. This is what came
 * out of the tank, not what the engine managed while moving.
 *
 * It is NOT computed from fuel-card purchases. A card transaction is money leaving on a
 * date, not fuel burned in a period — a driver filling a tank on the last day of a week
 * would wreck that week and flatter the next.
 */

export interface MileageRow {
  truckId: string
  unitNumber: string
  /** YYYY-MM-DD: the Monday for a WEEK row. */
  periodStart: string
  periodType: string
  miles: number
  gallons?: number | null
}

export interface TruckMpg {
  periodStart: string
  miles: number
  gallons: number | null
  /** Null whenever it cannot be computed honestly. */
  mpg: number | null
}

/**
 * MPG for one period, or null.
 *
 * Null rather than 0 or Infinity in every case that is not a real figure: no gallons
 * recorded, no miles, or either one zero. A truck that sat still all week has no fuel
 * economy — it has no data — and showing "0.0 MPG" would read as a catastrophic figure
 * rather than an absent one.
 */
export function mpgOf(miles: number, gallons: number | null | undefined): number | null {
  if (typeof gallons !== 'number' || !Number.isFinite(gallons) || gallons <= 0) return null
  if (!Number.isFinite(miles) || miles <= 0) return null
  return Math.round((miles / gallons) * 10) / 10
}

/** Weekly MPG for one truck, newest first. Only WEEK rows; a day is too short to mean much. */
export function weeklyMpg(rows: MileageRow[], truckId: string): TruckMpg[] {
  return rows
    .filter((r) => r.truckId === truckId && r.periodType === 'WEEK')
    .map((r) => ({
      periodStart: r.periodStart,
      miles: r.miles,
      gallons: typeof r.gallons === 'number' ? r.gallons : null,
      mpg: mpgOf(r.miles, r.gallons),
    }))
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart))
}

/**
 * How this week compares with the one before — the question "week over week" is asking.
 *
 * Null unless BOTH weeks have a real figure. A change measured against a week with no fuel
 * data is not a change, and showing one would invent a trend out of a gap in the feed.
 */
export function weekOverWeek(series: TruckMpg[]): { current: number | null; previous: number | null; deltaPct: number | null } {
  const withMpg = series.filter((s) => s.mpg != null)
  const current = withMpg[0]?.mpg ?? null
  const previous = withMpg[1]?.mpg ?? null
  const deltaPct =
    current != null && previous != null && previous > 0
      ? Math.round(((current - previous) / previous) * 1000) / 10
      : null
  return { current, previous, deltaPct }
}
