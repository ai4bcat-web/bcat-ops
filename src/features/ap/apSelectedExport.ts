/**
 * The Selected tab as a pay run sheet (Ryne 2026-11-18: "export everything in the selected tab so we can
 * see everything that needs to be paid"). One CSV: every selected bill, then a totals block per payee and a
 * grand total, with the payees that cannot be paid yet (no remit e-mail, no payment method) flagged.
 *
 * Internal to the AP desk. It carries only what the Selected tab already shows: no bank or account numbers,
 * only the method's name. It is never sent anywhere; the browser saves it.
 */
import type { CarrierBillRecord } from '@/types/tms'
import type { CarrierPaymentInfo, FinanceReviewShipment } from '@/lib/apiClient'
import { chicagoDateStr } from '@/lib/date'
import { billCustomerName, billDaysPastDue, billLabel, proOf, termsLabel, type BillFactsIndex } from './apQueue'
import { AP_PAYMENT_METHOD_LABEL, PAY_TO_STATUS_LABEL, paymentInfoFor, payeeNameFor, payToStatusFor, factorNameFor, remitEmailOf } from './apViews'

export interface SelectedExportInput {
  bills: readonly CarrierBillRecord[]
  facts: BillFactsIndex
  infos: readonly CarrierPaymentInfo[]
  review: ReadonlyMap<string, Pick<FinanceReviewShipment, 'financeReviewReason' | 'financeReviewApNote'>>
  /** The Chicago day the days past due count from (YYYY-MM-DD). */
  asOf: string
  /** Bill ids ticked on the tab right now. */
  ticked: ReadonlySet<string>
}

export interface SelectedExportRow {
  payee: string
  carrier: string
  pro: string
  po: string
  customer: string
  delivered: string
  invoiceDate: string
  dueDate: string
  /** YYYY-MM-DD, for ordering only. */
  dueSort: string
  daysPastDue: number | null
  terms: string
  netCents: number
  paidCents: number
  balanceCents: number
  payMethod: string
  remitEmail: string
  factorName: string
  /** 'Pay-to set', or what is missing (see `payToStatusFor`). */
  payToStatus: string
  status: string
  needsReview: string
  quickPay: boolean
  ticked: boolean
  bill: string
}

export interface PayeeTotal {
  payee: string
  bills: number
  totalCents: number
  tickedBills: number
  tickedCents: number
  payMethod: string
  remitEmail: string
  flags: string
}

const STATUS_LABEL: Record<string, string> = {
  TO_BE_PAID: 'To be paid',
  PARTIAL: 'Partial',
  IN_REVIEW: 'In review',
  PAID: 'Paid',
  VOID: 'Void',
}

/** MM/DD/YYYY from a YYYY-MM-DD day or an ISO timestamp (a timestamp is read in Chicago time). */
export function exportDay(value: string | null | undefined): string {
  if (!value) return ''
  const day = value.includes('T') ? chicagoDateStr(value) : value.slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ''
}

const dollars = (cents: number) => (cents / 100).toFixed(2)

/** The payment method's name for a bill: the bill's own snapshot, else the carrier's method on file. Never a number. */
function methodOf(bill: CarrierBillRecord, infos: readonly CarrierPaymentInfo[]): string {
  const raw = (bill.remitTo?.method ?? paymentInfoFor(bill, infos)?.method ?? '').toString().trim()
  if (!raw) return ''
  return (AP_PAYMENT_METHOD_LABEL as Record<string, string>)[raw.toUpperCase()] ?? raw
}

export function selectedExportRows(input: SelectedExportInput): SelectedExportRow[] {
  const { facts, infos, review, asOf, ticked } = input
  const rows = input.bills.map((bill): SelectedExportRow => {
    const flag = review.get(bill.shipmentId)
    const payee = payeeNameFor(bill, infos)
    return {
      payee,
      carrier: bill.carrierName?.trim() || '',
      pro: proOf(bill, facts),
      po: facts.get(bill.shipmentId)?.po ?? '',
      customer: billCustomerName(bill, facts) ?? '',
      delivered: exportDay(facts.get(bill.shipmentId)?.deliveredAt ?? null),
      invoiceDate: exportDay(bill.billDate),
      dueDate: exportDay(bill.dueAt),
      dueSort: bill.dueAt?.slice(0, 10) ?? '',
      daysPastDue: billDaysPastDue(bill, asOf),
      terms: termsLabel(bill),
      netCents: bill.netCents,
      paidCents: bill.paidCents,
      balanceCents: bill.balanceCents,
      payMethod: methodOf(bill, infos),
      remitEmail: remitEmailOf(bill, infos),
      factorName: factorNameFor(bill, infos),
      payToStatus: PAY_TO_STATUS_LABEL[payToStatusFor(bill, infos)],
      status: STATUS_LABEL[bill.status] ?? bill.status,
      needsReview: flag ? [flag.financeReviewReason, flag.financeReviewApNote].map((t) => t?.trim()).filter(Boolean).join(' · ') || 'Needs review' : '',
      quickPay: bill.quickPay === true,
      ticked: ticked.has(bill.id),
      bill: billLabel(bill),
    }
  })
  return rows.sort((a, b) =>
    a.payee.localeCompare(b.payee, undefined, { sensitivity: 'base' })
    || a.dueSort.localeCompare(b.dueSort)
    || a.pro.localeCompare(b.pro, undefined, { numeric: true }))
}

