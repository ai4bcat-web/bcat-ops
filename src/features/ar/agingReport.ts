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
import { AR_AGING_BUCKETS, AR_AGING_BUCKET_LABEL, daysLate, daysSinceInvoice, invoiceAgeBucket } from '@/lib/arAging'
import type { InvoiceRecord, OtrOffsetFlag } from '@/types/tms'
import { isFactoredInvoice } from '@/lib/agingStatement'
import { chicagoDateStr } from '@/lib/date'

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
  /** OTR Solutions offset this invoice (internal marker; never on a customer statement). */
  otrOffset: OtrOffsetFlag | null
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
  /** When the aging report was last e-mailed to this customer (Customer.agingStatementSentAt); null = never sent. */
  lastStatementAt: string | null
  /** Who it went to (Customer.agingStatementSentTo), for the hover text. */
  lastStatementTo: string | null
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
    lastStatementOf?: (customerId: string) => { at: string | null; to: string | null } | null
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
      otrOffset: inv.otrOffset ?? null,
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
        lastStatementAt: lookups.lastStatementOf?.(inv.customerId)?.at || null,
        lastStatementTo: lookups.lastStatementOf?.(inv.customerId)?.to || null,
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

export type AgingSortKey = 'customer' | AgingReportBucket | 'total' | 'pastDue' | 'oldest' | 'lastPaid' | 'lastStatement' | 'terms' | 'count' | 'daysToPay'

