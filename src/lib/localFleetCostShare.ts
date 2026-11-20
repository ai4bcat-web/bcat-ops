import type { ReviewMonthInput } from './profitReview'

/** The costs we control, in the order they are drawn around each month's donut. */
export type ShareKey = 'fuel' | 'driverPay' | 'maintenance'
export const SHARE_KEYS: ShareKey[] = ['fuel', 'driverPay', 'maintenance']

export interface CostShareRow {
  key: string
  month: string
  revenue: number
  fuel: number
  driverPay: number
  maintenance: number
  /** Each category as a percent of revenue; null when there is no revenue or the month has no costs on file. */
  pct: Record<ShareKey, number | null>
  /** The three categories together, in dollars and as a percent of revenue (null without costs or revenue). */
  controllable: number
  controllablePct: number | null
  /** Revenue left after the three categories (never below 0), and as a percent of revenue (null without costs or revenue). */
  leftover: number
  leftoverPct: number | null
  /** The three categories together cost more than the month's revenue. */
  overRevenue: boolean
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
 * Local-fleet revenue by month and the share of it that went to fuel, driver pay and maintenance (the costs we
 * control). Same inputs as the Profit Review (`useProfitReview`), so it matches the Finances P&L. Nothing is
 * invented: a category with no entries reads 0% and is flagged in `lowEntry` rather than guessed.
 */
export function buildCostShare(months: ReviewMonthInput[]): CostShareRow[] {
  const rows: CostShareRow[] = months.map((m) => {
    const partial = m.daysElapsed < m.daysInMonth
    const noCosts = !!m.incomplete
    const pct = (v: number): number | null => (noCosts || m.revenue <= 0 ? null : (v / m.revenue) * 100)
    const costs = m.fuel + m.driverPay + m.maintenance
    return {
      key: m.key,
      month: m.label.split(' ')[0],
      revenue: m.revenue,
      fuel: m.fuel,
      driverPay: m.driverPay,
      maintenance: m.maintenance,
      pct: { fuel: pct(m.fuel), driverPay: pct(m.driverPay), maintenance: pct(m.maintenance) },
      controllable: noCosts ? 0 : costs,
      controllablePct: pct(costs),
      leftover: noCosts ? 0 : Math.max(0, m.revenue - costs),
      leftoverPct: noCosts || m.revenue <= 0 ? null : ((m.revenue - costs) / m.revenue) * 100,
      overRevenue: !noCosts && m.revenue > 0 && costs > m.revenue,
      partial,
      noCosts,
      lowEntry: [],
    }
  })
  // Reference months: finished, with costs and revenue. Maintenance is lumpy by nature, so only fuel and driver
  // pay (entered on a schedule) are compared.
  const ref = rows.filter((r) => !r.partial && !r.noCosts && r.revenue > 0)
  for (const r of rows) {
    if (r.noCosts || r.revenue <= 0) continue
    for (const k of ['fuel', 'driverPay'] as const) {
      const mine = r.pct[k] ?? 0
      const others = ref.filter((x) => x.key !== r.key).map((x) => x.pct[k] ?? 0)
      const usual = median(others)
      if (mine === 0 || (others.length >= 2 && usual > 0 && mine < usual * 0.5)) r.lowEntry.push(k)
    }
  }
  return rows
}

/**
 * The fractions of a donut's ring each slice takes: the three costs then left over, adding up to 1. When the costs
 * exceed revenue the ring is the costs alone, scaled to fill it. Months without costs or revenue have no slices.
 */
export function donutSlices(r: CostShareRow): { key: ShareKey | 'leftover'; fraction: number }[] {
  if (r.noCosts || r.revenue <= 0) return []
  const total = r.overRevenue ? r.controllable : r.revenue
  if (total <= 0) return []
  const parts: { key: ShareKey | 'leftover'; fraction: number }[] = SHARE_KEYS.map((k) => ({ key: k, fraction: r[k] / total }))
  parts.push({ key: 'leftover', fraction: r.overRevenue ? 0 : r.leftover / total })
  return parts.filter((p) => p.fraction > 0)
}
