import { describe, expect, it } from 'vitest'
import { formatPayPeriod, formatWeekLabel, toLocalDateString, addDays } from './payPeriod'

describe('pay period labels', () => {
  it('labels a Sunday–Saturday week with the year once', () => {
    expect(formatPayPeriod('2026-09-06')).toBe('Sep 6 – Sep 12, 2026')
  })

  it('shows both years when the week crosses New Year', () => {
    expect(formatPayPeriod('2024-12-29')).toBe('Dec 29, 2024 – Jan 4, 2025')
  })

  it('passes legacy Google-Form text through untouched', () => {
    expect(formatPayPeriod('4/19 - 4/25')).toBe('4/19 - 4/25')
    expect(formatPayPeriod('2026-13-99')).toBe('2026-13-99')
  })

  it('dropdown value and label agree', () => {
    const sunday = new Date(2026, 8, 6)
    expect(toLocalDateString(sunday)).toBe('2026-09-06')
    expect(formatWeekLabel(sunday)).toBe(formatPayPeriod('2026-09-06'))
    expect(toLocalDateString(addDays(sunday, 6))).toBe('2026-09-12')
  })
})
