import { getStops } from './stops'
import type { Load } from '@/types'

/**
 * Build one lowercase searchable string from EVERY meaningful field on a load —
 * IDs, customer, notes, origin/destination, every stop, and (when resolvable) the
 * truck unit and driver names. Shared by the calendar, the loads grid and the global
 * top-bar search so "search by any word" finds a load if any field contains the words.
 */
export function buildLoadHaystack(
  l: Load,
  opts: { driverName?: (id: string) => string | undefined; truckUnit?: (id: string) => string | undefined } = {},
): string {
  const parts: (string | null | undefined)[] = [
    l.aljexId, l.tmsId, l.pickupNumber, l.customer, l.notes,
    l.originName, l.originCity, l.destinationName, l.destinationCity,
    l.truckId ? opts.truckUnit?.(l.truckId) : null,
    l.pickupDriverId ? opts.driverName?.(l.pickupDriverId) : null,
    l.deliveryDriverId ? opts.driverName?.(l.deliveryDriverId) : null,
  ]
  for (const s of getStops(l)) {
    parts.push(s.name, s.city)
    if (s.driverId) parts.push(opts.driverName?.(s.driverId))
  }
  return parts.filter(Boolean).join(' ').toLowerCase()
}

/** True if the haystack contains every whitespace-separated term in `query` (AND). */
export function loadMatchesQuery(haystack: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((t) => haystack.includes(t))
}
