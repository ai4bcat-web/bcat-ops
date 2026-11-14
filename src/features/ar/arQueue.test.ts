import { describe, it, expect } from 'vitest'
import type { ArWorklistRow } from '@/hooks/useArWorklist'
import type { InvoiceRecord, ShipmentRecord } from '@/types/tms'
import { buildInvoicedRows, buildPaidRows, buildReadyRows, factorQueueRows, groupTotals, orderByGroup, type ArQueueLookups } from './arQueue'

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

  it('leads Invoiced with invoices nobody has sent yet, newest release first', () => {
    const sent = inv({ id: 'sent', sentAt: '2026-10-02T00:00:00Z', sentCount: 1, dueAt: '2026-10-15' })
    const older = inv({ id: 'older', orderId: 'o-old', dueAt: '2026-12-01' })
    const fresh = inv({ id: 'fresh', orderId: 'o-new', dueAt: '2026-12-12' })
    const released = new Map([['o-old', '2026-11-01T00:00:00Z'], ['o-new', '2026-11-12T21:03:22Z']])
    expect(buildInvoicedRows([sent, older, fresh], lookups, released).map((r) => r.invoiceId)).toEqual(['fresh', 'older', 'sent'])
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

describe('factorQueueRows (the folded-in To factor tab)', () => {
  const l = { shipmentsById: new Map(), divisionName: (c: string | null | undefined) => c ?? 'No division', repName: () => 'No sales rep', asOf: '2026-11-14' }
  const item = (over: Record<string, unknown>) => ({ id: 'P1', proNumber: 'P1', status: 'NEED_TO_FACTOR', subject: '', fromEmail: '', receivedAt: '2026-11-11T19:19:10.000Z', messageId: '', createdAt: '', updatedAt: '', ...over }) as never

  it('lists queue rows not yet at OTR, once, and skips any a Ready order already carries', () => {
    const rows = factorQueueRows([
      item({ id: '11836', proNumber: '11836', otrAmount: 375 }),
      item({ id: 'P2', proNumber: 'P2', orderId: 'o-covered' }),
      item({ id: 'P3', proNumber: 'P3', status: 'PENDING_WITH_OTR' }),
    ], [{ orderId: 'o-covered', shipmentId: 's-x' } as never], new Map(), l)
    expect(rows.map((r) => r.key)).toEqual(['factor:11836'])
    expect(rows[0]).toMatchObject({ status: 'READY', shipmentNumber: '11836', amountCents: 37_500, factored: true, orderId: 'factor:11836' })
    expect(rows[0].factorItem?.id).toBe('11836')
  })

  const invoice = (over: Record<string, unknown>) => ({ id: 'inv-1', number: null, shipmentId: 's-1', status: 'ISSUED', totalCents: 37_500, paidCents: 0, balanceCents: 37_500, ...over }) as never

  it('skips an unlinked row whose PRO already has a live invoice (by invoice number, PRO-shaped id or shipment PRO)', () => {
    const lk = { ...l, shipmentsById: new Map([['s-9', { id: 's-9', number: '900' }]]) as never }
    const invoices = new Map<string, never>([
      ['11836', invoice({ id: '11836' })],
      ['inv-2', invoice({ id: 'inv-2', number: '500' })],
      ['inv-3', invoice({ id: 'inv-3', shipmentId: 's-9' })],
      ['inv-4', invoice({ id: 'inv-4', number: '700', status: 'VOID' })],
    ])
    const rows = factorQueueRows([
      item({ id: 'a', proNumber: '11836' }),
      item({ id: 'b', proNumber: '500' }),
      item({ id: 'c', proNumber: '900' }),
      item({ id: 'd', proNumber: '700' }),
      item({ id: 'e', proNumber: '800' }),
    ], [], invoices, lk)
    expect(rows.map((r) => r.key)).toEqual(['factor:d', 'factor:e'])
  })

  it('keeps a row linked to its own invoice, even though that PRO is invoiced', () => {
    const invoices = new Map<string, never>([['inv-2', invoice({ id: 'inv-2', number: '500' })]])
    const rows = factorQueueRows([item({ id: 'b', proNumber: '500', invoiceId: 'inv-2' })], [], invoices, l)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ invoiceId: 'inv-2', amountCents: 37_500 })
  })

  it('shows an unlinked row at its cached OTR payload amount, and $0 only when nothing has one', () => {
    const rows = factorQueueRows([
      item({ id: 'p', proNumber: 'P', otrReadiness: { payload: { InvoiceAmount: 375 } } }),
      item({ id: 'q', proNumber: 'Q', otrReadiness: { payload: { InvoiceAmount: '$1,250.50' } } }),
      item({ id: 'r', proNumber: 'R', otrAmount: 90, otrReadiness: { payload: { InvoiceAmount: 375 } } }),
      item({ id: 's', proNumber: 'S' }),
    ], [], new Map(), l)
    expect(rows.map((r) => [r.key, r.amountCents, r.balanceCents])).toEqual([
      ['factor:p', 37_500, 37_500],
      ['factor:q', 125_050, 125_050],
      ['factor:r', 9_000, 9_000],
      ['factor:s', 0, 0],
    ])
  })
})
