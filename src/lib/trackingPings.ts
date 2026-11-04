/**
 * Step AO — the breadcrumb contract.
 *
 * A "fix" is one position from any source: an ELD (Motive / Blue Ink rows that already
 * live in `TruckLocationHistory`), the driver's tapped link, a shared-location SMS, a
 * geocoded text reply, or a tracking provider. Load-keyed fixes are rows of the same
 * table with `truckId = 'load:<loadId>'` (plan D-AO1); this file is the one place that
 * knows how such a row is shaped, read back, merged, thinned and ranked.
 *
 * Pure and dependency-free (type imports aside) because three Lambdas bundle it by
 * relative path and the browser imports it through `@/lib/…`.
 */
import { haversineMiles, type LatLng } from './polyline'

export type PingSource =
  | 'motive' | 'blueink'                       // ELD (fleet rows)
  | 'link' | 'sms-share' | 'sms-geocode' | 'manual'
  | `provider:${string}`                       // lower-case registry key

export const LOAD_PING_PREFIX = 'load:'
export const ROUTE_ROW_PREFIX = 'route:'
export const PING_RETENTION_DAYS = 90
export const ROUTE_RETENTION_DAYS = 30
export const loadPingKey = (loadId: string): string => `${LOAD_PING_PREFIX}${loadId}`

/** A device clock is believed only inside this band around the server clock. */
const DEVICE_CLOCK_PAST_MS = 10 * 60_000
const DEVICE_CLOCK_FUTURE_MS = 2 * 60_000
/** An approximate fix never replaces a precise one younger than this (D-AO8). */
const APPROX_SHADOW_MS = 4 * 3_600_000
const MINUTE_MS = 60_000
const DAY_SECONDS = 86_400
const JUMP_WINDOW_MS = 30 * MINUTE_MS
/** A point further than this from the route is "off route" and has no miles-to-go. */
const OFF_ROUTE_MILES = 25

export interface TrackingFix {
  at: string                       // ISO
  lat: number; lng: number
  source: PingSource
  accuracyM: number | null         // for approx fixes: radius of the guess
  approx: boolean
  speedMph: number | null; headingDeg: number | null
  place: string | null             // "Joliet, IL" when known
}

export interface PingInput {       // what a writer hands to pingRow()
  loadId: string; unitNumber?: string | null
  at: string; lat: number; lng: number
  source: PingSource; accuracyM?: number | null; approx?: boolean
  speedMph?: number | null; headingDeg?: number | null; place?: string | null
  refId?: string | null; nowIso: string
}

const FIXED_SOURCES: ReadonlySet<string> = new Set(['motive', 'blueink', 'link', 'sms-share', 'sms-geocode', 'manual'])

export function isPingSource(value: unknown): value is PingSource {
  if (typeof value !== 'string') return false
  if (FIXED_SOURCES.has(value)) return true
  return value.startsWith('provider:') && value.length > 'provider:'.length
}

const validLat = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= -90 && n <= 90
const validLng = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= -180 && n <= 180

/**
 * The instant a fix is filed under. The device clock wins when it is plausible (so a
 * retried POST lands on the same sort key and the conditional put dedupes it); a phone
 * with a wrong clock cannot back-date or future-date a breadcrumb.
 */
export function resolveFixAt(deviceAt: string | null | undefined, nowIso: string): string {
  const now = Date.parse(nowIso)
  const device = deviceAt ? Date.parse(deviceAt) : Number.NaN
  if (Number.isNaN(device)) return new Date(now).toISOString()
  if (device < now - DEVICE_CLOCK_PAST_MS || device > now + DEVICE_CLOCK_FUTURE_MS) return new Date(now).toISOString()
  return new Date(device).toISOString()
}

