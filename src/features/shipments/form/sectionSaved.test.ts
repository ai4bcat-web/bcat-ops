import { describe, expect, it } from 'vitest'
import type { LoadCarrierRecord } from '@/types/tms'
import { CARD_ORDER } from './cards/cardRegistry'
import { sectionState } from './sectionSaved'
import { filledValues, storedBundle } from './testFixtures'

const covered = (v: ReturnType<typeof filledValues>) => ({
  ...storedBundle(v), loadCarriers: [{ id: 'lcr-1', status: 'ACTIVE', sequence: 0 } as LoadCarrierRecord],
})

describe('sectionState', () => {
  it('is neutral before the shipment exists on the server', () => {
    const v = filledValues()
    expect(sectionState('carrier', v, null, null)).toBe('neutral')
  })

  it('no card but Carrier & Tracking ever turns green, even fully filled and saved', () => {
    const v = filledValues(); v.rates.customer.lhRate = '2100'
    const bundle = covered(v)
    for (const key of CARD_ORDER.filter((k) => k !== 'carrier')) expect(sectionState(key, v, v, bundle)).toBe('neutral')
  })

  it('carrier is complete only once the saved load is covered', () => {
    const v = filledValues()
    expect(sectionState('carrier', v, v, { ...storedBundle(v), loadCarriers: [] })).toBe('neutral')
    expect(sectionState('carrier', v, v, covered(v))).toBe('complete')
  })

  it('an unsaved carrier edit takes the green away until it is saved', () => {
    const saved = filledValues()
    const edited = { ...saved, carrier: { ...saved.carrier, truckNo: '99' } }
    expect(sectionState('carrier', edited, saved, covered(saved))).toBe('neutral')
    expect(sectionState('carrier', edited, edited, covered(saved))).toBe('complete')
  })
})
