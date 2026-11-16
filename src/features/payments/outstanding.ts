/**
 * Payments Received → Outstanding (Ryne 2026-11-16): every open customer invoice, grouped by
 * customer, ticked and received in bulk.
 *
 * - The set is Open AR's own: every sent invoice still ISSUED or PARTIAL (`listOpenInvoices`).
 * - Two sections, each grouped by customer (Ryne 2026-11-16): Manually invoiced (the customer pays us)
 *   and Factored (OTR pays us). Both are receivable.
 * - Receiving builds ONE RECORD_PAYMENT per customer: the ticked invoices are its applications, the
 *   check # / OTR reference its reference, the payment date its receivedAt.
 * - A factored invoice is paid less OTR's fee (default 2%, `TmsSettings.factorFeeBps`). Amount paid is
 *   pre-filled at balance less the fee, and the fee is closed on the invoice as a write-off reasoned
 *   "Factoring fee (OTR n%)", so the invoice ends PAID. Only the fee is closed: a short pay beyond it stays open.
 *
 * Pure: the page loads the invoices and posts the payment; this groups, totals and validates.
 */
import { customerRefOf } from '@/lib/customerRef'
import type { ArPaymentMethod, InvoiceRecord, PaymentApplication } from '@/types/tms'

export type OutstandingSectionKey = 'manual' | 'factored'

export const DEFAULT_FACTOR_FEE_BPS = 200

/** The write-off reason that marks OTR's fee, so reports can find it. */
export const factorFeeReason = (bps: number) => `Factoring fee (OTR ${bps / 100}%)`

/** OTR's fee on a balance, to the cent. */
export const factorFeeCents = (balanceCents: number, bps: number) => Math.round((balanceCents * bps) / 10_000)

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
  /** `<section>:<customerId>`. */
  key: string
  customerId: string
  label: string
  factored: boolean
  rows: OutstandingRow[]
  openCents: number
}

export interface OutstandingSection {
  key: OutstandingSectionKey
  label: string
  groups: OutstandingGroup[]
  count: number
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

/** Open invoices in two sections — Manually invoiced, Factored (OTR) — each grouped by customer A→Z, oldest invoice first. */
export function groupOutstanding(
  invoices: readonly InvoiceRecord[],
  nameOf: (customerId: string, fallback: string) => string,
  asOf: string,
): OutstandingSection[] {
  const groups = new Map<string, OutstandingGroup>()
  for (const inv of invoices) {
    if (inv.status !== 'ISSUED' && inv.status !== 'PARTIAL') continue
    if ((inv.balanceCents ?? 0) <= 0) continue
    const row = outstandingRow(inv, asOf)
    const key = `${row.factored ? 'factored' : 'manual'}:${inv.customerId}`
    let g = groups.get(key)
    if (!g) {
      g = { key, customerId: inv.customerId, label: nameOf(inv.customerId, inv.customerName || inv.customerId), factored: row.factored, rows: [], openCents: 0 }
      groups.set(key, g)
    }
    g.rows.push(row)
    g.openCents += row.balanceCents
  }
  const byDate = (a: OutstandingRow, b: OutstandingRow) => a.invoiceDate.localeCompare(b.invoiceDate) || a.number.localeCompare(b.number)
  for (const g of groups.values()) g.rows.sort(byDate)
  const section = (key: OutstandingSectionKey, label: string): OutstandingSection => {
    const list = [...groups.values()].filter((g) => g.factored === (key === 'factored')).sort((a, b) => a.label.localeCompare(b.label))
    return { key, label, groups: list, count: list.reduce((n, g) => n + g.rows.length, 0), openCents: list.reduce((n, g) => n + g.openCents, 0) }
  }
  return [section('manual', 'Manually invoiced'), section('factored', 'Factored (OTR)')].filter((s) => s.count > 0)
}

/** Open invoices narrowed to one customer and/or a typed search over invoice #, PRO and PO; empty groups and sections drop out. */
export function filterOutstanding(
  sections: readonly OutstandingSection[],
  filter: { customerId?: string | null; query?: string | null },
): OutstandingSection[] {
  const q = (filter.query ?? '').trim().toLowerCase()
  if (!filter.customerId && !q) return [...sections]
  const hit = (r: OutstandingRow) => !q || [r.number, r.pro, r.po ?? '', r.invoiceId].some((v) => v.toLowerCase().includes(q))
  return sections.flatMap((s) => {
    const groups = s.groups
      .filter((g) => !filter.customerId || g.customerId === filter.customerId)
      .map((g) => {
        const rows = g.rows.filter(hit)
        return { ...g, rows, openCents: rows.reduce((n, r) => n + r.balanceCents, 0) }
      })
      .filter((g) => g.rows.length > 0)
    if (groups.length === 0) return []
    return [{ ...s, groups, count: groups.reduce((n, g) => n + g.rows.length, 0), openCents: groups.reduce((n, g) => n + g.openCents, 0) }]
  })
}

/**
 * Spends a received amount on invoices oldest first: each row is filled to what its Amount paid would start at
 * (balance, less OTR's fee on a factored one) until the money runs out; the last row takes what is left. Rows after that
 * are left unticked. Returns the amount per invoice, in cents.
 */
export function allocateOldestFirst(rows: readonly OutstandingRow[], receivedCents: number, feeBps: number): Map<string, number> {
  const out = new Map<string, number>()
  let left = Math.max(0, Math.round(receivedCents))
  const oldest = [...rows].sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.number.localeCompare(b.number))
  for (const r of oldest) {
    if (left <= 0) break
    const take = Math.min(left, prefillCents(r, feeBps))
    if (take <= 0) continue
    out.set(r.invoiceId, take)
    left -= take
  }
  return out
}

