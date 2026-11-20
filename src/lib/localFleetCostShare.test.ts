import { describe, expect, it } from 'vitest'
import { buildCostShare, pieSlices } from './localFleetCostShare'
import type { ReviewMonthInput } from './profitReview'

const month = (over: Partial<ReviewMonthInput>): ReviewMonthInput => ({
  key: '2026-09', label: 'Sep 2026', daysInMonth: 30, daysElapsed: 30, revenue: 10000, fuel: 2000, driverPay: 3000, maintenance: 500,
  insurance: 800, fixed: 1000, miles: 0, loads: 0, gallons: 0, trucks: [], customers: [], unitMaintenance: [], ...over,
})

describe('buildCostShare', () => {
  it('turns fuel, driver pay and maintenance into percents of revenue and ignores insurance', () => {
    const [r] = buildCostShare([month({})])
    expect(r.pct).toEqual({ fuel: 20, driverPay: 30, maintenance: 5 })
    expect(r.controllablePct).toBeCloseTo(55, 9)
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

  it('works out what is left of the revenue after the three costs, and never stacks a negative', () => {
    const [r, over, none] = buildCostShare([month({}), month({ key: '2026-08', label: 'Aug 2026', fuel: 9000 }), month({ key: '2026-05', label: 'May 2026', incomplete: true })])
    expect(r.leftover).toBe(4500)
    expect(r.leftoverPct).toBe(45)
    expect(r.overRevenue).toBe(false)
    expect(over.leftover).toBe(0)
    expect(over.leftoverPct).toBeCloseTo(-25, 0)
    expect(over.overRevenue).toBe(true)
    expect(none.leftover).toBe(0)
    expect(none.leftoverPct).toBeNull()
  })
})

describe('pieSlices', () => {
  it('splits the ring into the three costs and left over, adding up to the whole', () => {
    const [r] = buildCostShare([month({})])
    const slices = pieSlices(r)
    expect(slices.map((s) => s.key)).toEqual(['fuel', 'driverPay', 'maintenance', 'leftover'])
    expect(slices.reduce((a, s) => a + s.fraction, 0)).toBeCloseTo(1, 9)
    expect(slices[0].fraction).toBeCloseTo(0.2, 9)
    expect(slices[3].fraction).toBeCloseTo(0.45, 9)
  })

  it('scales the costs to fill the ring when they exceed revenue, with no left-over slice', () => {
    const [r] = buildCostShare([month({ fuel: 9000 })])
    const slices = pieSlices(r)
    expect(slices.map((s) => s.key)).toEqual(['fuel', 'driverPay', 'maintenance'])
    expect(slices.reduce((a, s) => a + s.fraction, 0)).toBeCloseTo(1, 9)
  })

  it('has no slices for a month without costs or revenue', () => {
    const rows = buildCostShare([month({ incomplete: true }), month({ revenue: 0 })])
    expect(pieSlices(rows[0])).toEqual([])
    expect(pieSlices(rows[1])).toEqual([])
  })
})
