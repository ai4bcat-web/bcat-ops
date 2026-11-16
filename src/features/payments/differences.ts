/**
 * Payments Received → Differences (Ryne 2026-11-16): every short pay and overpay in one list, so they can be
 * accepted as paid in full all at once.
 *
 * Four kinds, two of them still open:
 * - Short (open): a part-paid invoice that still has a balance. Accepting writes the balance off as
 *   "Short pay accepted as paid in full", so the invoice ends PAID.
 * - Over (open): a payment with money left over (`unappliedCents`). Accepting records it as an accepted overpay
 *   (`overageAcceptedCents`), never kept as customer credit.
 * - Accepted short / Accepted over: already accepted, shown for the record (nothing to do).
 *
 * Pure: the page loads invoices and ledger rows; this derives the rows, totals and the bulk request.
 */
import type { InvoiceRecord } from '@/types/tms'
import { isFactoredInvoice } from './outstanding'
import { isAcceptedDifference, type ReceivedRow } from './paymentsReceived'

export type DifferenceKind = 'short-open' | 'over-open' | 'short-accepted' | 'over-accepted'

export const DIFFERENCE_KIND_LABEL: Record<DifferenceKind, string> = {
  'short-open': 'Short pay (open)',
  'over-open': 'Overpay (open)',
  'short-accepted': 'Short pay (accepted)',
  'over-accepted': 'Overpay (accepted)',
}

export const isOpenKind = (k: DifferenceKind): boolean => k === 'short-open' || k === 'over-open'

export interface DifferenceRow {
  /** `short:<invoiceId>` / `over:<paymentId>` / `acc:<ledgerRowId>`. */
  id: string
  kind: DifferenceKind
  customerId: string | null
  customerName: string
  /** Invoice # / PRO(s) the difference is on. */
  invoiceRefs: string
  invoiceId: string | null
  paymentId: string | null
  /** YYYY-MM-DD of the payment (or the invoice for a short pay with no date). */
  date: string
  reference: string
  method: string
  factored: boolean
  /** What was owed / received, for context (0 when not known). */
  expectedCents: number
  receivedCents: number
  /** The difference, always positive. */
  differenceCents: number
  note: string
}

const ymd = (iso: string | null | undefined): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '')

/** Part-paid invoices that still owe money. */
export function openShortRows(
  invoices: readonly InvoiceRecord[],
  nameOf: (customerId: string, fallback: string) => string,
): DifferenceRow[] {
  const out: DifferenceRow[] = []
  for (const inv of invoices) {
    if (inv.status !== 'ISSUED' && inv.status !== 'PARTIAL') continue
    if ((inv.balanceCents ?? 0) <= 0 || (inv.paidCents ?? 0) <= 0) continue
    out.push({
      id: `short:${inv.id}`,
      kind: 'short-open',
      customerId: inv.customerId,
      customerName: nameOf(inv.customerId, inv.customerName || inv.customerId),
      invoiceRefs: inv.shipmentNumber || inv.number || inv.id,
      invoiceId: inv.id,
      paymentId: null,
      date: ymd(inv.invoiceDate),
      reference: '',
      method: '',
      factored: isFactoredInvoice(inv),
      expectedCents: inv.totalCents ?? 0,
      receivedCents: inv.paidCents ?? 0,
      differenceCents: inv.balanceCents ?? 0,
      note: '',
    })
  }
  return out
}

/** Payments with money left over that was never applied to an invoice. */
export function openOverRows(ledger: readonly ReceivedRow[]): DifferenceRow[] {
  const out: DifferenceRow[] = []
  for (const r of ledger) {
    if (r.source !== 'BCAT' || r.type !== 'payment' || r.reversed || !r.payment) continue
    if (r.unappliedCents <= 0) continue
    out.push({
      id: `over:${r.id}`,
      kind: 'over-open',
      customerId: r.customerId,
      customerName: r.customerName,
      invoiceRefs: r.invoices.map((i) => i.invoiceId).join(', '),
      invoiceId: r.invoices[0]?.invoiceId ?? null,
      paymentId: r.id,
      date: r.date ?? '',
      reference: r.reference ?? '',
      method: r.method ?? '',
      factored: r.payment.method === 'FACTOR',
      expectedCents: r.appliedCents,
      receivedCents: Math.abs(r.amountCents),
      differenceCents: r.unappliedCents,
      note: r.note ?? '',
    })
  }
  return out
}

