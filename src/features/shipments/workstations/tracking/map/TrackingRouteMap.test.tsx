// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { encodePolyline } from '@/lib/polyline'
import { currentFix, type TrackingFix } from '@/lib/trackingPings'
import { buildMapModel } from './mapModel'

const polylines = vi.hoisted(() => [] as Array<{ opts: { path: unknown[]; strokeOpacity: number }; setMap: ReturnType<typeof vi.fn> }>)
const circles = vi.hoisted(() => [] as Array<{ opts: { radius: number } }>)

// The Maps library is replaced: what is under test is what we ask it to draw.
vi.mock('@vis.gl/react-google-maps', () => {
  class Polyline {
    opts: { path: unknown[]; strokeOpacity: number }
    setMap = vi.fn()
    constructor(opts: { path: unknown[]; strokeOpacity: number }) { this.opts = opts; polylines.push(this) }
  }
  class Circle { opts: { radius: number }; setMap = vi.fn(); constructor(opts: { radius: number }) { this.opts = opts; circles.push(this) } }
  const lib = { Polyline, Circle }
  const map = { fitBounds: vi.fn(), setCenter: vi.fn(), setZoom: vi.fn() }
  return {
    APIProvider: ({ children, onError }: { children: ReactNode; onError?: (e: unknown) => void }) => <div data-testid="api" onClick={() => onError?.(new Error('script'))}>{children}</div>,
    Map: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    AdvancedMarker: ({ children, title }: { children: ReactNode; title?: string }) => <div data-testid="marker" title={title}>{children}</div>,
    useMap: () => map,
    useMapsLibrary: () => lib,
  }
})

const { default: TrackingRouteMap } = await import('./TrackingRouteMap')

const NOW = Date.parse('2026-11-04T18:00:00.000Z')
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const fix = (m: number, over: Partial<TrackingFix> = {}): TrackingFix => ({
  at: minAgo(m), lat: 41.5 - m / 100, lng: -88.1, source: 'link', accuracyM: 20, approx: false, speedMph: null, headingDeg: null, place: 'Joliet, IL', ...over,
})

afterEach(() => { cleanup(); polylines.length = 0; circles.length = 0 })

describe('TrackingRouteMap (Google branch)', () => {
  it('draws one marker per thinned breadcrumb, a pin per stop, the current marker, and a polyline of the decoded route', () => {
    const fixes = [fix(120), fix(60), fix(30), fix(2)]
    const route = encodePolyline([{ lat: 41.5, lng: -88.0 }, { lat: 36, lng: -92 }, { lat: 32.8, lng: -96.8 }])
    const model = buildMapModel({
      mode: 'staff', fixes, current: currentFix(fixes, NOW), route, routeSource: 'ROUTES_API', nowMs: NOW,
      pins: [{ type: 'pickup', lat: 41.5, lng: -88.0 }, { type: 'delivery', lat: 32.8, lng: -96.8 }],
    })
    render(<TrackingRouteMap apiKey="k" mapId="m" model={model} fitKey="L1" recenter={0} onAuthFailure={vi.fn()} />)

    expect(screen.getAllByTestId('tracking-map-dot')).toHaveLength(model.dots.length)
    expect(screen.getByTestId('tracking-map-pin-pickup')).toBeInTheDocument()
    expect(screen.getByTestId('tracking-map-pin-delivery')).toBeInTheDocument()
    expect(screen.getByTestId('tracking-map-current-marker')).toBeInTheDocument()
    expect(polylines).toHaveLength(1)
    expect(polylines[0].opts.path).toHaveLength(3)
    expect(polylines[0].opts.strokeOpacity).toBeGreaterThan(0)
  })

  it('draws an estimated route as a dashed (icon-repeated) stroke and an approximate fix as a circle', () => {
    const fixes = [fix(180), fix(5, { source: 'sms-geocode', approx: true, accuracyM: 12_000, lat: 41.6 })]
    const route = encodePolyline([{ lat: 41.5, lng: -88.0 }, { lat: 32.8, lng: -96.8 }])
    const model = buildMapModel({ mode: 'staff', fixes, current: currentFix(fixes, NOW), route, routeSource: 'ESTIMATE', nowMs: NOW, pins: [] })
    render(<TrackingRouteMap apiKey="k" mapId="m" model={model} fitKey="L1" recenter={0} onAuthFailure={vi.fn()} />)
    expect(polylines[0].opts.strokeOpacity).toBe(0)
    expect(circles.map((c) => c.opts.radius)).toContain(12_000)
  })

  it('reports a key refusal through window.gm_authFailure and restores the previous handler on unmount', () => {
    const onAuthFailure = vi.fn()
    const w = window as unknown as { gm_authFailure?: () => void }
    const previous = vi.fn()
    w.gm_authFailure = previous
    const model = buildMapModel({ mode: 'staff', fixes: [], current: null, route: null, routeSource: 'NONE', nowMs: NOW, pins: [] })
    const { unmount } = render(<TrackingRouteMap apiKey="k" mapId="m" model={model} fitKey="L1" recenter={0} onAuthFailure={onAuthFailure} />)
    w.gm_authFailure?.()
    expect(onAuthFailure).toHaveBeenCalledOnce()
    expect(previous).toHaveBeenCalledOnce()
    unmount()
    expect(w.gm_authFailure).toBe(previous)
  })

  it('treats a Maps script load failure like a key refusal, so the panel can draw the outline', () => {
    const onAuthFailure = vi.fn()
    const model = buildMapModel({ mode: 'staff', fixes: [], current: null, route: null, routeSource: 'NONE', nowMs: NOW, pins: [] })
    render(<TrackingRouteMap apiKey="k" mapId="m" model={model} fitKey="L1" recenter={0} onAuthFailure={onAuthFailure} />)
    fireEvent.click(screen.getByTestId('api'))
    expect(onAuthFailure).toHaveBeenCalledOnce()
  })
})
