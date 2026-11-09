import { describe, it, expect } from 'vitest'
import { driverTypeLabel, driverTypeOptions, driverTypeOptionsFor, fleetGroupLabel } from './fleetGroups'
import { SEED_DIVISIONS } from './ownership'

const loaded = SEED_DIVISIONS.map((d) => (d.id === 'LOCAL' ? { ...d, name: 'Ivan Local' } : d))

describe('driver types derive from the Ivan Cartage subsidiaries', () => {
  it('uses seed names before divisions load, in division order', () => {
    expect(driverTypeOptions(null)).toEqual([
      { value: 'OWNER_OPERATOR', label: 'Owner Operators' },
      { value: 'BOX_TRUCK', label: 'Box Trucks' },
      { value: 'LOCAL', label: 'Local Drivers' },
    ])
    expect(driverTypeOptions([])).toEqual(driverTypeOptions(null))
  })

  it('shows a renamed division everywhere and drops deactivated or non-ASSETS divisions', () => {
    expect(driverTypeLabel('LOCAL', loaded)).toBe('Ivan Local')
    expect(fleetGroupLabel('LOCAL', loaded)).toBe('Ivan Local')
    const retired = loaded.map((d) => (d.id === 'BOX_TRUCK' ? { ...d, active: false } : d))
    expect(driverTypeOptions(retired).map((o) => o.value)).toEqual(['OWNER_OPERATOR', 'LOCAL'])
  })

  it('reads legacy AMAZON as the owner-operator type, keeps AMAZON for trucks, shows unknown values raw', () => {
    expect(driverTypeLabel('AMAZON', loaded)).toBe('Owner Operators')
    expect(fleetGroupLabel('AMAZON', loaded)).toBe('Amazon')
    expect(driverTypeLabel('MYSTERY', loaded)).toBe('MYSTERY')
  })

  it('keeps a stored value that is not an option so a select never blanks it', () => {
    expect(driverTypeOptionsFor('AMAZON', loaded).at(-1)).toEqual({ value: 'AMAZON', label: 'Owner Operators' })
    expect(driverTypeOptionsFor('LOCAL', loaded)).toHaveLength(3)
    expect(driverTypeOptionsFor(null, loaded)).toHaveLength(3)
  })
})
