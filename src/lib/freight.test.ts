import { describe, it, expect } from 'vitest'
import { freightSummary, formatPieces, formatWeight, hasFreight } from './freight'

describe('freightSummary', () => {
  it('reads pieces, weight, commodity in that order', () => {
    expect(freightSummary({ commodity: 'Paper goods', weight: 41000, pieces: 22, piecesUnit: 'pallets' }))
      .toBe('22 pallets · 41,000 lbs · Paper goods')
  })
  it('skips what the tender did not state', () => {
    expect(freightSummary({ commodity: 'Steel coils', weight: null, pieces: null })).toBe('Steel coils')
    expect(freightSummary({ commodity: '  ', weight: 12000 })).toBe('12,000 lbs')
    expect(freightSummary({})).toBeNull()
    expect(freightSummary(null)).toBeNull()
    expect(hasFreight({ pieces: 0, weight: 0, commodity: '' })).toBe(false)
  })
  it('singularises one piece and defaults the unit', () => {
    expect(formatPieces(1, 'pallets')).toBe('1 pallet')
    expect(formatPieces(3, null)).toBe('3 pieces')
    expect(formatPieces(0, 'cases')).toBeNull()
  })
  it('rounds weight to whole pounds', () => {
    expect(formatWeight(42953.4)).toBe('42,953 lbs')
    expect(formatWeight(-5)).toBeNull()
  })
})

describe('freightPatchFor', () => {
  it('fills only what the load does not have yet', async () => {
    const { freightPatchFor } = await import('./rateconUpload')
    expect(freightPatchFor({ commodity: 'Typed by hand', weight: null, pieces: null },
      { commodity: 'Frozen foods', weightLbs: 42953.4, pieces: 24, piecesUnit: 'pallets' }))
      .toEqual({ weight: 42953, pieces: 24, piecesUnit: 'pallets' })
    expect(freightPatchFor({ commodity: 'X', weight: 1000, pieces: 2 }, { commodity: 'Y', weightLbs: 5, pieces: 9 })).toBeNull()
    expect(freightPatchFor({}, null)).toBeNull()
    expect(freightPatchFor({}, { commodity: null, weightLbs: null, pieces: null, piecesUnit: null })).toBeNull()
  })
})
