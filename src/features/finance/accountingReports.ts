/**
 * The Reports menu on Receivable and Payable (Ryne 2026-11-14): each report is a table of plain
 * cells built from records the caller has read, filtered by a date range, a customer/carrier
 * name and a status. Pure — `loadAccountingReport` does the reads, `reportCsv` writes the file.
 *
 * Internal only. Carrier pay and margin appear in these files; nothing here feeds a customer
 * document (statements and invoices are built elsewhere).
 */
import {
  AR_AGING_BUCKETS, AR_AGING_BUCKET_LABEL, AGING_BUCKETS, AGING_BUCKET_LABEL, ageInvoices, agingBucket, daysLate, daysSinceInvoice, invoiceAgeBucket,
} from '@/lib/arAging'
import { PAYMENT_METHOD_LABEL, paymentLinesByInvoice, settlementOf } from '@/lib/daysToPay'
import { billsExpected } from '@/features/ap/apViews'
import type { FinanceReviewShipment } from '@/lib/apiClient'
import type { ArPaymentRecord, CarrierBillRecord, InvoiceRecord, LaneRateSampleRecord } from '@/types/tms'
import { REVIEW_REASON_LABEL, reviewReasonKeys, type ReviewReasonKey } from './accountingStats'

export type ReportSide = 'AR' | 'AP'

export type AccountingReportKind =
  | 'arAgingSummary' | 'arAgingDetail' | 'arOpen' | 'arPayments' | 'arDaysToPay'
  | 'apAging' | 'apOpen' | 'apPaid' | 'apExpected'
  | 'marginByLoad' | 'needsReview'

export interface ReportStatusOption { key: string; label: string }

export interface AccountingReportDef {
  kind: AccountingReportKind
  title: string
  /** Which page lists it; `both` shows on Receivable and Payable. */
  side: ReportSide | 'both'
  /** What the date range filters on; null = the report is "as of today" and ignores it. */
  dateBasis: string | null
  partyLabel: 'Customer' | 'Carrier' | 'Customer or carrier'
  statuses: ReportStatusOption[]
}

const ALL: ReportStatusOption = { key: 'all', label: 'All' }

export const ACCOUNTING_REPORTS: AccountingReportDef[] = [
  { kind: 'arAgingSummary', title: 'AR aging by customer', side: 'AR', dateBasis: null, partyLabel: 'Customer', statuses: [ALL, { key: 'late', label: 'Customers with late invoices' }] },
  { kind: 'arAgingDetail', title: 'AR aging detail (by invoice)', side: 'AR', dateBasis: 'Invoice date', partyLabel: 'Customer', statuses: [ALL, { key: 'late', label: 'Past due' }, ...AR_AGING_BUCKETS.map((b) => ({ key: b, label: `${AR_AGING_BUCKET_LABEL[b]} days` }))] },
  { kind: 'arOpen', title: 'Open invoices', side: 'AR', dateBasis: 'Invoice date', partyLabel: 'Customer', statuses: [ALL, { key: 'late', label: 'Past due' }, { key: 'partial', label: 'Partially paid' }, { key: 'factored', label: 'Factored (OTR)' }, { key: 'manual', label: 'Invoiced manually' }] },
  { kind: 'arPayments', title: 'Payments received', side: 'AR', dateBasis: 'Received date', partyLabel: 'Customer', statuses: [ALL, { key: 'ACH', label: 'ACH' }, { key: 'CHECK', label: 'Paper check' }, { key: 'other', label: 'Other' }] },
  { kind: 'arDaysToPay', title: 'Days to pay by customer', side: 'AR', dateBasis: 'Invoice date', partyLabel: 'Customer', statuses: [ALL] },
  { kind: 'apAging', title: 'AP aging by carrier', side: 'AP', dateBasis: null, partyLabel: 'Carrier', statuses: [ALL, { key: 'late', label: 'Carriers with past-due bills' }] },
  { kind: 'apOpen', title: 'Open bills', side: 'AP', dateBasis: 'Due date', partyLabel: 'Carrier', statuses: [ALL, { key: 'late', label: 'Past due' }, { key: 'IN_REVIEW', label: 'In review' }, { key: 'TO_BE_PAID', label: 'To be paid' }, { key: 'PARTIAL', label: 'Partially paid' }, { key: 'FACTOR', label: 'Pay to factor' }] },
  { kind: 'apPaid', title: 'Bills paid', side: 'AP', dateBasis: 'Paid date', partyLabel: 'Carrier', statuses: [ALL, { key: 'FACTOR', label: 'Paid to factor' }, { key: 'CARRIER', label: 'Paid direct' }] },
  { kind: 'apExpected', title: 'Expected carrier cost (not yet billed)', side: 'AP', dateBasis: 'Recorded date', partyLabel: 'Carrier', statuses: [ALL, { key: 'flagged', label: 'Needs fix' }] },
  { kind: 'marginByLoad', title: 'Margin by load (internal)', side: 'both', dateBasis: 'Load date', partyLabel: 'Customer or carrier', statuses: [ALL, { key: 'negative', label: 'Negative margin only' }, { key: 'thin', label: 'Under 10% margin' }] },
  { kind: 'needsReview', title: 'Needs review list', side: 'both', dateBasis: 'Flagged date', partyLabel: 'Customer', statuses: [ALL, ...(Object.keys(REVIEW_REASON_LABEL) as ReviewReasonKey[]).map((k) => ({ key: k, label: REVIEW_REASON_LABEL[k] }))] },
]

