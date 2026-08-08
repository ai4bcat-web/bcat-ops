import { describe, it, expect } from 'vitest'
import { milesByTruck, mpg, formatMpg, formatMiles, mpgTone, recentWeeks, weeklyTotals } from './fuelEfficiency'
import type { TruckMileage } from '@/lib/apiClient'

const row = (over: Partial<TruckMileage>): TruckMileage => ({
  truckId: 't1', unitNumber: '101', periodStart: '2026-08-03', periodType: 'DAY',
  miles: 100, source: 'motive', syncedAt: '', createdAt: '', updatedAt: '', ...over,
})

const AUG = [new Date(2026, 7, 1), new Date(2026, 7, 31)] as [Date, Date]

describe('milesByTruck', () => {
  it('sums the daily rows for each truck', () => {
    const m = milesByTruck([
      row({ truckId: 't1', miles: 420 }),
      row({ truckId: 't1', periodStart: '2026-08-04', miles: 380 }),
      row({ truckId: 't2', miles: 190 }),
    ], AUG)
    expect(m.get('t1')).toBe(800)
    expect(m.get('t2')).toBe(190)
  })

  it('ignores days outside the selected range', () => {
    const m = milesByTruck([
      row({ miles: 500, periodStart: '2026-07-30' }),   // previous month
      row({ miles: 300, periodStart: '2026-08-05' }),
      row({ miles: 700, periodStart: '2026-09-01' }),   // next month
    ], AUG)
    expect(m.get('t1')).toBe(300)
  })

  it('includes the first and last day of the range', () => {
    const m = milesByTruck([
      row({ miles: 10, periodStart: '2026-08-01' }),
      row({ miles: 20, periodStart: '2026-08-31' }),
    ], AUG)
    expect(m.get('t1')).toBe(30)
  })

  it('leaves a truck with no rows absent rather than zero', () => {
    expect(milesByTruck([], AUG).has('t1')).toBe(false)
  })

  it('tolerates a null/absent mileage value', () => {
    const m = milesByTruck([row({ miles: undefined as unknown as number }), row({ miles: 50, periodStart: '2026-08-06' })], AUG)
    expect(m.get('t1')).toBe(50)
  })
})

describe('mpg', () => {
  it('divides miles by gallons', () => {
    expect(mpg(6000, 1000)).toBe(6)
  })

  it('is unknown — not zero — without gallons', () => {
    // A truck whose fuel card did not post yet has UNKNOWN efficiency. Reporting
    // 0.0 MPG would read as a catastrophic truck rather than missing data.
    expect(mpg(800, 0)).toBeNull()
  })

  it('is unknown without miles, so a fuel-only truck does not show 0', () => {
    expect(mpg(0, 120)).toBeNull()
  })
})

describe('formatting', () => {
  it('shows one decimal', () => {
    expect(formatMpg(6.44)).toBe('6.4')
    expect(formatMpg(7)).toBe('7.0')
  })

  it('renders unknown as an em dash in both formatters', () => {
    expect(formatMpg(null)).toBe('—')
    expect(formatMiles(0)).toBe('—')
  })

  it('separates thousands', () => {
    expect(formatMiles(12500)).toBe('12,500')
  })
})

describe('mpgTone', () => {
  it('flags a tractor burning too much', () => {
    expect(mpgTone(4.2)).toBe('poor')
  })

  it('reads a normal tractor as ok and a strong one as good', () => {
    expect(mpgTone(6.0)).toBe('ok')
    expect(mpgTone(7.1)).toBe('good')
  })

  it('has no opinion when MPG is unknown', () => {
    expect(mpgTone(null)).toBe('none')
  })
})

describe('recentWeeks', () => {
  // The user's reference week: 5/31/2026 (Sunday) through 6/6/2026 (Saturday).
  it('runs Sunday through Saturday', () => {
    const [w] = recentWeeks(1, new Date(2026, 5, 3))   // Wed 6/3/2026
    expect(w.start).toBe('2026-05-31')
    expect(w.end).toBe('2026-06-06')
    expect(w.label).toBe('5/31 – 6/6')
  })

  it('treats Sunday itself as the start of its own week, not the end of the last', () => {
    const [w] = recentWeeks(1, new Date(2026, 4, 31))  // Sun 5/31
    expect(w.start).toBe('2026-05-31')
  })

  it('includes Saturday in the same week', () => {
    const [w] = recentWeeks(1, new Date(2026, 5, 6))   // Sat 6/6
    expect(w.start).toBe('2026-05-31')
    expect(w.end).toBe('2026-06-06')
  })

  it('walks backwards, newest first, across a month boundary', () => {
    const weeks = recentWeeks(3, new Date(2026, 5, 3))
    expect(weeks.map((w) => w.label)).toEqual(['5/31 – 6/6', '5/24 – 5/30', '5/17 – 5/23'])
  })

  it('crosses a year boundary without breaking', () => {
    const weeks = recentWeeks(2, new Date(2027, 0, 5))  // Tue 1/5/2027
    expect(weeks[0].start).toBe('2027-01-03')
    expect(weeks[1].start).toBe('2026-12-27')
  })
})

describe('weeklyTotals', () => {
  const weeks = recentWeeks(2, new Date(2026, 5, 3))   // 5/31–6/6, 5/24–5/30
  const entries = [
    { day: '2026-06-01', amount: 1200, gallons: 300, truckId: 't1' },
    { day: '2026-06-04', amount: 800,  gallons: 200, truckId: 't2' },
    { day: '2026-05-26', amount: 400,  gallons: 100, truckId: 't1' },
  ]
  const miles = [
    row({ truckId: 't1', periodStart: '2026-06-01', miles: 1500 }),
    row({ truckId: 't2', periodStart: '2026-06-04', miles: 1300 }),
    row({ truckId: 't1', periodStart: '2026-05-26', miles: 600 }),
  ]

  it('rolls the whole fleet up per week', () => {
    const [thisWeek, lastWeek] = weeklyTotals(entries, miles, weeks, null)
    expect(thisWeek.spend).toBe(2000)
    expect(thisWeek.gallons).toBe(500)
    expect(thisWeek.miles).toBe(2800)
    expect(thisWeek.mpg).toBeCloseTo(5.6)
    expect(lastWeek.spend).toBe(400)
    expect(lastWeek.miles).toBe(600)
  })

  it('narrows to a single truck', () => {
    const [thisWeek] = weeklyTotals(entries, miles, weeks, 't1')
    expect(thisWeek.spend).toBe(1200)
    expect(thisWeek.miles).toBe(1500)
    expect(thisWeek.mpg).toBeCloseTo(5)
  })

  it('keeps a quiet week rather than dropping it — a gap is information', () => {
    const quiet = weeklyTotals([], [], weeks, null)
    expect(quiet).toHaveLength(2)
    expect(quiet[0].spend).toBe(0)
    expect(quiet[0].mpg).toBeNull()
  })

  it('does not leak a purchase into the neighbouring week', () => {
    // 5/30 is Saturday — the LAST day of the older week, not the first of the newer.
    const [thisWeek, lastWeek] = weeklyTotals(
      [{ day: '2026-05-30', amount: 100, gallons: 25, truckId: 't1' }], [], weeks, null)
    expect(thisWeek.spend).toBe(0)
    expect(lastWeek.spend).toBe(100)
  })
})
