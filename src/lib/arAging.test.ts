import { describe, it, expect } from 'vitest'
import type { InvoiceRecord, OrderRecord, ShipmentRecord } from '@/types/tms'
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABEL,
  AP_AGING_CSV_HEADER,
  ageInvoices,
  ageOpenItems,
  agingBucket,
  agingCsv,
  apAgingCsv,
  avgDaysToInvoice,
  avgDaysToPay,
  daysLate,
  deliveredNotInvoiced,
  oldestOpenInvoiceDays,
} from './arAging'

const invoice = (over: Partial<InvoiceRecord> & { id: string }): InvoiceRecord => ({
  number: over.id,
  orderId: `o-${over.id}`,
  shipmentId: `s-${over.id}`,
  customerId: 'c1',
  customerName: 'Batory Foods',
  status: 'ISSUED',
  invoiceDate: '2026-09-01',
  issuedAt: '2026-09-01T15:00:00Z',
  issuedBy: 'ryne',
  dueAt: '2026-10-01',
  termsDays: 30,
  invoiceMonth: '2026-09',
  subtotalCents: 100_000,
  totalCents: 100_000,
  paidCents: 0,
  writtenOffCents: 0,
  balanceCents: 100_000,
  version: 1,
  createdBy: 'ryne',
  updatedBy: 'ryne',
  createdAt: '2026-09-01T15:00:00Z',
  updatedAt: '2026-09-01T15:00:00Z',
  ...over,
})

const shipment = (over: Partial<ShipmentRecord> & { id: string }): ShipmentRecord => ({
  number: `B${over.id}`,
  status: 'DELIVERED',
  customerId: 'c1',
  customerName: 'Batory Foods',
  mode: 'FTL',
  source: 'MANUAL',
  deliveredAt: '2026-09-10T18:00:00Z',
  createdBy: 'ryne',
  updatedBy: 'ryne',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-10T18:00:00Z',
  ...over,
})

const order = (over: Partial<OrderRecord> & { id: string; shipmentId: string }): OrderRecord => ({
  customerId: 'c1',
  customerName: 'Batory Foods',
  mode: 'FTL',
  revenueCents: 250_000,
  arStatus: 'UNBILLED',
  createdBy: 'ryne',
  updatedBy: 'ryne',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-10T18:00:00Z',
  ...over,
})

describe('daysLate / agingBucket', () => {
  it('counts whole UTC days regardless of the hour asked', () => {
    expect(daysLate('2026-10-01', '2026-10-01')).toBe(0)
    expect(daysLate('2026-10-01', '2026-10-01T23:59:59Z')).toBe(0)
    expect(daysLate('2026-10-01', '2026-10-02T00:00:00Z')).toBe(1)
    expect(daysLate('2026-10-01', '2026-09-28')).toBe(-3)
  })

  it('crosses a month end', () => {
    expect(daysLate('2026-01-31', '2026-03-01')).toBe(29)
  })

  it('puts each bucket edge on the right side', () => {
    const due = '2026-10-01'
    const at = (days: number) => new Date(Date.UTC(2026, 9, 1 + days)).toISOString().slice(0, 10)
    expect(agingBucket(due, at(0))).toBe('CURRENT')
    expect(agingBucket(due, at(-5))).toBe('CURRENT')
    expect(agingBucket(due, at(1))).toBe('D1_30')
    expect(agingBucket(due, at(30))).toBe('D1_30')
    expect(agingBucket(due, at(31))).toBe('D31_60')
    expect(agingBucket(due, at(60))).toBe('D31_60')
    expect(agingBucket(due, at(61))).toBe('D61_90')
    expect(agingBucket(due, at(90))).toBe('D61_90')
    expect(agingBucket(due, at(91))).toBe('D91_PLUS')
  })

  it('treats an unusable date as not late', () => {
    expect(daysLate('', '2026-10-01')).toBe(0)
    expect(agingBucket('not-a-date', '2026-10-01')).toBe('CURRENT')
  })
})

