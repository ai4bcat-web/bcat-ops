/**
 * Step AO — the server side of "the driver shared a pin".
 *
 * `resolveShareLink` follows a maps short link without ever leaving the allow-list,
 * `reverseGeocodeWith` names a pin, and the two dev-only sim doors (`TRACKING_SIM_PINGS`,
 * `TRACKING_SIM_TEXT`) let the harness exercise the whole ingest path without a phone or
 * Twilio. The doors refuse outside the dev stack and to anyone but an ADMIN.
 */
import { isAllowedShareHost, parseLocationShare } from '../../../src/lib/locationShare'
import { isPingSource, type PingInput } from '../../../src/lib/trackingPings'
import { assertString, type Caller } from '../_shared/actionInputs'
import type { Row } from '../_shared/shipmentStore'
import { ingestShipmentMessage, type ThreadDeps } from './thread'

const MAX_REDIRECTS = 3
const FETCH_TIMEOUT_MS = 3000
const MAX_SIM_FIXES = 60
const MINUTE_MS = 60_000

/**
 * Follow a maps short link to a URL that carries coordinates. Every hop (the first
 * included) must pass `isAllowedShareHost`, redirects are followed by hand, at most three,
 * three seconds each, and no body is read. Null when anything is off.
 */
export async function resolveShareLink(url: string, fetchFn: typeof fetch): Promise<string | null> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedShareHost(current)) return null
    const parsed = parseLocationShare(current)
    if (parsed && parsed.kind !== 'SHORT_LINK') return current
    if (hop === MAX_REDIRECTS) return null
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
    let location: string | null = null
    try {
      const res = await fetchFn(current, { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'bcat-tracking/1.0' } })
      if (res.status >= 300 && res.status < 400) location = res.headers.get('location')
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
    if (!location) return null
    try {
      current = new URL(location, current).toString()
    } catch {
      return null
    }
  }
  return null
}

/** City / state of a pin through Google Geocoding (`latlng=`). Null on any failure or without a key. */
export async function reverseGeocodeWith(
  fetchFn: typeof fetch,
  apiKey: string,
  lat: number,
  lng: number,
): Promise<{ city: string; state: string } | null> {
  if (!apiKey) return null
  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
    url.searchParams.set('latlng', `${lat},${lng}`)
    url.searchParams.set('result_type', 'locality|administrative_area_level_1')
    url.searchParams.set('key', apiKey)
    const res = await fetchFn(url)
    if (!res.ok) return null
    const body = await res.json() as {
      status?: string
      results?: Array<{ address_components?: Array<{ long_name: string; short_name: string; types: string[] }> }>
    }
    if (body.status !== 'OK') return null
    for (const result of body.results ?? []) {
      const parts = result.address_components ?? []
      const city = parts.find((p) => p.types.includes('locality'))?.long_name ?? ''
      const state = parts.find((p) => p.types.includes('administrative_area_level_1'))?.short_name ?? ''
      if (city && state) return { city, state }
    }
    return null
  } catch {
    return null
  }
}

export interface SimDeps {
  isDevStack(): boolean
  now(): string
  getLoad(loadId: string): Promise<Row | null>
  putPing(input: PingInput): Promise<'WRITTEN' | 'DUPLICATE'>
  thread: ThreadDeps
}

function assertDevAdmin(deps: SimDeps, caller: Caller): void {
  if (!deps.isDevStack()) throw new Error('This action only exists on the dev stack')
  if (!caller.isAdmin) throw new Error('Forbidden: simulated tracking requires ADMIN')
}

const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** TRACKING_SIM_PINGS { loadId, fixes: [{ minutesAgo, lat, lng, source, accuracyM?, approx?, place? }] } */
export async function simPings(deps: SimDeps, input: Row, caller: Caller): Promise<Row> {
  assertDevAdmin(deps, caller)
  const loadId = assertString(input.loadId, 'loadId')
  if (!Array.isArray(input.fixes) || input.fixes.length === 0) throw new Error('fixes must be a non-empty list')
  if (input.fixes.length > MAX_SIM_FIXES) throw new Error(`At most ${MAX_SIM_FIXES} fixes per call`)
  if (!(await deps.getLoad(loadId))) throw new Error(`Load not found: ${loadId}`)

  const nowIso = deps.now()
  const nowMs = Date.parse(nowIso)
  let written = 0
  let duplicates = 0
  for (const raw of input.fixes as Row[]) {
    const source = raw?.source
    if (!isPingSource(source)) throw new Error(`Unknown ping source: ${String(source)}`)
    if (!finiteNumber(raw.minutesAgo) || !finiteNumber(raw.lat) || !finiteNumber(raw.lng)) {
      throw new Error('Each fix needs minutesAgo, lat and lng')
    }
    const result = await deps.putPing({
      loadId,
      at: new Date(nowMs - raw.minutesAgo * MINUTE_MS).toISOString(),
      lat: raw.lat,
      lng: raw.lng,
      source,
      accuracyM: finiteNumber(raw.accuracyM) ? raw.accuracyM : null,
      approx: raw.approx === true,
      place: typeof raw.place === 'string' ? raw.place : null,
      refId: `sim:${caller.sub}`,
      nowIso,
    })
    if (result === 'WRITTEN') written += 1
    else duplicates += 1
  }
  return { loadId, written, duplicates }
}

/** TRACKING_SIM_TEXT { shipmentId, body, sid? } — an inbound driver SMS without Twilio. */
export async function simText(deps: SimDeps, input: Row, caller: Caller): Promise<Row> {
  assertDevAdmin(deps, caller)
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const body = assertString(input.body, 'body')
  const sid = typeof input.sid === 'string' && input.sid.trim() ? input.sid.trim() : deps.thread.randomId()
  return ingestShipmentMessage(
    deps.thread,
    { shipmentId, messageId: `sim:${sid}`, channel: 'SMS', kind: 'CHECK_CALL_REPLY', party: 'DRIVER', from: 'sim', body },
    caller,
  )
}
