import { describe, it, expect } from 'vitest'
import { reviseRecurringAmount, startedToday, dayBefore } from './recurringRevision'
import type { RecurringExpenseData } from '@/lib/apiClient'

const row = (over: Partial<RecurringExpenseData> = {}): RecurringExpenseData => ({
  id: 'r1', expenseTypeId: 't-yard', allocationId: 'a1', monthlyAmount: 2000, startMonth: '2026-06', endMonth: null, active: true, notes: 'Yard',
  createdAt: '2026-06-01T12:00:00Z', updatedAt: '2026-06-01T12:00:00Z', ...over,
})

describe('changing a fixed monthly cost', () => {
  it('ends the old amount yesterday and starts the new one today — June keeps $2,000', () => {
    const r = reviseRecurringAmount(row(), 2500, '2026-10-15')
    expect(r.kind).toBe('split')
    if (r.kind !== 'split') return
    expect(r.endPatch).toEqual({ endMonth: '2026-10', endDate: '2026-10-14' })
    expect(r.create).toMatchObject({ monthlyAmount: 2500, startMonth: '2026-10', startDate: '2026-10-15', endMonth: null, active: true, notes: 'Yard', allocationId: 'a1' })
  })
  it('a change to $0 simply ends the cost yesterday', () => {
    expect(reviseRecurringAmount(row(), 0, '2026-10-15')).toEqual({ kind: 'end', id: 'r1', patch: { endMonth: '2026-10', endDate: '2026-10-14' } })
  })
  it('an edit on the day the row started is a correction, in place', () => {
    expect(reviseRecurringAmount(row({ startDate: '2026-10-15', startMonth: '2026-10' }), 2600, '2026-10-15')).toEqual({ kind: 'update', id: 'r1', patch: { monthlyAmount: 2600, active: true } })
    // Rows from before effective dates: created today and starting this month count the same.
    expect(startedToday(row({ startMonth: '2026-10', createdAt: '2026-10-15T14:00:00Z' }), '2026-10-15')).toBe(true)
    expect(startedToday(row(), '2026-10-15')).toBe(false)
  })
  it('crosses a month boundary correctly', () => {
    expect(dayBefore('2026-11-01')).toBe('2026-10-31')
    const r = reviseRecurringAmount(row(), 2500, '2026-11-01')
    if (r.kind === 'split') expect(r.endPatch).toEqual({ endMonth: '2026-10', endDate: '2026-10-31' })
  })
})
