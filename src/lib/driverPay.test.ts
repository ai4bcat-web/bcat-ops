import { describe, it, expect } from 'vitest'
import { calcDriverPay, tripPayAmount } from './driverPay'
import type { PayTripInput, PayDeductionInput } from './driverPay'

// Each "trip set" is reduced to its freight total; the calc only needs the sum.
const tripsTotaling = (gross: number): PayTripInput[] => [{ freightAmount: gross }]
const ded = (total: number): PayDeductionInput[] => [{ label: 'expenses', amount: total }]

describe('calcDriverPay — verified against production pay sheets', () => {
  it('Chad: 42% AFTER expenses', () => {
    // gross 10,262.06 − deductions 2,561.68 = 7,700.38 subtotal; check = 42% × subtotal
    const r = calcDriverPay(tripsTotaling(10_262.06), { payPercent: 0.42, expensesBeforePercent: true }, ded(2_561.68))
    expect(r.subtotal).toBeCloseTo(7_700.38, 2)
    expect(r.checkAmount).toBeCloseTo(3_234.16, 2)
    // each load shows full freight in the Amount column
    expect(tripPayAmount(765.78, { payPercent: 0.42, expensesBeforePercent: true })).toBeCloseTo(765.78, 2)
  })

  it('Lee: 88% of gross, THEN minus expenses', () => {
    const r = calcDriverPay(tripsTotaling(11_044.23), { payPercent: 0.88, expensesBeforePercent: false }, ded(1_798.22))
    expect(r.driverAmount).toBeCloseTo(9_718.92, 2)
    expect(r.checkAmount).toBeCloseTo(7_920.70, 2)
    // per-load amount = 88% of freight
    expect(tripPayAmount(300, { payPercent: 0.88, expensesBeforePercent: false })).toBeCloseTo(264, 2)
  })

  it('Mike: 85% of gross, THEN minus expenses', () => {
    const r = calcDriverPay(tripsTotaling(5_457.24), { payPercent: 0.85, expensesBeforePercent: false }, ded(1_081.11))
    expect(r.driverAmount).toBeCloseTo(4_638.65, 2)
    expect(r.checkAmount).toBeCloseTo(3_557.54, 2)
  })

  it('Roy: 88% of gross, THEN minus expenses', () => {
    const r = calcDriverPay(tripsTotaling(5_906.03), { payPercent: 0.88, expensesBeforePercent: false }, ded(500))
    expect(r.driverAmount).toBeCloseTo(5_197.31, 2)
    expect(r.checkAmount).toBeCloseTo(4_697.31, 2)
  })

  it('sums freight across many trips, including cancelled', () => {
    const trips: PayTripInput[] = [
      { freightAmount: 300, status: 'Completed' },
      { freightAmount: 175, status: 'Cancelled' }, // still counted
      { freightAmount: 463.33, status: 'Completed' },
    ]
    const r = calcDriverPay(trips, { payPercent: 0.88, expensesBeforePercent: false }, [])
    expect(r.gross).toBeCloseTo(938.33, 2)
    expect(r.checkAmount).toBeCloseTo(0.88 * 938.33, 2)
  })

  it('no trips / no deductions → zero', () => {
    const r = calcDriverPay([], { payPercent: 0.42, expensesBeforePercent: true }, [])
    expect(r.gross).toBe(0)
    expect(r.checkAmount).toBe(0)
  })
})
