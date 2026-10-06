/**
 * MPG by truck. Nearly all of this is about refusing to show a number that is not real —
 * a fuel figure people plan around is worse than useless when it is invented.
 */
import { describe, it, expect } from 'vitest'
import { mpgOf, weeklyMpg, weekOverWeek, type MileageRow } from './truckMpg'

const row = (over: Partial<MileageRow>): MileageRow => ({
  truckId: 't1', unitNumber: '0012', periodStart: '2026-09-28', periodType: 'WEEK',
  miles: 1000, gallons: 160, ...over,
})

describe('mpgOf', () => {
  it('divides miles by gallons to one decimal', () => {
    expect(mpgOf(1000, 160)).toBe(6.3)
  })

  it('is null with no fuel recorded', () => {
    // Motive had no fuel for this truck; that is missing data, not a bad figure.
    expect(mpgOf(1000, null)).toBeNull()
    expect(mpgOf(1000, undefined)).toBeNull()
  })

  it('is null rather than Infinity when gallons are zero', () => {
    expect(mpgOf(1000, 0)).toBeNull()
  })

  it('is null rather than 0.0 when the truck did not move', () => {
    /*
     * A truck that sat still has no fuel economy — it has no data. "0.0 MPG" reads as a
     * catastrophic figure rather than an absent one, and somebody would go looking for a
     * fault that is not there.
     */
    expect(mpgOf(0, 160)).toBeNull()
  })

  it('refuses negatives and nonsense', () => {
    expect(mpgOf(-100, 160)).toBeNull()
    expect(mpgOf(1000, -5)).toBeNull()
    expect(mpgOf(Number.NaN, 160)).toBeNull()
  })
})

describe('weeklyMpg', () => {
  it('returns one entry per week, newest first', () => {
    const series = weeklyMpg([
      row({ periodStart: '2026-09-14', miles: 900, gallons: 150 }),
      row({ periodStart: '2026-09-28', miles: 1000, gallons: 160 }),
      row({ periodStart: '2026-09-21', miles: 800, gallons: 128 }),
    ], 't1')
    expect(series.map((s) => s.periodStart)).toEqual(['2026-09-28', '2026-09-21', '2026-09-14'])
    expect(series[0].mpg).toBe(6.3)
  })

  it('ignores other trucks', () => {
    expect(weeklyMpg([row({ truckId: 't2' })], 't1')).toEqual([])
  })

  it('ignores day, month and year rows', () => {
    // A single day is too short to say anything about fuel economy.
    const rows = ['DAY', 'MONTH', 'YEAR'].map((periodType) => row({ periodType }))
    expect(weeklyMpg(rows, 't1')).toEqual([])
  })

  it('keeps a week with no fuel, with a null figure', () => {
    // The miles are still worth showing; only the MPG is unknown.
    const series = weeklyMpg([row({ gallons: null })], 't1')
    expect(series[0].miles).toBe(1000)
    expect(series[0].mpg).toBeNull()
  })
})

describe('week over week', () => {
  it('compares the two most recent weeks that have a figure', () => {
    const r = weekOverWeek([
      { periodStart: '2026-09-28', miles: 1000, gallons: 160, mpg: 6.3 },
      { periodStart: '2026-09-21', miles: 800, gallons: 160, mpg: 5.0 },
    ])
    expect(r.current).toBe(6.3)
    expect(r.previous).toBe(5.0)
    expect(r.deltaPct).toBe(26)
  })

  it('skips past a week with no fuel data rather than comparing to nothing', () => {
    const r = weekOverWeek([
      { periodStart: '2026-09-28', miles: 1000, gallons: 160, mpg: 6.3 },
      { periodStart: '2026-09-21', miles: 800, gallons: null, mpg: null },
      { periodStart: '2026-09-14', miles: 900, gallons: 180, mpg: 5.0 },
    ])
    expect(r.previous).toBe(5.0)
    expect(r.deltaPct).toBe(26)
  })

  it('reports no change when there is only one week', () => {
    // A trend needs two points. Inventing one from a gap in the feed is worse than silence.
    const r = weekOverWeek([{ periodStart: '2026-09-28', miles: 1000, gallons: 160, mpg: 6.3 }])
    expect(r.current).toBe(6.3)
    expect(r.previous).toBeNull()
    expect(r.deltaPct).toBeNull()
  })

  it('is empty all round with nothing to go on', () => {
    expect(weekOverWeek([])).toEqual({ current: null, previous: null, deltaPct: null })
  })

  it('shows a drop as a negative', () => {
    const r = weekOverWeek([
      { periodStart: '2026-09-28', miles: 800, gallons: 160, mpg: 5.0 },
      { periodStart: '2026-09-21', miles: 1000, gallons: 160, mpg: 6.3 },
    ])
    expect(r.deltaPct).toBeLessThan(0)
  })
})
