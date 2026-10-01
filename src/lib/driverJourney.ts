/**
 * Which load is a driver's right now, and how fresh their position is.
 *
 * Driver-reported status was removed: the office gets what it needs from the
 * documents arriving and from the ELD, and asking a driver to tap a progression
 * on top of that was work for no reader. Stop-level `arrivedAt`/`departedAt`
 * remain the record of actual facility events.
 *
 * Position is NOT collected by the PWA. A browser cannot track location in the
 * background with any reliability, so the dashboard uses the ELD fix and this
 * module only says how old that fix is.
 *
 * Pure: no AWS, no fetch, no clock. The PWA, the driver API and the dashboard
 * all import it so they agree on which load is current.
 */
// Relative, not '@/' — this module is bundled into the driver-app-api Lambda by
// esbuild, which does not know the Vite path alias. See amplify.yml.
import { getStops } from './stops'
import type { Load, Stop } from '../types'

/** True when this driver is on any stop of the load. */
export function driverIsOnLoad(load: Load, driverId: string): boolean {
  if (!driverId) return false
  const stops = getStops(load)
  if (stops.some((s: Stop) => s.driverId === driverId)) return true
  // Legacy loads with no stops array still carry the mirrored driver fields.
  return load.pickupDriverId === driverId || load.deliveryDriverId === driverId
}

/** Earliest appointment on the load, used to order a driver's work. */
export function firstApptAt(load: Load): string {
  const stops = getStops(load)
  const appts = stops.map((s: Stop) => s.appt).filter(Boolean).sort()
  return appts[0] ?? load.pickupAppt ?? ''
}

/** Latest appointment on the load — when the driver is finished with it. */
export function lastApptAt(load: Load): string {
  const stops = getStops(load)
  const appts = stops.map((s: Stop) => s.appt).filter(Boolean).sort()
  return appts[appts.length - 1] ?? load.deliveryAppt ?? load.pickupAppt ?? ''
}

/**
 * How long after its last appointment a load still counts as the driver's current one.
 *
 * Driver-reported status used to answer this: a load left the list when the driver
 * marked it delivered. Without that, the appointment is the only honest signal, and it
 * needs slack — a delivery can run late, and a driver finishing at midnight should
 * still see that load the next morning when they send the POD.
 */
export const CURRENT_LOAD_GRACE_HOURS = 36

/**
 * The one load a driver is working now: theirs, its last appointment not long past,
 * soonest first. Returns null when they have nothing open — which the PWA shows as a
 * rest state rather than an error.
 *
 * `now` is passed in rather than read from a clock so this stays pure and testable.
 */
export function currentLoadForDriver(loads: Load[], driverId: string, now: number): Load | null {
  const cutoff = now - CURRENT_LOAD_GRACE_HOURS * 60 * 60 * 1000
  const open = loads.filter((l) => {
    if (!driverIsOnLoad(l, driverId)) return false
    const last = lastApptAt(l)
    // A load with no appointment at all is still theirs; nothing says it is finished.
    if (!last) return true
    const at = Date.parse(last)
    return Number.isNaN(at) ? true : at >= cutoff
  })
  if (!open.length) return null
  return open.sort((a, b) => firstApptAt(a).localeCompare(firstApptAt(b)))[0]
}

/** Current load per driver, for the fleet dashboard. */
export function currentLoadByDriver(loads: Load[], driverIds: string[], now: number): Map<string, Load> {
  const out = new Map<string, Load>()
  for (const id of driverIds) {
    const load = currentLoadForDriver(loads, id, now)
    if (load) out.set(id, load)
  }
  return out
}

/**
 * Loads a driver could reasonably be sending paperwork for: theirs, from the recent
 * past through anything upcoming, newest first.
 *
 * This is what the attach picker offers. It is deliberately wider than the current
 * load — a POD photographed at a dock on Friday may only get attached on Monday, and a
 * driver must be able to find last week's load to put it on.
 */
export function recentLoadsForDriver(
  loads: Load[],
  driverId: string,
  now: number,
  withinDays = 30,
): Load[] {
  const cutoff = now - withinDays * 24 * 60 * 60 * 1000
  return loads
    .filter((l) => {
      if (!driverIsOnLoad(l, driverId)) return false
      const last = lastApptAt(l)
      if (!last) return true
      const at = Date.parse(last)
      return Number.isNaN(at) ? true : at >= cutoff
    })
    .sort((a, b) => lastApptAt(b).localeCompare(lastApptAt(a)))
}

/** "Mesa, AZ → Tempe, AZ", or whichever half is known. */
export function laneLabel(load: Load): string {
  const from = (load.originCity ?? '').trim()
  const to = (load.destinationCity ?? '').trim()
  if (from && to) return `${from} → ${to}`
  return from || to || 'Lane unknown'
}

/**
 * How stale an ELD fix is, in minutes. The dashboard shows a position with no
 * indication of age today, so a day-old fix reads as live.
 */
export function minutesSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((now - t) / 60000))
}

/** Fixes older than this are called out rather than shown as current. */
export const STALE_FIX_MINUTES = 90

export interface FixAge {
  minutes: number | null
  stale: boolean
  /** "4m ago", "3h ago", "2d ago", or "no fix". */
  label: string
}

export function fixAge(iso: string | null | undefined, now: number): FixAge {
  const minutes = minutesSince(iso, now)
  if (minutes === null) return { minutes: null, stale: true, label: 'no fix' }
  const label =
    minutes < 60
      ? `${minutes}m ago`
      : minutes < 60 * 24
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`
  return { minutes, stale: minutes > STALE_FIX_MINUTES, label }
}
