import { describe, it, expect } from 'vitest'
import { calcDriverPay, tripPayAmount } from './driverPay'
import type { PayTripInput, PayDeductionInput, PayCreditInput } from './driverPay'

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
    expect(r.totalCredits).toBe(0)
  })
})

describe('credits — extra pay added to the check', () => {
  const credit = (amount: number, reasonCode = 'DETENTION'): PayCreditInput[] => [{ label: 'detention', amount, reasonCode }]

  it('Zak-style (50% AFTER expenses): the credit lands on the check at 100%', () => {
    const setting = { payPercent: 0.5, expensesBeforePercent: true }
    const base = calcDriverPay(tripsTotaling(4_000), setting, ded(1_000))
    const withCredit = calcDriverPay(tripsTotaling(4_000), setting, ded(1_000), credit(150))
    // 50% × (4000 − 1000) = 1500, + 150 credit = 1650 — NOT 50% of the credit
    expect(base.checkAmount).toBeCloseTo(1_500, 2)
    expect(withCredit.payBeforeCredits).toBeCloseTo(1_500, 2)
    expect(withCredit.totalCredits).toBeCloseTo(150, 2)
    expect(withCredit.checkAmount).toBeCloseTo(1_650, 2)
  })

  it('88%-of-gross model: the credit is also paid in full', () => {
    const setting = { payPercent: 0.88, expensesBeforePercent: false }
    const r = calcDriverPay(tripsTotaling(1_000), setting, ded(100), credit(75))
    // 0.88 × 1000 = 880 − 100 = 780, + 75 = 855
    expect(r.payBeforeCredits).toBeCloseTo(780, 2)
    expect(r.checkAmount).toBeCloseTo(855, 2)
  })

  it('sums several credits and leaves gross/deductions untouched', () => {
    const r = calcDriverPay(tripsTotaling(2_000), { payPercent: 0.5, expensesBeforePercent: true }, ded(200), [
      { label: 'Detention', amount: 120.5, reasonCode: 'DETENTION' },
      { label: 'Layover', amount: 200, reasonCode: 'LAYOVER' },
      { label: 'Safety bonus', amount: 79.5, reasonCode: 'BONUS' },
    ])
    expect(r.gross).toBeCloseTo(2_000, 2)
    expect(r.totalDeductions).toBeCloseTo(200, 2)
    expect(r.totalCredits).toBeCloseTo(400, 2)
    expect(r.checkAmount).toBeCloseTo(900 + 400, 2)
  })

  it('credits can lift a negative check back into the black', () => {
    const r = calcDriverPay(tripsTotaling(500), { payPercent: 0.5, expensesBeforePercent: true }, ded(900), credit(300))
    expect(r.payBeforeCredits).toBeCloseTo(-200, 2)   // 50% × (500 − 900)
    expect(r.checkAmount).toBeCloseTo(100, 2)
  })

  it('no credits → check is unchanged from the pre-credit pay', () => {
    const r = calcDriverPay(tripsTotaling(1_000), { payPercent: 0.5, expensesBeforePercent: true }, ded(100))
    expect(r.totalCredits).toBe(0)
    expect(r.checkAmount).toBeCloseTo(r.payBeforeCredits, 2)
  })

  it('rounds to cents', () => {
    const r = calcDriverPay(tripsTotaling(1_000.01), { payPercent: 0.5, expensesBeforePercent: true }, [], [
      { label: 'a', amount: 33.333 }, { label: 'b', amount: 0.007 },
    ])
    expect(r.totalCredits).toBeCloseTo(33.34, 2)
    expect(r.checkAmount).toBeCloseTo(533.35, 2)
  })
})
