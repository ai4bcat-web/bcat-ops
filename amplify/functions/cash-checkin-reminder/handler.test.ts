/**
 * cash-checkin-reminder — the due-date rule is the whole behaviour, so it is tested
 * directly. Payroll anchor Fri 2026-09-11; payrolls then fall on 09-25, 10-09, …
 */
import { describe, expect, it } from 'vitest'
import { reminderDuePayroll, reminderText } from './handler'

describe('reminderDuePayroll', () => {
  const anchor = '2026-09-11'

  it('is due the morning after the anchor and after every 14th day, not on other days', () => {
    expect(reminderDuePayroll(anchor, [], '2026-09-12')).toBe('2026-09-11')
    expect(reminderDuePayroll(anchor, [], '2026-09-26')).toBe('2026-09-25')
    expect(reminderDuePayroll(anchor, [], '2026-10-10')).toBe('2026-10-09')
    expect(reminderDuePayroll(anchor, [], '2026-09-11')).toBeNull() // payroll day itself
    expect(reminderDuePayroll(anchor, [], '2026-09-13')).toBeNull()
    expect(reminderDuePayroll(anchor, [], '2026-09-19')).toBeNull() // one week, not two
  })

  it('is never due before the anchor or without one', () => {
    expect(reminderDuePayroll(anchor, [], '2026-09-01')).toBeNull()
    expect(reminderDuePayroll('', [], '2026-09-12')).toBeNull()
    expect(reminderDuePayroll('not a date', [], '2026-09-12')).toBeNull()
  })

  it('is suppressed once a check-in dated on or after that payroll exists', () => {
    expect(reminderDuePayroll(anchor, ['2026-09-25'], '2026-09-26')).toBeNull()
    expect(reminderDuePayroll(anchor, ['2026-09-26'], '2026-09-26')).toBeNull()
    expect(reminderDuePayroll(anchor, ['2026-09-24'], '2026-09-26')).toBe('2026-09-25') // stale one does not count
  })

  it('names the payroll date and links the page', () => {
    const text = reminderText('2026-09-25')
    expect(text).toContain('September 25')
    expect(text).toContain('https://ops.bcatcorp.com/finance/cash-checkin')
  })
})
