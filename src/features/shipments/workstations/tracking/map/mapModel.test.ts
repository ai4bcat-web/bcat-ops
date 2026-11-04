import { describe, expect, it } from 'vitest'
import { encodePolyline } from '@/lib/polyline'
import { currentFix, type TrackingFix } from '@/lib/trackingPings'
import type { CustomerTrackingView } from '@/types/tms'
import type { Stop } from '@/types'
import { buildMapModel, EMPTY_NO_POSITION, pinsOfStops, publicModelInput, type MapModelInput } from './mapModel'

const NOW = Date.parse('2026-11-04T18:00:00.000Z')
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

const fix = (over: Partial<TrackingFix> & { at: string }): TrackingFix => ({
  lat: 41.5, lng: -88.1, source: 'link', accuracyM: 20, approx: false, speedMph: null, headingDeg: null, place: 'Joliet, IL', ...over,
})

function input(fixes: TrackingFix[], over: Partial<MapModelInput> = {}): MapModelInput {
  return { mode: 'staff', pins: [], fixes, current: currentFix(fixes, NOW), route: null, routeSource: 'NONE', nowMs: NOW, ...over }
}

describe('buildMapModel', () => {
  it('thins breadcrumb dots to at most 150, at least 10 minutes apart, keeping the ends', () => {
    // 1 fix a minute for 12 hours.
    const fixes = Array.from({ length: 720 }, (_, i) => fix({ at: minAgo(720 - i), lat: 40 + i * 0.001 }))
    const { dots } = buildMapModel(input(fixes))
    expect(dots.length).toBeLessThanOrEqual(150)
    expect(dots[0].at).toBe(fixes[0].at)
    expect(dots[dots.length - 1].at).toBe(fixes[719].at)
    for (let i = 1; i < dots.length - 1; i++) {
      expect(Date.parse(dots[i].at) - Date.parse(dots[i - 1].at)).toBeGreaterThanOrEqual(10 * 60_000)
    }
  })

  it('colours the current marker by age and pulses only while fresh', () => {
    const tone = (m: number) => buildMapModel(input([fix({ at: minAgo(m) })])).current
    expect(tone(14)).toMatchObject({ tone: 'fresh', pulse: true })
    expect(tone(16)).toMatchObject({ tone: 'aging', pulse: false })
    expect(tone(61)).toMatchObject({ tone: 'stale', pulse: false })
  })

  it('names the source and age on the current marker for staff, never for the public', () => {
    const fixes = [fix({ at: minAgo(14) })]
    expect(buildMapModel(input(fixes)).current?.title).toBe('Joliet, IL · 14 min ago · Driver phone (link)')
    const pub = buildMapModel(input(fixes, { mode: 'public' }))
    expect(pub.current?.title).toBe('Last seen near Joliet, IL · 14 min ago')
    expect(pub.meta.currentSource).toBeNull()
    expect(pub.dots[0].title).toBe('')
    expect(pub.dots[0].label).toBeNull()
  })

  it('draws a newer approximate fix as a circle beside the still-fresh precise marker', () => {
    const fixes = [
      fix({ at: minAgo(180), lat: 41.5, lng: -88.1 }),
      fix({ at: minAgo(5), lat: 41.6, lng: -87.3, source: 'sms-geocode', approx: true, accuracyM: 12_000, place: 'Gary, IN' }),
    ]
    const m = buildMapModel(input(fixes))
    expect(m.current).toMatchObject({ lat: 41.5, lng: -88.1 })
    expect(m.approxCircle).toMatchObject({ lat: 41.6, lng: -87.3, radiusM: 12_000 })
    expect(m.approxCircle?.title).toContain('Driver said: near Gary, IN')
  })

  it('has no approximate circle for a precise fix', () => {
    expect(buildMapModel(input([fix({ at: minAgo(3) })])).approxCircle).toBeNull()
  })

  it('floors an approximate radius at 2 km and gives the public a fixed, claim-free radius', () => {
    const approx = fix({ at: minAgo(3), source: 'sms-geocode', approx: true, accuracyM: 500 })
    expect(buildMapModel(input([approx])).approxCircle?.radiusM).toBe(2_000)
    expect(buildMapModel(input([approx], { mode: 'public' })).approxCircle?.radiusM).toBe(8_000)
  })

  it('warns on a jump over 500 miles inside 30 minutes, and on nothing slower', () => {
    const far = [fix({ at: minAgo(20), lat: 41.5, lng: -88.1 }), fix({ at: minAgo(5), lat: 34.0, lng: -118.2 })]
    expect(buildMapModel(input(far)).current?.warn).toBe(true)
    const slow = [fix({ at: minAgo(200), lat: 41.5, lng: -88.1 }), fix({ at: minAgo(5), lat: 34.0, lng: -118.2 })]
    expect(buildMapModel(input(slow)).current?.warn).toBe(false)
  })

  it('draws a halo only for a poor accuracy', () => {
    expect(buildMapModel(input([fix({ at: minAgo(1), accuracyM: 80 })])).current?.haloM).toBeNull()
    expect(buildMapModel(input([fix({ at: minAgo(1), accuracyM: 900 })])).current?.haloM).toBe(900)
  })

  it('dashes an estimated route and says so; a road route is solid', () => {
    const route = encodePolyline([{ lat: 41.5, lng: -88.1 }, { lat: 32.8, lng: -96.8 }])
    const est = buildMapModel(input([], { route, routeSource: 'ESTIMATE' }))
    expect(est.pathStyle).toBe('dashed')
    expect(est.caption).toBe('Estimated path — no road route available')
    expect(buildMapModel(input([], { route, routeSource: 'ROUTES_API' })).pathStyle).toBe('solid')
    expect(buildMapModel(input([], { route: null, routeSource: 'NONE' })).pathStyle).toBe('none')
  })

  it('frames the current marker and the pickup and delivery pins, not the intermediate stops', () => {
    const m = buildMapModel(input([fix({ at: minAgo(2), lat: 41.5, lng: -88.1 })], {
      pins: [
        { type: 'pickup', lat: 41.5, lng: -88.0 },
        { type: 'stop', lat: 10, lng: -10 },
        { type: 'delivery', lat: 32.8, lng: -96.8 },
      ],
    }))
    expect(m.bounds).toEqual({ south: 32.8, west: -96.8, north: 41.5, east: -88.0 })
  })

  it('says why there is no map: nothing at all is an empty state; fixes without stops are captioned', () => {
    expect(buildMapModel(input([])).empty).toBe(EMPTY_NO_POSITION)
    const noStops = buildMapModel(input([fix({ at: minAgo(2) })]))
    expect(noStops.empty).toBeNull()
    expect(noStops.caption).toBe('Stop coordinates missing')
  })

  it('ignores a fix with impossible coordinates instead of drawing it', () => {
    const m = buildMapModel(input([fix({ at: minAgo(2), lat: 200 })], { current: null }))
    expect(m.dots).toEqual([])
  })
})

