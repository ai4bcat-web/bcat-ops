import { describe, expect, it } from 'vitest'
import { formatPayPeriod, formatWeekLabel, toLocalDateString, addDays, comparePayPeriodDesc } from './payPeriod'

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

describe('comparePayPeriodDesc', () => {
  it('orders newest ISO week first, legacy text after every ISO week, blanks last', () => {
    const rows = ['4/19 - 4/25', '2026-09-06', '', '2026-09-13', '2025-12-28']
    expect([...rows].sort(comparePayPeriodDesc)).toEqual(['2026-09-13', '2026-09-06', '2025-12-28', '4/19 - 4/25', ''])
    expect(comparePayPeriodDesc(undefined, '')).toBe(0)
    expect(comparePayPeriodDesc(undefined, '4/19 - 4/25')).toBeGreaterThan(0)
  })

  it('treats equal periods as ties so the caller decides', () => {
    expect(comparePayPeriodDesc('2026-09-06', '2026-09-06')).toBe(0)
    expect(comparePayPeriodDesc('4/19 - 4/25', '5/3 - 5/9')).toBe(0)
  })
})
