import { describe, expect, it } from 'vitest'
import { driverPayNotes, isDriverPayExpenseType, lastSubmittedPeriodStart, nextDriverPayPeriod } from './driverPayExpensePeriod'

const DP = 'type-driver-pay'
const records = [
  { expenseTypeId: DP, transactionDate: '2026-09-30' },          // period 9/30 – 10/13
  { expenseTypeId: DP, transactionDate: '2026-10-16', createdAt: '2026-10-20' }, // inside 10/14 – 10/27
  { expenseTypeId: 'type-tolls', transactionDate: '2026-11-01' }, // other type, ignored
  { expenseTypeId: DP, transactionDate: null, periodMonth: '2026-08' }, // no date, ignored
]

describe('driver pay expense period', () => {
  it('recognises driver pay types by name', () => {
    expect(isDriverPayExpenseType('Driver Pay')).toBe(true)
    expect(isDriverPayExpenseType('driver  pay – box trucks')).toBe(true)
    expect(isDriverPayExpenseType('Payroll')).toBe(true)
    expect(isDriverPayExpenseType('Tolls')).toBe(false)
    expect(isDriverPayExpenseType(undefined)).toBe(false)
  })
  it('finds the latest submitted period for the type, snapping dates to the cycle', () => {
    expect(lastSubmittedPeriodStart(records, DP)).toBe('2026-10-14')
    expect(lastSubmittedPeriodStart(records, 'nope')).toBeNull()
  })
  it('defaults to the period after the last one submitted', () => {
    const next = nextDriverPayPeriod(records, DP)
    expect(next.periodStart).toBe('2026-10-28')
    expect(next.label).toBe('Oct 28, 2026 – Nov 10, 2026')
    expect(next.followsExisting).toBe(true)
  })
  it('falls back to the current period when nothing has been booked', () => {
    const next = nextDriverPayPeriod([], DP, new Date(2026, 9, 28))
    expect(next.periodStart).toBe('2026-10-28')
    expect(next.followsExisting).toBe(false)
  })
  it('writes the period into the notes', () => {
    expect(driverPayNotes('Oct 28, 2026 – Nov 10, 2026')).toBe('Pay period Oct 28, 2026 – Nov 10, 2026')
  })
})
