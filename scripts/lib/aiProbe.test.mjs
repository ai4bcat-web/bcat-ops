import { describe, it, expect } from 'vitest'
import { percentile, expectedSums, forbiddenSlots, scanForbidden, AMOUNTS, SLOTS, VISIBLE, money, kpiValue, canonical } from './aiProbe.mjs'

describe('percentile', () => {
  it('is nearest-rank: p95 of five runs is the slowest, p50 the middle', () => {
    expect(percentile([900, 100, 500, 300, 700], 95)).toBe(900)
    expect(percentile([900, 100, 500, 300, 700], 50)).toBe(500)
  })
  it('ignores non-numbers and is NaN with nothing to rank', () => {
    expect(percentile([null, undefined, 4], 50)).toBe(4)
    expect(percentile([], 95)).toBeNaN()
  })
})

describe('fixture arithmetic', () => {
  it('every subset of the five amounts sums to a distinct number, so a total names its contributors', () => {
    const sums = new Set()
    for (let mask = 0; mask < 1 << SLOTS.length; mask++) {
      sums.add(SLOTS.reduce((a, s, i) => a + (mask & (1 << i) ? AMOUNTS[s] : 0), 0))
    }
    expect(sums.size).toBe(1 << SLOTS.length)
  })

  it('a viewer who sees nothing gets nulls and zero counts, not zeros that look like data', () => {
    expect(expectedSums('none')).toMatchObject({ revenue: null, arOpen: null, quoteOpenValue: null, samples: 0, shipments: 0, quotes: 0 })
  })

  it('the direct-rep viewer reaches C3 only through the rep field in samples/shipments/quotes and through the shipment join in AR', () => {
    const e = expectedSums('repb')
    expect(e.revenue).toBe(AMOUNTS.C3D)
    expect(e.arOpen).toBe(AMOUNTS.C3)
    expect(e.quoteOpenValue).toBe(AMOUNTS.C3D)
    expect(forbiddenSlots('repb')).toEqual(['C1', 'C2', 'C4'])
  })

  it('a viewAll persona sees every slot and has nothing forbidden', () => {
    expect(expectedSums('all').revenue).toBe(3_100_000)
    expect(expectedSums('all').arOpen).toBe(1_500_000)
    expect(forbiddenSlots('all')).toEqual([])
  })

  it('no persona\'s own cost or profit lands on a number forbidden to that persona (the scanner cannot false-positive)', () => {
    for (const persona of ['repa', 'tm', 'repb']) {
      const own = Object.values(expectedSums(persona)).filter((v) => typeof v === 'number')
      const banned = forbiddenSlots(persona).map((s) => AMOUNTS[s])
      expect(own.filter((v) => banned.includes(v)), persona).toEqual([])
    }
    expect(Object.keys(VISIBLE)).toContain('all')
  })
})

describe('scanForbidden', () => {
  const forbidden = { names: ['ZZ AI Hidden C3'], ids: ['cus-c3'], cents: [AMOUNTS.C3] }

  it('finds a hidden customer name, id, raw amount and money text anywhere in the result', () => {
    const leaky = { results: [{ series: { rows: [{ label: 'ZZ AI Hidden C3 123', values: [400000], text: ['$4,000.00', 'cus-c3-x'] }] } }] }
    expect(scanForbidden(leaky, forbidden).sort()).toEqual(['id cus-c3', 'money 400000', 'name "ZZ AI Hidden C3"', 'number 400000'])
  })

  it('stays silent on a clean result', () => {
    const clean = { results: [{ series: { rows: [{ label: 'ZZ AI Own C1', values: [100000], text: ['$1,000.00'] }] } }] }
    expect(scanForbidden(clean, forbidden)).toEqual([])
  })
})

describe('result readers', () => {
  const results = [{ widgetId: 'w1', ok: true, series: { kpis: [{ label: 'Revenue', value: 5 }] } }, { widgetId: 'w2', ok: false, error: 'x' }]
  it('reads a KPI by label and reports a failed widget as undefined', () => {
    expect(kpiValue(results, 'w1', 'Revenue')).toBe(5)
    expect(kpiValue(results, 'w2', 'Revenue')).toBeUndefined()
  })
  it('canonical JSON ignores key order, and money text matches the executor format', () => {
    expect(canonical({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonical({ a: [{ c: 2, d: 1 }], b: 1 }))
    expect(money(1_600_000)).toBe('$16,000.00')
  })
})
