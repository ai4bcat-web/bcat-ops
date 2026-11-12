import { describe, it, expect } from 'vitest'
import { computeArSummary } from './arSummary'
import type { InvoiceRecord, ShipmentRecord } from '@/types/tms'
import type { FactoringItem } from '@/types'

const inv = (over: Partial<InvoiceRecord>): InvoiceRecord => ({
  id: 'i', number: 'i', orderId: 'o', shipmentId: 's1', customerId: 'c', status: 'ISSUED', invoiceDate: '2026-11-01',
  issuedAt: '2026-11-01T12:00:00Z', issuedBy: 'x', dueAt: '2026-12-01', termsDays: 30, invoiceMonth: '2026-11',
  subtotalCents: 10_000, totalCents: 10_000, paidCents: 0, writtenOffCents: 0, balanceCents: 10_000,
  createdBy: 'x', updatedBy: 'x', version: 1, ...over,
})

describe('computeArSummary', () => {
  it('splits open money by OTR vs shippers, ages lateness, and slices by division', () => {
    const s = computeArSummary({
      open: [inv({ id: 'a' }), inv({ id: 'b', factored: true, factoringItemId: 'f1', balanceCents: 5_000, dueAt: '2026-11-05', shipmentId: 's2' })],
      paid: [
        inv({ id: 'p1', status: 'PAID', invoiceDate: '2026-11-01', paidAt: '2026-11-11T12:00:00Z' }),
        inv({ id: 'p2', status: 'PAID', factoringItemId: 'f2', paidAt: '2026-11-10T12:00:00Z' }),
        inv({ id: 'old', status: 'PAID', invoiceDate: '2026-01-01', paidAt: '2026-02-01T12:00:00Z' }),
      ],
      factorByItemId: new Map([['f2', { id: 'f2', otrSubmittedAt: '2026-11-07T12:00:00Z', factoredAt: '2026-11-09T12:00:00Z' } as unknown as FactoringItem]]),
      shipmentsById: new Map([['s1', { revDivision: 'BROKERAGE' } as ShipmentRecord], ['s2', { revDivision: 'ASSETS', revSubdivision: 'LOCAL' } as ShipmentRecord]]),
      divisionName: (c) => (c === 'ASSETS' ? 'Assets' : c === 'LOCAL' ? 'Local' : 'BCAT Logistics'),
      asOf: '2026-11-12',
    })
    expect(s).toMatchObject({
      pendingOtrCents: 5_000, pendingOtrCount: 1, pendingShippersCents: 10_000, pendingShippersCount: 1,
      lateCents: 5_000, lateCount: 1, otrDaysToPay: 2, shipperDaysToPay: 10,
    })
    expect(s.byDivision).toEqual([
      { key: 'BROKERAGE', label: 'BCAT Logistics', cents: 10_000, division: 'BROKERAGE', divisionLabel: 'BCAT Logistics', subLabel: null, count: 1 },
      { key: 'ASSETS/LOCAL', label: 'Assets · Local', cents: 5_000, division: 'ASSETS', divisionLabel: 'Assets', subLabel: 'Local', count: 1 },
    ])
  })
})
