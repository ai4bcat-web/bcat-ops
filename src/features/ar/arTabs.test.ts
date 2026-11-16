import { describe, it, expect } from 'vitest'
import { computeArSummary } from './arSummary'
import { billedByMatches, splitOpenInvoices, type ArBilledBy, type ArQueueLookups } from './arQueue'
import { arCompactItems, arTabs, paidInMonthOf } from './arTabs'
import { ageInvoices } from '@/lib/arAging'
import { formatCents } from '@/lib/invoiceBuild'
import type { InvoiceRecord, ShipmentRecord } from '@/types/tms'

const inv = (over: Partial<InvoiceRecord>): InvoiceRecord => ({
  id: 'i', number: 'i', orderId: 'o', shipmentId: 's1', customerId: 'c', customerName: 'Cust', status: 'ISSUED', invoiceDate: '2026-10-01',
  issuedAt: '2026-10-01T12:00:00Z', issuedBy: 'x', dueAt: '2026-10-31', termsDays: 30, invoiceMonth: '2026-10',
  subtotalCents: 10_000, totalCents: 10_000, paidCents: 0, writtenOffCents: 0, balanceCents: 10_000,
  createdBy: 'x', updatedBy: 'x', version: 1, ...over,
} as InvoiceRecord)

const lookups: ArQueueLookups = {
  shipmentsById: new Map([['s1', { id: 's1', revDivision: 'BROKERAGE' } as ShipmentRecord]]),
  asOf: '2026-11-15',
  divisionName: (c) => c ?? 'No division',
  repName: () => 'Rep',
} as ArQueueLookups

// Two shipper invoices (one late), two factored through OTR, one unsent draft, and paid invoices across two months.
const open = [
  inv({ id: 'a', orderId: 'oa' }),
  inv({ id: 'b', orderId: 'ob', balanceCents: 2_500, totalCents: 5_000, paidCents: 2_500, status: 'PARTIAL', dueAt: '2026-12-15' }),
  inv({ id: 'f1', orderId: 'of1', factored: true, factoringItemId: 'x1', balanceCents: 7_000, totalCents: 7_000, dueAt: '2026-12-01' }),
  inv({ id: 'f2', orderId: 'of2', factored: true, factoringItemId: 'x2', balanceCents: 3_000, totalCents: 3_000, dueAt: '2026-12-01' }),
  inv({ id: 'draft', orderId: 'od', balanceCents: 9_999, totalCents: 9_999 }),
]
const recentPaid = [
  inv({ id: 'p1', status: 'PAID', balanceCents: 0, paidCents: 4_000, totalCents: 4_000, paidAt: '2026-11-03T12:00:00Z' }),
  inv({ id: 'p2', status: 'PAID', balanceCents: 0, paidCents: 6_000, totalCents: 6_000, paidAt: '2026-11-10T12:00:00Z', invoiceMonth: '2026-09' }),
  inv({ id: 'p1', status: 'PAID', balanceCents: 0, paidCents: 4_000, totalCents: 4_000, paidAt: '2026-11-03T12:00:00Z' }),
  inv({ id: 'p3', status: 'PAID', balanceCents: 0, paidCents: 1_000, totalCents: 1_000, paidAt: '2026-10-20T12:00:00Z' }),
]

function page(billedBy: ArBilledBy) {
  const split = splitOpenInvoices(open, lookups, undefined, (i) => i.id !== 'draft')
  const drafts = new Set(split.drafts.map((r) => r.invoiceId))
  const sentOpen = open.filter((i) => !drafts.has(i.id))
  const summary = computeArSummary({ open: sentOpen, paid: recentPaid, factorByItemId: new Map(), shipmentsById: lookups.shipmentsById, divisionName: lookups.divisionName, asOf: '2026-11-15' })
  const invoiced = split.invoiced.filter((r) => billedByMatches(r, billedBy))
  const aging = ageInvoices(sentOpen, '2026-11-15T12:00:00Z', { fromInvoiceDate: true })
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const tabs = arTabs({
    billedBy,
    ready: { count: split.drafts.length, total: formatCents(sum(split.drafts.map((r) => r.amountCents))) },
    invoiced: { count: invoiced.length, total: formatCents(sum(invoiced.map((r) => r.balanceCents))) },
    aging: { count: sentOpen.length, total: formatCents(aging.totalCents) },
    review: 3,
  })
  return { summary, tabs: new Map(tabs.map((t) => [t.key, t])), chips: new Map(arCompactItems(summary).map((c) => [c.key, c])) }
}

describe('Invoicing tabs tie to the Receivables card', () => {
  it('Billed: All — Invoiced and Aging are Open AR', () => {
    const { summary, tabs, chips } = page('all')
    expect(summary.openCount).toBe(4)
    expect(tabs.get('invoiced')?.count).toBe(summary.openCount)
    expect(tabs.get('invoiced')?.label).toBe('Invoiced')
    expect(tabs.get('invoiced')?.title).toContain(`${formatCents(summary.openCents)} open`)
    expect(tabs.get('aging')?.count).toBe(summary.openCount)
    expect(tabs.get('aging')?.label).toBe('Aging')
    expect(tabs.get('aging')?.title).toContain(`${formatCents(summary.openCents)} open`)
    expect(tabs.get('ready')?.label).toBe('Ready to Invoice')
    expect(chips.get('open')?.value).toBe(formatCents(summary.openCents))
  })

  it('Manually invoiced is Pending with shippers; Factored is Pending with OTR', () => {
    const manual = page('manual')
    expect(manual.tabs.get('invoiced')?.count).toBe(manual.summary.pendingShippersCount)
    expect(manual.tabs.get('invoiced')?.label).toBe('Invoiced')
    expect(manual.tabs.get('invoiced')?.title).toContain(`${formatCents(manual.summary.pendingShippersCents)} open`)
    const factored = page('factored')
    expect(factored.tabs.get('invoiced')?.count).toBe(factored.summary.pendingOtrCount)
    expect(factored.tabs.get('invoiced')?.label).toBe('Invoiced')
    expect(factored.tabs.get('invoiced')?.title).toContain(`${formatCents(factored.summary.pendingOtrCents)} open`)
    // Aging ignores the billed view, like the card.
    expect(manual.tabs.get('aging')?.count).toBe(manual.summary.openCount)
  })

  it('an unsent draft is not a receivable: it is Ready to invoice, not Open AR', () => {
    const { summary, tabs } = page('all')
    expect(tabs.get('ready')?.count).toBe(1)
    expect(summary.openCents).toBe(10_000 + 2_500 + 7_000 + 3_000)
  })

  it('has no Payments & credits tab: it is the Payments received page now', () => {
    expect(page('all').tabs.has('payments')).toBe(false)
  })

  it('has no Paid tab in any billed view (Ryne 2026-11-16): paid lives on Payments received', () => {
    for (const billedBy of ['all', 'manual', 'factored'] as const) {
      expect([...page(billedBy).tabs.keys()]).toEqual(['ready', 'invoiced', 'aging', 'review'])
    }
  })

  it('paidInMonthOf counts each invoice once, by paid date', () => {
    expect(paidInMonthOf(recentPaid, '2026-11').map((i) => i.id)).toEqual(['p1', 'p2'])
    expect(paidInMonthOf(recentPaid, '2026-10').map((i) => i.id)).toEqual(['p3'])
  })
})
