/**
 * Lane matching shared by the three Rate-intelligence sections (DAT, "what we ran", "what we
 * quoted"). One definition of "the same lane" so the panel cannot show a load history built on
 * one rule beside a quote history built on another.
 *
 * A place matches another when, in order of strength:
 *   CITY    normalised city AND state are equal ("St. Louis, MO" = "ST LOUIS MO"),
 *   ZIP3    both carry a ZIP and the first three digits agree (the neighbourhood fallback),
 *   RADIUS  an opt-in: both carry coordinates and sit within `radiusMiles`.
 * A lane matches when BOTH ends match; its tier is the weaker of the two ends. A city with no
 * state never matches by name — "SPRINGFIELD" is nine cities.
 *
 * Pure: no store, no clock, no network. Imports are relative because the tmsShipmentActions
 * Lambda bundles this file by path.
 */

/** Two-letter code by spelled-out state name, for the addresses that were typed by hand. */
const STATE_NAMES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID',
  ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
}

const EQUIPMENT_ALIASES: Record<string, string> = {
  V: 'VAN', DV: 'VAN', 'DRY VAN': 'VAN', DRYVAN: 'VAN', VAN: 'VAN', '53 VAN': 'VAN', '53 DRY VAN': 'VAN',
  R: 'REEFER', RF: 'REEFER', REEF: 'REEFER', REEFER: 'REEFER',
  F: 'FLATBED', FB: 'FLATBED', FLAT: 'FLATBED', FLATBED: 'FLATBED',
  SD: 'STEPDECK', 'STEP DECK': 'STEPDECK', STEPDECK: 'STEPDECK',
}

export interface LanePlace {
  /** Normalised city, e.g. 'ST LOUIS'. Empty when unknown. */
  city: string
  /** Two-letter code, or ''. */
  state: string
  /** First three digits of the ZIP, or null. */
  zip3: string | null
  lat?: number | null
  lon?: number | null
}

export interface LaneSpec {
  origin: LanePlace
  destination: LanePlace
}

export type LaneMatchTier = 'CITY' | 'ZIP3' | 'RADIUS'

export interface LaneMatchOptions {
  /** Accept places within this many miles when both carry coordinates. Off by default. */
  radiusMiles?: number | null
  /** Accept a ZIP3 agreement as a match. On by default; false = city/state only. */
  zip3?: boolean
}

export interface PlaceInput {
  city?: string | null
  state?: string | null
  zip?: string | null
  lat?: number | null
  lon?: number | null
}

