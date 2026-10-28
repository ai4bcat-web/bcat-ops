import { describe, expect, it } from 'vitest'
import { authorize, canApprove, decisionMessage, decisionPatch, periodLabel, requestMessage, type CreditRow } from './approval'

const credit: CreditRow = {
  id: 'c1', driverId: 'd1', periodStart: '2026-10-13', kind: 'CREDIT', reasonCode: 'DETENTION',
  label: 'Waited 3 hrs at Batory', amount: 150, notes: 'Receiver was short-staffed', createdBy: 'ruben@bcatcorp.com', approvalStatus: 'PENDING', requestedBy: 'ruben@bcatcorp.com',
}
const ryne = { email: 'ryne@bcatcorp.com', isOwner: true, isAdmin: false }
const ruben = { email: 'ruben@bcatcorp.com', isOwner: false, isAdmin: false }

describe('authorize', () => {
  it('lets anyone signed in ask for a notification', () => {
    expect(() => authorize('NOTIFY', ruben)).not.toThrow()
  })
  it('only the owner or an ADMIN decides', () => {
    expect(() => authorize('APPROVE', ruben)).toThrow(/Forbidden/)
    expect(() => authorize('REJECT', ruben)).toThrow(/Forbidden/)
    expect(() => authorize('APPROVE', ryne)).not.toThrow()
    expect(() => authorize('APPROVE', { email: 'dennis@bcatcorp.com', isOwner: false, isAdmin: true })).not.toThrow()
    expect(canApprove(ruben)).toBe(false)
  })
  it('refuses an unresolved caller', () => {
    expect(() => authorize('NOTIFY', { email: '', isOwner: false, isAdmin: false })).toThrow(/Unauthorized/)
  })
})

describe('decisionPatch', () => {
  it('stamps who decided and when', () => {
    expect(decisionPatch('APPROVE', ryne, '2026-10-28T15:00:00.000Z')).toEqual({
      approvalStatus: 'APPROVED', approvedBy: 'ryne@bcatcorp.com', approvedAt: '2026-10-28T15:00:00.000Z', rejectionReason: null,
    })
    expect(decisionPatch('REJECT', ryne, '2026-10-28T15:00:00.000Z', ' not ours to pay ')).toEqual({
      approvalStatus: 'REJECTED', approvedBy: 'ryne@bcatcorp.com', approvedAt: '2026-10-28T15:00:00.000Z', rejectionReason: 'not ours to pay',
    })
  })
})

describe('messages', () => {
  it('asks Ryne with the driver, amount, note and a link', () => {
    const text = requestMessage({ credit, driverName: 'Zak', periodLabel: 'Oct 13 – Oct 19', link: 'https://ops.bcatcorp.com/driver-pay-box-trucks' })
    expect(text).toContain('Ruben added *$150.00* to *Zak*')
    expect(text).toContain('DETENTION — Waited 3 hrs at Batory')
    expect(text).toContain('Note: Receiver was short-staffed')
    expect(text).toContain('https://ops.bcatcorp.com/driver-pay-box-trucks')
  })
  it('tells the requester the outcome', () => {
    expect(decisionMessage({ action: 'APPROVE', credit, driverName: 'Zak', periodLabel: 'Oct 13 – Oct 19', by: 'ryne@bcatcorp.com' })).toBe('Ryne approved the $150.00 DETENTION — Waited 3 hrs at Batory on Zak\'s Oct 13 – Oct 19 check. It is on the check.')
    expect(decisionMessage({ action: 'REJECT', credit, driverName: 'Zak', periodLabel: 'Oct 13 – Oct 19', by: 'ryne@bcatcorp.com', reason: 'already paid' })).toContain('rejected the $150.00 DETENTION')
  })
})

describe('periodLabel', () => {
  it('spans the week', () => {
    expect(periodLabel('2026-10-13')).toBe('Oct 13 – Oct 19')
  })
})