export const reportDef = (kind: AccountingReportKind): AccountingReportDef => ACCOUNTING_REPORTS.find((r) => r.kind === kind) ?? ACCOUNTING_REPORTS[0]

export const reportsFor = (side: ReportSide): AccountingReportDef[] => ACCOUNTING_REPORTS.filter((r) => r.side === side || r.side === 'both')

export interface ReportFilters {
  /** YYYY-MM-DD, inclusive; '' = open-ended. */
  from: string
  to: string
  /** Case-insensitive contains on the customer / carrier name. */
  party: string
  status: string
  /** Today (Chicago), for every "as of" figure. */
  asOf: string
}

/** Everything a report may need; the loader fills only what the chosen report reads. */
export interface ReportData {
  openInvoices?: InvoiceRecord[]
  invoices?: InvoiceRecord[]
  payments?: ArPaymentRecord[]
  openBills?: CarrierBillRecord[]
  bills?: CarrierBillRecord[]
  samples?: LaneRateSampleRecord[]
  review?: FinanceReviewShipment[]
}

export type Cell = string | number | null
export interface ReportTable { columns: string[]; rows: Cell[][] }

const ymd = (iso: string | null | undefined): string => (/^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '') ?? [])[1] ?? ''
const inRange = (iso: string | null | undefined, f: ReportFilters): boolean => {
  const d = ymd(iso)
  if (!f.from && !f.to) return true
  if (!d) return false
  return (!f.from || d >= f.from) && (!f.to || d <= f.to)
}
const nameMatch = (name: string | null | undefined, f: ReportFilters): boolean =>
  !f.party.trim() || (name ?? '').toLowerCase().includes(f.party.trim().toLowerCase())
/** Dollars with two decimals, no symbol, so a spreadsheet reads the column as a number. */
const usd = (cents: number | null | undefined): number | null => (cents == null ? null : Math.round(cents) / 100)
const pct = (bps: number | null | undefined): number | null => (bps == null ? null : Math.round(bps) / 100)
const isFactoredInvoice = (inv: InvoiceRecord) => Boolean(inv.factored || inv.factoringItemId)
const openInvoice = (inv: InvoiceRecord) => (inv.status === 'ISSUED' || inv.status === 'PARTIAL') && inv.balanceCents > 0
const openBill = (b: CarrierBillRecord) => b.status !== 'PAID' && b.status !== 'VOID' && b.balanceCents > 0

