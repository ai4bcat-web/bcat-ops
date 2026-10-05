/**
 * Which loads need ELD logs, by the 150 air-mile rule.
 *
 * This is not an arbitrary threshold — it is the FMCSA short-haul exemption (49 CFR
 * 395.1(e)(1)). A driver who stays inside a 150 AIR-mile radius of the normal work
 * reporting location, and who is released within 14 hours, is exempt from keeping
 * records of duty status. Go outside that circle and logs are required for the day.
 *
 * Two consequences for how this is written:
 *
 *   - AIR miles, not driving miles. Great-circle distance is the legally correct measure,
 *     so Load.miles (a routed road distance) must NOT be used here. A 160-road-mile trip
 *     can sit well inside a 150-air-mile circle, and treating it as outside would tell a
 *     driver to log a day they did not have to.
 *   - A city we cannot place is UNKNOWN, never "inside". The dangerous error for a
 *     compliance prompt is the false negative — quietly telling a driver no logs are
 *     needed for a run that went outside the radius. Unknown asks a human to look.
 *
 * Pleasant Prairie, WI is Ivan Cartage's work reporting location, which is what the
 * radius is measured from.
 */
import { CITY_COORDS } from './cityCoords'

/** Ivan Cartage's work reporting location — the centre of the radius. */
export const WORK_REPORTING_LOCATION = { name: 'Pleasant Prairie, WI', lat: 42.5267, lng: -87.8883 }

/** 49 CFR 395.1(e)(1). */
export const SHORT_HAUL_AIR_MILES = 150

export type EldStatus = 'NOT_REQUIRED' | 'REQUIRED' | 'UNKNOWN'

export interface EldAssessment {
  status: EldStatus
  /** Air miles to the farthest stop we could place, or null when none could be placed. */
  farthestMiles: number | null
  /** The stop that drove the answer — the farthest placeable one. */
  farthestCity: string | null
  /** Cities we could not place, so the UI can say which ones need a human. */
  unplaceable: string[]
}

/**
 * Great-circle distance in statute miles.
 *
 * Mean Earth radius in miles. Haversine rather than a flat approximation: at Wisconsin
 * latitudes a naive equirectangular estimate is off by enough miles near the boundary to
 * change the answer, and the answer is a compliance decision.
 */
export function airMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 3958.7613
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/*
 * The spellings that actually appear in the Load records, mapped to a real place.
 *
 * Dispatchers type the city by hand, so the same place arrives as "MILWAUKEE", "MILWAUKEE,
 * WI" and "MILWAUKEE,WI", and a few carry a single-character slip or a facility shorthand
 * ("AMF OHARE" is the O'Hare air cargo facility). Normalising these is what keeps them out
 * of the unplaceable list; anything not listed here still has to match the table outright.
 */
const ALIASES: Record<string, string> = {
  'ALSIP. IL': 'ALSIP, IL',
  'AMF OHARE, IL': 'CHICAGO, IL',
  'ARGO, IL': 'SUMMIT, IL',
  'BENSEVILLE, IL': 'BENSENVILLE, IL',
  'BOOLINGBROOK, IL': 'BOLINGBROOK, IL',
  'CHICAGO': 'CHICAGO, IL',
  'CUDAHY': 'CUDAHY, WI',
  'DES PLANES, IL': 'DES PLAINES, IL',
  'DOWNERS GROVE': 'DOWNERS GROVE, IL',
  'DUNDEE, IL': 'WEST DUNDEE, IL',
  'ELK GROVE, IL': 'ELK GROVE VILLAGE, IL',
  'FOND DU LAC': 'FOND DU LAC, WI',
  'GRAND RAPIDS, IL': 'GRAND RAPIDS, MI',
  'INDIANAPOLIS IN': 'INDIANAPOLIS, IN',
  'LA CROSSE': 'LA CROSSE, WI',
  'MACHESNEY, IL': 'MACHESNEY PARK, IL',
  'MC COOK, IL': 'MCCOOK, IL',
  'MILWAUKEE': 'MILWAUKEE, WI',
  'MILWAUKEE, IL': 'MILWAUKEE, WI',
  'NEW BERLIN': 'NEW BERLIN, WI',
  'STURTEVANT.WI': 'STURTEVANT, WI',
  'SUMMIT ARGO, IL': 'SUMMIT, IL',
  'WEST DUNDEE': 'WEST DUNDEE, IL',
}