describe('pinsOfStops', () => {
  const stop = (sequence: number, type: Stop['type'], lat: number | null): Stop => ({
    id: `s${sequence}`, type, sequence, appt: '2026-11-04T12:00:00.000Z', driverId: null, name: `N${sequence}`,
    address: lat == null ? null : { lat, lng: -90 },
  } as unknown as Stop)

  it('marks the first pickup and the last delivery, leaves the rest as stops, skips uncoordinated ones', () => {
    const pins = pinsOfStops([stop(3, 'delivery', 30), stop(0, 'pickup', 41), stop(1, 'pickup', 40), stop(2, 'delivery', null), stop(4, 'delivery', 29)])
    expect(pins.map((p) => [p.type, p.lat])).toEqual([['pickup', 41], ['stop', 40], ['stop', 30], ['delivery', 29]])
  })
})

describe('publicModelInput', () => {
  const view = {
    position: { lat: 41.5, lng: -88.1, at: minAgo(10), description: 'Joliet, IL' },
    map: {
      stops: [{ type: 'pickup' as const, lat: 41.5, lng: -88.1 }],
      route: null,
      trail: [{ lat: 41.4, lng: -88.0, at: minAgo(90) }, { lat: 41.5, lng: -88.1, at: minAgo(10), approx: true as const }],
    },
  } as unknown as CustomerTrackingView

  it('builds the marker from the position and the dots from the trail, with no source anywhere', () => {
    const m = buildMapModel(publicModelInput(view, NOW))
    expect(m.mode).toBe('public')
    expect(m.dots).toHaveLength(2)
    expect(m.current?.title).toBe('Last seen near Joliet, IL · 10 min ago')
    expect(m.meta.currentSource).toBeNull()
    expect(JSON.stringify(m)).not.toMatch(/Driver phone|Motive|accuracy/i)
  })

  it('still draws the marker when the trail is absent', () => {
    const { map: _gone, ...bare } = view
    const m = buildMapModel(publicModelInput(bare as CustomerTrackingView, NOW))
    expect(m.current).not.toBeNull()
    expect(m.dots).toHaveLength(1)
  })
})
