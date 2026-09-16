// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { aggregateAmazon, useAmazonProfitability, type DriverWeekProfit } from './useAmazonProfitability'

const { listAmazonTrips, listDriverPaySettings, listDriverPayDeductions, listDriverPayCredits } = vi.hoisted(() => ({
  listAmazonTrips: vi.fn(),
  listDriverPaySettings: vi.fn(),
  listDriverPayDeductions: vi.fn(),
  listDriverPayCredits: vi.fn(),
}))

vi.mock('@/lib/apiClient', () => ({
  listAmazonTrips: () => listAmazonTrips(),
  listDriverPaySettings: () => listDriverPaySettings(),
  listDriverPayDeductions: () => listDriverPayDeductions(),
  listDriverPayCredits: () => listDriverPayCredits(),
}))

vi.mock('./useDrivers', () => ({ useDrivers: () => ({ drivers: [{ id: 'd1', name: 'Chad' }] }) }))
vi.mock('./useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

beforeEach(() => {
  listAmazonTrips.mockReset()
  listDriverPaySettings.mockReset()
  listDriverPayDeductions.mockReset()
  listDriverPayCredits.mockReset()
})

const row = (overrides: Partial<DriverWeekProfit> & Pick<DriverWeekProfit, 'periodStart'>): DriverWeekProfit => ({
  driverId:    'd1',
  driverName:  'Driver One',
  gross:       700,
  driverPay:   350,
  expenses:    100,
  profit:      250,
  ...overrides,
})

describe('aggregateAmazon', () => {
  it('non-prorated: includes only rows whose periodStart is inside the range', () => {
    const rows: DriverWeekProfit[] = [
      row({ periodStart: '2026-08-23', gross: 100, driverPay: 50, expenses: 20, profit: 30 }),
      row({ periodStart: '2026-08-30', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
      row({ periodStart: '2026-09-06', gross: 200, driverPay: 100, expenses: 40, profit: 60 }),
    ]
    const agg = aggregateAmazon(rows, '2026-09-01', '2026-09-30')
    expect(agg.rows).toHaveLength(1)
    expect(agg.rows[0].periodStart).toBe('2026-09-06')
    expect(agg.profit).toBe(60)
  })

  it('weekly callers keep whole-week behavior (start === end)', () => {
    const rows: DriverWeekProfit[] = [
      row({ periodStart: '2026-08-30', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
    ]
    const agg = aggregateAmazon(rows, '2026-08-30', '2026-08-30')
    expect(agg.profit).toBe(250)
    expect(agg.revenue).toBe(700)
  })

  it('prorated: splits a boundary week across months by days', () => {
    // Week 2026-08-30 (Sun) → 2026-09-05 (Sat). September owns 5 of 7 days.
    const rows: DriverWeekProfit[] = [
      row({ periodStart: '2026-08-30', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
    ]
    const agg = aggregateAmazon(rows, '2026-09-01', '2026-09-30', { prorate: true })
    expect(agg.rows).toHaveLength(1)
    expect(agg.revenue).toBe(500)   // 700 * 5/7
    expect(agg.driverPay).toBe(250) // 350 * 5/7
    expect(agg.expenses).toBe(71.43) // 100 * 5/7
    expect(agg.profit).toBe(178.57) // 250 * 5/7
  })

  it('prorated: a fully-inside week contributes its full amount', () => {
    const rows: DriverWeekProfit[] = [
      row({ periodStart: '2026-09-06', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
    ]
    const agg = aggregateAmazon(rows, '2026-09-01', '2026-09-30', { prorate: true })
    expect(agg.profit).toBe(250)
    expect(agg.revenue).toBe(700)
  })

  it('prorated: an outside week contributes nothing', () => {
    const rows: DriverWeekProfit[] = [
      row({ periodStart: '2026-08-23', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
    ]
    const agg = aggregateAmazon(rows, '2026-09-01', '2026-09-30', { prorate: true })
    expect(agg.rows).toHaveLength(0)
    expect(agg.profit).toBe(0)
  })

  it('prorated: sums multiple overlapping weeks', () => {
    const rows: DriverWeekProfit[] = [
      row({ periodStart: '2026-08-30', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
      row({ periodStart: '2026-09-06', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
      row({ periodStart: '2026-09-27', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
    ]
    const agg = aggregateAmazon(rows, '2026-09-01', '2026-09-30', { prorate: true })
    // Aug 30 week: 5/7; Sep 6 week: 7/7; Sep 27 week: 4/7 (Sep 27-30)
    expect(agg.revenue).toBe(500 + 700 + 400)
    expect(agg.profit).toBeCloseTo(250 * (5 / 7) + 250 + 250 * (4 / 7), 2)
  })

  it('prorated rows preserve profit = gross - driverPay - expenses', () => {
    const rows: DriverWeekProfit[] = [
      row({ periodStart: '2026-08-30', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
    ]
    const agg = aggregateAmazon(rows, '2026-09-01', '2026-09-30', { prorate: true })
    const r = agg.rows[0]
    expect(r.profit).toBe(r.gross - r.driverPay - r.expenses)
  })
})

describe('useAmazonProfitability', () => {
  it('counts the companyAmount of after-split fixed charges as a company expense', async () => {
    listAmazonTrips.mockResolvedValue([
      { id: 't1', driverId: 'd1', periodStart: '2026-09-06', freightAmount: 4_000, status: 'Completed', createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' },
    ])
    listDriverPaySettings.mockResolvedValue([
      {
        id: 's1',
        driverId: 'd1',
        payGroup: 'AMAZON',
        payPercent: 0.5,
        expensesBeforePercent: true,
        fixedExpenses: [
          { label: 'ELD', amount: 20 },
          { label: 'Lease', amount: 496, afterPercent: true, companyAmount: 496 },
        ],
        active: true,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      },
    ])
    listDriverPayDeductions.mockResolvedValue([])
    listDriverPayCredits.mockResolvedValue([])

    const { result } = renderHook(() => useAmazonProfitability())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.rows).toHaveLength(1)
    const r = result.current.rows[0]
    expect(r.gross).toBe(4_000)
    expect(r.driverPay).toBeCloseTo(1_494, 2)
    expect(r.expenses).toBe(20 + 496 + 496)
    expect(r.profit).toBeCloseTo(4_000 - 1_494 - 1_012, 2)
  })
})
