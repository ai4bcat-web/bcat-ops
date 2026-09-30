/**
 * Reverse geocode a lat/lon fix into a "City, ST" string using the Google
 * Geocoding API. Blue Ink Tech does not supply place names, so the sync handler
 * calls this only when a description is actually needed.
 *
 * The function is deliberately defensive: any problem (missing key, network
 * failure, non-OK status, missing address components) returns `null` so a
 * geocoding outage never aborts the location sync.
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
