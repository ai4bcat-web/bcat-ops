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
    const data = await getJson(url, apiKey) as {
      ifta_trips: MotiveIftaSummaryRow[]
      pagination:  PaginationMeta
    }
    for (const row of data.ifta_trips ?? []) {
      totalMiles += Number(row.distance) || 0
    }
    const { total, per_page } = data.pagination
    if (page * per_page >= total) break
    page++
  }
  return totalMiles
}
