import { describe, expect, it } from 'vitest'
import type { ArQueueRow } from '@/features/ar/arQueue'
import type { CarrierBillRecord, InvoiceRecord, LaneRateSampleRecord } from '@/types/tms'
import {
  apExpectedStats, apPaidStats, arInvoicedStats, arPaidStats, arReadyStats, billPaymentLines, billingMismatches, profitCheck, reviewReasonCounts, reviewReasonKeys, topParties,
} from './accountingStats'

const row = (over: Partial<ArQueueRow>): ArQueueRow => ({
  key: 'k', status: 'INVOICED', orderId: 'o', shipmentId: 's', shipmentNumber: '1', invoiceId: null, invoiceNumber: null,
  customerId: 'c1', customerName: 'Acme', revDivision: null, revDivisionName: '', salesRepId: null, salesRepName: '',
  deliveredAt: null, releasedAt: null, invoiceDate: null, dueAt: null, amountCents: 0, paidCents: 0, balanceCents: 0,
  sentAt: null, sentTo: null, sentCount: 0, daysPastDue: null, shortPaid: false, daysSinceInvoice: null, factored: false,
  paidAt: null, reasons: [], invoice: null, worklist: null, ...over,
})

const bill = (over: Partial<CarrierBillRecord>): CarrierBillRecord => ({
  id: 'b', shipmentId: 's', carrierId: 'car1', carrierName: 'Haul', balanceCents: 0, dueAt: '2026-11-20', recordedAt: '2026-11-01T00:00:00Z',
  ...over,
} as CarrierBillRecord)

describe('topParties', () => {
  it('totals by party, biggest first, skipping nothing-owed rows', () => {
    const top = topParties([{ id: 'a', n: 'A', c: 100 }, { id: 'b', n: 'B', c: 300 }, { id: 'a', n: 'A', c: 250 }, { id: 'c', n: 'C', c: 0 }],
      (x) => ({ id: x.id, name: x.n, cents: x.c }))
    expect(top.map((p) => [p.id, p.cents, p.count])).toEqual([['a', 350, 2], ['b', 300, 1]])
  })
})

describe('arReadyStats', () => {
  it('counts factor readiness and the oldest wait', () => {
    const rows = [row({ key: 'a', amountCents: 100, releasedAt: '2026-11-01' }), row({ key: 'b', amountCents: 200, releasedAt: '2026-11-10' }), row({ key: 'c', amountCents: 50 })]
    const readiness = new Map([
      ['a', { factorBilled: true, ready: true, missing: [] }],
      ['b', { factorBilled: true, ready: false, missing: ['PO'] }],
      ['c', { factorBilled: false, ready: false, missing: [] }],
    ])
    expect(arReadyStats(rows, readiness, '2026-11-14')).toEqual({ total: { count: 3, cents: 350 }, factorReady: 1, factorMissing: 1, oldestDays: 13 })
  })
  it('leaves readiness unknown until it has answered', () => {
    expect(arReadyStats([row({})], new Map(), '2026-11-14').factorReady).toBeNull()
  })
})

describe('arInvoicedStats', () => {
  it('buckets by due date and totals partial payments', () => {
    const s = arInvoicedStats([
      row({ balanceCents: 100, dueAt: '2026-11-01' }),
      row({ balanceCents: 200, dueAt: '2026-11-18', shortPaid: true }),
      row({ customerId: 'c2', customerName: 'Beta', balanceCents: 400, dueAt: '2027-01-30' }),
    ], '2026-11-14')
    expect(s.owed.buckets.past.cents).toBe(100)
    expect(s.owed.buckets.week.cents).toBe(200)
    expect(s.owed.buckets.later.cents).toBe(400)
    expect(s.partial).toEqual({ count: 1, cents: 200 })
    expect(s.top[0]).toMatchObject({ id: 'c2', cents: 400 })
  })
})

describe('arPaidStats', () => {
  const inv = (id: string, invoiceDate: string, paidAt: string): InvoiceRecord => ({ id, status: 'PAID', invoiceDate, paidAt } as InvoiceRecord)
  it('splits ACH and check by the settling payment and ranks customers by days to pay', () => {
    const lines = new Map([
      ['i1', [{ paymentId: 'p1', receivedOn: '2026-11-11', method: 'ACH' as const, reference: null, amountCents: 100 }]],
      ['i2', [{ paymentId: 'p2', receivedOn: '2026-11-21', method: 'CHECK' as const, reference: '123', amountCents: 300 }]],
    ])
    const s = arPaidStats([
      row({ status: 'PAID', amountCents: 100, invoice: inv('i1', '2026-11-01', '2026-11-11'), customerId: 'a', customerName: 'Fast Co' }),
      row({ status: 'PAID', amountCents: 300, invoice: inv('i2', '2026-11-01', '2026-11-21'), customerId: 'b', customerName: 'Slow Co' }),
    ], lines)
    expect(s.collected).toEqual({ count: 2, cents: 400 })
    expect(s.ach).toEqual({ count: 1, cents: 100 })
    expect(s.check).toEqual({ count: 1, cents: 300 })
    expect(s.avgDaysToPay).toBe(15)
    expect(s.fastest).toEqual({ name: 'Fast Co', days: 10 })
    expect(s.slowest).toEqual({ name: 'Slow Co', days: 20 })
  })
})

