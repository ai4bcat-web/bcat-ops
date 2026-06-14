import { startOfWeek, endOfWeek, addWeeks, format } from 'date-fns'
import type { DateRange } from '@/lib/fleetProfitability'

/**
 * The Monday–Sunday week, `offset` weeks before the current one (0 = this week,
 * 1 = last week …), as inclusive YYYY-MM-DD bounds. Matches the WEEK convention
 * used elsewhere (week starts Monday).
 */
export function weekRange(offset: number, ref: Date = new Date()): DateRange {
  const base = addWeeks(ref, -offset)
  const start = startOfWeek(base, { weekStartsOn: 1 })
  const end = endOfWeek(base, { weekStartsOn: 1 })
  return { start: format(start, 'yyyy-MM-dd'), end: format(end, 'yyyy-MM-dd') }
}

/** Human label, e.g. "Jun 8 – Jun 14, 2026". */
export function weekLabel(range: DateRange): string {
  const s = new Date(`${range.start}T12:00:00`)
  const e = new Date(`${range.end}T12:00:00`)
  const left = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const right = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${left} – ${right}`
}