/** "waukegan,il " / "KENOSHA, WI 53142" → "WAUKEGAN, IL" / "KENOSHA, WI". */
export function normalizeCityKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = raw.replace(/\s+/g, ' ').trim().toUpperCase()
  if (!s) return null
  s = ALIASES[s] ?? s
  // A trailing ZIP is noise here; the city/state pair is what places the stop.
  s = s.replace(/[\s,]+\d{5}(-\d{4})?$/, '')
  s = ALIASES[s] ?? s
  // "WAUKEGAN IL" and "WAUKEGAN,IL" both mean "WAUKEGAN, IL".
  const m = s.match(/^(.*?)[\s,]+([A-Z]{2})$/)
  if (m) s = `${m[1].trim().replace(/,$/, '')}, ${m[2]}`
  return ALIASES[s] ?? s
}

/** Coordinates for a city string as typed on a load, or null if we cannot place it. */
export function locateCity(raw: string | null | undefined): { lat: number; lng: number } | null {
  const key = normalizeCityKey(raw)
  if (!key) return null
  const hit = CITY_COORDS[key]
  return hit ? { lat: hit[0], lng: hit[1] } : null
}

/**
 * Does this set of stops take the driver outside the short-haul radius?
 *
 * REQUIRED as soon as ANY stop is outside — the exemption is lost for the whole day by
 * leaving the circle once, so the farthest stop decides. UNKNOWN when nothing could be
 * placed, or when an unplaceable city could still be the one that breaks the radius; in
 * that case the known stops are reported too, so the app can show what it does know.
 */
export function assessEld(cities: Array<string | null | undefined>): EldAssessment {
  const unplaceable: string[] = []
  let farthestMiles: number | null = null
  let farthestCity: string | null = null

  for (const raw of cities) {
    const key = normalizeCityKey(raw)
    if (!key) continue                       // a blank stop is absent, not unplaceable
    const at = locateCity(raw)
    if (!at) {
      if (!unplaceable.includes(key)) unplaceable.push(key)
      continue
    }
    const miles = airMiles(WORK_REPORTING_LOCATION, at)
    if (farthestMiles == null || miles > farthestMiles) {
      farthestMiles = miles
      farthestCity = key
    }
  }

  /*
   * A bare city name that another stop already placed is not an unknown.
   *
   * The same stop reaches us twice — once in the stops array, once as the legacy
   * origin/destination pair — and only one of the two carries a state. "KENOSHA" with no
   * state cannot be placed on its own, but when "KENOSHA, WI" is on the very same load
   * they are the same facility, and reporting it as unplaceable would claim uncertainty we
   * do not actually have. Only a name that nothing on this load placed stays unknown.
   */
  const placedCities = new Set(
    [farthestCity, ...cities.map((c) => normalizeCityKey(c))]
      .filter((k): k is string => !!k && !!CITY_COORDS[k])
      .map((k) => k.slice(0, k.lastIndexOf(', '))),
  )
  const stillUnknown = unplaceable.filter((u) => !placedCities.has(u))

  const rounded = farthestMiles == null ? null : Math.round(farthestMiles)

  // One stop outside is enough, and it outranks any uncertainty about the others.
  if (farthestMiles != null && farthestMiles > SHORT_HAUL_AIR_MILES) {
    return { status: 'REQUIRED', farthestMiles: rounded, farthestCity, unplaceable: stillUnknown }
  }
  // Everything we could place is inside, but something we could not place might not be.
  if (stillUnknown.length > 0) {
    return { status: 'UNKNOWN', farthestMiles: rounded, farthestCity, unplaceable: stillUnknown }
  }
  if (farthestMiles == null) {
    return { status: 'UNKNOWN', farthestMiles: null, farthestCity: null, unplaceable: stillUnknown }
  }
  return { status: 'NOT_REQUIRED', farthestMiles: rounded, farthestCity, unplaceable: stillUnknown }
}
