/**
 * Historical Rates buckets (AH-plan §4.5): Yesterday / Last Week / Last 30 Days / Last 90 Days /
 * Last Quarter / Last Year, computed locally from one lane-sample read. A bucket with no
 * history is `null` (never zeros). `LaneStatsWindow` is not widened.
 */
import { laneStats } from '@/lib/laneStats'
import type { LaneRateSampleRecord } from '@/types/tms'

export type PeriodKey = 'yesterday' | 'lastWeek' | 'last30' | 'last90' | 'lastQuarter' | 'lastYear'

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'lastWeek', label: 'Last Week' },
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'last90', label: 'Last 90 Days' },
  { key: 'lastQuarter', label: 'Last Quarter' },
  { key: 'lastYear', label: 'Last Year' },
]

export interface RateSpread { medianCents: number | null; lowCents: number | null; highCents: number | null }
export interface LaneBucket {
  count: number
  /** customerRateCents */
  linehaul: RateSpread
  /** revenueCents (all-in) */
  rate: RateSpread
  perMileCents: number | null
}

const DAY = 86_400_000
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** [from, to] inclusive `YYYY-MM-DD` bounds of a period relative to `nowIso`. */
export function periodBounds(key: PeriodKey, nowIso: string): { from: string; to: string } {
  const now = Date.parse(nowIso)
  const today = ymd(now)
  switch (key) {
    case 'yesterday': { const y = ymd(now - DAY); return { from: y, to: y } }
    case 'lastWeek': return { from: ymd(now - 7 * DAY), to: today }
    case 'last30': return { from: ymd(now - 30 * DAY), to: today }
    case 'last90': return { from: ymd(now - 90 * DAY), to: today }
    case 'lastYear': return { from: ymd(now - 365 * DAY), to: today }
    case 'lastQuarter': {
      const d = new Date(now)
      const q = Math.floor(d.getUTCMonth() / 3)
      const year = q === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear()
      const startMonth = (q === 0 ? 3 : q - 1) * 3
      const from = Date.UTC(year, startMonth, 1)
      const to = Date.UTC(year, startMonth + 3, 0)
      return { from: ymd(from), to: ymd(to) }
    }
  }
}

function spread(values: number[]): RateSpread {
  if (values.length === 0) return { medianCents: null, lowCents: null, highCents: null }
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return {
    medianCents: s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2),
    lowCents: s[0],
    highCents: s[s.length - 1],
  }
}

export function bucketSamples(
  samples: readonly LaneRateSampleRecord[],
  nowIso: string,
  o: { equipmentType?: string; anyEquipment?: boolean } = {},
): Record<PeriodKey, LaneBucket | null> {
  const equipment = o.anyEquipment ? '' : (o.equipmentType ?? '').trim().toUpperCase()
  const usable = samples.filter((s) => !s.excluded
    && (!equipment || (s.equipmentType ?? '').trim().toUpperCase() === equipment))
  const out = {} as Record<PeriodKey, LaneBucket | null>
  for (const { key } of PERIODS) {
    const { from, to } = periodBounds(key, nowIso)
    const rows = usable.filter((s) => {
      const d = (s.date ?? '').slice(0, 10)
      return d !== '' && d >= from && d <= to
    })
    if (rows.length === 0) { out[key] = null; continue }
    const stats = laneStats(rows, {}, nowIso)
    out[key] = {
      count: rows.length,
      linehaul: { medianCents: stats.customer.medianCents, lowCents: stats.customer.lowCents, highCents: stats.customer.highCents },
      rate: spread(rows.map((r) => r.revenueCents).filter((v): v is number => typeof v === 'number')),
      perMileCents: stats.customer.perMileCents,
    }
  }
  return out
}
