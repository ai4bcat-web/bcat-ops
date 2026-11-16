/**
 * Where a stop is: one answer for every page that shows, checks or sends a pickup or delivery place.
 *
 * Read in the order the shipment editor shows it (Ryne, 2026-11-14: "one source of truth"):
 *   1. the stop's own address snapshot (street, city, state, ZIP) — what the editor edits;
 *   2. the saved Location it links to;
 *   3. the stop's display text, which older rows carry as "CITY, ST" or "CITY, ST 79928".
 * Each field falls through on its own, so a stop with a ZIP but no city still takes its city from the
 * Location. ZIP is the 5-digit base (ZIP+4 with or without its dash reads as the first five).
 * Pure and import-free: the Lambdas bundle it by relative path.
 */

export interface StopPlaceAddress {
  street?: string | null
  address1?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
}

export interface StopPlaceStop {
  name?: string | null
  city?: string | null
  address?: StopPlaceAddress | null
}

export interface StopPlaceLocation {
  name?: string | null
  address1?: string | null
  street?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
}

export interface StopPlace {
  name: string | null
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
}

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.toUpperCase() !== 'N/A' ? t : null
}

/** Five-digit ZIP, from "53105", "79928-5900" or "799285900". */
export function zip5(v: unknown): string | null {
  const s = text(v)
  if (!s) return null
  const m = s.match(/\b(\d{5})(?:-?\d{4})?\b/)
  return m ? m[1] : null
}

/** Two letters, uppercased; anything else is no state. */
export function state2(v: unknown): string | null {
  const s = text(v)
  return s && /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : null
}

/** US states, DC and territories: a bare two-letter token only counts as a state when it is one of these. */
export const US_STATE_CODES: ReadonlySet<string> = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP'.split(' '),
)
const CA_PROVINCES: ReadonlySet<string> = new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' '))
export const isRegionCode = (v: string): boolean => US_STATE_CODES.has(v) || CA_PROVINCES.has(v)

const cleanCity = (v: string): string | null => {
  const t = v.replace(/[\s,.;-]+$/, '').replace(/\s{2,}/g, ' ').trim()
  return t || null
}

/**
 * "EL PASO, TX 79928" / "MESA, AZ" / "Chicago" → its parts. Older rows write the separator loosely:
 * "COCHRANE. WI", "COCHRANE WI", "Cochrane,WI 54622". A comma always splits (any two letters, as before); a
 * period, semicolon or plain space splits only when the last word is a real US state or Canadian province, so
 * "ST. LOUIS" and "FORT WAYNE" are never cut.
 */
export function parsePlaceText(v: unknown): { city: string | null; state: string | null; zip: string | null } {
  const s = text(v)
  if (!s) return { city: null, state: null, zip: null }
  const comma = s.match(/^(.*?),\s*([A-Za-z]{2})(?:\s+(\d{5}(?:-?\d{4})?))?\s*$/)
  if (comma) return { city: comma[1].trim() || null, state: comma[2].toUpperCase(), zip: zip5(comma[3]) }
  const loose = s.match(/^(.*?)(?:\s*[.;]\s*|\s+)([A-Za-z]{2})(?:[\s,.-]+(\d{5}(?:-?\d{4})?))?\s*$/)
  if (loose && isRegionCode(loose[2].toUpperCase())) {
    const city = cleanCity(loose[1])
    if (city) return { city, state: loose[2].toUpperCase(), zip: zip5(loose[3]) }
  }
  return { city: s, state: null, zip: null }
}

/** "COCHRANE" + "WI" → "COCHRANE, WI": the display text a stop carries beside its address. */
export function cityStateText(city: string | null | undefined, state: string | null | undefined): string {
  const c = parsePlaceText(city)
  const st = state2(state) ?? c.state
  return [c.city ?? '', st ?? ''].filter(Boolean).join(', ')
}

export function stopPlace(stop: StopPlaceStop | null | undefined, location?: StopPlaceLocation | null): StopPlace {
  const a = stop?.address ?? null
  const label = parsePlaceText(stop?.city)
  // The address's own city can carry its state too ("COCHRANE. WI"); split it the same way.
  const own = parsePlaceText(a?.city)
  return {
    name: text(stop?.name) ?? text(location?.name),
    street: text(a?.street) ?? text(a?.address1) ?? text(location?.address1) ?? text(location?.street),
    city: own.city ?? text(location?.city) ?? label.city,
    state: state2(a?.state) ?? own.state ?? state2(location?.state) ?? label.state,
    zip: zip5(a?.zip) ?? own.zip ?? zip5(location?.zip) ?? label.zip,
    country: text(a?.country) ?? text(location?.country),
  }
}

/**
 * The address a stop takes from the saved place it is moved to: street, city, state and ZIP, so a stop
 * linked to a place carries them itself and never depends on the place being read later. Null when the
 * place has none of them.
 */
export function stopAddressFromLocation(location: StopPlaceLocation | null | undefined): StopPlaceAddress | null {
  if (!location) return null
  const street = text(location.street) ?? text(location.address1)
  const city = text(location.city)
  const state = state2(location.state)
  const zip = text(location.zip)
  if (!street && !city && !state && !zip) return null
  return { street, city, state, zip, country: text(location.country) ?? 'US' }
}

/**
 * A load's `stops` as a list. It is AWSJSON: a list once AppSync parsed it, but the Aljex import stored it as a
 * JSON string (sometimes double-encoded), and iterating that string reads characters, not stops — every stop
 * reader on a raw row goes through this. Garbage reads as no stops.
 */
export function stopsList<T = Record<string, unknown>>(v: unknown): T[] {
  let x = v
  for (let i = 0; i < 4 && typeof x === 'string'; i++) {
    try { x = JSON.parse(x) } catch { return [] }
  }
  return Array.isArray(x) ? (x.filter((s) => !!s && typeof s === 'object') as T[]) : []
}
