import { describe, it, expect } from 'vitest'
import {
  calcDriverPay,
  tripPayAmount,
  effectivePayRate,
  effectiveFixedExpenses,
  fixedExpenseLineLabel,
  FACTORING_FEE_LABEL,
  type FixedExpenseInput,
  type PayRateOverride,
} from '../../../src/lib/driverPay'
import { matchedFuelForCard, sumFuel } from '../../../src/lib/driverFuel'
import { creditLineLabel } from '../../../src/lib/payCredits'
import { weekLabel } from '../../../src/features/driver-pay/week'
import {
  buildSettlement,
  listWeekStarts,
  type RawAmazonTrip,
  type RawCredit,
  type RawDeduction,
  type RawDriverPaySetting,
  type RawFuelTransaction,
  type FactoringFields,
} from './settlement'

function periodEnd(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

describe('buildSettlement', () => {
  const periodStart = '2026-09-21'
  const fixedExpenses: FixedExpenseInput[] = [
    { label: 'Insurance', amount: 100, from: '2026-09-01' },
    { label: 'Lease', amount: 50, from: '2026-09-21', afterPercent: true },
  ]

  const trips: RawAmazonTrip[] = [
    {
      id: 'trip-1',
      periodStart,
      shipmentDate: '2026-09-22',
      freightAmount: 1000,
      sortOrder: 1,
    },
    {
      id: 'trip-2',
      periodStart,
      shipmentDate: '2026-09-23',
      freightAmount: 500,
      sortOrder: 2,
      loadId: 'LOAD-2',
      origin: 'Joliet, IL',
      destination: 'Indianapolis, IN',
      miles: 180,
    },
  ]

  const deductions: RawDeduction[] = [{ label: 'Toll violation', amount: 25 }]

  const credits: RawCredit[] = [
    { reasonCode: 'DETENTION', label: 'Kroger 2hr', amount: 80 },
  ]

  const debits: RawCredit[] = [
    { reasonCode: 'CASH_ADVANCE', label: 'advance', amount: 40 },
  ]

  const fuelTxs: RawFuelTransaction[] = [
    { transactionDate: '2026-09-22', cardNumber: '007', fuelType: 'ULSD', itemCategory: 'FUEL', amount: 120, quantity: 40 },
    { transactionDate: '2026-09-23', cardNumber: '007', fuelType: 'SCLE', itemCategory: 'SCALE', amount: 10, quantity: 1 },
    { transactionDate: '2026-09-23', cardNumber: '999', fuelType: 'ULSD', itemCategory: 'FUEL', amount: 200, quantity: 60 },
  ]

  function makeSetting(payPercent = 0.88): RawDriverPaySetting {
    return {
      payPercent,
      expensesBeforePercent: false,
      fuelCardNumber: '007',
      fixedExpenses,
      rateHistory: null,
    }
  }

  it('matches the shared driver-pay math, including deductions and check amount', () => {
    const setting = makeSetting()
    const settlement = buildSettlement(
      periodStart,
      trips,
      setting,
      deductions,
      credits,
      debits,
      fuelTxs,
    )

    const end = periodEnd(periodStart)
    const rate = effectivePayRate(
      {
        payPercent: setting.payPercent,
        expensesBeforePercent: setting.expensesBeforePercent,
        rateHistory: null,
      },
      periodStart,
    )

    const fixed = effectiveFixedExpenses(fixedExpenses, periodStart, end)
    const fuelAmount = sumFuel(
      matchedFuelForCard(
        fuelTxs,
        '007',
        periodStart,
        end,
      ),
    )

    const fixedDebits = fixed
      .filter((f) => f.afterPercent)
      .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount }))
    const deductionInputs = [
      ...fixed
        .filter((f) => !f.afterPercent)
        .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
      ...(fuelAmount > 0 ? [{ label: `Fuel (card 007)`, amount: fuelAmount }] : []),
      ...deductions,
    ]

    const creditInputs = credits.map((c) => ({
      label: creditLineLabel({ reasonCode: c.reasonCode, label: c.label, amount: c.amount }),
      amount: c.amount,
      reasonCode: c.reasonCode,
    }))

    const debitInputs = [
      ...fixedDebits,
      ...debits.map((c) => ({
        label: creditLineLabel({ reasonCode: c.reasonCode, label: c.label, amount: c.amount }),
        amount: c.amount,
        reasonCode: c.reasonCode,
      })),
    ]

    const statement = calcDriverPay(
      trips.map((t) => ({ freightAmount: t.freightAmount, status: t.status })),
      rate,
      deductionInputs,
      creditInputs,
      debitInputs,
    )

    expect(settlement.grossPay).toBe(statement.gross)
    expect(settlement.checkAmount).toBe(statement.checkAmount)
    expect(settlement.deductions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Insurance', amount: 100 }),
        expect.objectContaining({ label: `Fuel (card 007)`, amount: fuelAmount }),
        expect.objectContaining({ label: 'Toll violation', amount: 25 }),
      ]),
    )
    expect(settlement.credits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: expect.stringContaining('Detention'), amount: 80 }),
      ]),
    )
    expect(settlement.debits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: expect.stringContaining('Lease'), amount: 50 }),
        expect.objectContaining({ label: expect.stringContaining('Cash advance'), amount: 40 }),
      ]),
    )

    // Gross 1500 × 2% = 30, listed exactly once and included in the total.
    expect(settlement.deductions.filter((d) => d.label === FACTORING_FEE_LABEL)).toHaveLength(1)
    expect(settlement.deductions.find((d) => d.label === FACTORING_FEE_LABEL)?.amount).toBe(30)
    expect(settlement.deductions.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(
      statement.totalDeductions,
      2,
    )

    expect(settlement.trips).toHaveLength(2)
    expect(settlement.trips[0].amount).toBe(tripPayAmount(trips[0].freightAmount, rate))
    expect(settlement.trips[1].amount).toBe(tripPayAmount(trips[1].freightAmount, rate))
    expect(settlement.weekLabel).toBe(weekLabel(periodStart))
  })

  it('uses a pinned historical rate when the week falls inside a rateHistory window', () => {
    const setting = makeSetting(0.85)
    setting.rateHistory = [{ from: '2026-09-14', until: '2026-09-28', payPercent: 0.42, expensesBeforePercent: true }]

    const settlement = buildSettlement(periodStart, trips, setting, deductions, credits, debits, fuelTxs)

    const end = periodEnd(periodStart)
    const rateHistory = (setting.rateHistory ?? null) as PayRateOverride[] | null
    const rate = effectivePayRate(
      {
        payPercent: setting.payPercent,
        expensesBeforePercent: setting.expensesBeforePercent,
        rateHistory,
      },
      periodStart,
    )

    const fixed = effectiveFixedExpenses(fixedExpenses, periodStart, end)
    const fuelAmount = sumFuel(
      matchedFuelForCard(fuelTxs, '007', periodStart, end),
    )
    const fixedDebits = fixed.filter((f) => f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount }))
    const deductionInputs = [
      ...fixed.filter((f) => !f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
      ...(fuelAmount > 0 ? [{ label: `Fuel (card 007)`, amount: fuelAmount }] : []),
      ...deductions,
    ]
    const creditInputs = credits.map((c) => ({
      label: creditLineLabel({ reasonCode: c.reasonCode, label: c.label, amount: c.amount }),
      amount: c.amount,
    }))
    const debitInputs = [...fixedDebits, ...debits.map((c) => ({ label: creditLineLabel(c), amount: c.amount }))]

    const statement = calcDriverPay(
      trips.map((t) => ({ freightAmount: t.freightAmount, status: t.status })),
      rate,
      deductionInputs,
      creditInputs,
      debitInputs,
    )

    expect(settlement.checkAmount).toBe(statement.checkAmount)
    expect(settlement.grossPay).toBe(1500)
  })

  it('excludes fuel when no matching card', () => {
    const setting = makeSetting()
    setting.fuelCardNumber = 'different'
    const settlement = buildSettlement(periodStart, trips, setting, [], [], [], fuelTxs)
    const fuelLine = settlement.deductions.find((d) => d.label.startsWith('Fuel'))
    expect(fuelLine).toBeUndefined()
  })

  it('carries the per-trip factoring readiness through to the driver statement', () => {
    const factoring: FactoringFields = {
      invoiceNo: '14452',
      poNumber: 'PO-1',
      brokerMc: '123456',
      invoiceAmount: 450,
      invoiceDate: '2026-09-22',
      fromCity: 'Chicago',
      fromState: 'IL',
      fromZip: '60601',
      toCity: 'Detroit',
      toState: 'MI',
      toZip: '48201',
      podPresent: true,
      rateconPresent: true,
      blocked: false,
    }
    const settlement = buildSettlement(
      periodStart,
      [{ ...trips[0], factoring }],
      makeSetting(),
      [],
      [],
      [],
      [],
    )
    expect(settlement.trips[0].factoring).toEqual(factoring)
  })
})

describe('listWeekStarts', () => {
  it('lists Sunday week starts in descending order', () => {
    const trips: RawAmazonTrip[] = [
      { id: 't1', periodStart: '2026-09-07', freightAmount: 100 },
      { id: 't2', periodStart: '2026-09-14', freightAmount: 200 },
      { id: 't3', periodStart: '2026-09-14', freightAmount: 300 },
    ]
    const weeks = listWeekStarts(trips, new Date('2026-09-30T00:00:00Z'))
    expect(weeks).toEqual(['2026-09-27', '2026-09-20', '2026-09-13', '2026-09-06'])
  })

  it('never returns weeks before an optional minimum', () => {
    const trips: RawAmazonTrip[] = [
      { id: 't1', periodStart: '2026-09-07', freightAmount: 100 },
    ]
    const weeks = listWeekStarts(trips, new Date('2026-09-30T00:00:00Z'), '2026-09-27')
    expect(weeks).toEqual(['2026-09-27'])
  })
})
