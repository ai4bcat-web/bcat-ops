import { describe, expect, it } from 'vitest'
import { payCadence } from './payrollCadence'

describe('payCadence', () => {
  it('on a Wednesday (Chicago) the pay date is today and covers the Sun–Sat week that closed four days ago', () => {
    const c = payCadence(new Date('2026-11-04T18:00:00Z')) // Wed 12:00 CST
    expect(c).toMatchObject({ nextPayDate: '2026-11-04', isToday: true, periodStart: '2026-10-25', periodEnd: '2026-10-31' })
    expect(c.label).toBe('Payroll runs every Wednesday · Pay date is today · Covers Sun Oct 25 – Sat Oct 31')
  })

  it('rolls forward to the next Wednesday from any other weekday', () => {
    const thu = payCadence(new Date('2026-11-05T18:00:00Z'))
    expect(thu).toMatchObject({ nextPayDate: '2026-11-11', isToday: false, periodStart: '2026-11-01', periodEnd: '2026-11-07' })
    expect(thu.label).toBe('Payroll runs every Wednesday · Next pay date Wed Nov 11 · Covers Sun Nov 1 – Sat Nov 7')
    expect(payCadence(new Date('2026-11-03T18:00:00Z')).nextPayDate).toBe('2026-11-04')
  })

  it('uses the Chicago calendar day, not UTC', () => {
    // Wed 00:30 UTC is still Tuesday evening in Chicago.
    expect(payCadence(new Date('2026-11-04T00:30:00Z')).nextPayDate).toBe('2026-11-04')
    expect(payCadence(new Date('2026-11-04T00:30:00Z')).isToday).toBe(false)
    // Thu 03:00 UTC is still Wednesday night in Chicago.
    expect(payCadence(new Date('2026-11-05T03:00:00Z')).isToday).toBe(true)
  })

  it('keeps whole days across the DST change and a year boundary', () => {
    // US fall-back was Sun Nov 1 2026: the covered week spans it.
    const c = payCadence(new Date('2026-11-04T18:00:00Z'))
    expect(c.periodStart).toBe('2026-10-25')
    const ny = payCadence(new Date('2027-01-01T18:00:00Z')) // Fri
    expect(ny).toMatchObject({ nextPayDate: '2027-01-06', periodStart: '2026-12-27', periodEnd: '2027-01-02' })
  })
})
