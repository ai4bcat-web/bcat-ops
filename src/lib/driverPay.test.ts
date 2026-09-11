import { describe, it, expect } from 'vitest'
import { calcDriverPay, tripPayAmount, effectivePayRate, effectiveFixedExpenses, fixedExpenseLineLabel } from './driverPay'
import type { PayTripInput, PayDeductionInput, PayCreditInput, PayRateOverride, FixedExpenseInput } from './driverPay'

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

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

describe('effectivePayRate — pinned rate windows', () => {
  // Chad's real timeline: 42% after expenses historically, Lee/Roy-style 88% − expenses
  // for the weeks of 8/16 and 8/23/2026, then 50% after expenses from 8/30 on.
  const history: PayRateOverride[] = [
    { from: '1970-01-01', until: '2026-08-16', payPercent: 0.42, expensesBeforePercent: true },
    { from: '2026-08-16', until: '2026-08-30', payPercent: 0.88, expensesBeforePercent: false },
  ]
  const chad = { payPercent: 0.5, expensesBeforePercent: true, rateHistory: history }

  it('weeks before the change keep the old pinned rate', () => {
    expect(effectivePayRate(chad, '2026-08-09')).toEqual({ payPercent: 0.42, expensesBeforePercent: true })
  })

  it('the two 88% weeks pay like Lee and Roy', () => {
    expect(effectivePayRate(chad, '2026-08-16')).toEqual({ payPercent: 0.88, expensesBeforePercent: false })
    expect(effectivePayRate(chad, '2026-08-23')).toEqual({ payPercent: 0.88, expensesBeforePercent: false })
  })

  it('8/30 and every later week falls through to the base 50% after expenses', () => {
    expect(effectivePayRate(chad, '2026-08-30')).toEqual({ payPercent: 0.5, expensesBeforePercent: true })
    expect(effectivePayRate(chad, '2027-01-03')).toEqual({ payPercent: 0.5, expensesBeforePercent: true })
  })

  it('no history (every other driver) means the base rate, unchanged', () => {
    expect(effectivePayRate({ payPercent: 0.88, expensesBeforePercent: false }, '2026-08-16'))
      .toEqual({ payPercent: 0.88, expensesBeforePercent: false })
    expect(effectivePayRate({ payPercent: 0.88, expensesBeforePercent: false, rateHistory: [] }, '2026-08-16'))
      .toEqual({ payPercent: 0.88, expensesBeforePercent: false })
  })

  it('until is exclusive — the boundary week belongs to the NEXT window', () => {
    expect(effectivePayRate(chad, '2026-08-15')).toEqual({ payPercent: 0.42, expensesBeforePercent: true })
  })
})

describe('debits — money off the check at 100%, AFTER the net', () => {
  const debit = (amount: number, reasonCode = 'CASH_ADVANCE') => [{ label: 'advance', amount, reasonCode }]

  it('after-expenses driver bears the FULL debit, not their pay % of it', () => {
    const setting = { payPercent: 0.5, expensesBeforePercent: true }
    // 50% × (4000 − 1000) = 1500; a $200 debit costs the whole $200, not $100
    const r = calcDriverPay(tripsTotaling(4_000), setting, ded(1_000), [], debit(200))
    expect(r.payBeforeCredits).toBeCloseTo(1_500, 2)
    expect(r.totalDebits).toBeCloseTo(200, 2)
    expect(r.checkAmount).toBeCloseTo(1_300, 2)
  })

  it('88%-of-gross model: subtracted in full after the net', () => {
    const setting = { payPercent: 0.88, expensesBeforePercent: false }
    const r = calcDriverPay(tripsTotaling(1_000), setting, ded(100), [], debit(75))
    expect(r.checkAmount).toBeCloseTo(0.88 * 1_000 - 100 - 75, 2)
  })

  it('credits and debits compose: check = net + credits − debits', () => {
    const setting = { payPercent: 0.5, expensesBeforePercent: true }
    const r = calcDriverPay(tripsTotaling(2_000), setting, [], [{ label: 'bonus', amount: 100 }], debit(40))
    expect(r.checkAmount).toBeCloseTo(1_000 + 100 - 40, 2)
  })

  it('no debits — statements are unchanged', () => {
    const r = calcDriverPay(tripsTotaling(1_000), { payPercent: 0.88, expensesBeforePercent: false }, [])
    expect(r.totalDebits).toBe(0)
    expect(r.checkAmount).toBeCloseTo(880, 2)
  })
})

