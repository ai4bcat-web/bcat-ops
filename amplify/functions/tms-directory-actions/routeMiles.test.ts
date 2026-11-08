import { describe, it, expect } from 'vitest'
import { parsePoints, routeMiles, ROAD_FACTOR } from './routeMiles'

const CHI = { lat: 41.8781, lng: -87.6298 }
const DAN = { lat: 40.1245, lng: -87.6300 }
const meters = (miles: number) => miles * 1609.344
const okBody = (miles: number) => ({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: meters(miles) } }] }] })

describe('routeMiles', () => {
  it('sums Distance Matrix legs and labels the result google', async () => {
    const urls: string[] = []
    const r = await routeMiles(
      [{ address: 'A, IL' }, { address: 'B, IL' }, { address: 'C, IN' }],
      { apiKey: 'k', fetchJson: async (u) => { urls.push(u); return okBody(urls.length === 1 ? 100 : 50.4) } },
    )
    expect(r).toMatchObject({ miles: 150, source: 'google' })
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('units=imperial')
  })

  it('without a key estimates from coordinates with the road factor and says estimate', async () => {
    const r = await routeMiles([CHI, DAN], { apiKey: '', fetchJson: async () => { throw new Error('must not call') } })
    expect(r.source).toBe('estimate')
    // ~121 straight-line miles x 1.2
    expect(r.miles).toBeGreaterThan(Math.round(115 * ROAD_FACTOR))
    expect(r.miles).toBeLessThan(Math.round(127 * ROAD_FACTOR))
  })

  it('falls back per leg when Google refuses one, and the total is then an estimate', async () => {
    let n = 0
    const r = await routeMiles(
      [{ address: 'A', ...CHI }, { address: 'B', ...DAN }, { address: 'C', ...CHI }],
      { apiKey: 'k', fetchJson: async () => (++n === 1 ? okBody(100) : { status: 'REQUEST_DENIED' }) },
    )
    expect(r.legs.map((l) => l?.source)).toEqual(['google', 'estimate'])
    expect(r.source).toBe('estimate')
  })

  it('returns null, never zero, when a leg cannot be measured at all', async () => {
    const r = await routeMiles([{ address: 'A' }, { address: 'B' }], { apiKey: 'k', fetchJson: async () => ({ status: 'ZERO_RESULTS' }) })
    expect(r).toMatchObject({ miles: null, source: null })
  })

  it('treats a thrown fetch as a failed leg', async () => {
    const r = await routeMiles([{ address: 'A', ...CHI }, { address: 'B', ...DAN }], { apiKey: 'k', fetchJson: async () => { throw new Error('net') } })
    expect(r.source).toBe('estimate')
  })
})

describe('parsePoints', () => {
  it('rejects fewer than two stops, too many stops and non-objects; drops half coordinates', () => {
    expect(() => parsePoints([{ address: 'A' }])).toThrow(/two stops/)
    expect(() => parsePoints(Array.from({ length: 13 }, () => ({ address: 'x' })))).toThrow(/At most/)
    expect(() => parsePoints(['x', 'y'])).toThrow(/must be an object/)
    expect(parsePoints([{ address: ' A ', lat: 10 }, { lat: 999, lng: 5 }])).toEqual([{ address: 'A' }, {}])
  })
})
