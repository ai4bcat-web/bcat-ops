/**
 * The Aging tab's report: one row per customer with what they owe in each aging column, and under
 * each customer (the twisty) every open invoice that makes up those numbers.
 *
 * Aged from the INVOICE date (0–30 / 31–60 / 61–90 / 90+), the same basis as the aging statement
 * the customer is e-mailed (agingStatement.ts) and Aljex's aging, so the two never disagree.
 * "Past due" is the due-date view alongside it: the balance whose due date has passed.
 *
 * It ages the same invoices the Open AR card counts (sent, still open, factored included), so the
 * totals row equals Open AR. Factored invoices are flagged: OTR collects them, and the customer's
 * statement leaves them off.
 */
import { AR_AGING_BUCKETS, daysLate, daysSinceInvoice, invoiceAgeBucket } from '@/lib/arAging'
import type { InvoiceRecord } from '@/types/tms'
import { isFactoredInvoice } from '@/lib/agingStatement'

export type AgingReportBucket = (typeof AR_AGING_BUCKETS)[number]

const OPEN = new Set(['ISSUED', 'PARTIAL'])

export interface AgingReportInvoice {
  id: string
  number: string
  pro: string
  shipmentId: string
  customerRef: string | null
  invoiceDate: string
  dueAt: string
  /** Days since the invoice date (what the bucket is from). */
  ageDays: number
  /** Days past the due date; 0 when not yet due. */
  daysPastDue: number
  totalCents: number
  paidCents: number
  balanceCents: number
  bucket: AgingReportBucket
  factored: boolean
}

export interface AgingReportCustomer {
  customerId: string
  customerName: string
  termsDays: number | null
  byBucket: Record<AgingReportBucket, number>
  totalCents: number
  pastDueCents: number
  factoredCents: number
  count: number
  /** Days since the oldest open invoice's invoice date. */
  oldestDays: number
  lastPaidAt: string | null
  /** The customer's average days to pay (invoice date → paid), factored invoices left out; null until read. */
  avgDaysToPay: number | null
  invoices: AgingReportInvoice[]
}

export interface AgingReport {
  customers: AgingReportCustomer[]
  byBucket: Record<AgingReportBucket, number>
  totalCents: number
  pastDueCents: number
  factoredCents: number
  count: number
}

const emptyBuckets = (): Record<AgingReportBucket, number> => ({ D1_30: 0, D31_60: 0, D61_90: 0, D91_PLUS: 0 })

export function buildAgingReport(
  invoices: readonly InvoiceRecord[],
  asOf: string,
  lookups: {
    refOf?: (inv: InvoiceRecord) => string | null
    termsOf?: (customerId: string) => number | null
    lastPaidOf?: (customerId: string) => string | null
    avgDaysToPayOf?: (customerId: string) => number | null
  } = {},
): AgingReport {
  const byCustomer = new Map<string, AgingReportCustomer>()
  const report: AgingReport = { customers: [], byBucket: emptyBuckets(), totalCents: 0, pastDueCents: 0, factoredCents: 0, count: 0 }
  for (const inv of invoices) {
    if (!OPEN.has(inv.status)) continue
    const bucket = invoiceAgeBucket(inv.invoiceDate, asOf) as AgingReportBucket
    const daysPastDue = inv.dueAt ? Math.max(0, daysLate(inv.dueAt, asOf)) : 0
    const factored = isFactoredInvoice(inv)
    const row: AgingReportInvoice = {
      id: inv.id,
      number: inv.number,
      pro: inv.shipmentNumber ?? '',
      shipmentId: inv.shipmentId,
      customerRef: lookups.refOf?.(inv) ?? null,
      invoiceDate: inv.invoiceDate,
      dueAt: inv.dueAt,
      ageDays: daysSinceInvoice(inv.invoiceDate, asOf) ?? 0,
      daysPastDue,
      totalCents: inv.totalCents,
      paidCents: inv.paidCents + (inv.writtenOffCents ?? 0),
      balanceCents: inv.balanceCents,
      bucket,
      factored,
    }
    let c = byCustomer.get(inv.customerId)
    if (!c) {
      c = {
        customerId: inv.customerId,
        customerName: inv.customerName || inv.customerId,
        termsDays: lookups.termsOf?.(inv.customerId) ?? null,
        byBucket: emptyBuckets(),
        totalCents: 0,
        pastDueCents: 0,
        factoredCents: 0,
        count: 0,
        oldestDays: 0,
        lastPaidAt: lookups.lastPaidOf?.(inv.customerId) ?? null,
        avgDaysToPay: lookups.avgDaysToPayOf?.(inv.customerId) ?? null,
        invoices: [],
      }
      byCustomer.set(inv.customerId, c)
    }
    c.invoices.push(row)
    c.byBucket[bucket] += row.balanceCents
    c.totalCents += row.balanceCents
    c.count++
    c.oldestDays = Math.max(c.oldestDays, row.ageDays)
    if (daysPastDue > 0) c.pastDueCents += row.balanceCents
    if (factored) c.factoredCents += row.balanceCents
    report.byBucket[bucket] += row.balanceCents
    report.totalCents += row.balanceCents
    report.count++
    if (daysPastDue > 0) report.pastDueCents += row.balanceCents
    if (factored) report.factoredCents += row.balanceCents
  }
  for (const c of byCustomer.values()) {
    c.invoices.sort((a, b) => (a.dueAt || '').localeCompare(b.dueAt || '') || a.invoiceDate.localeCompare(b.invoiceDate) || a.number.localeCompare(b.number))
  }
  report.customers = [...byCustomer.values()].sort((a, b) => b.totalCents - a.totalCents || a.customerName.localeCompare(b.customerName))
  return report
}

