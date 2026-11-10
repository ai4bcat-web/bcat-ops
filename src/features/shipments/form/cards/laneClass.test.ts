import { describe, expect, it } from 'vitest'
import { laneClassOfDivision } from './laneClass'

describe('laneClassOfDivision', () => {
  it('Brokerage is brokerage; Assets and what sits under it is Ivan; anything else is not compared by side', () => {
    expect(laneClassOfDivision('BROKERAGE')).toBe('BROKERAGE')
    expect(laneClassOfDivision('assets')).toBe('IVAN')
    expect(laneClassOfDivision('OWNER_OPERATOR')).toBe('IVAN')
    expect(laneClassOfDivision('BOX_TRUCK')).toBe('IVAN')
    expect(laneClassOfDivision('CAR_SHIPPING')).toBeNull()
    expect(laneClassOfDivision('')).toBeNull()
    expect(laneClassOfDivision(null)).toBeNull()
  })
})
