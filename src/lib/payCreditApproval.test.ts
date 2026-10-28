import { describe, expect, it } from 'vitest'
import { approvalLabel, approvalStatusOf, creditCounts, initialApprovalStatus } from './payCreditApproval'

describe('approvalStatusOf', () => {
  it('treats legacy rows with no status as approved', () => {
    expect(approvalStatusOf({})).toBe('APPROVED')
    expect(approvalStatusOf({ approvalStatus: null })).toBe('APPROVED')
    expect(approvalStatusOf({ approvalStatus: 'APPROVED' })).toBe('APPROVED')
  })
  it('keeps pending and rejected as they are', () => {
    expect(approvalStatusOf({ approvalStatus: 'PENDING' })).toBe('PENDING')
    expect(approvalStatusOf({ approvalStatus: 'REJECTED' })).toBe('REJECTED')
  })
  it('ignores unknown values rather than hiding pay', () => {
    expect(approvalStatusOf({ approvalStatus: 'weird' })).toBe('APPROVED')
  })
})

describe('creditCounts', () => {
  it('only approved rows reach the check', () => {
    expect(creditCounts({ approvalStatus: 'PENDING' })).toBe(false)
    expect(creditCounts({ approvalStatus: 'REJECTED' })).toBe(false)
    expect(creditCounts({ approvalStatus: 'APPROVED' })).toBe(true)
    expect(creditCounts({})).toBe(true)
  })
})

describe('initialApprovalStatus', () => {
  it('owner or admin credits are approved on the spot', () => {
    expect(initialApprovalStatus({ kind: 'CREDIT', canApprove: true })).toBe('APPROVED')
  })
  it('anyone else waits for Ryne', () => {
    expect(initialApprovalStatus({ kind: 'CREDIT', canApprove: false })).toBe('PENDING')
    expect(initialApprovalStatus({ kind: null, canApprove: false })).toBe('PENDING')
  })
  it('debits never need approval', () => {
    expect(initialApprovalStatus({ kind: 'DEBIT', canApprove: false })).toBe('APPROVED')
  })
})

describe('approvalLabel', () => {
  it('names each state', () => {
    expect(approvalLabel('PENDING')).toBe('Pending approval')
    expect(approvalLabel('REJECTED')).toBe('Rejected')
    expect(approvalLabel('APPROVED')).toBe('Approved')
  })
})
