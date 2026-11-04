/**
 * Step AO — GET_LOAD_ROUTE: the planned route of a load, computed server-side.
 *
 * One Routes API call per distinct lane per 30 days (the lane is the waypoints rounded to
 * 0.01°, so two loads on the same lane share a row), cached in TruckLocationHistory under
 * `truckId = 'route:<sha1>'`. The browser only ever draws the encoded polyline; it never
 * calls Directions. A Google problem is an answer ("ESTIMATE" / "NONE" with a reason),
 * never an exception: the drawer's map must not break because a key is unset.
 */
import { createHash } from 'node:crypto'
import { encodePolyline } from '../../../src/lib/polyline'
import { ROUTE_RETENTION_DAYS, ROUTE_ROW_PREFIX, routeKeyOf } from '../../../src/lib/trackingPings'
import { assertString, type Caller } from '../_shared/actionInputs'
import { readStops, type Row } from '../_shared/shipmentStore'

export interface RouteWaypoint {
  type: 'pickup' | 'delivery' | 'stop'
  lat: number
  lng: number
  name: string | null
}

/** Same shape as `LoadRoute` in `src/lib/apiClient.ts` (kept local so the Lambda never bundles the client). */
export interface LoadRouteResult {
  encoded: string | null
  meters: number | null
  seconds: number | null
  source: 'ROUTES_API' | 'DIRECTIONS_LEGACY' | 'ESTIMATE' | 'NONE'
  cached: boolean
  fetchedAt: string | null
  waypoints: RouteWaypoint[]
  reason: string | null
}

export interface RouteDeps {
  tables: { load: string }
  getById(table: string, id: string): Promise<Row | null>
  /** History table, by (truckId, locatedAt). */
  getHistory(truckId: string, locatedAt: string): Promise<Row | null>
  /** Conditional put: writes unless a row with a ttlEpoch still in the future exists. */
  putHistory(item: Row, nowEpochSec: number): Promise<void>
  /** Free-text address to coordinates; null when unknown. Never throws. */
  geocodeAddress(text: string): Promise<{ lat: number; lng: number } | null>
  fetch: typeof fetch
  /** Server Maps key; empty = no key. */
  apiKey: string
  now(): string
}

const MAX_MIDDLE_STOPS = 8
const ESTIMATE_TTL_DAYS = 1
const DAY_SECONDS = 86_400
const GOOGLE_TIMEOUT_MS = 8000
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json'

const round5 = (n: number): number => Math.round(n * 1e5) / 1e5
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function addressText(address: Row | null | undefined, city: unknown): string | null {
  const a = address ?? {}
  const parts = [a.street, a.city ?? city, a.state, a.zip].filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  return parts.length >= 2 ? parts.join(', ') : null
}

/**
 * First pickup, up to eight stops in between, last delivery — coordinates from the stop's
 * address, geocoded once (not persisted) when the address has none. `missing` names the
 * end that could not be placed.
 */
async function waypointsOf(
  deps: RouteDeps,
  load: Row,
): Promise<{ waypoints: RouteWaypoint[]; missing: string | null }> {
  const stops = readStops(load)
  const firstPickup = stops.findIndex((s) => s.type === 'pickup')
  let lastDelivery = -1
  stops.forEach((s, i) => { if (s.type === 'delivery') lastDelivery = i })
  if (firstPickup < 0 || lastDelivery < 0 || lastDelivery <= firstPickup) {
    return { waypoints: [], missing: 'This load needs a pickup and a delivery stop' }
  }
  const chosen = stops.slice(firstPickup, lastDelivery + 1)
  const middle = chosen.slice(1, -1).slice(0, MAX_MIDDLE_STOPS)
  const ordered = [
    { stop: chosen[0], type: 'pickup' as const },
    ...middle.map((stop) => ({ stop, type: 'stop' as const })),
    { stop: chosen[chosen.length - 1], type: 'delivery' as const },
  ]
  const waypoints: RouteWaypoint[] = []
  for (const { stop, type } of ordered) {
    const address = (stop.address ?? null) as Row | null
    let lat = address?.lat
    let lng = address?.lng
    if (!finite(lat) || !finite(lng)) {
      const text = addressText(address, stop.city)
      const hit = text ? await deps.geocodeAddress(text) : null
      if (!hit) {
        if (type === 'stop') continue
        return { waypoints: [], missing: `${type === 'pickup' ? 'Pickup' : 'Delivery'} address has no coordinates` }
      }
      lat = hit.lat
      lng = hit.lng
    }
    waypoints.push({ type, lat: round5(lat as number), lng: round5(lng as number), name: typeof stop.name === 'string' && stop.name ? stop.name : null })
  }
  return { waypoints, missing: null }
}

