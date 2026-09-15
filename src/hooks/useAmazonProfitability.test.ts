import { describe, it, expect } from 'vitest'
import { aggregateAmazon, type DriverWeekProfit } from './useAmazonProfitability'

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
