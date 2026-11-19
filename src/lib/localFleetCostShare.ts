import type { ReviewMonthInput } from './profitReview'

export type ShareKey = 'fuel' | 'driverPay' | 'insurance' | 'maintenance'
export const SHARE_KEYS: ShareKey[] = ['fuel', 'driverPay', 'insurance', 'maintenance']

export interface CostShareRow {
  key: string
  month: string
  revenue: number
  fuel: number
  driverPay: number
  insurance: number
  maintenance: number
  /** Each category as a percent of revenue; null when there is no revenue or the month has no costs on file. */
  pct: Record<ShareKey, number | null>
  partial: boolean
  /** The month predates the expense setup (no fixed costs on file): revenue shows, shares do not. */
  noCosts: boolean
  /** Categories that look under-entered next to the other months (zero, or under half the usual share). */
  lowEntry: ShareKey[]
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Local-fleet revenue by month and the share of it that went to fuel, driver pay, insurance and maintenance.
 * Same inputs as the Profit Review (`useProfitReview`), so it matches the Finances P&L. Nothing is invented: a
 * category with no entries reads 0% and is flagged in `lowEntry` rather than guessed.
 */
export function buildCostShare(months: ReviewMonthInput[]): CostShareRow[] {
  const rows: CostShareRow[] = months.map((m) => {
    const partial = m.daysElapsed < m.daysInMonth
    const noCosts = !!m.incomplete
    const pct = (v: number): number | null => (noCosts || m.revenue <= 0 ? null : (v / m.revenue) * 100)
    return {
      key: m.key,
      month: m.label.split(' ')[0],
      revenue: m.revenue,
      fuel: m.fuel,
      driverPay: m.driverPay,
      insurance: m.insurance,
      maintenance: m.maintenance,
      pct: { fuel: pct(m.fuel), driverPay: pct(m.driverPay), insurance: pct(m.insurance), maintenance: pct(m.maintenance) },
      partial,
      noCosts,
      lowEntry: [],
    }
  })
  // Reference months: finished, with costs and revenue. Maintenance is lumpy by nature, so only fuel and driver
  // pay (entered on a schedule) and insurance (a fixed allocation) are compared.
  const ref = rows.filter((r) => !r.partial && !r.noCosts && r.revenue > 0)
  for (const r of rows) {
    if (r.noCosts || r.revenue <= 0) continue
    for (const k of ['fuel', 'driverPay', 'insurance'] as const) {
      const mine = r.pct[k] ?? 0
      const others = ref.filter((x) => x.key !== r.key).map((x) => x.pct[k] ?? 0)
      const usual = median(others)
      if (mine === 0 || (others.length >= 2 && usual > 0 && mine < usual * 0.5)) r.lowEntry.push(k)
    }
  }
  return rows
}