/** One line per payee: what is owed this run, what is ticked, and what stops the payment. */
export function selectedPayeeTotals(rows: readonly SelectedExportRow[]): PayeeTotal[] {
  const byPayee = new Map<string, SelectedExportRow[]>()
  for (const row of rows) {
    const key = row.payee.toLowerCase()
    byPayee.set(key, [...(byPayee.get(key) ?? []), row])
  }
  const totals: PayeeTotal[] = []
  for (const group of byPayee.values()) {
    const methods = [...new Set(group.map((r) => r.payMethod).filter(Boolean))]
    const emails = [...new Set(group.map((r) => r.remitEmail).filter(Boolean))]
    const flags: string[] = []
    if (emails.length === 0) flags.push('No remit e-mail')
    if (methods.length === 0) flags.push('No payment method')
    if (group.some((r) => r.payToStatus !== PAY_TO_STATUS_LABEL.OK)) flags.push('Pay-to needed')
    totals.push({
      payee: group[0].payee,
      bills: group.length,
      totalCents: group.reduce((s, r) => s + r.balanceCents, 0),
      tickedBills: group.filter((r) => r.ticked).length,
      tickedCents: group.filter((r) => r.ticked).reduce((s, r) => s + r.balanceCents, 0),
      payMethod: methods.length > 1 ? 'Mixed' : methods[0] ?? '',
      remitEmail: emails.join('; '),
      flags: flags.join(' · '),
    })
  }
  return totals.sort((a, b) => a.payee.localeCompare(b.payee, undefined, { sensitivity: 'base' }))
}

function cell(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const line = (cells: readonly (string | number | null | undefined)[]) => cells.map(cell).join(',')

export const SELECTED_EXPORT_HEADERS = [
  'Payee (remit to)', 'Carrier', 'PRO', 'PO #', 'Customer', 'Delivered', 'Invoice date', 'Due date',
  'Days past due (negative = not due yet)', 'Terms', 'Amount (net)', 'Paid so far', 'Balance to pay',
  'Pay method', 'Remit e-mail', 'Factor', 'Pay-to status', 'Bill status', 'Needs review', 'Quick pay', 'Ticked', 'Bill',
] as const

export const PAYEE_TOTAL_HEADERS = [
  'Payee (remit to)', 'Bills', 'Total to pay', 'Ticked bills', 'Ticked total', 'Pay method', 'Remit e-mail', 'Flags',
] as const

/** The whole sheet: the bills, a blank line, then the pay run totals per payee with a grand total. */
export function selectedPayablesCsv(input: SelectedExportInput): string {
  const rows = selectedExportRows(input)
  const totals = selectedPayeeTotals(rows)
  const out: string[] = [line(SELECTED_EXPORT_HEADERS)]
  for (const r of rows) {
    out.push(line([
      r.payee, r.carrier, r.pro, r.po, r.customer, r.delivered, r.invoiceDate, r.dueDate,
      r.daysPastDue == null ? '' : r.daysPastDue, r.terms,
      dollars(r.netCents), dollars(r.paidCents), dollars(r.balanceCents),
      r.payMethod, r.remitEmail, r.factorName, r.payToStatus, r.status, r.needsReview, r.quickPay ? 'Yes' : 'No', r.ticked ? 'Yes' : 'No', r.bill,
    ]))
  }
  out.push('', line(['PAY RUN TOTALS BY PAYEE']), line(PAYEE_TOTAL_HEADERS))
  for (const t of totals) {
    out.push(line([t.payee, t.bills, dollars(t.totalCents), t.tickedBills, dollars(t.tickedCents), t.payMethod, t.remitEmail, t.flags]))
  }
  out.push(line([
    'GRAND TOTAL', rows.length, dollars(totals.reduce((s, t) => s + t.totalCents, 0)),
    totals.reduce((s, t) => s + t.tickedBills, 0), dollars(totals.reduce((s, t) => s + t.tickedCents, 0)),
    '', '', totals.some((t) => t.flags) ? `${totals.filter((t) => t.flags).length} payee(s) cannot be paid yet` : '',
  ]))
  return out.join('\r\n')
}

export function selectedPayablesFilename(asOf: string): string {
  return `selected-payables-${asOf}.csv`
}
