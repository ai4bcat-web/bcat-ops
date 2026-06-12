/**
 * Period math for Motive mileage, kept UTC-based to match exactly the periodStart
 * strings the sync Lambda writes (motive-mileage-sync/handler.ts uses UTC).
 *   DAY   → that date            WEEK  → Monday of that week
 *   MONTH → the 1st              YEAR  → Jan 1
 */

export type PeriodType = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'

export const PERIOD_TYPES: PeriodType[] = ['DAY', 'WEEK', 'MONTH', 'YEAR']

export const PERIOD_LABELS: Record<PeriodType, string> = {
  DAY:   'Day',
  WEEK:  'Week',
  MONTH: 'Month',
  YEAR:  'Year',
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * The periodStart (YYYY-MM-DD) for the given type, `offset` periods before now.
 * offset 0 = current period, 1 = previous, etc.
 */
export function periodStartIso(type: PeriodType, offset = 0, ref: Date = new Date()): string {
  const y = ref.getUTCFullYear()
  const m = ref.getUTCMonth()
  const day = ref.getUTCDate()
  switch (type) {
    case 'DAY': {
      const d = new Date(Date.UTC(y, m, day - offset))
      return isoOf(d)
    }
    case 'WEEK': {
      const d = new Date(Date.UTC(y, m, day))
      const dow = d.getUTCDay()                 // 0 = Sun
      const toMonday = dow === 0 ? -6 : 1 - dow
      d.setUTCDate(d.getUTCDate() + toMonday - offset * 7)
      return isoOf(d)
    }
    case 'MONTH':
      return isoOf(new Date(Date.UTC(y, m - offset, 1)))
    case 'YEAR':
      return isoOf(new Date(Date.UTC(y - offset, 0, 1)))
  }
}

/** Human label for a periodStart of the given type. */
export function periodLabel(type: PeriodType, iso: string): string {
  const d = new Date(iso + 'T12:00:00Z')
  switch (type) {
    case 'DAY':
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    case 'WEEK':
      return 'Week of ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    case 'MONTH':
      return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    case 'YEAR':
      return String(d.getUTCFullYear())
  }
}

/** Short label for trend-chart axis ticks. */
export function periodTickLabel(type: PeriodType, iso: string): string {
  const d = new Date(iso + 'T12:00:00Z')
  switch (type) {
    case 'DAY':
      return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
    case 'WEEK':
      return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
    case 'MONTH':
      return d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
    case 'YEAR':
      return String(d.getUTCFullYear())
  }
}

/** The last `n` periodStarts of a type, oldest → newest (for a trend series). */
export function recentPeriodStarts(type: PeriodType, n: number): string[] {
  return Array.from({ length: n }, (_, i) => periodStartIso(type, n - 1 - i))
}
