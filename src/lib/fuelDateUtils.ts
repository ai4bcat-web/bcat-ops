import { startOfWeek, endOfWeek, addWeeks, isAfter, format } from 'date-fns'
import type { FuelTransaction } from '@/lib/apiClient'

export interface WeekBucket { wStart: Date; wEnd: Date; label: string }

/**
 * Filter transactions to those whose stored transactionDate (YYYY-MM-DD string)
 * falls within [start, end].  Uses T12:00:00 (local noon) so the date comparison
 * is never affected by a UTC-midnight timezone shift in any negative-offset zone.
 */
export function filterByDate(txs: FuelTransaction[], start: Date, end: Date): FuelTransaction[] {
  return txs.filter((t) => {
    const d = new Date(`${t.transactionDate}T12:00:00`)
    return d >= start && d <= end
  })
}

/**
 * Build Sunday–Saturday week buckets that cover [start, end].
 * wStart/wEnd are the full week boundaries (wEnd can extend past `end`);
 * the label is clipped to the visible portion of the range.
 */
export function getWeeksInRange(start: Date, end: Date): WeekBucket[] {
  const weeks: WeekBucket[] = []
  let wStart = startOfWeek(start, { weekStartsOn: 0 })
  while (!isAfter(wStart, end)) {
    const wEnd      = endOfWeek(wStart, { weekStartsOn: 0 })
    const labelFrom = wStart < start ? start : wStart
    const labelTo   = wEnd > end ? end : wEnd
    const fromStr   = format(labelFrom, 'M/d')
    const toStr     = format(labelTo, 'M/d')
    const label     = fromStr === toStr ? fromStr : `${fromStr}–${toStr}`
    weeks.push({ wStart, wEnd, label })
    wStart = addWeeks(wStart, 1)
  }
  return weeks
}
