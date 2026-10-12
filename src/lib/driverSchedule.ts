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

/**
 * How far along a whole shipment is: delivered when its last delivery is departed, or, for
 * drivers who do not tap stops (owner operators), when the POD has been submitted.
 */
export function loadState(load: Load, hasPod?: (load: Load) => boolean): LoadState {
  if (hasPod?.(load)) return 'COMPLETED'
  const stops = getStops(load)
  if (stops.length === 0) return 'UPCOMING'
  const deliveries = stops.filter((s) => s.type === 'delivery')
  const last = deliveries[deliveries.length - 1] ?? stops[stops.length - 1]
  if (last.departedAt) return 'COMPLETED'
  if (stops.some((s) => s.arrivedAt || s.departedAt)) return 'IN_PROGRESS'
  return 'UPCOMING'
}

/** Every shipment of an owner operator's that touches the week starting `weekStart` (Sunday). */
export function ownerOperatorWeek(loads: readonly Load[], driverId: string, weekStart: string, hasPod?: (load: Load) => boolean): WeekSchedule {
  const weekEnd = new Date(Date.parse(`${weekStart}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10)
  const rows: WeekLoad[] = []
  for (const load of loads) {
    if (!driverIsOnLoad(load, driverId)) continue
    const stops = getStops(load)
    const days = stops.map(stopDay).filter((d): d is string => !!d)
    if (!days.some((d) => d >= weekStart && d <= weekEnd)) continue
    const appts = stops.map((s) => s.appt).filter((a) => a && !Number.isNaN(Date.parse(a))).sort()
    const state = loadState(load, hasPod)
    rows.push({ load, state, startsAt: appts[0] ?? null, stopsDone: state === 'COMPLETED' ? stops.length : stops.filter((s) => stopState(s) === 'DONE').length, stopsTotal: stops.length })
  }
  rows.sort((a, b) => String(a.startsAt ?? '').localeCompare(String(b.startsAt ?? '')))
  return {
    loads: rows,
    completed: rows.filter((r) => r.state === 'COMPLETED').length,
    inProgress: rows.filter((r) => r.state === 'IN_PROGRESS').length,
    upcoming: rows.filter((r) => r.state === 'UPCOMING').length,
  }
}

export interface DriverStopEvent {
  event: 'ARRIVED' | 'DEPARTED'
  stopType: Stop['type']
  stopName: string | null
  at: string
  /** The words dispatch uses: On site at pickup / Departed pickup / On site at delivery / Delivered. */
  label: string
  load: Load
}

/**
 * The most recent facility event THIS driver reported, across their loads. A load's other
 * stops may belong to another driver (Eulalio picks up, Jason delivers), and his delivery
 * must never read as hers.
 */
export function lastStopEventForDriver(loads: readonly Load[], driverId: string): DriverStopEvent | null {
  let best: DriverStopEvent | null = null
  for (const load of loads) {
    for (const s of getStops(load)) {
      if (s.driverId !== driverId) continue
      const candidates: Array<['ARRIVED' | 'DEPARTED', string | null | undefined]> = [['ARRIVED', s.arrivedAt], ['DEPARTED', s.departedAt]]
      for (const [event, at] of candidates) {
        if (!at || Number.isNaN(Date.parse(at))) continue
        if (best && at <= best.at) continue
        const delivery = s.type === 'delivery'
        best = {
          event, stopType: s.type, stopName: s.name?.trim() || null, at, load,
          label: event === 'ARRIVED' ? (delivery ? 'On site at delivery' : 'On site at pickup') : (delivery ? 'Delivered' : 'Departed pickup'),
        }
      }
    }
  }
  return best
}
