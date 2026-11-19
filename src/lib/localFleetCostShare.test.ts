import { describe, expect, it } from 'vitest'
import { buildCostShare } from './localFleetCostShare'
import type { ReviewMonthInput } from './profitReview'

const month = (over: Partial<ReviewMonthInput>): ReviewMonthInput => ({
  key: '2026-09', label: 'Sep 2026', daysInMonth: 30, daysElapsed: 30, revenue: 10000, fuel: 2000, driverPay: 3000, maintenance: 500,
  insurance: 800, fixed: 1000, miles: 0, loads: 0, gallons: 0, trucks: [], customers: [], unitMaintenance: [], ...over,
})

describe('buildCostShare', () => {
  it('turns each category into a percent of revenue', () => {
    const [r] = buildCostShare([month({})])
    expect(r.pct).toEqual({ fuel: 20, driverPay: 30, insurance: 8, maintenance: 5 })
    expect(r.month).toBe('Sep')
  })

  it('leaves shares empty when there is no revenue or no costs on file, without dividing by zero', () => {
    const rows = buildCostShare([month({ revenue: 0 }), month({ key: '2026-05', label: 'May 2026', incomplete: true })])
    expect(rows[0].pct.fuel).toBeNull()
    expect(rows[1].noCosts).toBe(true)
    expect(rows[1].pct.driverPay).toBeNull()
    expect(rows[1].revenue).toBe(10000)
  })

  it('marks the running month as partial', () => {
    const [r] = buildCostShare([month({ daysElapsed: 19 })])
    expect(r.partial).toBe(true)
  })

  it('flags a month whose driver pay is zero or far below the other months', () => {
    const rows = buildCostShare([
      month({ key: '2026-08', label: 'Aug 2026' }),
      month({ key: '2026-09', label: 'Sep 2026' }),
      month({ key: '2026-10', label: 'Oct 2026' }),
      month({ key: '2026-11', label: 'Nov 2026', daysElapsed: 19, driverPay: 900 }),
    ])
    expect(rows[3].lowEntry).toEqual(['driverPay'])
    expect(rows[0].lowEntry).toEqual([])
    const zero = buildCostShare([month({ fuel: 0 })])
    expect(zero[0].lowEntry).toEqual(['fuel'])
  })
})
