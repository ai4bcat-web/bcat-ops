/**
 * Payments received → Outstanding (Ryne 2026-11-16): every open customer invoice, grouped by
 * customer, ticked and received in bulk.
 *
 * - The set is Open AR's own: every sent invoice still ISSUED or PARTIAL (`listOpenInvoices`).
 * - Factored invoices are OTR's to collect, so they sit in one separate "Factored (OTR)" group with no
 *   tick boxes: a customer's check is never put against an invoice OTR already bought.
 * - Receiving builds ONE RECORD_PAYMENT per customer: the ticked invoices are its applications, the
 *   check # its reference, the payment date its receivedAt.
 *
 * Pure: the page loads the invoices and posts the payment; this groups, totals and validates.
 */
import { customerRefOf } from '@/lib/customerRef'
import type { ArPaymentMethod, InvoiceRecord, PaymentApplication } from '@/types/tms'

export const FACTORED_GROUP = '__factored_otr__'

export interface OutstandingRow {
  invoiceId: string
  number: string
  pro: string
  shipmentId: string
  customerId: string
  po: string | null
  invoiceDate: string
  dueAt: string
  daysOutstanding: number
  totalCents: number
  paidCents: number
  balanceCents: number
  factored: boolean
}

export interface OutstandingGroup {
  /** The customer id, or FACTORED_GROUP for the OTR group. */
  key: string
  label: string
  /** Factored invoices can't be received here. */
  receivable: boolean
  rows: OutstandingRow[]
  openCents: number
}

const DAY_MS = 86_400_000
const ymd = (iso: string | null | undefined) => /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')?.[1] ?? null

export function daysBetween(fromYmd: string | null, toYmd: string): number {
  if (!fromYmd) return 0
  return Math.max(0, Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / DAY_MS))
}

export const isFactoredInvoice = (inv: Pick<InvoiceRecord, 'factored' | 'factoringItemId'>): boolean =>
  Boolean(inv.factored || inv.factoringItemId)

export function outstandingRow(inv: InvoiceRecord, asOf: string): OutstandingRow {
  return {
    invoiceId: inv.id,
    number: inv.number || inv.id,
    pro: inv.shipmentNumber || inv.number || inv.id,
    shipmentId: inv.shipmentId,
    customerId: inv.customerId,
    po: customerRefOf(inv.references) ?? null,
    invoiceDate: ymd(inv.invoiceDate) ?? '',
    dueAt: ymd(inv.dueAt) ?? '',
    daysOutstanding: daysBetween(ymd(inv.invoiceDate), ymd(asOf) ?? asOf),
    totalCents: inv.totalCents ?? 0,
    paidCents: inv.paidCents ?? 0,
    balanceCents: inv.balanceCents ?? 0,
    factored: isFactoredInvoice(inv),
  }
}

/** Open invoices grouped by customer (A→Z), oldest invoice first, with the factored ones in their own group last. */
export function groupOutstanding(
  invoices: readonly InvoiceRecord[],
  nameOf: (customerId: string, fallback: string) => string,
  asOf: string,
): OutstandingGroup[] {
  const byCustomer = new Map<string, OutstandingGroup>()
  const factored: OutstandingGroup = { key: FACTORED_GROUP, label: 'Factored (OTR)', receivable: false, rows: [], openCents: 0 }
  for (const inv of invoices) {
    if (inv.status !== 'ISSUED' && inv.status !== 'PARTIAL') continue
    if ((inv.balanceCents ?? 0) <= 0) continue
    const row = outstandingRow(inv, asOf)
    const group = row.factored
      ? factored
      : byCustomer.get(inv.customerId) ?? (() => {
        const g: OutstandingGroup = {
          key: inv.customerId, label: nameOf(inv.customerId, inv.customerName || inv.customerId), receivable: true, rows: [], openCents: 0,
        }
        byCustomer.set(inv.customerId, g)
        return g
      })()
    group.rows.push(row)
    group.openCents += row.balanceCents
  }
  const byDate = (a: OutstandingRow, b: OutstandingRow) => a.invoiceDate.localeCompare(b.invoiceDate) || a.number.localeCompare(b.number)
  const groups = [...byCustomer.values()].sort((a, b) => a.label.localeCompare(b.label))
  for (const g of groups) g.rows.sort(byDate)
  factored.rows.sort(byDate)
  return factored.rows.length > 0 ? [...groups, factored] : groups
}

/** Typed dollars → cents; null when it isn't a number. */
export function parseDollars(text: string): number | null {
  const t = text.replace(/[$,\s]/g, '')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export interface ReceiveLine {
  row: OutstandingRow
  /** What was typed in Amount paid. */
  amount: string
}

export interface ReceiveDraft {
  customerId: string
  lines: ReceiveLine[]
  reference: string
  /** YYYY-MM-DD. */
  receivedAt: string
  method: ArPaymentMethod
}

export interface ReceivePlan {
  ok: boolean
  /** One plain sentence per problem, shown under the bar. */
  errors: string[]
  amountCents: number
  applications: PaymentApplication[]
}

/** Checks the ticked lines and builds the one payment they become. */
export function planReceive(d: ReceiveDraft): ReceivePlan {
  const errors: string[] = []
  const applications: PaymentApplication[] = []
  for (const { row, amount } of d.lines) {
    const cents = parseDollars(amount)
    if (cents == null || cents <= 0) { errors.push(`Enter the amount paid on ${row.pro}.`); continue }
    if (cents > row.balanceCents) {
      errors.push(`${row.pro}: $${(cents / 100).toFixed(2)} is more than the $${(row.balanceCents / 100).toFixed(2)} balance.`)
      continue
    }
    if (row.factored) { errors.push(`${row.pro} is factored; OTR collects it.`); continue }
    applications.push({ invoiceId: row.invoiceId, amountCents: cents })
  }
  if (d.lines.length === 0) errors.push('Tick at least one invoice.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.receivedAt)) errors.push('Enter the payment date.')
  if (d.method === 'CHECK' && !d.reference.trim()) errors.push('Enter the check number.')
  const amountCents = applications.reduce((s, a) => s + a.amountCents, 0)
  return { ok: errors.length === 0 && applications.length > 0, errors, amountCents, applications }
}

/** The RECORD_PAYMENT input for a clean plan. */
export function recordPaymentInput(d: ReceiveDraft, plan: ReceivePlan, clientRequestId: string) {
  return {
    customerId: d.customerId,
    receivedAt: d.receivedAt,
    method: d.method,
    reference: d.reference.trim() || undefined,
    amountCents: plan.amountCents,
    applications: plan.applications,
    creditApplications: [],
    clientRequestId,
  }
}