/** The full DynamoDB item for one load-keyed fix. Throws on an unusable fix: a writer must not file garbage. */
export function pingRow(i: PingInput): Record<string, unknown> {
  const atMs = Date.parse(i.at)
  if (Number.isNaN(atMs)) throw new RangeError('pingRow: unparseable fix time')
  if (!validLat(i.lat) || !validLng(i.lng)) throw new RangeError('pingRow: coordinates out of range')
  const row: Record<string, unknown> = {
    __typename: 'TruckLocationHistory',
    truckId: loadPingKey(i.loadId),
    locatedAt: new Date(atMs).toISOString(),
    loadId: i.loadId,
    unitNumber: i.unitNumber?.trim() || 'LOAD',
    lat: i.lat,
    lon: i.lng,
    source: i.source,
    syncedAt: i.nowIso,
    createdAt: i.nowIso,
    updatedAt: i.nowIso,
    ttlEpoch: Math.floor(atMs / 1000) + PING_RETENTION_DAYS * DAY_SECONDS,
  }
  if (i.accuracyM != null && Number.isFinite(i.accuracyM)) row.accuracyM = Math.max(0, Math.round(i.accuracyM))
  if (i.approx) row.approx = true
  if (i.speedMph != null && Number.isFinite(i.speedMph)) row.speed = i.speedMph
  if (i.headingDeg != null && Number.isFinite(i.headingDeg)) row.bearing = i.headingDeg
  if (i.place) row.description = i.place
  if (i.refId) row.refId = i.refId
  return row
}

/** One history row (fleet or load-keyed) as a fix; null for anything that is not a valid position. */
export function fixOfRow(row: Record<string, unknown>): TrackingFix | null {
  const truckId = row.truckId
  if (typeof truckId === 'string' && truckId.startsWith(ROUTE_ROW_PREFIX)) return null
  const lat = row.lat
  const lng = row.lon
  if (!validLat(lat) || !validLng(lng)) return null
  const at = typeof row.locatedAt === 'string' ? row.locatedAt : null
  if (!at || Number.isNaN(Date.parse(at))) return null
  if (!isPingSource(row.source)) return null
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    at,
    lat,
    lng,
    source: row.source,
    accuracyM: num(row.accuracyM),
    approx: row.approx === true,
    speedMph: num(row.speed),
    headingDeg: num(row.bearing),
    place: typeof row.description === 'string' && row.description ? row.description : null,
  }
}

/** Ascending by time; same-source fixes less than a second apart collapse to the first. */
export function mergeFixes(...sets: TrackingFix[][]): TrackingFix[] {
  const all = sets.flat().filter((f) => !Number.isNaN(Date.parse(f.at)))
  all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const out: TrackingFix[] = []
  const lastBySource = new Map<string, number>()
  for (const fix of all) {
    const at = Date.parse(fix.at)
    const prev = lastBySource.get(fix.source)
    if (prev !== undefined && at - prev < 1000) continue
    lastBySource.set(fix.source, at)
    out.push(fix)
  }
  return out
}