describe('ageInvoices', () => {
  const asOf = '2026-10-15'
  const rows = [
    invoice({ id: 'i1', dueAt: '2026-10-20', balanceCents: 100_000 }),            // current
    invoice({ id: 'i2', dueAt: '2026-10-01', balanceCents: 50_000, status: 'PARTIAL', paidCents: 50_000 }), // 14 late
    invoice({ id: 'i3', dueAt: '2026-08-01', balanceCents: 30_000 }),             // 75 late
    invoice({ id: 'i4', customerId: 'c2', customerName: 'Rev, Inc', dueAt: '2026-06-01', balanceCents: 20_000 }), // 136 late
    invoice({ id: 'i5', dueAt: '2026-01-01', balanceCents: 999_999, status: 'VOID' }),
    invoice({ id: 'i6', dueAt: '2026-01-01', balanceCents: 0, status: 'PAID', paidAt: '2026-02-01T00:00:00Z' }),
  ]

  it('ages the balance of ISSUED and PARTIAL rows only', () => {
    const summary = ageInvoices(rows, asOf)
    expect(summary.totalCents).toBe(200_000)
    expect(summary.byBucket).toEqual({
      CURRENT: 100_000,
      D1_30: 50_000,
      D31_60: 0,
      D61_90: 30_000,
      D91_PLUS: 20_000,
    })
    expect(summary.lateCents).toBe(100_000)
  })

  it('groups by customer, largest balance first', () => {
    const { byCustomer } = ageInvoices(rows, asOf)
    expect(byCustomer.map((c) => c.customerId)).toEqual(['c1', 'c2'])
    expect(byCustomer[0]).toMatchObject({ customerName: 'Batory Foods', totalCents: 180_000, lateCount: 2, oldestDays: 75 })
    expect(byCustomer[1]).toMatchObject({ customerId: 'c2', totalCents: 20_000, lateCount: 1, oldestDays: 136 })
    expect(byCustomer[0].byBucket.CURRENT).toBe(100_000)
  })

  it('reports zeroes for an empty set', () => {
    const summary = ageInvoices([], asOf)
    expect(summary.totalCents).toBe(0)
    expect(summary.byCustomer).toEqual([])
    expect(AGING_BUCKETS.every((b) => summary.byBucket[b] === 0)).toBe(true)
  })
})

describe('ageOpenItems', () => {
  const asOf = '2026-10-15'

  it('buckets a ledger-neutral set of items exactly as ageInvoices buckets the same rows', () => {
    const rows = [
      invoice({ id: 'i1', dueAt: '2026-10-20', balanceCents: 100_000 }),
      invoice({ id: 'i2', dueAt: '2026-10-01', balanceCents: 50_000, status: 'PARTIAL' }),
      invoice({ id: 'i3', dueAt: '2026-08-01', balanceCents: 30_000 }),
      invoice({ id: 'i4', customerId: 'c2', customerName: 'Rev, Inc', dueAt: '2026-06-01', balanceCents: 20_000 }),
    ]
    const fromInvoices = ageInvoices(rows, asOf)
    const fromItems = ageOpenItems(
      rows.map((r) => ({ partyId: r.customerId, partyName: r.customerName, dueAt: r.dueAt, balanceCents: r.balanceCents })),
      asOf,
    )

    expect(fromItems.byBucket).toEqual(fromInvoices.byBucket)
    expect(fromItems.totalCents).toBe(fromInvoices.totalCents)
    expect(fromItems.lateCents).toBe(fromInvoices.lateCents)
    expect(fromItems.byParty.map((p) => [p.partyId, p.partyName, p.totalCents, p.lateCount, p.oldestDays])).toEqual(
      fromInvoices.byCustomer.map((c) => [c.customerId, c.customerName, c.totalCents, c.lateCount, c.oldestDays]),
    )
  })

  it('counts an item due today as current, not late', () => {
    const summary = ageOpenItems([{ partyId: 'car-1', partyName: 'Blue Line', dueAt: asOf, balanceCents: 75_000 }], asOf)
    expect(summary.byBucket.CURRENT).toBe(75_000)
    expect(summary.lateCents).toBe(0)
    expect(summary.byParty[0]).toMatchObject({ lateCount: 0, oldestDays: 0 })
  })

  it('ages every item handed to it — which rows are still open is the caller\u2019s filter', () => {
    const summary = ageOpenItems(
      [
        { partyId: 'car-1', dueAt: '2026-09-01', balanceCents: 10_000 },
        { partyId: 'car-1', partyName: 'Blue Line', dueAt: '2026-10-20', balanceCents: 5_000 },
      ],
      asOf,
    )
    expect(summary.totalCents).toBe(15_000)
    expect(summary.byParty).toHaveLength(1)
    expect(summary.byParty[0].partyName).toBe('Blue Line')
  })
})

