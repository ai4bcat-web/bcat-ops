/**
 * A capacity note is only useful if its equipment reads the same as a carrier profile's.
 * The ordering cases are the ones a plain keyword table gets wrong: a step deck is not
 * a flatbed and "power only" is not a van.
 */
import { describe, it, expect } from 'vitest'
import { normalizeEquipment, postingFrom } from './capacityProposal'

describe('normalizeEquipment', () => {
  it('maps carrier wording onto the Carrier.equipment vocabulary', () => {
    expect(normalizeEquipment('53 Dry Van')).toBe('VAN')
    expect(normalizeEquipment('reefer -10F')).toBe('REEFER')
    expect(normalizeEquipment('Step-Deck')).toBe('SPECIALIZED')
    expect(normalizeEquipment('RGN')).toBe('SPECIALIZED')
    expect(normalizeEquipment('power only')).toBe('POWER_ONLY')
    expect(normalizeEquipment('flat bed')).toBe('FLATBED')
  })

  it('answers null rather than guessing', () => {
    expect(normalizeEquipment('whatever you have')).toBeNull()
    expect(normalizeEquipment(null)).toBeNull()
  })
})

describe('postingFrom', () => {
  it('keeps only what the carrier actually said', () => {
    expect(postingFrom({ carrier: ' Ivan Cartage ', equipment: 'reefer', trucks: 2.7, notes: '' })).toEqual({
      kind: 'CAPACITY',
      carrierName: 'Ivan Cartage',
      equipment: 'REEFER',
      originCity: null,
      originState: null,
      destinationCity: null,
      destinationState: null,
      availableDate: null,
      trucks: 2,
      notes: null,
      confidence: null,
    })
    expect(postingFrom({ trucks: -1 }).trucks).toBeNull()
  })
})