/** At most one fix per `minGapMin`, at most `max` in all; the first and the last always survive. */
export function thinFixes(fixes: TrackingFix[], minGapMin: number, max: number): TrackingFix[] {
  const ordered = fixes
    .filter((f) => !Number.isNaN(Date.parse(f.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (ordered.length <= 2) return ordered.slice(0, Math.max(0, max))
  const gapMs = Math.max(0, minGapMin) * MINUTE_MS
  const kept: TrackingFix[] = [ordered[0]]
  let keptAt = Date.parse(ordered[0].at)
  for (let i = 1; i < ordered.length - 1; i++) {
    const at = Date.parse(ordered[i].at)
    if (at - keptAt >= gapMs) {
      kept.push(ordered[i])
      keptAt = at
    }
  }
  kept.push(ordered[ordered.length - 1])
  if (max < 2 || kept.length <= max) return max < 2 ? kept.slice(-Math.max(0, max)) : kept
  // Too many even after the gap rule: sample evenly, pinning both ends.
  const out: TrackingFix[] = []
  const step = (kept.length - 1) / (max - 1)
  for (let n = 0; n < max; n++) out.push(kept[Math.round(n * step)])
  return out
}

/** motive/blueink 100 · provider 90 · link 80 · sms-share 70 · manual 60 · sms-geocode 10. */
export function trustRank(source: PingSource, approx: boolean): number {
  if (approx) return 10
  if (source === 'motive' || source === 'blueink') return 100
  if (source.startsWith('provider:')) return 90
  switch (source) {
    case 'link': return 80
    case 'sms-share': return 70
    case 'manual': return 60
    case 'sms-geocode': return 10
    default: return 0
  }
}

const PROVIDER_LABELS: Record<string, string> = {
  macropoint: 'MacroPoint',
  trucker_tools: 'Trucker Tools',
  load_market: 'Load Market',
  project44: 'project44',
}

export function sourceLabel(source: PingSource): string {
  if (source.startsWith('provider:')) {
    const key = source.slice('provider:'.length)
    return PROVIDER_LABELS[key] ?? key.split(/[_-]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
  }
  switch (source) {
    case 'motive': return 'Motive ELD'
    case 'blueink': return 'Blue Ink ELD'
    case 'link': return 'Driver phone (link)'
    case 'sms-share': return 'Driver-shared pin (SMS)'
    case 'sms-geocode': return 'Text reply (approximate)'
    case 'manual': return 'Entered by dispatch'
    default: return source
  }
}

export interface CurrentFix {
  fix: TrackingFix                  // the marker
  overlay: TrackingFix | null       // a newer approx fix shown as a circle beside a still-fresh precise fix
  ageMinutes: number
  tone: 'fresh' | 'aging' | 'stale' // < 15 min · 15-60 min · > 60 min
  /** Miles from the previous fix when it was reported within 30 min of this one; the map warns above 500. Never stored. */
  jumpMiles: number | null
}

/** The newest fix wins, except that an approximate newest fix does not replace a precise fix under 4 h old. */
export function currentFix(fixes: TrackingFix[], nowMs: number): CurrentFix | null {
  const ordered = fixes
    .filter((f) => !Number.isNaN(Date.parse(f.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (ordered.length === 0) return null

  let idx = ordered.length - 1
  let overlay: TrackingFix | null = null
  const newest = ordered[idx]
  if (newest.approx) {
    for (let j = idx - 1; j >= 0; j--) {
      if (ordered[j].approx) continue
      if (nowMs - Date.parse(ordered[j].at) < APPROX_SHADOW_MS) {
        overlay = newest
        idx = j
      }
      break
    }
  }

  const fix = ordered[idx]
  const ageMs = Math.max(0, nowMs - Date.parse(fix.at))
  const minutes = ageMs / MINUTE_MS
  let jumpMiles: number | null = null
  if (idx > 0) {
    const prev = ordered[idx - 1]
    if (Date.parse(fix.at) - Date.parse(prev.at) <= JUMP_WINDOW_MS) {
      jumpMiles = haversineMiles({ lat: prev.lat, lng: prev.lng }, { lat: fix.lat, lng: fix.lng })
    }
  }
  return {
    fix,
    overlay,
    ageMinutes: Math.floor(minutes),
    tone: minutes < 15 ? 'fresh' : minutes <= 60 ? 'aging' : 'stale',
    jumpMiles,
  }
}

// Local planar projection (miles) around a reference latitude: accurate to well under a
// percent over the 25-mile corridor this is used for, and cheap enough for a 3 000-vertex path.
function toXY(p: LatLng, refLat: number): { x: number; y: number } {
  const milesPerDegLat = 69.0
  return { x: p.lng * milesPerDegLat * Math.cos((refLat * Math.PI) / 180), y: p.lat * milesPerDegLat }
}

/** Along-route distance from `at` to the end of `path`; null when the point is more than 25 mi off the route. */
export function remainingMiles(path: LatLng[], at: LatLng): number | null {
  if (path.length === 0) return null
  if (path.length === 1) {
    return haversineMiles(path[0], at) > OFF_ROUTE_MILES ? null : 0
  }
  const refLat = at.lat
  const p = toXY(at, refLat)
  let best = Number.POSITIVE_INFINITY
  let bestSeg = 0
  let bestT = 0
  for (let i = 0; i < path.length - 1; i++) {
    const a = toXY(path[i], refLat)
    const b = toXY(path[i + 1], refLat)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    if (d < best) { best = d; bestSeg = i; bestT = t }
  }
  if (best > OFF_ROUTE_MILES) return null
  const segEnd = path[bestSeg + 1]
  const segStart = path[bestSeg]
  const proj = { lat: segStart.lat + (segEnd.lat - segStart.lat) * bestT, lng: segStart.lng + (segEnd.lng - segStart.lng) * bestT }
  let miles = haversineMiles(proj, segEnd)
  for (let i = bestSeg + 1; i < path.length - 1; i++) miles += haversineMiles(path[i], path[i + 1])
  return miles
}

/** The canonical lane string `lat,lng|lat,lng|…`, rounded to 0.01° (~1 km). The Lambda hashes it; the browser never does. */
export function routeKeyOf(stops: LatLng[]): string {
  const r = (n: number): string => {
    const s = n.toFixed(2)
    return s === '-0.00' ? '0.00' : s
  }
  return stops.map((s) => `${r(s.lat)},${r(s.lng)}`).join('|')
}
