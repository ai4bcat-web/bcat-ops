// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { TrackingFix } from '@/lib/trackingPings'

const NOW = Date.parse('2026-11-04T15:00:00.000Z')
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()

const api = vi.hoisted(() => ({
  listCheckCallsByLoad: vi.fn(),
  listTrackingLinksByShipment: vi.fn(),
  listTruckPositions: vi.fn(),
  listLoadBreadcrumbs: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)

import { useLoadTracking } from './useLoadTracking'

function ping(at: string, over: Partial<TrackingFix> = {}): TrackingFix {
  return { at, lat: 41.5, lng: -88.1, source: 'link', accuracyM: 20, approx: false, speedMph: null, headingDeg: null, place: null, ...over }
}
const motiveRow = (at: string) => ({ truckId: 't1', unitNumber: '9', lat: 41.4, lon: -88.2, bearing: null, speed: 0, locatedAt: at, description: 'Joliet, IL', source: 'motive', syncedAt: at })

const base = {
  loadId: 'L1', shipmentId: 'S1', truckId: 't1',
  load: { pickupAppt: minutesAgo(600), deliveredAt: null },
  loadCarrier: { dispatchedAt: minutesAgo(700) },
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  Object.values(api).forEach((f) => f.mockReset())
  api.listCheckCallsByLoad.mockResolvedValue([])
  api.listTrackingLinksByShipment.mockResolvedValue([])
  api.listTruckPositions.mockResolvedValue([])
  api.listLoadBreadcrumbs.mockResolvedValue([])
})

describe('useLoadTracking breadcrumbs', () => {
  it('reads the whole window first, then only rows newer than the last one seen', async () => {
    api.listLoadBreadcrumbs.mockResolvedValueOnce([ping(minutesAgo(30)), ping(minutesAgo(20))])
    const { result } = renderHook(() => useLoadTracking(base))
    await waitFor(() => expect(result.current.fixes).toHaveLength(2))
    const first = api.listLoadBreadcrumbs.mock.calls[0]
    expect(Date.parse(first[1])).toBeLessThanOrEqual(NOW - 600 * 60_000)

    api.listLoadBreadcrumbs.mockResolvedValueOnce([ping(minutesAgo(20)), ping(minutesAgo(5))])
    await act(async () => { await result.current.refresh() })
    const second = api.listLoadBreadcrumbs.mock.calls[1]
    // Newer than the newest row seen (20 min ago), less the small index-lag overlap — not the whole window again.
    expect(Date.parse(second[1])).toBeGreaterThan(NOW - 30 * 60_000)
    expect(Date.parse(second[1])).toBeLessThanOrEqual(Date.parse(minutesAgo(20)))
    // The overlapping row is not doubled and the new one is added.
    expect(result.current.fixes.map((f) => f.at)).toEqual([minutesAgo(30), minutesAgo(20), minutesAgo(5)])
  })

  it('keeps the last good list when a breadcrumb read fails', async () => {
    api.listLoadBreadcrumbs.mockResolvedValueOnce([ping(minutesAgo(10))])
    const { result } = renderHook(() => useLoadTracking(base))
    await waitFor(() => expect(result.current.fixes).toHaveLength(1))
    api.listLoadBreadcrumbs.mockRejectedValueOnce(new Error('throttled'))
    await act(async () => { await result.current.refresh() })
    expect(result.current.fixes).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })
})

describe('useLoadTracking fixes', () => {
  it('merges ELD rows by the leg truck with the load pings; the newest is current', async () => {
    api.listTruckPositions.mockResolvedValue([motiveRow(minutesAgo(40)), motiveRow(minutesAgo(30))])
    api.listLoadBreadcrumbs.mockResolvedValue([ping(minutesAgo(8))])
    const { result } = renderHook(() => useLoadTracking(base))
    await waitFor(() => expect(result.current.fixes).toHaveLength(3))
    expect(result.current.fixes.map((f) => f.source)).toEqual(['motive', 'motive', 'link'])
    expect(result.current.current?.fix.source).toBe('link')
    expect(result.current.current?.tone).toBe('fresh')
    // The strip hears about the breadcrumb even though no check call exists for it.
    expect(result.current.lastKnown).toMatchObject({ source: 'LINK', pingSource: 'link', at: minutesAgo(8) })
  })

  it('falls back to Load.lastKnown* only when nothing else has reported', async () => {
    const lastKnown = { lastKnownAt: minutesAgo(90), lastKnownLat: 41.7, lastKnownLng: -87.9, lastKnownCity: 'Gary', lastKnownState: 'IN', lastKnownSource: 'MANUAL' as const }
    const { result } = renderHook(() => useLoadTracking({ ...base, load: { ...base.load, ...lastKnown } }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.fixes).toHaveLength(1)
    expect(result.current.current?.fix).toMatchObject({ place: 'Gary, IN', source: 'manual' })
    expect(result.current.current?.tone).toBe('stale')

    api.listLoadBreadcrumbs.mockResolvedValue([ping(minutesAgo(5))])
    await act(async () => { await result.current.refresh() })
    expect(result.current.fixes).toHaveLength(1)
    expect(result.current.fixes[0].source).toBe('link')
  })

  it('reads nothing without a load', async () => {
    const { result } = renderHook(() => useLoadTracking({ ...base, loadId: null }))
    expect(result.current.fixes).toEqual([])
    expect(result.current.current).toBeNull()
    expect(api.listLoadBreadcrumbs).not.toHaveBeenCalled()
  })
})
