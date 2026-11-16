import { describe, it, expect } from 'vitest'
import { paidTabRedirect, paymentsReceivedPath, periodFromParam, recordPaymentPath } from './links'

describe('Payments Received links (the AR Paid tab is gone, Ryne 2026-11-16)', () => {
  it('opens on a period', () => {
    expect(paymentsReceivedPath('month')).toBe('/tms/payments-received?period=month')
    expect(paymentsReceivedPath('week')).toBe('/tms/payments-received?period=week')
    expect(paymentsReceivedPath()).toBe('/tms/payments-received')
    expect(recordPaymentPath({ customerId: 'c1' })).toBe('/tms/payments-received?record=1&customer=c1')
  })

  it('reads ?period= into a preset and dates', () => {
    expect(periodFromParam('month', '2026-11-16')).toEqual({ preset: 'month', range: { from: '2026-11-01', to: '2026-11-30' } })
    expect(periodFromParam('week', '2026-11-16')).toEqual({ preset: 'week', range: { from: '2026-11-16', to: '2026-11-16' } })
    expect(periodFromParam('2026-10', '2026-11-16')).toEqual({ preset: 'custom', range: { from: '2026-10-01', to: '2026-10-31' } })
    expect(periodFromParam('2026-11', '2026-11-16')?.preset).toBe('month')
    expect(periodFromParam('nonsense', '2026-11-16')).toBeNull()
    expect(periodFromParam(null, '2026-11-16')).toBeNull()
  })

  it('sends an old ?tab=paid link to Payments Received', () => {
    expect(paidTabRedirect('?tab=paid')).toBe('/tms/payments-received?period=month')
    expect(paidTabRedirect('?tab=paid&month=2026-10')).toBe('/tms/payments-received?period=2026-10')
    expect(paidTabRedirect('?tab=aging')).toBeNull()
    expect(paidTabRedirect('')).toBeNull()
  })
})
