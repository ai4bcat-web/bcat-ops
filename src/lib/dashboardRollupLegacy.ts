/**
 * Legacy `/dashboard` KPI rollup (Step AF): loads, revenue and broker-covered per day per
 * driver pair, so the six KPI cards never need the year's loads in the browser.
 *
 * Relative imports only (the Lambda bundles this). Days are America/Chicago calendar days
 * (the legacy page computed ranges in browser-local time, which is Chicago for the office).
 *
 * `reduceLegacy` reproduces the arithmetic of the old `useDashboardMetrics` KPI block
 * (`loadsByFleet`, `revenueByFleet`, `revenueConnected`, deltas, broker-covered).
 */
import { fleetBucketOf, loadsByFleet, revenueByFleet } from './revenueByFleet'
import type { FleetDriver, FleetBucket, LoadsSplit, RevenueSplit } from './revenueByFleet'
import type { ShipmentLite } from './dashboardRollup'

export interface LegacyLoadLite {
  id: string
  shipmentId?: string | null
  pickupAppt?: string | null
  pickupDriverId?: string | null
  deliveryDriverId?: string | null
  /** Cents. */
  rate?: number | null
  voidedAt?: string | null
}

export interface LegacyMonthSource {
  shipments(month: string): Promise<ShipmentLite[]>
  loadsOf(shipmentIds: string[]): Promise<LegacyLoadLite[]>
}

export interface LegacyPair { n: number; rev: number; rated: number }
export interface LegacyMonthPayload {
  v: 1
  /** `'YYYY-MM-DD'` (Chicago) → `'<pickupDriverId>|<deliveryDriverId>'` → counters. */
  days: Record<string, Record<string, LegacyPair>>
}

const chicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })

/** `'YYYY-MM-DD'` of an instant in America/Chicago; `''` for an unparsable value. */
export function chicagoDay(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : chicago.format(at)
}

function adjacentMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const index = y * 12 + (m - 1) + delta
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

/**
 * One month of legacy counters (Chicago month). Reads the shipments of the month and both
 * neighbours (a Chicago day can sit across the UTC month edge) and keeps the loads whose
 * Chicago pickup day is inside `month`. Voided shipments' loads are not counted.
 */
export async function computeLegacyMonth(src: LegacyMonthSource, month: string): Promise<LegacyMonthPayload> {
  const live = new Map<string, ShipmentLite>()
  for (const m of [adjacentMonth(month, -1), month, adjacentMonth(month, 1)]) {
    for (const shipment of await src.shipments(m)) if (!shipment.voidedAt) live.set(shipment.id, shipment)
  }
  const payload: LegacyMonthPayload = { v: 1, days: {} }
  const ids = [...live.keys()]
  if (ids.length === 0) return payload

  for (const load of await src.loadsOf(ids)) {
    if (load.voidedAt || !load.shipmentId || !live.has(load.shipmentId) || !load.pickupAppt) continue
    const day = chicagoDay(load.pickupAppt)
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
  /** Inclusive `YYYY-MM-DD` (Chicago). */
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
  const [pickup = '', delivery = ''] = pair.split('|')
  const id = pickup || delivery
  return fleetBucketOf(id ? byId.get(id) : undefined)
}

function reducePeriod(rows: LegacyMonthPayload[], from: string, to: string, byId: Map<string, FleetDriver>, brokerIds: Set<string>): Period {
  const period: Period = { loads: 0, revenue: 0, rated: 0, brokerLoads: 0, brokerRevenue: 0, byFleet: new Map(), unrated: 0 }
  for (const row of rows) {
    for (const [day, pairs] of Object.entries(row.days)) {
      if (day < from || day > to) continue
      for (const [pair, v] of Object.entries(pairs)) {
        const [pickup = '', delivery = ''] = pair.split('|')
        period.loads += v.n
        period.revenue += v.rev
        period.rated += v.rated
        period.unrated += v.n - v.rated
        if ((delivery && brokerIds.has(delivery)) || (pickup && brokerIds.has(pickup))) {
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
  const loadsSplit = loadsByFleet([], drivers)
  for (const row of loadsSplit.byBucket) row.loads = current.byFleet.get(row.bucket)?.loads ?? 0
  loadsSplit.total = current.loads

  const revenueSplit = revenueByFleet([], drivers)
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
