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
import { isAutoShipperName } from '@/lib/reviewRequirements'
import { OVERPAY_REASON, SHORT_PAY_REASON, differenceReason, isShortPayNote } from '@/lib/paymentDifference'
import type { ArPaymentMethod, InvoiceRecord, PaymentApplication } from '@/types/tms'

export type OutstandingSectionKey = 'manual' | 'factored'

export const DEFAULT_FACTOR_FEE_BPS = 200

export { SHORT_PAY_REASON, OVERPAY_REASON, isShortPayNote, differenceReason }

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
  /** Billed through Square (an auto shipper): Square cannot be told about a payment recorded here. */
  viaSquare?: boolean
}

/** One open invoice as a table row: the grouping is gone, so each row carries what a group header used to say. */
export interface OutstandingTableRow extends OutstandingRow {
  customerName: string
  /** The invoice's own division key (BCAT_LOGISTICS, …); '' when none. */
  divisionKey: string
  termsText: string
  /** YYYY-MM-DD the invoice went out ('' while unsent). */
  sentOn: string
  /** Days past the due date (0 when not yet late). */
  daysLate: number
  type: OutstandingSectionKey
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

/** An AUTO SHIPPER invoice is never factored (Ryne 2026-11-27), whatever an old import left on its flag. */
export const isFactoredInvoice = (inv: Pick<InvoiceRecord, 'factored' | 'factoringItemId'> & { customerName?: string | null }): boolean =>
  !isAutoShipperName(inv.customerName) && Boolean(inv.factored || inv.factoringItemId)

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
    ...(inv.external?.provider === 'SQUARE' ? { viaSquare: true } : {}),
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

/** Days past due, 0 when the invoice isn't late yet. */
export function daysLate(dueYmd: string | null | undefined, asOf: string): number {
  const due = ymd(dueYmd)
  if (!due) return 0
  return daysBetween(due, ymd(asOf) ?? asOf)
}

/** The status buckets the Status column filters by. */
export const LATE_BUCKETS = ['Current', '1–30 days late', '31–60 days late', '61–90 days late', '90+ days late'] as const
export function lateBucket(daysLateCount: number): (typeof LATE_BUCKETS)[number] {
  if (daysLateCount <= 0) return 'Current'
  if (daysLateCount <= 30) return '1–30 days late'
  if (daysLateCount <= 60) return '31–60 days late'
  if (daysLateCount <= 90) return '61–90 days late'
  return '90+ days late'
}

/** Every open invoice as one flat row (Ryne 2026-11-16: a table like Active shipments, not blocks by customer). */
export function tableRows(
  invoices: readonly InvoiceRecord[],
  nameOf: (customerId: string, fallback: string) => string,
  asOf: string,
): OutstandingTableRow[] {
  const out: OutstandingTableRow[] = []
  for (const inv of invoices) {
    if (inv.status !== 'ISSUED' && inv.status !== 'PARTIAL') continue
    if ((inv.balanceCents ?? 0) <= 0) continue
    const row = outstandingRow(inv, asOf)
    out.push({
      ...row,
      customerName: nameOf(inv.customerId, inv.customerName || inv.customerId),
      divisionKey: inv.divisionKey ?? '',
      termsText: inv.termsText?.trim() || (inv.termsDays ? `Net ${inv.termsDays}` : ''),
      sentOn: ymd(inv.sentAt) ?? ymd(inv.markedSentAt) ?? '',
      daysLate: daysLate(inv.dueAt, asOf),
      type: row.factored ? 'factored' : 'manual',
    })
  }
  return out.sort((a, b) => a.customerName.localeCompare(b.customerName) || a.dueAt.localeCompare(b.dueAt) || a.number.localeCompare(b.number, undefined, { numeric: true }))
}

/** The flat rows narrowed to one customer, a type chip and/or a typed search over invoice #, PRO and PO. */
export function filterTableRows(
  rows: readonly OutstandingTableRow[],
  filter: { customerId?: string | null; query?: string | null; type?: OutstandingSectionKey | null },
): OutstandingTableRow[] {
  const q = (filter.query ?? '').trim().toLowerCase()
  return rows.filter((r) =>
    (!filter.customerId || r.customerId === filter.customerId)
    && (!filter.type || r.type === filter.type)
    && (!q || [r.number, r.pro, r.po ?? '', r.invoiceId].some((v) => v.toLowerCase().includes(q))))
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
  /** Accept the payment as paid in full: a short pay is closed and an overpay is accepted, leaving no open balance or credit. */
  accept?: boolean
}

export interface ReceiveDraft {
  lines: ReceiveLine[]
  reference: string
  /** YYYY-MM-DD. */
  receivedAt: string
  method: ArPaymentMethod
  /** OTR's fee in basis points, for factored lines. */
  feeBps: number
  /** A difference this size or smaller (cents) is accepted without ticking "paid in full". 0/absent = never. */
  autoAcceptCents?: number
  /** Accept every amount as entered (default true): a short pay is closed and an overpay accepted, never an error. False restores ticking each line. */
  acceptAsEntered?: boolean
  /** The person's own words on the adjustment, after the standard reason. */
  note?: string
}

export interface PlannedLine {
  invoiceId: string
  pro: string
  customerId: string
  factored: boolean
  balanceCents: number
  /** Money received against the invoice. */
  paidCents: number
  /** The part of it applied to the invoice (never more than the balance). */
  appliedCents: number
  /** OTR's fee closed on the invoice after the payment posts (0 on a manual invoice). */
  feeCents: number
  /** What stays open afterwards (a short pay beyond the fee). Always 0 when the difference was accepted. */
  leftCents: number
  /** Short pay closed as an adjustment because it was accepted as paid in full. */
  shortCents: number
  /** Overpay accepted as paid in full: recorded on the payment, never kept as credit. */
  overCents: number
  /** The difference was accepted (ticked, or small enough to auto-accept). */
  accepted: boolean
  /** Accepted by the "auto-accept differences under $X" setting rather than ticked. */
  auto: boolean
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
  /** Σ short pays accepted as paid in full. */
  shortCents: number
  /** Σ overpays accepted as paid in full. */
  overCents: number
  /** One RECORD_PAYMENT per customer. */
  payments: Array<{ customerId: string; amountCents: number; applications: PaymentApplication[]; overCents: number }>
}

/**
 * Checks the ticked lines and builds what they become: one payment per customer, and on each factored
 * invoice OTR's fee — never more than the fee, never more than what is left after the payment.
 */
export function planReceive(d: ReceiveDraft): ReceivePlan {
  const errors: string[] = []
  const lines: PlannedLine[] = []
  const auto = Math.max(0, Math.round(d.autoAcceptCents ?? 0))
  for (const { row, amount, accept } of d.lines) {
    const cents = parseDollars(amount)
    if (cents == null || cents <= 0) { errors.push(`Enter the amount paid on ${row.pro}.`); continue }
    const over = Math.max(0, cents - row.balanceCents)
    const applied = Math.min(cents, row.balanceCents)
    const fee = row.factored ? Math.min(factorFeeCents(row.balanceCents, d.feeBps), row.balanceCents - applied) : 0
    const short = row.balanceCents - applied - fee
    const gap = Math.max(short, over)
    const asEntered = d.acceptAsEntered !== false
    const autoAccepted = !accept && !asEntered && gap > 0 && auto > 0 && gap <= auto
    const accepted = Boolean(accept) || asEntered || autoAccepted
    if (over > 0 && !accepted) {
      errors.push(`${row.pro}: $${(cents / 100).toFixed(2)} is more than the $${(row.balanceCents / 100).toFixed(2)} balance. Tick "Paid in full" to accept the extra.`)
      continue
    }
    lines.push({
      invoiceId: row.invoiceId, pro: row.pro, customerId: row.customerId, factored: row.factored, balanceCents: row.balanceCents,
      paidCents: cents, appliedCents: applied, feeCents: fee,
      leftCents: accepted ? 0 : short,
      shortCents: accepted ? short : 0,
      overCents: accepted ? over : 0,
      accepted: accepted && gap > 0,
      auto: autoAccepted || (asEntered && !accept && gap > 0),
    })
  }
  if (d.lines.length === 0) errors.push('Tick at least one invoice.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.receivedAt)) errors.push('Enter the payment date.')
  if (d.method === 'CHECK' && !d.reference.trim()) errors.push('Enter the check number.')
  const byCustomer = new Map<string, { applications: PaymentApplication[]; paid: number; over: number }>()
  for (const l of lines) {
    const g = byCustomer.get(l.customerId) ?? { applications: [], paid: 0, over: 0 }
    g.applications.push({ invoiceId: l.invoiceId, amountCents: l.appliedCents })
    g.paid += l.paidCents
    g.over += l.overCents
    byCustomer.set(l.customerId, g)
  }
  // The payment's amount is the money received, overpay included; its applications are what the invoices took.
  const payments = [...byCustomer].map(([customerId, g]) => ({ customerId, applications: g.applications, amountCents: g.paid, overCents: g.over }))
  return {
    ok: errors.length === 0 && lines.length > 0,
    errors,
    lines,
    receivedCents: lines.reduce((s, l) => s + l.paidCents, 0),
    feeCents: lines.reduce((s, l) => s + l.feeCents, 0),
    invoiceCents: lines.reduce((s, l) => s + l.balanceCents, 0),
    shortCents: lines.reduce((s, l) => s + l.shortCents, 0),
    overCents: lines.reduce((s, l) => s + l.overCents, 0),
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
    // An overpay accepted as paid in full is recorded on the payment, never kept as customer credit.
    ...(payment.overCents > 0 ? { acceptOverage: true, overageReason: differenceReason(OVERPAY_REASON, d.note) } : {}),
  }
}
