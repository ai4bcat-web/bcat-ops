import { describe, it, expect } from 'vitest'
import { needsHireDate, ptoAllowanceForYear, ptoBalance, ptoStartDate, ptoStartYears, untilLabel, validHireDate, formatDays } from './ptoAllowance'

describe('calendar-year allowance', () => {
  it('hired 2025-06-10: nothing in 2026, 5 in 2027, 10 from 2028', () => {
    expect([2025, 2026, 2027, 2028, 2035].map((y) => ptoAllowanceForYear('2025-06-10', y))).toEqual([0, 0, 5, 10, 10])
    expect(ptoStartDate('2025-06-10')).toBe('2027-01-01')
  })
  it('an anniversary on Jan 1 still waits for the next Jan 1', () => {
    expect(ptoStartYears('2025-01-01')).toEqual({ five: 2027, ten: 2028 })
    expect(ptoStartYears('2025-12-31')).toEqual({ five: 2027, ten: 2028 })
  })
  it('Feb 29 hires use Feb 28 in common years', () => {
    expect(ptoStartYears('2024-02-29')).toEqual({ five: 2026, ten: 2027 })
  })
  it('zero with no usable hire date', () => {
    expect(ptoAllowanceForYear(null, 2030)).toBe(0)
    expect(ptoAllowanceForYear('soon', 2030)).toBe(0)
    expect(ptoStartDate(undefined)).toBeNull()
    expect(validHireDate('2026-02-30x')).toBe(false)
  })
})

describe('ptoBalance', () => {
  const rows = [
    { workDate: '2026-03-02', minutes: 480 },
    { workDate: '2027-03-02', minutes: 480 },
    { workDate: '2027-07-02', minutes: 240 },
    { workDate: '2027-12-31', minutes: 480 },
    { workDate: '2028-01-01', minutes: 480 },
  ]
  it('counts only the calendar year holding the date, half days fractional', () => {
    expect(ptoBalance('2025-06-10', '2027-11-11', rows)).toMatchObject({ year: '2027', allowance: 5, used: 2.5, remaining: 2.5, start: '2027-01-01', end: '2027-12-31' })
  })
  it('allowance 0 before they qualify', () => {
    expect(ptoBalance('2025-06-10', '2026-11-11', rows)).toMatchObject({ allowance: 0, used: 1, remaining: -1 })
  })
  it('goes negative when over', () => {
    expect(ptoBalance('2025-06-10', '2027-11-11', [...rows, ...Array.from({ length: 4 }, (_, i) => ({ workDate: `2027-08-0${i + 1}`, minutes: 480 }))])?.remaining).toBe(-1.5)
  })
  it('null without a hire date', () => { expect(ptoBalance(undefined, '2027-11-11', rows)).toBeNull() })
  it('formats days', () => { expect([formatDays(2), formatDays(2.5), formatDays(0.25)]).toEqual(['2', '2.5', '0.25']) })
})

describe('untilLabel', () => {
  it('days, weeks, months', () => {
    expect(untilLabel('2026-11-12', '2026-11-13')).toBe('in 1 day')
    expect(untilLabel('2026-11-12', '2027-01-01')).toBe('in 7 weeks')
    expect(untilLabel('2026-05-12', '2027-01-01')).toBe('in 8 months')
  })
})

describe('needsHireDate', () => {
  it('flags active Ivan (LOCAL) employees and PTO-eligible drivers with no usable hire date', () => {
    expect(needsHireDate({ active: true, fleetGroup: 'LOCAL', hireDate: '' })).toBe(true)
    expect(needsHireDate({ active: true, fleetGroup: 'LOCAL', hireDate: 'junk' })).toBe(true)
    expect(needsHireDate({ active: true, fleetGroup: 'OWNER_OPERATOR', ptoEligible: true })).toBe(true)
  })
  it('does not flag a driver who has one, contractors, inactive drivers or brokers', () => {
    expect(needsHireDate({ active: true, fleetGroup: 'LOCAL', hireDate: '2025-03-10' })).toBe(false)
    expect(needsHireDate({ active: true, fleetGroup: 'OWNER_OPERATOR', hireDate: '' })).toBe(false)
    expect(needsHireDate({ active: true, fleetGroup: 'BOX_TRUCK' })).toBe(false)
    expect(needsHireDate({ active: false, fleetGroup: 'LOCAL' })).toBe(false)
    expect(needsHireDate({ active: true, type: 'broker', fleetGroup: 'LOCAL' })).toBe(false)
  })
})
