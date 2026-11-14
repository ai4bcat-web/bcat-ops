/**
 * The reads behind one accounting report: only what the chosen report needs, over the months
 * its date range spans. Payments are read per customer (the index is by customer), four at a time.
 */
import {
  listArPaymentsByCustomer, listBillsByMonth, listFinanceReviewShipments, listInvoicesByMonth, listOpenBills, listOpenInvoices,
} from '@/lib/apiClient'
import { loadSamples } from '@/lib/reportsClient'
import { monthsBetween } from '@/lib/reporting'
import type { ArPaymentRecord, CarrierBillRecord, InvoiceRecord } from '@/types/tms'
import type { AccountingReportKind, ReportData, ReportFilters } from './accountingReports'

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

async function paymentsFor(customerIds: string[]): Promise<ArPaymentRecord[]> {
  const ids = [...new Set(customerIds.filter(Boolean))]
  const out: ArPaymentRecord[] = []
  let next = 0
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]
      try { out.push(...await listArPaymentsByCustomer(id)) } catch { /* a customer that fails to read is left out */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
  return out
}

export async function loadAccountingReport(kind: AccountingReportKind, f: ReportFilters): Promise<ReportData> {
  switch (kind) {
    case 'arAgingSummary':
    case 'arAgingDetail':
    case 'arOpen':
      return { openInvoices: await listOpenInvoices() }
    case 'arPayments': {
      const [openInvoices, invoices] = await Promise.all([listOpenInvoices(), invoicesIn(windowMonths(f, 3, 6))])
      const payments = await paymentsFor([...openInvoices, ...invoices].map((inv) => inv.customerId))
      return { openInvoices, invoices, payments }
    }
    case 'arDaysToPay': {
      const invoices = await invoicesIn(windowMonths(f, 12))
      return { invoices, payments: await paymentsFor(invoices.filter((inv) => inv.status === 'PAID').map((inv) => inv.customerId)) }
    }
    case 'apAging':
    case 'apOpen':
      return { openBills: await listOpenBills() }
    case 'apExpected': {
      const [openBills, review] = await Promise.all([listOpenBills(), listFinanceReviewShipments().catch(() => [])])
      return { openBills, review }
    }
    case 'apPaid':
      return { bills: await billsIn(windowMonths(f, 3, 3)) }
    case 'marginByLoad': {
      const to = f.to || f.asOf
      const read = await loadSamples(f.from || monthShift(to, -2), to)
      return { samples: read.rows }
    }
    case 'needsReview':
      return { review: await listFinanceReviewShipments() }
  }
}
