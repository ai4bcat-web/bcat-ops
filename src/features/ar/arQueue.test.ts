import { describe, it, expect } from 'vitest'
import type { ArWorklistRow } from '@/hooks/useArWorklist'
import type { InvoiceRecord, ShipmentRecord } from '@/types/tms'
import { buildInvoicedRows, buildPaidRows, buildReadyRows, groupTotals, orderByGroup, type ArQueueLookups } from './arQueue'

const lookups: ArQueueLookups = {
  shipmentsById: new Map(),
  asOf: '2026-11-12',
  divisionName: (code) => (code === 'ASSETS' ? 'Ivan Cartage' : code ?? 'No division'),
  repName: (id) => (id ? `Rep ${id}` : 'No sales rep'),
}

function row(patch: Partial<ArWorklistRow> = {}): ArWorklistRow {
  return {
    order: { id: 'o1', shipmentId: 's1', readyToInvoiceAt: '2026-11-10T10:00:00Z' } as ArWorklistRow['order'],
    shipment: { id: 's1', number: '100', status: 'DELIVERED', deliveredAt: '2026-11-09T10:00:00Z', revDivision: 'ASSETS', salesRepId: 'a' } as ShipmentRecord,
    orderId: 'o1', shipmentId: 's1', shipmentNumber: '100', customerId: 'c1', customerName: 'Acme', billToId: null,
    deliveredAt: '2026-11-09T10:00:00Z', arStatusChangedAt: null, revenueCents: 1000, docsRequired: [], docsMissing: [],
    docsReady: true, invoiceNumber: null, invoicedAt: null, arBalanceCents: null, reasons: [],
    ...patch,
  }
}

function inv(patch: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: 'i1', number: 'INV-1', orderId: 'o1', shipmentId: 's1', customerId: 'c1', customerName: 'Acme', status: 'ISSUED',
    invoiceDate: '2026-10-01', issuedAt: '', issuedBy: '', dueAt: '2026-11-01', termsDays: 30, invoiceMonth: '2026-10',
    subtotalCents: 1000, totalCents: 1000, paidCents: 0, writtenOffCents: 0, balanceCents: 1000, createdBy: '', updatedBy: '', version: 1,
    ...patch,
  }
}

describe('the invoicing queue', () => {
  it('lists released, delivered orders as Ready to invoice with division, rep and release date', () => {
    const [r] = buildReadyRows([row()], lookups)
    expect(r).toMatchObject({ status: 'READY', revDivisionName: 'Ivan Cartage', salesRepName: 'Rep a', releasedAt: '2026-11-10T10:00:00Z' })
  })

  it('drops a released order that has not delivered', () => {
    const open = row({ deliveredAt: null, shipment: { id: 's1', number: '100', status: 'OPEN' } as ShipmentRecord })
    expect(buildReadyRows([open], lookups)).toEqual([])
  })

  it('puts open and partial invoices on Invoiced, flags short pay and days past due', () => {
    const rows = buildInvoicedRows([inv(), inv({ id: 'i2', status: 'PARTIAL', paidCents: 600, balanceCents: 400 }), inv({ id: 'i3', status: 'PAID', balanceCents: 0 })], lookups)
    expect(rows.map((r) => r.invoiceId)).toEqual(['i1', 'i2'])
    expect(rows[1].shortPaid).toBe(true)
    expect(rows[0].daysPastDue).toBe(11)
  })

  it('puts zero-balance invoices on Paid', () => {
    expect(buildPaidRows([inv(), inv({ id: 'i3', status: 'PAID', balanceCents: 0 })], lookups).map((r) => r.invoiceId)).toEqual(['i3'])
  })

  it('orders by group alphabetically with the no-division bucket last, and totals a group', () => {
    const a = buildReadyRows([row({ orderId: 'x', shipment: { ...row().shipment!, revDivision: null } as ShipmentRecord })], lookups)[0]
    const b = buildReadyRows([row({ orderId: 'y' })], lookups)[0]
    expect(orderByGroup([a, b], 'division').map((r) => r.orderId)).toEqual(['y', 'x'])
    expect(groupTotals([a, b])).toEqual({ count: 2, amountCents: 2000, balanceCents: 2000 })
  })
})