describe('oldestOpenInvoiceDays', () => {
  it('is null when nothing is open', () => {
    expect(oldestOpenInvoiceDays([], '2026-10-15')).toBeNull()
  })

  it('is null when everything is still inside terms', () => {
    const rows = [invoice({ id: 'i1', dueAt: '2026-10-20' }), invoice({ id: 'i2', dueAt: '2026-10-15' })]
    expect(oldestOpenInvoiceDays(rows, '2026-10-15')).toBeNull()
  })

  it('returns the largest days late of the open rows, ignoring VOID and PAID', () => {
    const rows = [
      invoice({ id: 'i1', dueAt: '2026-10-10' }),
      invoice({ id: 'i2', dueAt: '2026-09-15', status: 'PARTIAL' }),
      invoice({ id: 'i3', dueAt: '2026-01-01', status: 'VOID' }),
      invoice({ id: 'i4', dueAt: '2026-01-01', status: 'PAID', paidAt: '2026-02-01T00:00:00Z' }),
    ]
    expect(oldestOpenInvoiceDays(rows, '2026-10-15')).toBe(30)
  })
})

describe('avgDaysToInvoice / avgDaysToPay', () => {
  const ships = [
    shipment({ id: 's-i1', deliveredAt: '2026-09-01T18:00:00Z' }),
    shipment({ id: 's-i2', deliveredAt: '2026-09-01T01:00:00Z' }),
    shipment({ id: 's-i3', deliveredAt: '2026-09-01T18:00:00Z' }),
    shipment({ id: 's-i4', deliveredAt: null }),
  ]

  it('averages delivery → issue and ignores VOID and undelivered shipments', () => {
    const rows = [
      invoice({ id: 'i1', issuedAt: '2026-09-03T09:00:00Z' }),            // 2
      invoice({ id: 'i2', issuedAt: '2026-09-05T09:00:00Z' }),            // 4
      invoice({ id: 'i3', issuedAt: '2026-09-30T09:00:00Z', status: 'VOID' }), // excluded
      invoice({ id: 'i4', issuedAt: '2026-09-30T09:00:00Z' }),            // no delivery date
      invoice({ id: 'i9', issuedAt: '2026-09-30T09:00:00Z' }),            // no shipment at all
    ]
    expect(avgDaysToInvoice(rows, ships)).toBe(3)
  })

  it('is null when no pair qualifies', () => {
    expect(avgDaysToInvoice([invoice({ id: 'i3', status: 'VOID' })], ships)).toBeNull()
    expect(avgDaysToInvoice([], [])).toBeNull()
  })

  it('averages issue → paid over PAID invoices only', () => {
    const rows = [
      invoice({ id: 'i1', issuedAt: '2026-09-01T10:00:00Z', status: 'PAID', paidAt: '2026-09-21T10:00:00Z' }), // 20
      invoice({ id: 'i2', issuedAt: '2026-09-01T10:00:00Z', status: 'PAID', paidAt: '2026-10-06T10:00:00Z' }), // 35
      invoice({ id: 'i3', issuedAt: '2026-09-01T10:00:00Z', status: 'VOID', paidAt: '2026-09-02T10:00:00Z' }),
      invoice({ id: 'i4', issuedAt: '2026-09-01T10:00:00Z' }),
    ]
    expect(avgDaysToPay(rows)).toBe(27.5)
    expect(avgDaysToPay([invoice({ id: 'i4' })])).toBeNull()
  })
})

