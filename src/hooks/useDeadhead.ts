import { useEffect, useMemo, useState } from 'react'
import { useLoads } from './useLoads'
import { useDrivers } from './useDrivers'
import { listTimeClockEntries } from '@/lib/apiClient'
import { getStops } from '@/lib/stops'
import { chicagoDateStr } from '@/lib/date'
import { buildDayLegs, totals, emptyMilesByCustomer, type DayEvent, type DaySummary, type DeadheadTotals } from '@/lib/deadhead'
import type { TimeClockEntry } from '@/types'

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
export function useDeadhead(from: string, to: string): DeadheadData {
  const { loads } = useLoads()
  const { drivers } = useDrivers()
  // The fetched window is keyed so "loading" is derived (a new range has no result yet)
  // rather than flipped inside the effect.
  const key = `${from}|${to}`
  const [fetched, setFetched] = useState<{ key: string; rows: TimeClockEntry[]; error: string | null } | null>(null)
  const loading = fetched?.key !== key
  const clock = useMemo(() => (fetched?.key === key ? fetched.rows : []), [fetched, key])
  const error = fetched?.key === key ? fetched.error : null

  useEffect(() => {
    let live = true
    listTimeClockEntries({ from, to })
      .then((rows) => { if (live) setFetched({ key, rows, error: null }) })
      .catch((err: unknown) => { if (live) setFetched({ key, rows: [], error: err instanceof Error ? err.message : String(err) }) })
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

    for (const c of clock) {
      if (c.kind !== 'WORK' || !company.has(c.driverId)) continue
      if (c.clockInAt) push(c.driverId, { at: c.clockInAt, kind: 'CLOCK_IN', odometer: c.clockInOdometer ?? null, place: 'Yard' })
      if (c.clockOutAt) push(c.driverId, { at: c.clockOutAt, kind: 'CLOCK_OUT', odometer: c.clockOutOdometer ?? null, place: 'Yard' })
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

    const out: DriverDay[] = []
    for (const [key, evs] of events) {
      const [driverId, date] = key.split('|')
      out.push({ driverId, driverName: names.get(driverId) ?? driverId, date, summary: buildDayLegs(evs, onboardBefore.get(key) ?? []) })
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.driverName.localeCompare(b.driverName))
  }, [loads, drivers, clock, from, to])

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
