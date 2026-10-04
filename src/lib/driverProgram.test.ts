import { describe, it, expect } from 'vitest'
import { driverProgramOf } from './driverProgram'

describe('driverProgramOf', () => {
  it('gives Ivan’s own fleet the paperwork page', () => {
    expect(driverProgramOf({ fleetGroup: 'LOCAL' })).toBe('PAPERWORK')
    expect(driverProgramOf({ payGroup: 'LOCAL' })).toBe('PAPERWORK')
  })

  it('gives owner operators the settlement', () => {
    expect(driverProgramOf({ fleetGroup: 'AMAZON' })).toBe('SETTLEMENT')
    expect(driverProgramOf({ driverType: 'OWNER_OPERATOR' })).toBe('SETTLEMENT')
    expect(driverProgramOf({ payGroup: 'OWNER_OPERATOR' })).toBe('SETTLEMENT')
  })

  it('keeps the settlement when the record says nothing', () => {
    /*
     * The important one. Several live owner operators carry no fleetGroup and no
     * driverType; reading a blank record as Ivan's would take their pay page away and
     * replace it with one that shows no money. Unstated must mean "leave it alone".
     */
    expect(driverProgramOf({})).toBe('SETTLEMENT')
    expect(driverProgramOf({ fleetGroup: null, driverType: null, payGroup: null })).toBe('SETTLEMENT')
    expect(driverProgramOf({ payGroup: 'AMAZON' })).toBe('SETTLEMENT')
  })

  it('lets an owner-operator marking win over a stale LOCAL pay group', () => {
    // The two disagree in real data. The safer read keeps the settlement.
    expect(driverProgramOf({ driverType: 'OWNER_OPERATOR', payGroup: 'LOCAL' })).toBe('SETTLEMENT')
    expect(driverProgramOf({ fleetGroup: 'AMAZON', payGroup: 'LOCAL' })).toBe('SETTLEMENT')
  })
})
