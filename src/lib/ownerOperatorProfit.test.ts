import { describe, it, expect } from 'vitest'
import { aggregateOwnerOperator, ownerOperatorWeeksFromLoads, type OwnerOpWeekProfit } from './ownerOperatorProfit'

const row = (overrides: Partial<OwnerOpWeekProfit> & Pick<OwnerOpWeekProfit, 'periodStart'>): OwnerOpWeekProfit => ({
  driverId:   'd1',
  driverName: 'Driver One',
  gross:      700,
  driverPay:  350,
  expenses:   100,
  profit:     250,
  ...overrides,
})

describe('aggregateOwnerOperator', () => {
  it('non-prorated: includes only rows whose periodStart is inside the range', () => {
    const rows = [
      row({ periodStart: '2026-09-27', gross: 100, driverPay: 50, expenses: 20, profit: 30 }),
      row({ periodStart: '2026-10-04', gross: 700, driverPay: 350, expenses: 100, profit: 250 }),
    ]
    const agg = aggregateOwnerOperator(rows, '2026-10-01', '2026-10-31')
    expect(agg.rows).toHaveLength(1)
    expect(agg.rows[0].periodStart).toBe('2026-10-04')
    expect(agg.profit).toBe(250)
  })

  it('weekly callers keep whole-week behavior (start === end)', () => {
    const rows = [row({ periodStart: '2026-09-27', gross: 4_000, driverPay: 3_500, expenses: 20, profit: 480 })]
    const agg = aggregateOwnerOperator(rows, '2026-09-27', '2026-09-27')
    expect(agg.revenue).toBe(4_000)
    expect(agg.driverPay).toBe(3_500)
    expect(agg.expenses).toBe(20)
    expect(agg.profit).toBe(480)
  })

  it('prorated: splits a boundary week across months by days', () => {
    // Week 2026-09-27 (Sun) → 2026-10-03 (Sat). September owns 4 of 7 days.
    const rows = [row({ periodStart: '2026-09-27', gross: 700, driverPay: 350, expenses: 100, profit: 250 })]
    const agg = aggregateOwnerOperator(rows, '2026-09-01', '2026-09-30', { prorate: true })
    expect(agg.revenue).toBe(400)   // 700 * 4/7
    expect(agg.driverPay).toBe(200) // 350 * 4/7
    expect(agg.expenses).toBe(57.14)
    expect(agg.profit).toBeCloseTo(250 * (4 / 7), 2)
  })

  it('prorated: an outside week contributes nothing', () => {
    const rows = [row({ periodStart: '2026-09-27' })]
    const agg = aggregateOwnerOperator(rows, '2026-11-01', '2026-11-30', { prorate: true })
    expect(agg.rows).toHaveLength(0)
    expect(agg.profit).toBe(0)
  })

  it('prorated rows preserve profit = gross - driverPay - expenses', () => {
    const rows = [row({ periodStart: '2026-09-27', gross: 700, driverPay: 350, expenses: 100, profit: 250 })]
    const agg = aggregateOwnerOperator(rows, '2026-09-01', '2026-09-30', { prorate: true })
    const r = agg.rows[0]
    expect(r.profit).toBe(r.gross - r.driverPay - r.expenses)
  })
})

describe('ownerOperatorWeeksFromLoads', () => {
  it('maps each delivered load to its Sunday pay week, newest first', () => {
    const weeks = ownerOperatorWeeksFromLoads([
      { deliveryDriverId: 'd1', deliveryAppt: '2026-09-30T14:00:00Z' }, // Wed of the 9/27 week
      { deliveryDriverId: 'd1', deliveryAppt: '2026-10-05T09:00:00Z' }, // Mon of the 10/4 week
      { deliveryDriverId: 'd1', deliveryAppt: '2026-10-03T23:00:00Z' }, // Sat of the 9/27 week
    ], 'd1')
    expect(weeks).toEqual(['2026-10-04', '2026-09-27'])
  })

  it('drops loads delivered before the owner-operator changeover', () => {
    // 2026-09-26 is the Saturday before OWNER_OP_FIRST_PERIOD (2026-09-27): that week
    // still settles on the Amazon statement, so it must not produce a contribution.
    const weeks = ownerOperatorWeeksFromLoads([
      { deliveryDriverId: 'd1', deliveryAppt: '2026-09-26T14:00:00Z' },
      { deliveryDriverId: 'd1', deliveryAppt: '2026-09-20T14:00:00Z' },
    ], 'd1')
    expect(weeks).toEqual([])
  })

  it('counts the changeover day itself', () => {
    const weeks = ownerOperatorWeeksFromLoads([
      { deliveryDriverId: 'd1', deliveryAppt: '2026-09-27T14:00:00Z' },
    ], 'd1')
    expect(weeks).toEqual(['2026-09-27'])
  })

  it('ignores loads delivered by another driver or with no delivery date', () => {
    const weeks = ownerOperatorWeeksFromLoads([
      { deliveryDriverId: 'd2', deliveryAppt: '2026-09-30T14:00:00Z' },
      { deliveryDriverId: 'd1', deliveryAppt: null },
    ], 'd1')
    expect(weeks).toEqual([])
  })
})