interface Computed {
  encoded: string
  meters: number | null
  seconds: number | null
  source: 'ROUTES_API' | 'DIRECTIONS_LEGACY' | 'ESTIMATE'
  reason: string | null
}

async function timedFetch(deps: RouteDeps, url: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), GOOGLE_TIMEOUT_MS)
  try {
    return await deps.fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

const latLng = (w: RouteWaypoint) => ({ location: { latLng: { latitude: w.lat, longitude: w.lng } } })

async function viaRoutesApi(deps: RouteDeps, wps: RouteWaypoint[]): Promise<{ ok: Computed } | { reason: string }> {
  try {
    const res = await timedFetch(deps, ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': deps.apiKey,
        'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration',
      },
      body: JSON.stringify({
        origin: latLng(wps[0]),
        destination: latLng(wps[wps.length - 1]),
        ...(wps.length > 2 ? { intermediates: wps.slice(1, -1).map(latLng) } : {}),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        polylineQuality: 'OVERVIEW',
        polylineEncoding: 'ENCODED_POLYLINE',
        units: 'IMPERIAL',
      }),
    })
    if (!res.ok) return { reason: `Routes API refused the request (HTTP ${res.status})` }
    const body = await res.json() as { routes?: Array<{ polyline?: { encodedPolyline?: string }; distanceMeters?: number; duration?: string }> }
    const route = body.routes?.[0]
    const encoded = route?.polyline?.encodedPolyline
    if (!encoded) return { reason: 'Routes API returned no route' }
    const seconds = route?.duration ? Number.parseInt(route.duration, 10) : NaN
    return { ok: { encoded, meters: finite(route?.distanceMeters) ? route.distanceMeters : null, seconds: Number.isFinite(seconds) ? seconds : null, source: 'ROUTES_API', reason: null } }
  } catch (err) {
    return { reason: `Routes API unreachable (${err instanceof Error ? err.name : 'error'})` }
  }
}

async function viaDirectionsLegacy(deps: RouteDeps, wps: RouteWaypoint[]): Promise<{ ok: Computed } | { reason: string }> {
  try {
    const at = (w: RouteWaypoint): string => `${w.lat},${w.lng}`
    const url = new URL(DIRECTIONS_URL)
    url.searchParams.set('origin', at(wps[0]))
    url.searchParams.set('destination', at(wps[wps.length - 1]))
    if (wps.length > 2) url.searchParams.set('waypoints', wps.slice(1, -1).map(at).join('|'))
    url.searchParams.set('key', deps.apiKey)
    const res = await timedFetch(deps, url.toString())
    if (!res.ok) return { reason: `Directions API refused the request (HTTP ${res.status})` }
    const body = await res.json() as {
      status?: string
      routes?: Array<{ overview_polyline?: { points?: string }; legs?: Array<{ distance?: { value?: number }; duration?: { value?: number } }> }>
    }
    const route = body.status === 'OK' ? body.routes?.[0] : null
    const encoded = route?.overview_polyline?.points
    if (!route || !encoded) return { reason: `Directions API: ${body.status ?? 'no route'}` }
    const legs = route.legs ?? []
    const sum = (pick: (l: (typeof legs)[number]) => number | undefined): number | null => {
      const values = legs.map(pick)
      return values.length > 0 && values.every(finite) ? (values as number[]).reduce((a, b) => a + b, 0) : null
    }
    return { ok: { encoded, meters: sum((l) => l.distance?.value), seconds: sum((l) => l.duration?.value), source: 'DIRECTIONS_LEGACY', reason: null } }
  } catch (err) {
    return { reason: `Directions API unreachable (${err instanceof Error ? err.name : 'error'})` }
  }
}

