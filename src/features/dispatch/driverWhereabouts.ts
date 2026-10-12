/**
 * Where a driver is and when they are due next, for the conversation list: the truck's
 * last ELD fix (city) and the pending delivery ETA on their current load. Pure; the page
 * supplies loads, equipment and locations.
 */
import type { Driver, Load } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { TruckLocation } from '@/lib/apiClient'
import { currentLoadForDriver } from '@/lib/driverJourney'
import { pendingDeliveryEta } from '@/lib/stopEvents'
import { lastStopEventForDriver } from '@/lib/driverSchedule'

export interface Whereabouts {
  /** "Schaumburg, IL", or null when the truck has no fix. */
  place: string | null
  /** Minutes since the fix. */
  fixAgeMin: number | null
  /** The office's words for the last thing they reported, with when. */
  lastEvent: { label: string; at: string } | null
  /** When they are due at the next delivery, and where. */
  eta: { at: string; stopName: string | null; basis: 'motive' | 'appt' } | null
  /** The unit number of the truck on their file. */
  truck: string | null
  /** The trailer under them: the one named on the load they are hauling, else the one on their file. */
  trailer: string | null
}

/**
 * The trailer the driver has on right now. Ivan's drivers name the trailer as they leave
 * a pickup and it rides with that load to the delivery, so the load they have departed a
 * pickup on and not yet delivered is the one that says. Newest departure wins when two
 * loads are both open (a swap at a yard).
 */
export function trailerOnDriver(driver: Pick<Driver, 'id' | 'assignedTrailerId'>, loads: readonly Load[], equipment: readonly Pick<Equipment, 'id' | 'unitNumber'>[]): string | null {
  let best: { at: string; trailer: string } | null = null
  for (const load of loads) {
    const trailer = load.trailerNumber?.trim()
    if (!trailer) continue
    const stops = load.stops ?? []
    const mine = stops.filter((s) => s.driverId === driver.id)
    if (!mine.length) continue
    const delivered = stops.filter((s) => s.type === 'delivery').every((s) => !!s.departedAt) && stops.some((s) => s.type === 'delivery')
    if (delivered) continue
    const departed = mine.filter((s) => s.type === 'pickup' && s.departedAt).map((s) => s.departedAt as string).sort().pop()
    if (!departed) continue
    if (!best || departed > best.at) best = { at: departed, trailer }
  }
  if (best) return best.trailer
  const own = driver.assignedTrailerId ? equipment.find((e) => e.id === driver.assignedTrailerId) : undefined
  return own ? String(own.unitNumber) : null
}

/** "City, ST" out of a Motive description, else coordinates, else null. */
export function placeOf(loc: Pick<TruckLocation, 'description' | 'lat' | 'lon'> | null | undefined): string | null {
  if (!loc) return null
  const desc = loc.description
  if (desc) {
    const i = desc.lastIndexOf(' of ')
    return (i >= 0 ? desc.slice(i + 4) : desc).trim() || null
  }
  if (Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) return `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`
  return null
}

export function whereaboutsOf(
  driver: Driver | null | undefined,
  loads: readonly Load[],
  equipment: readonly Pick<Equipment, 'id' | 'unitNumber'>[],
  locations: readonly TruckLocation[],
  now: number,
): Whereabouts | null {
  if (!driver) return null
  const truck = driver.assignedTruckId ? equipment.find((e) => e.id === driver.assignedTruckId) : undefined
  const loc = truck ? locations.filter((l) => l.truckId === truck.id || l.unitNumber === String(truck.unitNumber)).sort((a, b) => (a.locatedAt < b.locatedAt ? 1 : -1))[0] : undefined
  const load = currentLoadForDriver(loads as Load[], driver.id, now)
  // Only this driver's own stops: a load they share with another driver must not lend
  // them the other driver's delivery.
  const ev = lastStopEventForDriver(loads, driver.id)
  const pending = load ? pendingDeliveryEta(load) : null
  let etaStop: string | null = null
  if (load && pending) {
    const stops = (load.stops ?? []).filter((s) => s.type === 'delivery' && s.etaAt === pending.etaAt)
    etaStop = stops[0]?.name?.trim() || null
  }
  return {
    place: placeOf(loc),
    fixAgeMin: loc ? Math.max(0, Math.round((now - new Date(loc.locatedAt).getTime()) / 60_000)) : null,
    lastEvent: ev ? { label: ev.label, at: ev.at } : null,
    eta: pending ? { at: pending.etaAt, stopName: etaStop, basis: pending.basis } : null,
    truck: truck ? String(truck.unitNumber) : null,
    trailer: trailerOnDriver(driver, loads, equipment),
  }
}

/** "Truck 3114 · Trailer 5302", or whichever half is known, or null. */
export function unitLine(w: Whereabouts | null): string | null {
  if (!w) return null
  const parts = [w.truck ? `Truck ${w.truck}` : null, w.trailer ? `Trailer ${w.trailer}` : null].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/** One line for the list: "📍 Schaumburg, IL · ETA 2:45 PM Batory". */
export function whereaboutsLine(w: Whereabouts | null): string | null {
  if (!w) return null
  const parts: string[] = []
  if (w.place) parts.push(w.fixAgeMin != null && w.fixAgeMin > 120 ? `${w.place} (${Math.round(w.fixAgeMin / 60)}h ago)` : w.place)
  if (w.eta) {
    const t = new Date(w.eta.at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })
    parts.push(`ETA ${t}${w.eta.stopName ? ` ${w.eta.stopName}` : ''}${w.eta.basis === 'appt' ? ' (appt)' : ''}`)
  }
  return parts.length ? parts.join(' · ') : null
}

/** "On site at pickup · 2:14 PM": the conversation's own last status, else the load's last event. */
export function statusLine(c: { lastStatusText?: string | null; lastStatusAt?: string | null }, w: Whereabouts | null): string | null {
  const text = c.lastStatusText?.trim() || w?.lastEvent?.label || null
  const at = c.lastStatusText?.trim() ? c.lastStatusAt : w?.lastEvent?.at
  if (!text) return null
  const when = at ? new Date(at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
  return when ? `${text} · ${when}` : text
}
