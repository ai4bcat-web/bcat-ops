/**
 * Motive API client — current vehicle locations for the live dashboard map.
 *
 * Auth:  X-API-Key header (org API key, never OAuth).
 * Units: X-Metric-Units: false  →  speed in mph.
 * Base:  https://api.gomotive.com
 *
 * Endpoint used:
 *   GET /v1/vehicle_locations  — latest known position per vehicle.
 *     Each row is { vehicle: { id, number, current_location: { lat, lon,
 *     located_at, bearing, speed, description, ... } } }.
 *     `number` matches our TruckConfig.unitNumber.
 */

const BASE_URL = 'https://api.gomotive.com'

export interface MotiveLocation {
  vehicleId:   number
  number:      string        // fleet number, e.g. "009" — matches our unitNumber
  lat:         number
  lon:         number
  locatedAt:   string        // ISO timestamp
  bearing:     number | null
  speed:       number | null // mph (metric_units=false); often null when parked
  description: string | null // human-readable, e.g. "4.5 mi NE of Tucson, AZ"
  odometer:    number | null // miles (metric_units=false); absent on some plans/fixes
}

interface PaginationMeta {
  per_page: number
  page_no:  number
  total:    number
}

interface RawLocationRow {
  vehicle: {
    id:               number
    number:           string
    current_location?: {
      lat?:         number
      lon?:         number
      located_at?:  string
      bearing?:     number | null
      speed?:       number | null
      description?: string | null
      odometer?:    number | null
    } | null
  }
}

function headers(apiKey: string): Record<string, string> {
  return {
    'X-API-Key':      apiKey,
    'X-Metric-Units': 'false',   // imperial: speed in mph
    'Content-Type':   'application/json',
  }
}

async function getJson(url: string, apiKey: string): Promise<unknown> {
  const res = await fetch(url, { headers: headers(apiKey) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Motive API ${res.status} ${res.statusText} — ${url}\n${body}`)
  }
  return res.json()
}

/**
 * Fetch the latest location for every vehicle (all pages).
 * Vehicles without a usable lat/lon fix are skipped.
 */
export async function fetchVehicleLocations(apiKey: string): Promise<MotiveLocation[]> {
  const out: MotiveLocation[] = []
  let page = 1
  while (true) {
    const url = `${BASE_URL}/v1/vehicle_locations?per_page=100&page_no=${page}`
    const data = await getJson(url, apiKey) as {
      vehicles:   RawLocationRow[]
      pagination: PaginationMeta
    }
    for (const row of data.vehicles ?? []) {
      const v = row.vehicle
      const loc = v?.current_location
      if (!v?.number || !loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') {
        continue
      }
      out.push({
        vehicleId:   v.id,
        number:      v.number,
        lat:         loc.lat,
        lon:         loc.lon,
        locatedAt:   loc.located_at ?? new Date().toISOString(),
        bearing:     loc.bearing ?? null,
        speed:       loc.speed ?? null,
        description: loc.description ?? null,
        odometer:    typeof loc.odometer === 'number' ? loc.odometer : null,
      })
    }
    const { total, per_page } = data.pagination
    if (page * per_page >= total) break
    page++
  }
  return out
}