describe('review reasons', () => {
  it('reads the problems a reason names', () => {
    expect(reviewReasonKeys('Fix on Expected: No customer rate; No carrier pay-to')).toEqual(['rate', 'payTo'])
    expect(reviewReasonKeys('Missing delivered date — enter it')).toEqual(['delivered'])
    expect(reviewReasonKeys('something else')).toEqual(['other'])
  })
  it('counts each kind once per shipment', () => {
    const counts = reviewReasonCounts([
      { id: '1', financeReviewReason: 'Possible duplicate — two $3,000 J&B bills' },
      { id: '2', financeReviewReason: 'No carrier on shipment — check' },
      { id: '3', financeReviewReason: 'No carrier on shipment — check' },
    ] as never)
    expect(counts).toEqual([{ key: 'carrier', count: 2 }, { key: 'duplicate', count: 1 }])
  })
})

describe('AP stats', () => {
  it('counts expected bills that need a fix', () => {
    const s = apExpectedStats([bill({ id: 'x', shipmentId: 's1', balanceCents: 100 }), bill({ id: 'y', shipmentId: 's2', balanceCents: 50, recordedAt: '2026-10-25T00:00:00Z' })],
      new Set(['s2']), '2026-11-14')
    expect(s).toEqual({ total: { count: 2, cents: 150 }, needsFix: { count: 1, cents: 50 }, oldestDays: 20 })
  })
  it('measures delivery → paid, car shipping separately', () => {
    const facts = new Map([
      ['car', { deliveredAt: '2026-11-01T15:00:00Z', revDivision: 'CAR_SHIPPING' }],
      ['ftl', { deliveredAt: '2026-11-01T15:00:00Z', revDivision: 'BROKERAGE' }],
    ]) as never
    const s = apPaidStats([
      bill({ shipmentId: 'car', paidAt: '2026-11-04T12:00:00Z', paidCents: 100 }),
      bill({ shipmentId: 'ftl', paidAt: '2026-11-21T12:00:00Z', paidCents: 200 }),
    ], facts)
    expect(s).toMatchObject({ paid: { count: 2, cents: 300 }, carAvgDays: 3, carCount: 1, otherAvgDays: 20, otherCount: 1 })
  })
})

describe('profitCheck', () => {
  it('totals month-to-date margin and lists negative loads, worst first', () => {
    const sample = (loadId: string, rev: number, cost: number, over: Partial<LaneRateSampleRecord> = {}) =>
      ({ loadId, shipmentId: loadId, shipmentNumber: loadId, revenueCents: rev, costCents: cost, profitCents: rev - cost, ...over } as LaneRateSampleRecord)
    const c = profitCheck([sample('1', 1000, 800), sample('2', 0, 1000), sample('3', 500, 600), sample('4', 999, 0, { excluded: true }), sample('1', 1000, 800)])
    expect(c).toMatchObject({ loads: 3, revenueCents: 1500, costCents: 2400, profitCents: -900, marginBps: -6000 })
    expect(c.negative.map((x) => x.shipmentNumber)).toEqual(['2', '3'])
  })
  it('has no margin without revenue', () => {
    expect(profitCheck([]).marginBps).toBeNull()
  })
})

describe('billing mismatches', () => {
  const inv = (over: Partial<InvoiceRecord>) => ({ id: 'i', number: '1001', shipmentId: 's1', shipmentNumber: '20001', customerName: 'Acme', status: 'PAID', totalCents: 100, paidAt: '2026-11-05T12:00:00Z', ...over } as InvoiceRecord)
  it('finds customer-paid loads with an open carrier bill, and paid bills with no invoice', () => {
    const m = billingMismatches({
      openInvoices: [inv({ id: 'open', shipmentId: 's3', status: 'ISSUED' })],
      invoices: [inv({}), inv({ id: 'v', shipmentId: 's4', status: 'VOID' })],
      openBills: [bill({ id: 'b1', shipmentId: 's1', balanceCents: 80, status: 'TO_BE_PAID' }), bill({ id: 'b3', shipmentId: 's3', balanceCents: 50, status: 'TO_BE_PAID' })],
      paidBills: [bill({ id: 'p4', shipmentId: 's4', shipmentNumber: '4', status: 'PAID', paidCents: 70, paidAt: '2026-11-02T12:00:00Z' }), bill({ id: 'p1', shipmentId: 's1', status: 'PAID' })],
    })
    expect(m.customerPaidCarrierUnpaid.map((r) => [r.shipmentNumber, r.billCents, r.paidOn])).toEqual([['20001', 80, '2026-11-05']])
    // s4's only invoice is void, so the carrier was paid on a load nobody billed.
    expect(m.carrierPaidNotBilled.map((r) => [r.shipmentNumber, r.billCents])).toEqual([['4', 70]])
  })
})

describe('AP payment method', () => {
  it('takes the latest live payment per bill and splits the Paid card', () => {
    const lines = billPaymentLines([
      { id: 'a', kind: 'PAYMENT', paidAt: '2026-11-01T12:00:00Z', method: 'ACH', reference: null, applications: [{ billId: 'x', amountCents: 10 }] },
      { id: 'b', kind: 'PAYMENT', paidAt: '2026-11-03T12:00:00Z', method: 'CHECK', reference: '77', applications: [{ billId: 'x', amountCents: 5 }] },
      { id: 'c', kind: 'PAYMENT', paidAt: '2026-11-04T12:00:00Z', method: 'ACH', reversedByPaymentId: 'r', applications: [{ billId: 'y', amountCents: 5 }] },
    ] as never)
    expect(lines.get('x')).toMatchObject({ method: 'CHECK', reference: '77' })
    expect(lines.has('y')).toBe(false)
    const s = apPaidStats([bill({ id: 'x', paidCents: 15 }), bill({ id: 'z', paidCents: 4 })], new Map() as never, lines)
    expect([s.ach, s.check, s.other]).toEqual([{ count: 0, cents: 0 }, { count: 1, cents: 15 }, { count: 1, cents: 4 }])
  })
})
