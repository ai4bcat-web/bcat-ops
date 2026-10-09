/**
 * Every place a load goes becomes a directory record, without anyone filing it.
 *
 * A stop typed into a load — a facility name, a city, maybe a street — used to live only
 * on that load. The next tender from the same shipper arrived as a stranger: no hours, no
 * dock notes, no driver comments, nothing to prefill. Now a saved load links each stop to
 * the directory: an existing record when one matches, a new one when none does.
 *
 * Matching is deliberately strict (the same rule the directory's own duplicate check
 * applies): the same name in the same city, or the same street address. A similar name
 * is a hint for a human, not a link for a machine — linking "Batory Chicago" to "Batory
 * Chicago Heights" would send a driver to the wrong dock.
 *
 * Pure: no store, no network. The drawer does the create.
 */
import { normalizeName, normalizeAddress, isActiveDirectoryRecord } from './tmsDirectory'
import type { LocationRecord } from '../types/tms'
import type { Stop } from '../types'

export type StopPlace = Pick<Stop, 'type' | 'name' | 'city' | 'address'>

/** "Chicago, IL" → { city: 'Chicago', state: 'IL' }; a bare city stays a city. */
export function splitCityState(cityState: string | null | undefined): { city: string | null; state: string | null } {
  const text = (cityState ?? '').trim()
  if (!text) return { city: null, state: null }
  const m = text.match(/^(.*?)[,\s]+([A-Za-z]{2})$/)
  if (m) return { city: m[1].trim() || null, state: m[2].toUpperCase() }
  return { city: text, state: null }
}

/** The address a stop is really at: the booked snapshot first, the city string as a fallback. */
export function stopAddress(stop: StopPlace): { street: string | null; city: string | null; state: string | null; zip: string | null } {
  const a = stop.address
  const fromCity = splitCityState(stop.city)
  return {
    street: a?.street?.trim() || null,
    city: a?.city?.trim() || fromCity.city,
    state: a?.state?.trim() || fromCity.state,
    zip: a?.zip?.trim() || null,
  }
}

/** The directory record this stop is, if one exists. Null means "none — create one". */
export function matchStopLocation(stop: StopPlace, locations: LocationRecord[]): LocationRecord | null {
  const name = normalizeName(stop.name ?? '')
  const addr = stopAddress(stop)
  const city = normalizeName(addr.city ?? '')
  const street = addr.street ? normalizeAddress({ street: addr.street, city: addr.city, state: addr.state, zip: addr.zip }) : ''
  const live = locations.filter(isActiveDirectoryRecord)
  if (name) {
    const byName = live.find((l) => {
      const names = [l.name, ...(l.aliases ?? [])].map((n) => normalizeName(n ?? ''))
      return names.includes(name) && normalizeName(l.city ?? '') === city
    })
    if (byName) return byName
  }
  if (street) {
    const byAddress = live.find((l) => l.street && normalizeAddress({ street: l.street, city: l.city, state: l.state, zip: l.zip }) === street)
    if (byAddress) return byAddress
  }
  return null
}

export interface NewLocationInput {
  name: string
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  facilityType: 'SHIPPER' | 'RECEIVER'
}

/** What to file for a stop nobody has filed before. Null when there is not enough to file — no name. */
export function locationInputForStop(stop: StopPlace): NewLocationInput | null {
  const name = (stop.name ?? '').trim()
  if (!name) return null
  const addr = stopAddress(stop)
  return {
    name,
    street: addr.street,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    facilityType: stop.type === 'pickup' ? 'SHIPPER' : 'RECEIVER',
  }
}