describe('effectiveFixedExpenses — daily-prorated fixed charges', () => {
  // Chad's real case: PLATES was deleted from settings and every past week lost it.
  // Bounded charges keep history: PLATES applies to weeks BEFORE 2026-08-30 only.
  const charges = [
    { label: 'ELD', amount: 20 },
    { label: 'PLATES', amount: 75, until: '2026-08-30' },
    { label: 'NEW ESCROW', amount: 50, from: '2026-09-06' },
  ]

  it('a past week keeps the since-ended charge', () => {
    expect(effectiveFixedExpenses(charges, '2026-08-23', addDays('2026-08-23', 6)).map((f) => f.label))
      .toEqual(['ELD', 'PLATES'])
  })

  it('the week it ends on no longer has it', () => {
    expect(effectiveFixedExpenses(charges, '2026-08-30', addDays('2026-08-30', 6)).map((f) => f.label))
      .toEqual(['ELD'])
  })

  it('a future-dated charge starts on its from week, not before', () => {
    expect(effectiveFixedExpenses(charges, '2026-09-06', addDays('2026-09-06', 6)).map((f) => f.label))
      .toEqual(['ELD', 'NEW ESCROW'])
  })

  it('unbounded charges (every existing row) apply everywhere', () => {
    expect(effectiveFixedExpenses([{ label: 'ELD', amount: 20 }], '1999-01-03', addDays('1999-01-03', 6)))
      .toHaveLength(1)
    expect(effectiveFixedExpenses(null, '2026-08-23', addDays('2026-08-23', 6))).toEqual([])
  })

  it('full-period aligned windows keep the original amount', () => {
    const r = effectiveFixedExpenses(
      [{ label: 'ELD', amount: 20 }],
      '2026-08-23',
      addDays('2026-08-23', 6),
    )
    expect(r[0].amount).toBe(20)
  })

  it('prorates a midweek amount change across the same expenseId series', () => {
    const rows: FixedExpenseInput[] = [
      { label: 'INSURANCE', amount: 100, from: '2026-09-06', until: '2026-09-09', revisionId: 'r1', expenseId: 'e1' },
      { label: 'INSURANCE', amount: 200, from: '2026-09-09', until: null, revisionId: 'r2', expenseId: 'e1' },
    ]
    const r = effectiveFixedExpenses(rows, '2026-09-06', addDays('2026-09-06', 6))
    expect(r.map((f) => f.amount)).toEqual([42.86, 114.28])
    expect(r.reduce((s, f) => s + f.amount, 0)).toBeCloseTo(157.14, 2)
  })

  it('names the day fraction on partial-period lines only, so the sheet explains the odd amount', () => {
    const rows: FixedExpenseInput[] = [
      { label: 'ELD', amount: 20 },
      { label: 'INSURANCE', amount: 100, from: '2026-09-06', until: '2026-09-09', revisionId: 'r1', expenseId: 'e1' },
      { label: 'INSURANCE', amount: 200, from: '2026-09-09', until: null, revisionId: 'r2', expenseId: 'e1' },
    ]
    const r = effectiveFixedExpenses(rows, '2026-09-06', addDays('2026-09-06', 6))
    expect(r.map(fixedExpenseLineLabel)).toEqual(['ELD', 'INSURANCE (3/7 days)', 'INSURANCE (4/7 days)'])
  })

  it('same-rate split cannot create or lose a cent', () => {
    const rows: FixedExpenseInput[] = [
      { label: 'INSURANCE', amount: 100, from: '2026-09-06', until: '2026-09-09', revisionId: 'r1', expenseId: 'e1' },
      { label: 'INSURANCE', amount: 100, from: '2026-09-09', until: null, revisionId: 'r2', expenseId: 'e1' },
    ]
    const r = effectiveFixedExpenses(rows, '2026-09-06', addDays('2026-09-06', 6))
    expect(r.reduce((s, f) => s + f.amount, 0)).toBe(100)
  })

  it('prorates 14-day biweekly new and ended charges', () => {
    const rows: FixedExpenseInput[] = [
      { label: 'OLD', amount: 100, from: '2026-09-01', until: '2026-09-10', revisionId: 'r1', expenseId: 'e1' },
      { label: 'NEW', amount: 100, from: '2026-09-13', until: null, revisionId: 'r2', expenseId: 'e2' },
    ]
    const r = effectiveFixedExpenses(rows, '2026-09-06', addDays('2026-09-06', 13))
    expect(r).toHaveLength(2)
    expect(r.find((f) => f.label === 'OLD')?.amount).toBeCloseTo(28.57, 2)
    expect(r.find((f) => f.label === 'NEW')?.amount).toBe(50)
  })

  it('handles multiple scheduled versions including a midweek type change', () => {
    const rows: FixedExpenseInput[] = [
      { label: 'INSURANCE-A', amount: 100, from: '2026-09-06', until: '2026-09-09', revisionId: 'r1', expenseId: 'e1' },
      { label: 'INSURANCE-B', amount: 150, from: '2026-09-09', until: '2026-09-12', revisionId: 'r2', expenseId: 'e1' },
      { label: 'INSURANCE-C', amount: 200, from: '2026-09-12', until: null, revisionId: 'r3', expenseId: 'e1' },
    ]
    const r = effectiveFixedExpenses(rows, '2026-09-06', addDays('2026-09-06', 6))
    expect(r.map((f) => f.amount)).toEqual([42.86, 64.28, 28.57])
    expect(r.reduce((s, f) => s + f.amount, 0)).toBeCloseTo(135.71, 2)
  })

  it('does not charge a revision that does not overlap the period', () => {
    const rows: FixedExpenseInput[] = [
      { label: 'FUTURE', amount: 100, from: '2026-09-13', until: null, revisionId: 'r1', expenseId: 'e1' },
    ]
    expect(effectiveFixedExpenses(rows, '2026-09-06', addDays('2026-09-06', 6))).toEqual([])
  })

  it('respects until exclusive', () => {
    const rows: FixedExpenseInput[] = [
      { label: 'X', amount: 70, from: '2026-09-06', until: '2026-09-09', revisionId: 'r1', expenseId: 'e1' },
    ]
    const r = effectiveFixedExpenses(rows, '2026-09-06', addDays('2026-09-06', 6))
    expect(r[0].amount).toBeCloseTo(30, 2)
  })

  it('rejects an inverted period range', () => {
    expect(() => effectiveFixedExpenses([], '2026-09-06', '2026-09-05')).toThrow()
  })

  it('a negative one-off offsets a fixed charge exactly, under BOTH pay models', () => {
    // The per-week "waive" writes a −amount one-off; net deductions for the week drop by
    // the full charge, which is correct whichever side of the % the expenses land on.
    const dedWaived = [{ label: 'INSURANCE', amount: 300 }, { label: 'Waived — INSURANCE', amount: -300 }]
    const after = calcDriverPay(tripsTotaling(2_000), { payPercent: 0.5, expensesBeforePercent: true }, dedWaived)
    expect(after.checkAmount).toBeCloseTo(1_000, 2)
    const gross = calcDriverPay(tripsTotaling(2_000), { payPercent: 0.88, expensesBeforePercent: false }, dedWaived)
    expect(gross.checkAmount).toBeCloseTo(1_760, 2)
  })
})
