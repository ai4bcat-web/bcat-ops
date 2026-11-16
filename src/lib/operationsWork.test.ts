import { describe, expect, it } from 'vitest'
import { isOperationsWork, operationsIndex, type OperationsRow } from './operationsWork'

const ship = (id: string, patch: Partial<OperationsRow> = {}): OperationsRow => ({
  id, status: 'DELIVERED', orderIds: [`ord-${id}`], loadIds: [`lod-${id}`], ...patch,
})

describe('operationsIndex', () => {
  const index = operationsIndex([
    ship('ops'),
    ship('review', { loadReviewPushedAt: '2026-11-13T21:07:26Z' }),
    ship('invoiced', { invoiceId: 'INV-9' }),
    ship('factored', { factoringItemId: 'f-1' }),
    ship('void', { voidedAt: '2026-11-01T00:00:00Z' }),
    ship('canceled', { status: 'CANCELED' }),
  ])

  it('keeps only shipments still in operations', () => {
    expect([...index.shipmentIds]).toEqual(['ops'])
    expect(index.loadIds.has('lod-ops')).toBe(true)
    expect(index.loadIds.has('lod-review')).toBe(false)
  })

  it('counts a document by shipment, order or load id', () => {
    expect(isOperationsWork({ shipmentId: 'ops' }, index)).toBe(true)
    expect(isOperationsWork({ shipmentId: 'x', orderId: 'ord-ops' }, index)).toBe(true)
    expect(isOperationsWork({ shipmentId: 'x', loadId: 'lod-ops' }, index)).toBe(true)
    // A driver POD waiting for review on a load already in Load Review is not Tracking work.
    expect(isOperationsWork({ shipmentId: 'review', orderId: 'ord-review' }, index)).toBe(false)
    expect(isOperationsWork({ shipmentId: 'invoiced' }, index)).toBe(false)
    expect(isOperationsWork({ shipmentId: 'unknown' }, index)).toBe(false)
  })
})
