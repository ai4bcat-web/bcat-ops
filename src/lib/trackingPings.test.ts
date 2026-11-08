import { describe, expect, it } from 'vitest'
import {
  currentFix, fixOfRow, mergeFixes, pingRow, remainingMiles, resolveFixAt, routeKeyOf, sourceLabel, thinFixes, trustRank,
  type TrackingFix,
} from './trackingPings'

const NOW = Date.parse('2026-11-04T15:00:00.000Z')
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()

function fix(at: string, over: Partial<TrackingFix> = {}): TrackingFix {
  return { at, lat: 41.5, lng: -88.1, source: 'link', accuracyM: 20, approx: false, speedMph: null, headingDeg: null, place: null, ...over }
}

describe('pingRow / fixOfRow', () => {
  const base = { loadId: 'L1', at: '2026-11-04T14:00:00.000Z', lat: 41.5, lng: -88.1, source: 'link' as const, nowIso: '2026-11-04T14:00:05.000Z' }

  it('keys the row by load, sorts by the fix and expires 90 days after the fix', () => {
    const row = pingRow({ ...base, accuracyM: 12.6, speedMph: 55 })
    expect(row.truckId).toBe('load:L1')
    expect(row.locatedAt).toBe('2026-11-04T14:00:00.000Z')
    expect(row.ttlEpoch).toBe(Date.parse('2026-11-04T14:00:00.000Z') / 1000 + 90 * 86_400)
    expect(row.accuracyM).toBe(13)
    expect(row.unitNumber).toBe('LOAD')
  })

  it('round-trips through fixOfRow', () => {
    const got = fixOfRow(pingRow({ ...base, approx: true, place: 'Gary, IN', source: 'sms-geocode', accuracyM: 5000 }))
    expect(got).toMatchObject({ source: 'sms-geocode', approx: true, place: 'Gary, IN', accuracyM: 5000, lat: 41.5, lng: -88.1 })
  })

  it('refuses to file an unusable fix', () => {
    expect(() => pingRow({ ...base, lat: 95 })).toThrow()
    expect(() => pingRow({ ...base, at: 'nope' })).toThrow()
  })

  it('reads a Motive-shaped row and rejects malformed, route and unknown-source rows', () => {
    const motive = { truckId: 't1', locatedAt: '2026-11-04T14:00:00.000Z', lat: 41.5, lon: -88.1, source: 'motive', speed: 30, description: 'Joliet, IL' }
    expect(fixOfRow(motive)).toMatchObject({ source: 'motive', speedMph: 30, place: 'Joliet, IL', approx: false, accuracyM: null })
    expect(fixOfRow({ ...motive, lat: Number.NaN })).toBeNull()
    expect(fixOfRow({ ...motive, lat: undefined })).toBeNull()
    expect(fixOfRow({ ...motive, lon: 181 })).toBeNull()
    expect(fixOfRow({ ...motive, locatedAt: 'x' })).toBeNull()
    expect(fixOfRow({ ...motive, source: 'weird' })).toBeNull()
    expect(fixOfRow({ ...motive, truckId: 'route:abc', source: 'routes-api' })).toBeNull()
  })
})

describe('resolveFixAt', () => {
  const now = '2026-11-04T15:00:00.000Z'
  it('trusts a plausible device clock and replaces a wrong one with server time', () => {
    expect(resolveFixAt('2026-11-04T14:56:00.000Z', now)).toBe('2026-11-04T14:56:00.000Z')
    expect(resolveFixAt('2026-11-04T14:30:00.000Z', now)).toBe(now)
    expect(resolveFixAt('2026-11-04T15:10:00.000Z', now)).toBe(now)
    expect(resolveFixAt(undefined, now)).toBe(now)
  })
})

