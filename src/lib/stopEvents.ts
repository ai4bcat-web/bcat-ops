/**
 * Facility events a driver reports from the app, and the delivery ETA they imply.
 *
 * Two events per stop — arrived, departed — stamped on the Stop itself, because that is
 * the record the loads board already derives its lifecycle from (src/lib/loadStatus.ts:
 * at pickup, in transit, at delivery, delivered). The driver taps one button; dispatch
 * sees the load move.
 *
 * Departing the pickup is the moment an ETA becomes worth stating, and whose ETA it is
 * depends on who delivers:
 *   - the same driver, delivering today: from the truck's live ELD fix to the consignee.
 *   - a different driver, delivering today or tomorrow: the appointment time. Nobody is
 *     rolling toward it yet, so the booked time is the honest estimate.
 *   - anything later: no estimate.
 *
 * Pure: the handler does the I/O (truck fix, consignee coordinates) and passes it in, so
 * every rule here can be pinned without a database.
 */
import { getStops } from './stops'
import { airMiles } from './eldRadius'
import { chicagoDateStr } from './date'
import type { Load, Stop } from '../types'

export type StopEvent = 'ARRIVED' | 'DEPARTED'

/** Local Chicago-area running: traffic, docks and city streets, not interstate cruising. */
export const ETA_AVERAGE_MPH = 38
/** Road distance over air distance, typical for the metro grid. */
export const ETA_ROAD_FACTOR = 1.3
/** Never promise less than this, however close the consignee is. */
export const ETA_MIN_MINUTES = 10

export interface LatLng { lat: number; lng: number }

/** The stops with one event stamped. Arrival is left alone on a departure: see loadStatus. */
export function applyStopEvent(stops: Stop[], stopId: string, event: StopEvent, atIso: string): Stop[] {
  return stops.map((s) => {
    if (s.id !== stopId) return s
    return event === 'ARRIVED' ? { ...s, arrivedAt: atIso } : { ...s, departedAt: atIso }
  })
}

/** Where the truck is expected, leaving `from` for `to` at `departedAtIso`. */
export function estimateEta(from: LatLng, to: LatLng, departedAtIso: string): string {
  const miles = airMiles(from, to) * ETA_ROAD_FACTOR
  const minutes = Math.max(ETA_MIN_MINUTES, (miles / ETA_AVERAGE_MPH) * 60)
  return new Date(Date.parse(departedAtIso) + minutes * 60_000).toISOString()
}

/** Who is set to deliver this stop: the stop's own driver, the legacy field, else the only driver on the load. */
export function delivererOf(load: Load, stops: Stop[], delivery: Stop): string | null {
  if (delivery.driverId) return delivery.driverId
  if (load.deliveryDriverId) return load.deliveryDriverId
  const drivers = new Set(stops.map((s) => s.driverId).filter((d): d is string => !!d))
  if (load.pickupDriverId) drivers.add(load.pickupDriverId)
  return drivers.size === 1 ? [...drivers][0] : null
}

/** The delivery that follows a pickup: the first one after it in sequence that has not happened. */
export function nextDeliveryAfter(stops: Stop[], pickup: Stop): Stop | null {
  return stops
    .filter((s) => s.type === 'delivery' && s.sequence > pickup.sequence && !s.departedAt)
    .sort((a, b) => a.sequence - b.sequence)[0] ?? null
}

export type EtaPlan =
  | { kind: 'motive'; stop: Stop }
  | { kind: 'appt'; stop: Stop }
  | { kind: 'none'; stop: Stop | null; reason: string }

/**
 * Which kind of ETA the departing driver's next delivery gets. `nowIso` decides what
 * "today" and "tomorrow" are, on the Chicago calendar like the appointments.
 */
export function planDeliveryEta(load: Load, stops: Stop[], pickup: Stop, driverId: string, nowIso: string): EtaPlan {
  const delivery = nextDeliveryAfter(stops, pickup)
  if (!delivery) return { kind: 'none', stop: null, reason: 'no delivery after this pickup' }
  const day = delivery.appt ? chicagoDateStr(delivery.appt) : ''
  if (!day) return { kind: 'none', stop: delivery, reason: 'delivery has no appointment date' }
  const today = chicagoDateStr(nowIso)
  const tomorrow = chicagoDateStr(new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000))
  const deliverer = delivererOf(load, stops, delivery)
  if (deliverer === driverId && day === today) return { kind: 'motive', stop: delivery }
  if (day === today || day === tomorrow) return { kind: 'appt', stop: delivery }
  return { kind: 'none', stop: delivery, reason: 'delivery is later than tomorrow' }
}

/** Stamp an ETA on one stop. */
export function withEta(stops: Stop[], stopId: string, etaAt: string, basis: 'motive' | 'appt', nowIso: string): Stop[] {
  return stops.map((s) => (s.id === stopId ? { ...s, etaAt, etaBasis: basis, etaUpdatedAt: nowIso } : s))
}

/** Convenience for callers holding a Load rather than its stops. */
export function stopsOf(load: Load): Stop[] {
  return getStops(load)
}
