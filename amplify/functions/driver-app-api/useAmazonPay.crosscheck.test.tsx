// @vitest-environment jsdom
/**
 * Cross-implementation check between the driver-app settlement composition
 * (amplify/functions/driver-app-api/settlement.ts) and the staff UI composition
 * (src/hooks/useAmazonPay.ts). Both must produce the same gross, deductions, and
 * final check amount for identical fixtures; if they diverge, a driver and the office
 * will disagree about pay.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useAmazonPay } from '../../../src/hooks/useAmazonPay'
import { buildSettlement } from './settlement'

const DRIVER_ID = 'drv-crosscheck'
const DRIVER_NAME = 'Cross Check'
const WEEK_START = '2026-09-21'

// Minimal local shapes that satisfy the hook's structural types.
interface TestDriver {
  id: string
  name: string
  phone: string
  active: boolean
  email?: string | null
  createdAt: string
  updatedAt: string
}

interface TestTrip {
  id: string
  driverId: string
  periodStart: string
  freightAmount: number
  loadId?: string | null
  origin?: string | null
  destination?: string | null
  miles?: number | null
  ratePerMile?: number | null
  status?: string | null
  sortOrder?: number | null
  createdAt: string
  updatedAt: string
}

interface TestSetting {
  id: string
  driverId: string
  payGroup: 'AMAZON' | null
  payPercent: number
  expensesBeforePercent: boolean
  active: boolean
  fuelCardNumber: string
  fixedExpenses: unknown
  rateHistory: unknown
  createdAt: string
  updatedAt: string
}

interface TestDeduction {
  id: string
  driverId: string
  periodStart: string
  label: string
  amount: number
  date?: string | null
  createdAt: string
  updatedAt: string
}

interface TestCredit {
  id: string
  driverId: string
  periodStart: string
  kind: 'CREDIT' | 'DEBIT'
  reasonCode: string
  label?: string | null
  amount: number
  miles?: number | null
  costPerMile?: number | null
  date?: string | null
  createdAt: string
  updatedAt: string
}

interface TestFuelTx {
  id: string
  transactionDate: string
  cardNumber: string
  fuelType: string
  itemCategory?: string
  amount: number
  quantity: number
  pricePerUnit: number
  createdAt: string
  updatedAt: string
}

const driver: TestDriver = {
  id: DRIVER_ID,
  name: DRIVER_NAME,
  phone: '+15555551234',
  active: true,
  email: 'cross@example.com',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const setting: TestSetting = {
  id: 'set-crosscheck',
  driverId: DRIVER_ID,
  payGroup: 'AMAZON',
  payPercent: 0.88,
  expensesBeforePercent: false,
  active: true,
  fuelCardNumber: '00007',
  fixedExpenses: [
    { label: 'Insurance', amount: 200.0, from: '2026-09-01' },
    // Partial-week fixed expense to exercise proration and rounding.
    { label: 'Prorated fee', amount: 70.0, from: '2026-09-21', until: '2026-09-23' },
    { label: 'Lease mileage', amount: 30.0, from: '2026-09-21', afterPercent: true, mileage: { miles: 100, costPerMile: 0.3 } },
  ],
  rateHistory: [
    // Override NOT active this week, so the base 0.88 applies. Include it to prove we parse it.
    { from: '2026-08-01', until: '2026-08-31', payPercent: 0.42, expensesBeforePercent: true },
  ],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const trips: TestTrip[] = [
  {
    id: 'trip-1',
    driverId: DRIVER_ID,
    periodStart: WEEK_START,
    freightAmount: 1234.56,
    loadId: 'LOAD-1',
    origin: 'Joliet, IL',
    destination: 'Indianapolis, IN',
    miles: 180,
    ratePerMile: 6.8587,
    status: 'Completed',
    sortOrder: 1,
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z',
  },
  {
    id: 'trip-2',
    driverId: DRIVER_ID,
    periodStart: WEEK_START,
    freightAmount: 987.65,
    loadId: 'LOAD-2',
    origin: 'Chicago, IL',
    destination: 'Detroit, MI',
    miles: 240,
    ratePerMile: 4.1152,
    status: 'Completed',
    sortOrder: 2,
    createdAt: '2026-09-23T00:00:00Z',
    updatedAt: '2026-09-23T00:00:00Z',
  },
  // A duplicate loadId from the previous week — staff flags it but still pays it.
  {
    id: 'trip-3',
    driverId: DRIVER_ID,
    periodStart: WEEK_START,
    freightAmount: 555.55,
    loadId: 'LOAD-DUP',
    status: 'Completed',
    sortOrder: 3,
    createdAt: '2026-09-24T00:00:00Z',
    updatedAt: '2026-09-24T00:00:00Z',
  },
]

const previousWeekTrip: TestTrip = {
  id: 'trip-prev',
  driverId: DRIVER_ID,
  periodStart: '2026-09-14',
  freightAmount: 100,
  loadId: 'LOAD-DUP',
  status: 'Completed',
  sortOrder: 1,
  createdAt: '2026-09-15T00:00:00Z',
  updatedAt: '2026-09-15T00:00:00Z',
}

const deductions: TestDeduction[] = [
  { id: 'ded-1', driverId: DRIVER_ID, periodStart: WEEK_START, label: 'Toll fine', amount: 75.5, createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z' },
]

const credits: TestCredit[] = [
  { id: 'cred-1', driverId: DRIVER_ID, periodStart: WEEK_START, kind: 'CREDIT', reasonCode: 'DETENTION', label: 'Kroger wait', amount: 120.0, date: '2026-09-22', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z' },
]

const debits: TestCredit[] = [
  { id: 'deb-1', driverId: DRIVER_ID, periodStart: WEEK_START, kind: 'DEBIT', reasonCode: 'CASH_ADVANCE', label: 'advance', amount: 50.0, date: '2026-09-23', createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' },
]

const fuelTxs: TestFuelTx[] = [
  { id: 'fuel-1', transactionDate: '2026-09-22', cardNumber: '00007', fuelType: 'ULSD', itemCategory: 'FUEL', amount: 180.25, quantity: 50, pricePerUnit: 3.605, createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z' },
  // Non-fuel line must be ignored by both implementations.
  { id: 'fuel-2', transactionDate: '2026-09-22', cardNumber: '00007', fuelType: 'SCLE', itemCategory: 'SCALE', amount: 12.0, quantity: 1, pricePerUnit: 12.0, createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z' },
  // Wrong card must be ignored.
  { id: 'fuel-3', transactionDate: '2026-09-23', cardNumber: '00099', fuelType: 'ULSD', itemCategory: 'FUEL', amount: 300.0, quantity: 80, pricePerUnit: 3.75, createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' },
]

vi.mock('../../../src/hooks/useFuelTransactions', () => ({
  useFuelTransactions: () => ({ transactions: fuelTxs, loading: false, error: null, refresh: vi.fn() }),
}))

vi.mock('../../../src/hooks/useDrivers', () => ({
  useDrivers: () => ({ drivers: [driver], updateDriver: vi.fn() }),
}))

vi.mock('../../../src/lib/apiClient', () => ({
  listAmazonTrips: async () => [...trips, previousWeekTrip],
  listDriverPaySettings: async () => [setting],
  listDriverPayDeductions: async () => deductions,
  listDriverPayCredits: async () => [...credits, ...debits],
}))

describe('useAmazonPay vs buildSettlement cross-check', () => {
  it('produces the same gross, deduction total, and check amount for identical fixtures', async () => {
    const { result } = renderHook(() => useAmazonPay(WEEK_START))

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0), { timeout: 3000 })

    const staffRow = result.current.rows.find((r) => r.driver.id === DRIVER_ID)
    if (!staffRow) {
      throw new Error('useAmazonPay did not produce a row for the test driver')
    }

    const serverSettlement = buildSettlement(
      WEEK_START,
      trips,
      {
        payPercent: setting.payPercent,
        expensesBeforePercent: setting.expensesBeforePercent,
        // The handler hands buildSettlement the whole setting row; the pay group is what
        // decides there is no factoring fee on an Amazon statement.
        payGroup: setting.payGroup,
        fuelCardNumber: setting.fuelCardNumber,
        fixedExpenses: setting.fixedExpenses,
        rateHistory: setting.rateHistory,
      },
      deductions.map((d) => ({ label: d.label, amount: d.amount })),
      credits.map((c) => ({
        kind: c.kind,
        reasonCode: c.reasonCode,
        label: c.label,
        amount: c.amount,
        miles: c.miles,
        costPerMile: c.costPerMile,
        date: c.date,
      })),
      debits.map((c) => ({
        kind: c.kind,
        reasonCode: c.reasonCode,
        label: c.label,
        amount: c.amount,
        miles: c.miles,
        costPerMile: c.costPerMile,
        date: c.date,
      })),
      fuelTxs.map((f) => ({
        transactionDate: f.transactionDate,
        cardNumber: f.cardNumber,
        fuelType: f.fuelType,
        itemCategory: f.itemCategory,
        amount: f.amount,
        quantity: f.quantity,
      })),
    )

    const staffDeductionsTotal = staffRow.statement.totalDeductions
    const serverDeductionsTotal = serverSettlement.deductions.reduce((s, d) => s + d.amount, 0)

    expect(serverSettlement.grossPay).toBe(staffRow.statement.gross)
    expect(serverDeductionsTotal).toBe(staffDeductionsTotal)
    expect(serverSettlement.checkAmount).toBe(staffRow.statement.checkAmount)

    // Sanity-check that the fixtures actually exercised the interesting branches.
    expect(serverSettlement.grossPay).toBeCloseTo(2777.76, 2)
    expect(serverSettlement.deductions.some((d) => d.label.includes('Prorated fee'))).toBe(true)
    expect(serverSettlement.deductions.some((d) => d.label.includes('Fuel (card 00007)'))).toBe(true)
    expect(serverSettlement.debits.some((d) => d.label.includes('Lease mileage'))).toBe(true)
  })
})
