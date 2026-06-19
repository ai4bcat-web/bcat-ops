import { describe, it, expect } from 'vitest'
import { biweeklyPeriodOf } from './payPeriods'

describe('biweeklyPeriodOf', () => {
  it('returns the 6/8–6/21 period for a date inside it', () => {
    expect(biweeklyPeriodOf(new Date(2026, 5, 19))).toEqual({ start: '2026-06-08', end: '2026-06-21' })
  })

  it('aligns to the 14-day anchor on boundaries and across periods', () => {
    expect(biweeklyPeriodOf(new Date(2026, 5, 8))).toEqual({ start: '2026-06-08', end: '2026-06-21' })  // first day
    expect(biweeklyPeriodOf(new Date(2026, 5, 21))).toEqual({ start: '2026-06-08', end: '2026-06-21' }) // last day
    expect(biweeklyPeriodOf(new Date(2026, 5, 22))).toEqual({ start: '2026-06-22', end: '2026-07-05' }) // next period
    expect(biweeklyPeriodOf(new Date(2026, 5, 7))).toEqual({ start: '2026-05-25', end: '2026-06-07' })  // previous period
  })
})
