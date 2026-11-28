/**
 * Legacy `/dashboard` KPI rollup (Step AF): loads, revenue and broker-covered per day per
 * driver pair, so the six KPI cards never need the year's loads in the browser.
 *
 * Relative imports only (the Lambda bundles this).
 *
 * A load counts on the day it was DELIVERED, the same date basis and rules as the Finances page
 * (`fleetProfitability`): the day is the first ten characters of the stored `deliveryAppt`, a voided load
 * counts nowhere, and a load with no delivery date counts in no month. It is attributed to its delivery
 * driver. (Schema v1 counted by Chicago pickup day and the pickup driver; `LEGACY_SCHEMA_VERSION` 2 marks
 * the change, so a stored v1 row is never read as delivery figures.)
 *
 * `reduceLegacy` reproduces the arithmetic of the old `useDashboardMetrics` KPI block
 * (`loadsByFleet`, `revenueByFleet`, `revenueConnected`, deltas, broker-covered).
 */
import { fleetBucketOf, loadsByFleet, revenueByFleet } from './revenueByFleet'
import type { FleetDriver, FleetBucket, LoadsSplit, RevenueSplit } from './revenueByFleet'

/** Schema of the `LG:` rows. v2: counted by delivery day and delivery driver (v1: Chicago pickup day, pickup driver). */
export const LEGACY_SCHEMA_VERSION = 2

export interface LegacyLoadLite {
  id: string
  shipmentId?: string | null
  pickupAppt?: string | null
  deliveryAppt?: string | null
  pickupDriverId?: string | null
  deliveryDriverId?: string | null
  /** Cents. */
  rate?: number | null
  voidedAt?: string | null
}

export interface LegacyMonthSource {
  /** Every load whose `deliveryAppt` starts with `month` ('YYYY-MM'); voided ones may be included (compute drops them). */
  loadsDeliveredIn(month: string): Promise<LegacyLoadLite[]>
}

export interface LegacyPair { n: number; rev: number; rated: number }
export interface LegacyMonthPayload {
  v: 1
  /** `'YYYY-MM-DD'` (delivery day) → `'<pickupDriverId>|<deliveryDriverId>'` → counters. */
  days: Record<string, Record<string, LegacyPair>>
}

/** `'YYYY-MM-DD'` of a stored delivery time: its first ten characters, exactly what Finances reads; `''` when absent or not a date. */
export function deliveryDay(deliveryAppt: string | null | undefined): string {
  const day = (deliveryAppt ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
}

/**
 * One month of legacy counters: the loads delivered in `month` (by `deliveryDay`). A voided load is not
 * counted, and a load with no delivery date is in no month.
 */
export async function computeLegacyMonth(src: LegacyMonthSource, month: string): Promise<LegacyMonthPayload> {
  const payload: LegacyMonthPayload = { v: 1, days: {} }
  for (const load of await src.loadsDeliveredIn(month)) {
    if (load.voidedAt) continue
    const day = deliveryDay(load.deliveryAppt)
    if (!day.startsWith(`${month}-`)) continue
    const pair = `${load.pickupDriverId ?? ''}|${load.deliveryDriverId ?? ''}`
    const byPair = (payload.days[day] ??= {})
    const slot = (byPair[pair] ??= { n: 0, rev: 0, rated: 0 })
    slot.n += 1
    slot.rev += load.rate ?? 0
    if ((load.rate ?? 0) > 0) slot.rated += 1
  }
  return payload
}

export interface LegacyRange {
  /** Inclusive `YYYY-MM-DD`. */
  from: string
  to: string
  prevFrom: string
  prevTo: string
}

export interface LegacyKpis {
  totalLoads: number
  totalLoadsDelta: number
  loadsSplit: LoadsSplit
  revenue: number
  revenueSplit: RevenueSplit
  revenueDelta: number
  revenueConnected: boolean
  brokerLoads: number
  brokerLoadsDelta: number
  brokerRevenue: number
  brokerRevenueDelta: number
}

interface Period {
  loads: number
  revenue: number
  rated: number
  brokerLoads: number
  brokerRevenue: number
  byFleet: Map<FleetBucket, { loads: number; revenue: number; ratedLoads: number }>
  unrated: number
}

function bucketOfPair(pair: string, byId: Map<string, FleetDriver>): FleetBucket {
  const delivery = pair.split('|')[1] ?? ''
  return fleetBucketOf(delivery ? byId.get(delivery) : undefined)
}

function reducePeriod(rows: LegacyMonthPayload[], from: string, to: string, byId: Map<string, FleetDriver>, brokerIds: Set<string>): Period {
  const period: Period = { loads: 0, revenue: 0, rated: 0, brokerLoads: 0, brokerRevenue: 0, byFleet: new Map(), unrated: 0 }
  for (const row of rows) {
    for (const [day, pairs] of Object.entries(row.days)) {
      if (day < from || day > to) continue
      for (const [pair, v] of Object.entries(pairs)) {
        const delivery = pair.split('|')[1] ?? ''
        period.loads += v.n
        period.revenue += v.rev
        period.rated += v.rated
        period.unrated += v.n - v.rated
        if (delivery && brokerIds.has(delivery)) {
          period.brokerLoads += v.n
          period.brokerRevenue += v.rev
        }
        const bucket = bucketOfPair(pair, byId)
        const slot = period.byFleet.get(bucket) ?? { loads: 0, revenue: 0, ratedLoads: 0 }
        slot.loads += v.n
        slot.revenue += v.rev
        slot.ratedLoads += v.rated
        period.byFleet.set(bucket, slot)
      }
    }
  }
  return period
}

/** The six KPI cards' figures from the stored month rows, the same numbers the store arithmetic gave. */
export function reduceLegacy(rows: LegacyMonthPayload[], range: LegacyRange, drivers: FleetDriver[]): LegacyKpis {
  const byId = new Map(drivers.map((d) => [d.id, d]))
  const brokerIds = new Set(drivers.filter((d) => d.type === 'broker').map((d) => d.id))
  const current = reducePeriod(rows, range.from, range.to, byId, brokerIds)
  const previous = reducePeriod(rows, range.prevFrom, range.prevTo, byId, brokerIds)

  // Start from the empty split so bucket order and labels stay the single source of truth.
  const loadsSplit = loadsByFleet([], drivers, 'delivery')
  for (const row of loadsSplit.byBucket) row.loads = current.byFleet.get(row.bucket)?.loads ?? 0
  loadsSplit.total = current.loads

  const revenueSplit = revenueByFleet([], drivers, 'delivery')
  for (const row of revenueSplit.byBucket) {
    const slot = current.byFleet.get(row.bucket)
    row.revenue = slot?.ratedLoads ? slot.revenue : 0
    row.loads = slot?.ratedLoads ?? 0
  }
  revenueSplit.total = revenueSplit.byBucket.reduce((sum, row) => sum + row.revenue, 0)
  revenueSplit.unrated = current.unrated

  const revenueConnected = current.rated > 0
  return {
    totalLoads: current.loads,
    totalLoadsDelta: current.loads - previous.loads,
    loadsSplit,
    revenue: current.revenue,
    revenueSplit,
    revenueDelta: revenueConnected || previous.rated > 0 ? current.revenue - previous.revenue : 0,
    revenueConnected,
    brokerLoads: current.brokerLoads,
    brokerLoadsDelta: current.brokerLoads - previous.brokerLoads,
    brokerRevenue: current.brokerRevenue,
    brokerRevenueDelta: current.brokerRevenue - previous.brokerRevenue,
  }
}
