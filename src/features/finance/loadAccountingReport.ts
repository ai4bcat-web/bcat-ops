/**
 * The reads behind one accounting report: only what the chosen report needs, over the months
 * its date range spans. Payments (AR and AP) are one paginated list each; the tables are small.
 */
import {
  listApPayments, listArPayments, listBillsByMonth, listFinanceReviewShipments, listInvoicesByMonth, listOpenBills, listOpenInvoices,
} from '@/lib/apiClient'
import { loadSamples } from '@/lib/reportsClient'
import { monthsBetween } from '@/lib/reporting'
import { cachedList } from '@/lib/listCache'
import { isAljexBill } from '@/features/ap/apQueue'
import type { CarrierBillRecord, InvoiceRecord } from '@/types/tms'
import type { AccountingReportKind, ReportData, ReportFilters } from './accountingReports'
import { billingMismatches, type BillingMismatches } from './accountingStats'

/** `'YYYY-MM-DD'` moved by whole months (day clamped to 01 — only the month matters here). */
function monthShift(day: string, by: number): string {
  const y = Number(day.slice(0, 4))
  const i = y * 12 + Number(day.slice(5, 7)) - 1 + by
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`
}

/**
 * The months to read for a range. An open start reads `back` months before the end; payments and
 * paid bills also reach `lead` months before the start, since a bill dated earlier can be paid inside it.
 */
function windowMonths(f: ReportFilters, back: number, lead = 0): string[] {
  const to = f.to || f.asOf
  const from = f.from ? monthShift(f.from, -lead) : monthShift(to, -back)
  return monthsBetween(from, to)
}

async function invoicesIn(months: string[]): Promise<InvoiceRecord[]> {
  const sets = await Promise.all(months.map((m) => listInvoicesByMonth(m).catch(() => [] as InvoiceRecord[])))
  return sets.flat()
}

async function billsIn(months: string[]): Promise<CarrierBillRecord[]> {
  const sets = await Promise.all(months.map((m) => listBillsByMonth(m).catch(() => [] as CarrierBillRecord[])))
  return sets.flat()
}

const MISMATCH_PAID_DAYS = 90

/**
 * The profit check's two mismatch lists, read once per five minutes for both pages: open
 * invoices and a year of invoices (to find each bill's invoice), open bills, and the bills
 * paid in the last 90 days (older Aljex-era payments have no invoice here and are left out).
 */
export function loadBillingMismatches(asOf: string): Promise<BillingMismatches> {
  return cachedList(`acct:mismatches:${asOf}`, async () => {
    const [openInvoices, invoices, openBills, recentBills] = await Promise.all([
      listOpenInvoices(), invoicesIn(monthsBetween(monthShift(asOf, -12), asOf)), listOpenBills(), billsIn(monthsBetween(monthShift(asOf, -6), asOf)),
    ])
    const cutoff = new Date(Date.parse(`${asOf}T00:00:00Z`) - MISMATCH_PAID_DAYS * 86_400_000).toISOString().slice(0, 10)
    const paidBills = recentBills.filter((b) => b.status === 'PAID' && (b.paidAt ?? '').slice(0, 10) >= cutoff && !isAljexBill(b))
    return billingMismatches({ openInvoices, invoices, openBills: openBills.filter((b) => !isAljexBill(b)), paidBills })
  }, { ttlMs: 300_000 })
}

export async function loadAccountingReport(kind: AccountingReportKind, f: ReportFilters): Promise<ReportData> {
  switch (kind) {
    case 'arAgingSummary':
    case 'arAgingDetail':
    case 'arOpen':
      return { openInvoices: await listOpenInvoices() }
    case 'arPayments': {
      // Every payment in the range, all customers (one list read). Invoices only name what each
      // payment was applied to; one a year or more older shows its id instead of its number.
      const [payments, openInvoices, invoices] = await Promise.all([listArPayments(), listOpenInvoices(), invoicesIn(windowMonths(f, 3, 12))])
      return { openInvoices, invoices, payments }
    }
    case 'arDaysToPay': {
      const [invoices, payments] = await Promise.all([invoicesIn(windowMonths(f, 12)), listArPayments()])
      return { invoices, payments }
    }
    case 'apAging':
    case 'apOpen':
      return { openBills: await listOpenBills() }
    case 'apExpected': {
      const [openBills, review] = await Promise.all([listOpenBills(), listFinanceReviewShipments().catch(() => [])])
      return { openBills, review }
    }
    case 'apPaid': {
      const [bills, apPayments] = await Promise.all([billsIn(windowMonths(f, 3, 3)), listApPayments()])
      return { bills, apPayments }
    }
    case 'custPaidCarrierUnpaid':
    case 'carrierPaidNotBilled':
      return { mismatches: await loadBillingMismatches(f.asOf) }
    case 'marginByLoad': {
      const to = f.to || f.asOf
      const read = await loadSamples(f.from || monthShift(to, -2), to)
      return { samples: read.rows }
    }
    case 'needsReview':
      return { review: await listFinanceReviewShipments() }
  }
}
