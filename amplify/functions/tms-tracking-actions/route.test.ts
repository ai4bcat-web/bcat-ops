import { describe, it, expect, vi } from 'vitest'
import { decodePolyline } from '../../../src/lib/polyline'
import { getLoadRoute, routeLaneKey, type RouteDeps } from './route'
import type { Row } from '../_shared/shipmentStore'

const CALLER = { email: 'ops@bcatcorp.com', sub: 's', groups: [], isAdmin: false }
const NOW = '2026-11-04T12:00:00.000Z'
const NOW_SEC = Date.parse(NOW) / 1000

function stops(overrides: Row[] = []): Row {
  return {
    stops: JSON.stringify([
      { id: 'a', type: 'pickup', sequence: 1, name: 'Joliet DC', address: { lat: 41.5245, lng: -88.081 }, ...overrides[0] },
      { id: 'b', type: 'delivery', sequence: 2, name: 'Toledo DC', address: { lat: 41.6528, lng: -83.5379 }, ...overrides[1] },
    ]),
  }
}

function makeDeps(loads: Record<string, Row>, over: Partial<RouteDeps> = {}) {
  const history = new Map<string, Row>()
  const fetchMock = vi.fn()
  const deps: RouteDeps = {
    tables: { load: 'Load' },
    getById: async (_t, id) => (loads[id] ? { id, ...loads[id] } : null),
    getHistory: async (truckId, locatedAt) => history.get(`${truckId}|${locatedAt}`) ?? null,
    putHistory: async (item, nowSec) => {
      const k = `${item.truckId}|${item.locatedAt}`
      const old = history.get(k)
      if (old && Number(old.ttlEpoch) >= nowSec) return
      history.set(k, item)
    },
    geocodeAddress: vi.fn(async () => null),
    fetch: fetchMock as unknown as typeof fetch,
    apiKey: 'server-key',
    now: () => NOW,
    ...over,
  }
  return { deps, history, fetchMock }
}

const routesOk = () => new Response(JSON.stringify({
  routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }, distanceMeters: 500000, duration: '18000s' }],
}), { status: 200 })

