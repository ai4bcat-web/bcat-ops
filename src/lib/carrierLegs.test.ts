import { describe, it, expect } from 'vitest'
import { carrierPhase, coveringCarrier, legStopsOf, validateCarrierAdd, validateLegs } from './carrierLegs'
import type { LegStop } from './carrierLegs'

const stop = (id: string, sequence: number, over: Partial<LegStop> = {}): LegStop => ({ id, sequence, ...over })
const stops = [stop('s1', 0), stop('s2', 1), stop('s3', 2)]
const lc = (id: string, legStopIds?: string[]) => ({ id, legStopIds })

describe('legStopsOf', () => {
  it('treats empty or absent legs as every stop, in route order', () => {
    expect(legStopsOf(lc('a'), [stops[2], stops[0], stops[1]]).map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(legStopsOf(lc('a', []), stops)).toHaveLength(3)
  })
  it('narrows to the named stops', () => {
    expect(legStopsOf(lc('a', ['s3', 's1']), stops).map((s) => s.id)).toEqual(['s1', 's3'])
  })
})

describe('validateLegs', () => {
  it('errors on an unknown stop id', () => {
    expect(validateLegs([lc('a', ['nope'])], stops).errors).toHaveLength(1)
  })
  it('warns, never errors, on a stop nobody covers', () => {
    const r = validateLegs([lc('a', ['s1']), lc('b', ['s2'])], stops)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual(['Stop 3 is not covered by any carrier'])
  })
  it('allows a shared transload stop and all-stops carriers', () => {
    expect(validateLegs([lc('a', ['s1', 's2']), lc('b', ['s2', 's3'])], stops)).toEqual({ errors: [], warnings: [] })
    expect(validateLegs([lc('a'), lc('b')], stops)).toEqual({ errors: [], warnings: [] })
  })
})

describe('carrierPhase / coveringCarrier', () => {
  const run = [
    stop('s1', 0, { arrivedAt: 't1', departedAt: 't2' }),
    stop('s2', 1, { arrivedAt: 't3' }),
    stop('s3', 2),
  ]
  it('derives the phase from the covered stops\' clocks', () => {
    expect(carrierPhase(lc('a', ['s1']), run)).toBe('DONE')
    expect(carrierPhase(lc('a', ['s2', 's3']), run)).toBe('AT_PICKUP')
    expect(carrierPhase(lc('a'), run)).toBe('IN_TRANSIT')
    expect(carrierPhase(lc('a', ['s3']), run)).toBe('NOT_STARTED')
    expect(carrierPhase(lc('a', ['s1', 's2']), run)).toBe('AT_DELIVERY')
  })
  it('names the carrier holding the earliest un-departed stop', () => {
    const a = lc('a', ['s1']); const b = lc('b', ['s2', 's3'])
    expect(coveringCarrier([a, b], run)?.id).toBe('b')
    expect(coveringCarrier([a, b], [stop('s1', 0), stop('s2', 1)])?.id).toBe('a')
    expect(coveringCarrier([a], run)).toBeNull()
  })
})

describe('validateCarrierAdd', () => {
  const outsideRow = (id: string, carrierId: string, legs?: string[]) => ({ id, carrierId, kind: 'CARRIER' as const, legStopIds: legs })
  it('refuses own fleet next to outside carriers, either way round', () => {
    expect(validateCarrierAdd([{ id: 'o', kind: 'OWN_ASSET' }], { kind: 'CARRIER', carrierId: 'c' })).toMatch(/Own fleet/)
    expect(validateCarrierAdd([outsideRow('a', 'c1')], { kind: 'OWN_ASSET' })).toMatch(/Own fleet/)
  })
  it('caps at four live carriers', () => {
    const four = [1, 2, 3, 4].map((n) => outsideRow(`r${n}`, `c${n}`))
    expect(validateCarrierAdd(four, { kind: 'CARRIER', carrierId: 'c9' })).toMatch(/at most 4/)
    expect(validateCarrierAdd(four.slice(0, 3), { kind: 'CARRIER', carrierId: 'c9' })).toBeNull()
  })
  it('allows the same carrier twice only with disjoint non-empty legs', () => {
    const live = [outsideRow('a', 'c1', ['s1'])]
    expect(validateCarrierAdd(live, { kind: 'CARRIER', carrierId: 'c1', legStopIds: ['s2'] })).toBeNull()
    expect(validateCarrierAdd(live, { kind: 'CARRIER', carrierId: 'c1', legStopIds: ['s1'] })).toMatch(/separate stops/)
    expect(validateCarrierAdd(live, { kind: 'CARRIER', carrierId: 'c1' })).toMatch(/separate stops/)
    expect(validateCarrierAdd([outsideRow('a', 'c1')], { kind: 'CARRIER', carrierId: 'c1', legStopIds: ['s2'] })).toMatch(/separate stops/)
  })
})
