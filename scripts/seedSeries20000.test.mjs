import { describe, it, expect } from 'vitest'
import { COUNTER_FLOOR, assertSeriesSuffix, planSeries20000 } from './seedSeries20000.mjs'

describe('assertSeriesSuffix', () => {
  it('requires an explicit suffix and refuses production anywhere in it', () => {
    expect(() => assertSeriesSuffix(undefined)).toThrow(/required/)
    expect(() => assertSeriesSuffix('  ')).toThrow(/required/)
    expect(() => assertSeriesSuffix('5ucwdyvwivelbo4k4jomvrwel4-NONE')).toThrow(/production/)
    expect(() => assertSeriesSuffix('x-5ucwdyvwivelbo4k4jomvrwel4')).toThrow(/production/)
    expect(assertSeriesSuffix(' devsuffix-NONE ')).toBe('devsuffix-NONE')
  })
})

describe('planSeries20000', () => {
  it('sets the counter to 19999 (next PRO 20000) and NUMERIC from an imported-max counter', () => {
    const plan = planSeries20000({ settings: { nextShipmentNumber: 14939, proScheme: 'DERIVED' }, maxClaimedPro: 14939 })
    expect(plan).toMatchObject({ action: 'SET', firstPro: 20000, patch: { nextShipmentNumber: COUNTER_FLOOR, proScheme: 'NUMERIC' } })
  })
  it('never rewinds a counter that is already at or past the floor', () => {
    expect(planSeries20000({ settings: { nextShipmentNumber: 20005, proScheme: 'NUMERIC' } }).action).toBe('REFUSE')
    expect(planSeries20000({ settings: { nextShipmentNumber: 19999, proScheme: 'DERIVED' } }).action).toBe('REFUSE')
  })
  it('is a no-op once seeded', () => {
    expect(planSeries20000({ settings: { nextShipmentNumber: 19999, proScheme: 'NUMERIC' } }).action).toBe('NOOP')
  })
  it('refuses when a numeric PRO >= 20000 is already claimed, and when there is no settings row', () => {
    expect(planSeries20000({ settings: { nextShipmentNumber: 100 }, maxClaimedPro: 20001 }).action).toBe('REFUSE')
    expect(planSeries20000({ settings: { nextShipmentNumber: 100 }, maxClaimedPro: 19999 }).action).toBe('SET')
    expect(planSeries20000({ settings: null }).action).toBe('REFUSE')
  })
})
