import { useEffect, useMemo, useState } from 'react'
import { useLoads } from './useLoads'
import { useDrivers } from './useDrivers'
import { listTimeClockEntries } from '@/lib/apiClient'
import { getStops } from '@/lib/stops'
import { chicagoDateStr } from '@/lib/date'
import { buildDayLegs, totals, emptyMilesByCustomer, baseLabelFor, DEADHEAD_START, type DayEvent, type DaySummary, type DeadheadTotals } from '@/lib/deadhead'
import { fetchOdometerDays } from './useTruckOdometer'
import type { TruckOdometerDay } from '@/lib/odometerWeek'
import type { TimeClockEntry } from '@/types'

/** Sunday that opens the week containing `date` (the odometer ledger's week key). */
function sundayOf(date: string): string {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.toISOString().slice(0, 10)
}

/** Every odometer-ledger row for the weeks covering [from, to]. */
async function fetchOdometerRange(from: string, to: string): Promise<TruckOdometerDay[]> {
  const weeks: string[] = []
  for (let w = sundayOf(from); w <= to; ) {
    weeks.push(w)
    const d = new Date(w + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); w = d.toISOString().slice(0, 10)
  }
  const pages = await Promise.all(weeks.map((w) => fetchOdometerDays(w)))
  return pages.flat()
}

function previousDate(date: string): string {
  const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10)
}

export interface DriverDay {
  driverId:   string
  driverName: string
  date:       string        // Chicago YYYY-MM-DD
  summary:    DaySummary
}

export interface DeadheadData {
  days:       DriverDay[]
  loading:    boolean
  error:      string | null
  /** Totals per month key (YYYY-MM). */
  byMonth:    Map<string, DeadheadTotals>
  /** Totals per driver over the whole window. */
  byDriver:   Array<{ driverId: string; driverName: string; days: number } & DeadheadTotals>
  byCustomer: Array<{ customer: string; emptyMiles: number; legs: number }>
  all:        DeadheadTotals
}

/**
 * Loaded vs empty miles for every company driver, one chain per driver per Chicago day,
 * from the odometer readings taken at clock in, each stop tap, and clock out. Owner-operators
 * are not on Motive and are left out. Days before the readings started simply have no legs.
 */
