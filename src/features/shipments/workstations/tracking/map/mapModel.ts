/**
 * The one thing both map renderers (Google and the offline outline) draw. Pure: no React,
 * no clock (the caller passes `nowMs`), no network. Everything the panel decides — which
 * pins, how many dots, which marker tone, whether the route is an estimate — is decided
 * here so a renderer can only draw it, never second-guess it.
 */
import { decodePolyline, type LatLng } from '@/lib/polyline'
import {
  currentFix, sourceLabel, thinFixes, type CurrentFix, type TrackingFix,
} from '@/lib/trackingPings'
import { formatBoardDateTime } from '@/lib/date'
import { descriptorOf } from '@/lib/integrations/registry'
import type { Stop } from '@/types'
import type { CustomerTrackingView } from '@/types/tms'

/** `staff` shows sources and times; `public` (customer page) never names a source or an accuracy. */
export type MapMode = 'staff' | 'public'
export type RouteSource = 'ROUTES_API' | 'DIRECTIONS_LEGACY' | 'ESTIMATE' | 'NONE'
export type MapTone = 'fresh' | 'aging' | 'stale'

export interface MapPinInput { type: 'pickup' | 'delivery' | 'stop'; lat: number; lng: number; name?: string | null }

export interface MapModelInput {
  mode: MapMode
  pins: MapPinInput[]
  fixes: TrackingFix[]
  current: CurrentFix | null
  /** Google encoded polyline (precision 5) or null. */
  route: string | null
  routeSource: RouteSource
  /** Why the route is an estimate / absent. Staff mode only. */
  routeReason?: string | null
  nowMs: number
}

export interface MapPin { type: MapPinInput['type']; lat: number; lng: number; glyph: string; title: string }
export interface MapDot { lat: number; lng: number; at: string; approx: boolean; title: string; label: string | null }
export interface MapCurrent {
  lat: number; lng: number; tone: MapTone; title: string
  /** Pulses only while the fix is fresh. */
  pulse: boolean
  /** Accuracy halo in metres, only when the device reported worse than 100 m. */
  haloM: number | null
  /** The fix is > 500 mi from the previous one inside 30 min. */
  warn: boolean
}
export interface MapCircle { lat: number; lng: number; radiusM: number; title: string }
export interface MapBounds { south: number; west: number; north: number; east: number }

export interface MapModel {
  mode: MapMode
  pins: MapPin[]
  path: LatLng[]
  pathStyle: 'solid' | 'dashed' | 'none'
  dots: MapDot[]
  current: MapCurrent | null
  approxCircle: MapCircle | null
  /** Current ∪ pickup ∪ delivery (and the whole path when nothing else frames it); null = nothing to frame. */
  bounds: MapBounds | null
  caption: string | null
  /** Set when there is nothing to draw at all. */
  empty: string | null
  /** For the panel's data-* attributes. `currentSource` stays null in public mode. */
  meta: { fixes: number; currentSource: string | null }
}

export const MAX_DOTS = 150
export const DOT_GAP_MIN = 10
/** A visible time label on the first, the last and roughly every hour in between. */
const LABEL_GAP_MS = 60 * 60_000
const HALO_ABOVE_M = 100
const JUMP_WARN_MILES = 500
/** The customer page never knows an approximate fix's radius; it draws one that claims no precision. */
export const PUBLIC_APPROX_RADIUS_M = 8_000

export const EMPTY_NO_POSITION = 'No position yet — send a tracking link or log a check call'

const PIN_GLYPH: Record<MapPinInput['type'], string> = { pickup: 'P', delivery: 'D', stop: '' }
const PIN_TITLE: Record<MapPinInput['type'], string> = { pickup: 'Pickup', delivery: 'Delivery', stop: 'Stop' }

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const validPoint = (p: { lat: number; lng: number }) => finite(p.lat) && finite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180

