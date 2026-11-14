import { describe, expect, it } from 'vitest'
import type { ArPaymentRecord, CarrierBillRecord, InvoiceRecord, LaneRateSampleRecord } from '@/types/tms'
import { ACCOUNTING_REPORTS, buildAccountingReport, reportCsv, reportFileName, reportsFor, type ReportFilters } from './accountingReports'

const f = (over: Partial<ReportFilters> = {}): ReportFilters => ({ from: '', to: '', party: '', status: 'all', asOf: '2026-11-14', ...over })

const inv = (over: Partial<InvoiceRecord>): InvoiceRecord => ({
  id: 'i1', number: '1001', orderId: 'o', shipmentId: 's', shipmentNumber: '20001', customerId: 'c1', customerName: 'Acme Foods',
  status: 'ISSUED', invoiceDate: '2026-10-01', issuedAt: '2026-10-01T12:00:00Z', issuedBy: 'x', dueAt: '2026-10-31', termsDays: 30,
  invoiceMonth: '2026-10', subtotalCents: 100_00, totalCents: 100_00, paidCents: 0, writtenOffCents: 0, balanceCents: 100_00,
  createdBy: 'x', updatedBy: 'x', ...over,
} as InvoiceRecord)

const bill = (over: Partial<CarrierBillRecord>): CarrierBillRecord => ({
  id: 'b1', shipmentId: 's', shipmentNumber: '20001', carrierId: 'k1', carrierName: 'Haul LLC', payeeKind: 'CARRIER', status: 'TO_BE_PAID',
  billDate: '2026-11-01', dueAt: '2026-11-10', recordedAt: '2026-11-01T00:00:00Z', netCents: 80_00, paidCents: 0, balanceCents: 80_00, ...over,
} as CarrierBillRecord)

describe('the report list', () => {
  it('splits AR and AP, with the shared reports on both', () => {
    expect(reportsFor('AR').map((r) => r.kind)).toEqual(['arAgingSummary', 'arAgingDetail', 'arOpen', 'arPayments', 'arDaysToPay', 'marginByLoad', 'needsReview'])
    expect(reportsFor('AP').map((r) => r.kind)).toEqual(['apAging', 'apOpen', 'apPaid', 'apExpected', 'marginByLoad', 'needsReview'])
    expect(ACCOUNTING_REPORTS.every((r) => r.statuses[0].key === 'all')).toBe(true)
  })
})