export type AgingSortKey = 'customer' | AgingReportBucket | 'total' | 'pastDue' | 'oldest' | 'lastPaid' | 'terms' | 'count' | 'daysToPay'

export function sortAgingCustomers(rows: readonly AgingReportCustomer[], key: AgingSortKey, dir: 'asc' | 'desc'): AgingReportCustomer[] {
  const val = (c: AgingReportCustomer): string | number => {
    switch (key) {
      case 'customer': return c.customerName.toLowerCase()
      case 'total': return c.totalCents
      case 'pastDue': return c.pastDueCents
      case 'oldest': return c.oldestDays
      case 'lastPaid': return c.lastPaidAt ?? ''
      case 'terms': return c.termsDays ?? -1
      case 'daysToPay': return c.avgDaysToPay ?? -1
      case 'count': return c.count
      default: return c.byBucket[key]
    }
  }
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b)
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return cmp * sign || a.customerName.localeCompare(b.customerName)
  })
}

/** The default order Ryne asked for: customer name A→Z. */
export const DEFAULT_AGING_SORT: { key: AgingSortKey; dir: 'asc' | 'desc' } = { key: 'customer', dir: 'asc' }

export interface AgingFilters {
  /** Free text: matches the customer name, or any invoice's PRO, invoice # or PO. */
  search: string
  /** Customer-name text filter. */
  customer: string
  /** Payment terms in days ('' = any). */
  terms: string
  /** Only customers with a balance in these buckets (any of them). */
  buckets: AgingReportBucket[]
  /** Only customers with something past due. */
  pastDueOnly: boolean
}

export const EMPTY_AGING_FILTERS: AgingFilters = { search: '', customer: '', terms: '', buckets: [], pastDueOnly: false }

export function agingFilterCount(f: AgingFilters): number {
  return (f.search.trim() ? 1 : 0) + (f.customer.trim() ? 1 : 0) + (f.terms ? 1 : 0) + f.buckets.length + (f.pastDueOnly ? 1 : 0)
}

export function filterAgingCustomers(rows: readonly AgingReportCustomer[], f: AgingFilters): AgingReportCustomer[] {
  const q = f.search.trim().toLowerCase()
  const cust = f.customer.trim().toLowerCase()
  return rows.filter((c) => {
    if (cust && !c.customerName.toLowerCase().includes(cust)) return false
    if (f.terms && String(c.termsDays ?? '') !== f.terms) return false
    if (f.pastDueOnly && c.pastDueCents <= 0) return false
    if (f.buckets.length && !f.buckets.some((b) => c.byBucket[b] > 0)) return false
    if (q) {
      const hit = c.customerName.toLowerCase().includes(q)
        || c.invoices.some((i) => [i.pro, i.number, i.customerRef ?? ''].some((v) => v.toLowerCase().includes(q)))
      if (!hit) return false
    }
    return true
  })
}

/** Totals for the rows on screen, so the totals row follows the filters. */
export function summarizeAging(rows: readonly AgingReportCustomer[]): Omit<AgingReport, 'customers'> {
  const out = { byBucket: emptyBuckets(), totalCents: 0, pastDueCents: 0, factoredCents: 0, count: 0 }
  for (const c of rows) {
    for (const b of AR_AGING_BUCKETS as readonly AgingReportBucket[]) out.byBucket[b] += c.byBucket[b]
    out.totalCents += c.totalCents
    out.pastDueCents += c.pastDueCents
    out.factoredCents += c.factoredCents
    out.count += c.count
  }
  return out
}
