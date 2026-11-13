import { describe, expect, it } from 'vitest'
import type { LoadCarrierRecord } from '@/types/tms'
import { requiredRows } from './railModel'
import { sectionState } from './sectionSaved'
import { CUSTOMER, filledValues, storedBundle } from './testFixtures'

const rowsOf = (v: ReturnType<typeof filledValues>) => requiredRows(v, 'edit', { customer: CUSTOMER })

describe('sectionState', () => {
  it('is neutral before the shipment exists on the server', () => {
    const v = filledValues()
    expect(sectionState('freight', v, null, rowsOf(v), null)).toBe('neutral')
  })

  it('a card with its required fields filled and saved is complete', () => {
    const v = filledValues()
    const bundle = storedBundle(v)
    expect(sectionState('freight', v, v, rowsOf(v), bundle)).toBe('complete')
    expect(sectionState('route', v, v, rowsOf(v), bundle)).toBe('complete')
  })

  it('editing a field makes the card unsaved until it is saved again', () => {
    const saved = filledValues()
    const edited = { ...saved, ship: { ...saved.ship, weightLbs: '41000' } }
    const bundle = storedBundle(saved)
    expect(sectionState('freight', edited, saved, rowsOf(edited), bundle)).toBe('unsaved')
    // Other cards are untouched by that edit.
    expect(sectionState('route', edited, saved, rowsOf(edited), bundle)).toBe('complete')
    expect(sectionState('freight', edited, edited, rowsOf(edited), bundle)).toBe('complete')
  })

  it('a saved card missing a required field stays neutral', () => {
    const v = filledValues(); v.ship.weightLbs = ''
    expect(sectionState('freight', v, v, rowsOf(v), storedBundle(v))).toBe('neutral')
  })

  it('carrier is complete only once the load is covered', () => {
    const v = filledValues()
    const bundle = storedBundle(v)
    expect(sectionState('carrier', v, v, rowsOf(v), { ...bundle, loadCarriers: [] })).toBe('neutral')
    const covered = { ...bundle, loadCarriers: [{ id: 'lcr-1', status: 'ACTIVE', sequence: 0 } as LoadCarrierRecord] }
    expect(sectionState('carrier', v, v, rowsOf(v), covered)).toBe('complete')
  })

  it('rates are complete once a customer rate is saved; documents stay neutral', () => {
    const v = filledValues(); v.rates.customer.lhRate = '2100'
    const bundle = storedBundle(v)
    expect(sectionState('rates', v, v, rowsOf(v), bundle)).toBe('complete')
    const none = filledValues(); none.rates.customer.lhRate = ''
    expect(sectionState('rates', none, none, rowsOf(none), bundle)).toBe('neutral')
    expect(sectionState('documents', v, v, rowsOf(v), bundle)).toBe('neutral')
  })
})