/** Differences already accepted as paid in full (short write-offs and accepted overpays). */
export function acceptedRows(ledger: readonly ReceivedRow[]): DifferenceRow[] {
  const out: DifferenceRow[] = []
  for (const r of ledger) {
    if (r.reversed || !isAcceptedDifference(r)) continue
    const over = r.type !== 'write-off'
    out.push({
      id: `acc:${r.id}`,
      kind: over ? 'over-accepted' : 'short-accepted',
      customerId: r.customerId,
      customerName: r.customerName,
      invoiceRefs: r.invoices.map((i) => i.invoiceId).join(', '),
      invoiceId: r.invoices[0]?.invoiceId ?? null,
      paymentId: over ? r.id : null,
      date: r.date ?? '',
      reference: r.reference ?? '',
      method: r.method ?? '',
      factored: r.payment?.method === 'FACTOR',
      expectedCents: 0,
      receivedCents: over ? Math.abs(r.amountCents) : 0,
      differenceCents: over ? r.overAcceptedCents ?? 0 : Math.abs(r.amountCents),
      note: r.note ?? r.payment?.overageReason ?? '',
    })
  }
  return out
}

export function differenceRows(
  invoices: readonly InvoiceRecord[],
  ledger: readonly ReceivedRow[],
  nameOf: (customerId: string, fallback: string) => string,
): DifferenceRow[] {
  return [...openShortRows(invoices, nameOf), ...openOverRows(ledger), ...acceptedRows(ledger)]
    .sort((a, b) => a.customerName.localeCompare(b.customerName) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
}

export interface DifferenceTotals {
  count: number
  cents: number
}

export function totalsByKind(rows: readonly DifferenceRow[]): Record<DifferenceKind, DifferenceTotals> {
  const t: Record<DifferenceKind, DifferenceTotals> = {
    'short-open': { count: 0, cents: 0 }, 'over-open': { count: 0, cents: 0 },
    'short-accepted': { count: 0, cents: 0 }, 'over-accepted': { count: 0, cents: 0 },
  }
  for (const r of rows) { t[r.kind].count += 1; t[r.kind].cents += r.differenceCents }
  return t
}

/** How many differences still need a decision: the Differences tab's badge. */
export const openCount = (rows: readonly DifferenceRow[]): number => rows.filter((r) => isOpenKind(r.kind)).length

/** The bulk request for the ticked rows: only open ones count; each carries what it expects to find. */
export interface AcceptItem {
  kind: 'SHORT' | 'OVER'
  invoiceId?: string
  paymentId?: string
  /** What the server must still find (balance / unapplied), so a stale screen is refused, not applied. */
  expectedCents: number
}

export function acceptItems(rows: readonly DifferenceRow[]): AcceptItem[] {
  const items: AcceptItem[] = []
  for (const r of rows) {
    if (r.kind === 'short-open' && r.invoiceId) items.push({ kind: 'SHORT', invoiceId: r.invoiceId, expectedCents: r.differenceCents })
    else if (r.kind === 'over-open' && r.paymentId) items.push({ kind: 'OVER', paymentId: r.paymentId, expectedCents: r.differenceCents })
  }
  return items
}

/** Ticked rows at or under a limit (cents), open kinds only: the "Select all ≤ $X" helper. */
export function selectUpTo(rows: readonly DifferenceRow[], limitCents: number): string[] {
  return rows.filter((r) => isOpenKind(r.kind) && r.differenceCents <= limitCents).map((r) => r.id)
}
