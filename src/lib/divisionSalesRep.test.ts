import { describe, it, expect } from 'vitest'
import { divisionForRevType, parseDivisionSalesReps, salesRepForDivision } from './divisionSalesRep'

const settings = { divisionSalesReps: JSON.stringify({ BROKERAGE: 'u1', ASSETS: ' u2 ', CAR_SHIPPING: '', OWNER_OPERATOR: 5 }) }

describe('salesRepForDivision', () => {
  it('gives the division rep to a shipment that has none', () => {
    expect(salesRepForDivision(settings, { revDivision: 'BROKERAGE', salesRepId: null })).toBe('u1')
    expect(salesRepForDivision(settings, { revDivision: 'ASSETS' })).toBe('u2')
  })
  it('never overwrites a rep already on the shipment', () => {
    expect(salesRepForDivision(settings, { revDivision: 'BROKERAGE', salesRepId: 'hand' })).toBeNull()
  })
  it('returns null for blank entries, unknown divisions, no settings or garbage JSON', () => {
    expect(salesRepForDivision(settings, { revDivision: 'CAR_SHIPPING' })).toBeNull()
    expect(salesRepForDivision(settings, { revDivision: 'OWNER_OPERATOR' })).toBeNull()
    expect(salesRepForDivision(settings, { revDivision: null })).toBeNull()
    expect(salesRepForDivision(null, { revDivision: 'BROKERAGE' })).toBeNull()
    expect(parseDivisionSalesReps('{nope')).toEqual({})
  })
})

describe('divisionForRevType', () => {
  it('maps the four letters, case-insensitively', () => {
    expect(['B', 'i', 'A', 'o', 'X', null].map(divisionForRevType)).toEqual(['BROKERAGE', 'ASSETS', 'CAR_SHIPPING', 'OWNER_OPERATOR', null, null])
  })
})
