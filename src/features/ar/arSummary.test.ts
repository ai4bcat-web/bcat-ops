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
      openCents: 15_000, openCount: 2,
      // Thursday 11/12: the week runs from Monday 11/09.
      collectedWeekCents: 20_000, collectedWeekCount: 2, collectedMonthCents: 20_000, collectedMonthCount: 2,
    })
    expect(s.byDivision).toEqual([
      { key: 'BROKERAGE', label: 'BCAT Logistics', cents: 10_000, division: 'BROKERAGE', divisionLabel: 'BCAT Logistics', subLabel: null, count: 1 },
      { key: 'ASSETS/LOCAL', label: 'Assets · Local', cents: 5_000, division: 'ASSETS', divisionLabel: 'Assets', subLabel: 'Local', count: 1 },
    ])
  })
})

describe('Open AR is every outstanding balance, factored or not, whatever OTR said', () => {
  it('adds up ISSUED and PARTIAL balances and ignores paid, void and empty ones', () => {
    const open = [
      inv({ id: 'manual', balanceCents: 10_000 }),
      inv({ id: 'partial', status: 'PARTIAL', paidCents: 2_000, balanceCents: 8_000 }),
      // OTR Dead / Duplicate / rejected / archived: still owed.
      inv({ id: 'dead', factored: true, factoringItemId: 'f-dead', balanceCents: 7_000 }),
      inv({ id: 'dup', factored: true, factoringItemId: 'f-dup', balanceCents: 6_000 }),
      inv({ id: 'reset', factored: true, factoringItemId: 'f-reset', balanceCents: 5_000 }),
      inv({ id: 'gone', factored: true, factoringItemId: 'f-missing', balanceCents: 4_000 }),
      inv({ id: 'void', status: 'VOID', balanceCents: 0 }),
      inv({ id: 'paid', status: 'PAID', balanceCents: 0 }),
      inv({ id: 'zero', balanceCents: 0 }),
    ]
    const s = computeArSummary({
      open,
      paid: [],
      factorByItemId: new Map([
        ['f-dead', { id: 'f-dead', status: 'PENDING_WITH_OTR', otrStatus: '4' } as unknown as FactoringItem],
        ['f-dup', { id: 'f-dup', status: 'PENDING_WITH_OTR', otrStatus: '7' } as unknown as FactoringItem],
        ['f-reset', { id: 'f-reset', status: 'NEED_TO_FACTOR' } as unknown as FactoringItem],
      ]),
      shipmentsById: new Map([['s1', { revDivision: 'BROKERAGE' } as ShipmentRecord]]),
      divisionName: () => 'BCAT Logistics',
      asOf: '2026-11-12',
    })
    const expected = 10_000 + 8_000 + 7_000 + 6_000 + 5_000 + 4_000
    expect(s.openCents).toBe(expected)
    expect(s.openCount).toBe(6)
    // Open AR = Factored + Pending with shippers, so nothing can fall between the two.
    expect(s.pendingOtrCents + s.pendingShippersCents).toBe(expected)
  })
})
