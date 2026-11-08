/**
 * What a lane has actually paid: low, median, average, high, per mile, by month.
 *
 * Three rules shape this file:
 *
 * 1. **An excluded sample is kept and never counted.** Canceled shipments and TONU'd
 *    assignments leave their row behind so the history stays honest about what happened,
 *    but a rate nobody hauled is not a rate.
 * 2. **Own-fleet legs carry no carrier cost.** `costCents` on an OWN_ASSET assignment is
 *    zero because we did not buy anything, so counting it would drag a lane's buy side to
 *    nothing and talk a dispatcher into an offer no carrier will take. They are out of the
 *    carrier side unless somebody asks for them; they are always in the customer side.
 * 3. **No statistic is invented.** A lane with no samples returns nulls — never `NaN`,
 *    never `Infinity`, never a zero that reads like a real number.
 *
 * `medianCents` is the true median (the two middles averaged on an even count).
 * `perMileCents` averages per-sample cents-per-mile over the samples that carry miles,
 * which is the number a rep quotes; samples with no mileage simply do not vote.
 *
 * Pure: no store, no clock (callers pass `nowIso`), no network. Imports are relative
 * because the Lambdas bundle this file by path.
 */
import type {
  LaneRateSampleRecord,
  LaneStats,
  LaneStatsFilters,
  LaneStatsMonth,
  LaneStatsSide,
} from '../types/tms'

/** One sample's contribution to one side: the money, and the miles it covered. */
interface SidePoint {
  amountCents: number
  miles: number | null
}

function amount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const v of values) sum += v
  return Math.round(sum / values.length)
}

function statsOf(points: SidePoint[]): LaneStatsSide {
  if (points.length === 0) {
    return { count: 0, lowCents: null, medianCents: null, avgCents: null, highCents: null, perMileCents: null }
  }
  const sorted = points.map((p) => p.amountCents).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  const perMile: number[] = []
  for (const p of points) {
    if (p.miles != null) perMile.push(p.amountCents / p.miles)
  }
  return {
    count: points.length,
    lowCents: sorted[0],
    medianCents: median,
    avgCents: average(sorted),
    highCents: sorted[sorted.length - 1],
    perMileCents: average(perMile),
  }
}

/**
 * The samples a filter leaves standing: not excluded, inside the window, and of the
 * asked-for equipment and rate type. The window is inclusive at its edge — a sample
 * dated exactly `windowDays` ago is in the last `windowDays`.
 */
function usable(
  samples: LaneRateSampleRecord[],
  filters: LaneStatsFilters,
  nowIso: string,
): LaneRateSampleRecord[] {
  const window = filters.windowDays ?? 'ALL'
  const now = Date.parse(nowIso)
  const from = window === 'ALL' || !Number.isFinite(now)
    ? null
    : new Date(now - window * 86_400_000).toISOString().slice(0, 10)
  const equipment = (filters.equipmentType ?? '').trim().toUpperCase()

  return samples.filter((s) => {
    if (s.excluded) return false
    const date = (s.date ?? '').slice(0, 10)
    if (!date) return false
    if (from != null && date < from) return false
    if (equipment && (s.equipmentType ?? '').trim().toUpperCase() !== equipment) return false
    if (filters.rateType && s.rateType !== filters.rateType) return false
    return true
  })
}

/**
 * Both sides of a lane over the filtered window, plus the month strip the panel draws.
 * An empty lane is counts of zero and statistics of null, which renders as "no history"
 * rather than as free freight.
 */
export function laneStats(
  samples: LaneRateSampleRecord[],
  filters: LaneStatsFilters,
  nowIso: string,
): LaneStats {
  const rows = usable(samples ?? [], filters ?? {}, nowIso)
  const includeOwnFleet = filters?.includeOwnFleetCost === true

  const customer: SidePoint[] = []
  const carrier: SidePoint[] = []
  const margins: number[] = []
  const miles: number[] = []
  const months = new Map<string, { customer: number[]; carrier: number[]; count: number }>()
  let lastAt: string | null = null

  for (const sample of rows) {
    const date = sample.date.slice(0, 10)
    // Miles only count when there are some: a zero-mile sample has no cents per mile.
    const sampleMiles = typeof sample.miles === 'number' && Number.isFinite(sample.miles) && sample.miles > 0
      ? sample.miles
      : null
    const month = date.slice(0, 7)
    const bucket = months.get(month) ?? { customer: [], carrier: [], count: 0 }
    bucket.count += 1

    // The customer paid the quoted rate, or the billed revenue when there was no rate.
    const sell = amount(sample.customerRateCents) ?? amount(sample.revenueCents)
    if (sell != null) {
      customer.push({ amountCents: sell, miles: sampleMiles })
      bucket.customer.push(sell)
    }
    // Our own truck bought nothing, so its zero cost stays out of the buy side.
    const buy = !includeOwnFleet && sample.assignmentKind === 'OWN_ASSET'
      ? null
      : (amount(sample.carrierRateCents) ?? amount(sample.costCents))
    if (buy != null) {
      carrier.push({ amountCents: buy, miles: sampleMiles })
      bucket.carrier.push(buy)
    }
    months.set(month, bucket)

    const margin = amount(sample.marginBps)
    if (margin != null) margins.push(margin)
    if (sampleMiles != null) miles.push(sampleMiles)
    if (lastAt == null || date > lastAt) lastAt = date
  }

  const byMonth: LaneStatsMonth[] = [...months.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([month, bucket]) => ({
      month,
      customerAvgCents: average(bucket.customer),
      carrierAvgCents: average(bucket.carrier),
      count: bucket.count,
    }))

  return {
    customer: statsOf(customer),
    carrier: statsOf(carrier),
    marginAvgBps: average(margins),
    milesAvg: average(miles),
    byMonth,
    lastAt,
  }
}

export interface LaneFallback {
  samples: LaneRateSampleRecord[]
  basis: 'EXACT' | 'ZIP3' | 'NONE'
  /** What the panel says above the numbers, so nobody mistakes a ZIP3 average for the lane. */
  badge: string
}

/**
 * Which set of samples the panel should show: this exact lane when it has any history,
 * the ZIP3 neighbourhood when it does not, nothing when neither does. Excluded samples
 * are dropped here too, so the badge's count is the count the statistics will use.
 *
 * A set whose key is null cannot be a basis — samples without the key that selected them
 * are not evidence about this lane.
 */
export function laneFallback(
  exact: LaneRateSampleRecord[],
  zip3: LaneRateSampleRecord[],
  exactLaneKey: string | null,
  zip3Key: string | null,
): LaneFallback {
  const exactRows = exactLaneKey ? (exact ?? []).filter((s) => !s.excluded) : []
  if (exactRows.length > 0) {
    return {
      samples: exactRows,
      basis: 'EXACT',
      badge: `${exactRows.length} ${exactRows.length === 1 ? 'load' : 'loads'} on this lane`,
    }
  }

  const zipRows = zip3Key ? (zip3 ?? []).filter((s) => !s.excluded) : []
  if (zipRows.length > 0) {
    return {
      samples: zipRows,
      basis: 'ZIP3',
      badge: `${zipRows.length} ${zipRows.length === 1 ? 'load' : 'loads'} ${(zip3Key ?? '').replace('>', '→')}`,
    }
  }

  return { samples: [], basis: 'NONE', badge: 'No history on this lane' }
}
