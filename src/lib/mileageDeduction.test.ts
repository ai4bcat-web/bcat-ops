import { describe, it, expect } from 'vitest'
import { mileageDeductionLine } from './mileageDeduction'

describe('mileageDeductionLine', () => {
  it('returns the production label and amount for the sample mileage pair', () => {
    expect(mileageDeductionLine(2494, 0.086)).toEqual({
      label: 'Lease mileage — 2494 mi @ $0.086/mi',
      amount: 214.48,
    })
  })

  it('uses the supplied note as the prefix', () => {
    expect(mileageDeductionLine(1000, 0.12, 'Truck lease')).toEqual({
      label: 'Truck lease — 1000 mi @ $0.12/mi',
      amount: 120,
    })
  })

  it('throws on invalid input', () => {
    expect(() => mileageDeductionLine(0, 0.1)).toThrow()
    expect(() => mileageDeductionLine(100, -0.1)).toThrow()
    expect(() => mileageDeductionLine(Number.NaN, 0.1)).toThrow()
  })
})
