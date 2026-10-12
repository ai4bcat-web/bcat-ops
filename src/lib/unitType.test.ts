import { describe, it, expect } from 'vitest'
import { unitTypeOf, unitKindLabel, unitTypeEditable, nextUnitType } from './unitType'

describe('unit type', () => {
  it('is dry van for Ivan local, box truck for box trucks, explicit otherwise', () => {
    expect(unitTypeOf({ fleetGroup: 'LOCAL' })).toBe('DRY_VAN')
    expect(unitTypeOf({ fleetGroup: 'BOX_TRUCK' })).toBe('BOX_TRUCK')
    expect(unitTypeOf({ fleetGroup: 'AMAZON' })).toBeNull()
    expect(unitTypeOf({ fleetGroup: 'AMAZON', unitType: 'FLATBED' })).toBe('FLATBED')
    expect(unitTypeOf({ fleetGroup: 'LOCAL', unitType: 'POWER_ONLY' })).toBe('POWER_ONLY')
  })
  it('labels and toggles', () => {
    expect(unitKindLabel(null)).toBe('Set unit type')
    expect(unitKindLabel('BOX_TRUCK')).toBe('Box truck')
    expect(unitKindLabel('DRY_VAN')).toBe('Dry van')
    expect(unitTypeEditable({ fleetGroup: 'AMAZON' })).toBe(true)
    expect(unitTypeEditable({ fleetGroup: 'LOCAL' })).toBe(false)
    expect(nextUnitType(null)).toBe('DRY_VAN')
    expect(nextUnitType('DRY_VAN')).toBe('FLATBED')
    expect(nextUnitType('POWER_ONLY')).toBe('DRY_VAN')
  })
})
