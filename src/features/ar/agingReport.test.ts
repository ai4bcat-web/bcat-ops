import { describe, expect, it } from 'vitest'
import {
  agingFilterCount, agingReportCsv, buildAgingReport, daysSinceStatement, EMPTY_AGING_FILTERS, filterAgingCustomers, sortAgingCustomers, sortAgingInvoices, statementAgoLabel,
} from './agingReport'
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

describe('last aging report sent', () => {
  const NOW = '2026-11-17T18:00:00Z'
  const sent: Record<string, { at: string | null; to: string | null }> = {
    c1: { at: '2026-11-15T03:30:00Z', to: 'ap@acme.com' }, // Nov 14 in Chicago
    c2: { at: '2026-11-10T20:00:00Z', to: 'bills@beta.com' },
  }
  const report = buildAgingReport([
    inv({ id: 'a', number: 'A' }),
    inv({ id: 'b', number: 'B', customerId: 'c2', customerName: 'Beta' }),
    inv({ id: 'c', number: 'C', customerId: 'c3', customerName: 'Gamma' }),
  ], '2026-11-15', { lastStatementOf: (id) => sent[id] ?? null })
  const by = (id: string) => report.customers.find((c) => c.customerId === id)!

  it('carries the last send and who it went to onto each customer; never is null', () => {
    expect(by('c1').lastStatementAt).toBe('2026-11-15T03:30:00Z')
    expect(by('c1').lastStatementTo).toBe('ap@acme.com')
    expect(by('c3').lastStatementAt).toBeNull()
    expect(by('c3').lastStatementTo).toBeNull()
  })

  it('counts whole Chicago days and words them', () => {
    expect(daysSinceStatement('2026-11-15T03:30:00Z', NOW)).toBe(3)
    expect(daysSinceStatement('2026-11-17T01:00:00Z', NOW)).toBe(1)
    expect(daysSinceStatement(null, NOW)).toBeNull()
    expect(statementAgoLabel(0)).toBe('today')
    expect(statementAgoLabel(1)).toBe('yesterday')
    expect(statementAgoLabel(3)).toBe('3d ago')
    expect(statementAgoLabel(null)).toBe('')
  })

  it('sorts never first ascending and the most recent first descending', () => {
    expect(sortAgingCustomers(report.customers, 'lastStatement', 'asc').map((c) => c.customerId)).toEqual(['c3', 'c2', 'c1'])
    expect(sortAgingCustomers(report.customers, 'lastStatement', 'desc').map((c) => c.customerId)).toEqual(['c1', 'c2', 'c3'])
  })

  it('filters never sent, sent in the last 7 days and not sent in 14+ days', () => {
    const ids = (statement: 'never' | 'recent' | 'stale') => filterAgingCustomers(report.customers, { ...EMPTY_AGING_FILTERS, statement }, NOW).map((c) => c.customerId).sort()
    expect(ids('never')).toEqual(['c3'])
    expect(ids('recent')).toEqual(['c1', 'c2'])
    // c1 went out 3 days ago and c2 7 days ago; only the customer nobody e-mailed counts as 14+ days.
    expect(ids('stale')).toEqual(['c3'])
    const old = buildAgingReport([inv({ id: 'x', number: 'X', customerId: 'c9', customerName: 'Old' })], '2026-11-15', {
      lastStatementOf: () => ({ at: '2026-10-20T15:00:00Z', to: null }),
    })
    expect(filterAgingCustomers(old.customers, { ...EMPTY_AGING_FILTERS, statement: 'stale' }, NOW)).toHaveLength(1)
    expect(filterAgingCustomers(old.customers, { ...EMPTY_AGING_FILTERS, statement: 'recent' }, NOW)).toHaveLength(0)
  })
})

describe('column filters and invoice sorting', () => {
  const rep = buildAgingReport([
    inv({ id: '1', number: '1', customerId: 'c1', customerName: 'One', balanceCents: 10000, totalCents: 10000 }),
    inv({ id: '2', number: '2', customerId: 'c2', customerName: 'Two', balanceCents: 250000, totalCents: 250000, invoiceDate: '2026-07-01', dueAt: '2026-07-31' }),
  ], '2026-11-15')

  it('filters by a dollar range on a column and counts it once', () => {
    const f = { ...EMPTY_AGING_FILTERS, ranges: { total: { min: 1000 } } }
    expect(filterAgingCustomers(rep.customers, f).map((c) => c.customerName)).toEqual(['Two'])
    expect(agingFilterCount(f)).toBe(1)
    expect(filterAgingCustomers(rep.customers, { ...EMPTY_AGING_FILTERS, ranges: { total: { max: 1000 } } }).map((c) => c.customerName)).toEqual(['One'])
  })

  it('filters last paid by a date range and by no payment yet', () => {
    const rows = rep.customers.map((c) => (c.customerId === 'c1' ? { ...c, lastPaidAt: '2026-11-02T15:00:00Z' } : c))
    expect(filterAgingCustomers(rows, { ...EMPTY_AGING_FILTERS, lastPaidFrom: '2026-11-01', lastPaidTo: '2026-11-05' }).map((c) => c.customerName)).toEqual(['One'])
    expect(filterAgingCustomers(rows, { ...EMPTY_AGING_FILTERS, lastPaidBlank: true }).map((c) => c.customerName)).toEqual(['Two'])
  })

  it('filters the last aging report by custom day counts', () => {
    const rows = rep.customers.map((c) => (c.customerId === 'c1' ? { ...c, lastStatementAt: '2026-11-13T15:00:00Z' } : c))
    const now = '2026-11-15T18:00:00Z'
    expect(filterAgingCustomers(rows, { ...EMPTY_AGING_FILTERS, statementWithinDays: 3 }, now).map((c) => c.customerName)).toEqual(['One'])
    expect(filterAgingCustomers(rows, { ...EMPTY_AGING_FILTERS, statementOlderDays: 3 }, now).map((c) => c.customerName)).toEqual(['Two'])
  })

  it('sorts a customer\'s invoices by any column, ties by invoice number', () => {
    const invs = [
      { ...rep.customers[0].invoices[0], id: 'x', number: '10', balanceCents: 500 },
      { ...rep.customers[0].invoices[0], id: 'y', number: '9', balanceCents: 900 },
    ]
    expect(sortAgingInvoices(invs, 'balanceCents', 'desc').map((i) => i.id)).toEqual(['y', 'x'])
    expect(sortAgingInvoices(invs, 'number', 'asc').map((i) => i.id)).toEqual(['y', 'x'])
  })

  it('exports one CSV row per customer in dollars and neutralises formulas', () => {
    const rows = [{ ...rep.customers[0], customerName: '=SUM(A1)' }]
    const csv = agingReportCsv(rows)
    const lines = csv.split('\r\n')
    expect(lines[0]).toContain('Customer,Terms')
    expect(lines[1].startsWith("'=SUM(A1)")).toBe(true)
    expect(lines[1]).toContain('2500.00')
  })
})