/** What Amount paid starts at when an invoice is ticked: the balance, less OTR's fee on a factored one. */
export function prefillCents(row: OutstandingRow, feeBps: number): number {
  return row.factored ? row.balanceCents - factorFeeCents(row.balanceCents, feeBps) : row.balanceCents
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
  lines: ReceiveLine[]
  reference: string
  /** YYYY-MM-DD. */
  receivedAt: string
  method: ArPaymentMethod
  /** OTR's fee in basis points, for factored lines. */
  feeBps: number
}

export interface PlannedLine {
  invoiceId: string
  pro: string
  customerId: string
  factored: boolean
  balanceCents: number
  /** Money received against the invoice. */
  paidCents: number
  /** OTR's fee closed on the invoice after the payment posts (0 on a manual invoice). */
  feeCents: number
  /** What stays open afterwards (a short pay beyond the fee). */
  leftCents: number
}

export interface ReceivePlan {
  ok: boolean
  /** One plain sentence per problem, shown under the bar. */
  errors: string[]
  lines: PlannedLine[]
  receivedCents: number
  feeCents: number
  /** Σ invoice balances covered. */
  invoiceCents: number
  /** One RECORD_PAYMENT per customer. */
  payments: Array<{ customerId: string; amountCents: number; applications: PaymentApplication[] }>
}

/**
 * Checks the ticked lines and builds what they become: one payment per customer, and on each factored
 * invoice OTR's fee — never more than the fee, never more than what is left after the payment.
 */
export function planReceive(d: ReceiveDraft): ReceivePlan {
  const errors: string[] = []
  const lines: PlannedLine[] = []
  for (const { row, amount } of d.lines) {
    const cents = parseDollars(amount)
    if (cents == null || cents <= 0) { errors.push(`Enter the amount paid on ${row.pro}.`); continue }
    if (cents > row.balanceCents) {
      errors.push(`${row.pro}: $${(cents / 100).toFixed(2)} is more than the $${(row.balanceCents / 100).toFixed(2)} balance.`)
      continue
    }
    const fee = row.factored ? Math.min(factorFeeCents(row.balanceCents, d.feeBps), row.balanceCents - cents) : 0
    lines.push({
      invoiceId: row.invoiceId, pro: row.pro, customerId: row.customerId, factored: row.factored, balanceCents: row.balanceCents,
      paidCents: cents, feeCents: fee, leftCents: row.balanceCents - cents - fee,
    })
  }
  if (d.lines.length === 0) errors.push('Tick at least one invoice.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.receivedAt)) errors.push('Enter the payment date.')
  if (d.method === 'CHECK' && !d.reference.trim()) errors.push('Enter the check number.')
  const byCustomer = new Map<string, PaymentApplication[]>()
  for (const l of lines) byCustomer.set(l.customerId, [...(byCustomer.get(l.customerId) ?? []), { invoiceId: l.invoiceId, amountCents: l.paidCents }])
  const payments = [...byCustomer].map(([customerId, applications]) => ({
    customerId, applications, amountCents: applications.reduce((s, a) => s + a.amountCents, 0),
  }))
  return {
    ok: errors.length === 0 && lines.length > 0,
    errors,
    lines,
    receivedCents: lines.reduce((s, l) => s + l.paidCents, 0),
    feeCents: lines.reduce((s, l) => s + l.feeCents, 0),
    invoiceCents: lines.reduce((s, l) => s + l.balanceCents, 0),
    payments,
  }
}

/** The RECORD_PAYMENT input for one customer's payment in a clean plan. */
export function recordPaymentInput(d: ReceiveDraft, payment: ReceivePlan['payments'][number], clientRequestId: string) {
  return {
    customerId: payment.customerId,
    receivedAt: d.receivedAt,
    method: d.method,
    reference: d.reference.trim() || undefined,
    amountCents: payment.amountCents,
    applications: payment.applications,
    creditApplications: [],
    clientRequestId,
  }
}
