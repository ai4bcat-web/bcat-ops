/**
 * GET_ROUTE_MILES — road miles for the shipment form's Customer Miles / Truck Miles.
 *
 * Google Distance Matrix when the Lambda already holds `GOOGLE_MAPS_API_KEY` (the same secret
 * tmsGeocode uses; nothing new in code). When there is no key, or Google refuses a leg, the leg
 * falls back to a great-circle estimate x ROAD_FACTOR from coordinates the client already has,
 * and the result says `source: 'estimate'` so the UI can label it "est.".
 */

export const ROAD_FACTOR = 1.2
const MAX_STOPS = 12
const METERS_PER_MILE = 1609.344

export interface RoutePoint {
  /** One-line address for Distance Matrix ("5 Dock Rd, Joliet, IL 60431"). */
  address?: string
  lat?: number
  lng?: number
}

export interface RouteLeg { miles: number; source: 'google' | 'estimate' }

export interface RouteMiles {
  /** Whole miles over every leg; null when any leg could not be measured at all. */
  miles: number | null
  /** `google` only when every leg came from Distance Matrix. */
  source: 'google' | 'estimate' | null
  legs: (RouteLeg | null)[]
}

export interface RouteMilesDeps {
  apiKey: string
  fetchJson: (url: string) => Promise<unknown>
}

function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return (2 * 6_371_008.8 * Math.asin(Math.sqrt(h))) / METERS_PER_MILE
}

const hasCoords = (p: RoutePoint): p is RoutePoint & { lat: number; lng: number } =>
  Number.isFinite(p.lat) && Number.isFinite(p.lng)

export function parsePoints(input: unknown): RoutePoint[] {
  if (!Array.isArray(input)) throw new Error('stops must be an array')
  if (input.length < 2) throw new Error('At least two stops are needed to measure a route')
  if (input.length > MAX_STOPS) throw new Error(`At most ${MAX_STOPS} stops can be measured`)
  return input.map((raw, i) => {
    if (raw === null || typeof raw !== 'object') throw new Error(`stops[${i}] must be an object`)
    const r = raw as Record<string, unknown>
    const address = typeof r.address === 'string' ? r.address.trim().slice(0, 300) : ''
    const lat = typeof r.lat === 'number' && Math.abs(r.lat) <= 90 ? r.lat : undefined
    const lng = typeof r.lng === 'number' && Math.abs(r.lng) <= 180 ? r.lng : undefined
    return { ...(address ? { address } : {}), ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}) }
  })
}

function placeOf(p: RoutePoint): string {
  return hasCoords(p) && !p.address ? `${p.lat},${p.lng}` : (p.address ?? '')
}

async function googleLeg(a: RoutePoint, b: RoutePoint, deps: RouteMilesDeps): Promise<number | null> {
  const from = placeOf(a)
  const to = placeOf(b)
  if (!from || !to) return null
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
  url.searchParams.set('origins', from)
  url.searchParams.set('destinations', to)
  url.searchParams.set('units', 'imperial')
  url.searchParams.set('key', deps.apiKey)
  try {
    const body = await deps.fetchJson(url.toString()) as {
      status?: string
      rows?: { elements?: { status?: string; distance?: { value?: number } }[] }[]
    }
    const el = body.status === 'OK' ? body.rows?.[0]?.elements?.[0] : undefined
    const meters = el?.status === 'OK' ? el.distance?.value : undefined
    return typeof meters === 'number' && meters >= 0 ? meters / METERS_PER_MILE : null
  } catch {
    return null
  }
}

export async function routeMiles(points: RoutePoint[], deps: RouteMilesDeps): Promise<RouteMiles> {
  const legs: (RouteLeg | null)[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const g = deps.apiKey ? await googleLeg(a, b, deps) : null
    if (g !== null) { legs.push({ miles: g, source: 'google' }); continue }
    legs.push(hasCoords(a) && hasCoords(b) ? { miles: haversineMiles(a, b) * ROAD_FACTOR, source: 'estimate' } : null)
  }
  if (legs.some((l) => l === null)) return { miles: null, source: null, legs }
  const done = legs as RouteLeg[]
  return {
    miles: Math.round(done.reduce((sum, l) => sum + l.miles, 0)),
    source: done.every((l) => l.source === 'google') ? 'google' : 'estimate',
    legs: done.map((l) => ({ ...l, miles: Math.round(l.miles) })),
  }
}
