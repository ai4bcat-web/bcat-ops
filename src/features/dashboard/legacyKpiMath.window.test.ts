import { describe, it, expect } from 'vitest'
import { reduceLegacy, type LegacyMonthPayload } from '@/lib/dashboardRollupLegacy'
import type { Driver } from '@/types'
import { compareLabel, legacyWindow, periodLabel, type DateRangeKey } from './legacyKpiMath'

/** Local noon, so the calendar day is the same in any CI zone. */
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12)
const win = (key: DateRangeKey, y: number, m: number, d: number) => legacyWindow(key, at(y, m, d))

describe('the month so far is read against the same days of last month', () => {
  it('Nov 18 meets Oct 1-18', () => {
    const w = win('this-month', 2026, 11, 18)
    expect([w.from, w.to, w.prevFrom, w.prevTo]).toEqual(['2026-11-01', '2026-11-18', '2026-10-01', '2026-10-18'])
    expect(compareLabel('this-month', w)).toBe('vs. Oct 1–18')
  })

  it('a shorter previous month ends on its own last day (the 30th meets Feb 28, or Feb 29 in a leap year)', () => {
    expect(win('this-month', 2027, 3, 30).prevTo).toBe('2027-02-28')
    expect(compareLabel('this-month', win('this-month', 2027, 3, 30))).toBe('vs. Feb 1–28')
    expect(win('this-month', 2028, 3, 30).prevTo).toBe('2028-02-29')
  })

  it('the first day of the month meets the first day of last month, and January meets December', () => {
    const w = win('this-month', 2026, 11, 1)
    expect([w.from, w.to, w.prevFrom, w.prevTo]).toEqual(['2026-11-01', '2026-11-01', '2026-10-01', '2026-10-01'])
    expect(compareLabel('this-month', w)).toBe('vs. Oct 1')
    const jan = win('this-month', 2027, 1, 15)
    expect([jan.prevFrom, jan.prevTo]).toEqual(['2026-12-01', '2026-12-15'])
  })

  it('the 31st meets the last day of a 30-day month', () => {
    expect(win('this-month', 2026, 12, 31).prevTo).toBe('2026-11-30')
  })
})

describe('the other ranges are cut the same way', () => {
  it('week to date meets the same weekdays last week', () => {
    // Wed Nov 18, 2026: Mon 16th to Wed 18th, against Mon 9th to Wed 11th.
    const w = win('this-week', 2026, 11, 18)
    expect([w.from, w.to, w.prevFrom, w.prevTo]).toEqual(['2026-11-16', '2026-11-18', '2026-11-09', '2026-11-11'])
    expect(compareLabel('this-week', w)).toBe('vs. Nov 9–11')
    // A Sunday is the whole week.
    const sun = win('this-week', 2026, 11, 22)
    expect([sun.from, sun.to, sun.prevFrom, sun.prevTo]).toEqual(['2026-11-16', '2026-11-22', '2026-11-09', '2026-11-15'])
  })

  it('quarter to date meets the same stretch of the previous quarter, never past its end', () => {
    const w = win('this-quarter', 2026, 11, 18) // Oct 1 - Nov 18 is 49 days
    expect([w.from, w.to, w.prevFrom, w.prevTo]).toEqual(['2026-10-01', '2026-11-18', '2026-07-01', '2026-08-18'])
    expect(compareLabel('this-quarter', w)).toBe('vs. Jul 1 – Aug 18')
    // Q2 is 91 days, Q1 only 90: the last day of Q2 meets the last day of Q1.
    expect(win('this-quarter', 2026, 6, 30).prevTo).toBe('2026-03-31')
  })

  it('today is read against yesterday', () => {
    const w = win('today', 2026, 11, 18)
    expect([w.from, w.to, w.prevFrom, w.prevTo]).toEqual(['2026-11-18', '2026-11-18', '2026-11-17', '2026-11-17'])
    expect(compareLabel('today', w)).toBe('vs. yesterday')
  })

  it('formats a period inside one month, across two, and a single day', () => {
    expect(periodLabel(at(2026, 10, 1), at(2026, 10, 18))).toBe('Oct 1–18')
    expect(periodLabel(at(2026, 7, 1), at(2026, 8, 18))).toBe('Jul 1 – Aug 18')
    expect(periodLabel(at(2026, 10, 1), at(2026, 10, 1))).toBe('Oct 1')
  })
})

describe('the change badge counts only the matching days of the previous period', () => {
  const drivers = [{ id: 'ivan', fleetGroup: 'COMPANY', driverType: 'COMPANY' }] as unknown as Driver[]
  const day = (n: number, rev: number) => ({ '|': { n, rev, rated: n } })
  // October: 3 loads/$3,000 by the 18th, then 5 loads/$5,000 after it. November: 4 loads/$4,000 by the 18th.
  const oct: LegacyMonthPayload = { v: 1, days: { '2026-10-04': day(1, 100_000), '2026-10-18': day(2, 200_000), '2026-10-19': day(5, 500_000) } }
  const nov: LegacyMonthPayload = { v: 1, days: { '2026-11-02': day(1, 100_000), '2026-11-18': day(3, 300_000) } }

  it('Nov 18 is +1 load against Oct 1-18 (not -4 against all of October)', () => {
    const w = win('this-month', 2026, 11, 18)
    const k = reduceLegacy([oct, nov], w, drivers)
    expect(k.totalLoads).toBe(4)
    expect(k.totalLoadsDelta).toBe(1)
    expect(k.revenue).toBe(400_000)
    expect(k.revenueDelta).toBe(100_000)
  })

  it('a load picked up later in the month is not counted until its day', () => {
    const later: LegacyMonthPayload = { v: 1, days: { ...nov.days, '2026-11-25': day(7, 700_000) } }
    const k = reduceLegacy([oct, later], win('this-month', 2026, 11, 18), drivers)
    expect(k.totalLoads).toBe(4)
  })

  it('on the first day it is read against the first day of last month', () => {
    const firsts: LegacyMonthPayload = { v: 1, days: { '2026-10-01': day(2, 200_000), '2026-10-02': day(9, 900_000) } }
    const today: LegacyMonthPayload = { v: 1, days: { '2026-11-01': day(3, 300_000) } }
    const k = reduceLegacy([firsts, today], win('this-month', 2026, 11, 1), drivers)
    expect(k.totalLoads).toBe(3)
    expect(k.totalLoadsDelta).toBe(1)
  })
})