export function buildAccountingReport(kind: AccountingReportKind, data: ReportData, f: ReportFilters): ReportTable {
  const all = f.status === 'all' || !f.status
  switch (kind) {
    case 'arAgingSummary': {
      const open = (data.openInvoices ?? []).filter((inv) => openInvoice(inv) && nameMatch(inv.customerName, f))
      const aging = ageInvoices(open, f.asOf, { fromInvoiceDate: true })
      const rows = aging.byCustomer.filter((c) => all || c.lateCount > 0)
      return {
        columns: ['Customer', ...AR_AGING_BUCKETS.map((b) => `${AR_AGING_BUCKET_LABEL[b]} days`), 'Total open', 'Past-due invoices', 'Oldest days past due'],
        rows: rows.map((c) => [c.customerName, ...AR_AGING_BUCKETS.map((b) => usd(c.byBucket[b])), usd(c.totalCents), c.lateCount, c.oldestDays || null]),
      }
    }
    case 'arAgingDetail':
    case 'arOpen': {
      const rows = (data.openInvoices ?? [])
        .filter((inv) => openInvoice(inv) && nameMatch(inv.customerName, f) && inRange(inv.invoiceDate, f))
        .filter((inv) => {
          if (all) return true
          const late = inv.dueAt ? daysLate(inv.dueAt, f.asOf) > 0 : false
          if (f.status === 'late') return late
          if (f.status === 'partial') return inv.paidCents > 0
          if (f.status === 'factored') return isFactoredInvoice(inv)
          if (f.status === 'manual') return !isFactoredInvoice(inv)
          return invoiceAgeBucket(inv.invoiceDate, f.asOf) === f.status
        })
        .sort((a, b) => (a.customerName ?? '').localeCompare(b.customerName ?? '') || a.invoiceDate.localeCompare(b.invoiceDate))
      if (kind === 'arAgingDetail') {
        return {
          columns: ['Customer', 'Invoice #', 'PRO', 'Invoice date', 'Due date', 'Days since invoice', 'Age bucket', 'Days past due', 'Total', 'Paid', 'Balance'],
          rows: rows.map((inv) => {
            const late = inv.dueAt ? daysLate(inv.dueAt, f.asOf) : 0
            return [inv.customerName ?? '', inv.number, inv.shipmentNumber ?? '', ymd(inv.invoiceDate), ymd(inv.dueAt), daysSinceInvoice(inv.invoiceDate, f.asOf),
              AR_AGING_BUCKET_LABEL[invoiceAgeBucket(inv.invoiceDate, f.asOf) as (typeof AR_AGING_BUCKETS)[number]] ?? '', late > 0 ? late : null,
              usd(inv.totalCents), usd(inv.paidCents), usd(inv.balanceCents)]
          }),
        }
      }
      return {
        columns: ['Customer', 'Invoice #', 'PRO', 'Invoice date', 'Due date', 'Terms (days)', 'Status', 'Billed', 'Sent', 'Sent to', 'Total', 'Paid', 'Balance'],
        rows: rows.map((inv) => [inv.customerName ?? '', inv.number, inv.shipmentNumber ?? '', ymd(inv.invoiceDate), ymd(inv.dueAt), inv.termsDays,
          inv.paidCents > 0 ? 'Partially paid' : 'Open', isFactoredInvoice(inv) ? 'Factored (OTR)' : 'Manual', ymd(inv.sentAt ?? inv.markedSentAt), inv.sentTo ?? '',
          usd(inv.totalCents), usd(inv.paidCents), usd(inv.balanceCents)]),
      }
    }
    case 'arPayments': {
      const invoicesById = new Map([...(data.invoices ?? []), ...(data.openInvoices ?? [])].map((inv) => [inv.id, inv]))
      const nameOf = (customerId: string) => [...invoicesById.values()].find((inv) => inv.customerId === customerId)?.customerName ?? customerId
      const rows: Cell[][] = []
      for (const p of data.payments ?? []) {
        if (p.kind !== 'PAYMENT' || p.reversedByPaymentId || !inRange(p.receivedAt, f)) continue
        const method = p.method ?? null
        if (!all && (f.status === 'other' ? method === 'ACH' || method === 'CHECK' : method !== f.status)) continue
        const customer = nameOf(p.customerId)
        if (!nameMatch(customer, f)) continue
        const label = method ? PAYMENT_METHOD_LABEL[method] ?? method : ''
        const apps = (p.applications ?? []).filter((a) => a.amountCents > 0)
        if (apps.length === 0) rows.push([ymd(p.receivedAt), customer, label, p.reference ?? '', usd(p.amountCents), '', '', null, usd(p.unappliedCents)])
        for (const a of apps) {
          const inv = invoicesById.get(a.invoiceId)
          rows.push([ymd(p.receivedAt), customer, label, p.reference ?? '', usd(p.amountCents), inv?.number ?? a.invoiceId, inv?.shipmentNumber ?? '', usd(a.amountCents), usd(p.unappliedCents)])
        }
      }
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])))
      return { columns: ['Received', 'Customer', 'Method', 'Check / ref #', 'Payment amount', 'Invoice #', 'PRO', 'Applied to invoice', 'Unapplied'], rows }
    }
    case 'arDaysToPay': {
      const lines = paymentLinesByInvoice(data.payments ?? [])
      const byCustomer = new Map<string, { name: string; days: number[]; cents: number }>()
      for (const inv of data.invoices ?? []) {
        if (inv.status !== 'PAID' || !inRange(inv.invoiceDate, f) || !nameMatch(inv.customerName, f)) continue
        const s = settlementOf(inv, lines.get(inv.id))
        if (s.daysToPay == null) continue
        const c = byCustomer.get(inv.customerId) ?? { name: inv.customerName ?? inv.customerId, days: [], cents: 0 }
        c.days.push(s.daysToPay)
        c.cents += inv.totalCents
        byCustomer.set(inv.customerId, c)
      }
      const rows = [...byCustomer.values()].map((c) => {
        const avg = Math.round((c.days.reduce((a, b) => a + b, 0) / c.days.length) * 10) / 10
        return [c.name, c.days.length, avg, Math.min(...c.days), Math.max(...c.days), usd(c.cents)] as Cell[]
      }).sort((a, b) => Number(b[2]) - Number(a[2]))
      return { columns: ['Customer', 'Paid invoices', 'Avg days to pay', 'Fastest (days)', 'Slowest (days)', 'Paid total'], rows }
    }
    case 'apAging': {
      type Acc = { name: string; byBucket: Record<string, number>; total: number; late: number; oldest: number }
      const by = new Map<string, Acc>()
      for (const b of data.openBills ?? []) {
        if (!openBill(b) || !nameMatch(b.carrierName, f)) continue
        const a = by.get(b.carrierId) ?? { name: b.carrierName ?? b.carrierId, byBucket: Object.fromEntries(AGING_BUCKETS.map((k) => [k, 0])), total: 0, late: 0, oldest: 0 }
        const bucket = b.dueAt ? agingBucket(b.dueAt, f.asOf) : 'CURRENT'
        a.byBucket[bucket] += b.balanceCents
        a.total += b.balanceCents
        const late = b.dueAt ? daysLate(b.dueAt, f.asOf) : 0
        if (late > 0) { a.late += 1; a.oldest = Math.max(a.oldest, late) }
        by.set(b.carrierId, a)
      }
      const rows = [...by.values()].filter((a) => all || a.late > 0).sort((x, y) => y.total - x.total)
      return {
        columns: ['Carrier', ...AGING_BUCKETS.map((k) => (k === 'CURRENT' ? 'Not yet due' : `${AGING_BUCKET_LABEL[k]} days past due`)), 'Total open', 'Past-due bills', 'Oldest days past due'],
        rows: rows.map((a) => [a.name, ...AGING_BUCKETS.map((k) => usd(a.byBucket[k])), usd(a.total), a.late, a.oldest || null]),
      }
    }
    case 'apOpen': {
      const rows = (data.openBills ?? [])
        .filter((b) => openBill(b) && nameMatch(b.carrierName, f) && inRange(b.dueAt, f))
        .filter((b) => all || (f.status === 'late' ? Boolean(b.dueAt) && daysLate(b.dueAt, f.asOf) > 0 : f.status === 'FACTOR' ? b.payeeKind === 'FACTOR' : b.status === f.status))
        .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
      return {
        columns: ['Carrier', 'PRO', 'Bill #', 'Bill date', 'Due date', 'Days past due', 'Status', 'Pay to', 'Net', 'Paid', 'Balance'],
        rows: rows.map((b) => {
          const late = b.dueAt ? daysLate(b.dueAt, f.asOf) : 0
          return [b.carrierName ?? '', b.shipmentNumber ?? '', b.billNumber ?? '', ymd(b.billDate), ymd(b.dueAt), late > 0 ? late : null,
            b.datesPending ? 'Expected' : b.status, b.payeeKind === 'FACTOR' ? (b.remitTo?.name ?? 'Factor') : 'Carrier', usd(b.netCents), usd(b.paidCents), usd(b.balanceCents)]
        }),
      }
    }
    case 'apPaid': {
      const rows = (data.bills ?? [])
        .filter((b) => b.status === 'PAID' && inRange(b.paidAt, f) && nameMatch(b.carrierName, f) && (all || b.payeeKind === f.status))
        .sort((a, b) => String(a.paidAt).localeCompare(String(b.paidAt)))
      return {
        columns: ['Paid date', 'Carrier', 'PRO', 'Bill #', 'Bill date', 'Due date', 'Pay to', 'Net', 'Paid'],
        rows: rows.map((b) => [ymd(b.paidAt), b.carrierName ?? '', b.shipmentNumber ?? '', b.billNumber ?? '', ymd(b.billDate), ymd(b.dueAt),
          b.payeeKind === 'FACTOR' ? (b.remitTo?.name ?? 'Factor') : 'Carrier', usd(b.netCents), usd(b.paidCents)]),
      }
    }
    case 'apExpected': {
      const flagged = new Map((data.review ?? []).map((r) => [r.id, r.financeReviewReason ?? '']))
      const rows = billsExpected((data.openBills ?? []).filter((b) => nameMatch(b.carrierName, f) && inRange(b.recordedAt, f)))
        .filter((b) => all || flagged.has(b.shipmentId))
      return {
        columns: ['Carrier', 'PRO', 'Recorded', 'Expected cost', 'Needs review'],
        rows: rows.map((b) => [b.carrierName ?? '', b.shipmentNumber ?? '', ymd(b.recordedAt), usd(b.balanceCents), flagged.get(b.shipmentId) ?? '']),
      }
    }
    case 'marginByLoad': {
      const seen = new Set<string>()
      const rows: Cell[][] = []
      for (const s of data.samples ?? []) {
        if (s.excluded || seen.has(s.loadId) || !inRange(s.date, f)) continue
        if (!nameMatch(s.customerName, f) && !nameMatch(s.carrierName, f)) continue
        seen.add(s.loadId)
        const rev = s.revenueCents ?? 0
        const cost = s.costCents ?? 0
        const profit = s.profitCents ?? rev - cost
        const bps = s.marginBps ?? (rev ? Math.round((profit * 10_000) / rev) : null)
        if (f.status === 'negative' && !(profit < 0)) continue
        if (f.status === 'thin' && !(bps != null && bps < 1000)) continue
        rows.push([ymd(s.deliveredAt ?? s.date), s.shipmentNumber ?? s.shipmentId, s.customerName ?? '', s.carrierName ?? '', s.revDivision ?? s.divisionKey ?? '',
          usd(rev), usd(cost), usd(profit), pct(bps)])
      }
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      return { columns: ['Date', 'PRO', 'Customer', 'Carrier', 'Division', 'Revenue', 'Carrier cost', 'Profit', 'Margin %'], rows }
    }
    case 'needsReview': {
      const rows = (data.review ?? [])
        .filter((r) => nameMatch(r.customerName, f) && inRange(r.financeReviewAt, f) && (all || reviewReasonKeys(r.financeReviewReason).includes(f.status as ReviewReasonKey)))
        .sort((a, b) => String(a.number).localeCompare(String(b.number)))
      return {
        columns: ['PRO', 'Customer', 'Status', 'Delivered', 'Flagged', 'Reason', 'AP note'],
        rows: rows.map((r) => [r.number ?? '', r.customerName ?? '', r.status ?? '', ymd(r.deliveredAt), ymd(r.financeReviewAt), r.financeReviewReason ?? '', r.financeReviewApNote ?? '']),
      }
    }
  }
}

function csvCell(v: Cell): string {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function reportCsv(table: ReportTable): string {
  return [table.columns, ...table.rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
}

/** `ar-aging-by-customer-2026-11-14.csv` */
export function reportFileName(kind: AccountingReportKind, f: ReportFilters): string {
  const slug = reportDef(kind).title.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const range = reportDef(kind).dateBasis && (f.from || f.to) ? `${f.from || 'start'}-to-${f.to || f.asOf}` : f.asOf
  return `${slug}-${range}.csv`
}