describe('currentFix', () => {
  it('newest fix wins', () => {
    const cur = currentFix([fix(minutesAgo(30), { lat: 40 }), fix(minutesAgo(5), { lat: 41 })], NOW)
    expect(cur?.fix.lat).toBe(41)
    expect(cur?.overlay).toBeNull()
  })

  it('a newer approximate fix does not replace a 3-hour-old precise one', () => {
    const precise = fix(minutesAgo(180), { lat: 41 })
    const approx = fix(minutesAgo(10), { lat: 42, approx: true, source: 'sms-geocode' })
    const cur = currentFix([precise, approx], NOW)
    expect(cur?.fix).toBe(precise)
    expect(cur?.overlay).toBe(approx)
    expect(cur?.ageMinutes).toBe(180)
  })

  it('but does replace a 5-hour-old one', () => {
    const approx = fix(minutesAgo(10), { approx: true, source: 'sms-geocode' })
    const cur = currentFix([fix(minutesAgo(300)), approx], NOW)
    expect(cur?.fix).toBe(approx)
    expect(cur?.overlay).toBeNull()
  })

  it.each([[14, 'fresh'], [16, 'aging'], [61, 'stale']] as const)('tone at %i minutes is %s', (m, tone) => {
    expect(currentFix([fix(minutesAgo(m))], NOW)?.tone).toBe(tone)
  })

  it('reports the jump from the previous fix only when it was reported within 30 minutes', () => {
    const near = currentFix([fix(minutesAgo(20), { lat: 41, lng: -88 }), fix(minutesAgo(5), { lat: 34, lng: -118 })], NOW)
    expect(near?.jumpMiles).toBeGreaterThan(1500)
    const far = currentFix([fix(minutesAgo(120), { lat: 41, lng: -88 }), fix(minutesAgo(5), { lat: 34, lng: -118 })], NOW)
    expect(far?.jumpMiles).toBeNull()
  })

  it('is null with no fixes', () => {
    expect(currentFix([], NOW)).toBeNull()
  })
})

describe('mergeFixes / thinFixes', () => {
  it('collapses same-source fixes under a second apart but keeps cross-source ones', () => {
    const a = fix('2026-11-04T14:00:00.000Z')
    const dup = fix('2026-11-04T14:00:00.400Z')
    const other = fix('2026-11-04T14:00:00.200Z', { source: 'motive' })
    const merged = mergeFixes([dup, a], [other])
    expect(merged.map((f) => f.source)).toEqual(['link', 'motive'])
    expect(merged[0].at).toBe(a.at)
  })

  it('thins to the gap, caps the count and always keeps both ends', () => {
    const fixes = Array.from({ length: 100 }, (_, i) => fix(new Date(NOW - (100 - i) * 60_000).toISOString(), { lat: 40 + i / 100 }))
    const thin = thinFixes(fixes, 10, 6)
    expect(thin.length).toBeLessThanOrEqual(6)
    expect(thin[0]).toBe(fixes[0])
    expect(thin[thin.length - 1]).toBe(fixes[99])
    const gap = thinFixes(fixes, 10, 150)
    for (let i = 1; i < gap.length - 1; i++) {
      expect(Date.parse(gap[i].at) - Date.parse(gap[i - 1].at)).toBeGreaterThanOrEqual(10 * 60_000)
    }
    expect(gap[gap.length - 1]).toBe(fixes[99])
  })
})

describe('remainingMiles', () => {
  const path = [{ lat: 41.5, lng: -88.0 }, { lat: 41.5, lng: -87.0 }, { lat: 41.5, lng: -86.0 }]
  it('measures along the route from the nearest point', () => {
    const left = remainingMiles(path, { lat: 41.5, lng: -87.5 })
    // 1.5 degrees of longitude at 41.5N is ~77 miles.
    expect(left).toBeGreaterThan(70)
    expect(left).toBeLessThan(85)
  })
  it('is null when the point is 40 miles off the route', () => {
    expect(remainingMiles(path, { lat: 42.1, lng: -87.0 })).toBeNull()
  })
  it('is null without a route', () => {
    expect(remainingMiles([], { lat: 41, lng: -88 })).toBeNull()
  })
})

describe('labels, rank, route key', () => {
  it('names and ranks a provider source', () => {
    expect(sourceLabel('provider:macropoint')).toBe('MacroPoint')
    expect(sourceLabel('link')).toBe('Driver phone (link)')
    expect(trustRank('provider:macropoint', false)).toBe(90)
    expect(trustRank('motive', false)).toBeGreaterThan(trustRank('provider:macropoint', false))
    expect(trustRank('link', true)).toBe(10)
  })
  it('rounds the lane key to 0.01 degrees so neighbouring loads share a route', () => {
    expect(routeKeyOf([{ lat: 41.5251, lng: -88.0817 }, { lat: 41.6528, lng: -83.5379 }])).toBe('41.53,-88.08|41.65,-83.54')
    expect(routeKeyOf([{ lat: 41.5210, lng: -88.0817 }])).toBe(routeKeyOf([{ lat: 41.5240, lng: -88.0783 }]))
  })
})
