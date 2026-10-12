/**
 * A driver's schedule as the Dispatch page shows it beside their texts.
 *
 * Ivan's local drivers run a day: every stop of theirs today, done / on site / still to
 * do. Owner operators run a week: every shipment of theirs this week, delivered / under
 * way / not started. Pure, on top of the loads already in the store.
 */
import type { Load, Stop } from '@/types'
import { getStops } from './stops'
import { chicagoDateStr } from './date'
import { driverIsOnLoad } from './driverJourney'

export type StopState = 'DONE' | 'IN_PROGRESS' | 'UPCOMING'
export type LoadState = 'COMPLETED' | 'IN_PROGRESS' | 'UPCOMING'

export function stopState(stop: Pick<Stop, 'arrivedAt' | 'departedAt'>): StopState {
  if (stop.departedAt) return 'DONE'
  if (stop.arrivedAt) return 'IN_PROGRESS'
  return 'UPCOMING'
}

/** The Chicago day a stop belongs to: when it was actually worked, else its appointment. */
export function stopDay(stop: Pick<Stop, 'appt' | 'arrivedAt' | 'departedAt'>): string | null {
  for (const at of [stop.arrivedAt, stop.departedAt, stop.appt]) {
    if (at && !Number.isNaN(Date.parse(at))) return chicagoDateStr(at)
  }
  return null
}

export interface DayStop {
  load: Load
  stop: Stop
  state: StopState
  /** The appointment is impossible as entered: a delivery before its pickup. */
  apptWarning?: string | null
}

export interface DaySchedule {
  stops: DayStop[]
  done: number
  inProgress: number
  total: number
}

/** Today's stops for one of Ivan's drivers, in appointment order. */
export function ivanDaySchedule(loads: readonly Load[], driverId: string, today: string): DaySchedule {
  const stops: DayStop[] = []
  for (const load of loads) {
    for (const stop of getStops(load)) {
      if (stop.driverId !== driverId) continue
      if (stopDay(stop) !== today) continue
      stops.push({ load, stop, state: stopState(stop) })
    }
  }
  // A load's stops stay in route order (pickup before its delivery) whatever the clock
  // says: the office sometimes types a delivery time earlier than the pickup, and showing
  // the delivery first makes one load read as two. Loads order by their earliest stop.
  const anchor = new Map<string, string>()
  for (const { load, stop } of stops) {
    const t = String(stop.appt ?? '')
    const cur = anchor.get(load.id)
    if (cur === undefined || (t && t < cur)) anchor.set(load.id, t)
  }
  stops.sort((a, b) =>
    (anchor.get(a.load.id) ?? '').localeCompare(anchor.get(b.load.id) ?? '') ||
    a.load.id.localeCompare(b.load.id) ||
    a.stop.sequence - b.stop.sequence)
  for (const item of stops) {
    const earlierPickup = stops.find((o) => o.load.id === item.load.id && o.stop.type === 'pickup' && o.stop.sequence < item.stop.sequence)
    if (item.stop.type === 'delivery' && earlierPickup && item.stop.appt && earlierPickup.stop.appt && item.stop.appt < earlierPickup.stop.appt) {
      item.apptWarning = 'Delivery appointment is before the pickup; check the times on the load'
    }
  }
  return {
    stops,
    done: stops.filter((s) => s.state === 'DONE').length,
    inProgress: stops.filter((s) => s.state === 'IN_PROGRESS').length,
    total: stops.length,
  }
}

export interface WeekLoad {
  load: Load
  state: LoadState
  /** First appointment, for ordering and display. */
  startsAt: string | null
  stopsDone: number
  stopsTotal: number
}

export interface WeekSchedule {
  loads: WeekLoad[]
  completed: number
  inProgress: number
  upcoming: number
}

/** How far along a whole shipment is: delivered when its last delivery is departed. */
export function loadState(load: Load): LoadState {
  const stops = getStops(load)
  if (stops.length === 0) return 'UPCOMING'
  const deliveries = stops.filter((s) => s.type === 'delivery')
  const last = deliveries[deliveries.length - 1] ?? stops[stops.length - 1]
  if (last.departedAt) return 'COMPLETED'
  if (stops.some((s) => s.arrivedAt || s.departedAt)) return 'IN_PROGRESS'
  return 'UPCOMING'
}

/** Every shipment of an owner operator's that touches the week starting `weekStart` (Sunday). */
export function ownerOperatorWeek(loads: readonly Load[], driverId: string, weekStart: string): WeekSchedule {
  const weekEnd = new Date(Date.parse(`${weekStart}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10)
  const rows: WeekLoad[] = []
  for (const load of loads) {
    if (!driverIsOnLoad(load, driverId)) continue
    const stops = getStops(load)
    const days = stops.map(stopDay).filter((d): d is string => !!d)
    if (!days.some((d) => d >= weekStart && d <= weekEnd)) continue
    const appts = stops.map((s) => s.appt).filter((a) => a && !Number.isNaN(Date.parse(a))).sort()
    rows.push({ load, state: loadState(load), startsAt: appts[0] ?? null, stopsDone: stops.filter((s) => stopState(s) === 'DONE').length, stopsTotal: stops.length })
  }
  rows.sort((a, b) => String(a.startsAt ?? '').localeCompare(String(b.startsAt ?? '')))
  return {
    loads: rows,
    completed: rows.filter((r) => r.state === 'COMPLETED').length,
    inProgress: rows.filter((r) => r.state === 'IN_PROGRESS').length,
    upcoming: rows.filter((r) => r.state === 'UPCOMING').length,
  }
}