describe('deliveredNotInvoiced', () => {
  const ships = [
    shipment({ id: 's1', number: 'B1001', deliveredAt: '2026-10-01T12:00:00Z' }),
    shipment({ id: 's2', number: 'B1002', deliveredAt: '2026-10-05T12:00:00Z' }),
    shipment({ id: 's3', number: 'B1003', deliveredAt: '2026-10-03T12:00:00Z' }),
    shipment({ id: 's4', number: 'B1004', deliveredAt: '2026-10-04T12:00:00Z', deletedAt: '2026-10-04T13:00:00Z' }),
    shipment({ id: 's5', number: 'B1005', status: 'IN_TRANSIT', deliveredAt: null }),
    shipment({ id: 's6', number: 'B1006', deliveredAt: '2026-10-02T12:00:00Z' }),
    shipment({ id: 's7', number: 'B1007', deliveredAt: '2026-10-02T12:00:00Z' }),
    shipment({ id: 's8', number: 'B1008', deliveredAt: '2026-10-02T12:00:00Z', voidedAt: '2026-10-02T13:00:00Z' }),
  ]
  const orders = [
    order({ id: 'o1', shipmentId: 's1', arStatus: 'DOCS_NEEDED', revenueCents: 150_000 }),
    order({ id: 'o2', shipmentId: 's2', arStatus: 'UNBILLED', revenueCents: 220_000 }),
    order({ id: 'o3', shipmentId: 's3', arStatus: 'LEGACY' }),
    order({ id: 'o4', shipmentId: 's4', arStatus: 'UNBILLED' }),
    order({ id: 'o5', shipmentId: 's5', arStatus: 'UNBILLED' }),
    order({ id: 'o6', shipmentId: 's6', arStatus: 'INVOICE_NOT_NEEDED' }),
    order({ id: 'o7', shipmentId: 's7', arStatus: 'UNPAID' }),
    order({ id: 'o8', shipmentId: 's7', arStatus: 'PAID' }),
  ]

  it('keeps only DOCS_NEEDED and UNBILLED on live delivered shipments, newest first', () => {
    const rows = deliveredNotInvoiced(orders, ships, '2026-10-08')
    expect(rows.map((r) => r.orderId)).toEqual(['o2', 'o1'])
    expect(rows[0]).toEqual({
      orderId: 'o2',
      shipmentId: 's2',
      shipmentNumber: 'B1002',
      customerId: 'c1',
      customerName: 'Batory Foods',
      deliveredAt: '2026-10-05T12:00:00Z',
      daysWaiting: 3,
      revenueCents: 220_000,
    })
    expect(rows[1].daysWaiting).toBe(7)
  })

  it('treats a missing revenue as zero rather than dropping the row', () => {
    const rows = deliveredNotInvoiced([order({ id: 'o1', shipmentId: 's1', revenueCents: null })], ships, '2026-10-08')
    expect(rows).toHaveLength(1)
    expect(rows[0].revenueCents).toBe(0)
  })

  it('drops a voided shipment, not just a pre-R soft delete', () => {
    const rows = deliveredNotInvoiced([order({ id: 'o9', shipmentId: 's8', arStatus: 'UNBILLED' })], ships, '2026-10-08')
    expect(rows).toEqual([])
  })
})

describe('agingCsv', () => {
  it('writes dollars from cents and escapes a customer name with a comma', () => {
    const { byCustomer } = ageInvoices(
      [
        invoice({ id: 'i1', customerId: 'c2', customerName: 'Rev, Inc', dueAt: '2026-10-20', balanceCents: 125_050 }),
        invoice({ id: 'i2', customerId: 'c2', customerName: 'Rev, Inc', dueAt: '2026-08-01', balanceCents: 7 }),
      ],
      '2026-10-15',
    )
    const csv = agingCsv(byCustomer)
    const lines = csv.split('\n')
    expect(lines[0]).toBe(
      ['Customer', ...AGING_BUCKETS.map((b) => AGING_BUCKET_LABEL[b]), 'Total', 'Late invoices', 'Oldest days']
        .map((h) => `"${h}"`)
        .join(','),
    )
    expect(lines[1]).toBe('"Rev, Inc","1250.50","0.00","0.00","0.07","0.00","1250.57","1","75"')
  })

  it('doubles an embedded quote and renders a header for no rows', () => {
    expect(agingCsv([]).split('\n')).toHaveLength(1)
    const csv = agingCsv([
      {
        customerId: 'c3',
        customerName: 'Joe "Big Joe" Hauling',
        byBucket: { CURRENT: -2_500, D1_30: 0, D31_60: 0, D61_90: 0, D91_PLUS: 0 },
        totalCents: -2_500,
        lateCount: 0,
        oldestDays: 0,
      },
    ])
    expect(csv.split('\n')[1]).toContain('"Joe ""Big Joe"" Hauling"')
    expect(csv.split('\n')[1]).toContain('"-25.00"')
  })
})

describe('apAgingCsv', () => {
  it('heads the party column with the carrier and counts bills, not invoices', () => {
    const { byParty } = ageOpenItems(
      [
        { partyId: 'car-1', partyName: 'Blue Line, Inc', dueAt: '2026-10-20', balanceCents: 125_050 },
        { partyId: 'car-1', partyName: 'Blue Line, Inc', dueAt: '2026-08-01', balanceCents: 7 },
      ],
      '2026-10-15',
    )
    const lines = apAgingCsv(byParty).split('\n')
    expect(lines[0]).toBe(AP_AGING_CSV_HEADER.map((h) => `"${h}"`).join(','))
    expect(lines[0]).toContain('"Carrier"')
    expect(lines[0]).toContain('"Late bills"')
    expect(lines[1]).toBe('"Blue Line, Inc","1250.50","0.00","0.00","0.07","0.00","1250.57","1","75"')
  })
})
