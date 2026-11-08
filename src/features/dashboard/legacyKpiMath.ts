/**
 * The legacy `/dashboard` KPI arithmetic over the store's loads: the reference implementation
 * that the old dashboard-metrics hook held (moved verbatim, trimmed to the figures the page
 * renders). `reduceLegacy` over the `LG:` rollup rows must give the same numbers; the page
 * only runs this when the rollup is unusable.
 */
import { isLoadVoided } from '@/lib/shipmentVoid'
import { revenueByFleet, loadsByFleet } from '@/lib/revenueByFleet'
import type { LegacyKpis, LegacyRange } from '@/lib/dashboardRollupLegacy'
import type { Driver, Load } from '@/types'

export type DateRangeKey = 'today' | 'this-week' | 'this-month' | 'this-quarter' | 'this-year'

function getRange(key: DateRangeKey, now: Date): { start: Date; end: Date } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (key) {
    case 'today':
      // `end` is a day start like every other range's: `loadsInRange` already adds the day.
      // (The old `+ 1 day - 1 ms` made Today also count tomorrow's pickups.)
      return { start: today, end: today }

    case 'this-week': {
      const day = today.getDay() // 0=Sun
      const mon = new Date(today); mon.setDate(today.getDate() - (day === 0 ? 6 : day - 1))
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
      return { start: mon, end: sun }
    }

    case 'this-month': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1)
      const end   = new Date(today.getFullYear(), today.getMonth() + 1, 0)
      return { start, end }
    }

    case 'this-quarter': {
      const q = Math.floor(today.getMonth() / 3)
      const start = new Date(today.getFullYear(), q * 3, 1)
      const end   = new Date(today.getFullYear(), q * 3 + 3, 0)
      return { start, end }
    }

    case 'this-year': {
      const start = new Date(today.getFullYear(), 0, 1)
      const end   = new Date(today.getFullYear(), 11, 31)
      return { start, end }
    }
  }
}

/** Local calendar day, `YYYY-MM-DD` (never through UTC). */
function localDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export interface LegacyWindow extends LegacyRange {
  start: Date
  end: Date
  prevStart: Date
  prevEnd: Date
}

/** The range chip's current and previous (equal-length) periods, in the browser's local calendar. */
export function legacyWindow(key: DateRangeKey, now: Date): LegacyWindow {
  const { start, end } = getRange(key, now)
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  // Calendar-day arithmetic: subtracting 24 h multiples lands on the wrong day across a DST edge.
  const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - days)
  const prevEnd = new Date(end); prevEnd.setDate(prevEnd.getDate() - days)
  return {
    start, end, prevStart, prevEnd,
    from: localDay(start), to: localDay(end), prevFrom: localDay(prevStart), prevTo: localDay(prevEnd),
  }
}

function loadsInRange(loads: Load[], start: Date, end: Date): Load[] {
  const s = start.getTime()
  const e = end.getTime() + 86_400_000  // inclusive end
  return loads.filter((l) => {
    const t = new Date(l.pickupAppt).getTime()
    return t >= s && t < e
  })
}

/** Exact path: the six cards' load-derived figures from the loads in the store. */
export function legacyKpisFromLoads(allLoads: Load[], drivers: Driver[], win: Pick<LegacyWindow, 'start' | 'end' | 'prevStart' | 'prevEnd'>): LegacyKpis {
  // A voided load is not live work and is counted in no dashboard figure.
  const loads = allLoads.filter((l) => !isLoadVoided(l))
  const current  = loadsInRange(loads, win.start, win.end)
  const previous = loadsInRange(loads, win.prevStart, win.prevEnd)

  const totalLoads      = current.length
  const totalLoadsDelta = totalLoads - previous.length

  const revenue          = current.reduce((sum, l) => sum + (l.rate ?? 0), 0)
  const revenueSplit     = revenueByFleet(current, drivers)
  const loadsSplit       = loadsByFleet(current, drivers)
  const prevRevenue      = previous.reduce((sum, l) => sum + (l.rate ?? 0), 0)
  const revenueConnected = current.some((l) => l.rate != null && l.rate > 0)
  const revenueConnectedPrev = previous.some((l) => l.rate != null && l.rate > 0)
  const revenueDelta     = revenueConnected || revenueConnectedPrev ? revenue - prevRevenue : 0

  // Broker-covered loads = a load whose pickup or delivery driver is a broker.
  const brokerIds = new Set(drivers.filter((d) => d.type === 'broker').map((d) => d.id))
  const isBrokerCovered = (l: Load) =>
    (!!l.deliveryDriverId && brokerIds.has(l.deliveryDriverId)) || (!!l.pickupDriverId && brokerIds.has(l.pickupDriverId))
  const brokerCur  = current.filter(isBrokerCovered)
  const brokerPrev = previous.filter(isBrokerCovered)
  const brokerLoads        = brokerCur.length
  const brokerLoadsDelta   = brokerLoads - brokerPrev.length
  const brokerRevenue      = brokerCur.reduce((s, l) => s + (l.rate ?? 0), 0)
  const brokerRevenueDelta = brokerRevenue - brokerPrev.reduce((s, l) => s + (l.rate ?? 0), 0)

  return {
    totalLoads, totalLoadsDelta, loadsSplit,
    revenue, revenueSplit, revenueDelta, revenueConnected,
    brokerLoads, brokerLoadsDelta, brokerRevenue, brokerRevenueDelta,
  }
}
