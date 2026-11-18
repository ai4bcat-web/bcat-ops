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

/**
 * The range chip's current period, to date: week, month and quarter end TODAY (not at their last day), so a card reads
 * "Nov 1-18" in the middle of November and the previous period can be cut to the same length. A load picked up later this
 * month is counted when its day arrives. Today is just today.
 */
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
      return { start: mon, end: today }
    }

    case 'this-month':
      return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: today }

    case 'this-quarter': {
      const q = Math.floor(today.getMonth() / 3)
      return { start: new Date(today.getFullYear(), q * 3, 1), end: today }
    }

    case 'this-year':
      return { start: new Date(today.getFullYear(), 0, 1), end: today }
  }
}

/**
 * The period a card is read against: the same stretch of the previous week, month, quarter or year, cut off on the same
 * day, so a month 18 days in meets the first 18 days of last month (not all of it). A shorter previous month ends on its
 * own last day (the 30th meets February 28th). Today is read against yesterday.
 */
function previousPeriod(key: DateRangeKey, start: Date, end: Date): { prevStart: Date; prevEnd: Date } {
  const y = start.getFullYear()
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  switch (key) {
    case 'today': {
      const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 1)
      return { prevStart, prevEnd: new Date(prevStart) }
    }
    case 'this-week': {
      // Calendar-day arithmetic: subtracting 24 h multiples lands on the wrong day across a DST edge.
      const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 7)
      const prevEnd = new Date(end); prevEnd.setDate(prevEnd.getDate() - 7)
      return { prevStart, prevEnd }
    }
    case 'this-month': {
      const m = start.getMonth()
      const prevStart = new Date(y, m - 1, 1)
      const prevLast = new Date(y, m, 0).getDate()
      return { prevStart, prevEnd: new Date(y, m - 1, Math.min(end.getDate(), prevLast)) }
    }
    case 'this-quarter': {
      const qm = start.getMonth()
      const prevStart = new Date(y, qm - 3, 1)
      const prevEnd = new Date(prevStart); prevEnd.setDate(prevEnd.getDate() + spanDays - 1)
      const prevQuarterEnd = new Date(y, qm, 0)
      return { prevStart, prevEnd: prevEnd > prevQuarterEnd ? prevQuarterEnd : prevEnd }
    }
    case 'this-year': {
      const prevStart = new Date(y - 1, 0, 1)
      const prevEnd = new Date(y - 1, end.getMonth(), end.getDate())
      return { prevStart, prevEnd: prevEnd.getMonth() === end.getMonth() ? prevEnd : new Date(y - 1, end.getMonth() + 1, 0) }
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

/** The range chip's current period (to date) and the matching stretch of the previous one, in the browser's local calendar. */
export function legacyWindow(key: DateRangeKey, now: Date): LegacyWindow {
  const { start, end } = getRange(key, now)
  const { prevStart, prevEnd } = previousPeriod(key, start, end)
  return {
    start, end, prevStart, prevEnd,
    from: localDay(start), to: localDay(end), prevFrom: localDay(prevStart), prevTo: localDay(prevEnd),
  }
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Oct 1–18` inside one month, `Jul 1 – Sep 18` across two, `Oct 1` for a single day. */
export function periodLabel(from: Date, to: Date): string {
  const a = `${MONTH_ABBR[from.getMonth()]} ${from.getDate()}`
  if (from.getTime() === to.getTime()) return a
  if (from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear()) return `${a}–${to.getDate()}`
  return `${a} – ${MONTH_ABBR[to.getMonth()]} ${to.getDate()}`
}

/** What a card's change badge is read against: "vs. Oct 1–18", "vs. yesterday". */
export function compareLabel(key: DateRangeKey, win: Pick<LegacyWindow, 'prevStart' | 'prevEnd'>): string {
  return key === 'today' ? 'vs. yesterday' : `vs. ${periodLabel(win.prevStart, win.prevEnd)}`
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
