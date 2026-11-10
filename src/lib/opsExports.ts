/**
 * The four "pull everything" CSVs: active shipments, shipments in Load Review, outstanding payables and outstanding receivables.
 * Every stored field of every record (nested values become dotted columns), not the columns on screen and not the page's filters.
 * Open to anyone who can open the page the button sits on, so none of these checks the role.
 */
import { listCustomers, listOpenBills, listOpenInvoices } from '@/lib/apiClient'
import { downloadCsv, recordsToFullCsv } from '@/lib/directoryCsv'
import { LOAD_REVIEW_CHECKS, LOAD_REVIEW_CHECK_LABEL, failingReasons, type LoadReviewVerdict } from '@/lib/loadReview'

const today = () => new Date().toISOString().slice(0, 10)

/** Save `records` as `<name>-<date>.csv`; returns how many rows went out. */
export function exportRecords(name: string, records: readonly object[]): number {
  downloadCsv(`${name}-${today()}.csv`, recordsToFullCsv(records))
  return records.length
}

/** One Load Review row with its checks spelled out: a Pass/Fix column per check, the failing reasons, and the overall verdict. */
export function reviewExportRow(row: object, verdict: LoadReviewVerdict | undefined): object {
  if (!verdict) return row
  const checks: Record<string, string> = {}
  for (const key of LOAD_REVIEW_CHECKS) checks[`check: ${LOAD_REVIEW_CHECK_LABEL[key]}`] = verdict.checks[key].ok ? 'Pass' : 'Fix'
  return { ...row, reviewVerdict: verdict.ok ? 'Looks ready' : 'Needs fixes', reviewReasons: failingReasons(verdict).map((r) => r.message).join('; '), ...checks }
}

/** Every open invoice (money still owed to us) with the customer's name beside its id. */
export async function exportOutstandingReceivables(): Promise<number> {
  const [invoices, customers] = await Promise.all([listOpenInvoices(), listCustomers({ includeArchived: true })])
  const names = new Map(customers.map((c) => [c.id, c.name]))
  return exportRecords('outstanding-receivables', invoices.map((inv) => ({ ...inv, customerName: names.get(inv.customerId ?? '') ?? '' })))
}

/** Every open carrier bill (money we still owe). */
export async function exportOutstandingPayables(): Promise<number> {
  return exportRecords('outstanding-payables', await listOpenBills())
}
