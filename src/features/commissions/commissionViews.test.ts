/**
 * The four things the board cannot get wrong without lying to somebody:
 * the needs-review rows an approver must see first, whose rows a person is shown at all,
 * a CSV a spreadsheet will not mangle, and a status pill that never reads `undefined`.
 */
import { describe, it, expect } from 'vitest'
import type { CommissionRecord, CommissionStatus } from '@/types/tms'
import {
  COMMISSION_STATUSES,
  commissionCsv,
  filterForCaller,
  monthOptions,
  needsReviewReason,
  sortForApproval,
  statusLabel,
} from './commissionViews'

function row(over: Partial<CommissionRecord> & { id: string }): CommissionRecord {
  return {
    orderId: 'o1',
    invoiceId: 'i1',
    repId: 'rep@bcatcorp.com',
    roleName: 'PRIMARY_ACCOUNT_OWNER',
    basisCents: 100_000,
    revenueCents: 200_000,
    costCents: 100_000,
    profitCents: 100_000,
    amountCents: 5_000,
    netCents: 5_000,
    status: 'UN_APPROVED',
    triggerAt: '2026-10-10T12:00:00.000Z',
    commissionMonth: '2026-10',
    computedAt: '2026-10-10T12:00:00.000Z',
    createdBy: 'system',
    updatedBy: 'system',
    version: 1,
    ...over,
  }
}

describe('sortForApproval', () => {
  it('puts needs-review rows first, then the oldest trigger', () => {
    const sorted = sortForApproval([
      row({ id: 'c', triggerAt: '2026-10-01T00:00:00.000Z' }),
      row({ id: 'b', triggerAt: '2026-10-20T00:00:00.000Z', needsReview: true }),
      row({ id: 'a', triggerAt: '2026-10-05T00:00:00.000Z' }),
    ])
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('needsReviewReason', () => {
  it('spells out an own-fleet row instead of printing its code', () => {
    expect(needsReviewReason(row({ id: 'x', needsReview: true, basisNote: 'OWN_FLEET_NO_COST' })))
      .toBe('ran on our own trucks, so there is no carrier cost to take a margin from')
  })

  it('says nothing about a row that settled cleanly', () => {
    expect(needsReviewReason(row({ id: 'x' }))).toBeNull()
  })
})

describe('filterForCaller', () => {
  const rep = { email: 'rep@bcatcorp.com', isAdmin: false, isManager: false }

  it("keeps a rep's own open row and drops somebody else's", () => {
    const kept = filterForCaller(
      [row({ id: 'mine' }), row({ id: 'theirs', repId: 'other@bcatcorp.com' })],
      rep,
    )
    expect(kept.map((r) => r.id)).toEqual(['mine'])
  })

  it("drops the rep's own row once it is paid", () => {
    expect(filterForCaller([row({ id: 'mine', status: 'PAID' })], rep)).toEqual([])
  })

  it('keeps everybody for a manager who may approve', () => {
    const kept = filterForCaller(
      [row({ id: 'mine' }), row({ id: 'theirs', repId: 'other@bcatcorp.com' })],
      { email: 'boss@bcatcorp.com', isAdmin: false, isManager: true, mayApprove: true },
    )
    expect(kept.map((r) => r.id)).toEqual(['mine', 'theirs'])
  })
})

describe('commissionCsv', () => {
  it('quotes a customer name carrying a comma and doubles its quote', () => {
    const csv = commissionCsv([
      row({ id: 'x', customerName: 'Smith, "Big Jim" & Co', netCents: 123_450, amountCents: 123_450 }),
    ])
    const [header, line] = csv.split('\n')
    expect(header).toContain('"Customer"')
    expect(line).toContain('"Smith, ""Big Jim"" & Co"')
    // Money is a plain number a spreadsheet parses, never `$1,234.50`.
    expect(line).toContain('"1234.50"')
  })
})

describe('statusLabel', () => {
  it('has words for every status the ladder can reach', () => {
    for (const status of COMMISSION_STATUSES) {
      const label = statusLabel(status)
      expect(label).toBeTruthy()
      expect(label).not.toContain('_')
    }
    expect(COMMISSION_STATUSES).toHaveLength(7)
    expect(statusLabel(null)).toBe('Un-approved')
    expect(statusLabel('FULLY_APPROVED' satisfies CommissionStatus)).toBe('Fully approved')
  })
})

describe('monthOptions', () => {
  it('counts back across a year boundary, newest first', () => {
    expect(monthOptions('2026-01-15', 3)).toEqual(['2026-01', '2025-12', '2025-11'])
  })
})
