/**
 * Motive API client — minimal wrapper for vehicle lookup + IFTA mileage summary.
 *
 * Auth:  X-API-Key header (org API key, never OAuth).
 * Units: X-Metric-Units: false  →  distances returned in miles.
 * Base:  https://api.gomotive.com
 *
 * Endpoints used:
 *   GET /v1/vehicles           — list vehicles, match by `number` field = fleet unit number
 *   GET /v1/ifta/summary       — total miles per jurisdiction per vehicle for a date range
 *                                sum across jurisdictions = total truck miles for period
 */

const BASE_URL = 'https://api.gomotive.com'

export interface MotiveVehicle {
  id: number
  number: string        // fleet number, e.g. "009" — matches our unitNumber
  make?: string
  model?: string
  year?: number
  vin?: string
  metric_units?: boolean
}

export interface MotiveIftaSummaryRow {
  jurisdiction: string
  vehicle: MotiveVehicle
  distance: number      // miles (metric_units=false header)
}

interface PaginationMeta {
  per_page: number
  page_no: number
  total: number
}

function headers(apiKey: string): Record<string, string> {
  return {
    'X-API-Key':      apiKey,
    'X-Metric-Units': 'false',   // imperial: distances in miles
    'Content-Type':  'application/json',
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

/** Fetch all vehicles (all pages). Returns map of unitNumber → Motive vehicle ID. */
export async function fetchVehicleMap(apiKey: string): Promise<Map<string, MotiveVehicle>> {
  const map = new Map<string, MotiveVehicle>()
  let page = 1
  while (true) {
    const url = `${BASE_URL}/v1/vehicles?per_page=100&page_no=${page}`
    const data = await getJson(url, apiKey) as {
      vehicles: Array<{ vehicle: MotiveVehicle }>
      pagination: PaginationMeta
    }
    for (const row of data.vehicles ?? []) {
      const v = row.vehicle
      if (v?.number) map.set(v.number, v)
    }
    const { total, per_page } = data.pagination
    if (page * per_page >= total) break
    page++
  }
  return map
}

/**
 * Fetch IFTA mileage summary for a vehicle in a date range.
 * Returns total miles (sum of all jurisdiction distances).
 * Date strings: YYYY-MM-DD.
 */
export async function fetchMilesForVehicle(
  apiKey: string,
  vehicleId: number,
  startDate: string,
  endDate: string,
): Promise<number> {
  let totalMiles = 0
  let page = 1
  while (true) {
    const params = new URLSearchParams({
      start_date:     startDate,
      end_date:       endDate,
      per_page:       '100',
      page_no:        String(page),
    })
    params.append('vehicle_ids[]', String(vehicleId))
    const url = `${BASE_URL}/v1/ifta/summary?${params.toString()}`
    // Each element is wrapped: { ifta_trip: { jurisdiction, vehicle, distance } }.
    const data = await getJson(url, apiKey) as {
      ifta_trips: Array<{ ifta_trip: MotiveIftaSummaryRow }>
      pagination:  PaginationMeta
    }
    for (const row of data.ifta_trips ?? []) {
      totalMiles += Number(row.ifta_trip?.distance) || 0
    }
    const { total, per_page } = data.pagination
    if (page * per_page >= total) break
    page++
  }
  return totalMiles
}

/**
 * Fuel burned per vehicle over a period, in US gallons, keyed by Motive vehicle id.
 *
 * Fetched for the WHOLE fleet in one request per period rather than one per truck: this
 * endpoint returns every vehicle on the org (8 of them) in a single page, so asking per
 * truck would multiply the calls by the fleet size for the same answer.
 *
 * driving_fuel AND idle_fuel. A truck idling at a dock burns fuel that no mile accounts
 * for, and leaving it out would flatter every MPG figure — on a local fleet that idles, by
 * a lot. The number here is what actually came out of the tank.
 */
export async function fetchFuelByVehicle(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  let page = 1
  while (true) {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date:   endDate,
      per_page:   '100',
      page_no:    String(page),
    })
    const data = (await getJson(`${BASE_URL}/v1/vehicle_utilization?${params.toString()}`, apiKey)) as {
      vehicle_idle_rollups?: Array<{
        vehicle_idle_rollup?: {
          vehicle?: { id?: number }
          driving_fuel?: number | null
          idle_fuel?: number | null
        }
      }>
      pagination?: PaginationMeta
    }
    const rows = data.vehicle_idle_rollups ?? []
    for (const row of rows) {
      const r = row.vehicle_idle_rollup
      const id = r?.vehicle?.id
      if (typeof id !== 'number') continue
      const gallons = (r?.driving_fuel ?? 0) + (r?.idle_fuel ?? 0)
      if (gallons > 0) out.set(id, (out.get(id) ?? 0) + gallons)
    }
    const total = data.pagination?.total ?? rows.length
    if (rows.length === 0 || page * 100 >= total) break
    page += 1
  }
  return out
}
