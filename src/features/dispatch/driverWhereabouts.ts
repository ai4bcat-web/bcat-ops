/**
 * Where a driver is and when they are due next, for the conversation list: the truck's
 * last ELD fix (city) and the pending delivery ETA on their current load. Pure; the page
 * supplies loads, equipment and locations.
 */
import type { Driver, Load } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { TruckLocation } from '@/lib/apiClient'
import { currentLoadForDriver } from '@/lib/driverJourney'
import { lastStopEvent, pendingDeliveryEta } from '@/lib/stopEvents'

export interface Whereabouts {
  /** "Schaumburg, IL", or null when the truck has no fix. */
  place: string | null
  /** Minutes since the fix. */
  fixAgeMin: number | null
  /** The office's words for the last thing they reported, with when. */
  lastEvent: { label: string; at: string } | null
  /** When they are due at the next delivery, and where. */
  eta: { at: string; stopName: string | null; basis: 'motive' | 'appt' } | null
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
  const ev = load ? lastStopEvent(load) : null
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
  }
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