/** Upper case, punctuation to spaces, whitespace collapsed; 'ST.' / 'SAINT' / 'FT' spellings unified. */
export function normalizeCity(value: string | null | undefined): string {
  const text = (value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
  return text
    .split(' ')
    .map((word) => (word === 'SAINT' ? 'ST' : word === 'FORT' ? 'FT' : word === 'MOUNT' ? 'MT' : word))
    .join(' ')
}

/** A two-letter state from a code or a full name; '' when it is neither. */
export function normalizeState(value: string | null | undefined): string {
  const text = (value ?? '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim()
  if (/^[A-Z]{2}$/.test(text)) return text
  return STATE_NAMES[text] ?? ''
}

/** `'60106-1234'` → `'601'`; anything that is not a ZIP → null. */
export function zip3Of(value: string | null | undefined): string | null {
  const match = (value ?? '').trim().match(/^(\d{3})\d{2}(?:-?\d{4})?$/)
  return match ? match[1] : null
}

/** `'Chicago, IL'` (the Load.stops display string) split into its parts. */
export function splitPlaceText(text: string | null | undefined): { city: string; state: string } {
  const [city, state] = (text ?? '').split(',').map((part) => part.trim())
  return { city: city ?? '', state: state ?? '' }
}

export function lanePlace(input: PlaceInput): LanePlace {
  const lat = typeof input.lat === 'number' && Number.isFinite(input.lat) ? input.lat : null
  const lon = typeof input.lon === 'number' && Number.isFinite(input.lon) ? input.lon : null
  return {
    city: normalizeCity(input.city),
    state: normalizeState(input.state),
    zip3: zip3Of(input.zip),
    lat,
    lon,
  }
}

/** A place that can be matched at all: a city and state, or a ZIP3. */
export function placeUsable(place: LanePlace): boolean {
  return (!!place.city && !!place.state) || !!place.zip3
}

/** The lane key every `LaneRateSample` / `Quote` carries: `'CHICAGO|IL>DANVILLE|IL'`. */
export function laneKeyOfSpec(spec: LaneSpec): string | null {
  const { origin, destination } = spec
  if (!origin.city || !origin.state || !destination.city || !destination.state) return null
  return `${origin.city}|${origin.state}>${destination.city}|${destination.state}`
}

/** `'606>618'`, or null unless both ends have a ZIP3. */
export function laneKey3OfSpec(spec: LaneSpec): string | null {
  return spec.origin.zip3 && spec.destination.zip3 ? `${spec.origin.zip3}>${spec.destination.zip3}` : null
}

/**
 * A stored sample or quote as a spec, from its two keys. Either key may be missing; an end the
 * keys cannot describe is an empty place and will not match.
 */
export function laneSpecFromKeys(laneKey: string | null | undefined, laneKey3?: string | null): LaneSpec {
  const empty = (): LanePlace => ({ city: '', state: '', zip3: null })
  const spec: LaneSpec = { origin: empty(), destination: empty() }
  const [from, to] = (laneKey ?? '').split('>')
  const parsePart = (part: string | undefined): Pick<LanePlace, 'city' | 'state'> => {
    const [city, state] = (part ?? '').split('|')
    return { city: normalizeCity(city), state: normalizeState(state) }
  }
  if (from && to) {
    Object.assign(spec.origin, parsePart(from))
    Object.assign(spec.destination, parsePart(to))
  }
  const [z1, z2] = (laneKey3 ?? '').split('>')
  if (/^\d{3}$/.test(z1 ?? '') && /^\d{3}$/.test(z2 ?? '')) {
    spec.origin.zip3 = z1
    spec.destination.zip3 = z2
  }
  return spec
}

const EARTH_MILES = 3958.8

export function milesBetween(a: LanePlace, b: LanePlace): number | null {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return null
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** How two places relate, strongest tier first; null when they are different places. */
export function matchPlace(a: LanePlace, b: LanePlace, opts: LaneMatchOptions = {}): LaneMatchTier | null {
  if (a.city && a.state && a.city === b.city && a.state === b.state) return 'CITY'
  if ((opts.zip3 ?? true) && a.zip3 && a.zip3 === b.zip3) return 'ZIP3'
  const radius = opts.radiusMiles
  if (radius != null && radius > 0) {
    const miles = milesBetween(a, b)
    if (miles != null && miles <= radius) return 'RADIUS'
  }
  return null
}

const TIER_RANK: Record<LaneMatchTier, number> = { CITY: 0, ZIP3: 1, RADIUS: 2 }

/** Both ends must match; the lane's tier is the weaker end's. */
export function matchLane(target: LaneSpec, candidate: LaneSpec, opts: LaneMatchOptions = {}): LaneMatchTier | null {
  const origin = matchPlace(target.origin, candidate.origin, opts)
  if (!origin) return null
  const destination = matchPlace(target.destination, candidate.destination, opts)
  if (!destination) return null
  return TIER_RANK[origin] >= TIER_RANK[destination] ? origin : destination
}

/** Canonical equipment: 'Dry Van' / 'V' / 'van' → 'VAN'; unknown text is upper-cased as is. */
export function normalizeEquipment(value: string | null | undefined): string {
  const text = (value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
  return EQUIPMENT_ALIASES[text] ?? text
}

/** Same equipment; a side with no equipment is not a conflict (old rows were not always typed). */
export function sameEquipment(wanted: string | null | undefined, actual: string | null | undefined): boolean {
  const w = normalizeEquipment(wanted)
  const a = normalizeEquipment(actual)
  return !w || !a || w === a
}
