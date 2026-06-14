/**
 * Blue Ink Tech (BIT) API client.
 *
 * Auth:  x-api-key header.
 * Base:  https://blueinktech.com/api/v1/
 *
 * Endpoints used:
 *   GET /vehicles/            — list vehicles; match by `number` field = our unit number.
 *   GET /vehicle_locations/   — latest position per vehicle (current_location.{lat,lon,
 *                               located_at,speed_mph,odometer}). Values are STRINGS.
 *   GET /vehicle_route/?vehicle_id=&start_time=&end_time=
 *                             — GPS breadcrumb list for a date range. There is no
 *                               mileage/IFTA endpoint, so per-period miles are derived
 *                               from the route: odometer delta when reported, else the
 *                               sum of haversine distances between consecutive points.
 *
 * Timestamps from BIT have no timezone ("2026-06-06 11:37:39.526" / "...T11:35:54");
 * they are treated as UTC and normalised to ISO-8601 (Z).
 */

const BASE_URL = 'https://blueinktech.com/api/v1'

export interface BlueInkVehicle {
  id:     string        // BIT vehicle id, e.g. "176260"
  number: string        // fleet/unit number, e.g. "310" — matches our unitNumber
  vin?:   string
  make?:  string
  model?: string
  year?:  string
}

export interface BlueInkLocation {
  vehicleId:   string
  number:      string
  lat:         number
  lon:         number
  locatedAt:   string        // ISO-8601 (UTC)
  speed:       number | null // mph
  bearing:     number | null // BIT does not report heading → always null
  description: string | null // BIT does not provide a geocoded description → null
}

function headers(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
}

async function getJson(url: string, apiKey: string): Promise<unknown> {
  const res = await fetch(url, { headers: headers(apiKey) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Blue Ink Tech API ${res.status} ${res.statusText} — ${url}\n${body}`)
  }
  return res.json()
}

/** Normalise a BIT timestamp (no TZ) to an ISO-8601 UTC string. */
export function toIsoUtc(s: string | null | undefined): string {
  if (!s) return new Date().toISOString()
  const t = s.trim().replace(' ', 'T')
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)
  const d = new Date(hasTz ? t : `${t}Z`)
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return isFinite(n) ? n : null
}

interface PaginationMeta { per_page: number; page_no: number; total: number }

interface RawVehicle {
  id?: string; number?: string; vin?: string; make?: string; model?: string; year?: string
  current_location?: {
    lat?: string | number; lon?: string | number; located_at?: string
    speed_mph?: string | number | null; odometer?: string | number | null
  } | null
}

/** All BIT vehicles, keyed by unit number. */
export async function fetchVehicles(apiKey: string): Promise<Map<string, BlueInkVehicle>> {
  const map = new Map<string, BlueInkVehicle>()
  let page = 1
  while (true) {
    const data = await getJson(`${BASE_URL}/vehicles/?per_page=100&page_no=${page}`, apiKey) as {
      vehicles?: Array<{ vehicle: RawVehicle }>
      pagination?: PaginationMeta
    }
    for (const row of data.vehicles ?? []) {
      const v = row.vehicle
      if (v?.number && v.id) {
        map.set(String(v.number), { id: String(v.id), number: String(v.number), vin: v.vin, make: v.make, model: v.model, year: v.year })
      }
    }
    const p = data.pagination
    if (!p || p.page_no * p.per_page >= p.total) break
    page++
  }
  return map
}

/** Latest known location for every BIT vehicle (rows without a usable fix are skipped). */
export async function fetchVehicleLocations(apiKey: string): Promise<BlueInkLocation[]> {
  const out: BlueInkLocation[] = []
  let page = 1
  while (true) {
    const data = await getJson(`${BASE_URL}/vehicle_locations/?per_page=100&page_no=${page}`, apiKey) as {
      vehicles?: Array<{ vehicle: RawVehicle }>
      pagination?: PaginationMeta
    }
    for (const row of data.vehicles ?? []) {
      const v = row.vehicle
      const loc = v?.current_location
      const lat = num(loc?.lat)
      const lon = num(loc?.lon)
      if (!v?.number || !loc || lat == null || lon == null) continue
      out.push({
        vehicleId:   String(v.id ?? ''),
        number:      String(v.number),
        lat,
        lon,
        locatedAt:   toIsoUtc(loc.located_at),
        speed:       num(loc.speed_mph),
        bearing:     null,
        description: null,
      })
    }
    const p = data.pagination
    if (!p || p.page_no * p.per_page >= p.total) break
    page++
  }
  return out
}

interface RawRoutePoint {
  lat?: string | number; lon?: string | number
  odometer?: string | number | null; speed_mph?: string | number | null; located_at?: string
}

/** Great-circle distance between two points, in miles. */
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.7613 // mean Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Miles a BIT vehicle travelled in [startDate, endDate] (YYYY-MM-DD), derived from
 * the route breadcrumb list:
 *   • if ≥2 points report a real odometer → max − min odometer (accurate), else
 *   • sum of haversine distance between consecutive points, dropping sub-0.03-mi
 *     segments to filter parked-GPS jitter.
 */
export async function fetchMilesForVehicle(
  apiKey: string,
  vehicleId: string,
  startDate: string,
  endDate: string,
): Promise<number> {
  const points: Array<{ lat: number; lon: number; odo: number | null; at: string }> = []
  let page = 1
  while (true) {
    const qs =
      `vehicle_id=${encodeURIComponent(vehicleId)}` +
      `&start_time=${encodeURIComponent(`${startDate} 00:00:00`)}` +
      `&end_time=${encodeURIComponent(`${endDate} 23:59:59`)}` +
      `&per_page=1000&page_no=${page}`
    const data = await getJson(`${BASE_URL}/vehicle_route/?${qs}`, apiKey) as {
      route?: RawRoutePoint[]
      pagination?: PaginationMeta
    }
    for (const p of data.route ?? []) {
      const lat = num(p.lat)
      const lon = num(p.lon)
      if (lat == null || lon == null) continue
      points.push({ lat, lon, odo: num(p.odometer), at: String(p.located_at ?? '') })
    }
    const pg = data.pagination
    if (!pg || pg.page_no * pg.per_page >= pg.total) break
    page++
  }

  if (points.length < 2) return 0
  points.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  // Odometer path — most accurate when the device reports it.
  const odos = points.map((p) => p.odo).filter((o): o is number => o != null && o > 0)
  if (odos.length >= 2) {
    const miles = Math.max(...odos) - Math.min(...odos)
    if (miles >= 0) return miles
  }

  // GPS path — sum consecutive segments, ignoring parked jitter (< 0.03 mi).
  let miles = 0
  for (let i = 1; i < points.length; i++) {
    const d = haversineMiles(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon)
    if (d >= 0.03) miles += d
  }
  return miles
}
