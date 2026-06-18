import { startOfMonth, endOfMonth, addMonths, format } from 'date-fns'
import type { DateRange } from '@/lib/fleetProfitability'

/**
 * The calendar month `offset` months before the current one (0 = this month,
 * 1 = last month …), as inclusive YYYY-MM-DD bounds.
 */
export function monthRange(offset: number, ref: Date = new Date()): DateRange {
  const base = addMonths(ref, -offset)
  return {
    start: format(startOfMonth(base), 'yyyy-MM-dd'),
    end: format(endOfMonth(base), 'yyyy-MM-dd'),
  }
}

/** Human label, e.g. "June 2026". */
export function monthLabel(range: DateRange): string {
  return new Date(`${range.start}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