export function sortAgingCustomers(rows: readonly AgingReportCustomer[], key: AgingSortKey, dir: 'asc' | 'desc'): AgingReportCustomer[] {
  const val = (c: AgingReportCustomer): string | number => {
    switch (key) {
      case 'customer': return c.customerName.toLowerCase()
      case 'total': return c.totalCents
      case 'pastDue': return c.pastDueCents
      case 'oldest': return c.oldestDays
      case 'lastPaid': return c.lastPaidAt ?? ''
      // Never sent sorts as the oldest: ascending puts the customers nobody has e-mailed first.
      case 'lastStatement': return c.lastStatementAt ?? ''
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
  /** The last aging report e-mailed to the customer ('' = any). */
  statement: AgingStatementFilter
  /** Column filters: min/max per numeric column (dollars for money columns, days or counts for the rest). */
  ranges: Partial<Record<AgingRangeKey, AgingRange>>
  /** Last paid from / to (YYYY-MM-DD, Chicago day); either may be ''. */
  lastPaidFrom: string
  lastPaidTo: string
  /** Only customers with no payment on file. */
  lastPaidBlank: boolean
  /** Last aging report sent within / not sent in the last N days (a custom count for the column filter); null = off. */
  statementWithinDays: number | null
  statementOlderDays: number | null
}

/** The numeric columns that take a min/max column filter. */
export type AgingRangeKey = AgingReportBucket | 'total' | 'pastDue' | 'count' | 'oldest' | 'daysToPay'
export interface AgingRange { min?: number; max?: number }
export const AGING_RANGE_KEYS: readonly AgingRangeKey[] = [...AR_AGING_BUCKETS, 'total', 'pastDue', 'count', 'oldest', 'daysToPay']

/** Never sent, sent in the last 7 days, or not sent in 14+ days (never counts as not sent). */
export type AgingStatementFilter = '' | 'never' | 'recent' | 'stale'

export const AGING_STATEMENT_FILTER_LABEL: Record<Exclude<AgingStatementFilter, ''>, string> = {
  never: 'Never sent',
  recent: 'Sent in the last 7 days',
  stale: 'Not sent in 14+ days',
}

/** Whole Chicago calendar days since the aging report went out; null when it never did. */
export function daysSinceStatement(sentAt: string | null | undefined, nowIso: string): number | null {
  if (!sentAt) return null
  const sent = chicagoDateStr(sentAt)
  const today = chicagoDateStr(nowIso)
  if (!sent || !today) return null
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${sent}T00:00:00Z`)) / 86_400_000)
}

/** 'today', 'yesterday' or '3d ago'. */
export function statementAgoLabel(days: number | null): string {
  if (days == null) return ''
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

export const EMPTY_AGING_FILTERS: AgingFilters = {
  search: '', customer: '', terms: '', buckets: [], pastDueOnly: false, statement: '',
  ranges: {}, lastPaidFrom: '', lastPaidTo: '', lastPaidBlank: false, statementWithinDays: null, statementOlderDays: null,
}

const rangeActive = (r: AgingRange | undefined): boolean => r != null && (r.min != null || r.max != null)

/** How many filters are on: each text box, dropdown, chip and column filter counts once. */
export function agingFilterCount(f: AgingFilters): number {
  const ranges = AGING_RANGE_KEYS.filter((k) => rangeActive(f.ranges?.[k])).length
  const paid = (f.lastPaidFrom || f.lastPaidTo ? 1 : 0) + (f.lastPaidBlank ? 1 : 0)
  const custom = (f.statementWithinDays != null ? 1 : 0) + (f.statementOlderDays != null ? 1 : 0)
  return (f.search.trim() ? 1 : 0) + (f.customer.trim() ? 1 : 0) + (f.terms ? 1 : 0) + f.buckets.length + (f.pastDueOnly ? 1 : 0)
    + (f.statement ? 1 : 0) + ranges + paid + custom
}

/** The customer's value in a numeric column, in the unit its filter uses (dollars for money); null when it has none. */
export function agingRangeValue(c: AgingReportCustomer, key: AgingRangeKey): number | null {
  switch (key) {
    case 'total': return c.totalCents / 100
    case 'pastDue': return c.pastDueCents / 100
    case 'count': return c.count
    case 'oldest': return c.oldestDays
    case 'daysToPay': return c.avgDaysToPay
    default: return c.byBucket[key] / 100
  }
}

export function filterAgingCustomers(rows: readonly AgingReportCustomer[], f: AgingFilters, nowIso: string = new Date().toISOString()): AgingReportCustomer[] {
  const q = f.search.trim().toLowerCase()
  const cust = f.customer.trim().toLowerCase()
  return rows.filter((c) => {
    if (cust && !c.customerName.toLowerCase().includes(cust)) return false
    if (f.terms && String(c.termsDays ?? '') !== f.terms) return false
    if (f.pastDueOnly && c.pastDueCents <= 0) return false
    if (f.buckets.length && !f.buckets.some((b) => c.byBucket[b] > 0)) return false
    for (const k of AGING_RANGE_KEYS) {
      const r = f.ranges?.[k]
      if (!rangeActive(r)) continue
      const v = agingRangeValue(c, k)
      // A blank (no average yet) never satisfies a number range.
      if (v == null) return false
      if (r!.min != null && v < r!.min) return false
      if (r!.max != null && v > r!.max) return false
    }
    if (f.lastPaidBlank && c.lastPaidAt) return false
    if (f.lastPaidFrom || f.lastPaidTo) {
      const day = c.lastPaidAt ? chicagoDateStr(c.lastPaidAt) : ''
      if (!day) return false
      if (f.lastPaidFrom && day < f.lastPaidFrom) return false
      if (f.lastPaidTo && day > f.lastPaidTo) return false
    }
    if (f.statementWithinDays != null) {
      const d = daysSinceStatement(c.lastStatementAt, nowIso)
      if (d == null || d > f.statementWithinDays) return false
    }
    if (f.statementOlderDays != null) {
      const d = daysSinceStatement(c.lastStatementAt, nowIso)
      if (d != null && d < f.statementOlderDays) return false
    }
    if (f.statement) {
      const days = daysSinceStatement(c.lastStatementAt, nowIso)
      if (f.statement === 'never' && days != null) return false
      if (f.statement === 'recent' && (days == null || days > 7)) return false
      if (f.statement === 'stale' && days != null && days < 14) return false
    }
    if (q) {
      const hit = c.customerName.toLowerCase().includes(q)
        || c.invoices.some((i) => [i.pro, i.number, i.customerRef ?? ''].some((v) => v.toLowerCase().includes(q)))
      if (!hit) return false
    }
    return true
  })
}

export type AgingInvoiceSortKey = 'pro' | 'number' | 'customerRef' | 'invoiceDate' | 'dueAt' | 'ageDays' | 'daysPastDue' | 'totalCents' | 'paidCents' | 'balanceCents' | 'bucket' | 'factored'

/** The order the open invoices under a customer have always had: due date, then invoice date. */
export const DEFAULT_AGING_INVOICE_SORT: { key: AgingInvoiceSortKey; dir: 'asc' | 'desc' } = { key: 'dueAt', dir: 'asc' }

const BUCKET_ORDER: Record<AgingReportBucket, number> = { D1_30: 0, D31_60: 1, D61_90: 2, D91_PLUS: 3 }

/** A customer's open invoices in the chosen order; ties fall back to invoice number so the order is stable. */
export function sortAgingInvoices(rows: readonly AgingReportInvoice[], key: AgingInvoiceSortKey, dir: 'asc' | 'desc'): AgingReportInvoice[] {
  const val = (i: AgingReportInvoice): string | number => {
    switch (key) {
      case 'pro': return i.pro.toLowerCase()
      case 'number': return i.number.toLowerCase()
      case 'customerRef': return (i.customerRef ?? '').toLowerCase()
      case 'invoiceDate': return i.invoiceDate || ''
      case 'dueAt': return i.dueAt || ''
      case 'bucket': return BUCKET_ORDER[i.bucket]
      case 'factored': return i.factored ? 1 : 0
      default: return i[key]
    }
  }
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b)
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
    return cmp * sign || a.number.localeCompare(b.number, undefined, { numeric: true })
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

/** One CSV cell; a leading = + - @ is neutralised so a spreadsheet can't read a name as a formula. */
function csvCell(v: string | number | null): string {
  let t = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(t) && typeof v === 'string') t = `'${t}`
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}
const dollars = (cents: number): string => (cents / 100).toFixed(2)

/** The customers on screen (filtered and sorted) as CSV: one row per customer, amounts in dollars. */
export function agingReportCsv(rows: readonly AgingReportCustomer[]): string {
  const head = ['Customer', 'Terms', 'Avg days to pay', ...AR_AGING_BUCKETS.map((b) => AR_AGING_BUCKET_LABEL[b]), 'Total open', 'Past due', 'Invoices', 'Oldest (days)', 'Last paid', 'Last aging report']
  const lines = [head.map(csvCell).join(',')]
  for (const c of rows) {
    lines.push([
      c.customerName,
      c.termsDays == null ? '' : `Net ${c.termsDays}`,
      c.avgDaysToPay == null ? '' : Math.round(c.avgDaysToPay),
      ...AR_AGING_BUCKETS.map((b) => dollars(c.byBucket[b])),
      dollars(c.totalCents), dollars(c.pastDueCents), c.count, c.oldestDays,
      c.lastPaidAt ? chicagoDateStr(c.lastPaidAt) : '',
      c.lastStatementAt ? chicagoDateStr(c.lastStatementAt) : 'Never',
    ].map(csvCell).join(','))
  }
  return lines.join('\r\n')
}
