import { describe, expect, it } from 'vitest'
import { computeArSummary } from '@/features/ar/arSummary'
import { pendingOtrStats } from '@/features/factoring/factoringQueueStats'
import { factoredBucketOf, isWaitingOnOtr, waitingOnOtrTotal } from './factoredOpen'
import type { FactoringItem } from '@/types'
import type { InvoiceRecord } from '@/types/tms'

const item = (id: string, over: Partial<FactoringItem>): FactoringItem =>
  ({ id, proNumber: id, status: 'PENDING_WITH_OTR', otrAmount: 500, otrSubmittedAt: '2026-11-01T12:00:00Z', ...over }) as unknown as FactoringItem

const inv = (id: string, over: Partial<InvoiceRecord>): InvoiceRecord => ({
  id, number: id, orderId: 'o', shipmentId: 's', customerId: 'c', status: 'ISSUED', invoiceDate: '2026-11-01',
  issuedAt: '2026-11-01T12:00:00Z', issuedBy: 'x', dueAt: '2026-12-01', termsDays: 30, invoiceMonth: '2026-11',
  subtotalCents: 50_000, totalCents: 50_000, paidCents: 0, writtenOffCents: 0, balanceCents: 50_000,
  createdBy: 'x', updatedBy: 'x', version: 1, factored: true, ...over,
})

describe('factored, open buckets', () => {
  it('puts each queue state in one bucket; Approved / Dead / Duplicate are not waiting', () => {
    expect(isWaitingOnOtr(item('a', { otrStatus: 6 as never }))).toBe(true)
    expect(isWaitingOnOtr(item('a', { otrStatus: 3 as never }))).toBe(false)
    expect(factoredBucketOf(item('a', { otrStatus: 3 as never }))).toBe('APPROVED')
    expect(factoredBucketOf(item('a', { otrStatus: 4 as never }))).toBe('REJECTED')
    expect(factoredBucketOf(item('a', { otrStatus: 7 as never }))).toBe('OTHER')
    expect(factoredBucketOf(item('a', { status: 'FACTORED' }))).toBe('APPROVED')
    expect(factoredBucketOf(item('a', { status: 'MANUAL_INVOICE' }))).toBe('MANUAL')
    expect(factoredBucketOf(item('a', { status: 'NEED_TO_FACTOR' }))).toBe('NOT_SENT')
    expect(factoredBucketOf(null)).toBe('NO_RECORD')
  })

  it("the factoring queue's Waiting on OTR approval equals the Receivables card's line", () => {
    const items = [
      item('w1', { otrStatus: 6 as never }),
      item('w2', { otrStatus: 8 as never, otrAmount: 2900 }),
      item('stale', { otrStatus: 3 as never }), // Approved but still PENDING locally
      item('dead', { otrStatus: 4 as never }),
      item('dup', { otrStatus: 7 as never }),
      item('fac', { status: 'FACTORED', otrStatus: 3 as never }),
    ]
    const open = [
      inv('i1', { factoringItemId: 'w1' }),
      inv('i2', { factoringItemId: 'w2', balanceCents: 309_000 }), // invoice grew after submission
      inv('i3', { factoringItemId: 'fac' }),
      inv('i4', { factoringItemId: 'dead' }),
      inv('i5', {}), // imported, no queue row
    ]
    const ar = computeArSummary({
      open, paid: [], factorByItemId: new Map(items.map((i) => [i.id, i])), shipmentsById: new Map(),
      divisionName: () => 'x', asOf: '2026-11-15',
    })
    const balances = new Map<string, number>(open.filter((i) => i.factoringItemId).map((i) => [i.factoringItemId as string, i.balanceCents]))
    const queue = pendingOtrStats(items, '2026-11-15', balances)
    expect(ar.factored.WAITING).toEqual({ count: 2, cents: 359_000 })
    expect({ count: queue.count, cents: Math.round(queue.dollars * 100) }).toEqual(ar.factored.WAITING)
    expect(waitingOnOtrTotal(items, balances, (i) => i.otrAmount ?? 0)).toEqual(ar.factored.WAITING)
    expect(ar.factored.APPROVED.count).toBe(1)
    expect(ar.factored.REJECTED.count).toBe(1)
    expect(ar.factored.NO_RECORD.count).toBe(1)
    // The sub-lines add up to Factored, open.
    const sum = Object.values(ar.factored).reduce((n, b) => n + b.cents, 0)
    expect(sum).toBe(ar.pendingOtrCents)
  })
})