describe('GET_LOAD_ROUTE', () => {
  it('calls the Routes API once, caches the row with a 30-day ttl, then serves the cache', async () => {
    const { deps, history, fetchMock } = makeDeps({ 'lod-1': stops() })
    fetchMock.mockImplementation(async () => routesOk())

    const first = await getLoadRoute(deps, { loadId: 'lod-1' }, CALLER)
    expect(first).toMatchObject({ source: 'ROUTES_API', cached: false, meters: 500000, seconds: 18000, reason: null })
    expect(decodePolyline(first.encoded as string)).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Goog-FieldMask']).toBe('routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration')
    expect(headers['X-Goog-Api-Key']).toBe('server-key')
    expect(JSON.parse(String(init.body))).toMatchObject({ travelMode: 'DRIVE', polylineEncoding: 'ENCODED_POLYLINE' })

    const row = [...history.values()][0]
    expect(String(row.truckId)).toMatch(/^route:[0-9a-f]{40}$/)
    expect(row.locatedAt).toBe('route')
    expect(row.ttlEpoch).toBe(NOW_SEC + 30 * 86_400)

    const second = await getLoadRoute(deps, { loadId: 'lod-1' }, CALLER)
    expect(second).toMatchObject({ cached: true, source: 'ROUTES_API', encoded: first.encoded })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refetches when the cached row has expired', async () => {
    const { deps, history, fetchMock } = makeDeps({ 'lod-1': stops() })
    fetchMock.mockImplementation(async () => routesOk())
    await getLoadRoute(deps, { loadId: 'lod-1' }, CALLER)
    for (const row of history.values()) row.ttlEpoch = NOW_SEC - 1
    const again = await getLoadRoute(deps, { loadId: 'lod-1' }, CALLER)
    expect(again.cached).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('two loads on the same lane share one cached row', async () => {
    const { deps, history, fetchMock } = makeDeps({ 'lod-1': stops(), 'lod-2': stops([{ address: { lat: 41.5241, lng: -88.0811 } }]) })
    fetchMock.mockImplementation(async () => routesOk())
    await getLoadRoute(deps, { loadId: 'lod-1' }, CALLER)
    const second = await getLoadRoute(deps, { loadId: 'lod-2' }, CALLER)
    expect(second.cached).toBe(true)
    expect(history.size).toBe(1)
  })

  it('falls back to a one-day estimate with a reason when Routes and Directions both refuse', async () => {
    const { deps, history, fetchMock } = makeDeps({ 'lod-1': stops() })
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('routes.googleapis.com')
        ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify({ status: 'REQUEST_DENIED' }), { status: 200 }),
    )
    const out = await getLoadRoute(deps, { loadId: 'lod-1' }, CALLER)
    expect(out.source).toBe('ESTIMATE')
    expect(out.reason).toMatch(/403/)
    expect(decodePolyline(out.encoded as string)).toHaveLength(2)
    expect([...history.values()][0].ttlEpoch).toBe(NOW_SEC + 86_400)
  })

  it('uses the legacy Directions API when Routes is refused but Directions answers', async () => {
    const { deps, fetchMock } = makeDeps({ 'lod-1': stops() })
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('routes.googleapis.com')
        ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify({
            status: 'OK',
            routes: [{ overview_polyline: { points: '_p~iF~ps|U_ulLnnqC' }, legs: [{ distance: { value: 1000 }, duration: { value: 60 } }] }],
          }), { status: 200 }),
    )
    const out = await getLoadRoute(deps, { loadId: 'lod-1' }, CALLER)
    expect(out).toMatchObject({ source: 'DIRECTIONS_LEGACY', meters: 1000, seconds: 60 })
  })

  it('returns an estimate without calling Google when no key is set', async () => {
    const { deps, fetchMock } = makeDeps({ 'lod-1': stops() }, { apiKey: '' })
    const out = await getLoadRoute(deps, { loadId: 'lod-1' }, CALLER)
    expect(out.source).toBe('ESTIMATE')
    expect(out.reason).toMatch(/key/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never throws on a network error', async () => {
    const { deps, fetchMock } = makeDeps({ 'lod-1': stops() })
    fetchMock.mockRejectedValue(new Error('socket hang up'))
    const out = await getLoadRoute(deps, { loadId: 'lod-1' }, CALLER)
    expect(out.source).toBe('ESTIMATE')
  })

  it('geocodes a stop that has an address but no coordinates, and gives up as NONE when it cannot', async () => {
    const loads = { 'lod-1': stops([{}, { address: { street: '1 Main St', city: 'Toledo', state: 'OH' } }]) }
    const hit = makeDeps(loads, { apiKey: '' })
    ;(hit.deps.geocodeAddress as ReturnType<typeof vi.fn>).mockResolvedValue({ lat: 41.65, lng: -83.53 })
    const placed = await getLoadRoute(hit.deps, { loadId: 'lod-1' }, CALLER)
    expect(placed.source).toBe('ESTIMATE')
    expect(hit.deps.geocodeAddress).toHaveBeenCalledTimes(1)

    const miss = makeDeps(loads)
    const lost = await getLoadRoute(miss.deps, { loadId: 'lod-1' }, CALLER)
    expect(lost).toMatchObject({ source: 'NONE', encoded: null, reason: 'Delivery address has no coordinates' })
    expect(miss.history.size).toBe(0)
  })

  it('lane key ignores sub-kilometre differences', () => {
    expect(routeLaneKey([{ lat: 41.5241, lng: -88.0811 }])).toBe(routeLaneKey([{ lat: 41.5249, lng: -88.0809 }]))
    expect(routeLaneKey([{ lat: 41.5251, lng: -88.0811 }])).not.toBe(routeLaneKey([{ lat: 41.6, lng: -88.0811 }]))
  })
})
