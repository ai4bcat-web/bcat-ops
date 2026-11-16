import { describe, it, expect } from 'vitest'
import { divisionForRevType, mergeDivisionRepDefaults, parseDivisionSalesReps, salesRepAfterDivisionChange, salesRepForDivision } from './divisionSalesRep'

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

describe('salesRepAfterDivisionChange', () => {
  const cfg = { divisionSalesReps: { BROKERAGE: { default: 'ryne', allowed: ['ryne', 'amy'] }, ASSETS: 'ivan', CAR_SHIPPING: 'ruben' } }
  it('moves a blank rep or another division\'s default to the new division default', () => {
    expect(salesRepAfterDivisionChange(cfg, { revDivision: 'BROKERAGE', salesRepId: null })).toBe('ryne')
    expect(salesRepAfterDivisionChange(cfg, { revDivision: 'BROKERAGE', salesRepId: 'ruben' })).toBe('ryne')
    expect(salesRepAfterDivisionChange(cfg, { revDivision: 'ASSETS', salesRepId: 'ryne' })).toBe('ivan')
  })
  it('keeps a manually chosen rep: an allowed one, or one that is nobody\'s default', () => {
    expect(salesRepAfterDivisionChange(cfg, { revDivision: 'BROKERAGE', salesRepId: 'amy' })).toBeNull()
    expect(salesRepAfterDivisionChange(cfg, { revDivision: 'ASSETS', salesRepId: 'perla' })).toBeNull()
    expect(salesRepAfterDivisionChange(cfg, { revDivision: 'ASSETS', salesRepId: 'ivan' })).toBeNull()
  })
  it('does nothing without a rule for the division', () => {
    expect(salesRepAfterDivisionChange(cfg, { revDivision: 'OWNER_OPERATOR', salesRepId: null })).toBeNull()
    expect(salesRepAfterDivisionChange(null, { revDivision: 'BROKERAGE', salesRepId: null })).toBeNull()
  })
  it('reads the list shape as defaults and keeps lists when a default is edited', () => {
    expect(parseDivisionSalesReps(cfg.divisionSalesReps)).toEqual({ BROKERAGE: 'ryne', ASSETS: 'ivan', CAR_SHIPPING: 'ruben' })
    expect(mergeDivisionRepDefaults(cfg.divisionSalesReps, { BROKERAGE: 'amy', ASSETS: 'ivan' }))
      .toEqual({ BROKERAGE: { default: 'amy', allowed: ['amy', 'ryne'] }, ASSETS: 'ivan' })
  })
})
