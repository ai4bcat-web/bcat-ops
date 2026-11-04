import { describe, expect, it } from 'vitest'
import type { VendorPayable } from '@/types/vendorAp'
import { filterBySource, groupByVendor, sourceCounts, UNKNOWN_VENDOR, vendorApTotals } from './vendorApSources'

const TODAY = '2026-11-04'

function bill(over: Partial<VendorPayable> = {}): VendorPayable {
  return {
    id: 'v-1', status: 'NEED_TO_PAY', source: 'EMAIL', subject: 's', vendor: 'Acme Parts', attachments: [],
    receivedAt: '2026-11-01T12:00:00Z', createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z',
    ...over,
  }
}

describe('vendorApTotals', () => {
  it('counts only unpaid rows as outstanding and splits overdue from due this week', () => {
    const t = vendorApTotals([
      bill({ id: 'a', amount: 10_000, dueDate: '2026-11-01' }),
      bill({ id: 'b', amount: 5_000, dueDate: '2026-11-04' }),
      bill({ id: 'c', amount: 2_500, dueDate: '2026-11-11' }),
      bill({ id: 'd', amount: 1_000, dueDate: '2026-11-12' }),
      bill({ id: 'e', status: 'DONE', amount: 99_900, dueDate: '2026-10-01', paidAt: '2026-10-10T12:00:00Z' }),
    ], TODAY)
    expect(t.outstandingCents).toBe(18_500)
    expect(t.outstandingCount).toBe(4)
    expect(t.overdueCount).toBe(1)
    expect(t.dueThisWeekCount).toBe(2)
  })

  it('reports rows without an amount as unvalued rather than as $0 owed', () => {
    const t = vendorApTotals([bill({ id: 'a', amount: null }), bill({ id: 'b', amount: 100 })], TODAY)
    expect(t.unvaluedCount).toBe(1)
    expect(t.outstandingCents).toBe(100)
    expect(t.outstandingCount).toBe(2)
  })

  it('paid last 30 days includes day 30 and excludes day 31', () => {
    const t = vendorApTotals([
      bill({ id: 'in', status: 'DONE', amount: 1_000, paidAt: '2026-10-05T12:00:00Z' }),
      bill({ id: 'out', status: 'DONE', amount: 7_000, paidAt: '2026-10-04T12:00:00Z' }),
    ], TODAY)
    expect(t.paidLast30Cents).toBe(1_000)
  })
})

describe('source filter', () => {
  const rows = [bill({ id: 'a', source: 'EMAIL' }), bill({ id: 'b', source: 'MAINTENANCE' }), bill({ id: 'c', source: 'EMAIL' })]
  it('filters and counts by source', () => {
    expect(filterBySource(rows, 'EMAIL').map((r) => r.id)).toEqual(['a', 'c'])
    expect(filterBySource(rows, 'ALL')).toHaveLength(3)
    expect(sourceCounts(rows)).toEqual({ ALL: 3, EMAIL: 2, MAINTENANCE: 1 })
  })
})

describe('groupByVendor', () => {
  it('merges spellings that differ only by case, punctuation and company suffix', () => {
    const groups = groupByVendor([
      bill({ id: 'a', vendor: 'Acme Parts, Inc.', amount: 1_000, receivedAt: '2026-11-01T00:00:00Z' }),
      bill({ id: 'b', vendor: 'ACME PARTS', amount: 2_000, receivedAt: '2026-11-02T00:00:00Z' }),
      bill({ id: 'c', vendor: 'Other Co', amount: 500 }),
    ], TODAY)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ vendor: 'ACME PARTS', openCount: 2, owedCents: 3_000, lastBillAt: '2026-11-02T00:00:00Z' })
  })

  it('buckets rows with no vendor under Unknown vendor and counts only open bills as owed', () => {
    const groups = groupByVendor([
      bill({ id: 'a', vendor: null, amount: 900, dueDate: '2026-10-30' }),
      bill({ id: 'b', vendor: '  ', amount: 100, status: 'DONE' }),
    ], TODAY)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ vendor: UNKNOWN_VENDOR, openCount: 1, owedCents: 900, overdueCount: 1 })
  })
})