describe('AR reports', () => {
  const open = [
    inv({ id: 'a', number: 'A', invoiceDate: '2026-10-01', dueAt: '2026-10-31' }),
    inv({ id: 'b', number: 'B', customerId: 'c2', customerName: 'Beta Co', invoiceDate: '2026-11-10', dueAt: '2026-12-10', paidCents: 40_00, balanceCents: 60_00, status: 'PARTIAL' }),
    inv({ id: 'z', number: 'Z', status: 'PAID', balanceCents: 0 }),
  ]

  it('ages by customer from the invoice date', () => {
    const t = buildAccountingReport('arAgingSummary', { openInvoices: open }, f())
    expect(t.columns[1]).toBe('0–30 days')
    expect(t.rows.map((r) => [r[0], r[5]])).toEqual([['Acme Foods', 100], ['Beta Co', 60]])
    expect(buildAccountingReport('arAgingSummary', { openInvoices: open }, f({ status: 'late' })).rows.map((r) => r[0])).toEqual(['Acme Foods'])
  })

  it('lists open invoices filtered by date, name and status', () => {
    expect(buildAccountingReport('arOpen', { openInvoices: open }, f()).rows.map((r) => r[1])).toEqual(['A', 'B'])
    expect(buildAccountingReport('arOpen', { openInvoices: open }, f({ from: '2026-11-01', to: '2026-11-30' })).rows.map((r) => r[1])).toEqual(['B'])
    expect(buildAccountingReport('arOpen', { openInvoices: open }, f({ party: 'acme' })).rows.map((r) => r[1])).toEqual(['A'])
    expect(buildAccountingReport('arOpen', { openInvoices: open }, f({ status: 'partial' })).rows.map((r) => r[1])).toEqual(['B'])
    const detail = buildAccountingReport('arAgingDetail', { openInvoices: open }, f({ status: 'late' }))
    expect(detail.rows).toEqual([['Acme Foods', 'A', '20001', '2026-10-01', '2026-10-31', 44, '31–60', 14, 100, 0, 100]])
  })

  it('lists each payment application with method and check number', () => {
    const payments = [
      { id: 'p1', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-11-05T12:00:00Z', method: 'CHECK', reference: '5521', amountCents: 150_00, appliedCents: 150_00, unappliedCents: 0,
        applications: [{ invoiceId: 'a', amountCents: 100_00 }, { invoiceId: 'z', amountCents: 50_00 }], createdBy: 'x' },
      { id: 'p2', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2026-09-05T12:00:00Z', method: 'ACH', amountCents: 10_00, appliedCents: 10_00, unappliedCents: 0, applications: [], createdBy: 'x' },
    ] as unknown as ArPaymentRecord[]
    const t = buildAccountingReport('arPayments', { openInvoices: open, payments }, f({ from: '2026-11-01', to: '2026-11-30' }))
    expect(t.rows).toEqual([
      ['2026-11-05', 'Acme Foods', 'Paper check', '5521', 150, 'A', '20001', 100, 0],
      ['2026-11-05', 'Acme Foods', 'Paper check', '5521', 150, 'Z', '20001', 50, 0],
    ])
    expect(buildAccountingReport('arPayments', { openInvoices: open, payments }, f({ status: 'ACH' })).rows).toHaveLength(1)
  })

  it('averages days to pay per customer, slowest first', () => {
    const invoices = [
      inv({ id: 'x', status: 'PAID', invoiceDate: '2026-10-01', paidAt: '2026-10-11T12:00:00Z' }),
      inv({ id: 'y', status: 'PAID', invoiceDate: '2026-10-01', paidAt: '2026-10-31T12:00:00Z' }),
      inv({ id: 'w', status: 'PAID', customerId: 'c2', customerName: 'Beta Co', invoiceDate: '2026-10-01', paidAt: '2026-11-15T12:00:00Z' }),
    ]
    const t = buildAccountingReport('arDaysToPay', { invoices, payments: [] }, f())
    expect(t.rows).toEqual([['Beta Co', 1, 45, 45, 45, 100], ['Acme Foods', 2, 20, 10, 30, 200]])
  })
})

describe('AP reports', () => {
  const bills = [
    bill({ id: 'b1' }),
    bill({ id: 'b2', carrierId: 'k2', carrierName: 'Fast Freight', dueAt: '2026-11-20', payeeKind: 'FACTOR', remitTo: { name: 'OTR Capital' } as never }),
    bill({ id: 'b3', status: 'IN_REVIEW', datesPending: true, dueAt: '2026-11-30', shipmentId: 's9', shipmentNumber: '14313', balanceCents: 30_00 }),
  ]
  it('ages open bills by carrier from the due date', () => {
    const t = buildAccountingReport('apAging', { openBills: bills }, f())
    expect(t.rows.map((r) => [r[0], r[1], r[2], r[6]])).toEqual([['Haul LLC', 30, 80, 110], ['Fast Freight', 80, 0, 80]])
  })
  it('filters open bills by status and pay-to', () => {
    expect(buildAccountingReport('apOpen', { openBills: bills }, f({ status: 'FACTOR' })).rows.map((r) => r[7])).toEqual(['OTR Capital'])
    expect(buildAccountingReport('apOpen', { openBills: bills }, f({ status: 'late' })).rows).toHaveLength(1)
  })
  it('lists expected bills with their review reason', () => {
    const t = buildAccountingReport('apExpected', { openBills: bills, review: [{ id: 's9', financeReviewReason: 'No carrier pay-to' }] as never }, f({ status: 'flagged' }))
    expect(t.rows).toEqual([['Haul LLC', '14313', '2026-11-01', 30, 'No carrier pay-to']])
  })
  it('lists bills paid in the range', () => {
    const paid = [bill({ status: 'PAID', paidAt: '2026-11-03T12:00:00Z', paidCents: 80_00, balanceCents: 0 }), bill({ id: 'old', status: 'PAID', paidAt: '2026-09-03T12:00:00Z' })]
    expect(buildAccountingReport('apPaid', { bills: paid }, f({ from: '2026-11-01', to: '2026-11-30' })).rows).toHaveLength(1)
  })
})

describe('shared reports', () => {
  it('margin by load, negative only', () => {
    const samples = [
      { loadId: 'l1', shipmentId: 's1', shipmentNumber: '1', date: '2026-11-02', customerName: 'Acme Foods', carrierName: 'Haul LLC', revenueCents: 1000_00, costCents: 800_00, profitCents: 200_00, marginBps: 2000 },
      { loadId: 'l2', shipmentId: 's2', shipmentNumber: '2', date: '2026-11-03', customerName: 'Acme Foods', carrierName: 'Haul LLC', revenueCents: 0, costCents: 100_00, profitCents: -100_00, marginBps: null },
    ] as unknown as LaneRateSampleRecord[]
    expect(buildAccountingReport('marginByLoad', { samples }, f()).rows).toHaveLength(2)
    expect(buildAccountingReport('marginByLoad', { samples }, f({ status: 'negative' })).rows).toEqual([['2026-11-03', '2', 'Acme Foods', 'Haul LLC', '', 0, 100, -100, null]])
    expect(buildAccountingReport('marginByLoad', { samples }, f({ party: 'haul' })).rows).toHaveLength(2)
  })
  it('needs review by reason', () => {
    const review = [
      { id: '1', number: '6269', customerName: 'J&B', financeReviewReason: 'Possible duplicate — two $3,000 bills' },
      { id: '2', number: '13726', customerName: 'Acme', financeReviewReason: 'Missing delivered date — enter it' },
    ] as never
    expect(buildAccountingReport('needsReview', { review }, f({ status: 'delivered' })).rows.map((r) => r[0])).toEqual(['13726'])
  })
})

describe('CSV', () => {
  it('quotes cells that need it and names the file', () => {
    expect(reportCsv({ columns: ['A', 'B'], rows: [['x, y', 1.5], [null, 'say "hi"']] })).toBe('A,B\r\n"x, y",1.5\r\n,"say ""hi"""')
    expect(reportFileName('arPayments', f({ from: '2026-11-01', to: '2026-11-30' }))).toBe('payments-received-2026-11-01-to-2026-11-30.csv')
    expect(reportFileName('arAgingSummary', f())).toBe('ar-aging-by-customer-2026-11-14.csv')
  })
})
