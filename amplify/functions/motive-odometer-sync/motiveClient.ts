/**
 * Motive API client — odometer readings + daily fuel economy.
 *
 * Auth:  X-API-Key header (org API key, never OAuth).
 * Units: X-Metric-Units: false  →  straight from Motive this means distances in
 *        miles; the same header is sent to vehicle_utilization so its fuel values
 *        are treated here as US gallons.
 * Base:  https://api.gomotive.com
 *
 * Endpoints used (same base/method family the existing Motive syncs use):
 *   GET /v1/vehicle_locations    — latest known fix per vehicle, carrying the
 *                                  live `odometer` (and `true_odometer` where the
 *                                  plan reports it), in miles.
 *   GET /v1/vehicle_utilization  — per-vehicle driving fuel for a date range; the
 *                                  rollup buckets by the company timezone, so a
 *                                  single-day range is exactly one day's fuel.
 *
 * Both responses are parsed defensively: the documented envelope is
 * `{ vehicles: [{ vehicle: … }] }` / `{ vehicle_idle_rollups: [{ vehicle_idle_rollup: … }] }`,
 * but Motive has shipped rows unwrapped before, so the extractors accept either.
 * The first raw payload of each kind is logged once so a deploy can be verified
 * against CloudWatch without guessing the shape.
 */

const BASE_URL = 'https://api.gomotive.com'

export interface MotiveOdometer {
  vehicleId:  number
  number:     string        // fleet number, e.g. "009" — matches our unitNumber
  /** Prefer Motive's calibrated `true_odometer`; fall back to the virtual one. */
  odometer:   number | null
}

export interface MotiveUtilization {
  vehicleId:    number
  number:       string
  /** Fuel burned while driving (gallons under X-Metric-Units: false). */
  drivingFuel:  number | null
  idleFuel:     number | null
}

interface PaginationMeta {
  per_page: number
  page_no:  number
  total:    number
}

function headers(apiKey: string): Record<string, string> {
  return {
    'X-API-Key':      apiKey,
    'X-Metric-Units': 'false',   // imperial: miles + US gallons
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

/** Unwrap `{ row: { … } }` when present; otherwise return the row unchanged. */
function unwrap<T>(row: unknown, key: string): T | null {
  if (!row || typeof row !== 'object') return null
  const inner = (row as Record<string, unknown>)[key]
  return (inner && typeof inner === 'object' ? inner : row) as T
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * Latest odometer for every vehicle, paginated. Vehicles without an `odometer`
 * field are still returned with `odometer: null` so the caller can skip them.
 */
export async function fetchVehicleOdometers(apiKey: string): Promise<MotiveOdometer[]> {
  const out: MotiveOdometer[] = []
  let page = 1
  let loggedShape = false
  while (true) {
    const url = `${BASE_URL}/v1/vehicle_locations?per_page=100&page_no=${page}`
    const data = await getJson(url, apiKey) as {
      vehicles?:   Array<Record<string, unknown>>
      pagination?: PaginationMeta
    }
    if (!loggedShape) {
      console.log('[motive-odometer-sync] raw /v1/vehicle_locations first row:', JSON.stringify(data.vehicles?.[0] ?? null))
      loggedShape = true
    }
    for (const row of data.vehicles ?? []) {
      const v = unwrap<{
        id?: number
        number?: string
        current_location?: { odometer?: unknown; true_odometer?: unknown } | null
      }>(row, 'vehicle')
      if (!v?.number) continue
      const loc = v.current_location ?? {}
      out.push({
        vehicleId: v.id ?? -1,
        number:    String(v.number),
        // Motive documents true_odometer as the calibrated value; the raw
        // odometer is the vehicle-gateway virtual reading. Prefer calibrated.
        odometer:  num(loc.true_odometer) ?? num(loc.odometer),
      })
    }
    const { total = 0, per_page = 100 } = data.pagination ?? {}
    if (page * per_page >= total) break
    page++
  }
  return out
}

/**
 * Driving fuel per vehicle for [startDate, endDate] inclusive (one row per
 * vehicle). The utilization rollup is timezone-bucketed by Motive, so passing a
 * single YYYY-MM-DD for both ends selects exactly that company-timezone day.
 */
export async function fetchVehicleUtilization(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<MotiveUtilization[]> {
  const out: MotiveUtilization[] = []
  let page = 1
  let loggedShape = false
  while (true) {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date:   endDate,
      per_page:   '100',
      page_no:    String(page),
    })
    const url = `${BASE_URL}/v1/vehicle_utilization?${params.toString()}`
    const data = await getJson(url, apiKey) as {
      vehicle_idle_rollups?: Array<Record<string, unknown>>
      pagination?:           PaginationMeta
      per_page?:             number
      page_no?:              number
      total?:                number
    }
    const rows = data.vehicle_idle_rollups ?? []
    if (!loggedShape) {
      console.log('[motive-odometer-sync] raw /v1/vehicle_utilization first row:', JSON.stringify(rows[0] ?? null))
      loggedShape = true
    }
    for (const row of rows) {
      const r = unwrap<{
        vehicle?: { id?: number; number?: string }
        driving_fuel?: unknown
        idle_fuel?: unknown
      }>(row, 'vehicle_idle_rollup')
      if (!r?.vehicle?.number) continue
      out.push({
        vehicleId:   r.vehicle.id ?? -1,
        number:      String(r.vehicle.number),
        drivingFuel: num(r.driving_fuel),
        idleFuel:    num(r.idle_fuel),
      })
    }
    // This endpoint documents per_page/page_no but omits `pagination` in the
    // example; accept either envelope and stop when a page comes back short.
    const total   = data.pagination?.total ?? data.total ?? out.length
    const perPage = data.pagination?.per_page ?? data.per_page ?? 100
    if (rows.length < perPage || page * perPage >= total) break
    page++
  }
  return out
}
