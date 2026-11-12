import { describe, expect, it } from 'vitest'
import { isOwnerOperatorGroup, ownerOpCarriesWeeklyCharges, OWNER_OP_FIRST_PERIOD } from './ownerOperatorTrips'

describe('owner operator changeover', () => {
  it('counts an Amazon-group driver and an owner-operator-group driver as owner operators', () => {
    expect(isOwnerOperatorGroup('AMAZON')).toBe(true)
    expect(isOwnerOperatorGroup('OWNER_OPERATOR')).toBe(true)
    expect(isOwnerOperatorGroup(null)).toBe(true)
    expect(isOwnerOperatorGroup('BOX_TRUCK')).toBe(false)
  })
  it('weekly charges move to the owner-operator statement from 2026-09-27, never before', () => {
    expect(OWNER_OP_FIRST_PERIOD).toBe('2026-09-27')
    expect(ownerOpCarriesWeeklyCharges('2026-09-20')).toBe(false)
    expect(ownerOpCarriesWeeklyCharges('2026-09-27')).toBe(true)
  })
})
