/**
 * Reverse geocode a lat/lon fix into a "City, ST" string. Blue Ink Tech does not supply
 * place names, so the sync handler calls this only when a description is actually needed.
 *
 * TWO SOURCES, in order:
 *
 *   1. Google's Geocoding API, when GOOGLE_PLACES_API_KEY is set and authorised for it.
 *   2. The US Census Bureau geocoder, which needs no key at all.
 *
 * The fallback exists because the first source failed silently for months. The key was
 * present and valid — it is the same one the reviews widget uses — but the Geocoding API
 * was never enabled on the Google Cloud project, so every call came back REQUEST_DENIED
 * ("This API is not activated on your API project"). reverseGeocode returned null, every
 * Blue Ink truck stored a null description, and the dashboard showed dispatchers raw
 * coordinates instead of a town. Nothing logged, because a null here is also what a
 * perfectly ordinary mid-ocean fix looks like.
 *
 * The Census service is US-only, which matches the fleet, and is authoritative for exactly
 * the thing wanted here: which incorporated place a coordinate falls in.
 *
 * Both paths stay deliberately defensive: any problem — missing key, network failure,
 * non-OK status, missing components — returns `null`, so a geocoding outage can never
 * abort the location sync.
 */

interface AddressComponent {
  long_name: string
  short_name: string
  types: string[]
}

interface GeocodeResult {
  address_components?: AddressComponent[]
}

interface GeocodeResponse {
  status: string
  results?: GeocodeResult[]
}

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'

function firstComponentName(
  components: AddressComponent[],
  types: string[],
  name: 'long_name' | 'short_name',
): string | null {
  for (const component of components) {
    if (component.types.some((t) => types.includes(t))) {
      const value = component[name]
      if (typeof value === 'string' && value.trim().length > 0) {
        return value
      }
    }
  }
  return null
}

export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  return (await googleReverseGeocode(lat, lon)) ?? (await censusReverseGeocode(lat, lon))
}

async function googleReverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY
  if (!key) return null

  const url = `${GEOCODE_URL}?latlng=${encodeURIComponent(`${lat},${lon}`)}&key=${encodeURIComponent(key)}`

  let response: Response
  try {
    response = await fetch(url)
  } catch {
    return null
  }

  let data: GeocodeResponse
  try {
    data = (await response.json()) as GeocodeResponse
  } catch {
    return null
  }

  if (data.status !== 'OK' || !data.results || data.results.length === 0) return null

  const components = data.results[0].address_components
  if (!components || components.length === 0) return null

  const locality =
    firstComponentName(components, ['locality'], 'long_name') ??
    firstComponentName(components, ['postal_town'], 'long_name') ??
    firstComponentName(components, ['sublocality', 'sublocality_level_1'], 'long_name') ??
    firstComponentName(components, ['administrative_area_level_2'], 'long_name')

  const state = firstComponentName(components, ['administrative_area_level_1'], 'short_name')

  if (!locality || !state) return null

  return `${locality}, ${state}`
}

/* ── US Census Bureau geocoder ───────────────────────────────────────────────── */

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates'

interface CensusArea {
  NAME?: string
  BASENAME?: string
  STUSAB?: string
}

interface CensusResponse {
  result?: { geographies?: Record<string, CensusArea[] | undefined> }
}

/**
 * No key, no quota to manage. Asks which incorporated place the point falls in, and which
 * state — `BASENAME` is the bare town name ("Madison") where `NAME` carries the legal
 * suffix ("Madison city"), and `STUSAB` is already the two-letter code.
 *
 * A point outside any incorporated place — most of an interstate — has no place layer, so
 * the county stands in. "Dane County, WI" is still somewhere a dispatcher can picture; a
 * pair of decimals is not.
 */
export async function censusReverseGeocode(lat: number, lon: number): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  const url =
    `${CENSUS_URL}?x=${encodeURIComponent(String(lon))}&y=${encodeURIComponent(String(lat))}` +
    '&benchmark=Public_AR_Current&vintage=Current_Current' +
    '&layers=Incorporated%20Places,Census%20Designated%20Places,Counties,States&format=json'

  let data: CensusResponse
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    data = (await response.json()) as CensusResponse
  } catch {
    return null
  }

  const geographies = data.result?.geographies
  if (!geographies) return null

  const pick = (layer: string): CensusArea | null => {
    const areas = geographies[layer]
    return Array.isArray(areas) && areas.length > 0 ? areas[0] : null
  }

  const place =
    pick('Incorporated Places') ?? pick('Census Designated Places') ?? pick('Counties')
  const state = pick('States')

  const name = (place?.BASENAME ?? place?.NAME ?? '').trim()
  const abbreviation = (state?.STUSAB ?? '').trim()
  if (!name || !abbreviation) return null

  // A county stands in for open road; say so, so nobody reads it as a town.
  const isCounty = place === pick('Counties') && !pick('Incorporated Places') && !pick('Census Designated Places')
  return `${isCounty ? `${name} County` : name}, ${abbreviation}`
}
