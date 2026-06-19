import { addDays, differenceInCalendarDays, format } from 'date-fns'
import type { DateRange } from '@/lib/fleetProfitability'

/**
 * Driver pay runs on a fixed 14-day (biweekly) cadence. This anchor is a known period
 * START — the period 2026-06-08 → 2026-06-21 — so every other period lines up with it.
 */
export const PAY_PERIOD_ANCHOR = new Date(2026, 5, 8) // Jun 8 2026 (month is 0-indexed)

/** The 14-day pay period that contains `ref`, aligned to PAY_PERIOD_ANCHOR. */
export function biweeklyPeriodOf(ref: Date = new Date()): DateRange {
  const idx = Math.floor(differenceInCalendarDays(ref, PAY_PERIOD_ANCHOR) / 14)
  const start = addDays(PAY_PERIOD_ANCHOR, idx * 14)
  const end = addDays(start, 13)
  return { start: format(start, 'yyyy-MM-dd'), end: format(end, 'yyyy-MM-dd') }
}

/** Human label, e.g. "Jun 8 – Jun 21, 2026". */
export function biweeklyPeriodLabel(range: DateRange): string {
  const s = new Date(`${range.start}T12:00:00`)
  const e = new Date(`${range.end}T12:00:00`)
  const left = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const right = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${left} – ${right}`
}
