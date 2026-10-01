/**
 * Driver journey: the status a driver reports from the PWA, and which load is
 * theirs right now.
 *
 * One status per load, not per stop — a driver taps a single progression rather
 * than marking every facility. Stop-level `arrivedAt`/`departedAt` remain the
 * record of actual facility events; this is the driver's own reported state, and
 * the two are deliberately separate so a tap never rewrites a facility record.
 *
 * Position is NOT collected here. A browser cannot track location in the
 * background with any reliability, so the dashboard keeps using the ELD fix and
 * a status change only carries whatever position the ELD already knew.
 *
 * Pure: no AWS, no fetch, no clock. The PWA, the driver API and the dashboard
 * all import this so a transition that is legal in one place is legal in all.
 */
import { getStops } from '@/lib/stops'
import type { Load, Stop } from '@/types'

export const DRIVER_STATUSES = ['ASSIGNED', 'EN_ROUTE', 'ON_SITE', 'DELIVERED'] as const
export type DriverStatus = (typeof DRIVER_STATUSES)[number]

/** What a driver sees on the button, not what the database calls it. */
export const DRIVER_STATUS_LABEL: Record<DriverStatus, string> = {
  ASSIGNED: 'Not started',
  EN_ROUTE: 'En route',
  ON_SITE: 'On site',
  DELIVERED: 'Delivered',
}

/**
 * Legal moves. Forward progression plus one backward edge: a driver who has
 * loaded at the pickup goes back to EN_ROUTE for the run to the delivery, which
 * is the normal shape of a one-pickup-one-drop load. DELIVERED is terminal —
 * reopening it is a dispatcher action, not a driver one.
 */
const TRANSITIONS: Record<DriverStatus, DriverStatus[]> = {
  ASSIGNED: ['EN_ROUTE'],
  EN_ROUTE: ['ON_SITE'],
  ON_SITE: ['EN_ROUTE', 'DELIVERED'],
  DELIVERED: [],
}

export function canTransition(from: DriverStatus | null | undefined, to: DriverStatus): boolean {
  const current = from ?? 'ASSIGNED'
  return TRANSITIONS[current]?.includes(to) ?? false
}

/** The moves a driver can make right now, for rendering buttons. */
export function nextStatuses(from: DriverStatus | null | undefined): DriverStatus[] {
  return TRANSITIONS[from ?? 'ASSIGNED'] ?? []
}

/** Human reason a move was refused, for the API's error text. */
export function transitionError(
  from: DriverStatus | null | undefined,
  to: DriverStatus,
): string | null {
  if (canTransition(from, to)) return null
  const current = from ?? 'ASSIGNED'
  if (current === 'DELIVERED') return 'This load is already delivered'
  if (current === to) return `Already marked ${DRIVER_STATUS_LABEL[to].toLowerCase()}`
  return `Cannot go from ${DRIVER_STATUS_LABEL[current].toLowerCase()} to ${DRIVER_STATUS_LABEL[to].toLowerCase()}`
}

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

/**
 * The one load a driver is working now: theirs, not yet delivered, soonest
 * appointment first. Returns null when they have nothing open — which the PWA
 * shows as a rest state rather than an error.
 */
export function currentLoadForDriver(loads: Load[], driverId: string): Load | null {
  const open = loads
    .filter((l) => driverIsOnLoad(l, driverId))
    .filter((l) => (l.driverStatus ?? 'ASSIGNED') !== 'DELIVERED')
  if (!open.length) return null
  return open.sort((a, b) => firstApptAt(a).localeCompare(firstApptAt(b)))[0]
}

/** Current load per driver, for the fleet dashboard. */
export function currentLoadByDriver(loads: Load[], driverIds: string[]): Map<string, Load> {
  const out = new Map<string, Load>()
  for (const id of driverIds) {
    const load = currentLoadForDriver(loads, id)
    if (load) out.set(id, load)
  }
  return out
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
