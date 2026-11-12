import { describe, it, expect } from 'vitest'
import { allowanceForServiceYears, benefitYearOf, ptoBalance, validHireDate, formatDays } from './ptoAllowance'

describe('allowance tiers', () => {
  it('0 before one year, 5 at one, 10 from two on', () => {
    expect([0, 1, 2, 3, 9].map(allowanceForServiceYears)).toEqual([0, 5, 10, 10, 10])
  })
})

describe('benefitYearOf', () => {
  it('first year of service has no allowance', () => {
    expect(benefitYearOf('2025-06-10', '2026-06-09')).toEqual({ serviceYears: 0, allowance: 0, start: '2025-06-10', end: '2026-06-09' })
  })
  it('turns to 5 on the first anniversary and 10 on the second', () => {
    expect(benefitYearOf('2025-06-10', '2026-06-10')).toEqual({ serviceYears: 1, allowance: 5, start: '2026-06-10', end: '2027-06-09' })
    expect(benefitYearOf('2025-06-10', '2027-06-10')).toMatchObject({ allowance: 10, start: '2027-06-10', end: '2028-06-09' })
    expect(benefitYearOf('2025-06-10', '2031-01-01')).toMatchObject({ allowance: 10, start: '2030-06-10' })
  })
  it('Feb 29 hires use Feb 28 in common years', () => {
    expect(benefitYearOf('2024-02-29', '2025-02-27')).toMatchObject({ serviceYears: 0, end: '2025-02-27' })
    expect(benefitYearOf('2024-02-29', '2025-02-28')).toMatchObject({ serviceYears: 1, start: '2025-02-28' })
    expect(benefitYearOf('2024-02-29', '2028-02-29')).toMatchObject({ serviceYears: 4, start: '2028-02-29' })
  })
  it('null for no hire date, a bad one, or a date before hire', () => {
    expect(benefitYearOf(null, '2026-01-01')).toBeNull()
    expect(benefitYearOf('soon', '2026-01-01')).toBeNull()
    expect(benefitYearOf('2026-02-30x', '2026-03-01')).toBeNull()
    expect(benefitYearOf('2026-05-01', '2026-04-30')).toBeNull()
    expect(validHireDate('2026-05-01')).toBe(true)
  })
})

describe('ptoBalance', () => {
  const rows = [
    { workDate: '2026-03-02', minutes: 480 }, // before the anniversary: previous benefit year
    { workDate: '2026-07-01', minutes: 480 },
    { workDate: '2026-07-02', minutes: 240 },
    { workDate: '2027-06-09', minutes: 480 }, // last day of that benefit year
    { workDate: '2027-06-10', minutes: 480 }, // next one
  ]
  it('counts only the benefit year holding the date, half days fractional', () => {
    expect(ptoBalance('2025-06-10', '2026-11-11', rows)).toMatchObject({ allowance: 5, used: 2.5, remaining: 2.5, start: '2026-06-10', end: '2027-06-09' })
  })
  it('goes negative when over', () => {
    expect(ptoBalance('2025-06-10', '2026-11-11', [...rows, ...Array.from({ length: 4 }, (_, i) => ({ workDate: `2026-08-0${i + 1}`, minutes: 480 }))])?.remaining).toBe(-1.5)
  })
  it('null without a hire date', () => { expect(ptoBalance(undefined, '2026-11-11', rows)).toBeNull() })
  it('formats days', () => { expect([formatDays(2), formatDays(2.5), formatDays(0.25)]).toEqual(['2', '2.5', '0.25']) })
})