export function ageLabel(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${Math.floor(minutes)} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} d ago`
}

function boundsOf(points: LatLng[]): MapBounds | null {
  if (points.length === 0) return null
  let south = Infinity; let west = Infinity; let north = -Infinity; let east = -Infinity
  for (const p of points) {
    south = Math.min(south, p.lat); north = Math.max(north, p.lat)
    west = Math.min(west, p.lng); east = Math.max(east, p.lng)
  }
  return { south, west, north, east }
}

export function buildMapModel(i: MapModelInput): MapModel {
  const staff = i.mode === 'staff'
  const pins: MapPin[] = i.pins.filter(validPoint).map((p) => ({
    type: p.type, lat: p.lat, lng: p.lng, glyph: PIN_GLYPH[p.type], title: p.name ? `${PIN_TITLE[p.type]} · ${p.name}` : PIN_TITLE[p.type],
  }))

  let path: LatLng[] = []
  if (i.route) {
    try { path = decodePolyline(i.route).filter(validPoint) } catch { path = [] }
  }
  const pathStyle: MapModel['pathStyle'] = path.length < 2 ? 'none' : i.routeSource === 'ESTIMATE' ? 'dashed' : 'solid'

  const thinned = thinFixes(i.fixes.filter((f) => validPoint(f)), DOT_GAP_MIN, MAX_DOTS)
  let lastLabelAt = -Infinity
  const dots: MapDot[] = thinned.map((f, idx) => {
    const t = Date.parse(f.at)
    const edge = idx === 0 || idx === thinned.length - 1
    const label = staff && (edge || t - lastLabelAt >= LABEL_GAP_MS) ? formatBoardDateTime(f.at) : null
    if (label) lastLabelAt = t
    return {
      lat: f.lat, lng: f.lng, at: f.at, approx: f.approx, label,
      title: staff ? `${formatBoardDateTime(f.at)} · ${sourceLabel(f.source)}` : '',
    }
  })

  let current: MapCurrent | null = null
  let approxCircle: MapCircle | null = null
  if (i.current && validPoint(i.current.fix)) {
    const { fix, overlay, tone, ageMinutes, jumpMiles } = i.current
    const place = fix.place ?? `${fix.lat.toFixed(3)}, ${fix.lng.toFixed(3)}`
    current = {
      lat: fix.lat, lng: fix.lng, tone,
      title: staff ? `${place} · ${ageLabel(ageMinutes)} · ${sourceLabel(fix.source)}` : `Last seen ${fix.place ? `near ${fix.place}` : 'here'} · ${ageLabel(ageMinutes)}`,
      pulse: tone === 'fresh',
      haloM: staff && fix.accuracyM != null && fix.accuracyM > HALO_ABOVE_M ? fix.accuracyM : null,
      warn: staff && jumpMiles != null && jumpMiles > JUMP_WARN_MILES,
    }
    // The approximate guess is a circle beside a still-fresh precise fix, or around the marker when it IS the fix.
    const guess = overlay ?? (fix.approx ? fix : null)
    if (guess && validPoint(guess)) {
      const age = Math.max(0, Math.floor((i.nowMs - Date.parse(guess.at)) / 60_000))
      approxCircle = {
        lat: guess.lat, lng: guess.lng,
        radiusM: staff ? Math.max(guess.accuracyM ?? 0, 2_000) : PUBLIC_APPROX_RADIUS_M,
        title: `Driver said: ${guess.place ? `near ${guess.place}` : 'approximate'} · ${ageLabel(age)}`,
      }
    }
  }

  const framing: LatLng[] = []
  if (current) framing.push(current)
  for (const p of pins) if (p.type !== 'stop') framing.push(p)
  if (framing.length === 0) for (const p of pins) framing.push(p)
  if (framing.length === 0 && path.length > 0) framing.push(path[0], path[path.length - 1])
  const bounds = boundsOf(framing)

  let caption: string | null = null
  if (staff) {
    if (pathStyle === 'dashed') caption = 'Estimated path — no road route available'
    else if (pins.length === 0 && (current || dots.length > 0)) caption = 'Stop coordinates missing'
  }

  const nothing = !current && dots.length === 0 && pins.length === 0 && path.length === 0
  return {
    mode: i.mode, pins, path, pathStyle, dots, current, approxCircle, bounds, caption,
    empty: nothing ? EMPTY_NO_POSITION : null,
    meta: { fixes: i.fixes.length, currentSource: staff && i.current ? i.current.fix.source : null },
  }
}

/** The customer page's view as model input: the thinned trail is the fixes; the position is the marker. */
export function publicModelInput(view: CustomerTrackingView, nowMs: number): MapModelInput {
  const map = view.map
  const fixes: TrackingFix[] = (map?.trail ?? []).map((p) => ({
    at: p.at, lat: p.lat, lng: p.lng, source: 'link', accuracyM: null, approx: p.approx === true,
    speedMph: null, headingDeg: null, place: null,
  }))
  // The server already decided what "current" is across every source; the page draws that, not its own pick.
  const pos = view.position
  let current: CurrentFix | null = null
  if (pos) {
    const trailMatch = fixes.find((f) => f.at === pos.at)
    const own: TrackingFix = {
      at: pos.at, lat: pos.lat, lng: pos.lng, source: 'link', accuracyM: null, approx: trailMatch?.approx ?? false,
      speedMph: null, headingDeg: null, place: pos.description,
    }
    if (trailMatch) Object.assign(trailMatch, own)
    else fixes.push(own)
    current = currentFix([own], nowMs)
  }
  return {
    mode: 'public',
    pins: (map?.stops ?? []).map((s) => ({ type: s.type, lat: s.lat, lng: s.lng })),
    fixes,
    current,
    route: map?.route ?? null,
    routeSource: 'ROUTES_API',
    nowMs,
  }
}

/**
 * Pins from the booked stops that carry coordinates: the first pickup is the "P", the last
 * delivery the "D", everything between is a small gray stop.
 */
export function pinsOfStops(stops: readonly Stop[] | null | undefined): MapPinInput[] {
  const located = [...(stops ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((s) => finite(s.address?.lat) && finite(s.address?.lng))
  const firstPickup = located.findIndex((s) => s.type === 'pickup')
  const lastDelivery = located.map((s) => s.type).lastIndexOf('delivery')
  return located.map((s, idx): MapPinInput => ({
    type: idx === firstPickup ? 'pickup' : idx === lastDelivery ? 'delivery' : 'stop',
    lat: s.address!.lat as number,
    lng: s.address!.lng as number,
    name: s.name ?? null,
  }))
}

/** "MacroPoint Visibility" for a registry key; the key itself for one the registry does not know. */
export function providerLabel(key: string | null | undefined): string {
  return (key ? descriptorOf(key)?.label : null) ?? key ?? 'Provider'
}
