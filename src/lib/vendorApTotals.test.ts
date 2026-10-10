import { describe, it, expect } from 'vitest'
import { vendorApTotals } from './vendorApTotals'
import type { VendorPayable } from '@/types/vendorAp'

const row = (over: Partial<VendorPayable>): VendorPayable => ({ id: Math.random().toString(), status: 'NEED_TO_PAY', source: 'EMAIL', subject: 's', attachments: [], receivedAt: '2026-10-01T00:00:00Z', createdAt: '', updatedAt: '', ...over })

describe('vendorApTotals', () => {
  it('sums what is still to pay, flags overdue and due-this-week, counts blanks', () => {
    const t = vendorApTotals([
      row({ amount: 10000, dueDate: '2026-10-05' }),      // overdue
      row({ amount: 20000, dueDate: '2026-10-15' }),      // this week
      row({ amount: 30000, dueDate: '2026-11-01' }),      // later
      row({ amount: null }),                              // no amount yet
      row({ status: 'DONE', amount: 5000, paymentDate: '2026-10-01' }),
      row({ status: 'DONE', amount: 7000, paymentDate: '2026-08-01' }),
    ], '2026-10-10')
    expect(t.outstandingAmount).toBe(60000)
    expect(t.outstandingCount).toBe(4)
    expect(t.unvalued).toBe(1)
    expect(t.overdue).toEqual({ count: 1, amount: 10000 })
    expect(t.dueThisWeek).toEqual({ count: 1, amount: 20000 })
    expect(t.paidLast30).toBe(5000)
    expect(t.nextDue).toBe('2026-10-05')
  })
  it('is calm when the queue is empty', () => {
    expect(vendorApTotals([], '2026-10-10')).toMatchObject({ outstandingAmount: 0, outstandingCount: 0, nextDue: null })
  })
})
