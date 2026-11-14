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

/** "EL PASO, TX 79928" / "MESA, AZ" / "Chicago" → its parts. */
export function parsePlaceText(v: unknown): { city: string | null; state: string | null; zip: string | null } {
  const s = text(v)
  if (!s) return { city: null, state: null, zip: null }
  const m = s.match(/^(.*?),\s*([A-Za-z]{2})(?:\s+(\d{5}(?:-?\d{4})?))?\s*$/)
  if (m) return { city: m[1].trim() || null, state: m[2].toUpperCase(), zip: zip5(m[3]) }
  return { city: s, state: null, zip: null }
}

export function stopPlace(stop: StopPlaceStop | null | undefined, location?: StopPlaceLocation | null): StopPlace {
  const a = stop?.address ?? null
  const label = parsePlaceText(stop?.city)
  return {
    name: text(stop?.name) ?? text(location?.name),
    street: text(a?.street) ?? text(a?.address1) ?? text(location?.address1) ?? text(location?.street),
    city: text(a?.city) ?? text(location?.city) ?? label.city,
    state: state2(a?.state) ?? state2(location?.state) ?? label.state,
    zip: zip5(a?.zip) ?? zip5(location?.zip) ?? label.zip,
    country: text(a?.country) ?? text(location?.country),
  }
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
