import { describe, expect, it } from 'vitest'
import { buildAgingReport, sortAgingCustomers } from './agingReport'
import { ageInvoices } from '@/lib/arAging'
import type { InvoiceRecord } from '@/types/tms'

const inv = (over: Partial<InvoiceRecord>): InvoiceRecord => ({
  id: 'i', number: '1', customerId: 'c1', customerName: 'Acme', shipmentId: 's', shipmentNumber: '100',
  status: 'ISSUED', invoiceDate: '2026-11-01', dueAt: '2026-12-01', termsDays: 30,
  subtotalCents: 0, totalCents: 10000, paidCents: 0, writtenOffCents: 0, balanceCents: 10000,
  ...over,
} as InvoiceRecord)

const asOf = '2026-11-15'
const invoices = [
  inv({ id: 'a', number: 'A', invoiceDate: '2026-11-01', dueAt: '2026-12-01', balanceCents: 10000, totalCents: 10000 }), // 14d → 0–30, not due
  inv({ id: 'b', number: 'B', invoiceDate: '2026-09-20', dueAt: '2026-10-20', balanceCents: 5000, totalCents: 8000, paidCents: 3000, status: 'PARTIAL' }), // 56d → 31–60, 26 past due
  inv({ id: 'c', number: 'C', customerId: 'c2', customerName: 'Beta', invoiceDate: '2026-07-01', dueAt: '2026-07-31', balanceCents: 7000, totalCents: 7000, factored: true }), // 137d → 90+
  inv({ id: 'd', number: 'D', status: 'PAID', balanceCents: 0 }), // ignored
]

describe('buildAgingReport', () => {
  const report = buildAgingReport(invoices, asOf, {
    refOf: (i) => `PO-${i.number}`,
    termsOf: (id) => (id === 'c1' ? 30 : 120),
    lastPaidOf: (id) => (id === 'c1' ? '2026-11-10' : null),
  })

  it('ages each invoice from its invoice date into the statement buckets', () => {
    const acme = report.customers.find((c) => c.customerId === 'c1')!
    expect(acme.byBucket).toEqual({ D1_30: 10000, D31_60: 5000, D61_90: 0, D91_PLUS: 0 })
    expect(acme.invoices.map((i) => [i.number, i.bucket, i.daysPastDue])).toEqual([['B', 'D31_60', 26], ['A', 'D1_30', 0]])
    expect(acme.pastDueCents).toBe(5000)
    expect(acme.termsDays).toBe(30)
    expect(acme.lastPaidAt).toBe('2026-11-10')
    expect(acme.invoices[0].customerRef).toBe('PO-B')
  })

  it('totals equal the open balance the Open AR card counts (and the old aging summary)', () => {
    const openBalance = invoices.filter((i) => i.status === 'ISSUED' || i.status === 'PARTIAL').reduce((s, i) => s + i.balanceCents, 0)
    expect(report.totalCents).toBe(openBalance)
    expect(report.count).toBe(3)
    expect(report.totalCents).toBe(ageInvoices(invoices, asOf, { fromInvoiceDate: true }).totalCents)
    expect(Object.values(report.byBucket).reduce((a, b) => a + b, 0)).toBe(report.totalCents)
  })

  it('flags factored invoices instead of dropping them', () => {
    const beta = report.customers.find((c) => c.customerId === 'c2')!
    expect(beta.factoredCents).toBe(7000)
    expect(beta.invoices[0].factored).toBe(true)
    expect(report.factoredCents).toBe(7000)
  })

  it('sorts customers by any column', () => {
    expect(sortAgingCustomers(report.customers, 'customer', 'asc').map((c) => c.customerName)).toEqual(['Acme', 'Beta'])
    expect(sortAgingCustomers(report.customers, 'D91_PLUS', 'desc')[0].customerName).toBe('Beta')
  })

  it('carries no cost, carrier pay or margin fields', () => {
    const keys = new Set<string>()
    for (const c of report.customers) {
      Object.keys(c).forEach((k) => keys.add(k))
      for (const i of c.invoices) Object.keys(i).forEach((k) => keys.add(k))
    }
    for (const k of keys) expect(k).not.toMatch(/cost|carrier|margin|profit/i)
  })
})
