import { trailingMonths } from '@/lib/brokerageRevenue'
import { DASHBOARD_DATA_START } from '@/lib/dashboardRollup'

export interface MonthRange { from: string; to: string }

/** First month a Brokerage view draws (the new system's data start) and the longest range one view draws. */
export const FIRST_MONTH = DASHBOARD_DATA_START
export const MAX_RANGE_MONTHS = 36

export const money0 = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100)
export const moneyK = (cents: number) => `${cents < 0 ? '−' : ''}$${Math.round(Math.abs(cents) / 100_000)}k`
/** Profit % from basis points; a dash when there is no revenue to divide by. */
export const pct = (bps: number | null) => (bps == null ? '—' : `${(bps / 100).toFixed(1)}%`)
export const netColor = (cents: number) => (cents > 0 ? 'var(--tms-badge-green)' : cents < 0 ? 'var(--tms-badge-red)' : 'var(--tms-text-2)')

export function previousMonth(month: string): string {
  return trailingMonths(month, 2)[0]
}

/** Keeps a picked range ordered, inside the rollup's history and no longer than `MAX_RANGE_MONTHS`. */
export function clampRange(range: MonthRange, current: string): MonthRange {
  let [from, to] = range.from <= range.to ? [range.from, range.to] : [range.to, range.from]
  if (to > current) to = current
  if (from < FIRST_MONTH) from = FIRST_MONTH
  if (from > to) from = to
  const months = trailingMonths(to, MAX_RANGE_MONTHS)
  if (from < months[0]) from = months[0]
  return { from, to }
}