async function compute(deps: RouteDeps, wps: RouteWaypoint[]): Promise<Computed> {
  const estimate = (reason: string): Computed => ({
    encoded: encodePolyline(wps.map((w) => ({ lat: w.lat, lng: w.lng }))),
    meters: null,
    seconds: null,
    source: 'ESTIMATE',
    reason,
  })
  if (!deps.apiKey) return estimate('No server Maps key is configured')
  const routes = await viaRoutesApi(deps, wps)
  if ('ok' in routes) return routes.ok
  const legacy = await viaDirectionsLegacy(deps, wps)
  if ('ok' in legacy) return legacy.ok
  return estimate(routes.reason)
}

function payloadOf(row: Row): Row | null {
  let p: unknown = row.payload
  for (let i = 0; i < 2 && typeof p === 'string'; i++) {
    try { p = JSON.parse(p) } catch { return null }
  }
  return p && typeof p === 'object' && !Array.isArray(p) ? p as Row : null
}

function resultOfPayload(p: Row, cached: boolean): LoadRouteResult | null {
  const source = p.source
  if (source !== 'ROUTES_API' && source !== 'DIRECTIONS_LEGACY' && source !== 'ESTIMATE') return null
  if (typeof p.encoded !== 'string' || !p.encoded) return null
  return {
    encoded: p.encoded,
    meters: finite(p.meters) ? p.meters : null,
    seconds: finite(p.seconds) ? p.seconds : null,
    source,
    cached,
    fetchedAt: typeof p.fetchedAt === 'string' ? p.fetchedAt : null,
    waypoints: Array.isArray(p.waypoints) ? p.waypoints as RouteWaypoint[] : [],
    reason: typeof p.reason === 'string' ? p.reason : null,
  }
}

export function routeLaneKey(waypoints: Array<{ lat: number; lng: number }>): string {
  return createHash('sha1').update(routeKeyOf(waypoints)).digest('hex')
}

export async function getLoadRoute(deps: RouteDeps, input: Row, _caller: Caller): Promise<LoadRouteResult> {
  const loadId = assertString(input.loadId, 'loadId')
  const none = (reason: string, waypoints: RouteWaypoint[] = []): LoadRouteResult => ({
    encoded: null, meters: null, seconds: null, source: 'NONE', cached: false, fetchedAt: null, waypoints, reason,
  })
  const load = await deps.getById(deps.tables.load, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)

  const { waypoints, missing } = await waypointsOf(deps, load)
  if (missing) return none(missing)

  const key = routeLaneKey(waypoints)
  const nowIso = deps.now()
  const nowMs = Date.parse(nowIso)
  const nowSec = Math.floor(nowMs / 1000)
  const truckId = `${ROUTE_ROW_PREFIX}${key}`

  const hit = await deps.getHistory(truckId, 'route')
  if (hit && finite(Number(hit.ttlEpoch)) && Number(hit.ttlEpoch) * 1000 > nowMs) {
    const p = payloadOf(hit)
    const cached = p ? resultOfPayload(p, true) : null
    // The caller's stops win for the pins: two loads on one lane share a polyline, not a name.
    if (cached) return { ...cached, waypoints }
  }

  const computed = await compute(deps, waypoints)
  const ttlDays = computed.source === 'ESTIMATE' ? ESTIMATE_TTL_DAYS : ROUTE_RETENTION_DAYS
  const payload = {
    encoded: computed.encoded,
    meters: computed.meters,
    seconds: computed.seconds,
    source: computed.source,
    reason: computed.reason,
    fetchedAt: nowIso,
    key,
    waypoints,
  }
  try {
    await deps.putHistory({
      __typename: 'TruckLocationHistory',
      truckId,
      locatedAt: 'route',
      unitNumber: 'ROUTE',
      lat: waypoints[0].lat,
      lon: waypoints[0].lng,
      source: computed.source === 'ROUTES_API' ? 'routes-api' : computed.source === 'DIRECTIONS_LEGACY' ? 'directions-legacy' : 'estimate',
      syncedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
      ttlEpoch: nowSec + ttlDays * DAY_SECONDS,
      // `payload` is an AWSJSON field: a JSON string on the wire.
      payload: JSON.stringify(payload),
    }, nowSec)
  } catch (err) {
    console.warn('[tms-tracking-actions] route cache write failed', { err: String(err) })
  }
  return {
    encoded: computed.encoded,
    meters: computed.meters,
    seconds: computed.seconds,
    source: computed.source,
    cached: false,
    fetchedAt: nowIso,
    waypoints,
    reason: computed.reason,
  }
}