export function useDeadhead(fromRequested: string, to: string): DeadheadData {
  // Nothing before the effective date counts, whatever window the page asks for.
  const from = fromRequested > DEADHEAD_START ? fromRequested : DEADHEAD_START
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  // The fetched window is keyed so "loading" is derived (a new range has no result yet)
  // rather than flipped inside the effect.
  const key = `${from}|${to}`
  const [fetched, setFetched] = useState<{ key: string; rows: TimeClockEntry[]; odometer: TruckOdometerDay[]; error: string | null } | null>(null)
  // Before the effective date there is nothing to fetch, so that window is never "loading".
  const loading = to >= from && fetched?.key !== key
  const clock = useMemo(() => (fetched?.key === key ? fetched.rows : []), [fetched, key])
  const odometerDays = useMemo(() => (fetched?.key === key ? fetched.odometer : []), [fetched, key])
  const error = fetched?.key === key ? fetched.error : null

  useEffect(() => {
    let live = true
    if (to < from) return () => { live = false }
    Promise.all([listTimeClockEntries({ from, to }), fetchOdometerRange(from, to)])
      .then(([rows, odometer]) => { if (live) setFetched({ key, rows, odometer, error: null }) })
      .catch((err: unknown) => { if (live) setFetched({ key, rows: [], odometer: [], error: err instanceof Error ? err.message : String(err) }) })
    return () => { live = false }
  }, [from, to, key])

  const days = useMemo<DriverDay[]>(() => {
    const names = new Map(drivers.map((d) => [d.id, d.name]))
    // Company drivers on Motive trucks: the Ivan local fleet and the box truck. Owner-operators
    // and brokers have no odometer feed and are left out.
    const company = new Set(drivers.filter((d) => d.type !== 'broker' && (d.fleetGroup === 'LOCAL' || d.fleetGroup === 'BOX_TRUCK')).map((d) => d.id))
    const events = new Map<string, DayEvent[]>()           // `${driverId}|${date}`
    const push = (driverId: string, ev: DayEvent) => {
      const date = chicagoDateStr(ev.at)
      if (!date || date < from || date > to) return
      const key = `${driverId}|${date}`
      const list = events.get(key) ?? []
      list.push(ev)
      events.set(key, list)
    }
    // Loads picked up before the window's day and not yet delivered: on board from clock in.
    const onboardBefore = new Map<string, string[]>()      // `${driverId}|${date}` → loadIds

    const baseOf = new Map(drivers.map((d) => [d.id, baseLabelFor(d.fleetGroup)]))
    const clockedDays = new Set<string>()
    for (const c of clock) {
      if (c.kind !== 'WORK' || !company.has(c.driverId)) continue
      const base = baseOf.get(c.driverId) ?? 'Yard'
      if (c.clockInAt) { push(c.driverId, { at: c.clockInAt, kind: 'CLOCK_IN', odometer: c.clockInOdometer ?? null, place: base }); clockedDays.add(`${c.driverId}|${chicagoDateStr(c.clockInAt)}`) }
      if (c.clockOutAt) push(c.driverId, { at: c.clockOutAt, kind: 'CLOCK_OUT', odometer: c.clockOutOdometer ?? null, place: base })
    }

    for (const load of loads) {
      const stops = getStops(load)
      for (const s of stops) {
        const driverId = s.driverId ?? (s.type === 'pickup' ? load.pickupDriverId : load.deliveryDriverId)
        if (!driverId || !company.has(driverId)) continue
        const place = s.name?.trim() || s.city?.trim() || (s.type === 'pickup' ? 'Pickup' : 'Delivery')
        const base = { stopType: s.type as 'pickup' | 'delivery', loadId: load.id, place, customer: load.customer ?? null }
        if (s.arrivedAt) push(driverId, { at: s.arrivedAt, kind: 'ARRIVED', odometer: s.arrivedOdometer ?? null, ...base })
        if (s.departedAt) push(driverId, { at: s.departedAt, kind: 'DEPARTED', odometer: s.departedOdometer ?? null, ...base })
      }
      // A pickup departed on day X with its delivery arrived on a later day (or not yet)
      // rides along overnight: the delivering driver starts day X+1.. loaded.
      const pickup = stops.find((s) => s.type === 'pickup' && s.departedAt)
      const delivery = stops.find((s) => s.type === 'delivery')
      if (pickup?.departedAt && delivery) {
        const deliverer = delivery.driverId ?? load.deliveryDriverId
        if (!deliverer || !company.has(deliverer)) continue
        const pickedDay = chicagoDateStr(pickup.departedAt)
        const deliveredDay = delivery.arrivedAt ? chicagoDateStr(delivery.arrivedAt) : to
        for (const key of events.keys()) {
          const [d, date] = key.split('|')
          if (d === deliverer && date > pickedDay && date <= deliveredDay) {
            onboardBefore.set(key, [...(onboardBefore.get(key) ?? []), load.id])
          }
        }
      }
    }

    // A driver with no time clock (the box truck) still starts and ends every day at the
    // base, so the odometer ledger stands in for the punches: the previous day's closing
    // reading opens the day and this day's closing reading ends it.
    const ledger = new Map<string, Map<string, TruckOdometerDay>>()
    for (const r of odometerDays) {
      let m = ledger.get(r.truckId); if (!m) { m = new Map(); ledger.set(r.truckId, m) }
      m.set(r.date, r)
    }
    const truckOf = new Map(drivers.map((d) => [d.id, d.assignedTruckId ?? null]))
    for (const [key, evs] of events) {
      if (clockedDays.has(key)) continue
      const [driverId, date] = key.split('|')
      const truckId = truckOf.get(driverId)
      const days = truckId ? ledger.get(truckId) : undefined
      if (!days) continue
      const base = baseOf.get(driverId) ?? 'Yard'
      let opening: number | null = null
      for (let d = previousDate(date), i = 0; i < 4 && opening == null; d = previousDate(d), i++) {
        const row = days.get(d); if (typeof row?.endOdometer === 'number') opening = row.endOdometer
      }
      if (opening == null && typeof days.get(date)?.startOdometer === 'number') opening = days.get(date)!.startOdometer!
      const closing = typeof days.get(date)?.endOdometer === 'number' ? days.get(date)!.endOdometer! : null
      const first = evs.reduce((a, e) => (e.at < a ? e.at : a), evs[0].at)
      const last = evs.reduce((a, e) => (e.at > a ? e.at : a), evs[0].at)
      if (opening != null) evs.push({ at: new Date(Date.parse(first) - 1).toISOString(), kind: 'CLOCK_IN', odometer: opening, place: base })
      if (closing != null) evs.push({ at: new Date(Date.parse(last) + 1).toISOString(), kind: 'CLOCK_OUT', odometer: closing, place: base })
    }

    const out: DriverDay[] = []
    for (const [key, evs] of events) {
      const [driverId, date] = key.split('|')
      out.push({ driverId, driverName: names.get(driverId) ?? driverId, date, summary: buildDayLegs(evs, onboardBefore.get(key) ?? []) })
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.driverName.localeCompare(b.driverName))
  }, [loads, drivers, clock, odometerDays, from, to])

  const byMonth = useMemo(() => {
    const groups = new Map<string, DaySummary[]>()
    for (const d of days) {
      const k = d.date.slice(0, 7)
      groups.set(k, [...(groups.get(k) ?? []), d.summary])
    }
    return new Map([...groups.entries()].map(([k, v]) => [k, totals(v)]))
  }, [days])

  const byDriver = useMemo(() => {
    const groups = new Map<string, { driverName: string; summaries: DaySummary[] }>()
    for (const d of days) {
      const g = groups.get(d.driverId) ?? { driverName: d.driverName, summaries: [] }
      g.summaries.push(d.summary)
      groups.set(d.driverId, g)
    }
    return [...groups.entries()]
      .map(([driverId, g]) => ({ driverId, driverName: g.driverName, days: g.summaries.length, ...totals(g.summaries) }))
      .sort((a, b) => b.emptyMiles - a.emptyMiles)
  }, [days])

  const byCustomer = useMemo(() => emptyMilesByCustomer(days.map((d) => d.summary)), [days])
  const all = useMemo(() => totals(days.map((d) => d.summary)), [days])

  return { days, loading, error, byMonth, byDriver, byCustomer, all }
}
