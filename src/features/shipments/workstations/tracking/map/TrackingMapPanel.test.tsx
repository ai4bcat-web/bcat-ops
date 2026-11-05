// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { encodePolyline } from '@/lib/polyline'
import { currentFix, type TrackingFix } from '@/lib/trackingPings'
import type { LoadTracking } from '@/hooks/useLoadTracking'
import type { LoadCarrierRecord, ShipmentBundle, ShipmentLoad, ShipmentRecord, TrackingLinkRecord } from '@/types/tms'
import type { TrackingSummary } from '../trackingSummary'
import { etaText } from '../trackingSummary'
import { MAP_COLLAPSED_KEY, TrackingMapPanel } from './TrackingMapPanel'

const getLoadRoute = vi.hoisted(() => vi.fn())
const startProviderTracking = vi.hoisted(() => vi.fn(async () => ({ link: {}, mode: 'STUB', message: 'STUB — A live MacroPoint connection would have started tracking.' })))
const stopProviderTracking = vi.hoisted(() => vi.fn(async () => ({ link: {} })))
vi.mock('@/lib/apiClient', () => ({ getLoadRoute, startProviderTracking, stopProviderTracking }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// The Google chunk is replaced by a probe: loading it at all is what the no-key test forbids.
const googleLoaded = vi.hoisted(() => vi.fn())
vi.mock('./TrackingRouteMap', () => {
  googleLoaded()
  return {
    default: ({ onAuthFailure }: { onAuthFailure: () => void }) => (
      <button type="button" data-testid="fake-google" onClick={onAuthFailure}>google</button>
    ),
  }
})

const NOW = Date.parse('2026-11-04T18:00:00.000Z')
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

const fix = (over: Partial<TrackingFix> & { at: string }): TrackingFix => ({
  lat: 41.5, lng: -88.1, source: 'link', accuracyM: 20, approx: false, speedMph: null, headingDeg: null, place: 'Joliet, IL', ...over,
})

const load = {
  id: 'L1', shipmentId: 'S1', status: 'IN_TRANSIT',
  stops: [
    { id: 'a', type: 'pickup', sequence: 0, name: 'Shipper', address: { lat: 41.5, lng: -88.0 }, appt: '', driverId: null },
    { id: 'b', type: 'delivery', sequence: 1, name: 'Consignee', address: { lat: 32.8, lng: -96.8 }, appt: '', driverId: null },
  ],
} as unknown as ShipmentLoad
const leg = { id: 'C1', loadId: 'L1', shipmentId: 'S1', kind: 'CARRIER', status: 'ACTIVE' } as LoadCarrierRecord
const bundle = { shipment: { id: 'S1' } as ShipmentRecord, orders: [], loads: [load], loadCarriers: [leg], charges: [], financials: [], documents: [] } as unknown as ShipmentBundle

const ETA = { at: '2026-11-04T23:00:00.000Z', estimated: true, lateMinutes: null }
const summary = { eta: ETA } as unknown as TrackingSummary

function trackingOf(fixes: TrackingFix[]): LoadTracking {
  return { fixes, current: currentFix(fixes, NOW), nowMs: NOW, links: [] } as unknown as LoadTracking
}

function renderPanel(over: { fixes?: TrackingFix[]; links?: TrackingLinkRecord[]; b?: ShipmentBundle } = {}) {
  const fixes = over.fixes ?? [fix({ at: minAgo(14) })]
  return render(
    <TrackingMapPanel bundle={over.b ?? bundle} tracking={trackingOf(fixes)} summary={summary} links={over.links ?? []} onProviderChanged={vi.fn()} />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '')
  getLoadRoute.mockResolvedValue({
    encoded: encodePolyline([{ lat: 41.5, lng: -88.0 }, { lat: 32.8, lng: -96.8 }]), meters: 1, seconds: 1,
    source: 'ROUTES_API', cached: true, fetchedAt: null, waypoints: [], reason: null,
  })
})
afterEach(() => { cleanup(); vi.unstubAllEnvs() })

describe('TrackingMapPanel', () => {
  it('with no browser key draws the outline and never requests the Google chunk', async () => {
    renderPanel()
    const map = await screen.findByTestId('tracking-map')
    expect(map).toHaveAttribute('data-mode', 'fallback')
    expect(screen.getByTestId('tracking-map-caption')).toHaveTextContent('Google map not configured — showing outline')
    expect(googleLoaded).not.toHaveBeenCalled()
    expect(map).toHaveAttribute('data-current-source', 'link')
    await waitFor(() => expect(screen.getByTestId('tracking-map-route')).toBeInTheDocument())
  })

  it('falls back to the outline with a caption when Google rejects the key', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key-not-real')
    renderPanel()
    const probe = await screen.findByTestId('fake-google')
    expect(screen.getByTestId('tracking-map')).toHaveAttribute('data-mode', 'google')
    fireEvent.click(probe)
    await waitFor(() => expect(screen.getByTestId('tracking-map')).toHaveAttribute('data-mode', 'fallback'))
    expect(screen.getByTestId('tracking-map-caption')).toHaveTextContent('Google rejected the map key or could not load — showing outline')
  })

  it('remembers a collapsed panel across remounts and mounts no map while collapsed', async () => {
    const first = renderPanel()
    await screen.findByTestId('tracking-map')
    fireEvent.click(screen.getByTestId('tracking-map-toggle'))
    expect(screen.queryByTestId('tracking-map')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(MAP_COLLAPSED_KEY)).toBe('1')
    first.unmount()

    getLoadRoute.mockClear()
    renderPanel()
    expect(screen.getByTestId('tracking-map-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('tracking-map')).not.toBeInTheDocument()
    expect(getLoadRoute).not.toHaveBeenCalled()
    expect(googleLoaded).not.toHaveBeenCalled()
  })

  it('reads "place · age · source" and repeats the strip\'s own ETA text', async () => {
    renderPanel()
    expect(screen.getByTestId('tracking-map-current')).toHaveTextContent('Joliet, IL · 14 min ago · Driver phone (link)')
    expect(screen.getByTestId('tracking-map-eta')).toHaveTextContent(`ETA ${etaText(ETA)}`)
    expect(screen.getByTestId('tracking-map-current')).toHaveAttribute('data-tone', 'fresh')
  })

  it('goes stale after an hour and says so', async () => {
    renderPanel({ fixes: [fix({ at: minAgo(61) })] })
    const head = screen.getByTestId('tracking-map-current')
    expect(head).toHaveAttribute('data-tone', 'stale')
    expect(head).toHaveTextContent('stale')
  })

  it('shows the approximate badge only when a newer approximate fix sits beside a precise one', async () => {
    const { unmount } = renderPanel()
    expect(screen.queryByTestId('tracking-map-approx')).not.toBeInTheDocument()
    unmount()
    renderPanel({ fixes: [fix({ at: minAgo(120) }), fix({ at: minAgo(5), source: 'sms-geocode', approx: true, accuracyM: 9000, place: 'Gary, IN', lat: 41.6, lng: -87.3 })] })
    expect(screen.getByTestId('tracking-map-approx')).toBeInTheDocument()
    // The marker stays on the precise fix.
    expect(screen.getByTestId('tracking-map-current')).toHaveTextContent('Joliet, IL')
  })

  it('says there is no position instead of drawing an empty map', async () => {
    renderPanel({ fixes: [], b: { ...bundle, loads: [{ ...load, stops: [] } as ShipmentLoad] } })
    expect(await screen.findByTestId('tracking-map-empty')).toHaveTextContent('No position yet')
  })

  it('offers to start a tracking provider on a brokered leg, as STUB, and calls the API', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('tracking-map-menu'))
    const start = await screen.findByTestId('provider-start-MACROPOINT')
    expect(start).toHaveTextContent(/^Start .*tracking \(STUB\)$/)
    fireEvent.click(start)
    await waitFor(() => expect(startProviderTracking).toHaveBeenCalledWith({ loadCarrierId: 'C1', provider: 'MACROPOINT' }))
  })

  it('shows the STUB badge and a Stop action while a provider subscription is active', async () => {
    const link = { id: 'T1', kind: 'PROVIDER_TRACK', status: 'ACTIVE', provider: 'MACROPOINT' } as TrackingLinkRecord
    renderPanel({ links: [link] })
    expect(screen.getByTestId('tracking-map-provider')).toHaveTextContent('· STUB')
    fireEvent.click(screen.getByTestId('tracking-map-menu'))
    fireEvent.click(screen.getByTestId('provider-stop'))
    await waitFor(() => expect(stopProviderTracking).toHaveBeenCalledWith({ linkId: 'T1' }))
  })

  it('offers no provider menu on an own-fleet leg (the ELD is the source there)', () => {
    renderPanel({ b: { ...bundle, loadCarriers: [{ ...leg, kind: 'OWN_ASSET' } as LoadCarrierRecord] } })
    expect(screen.queryByTestId('tracking-map-menu')).not.toBeInTheDocument()
  })
})
