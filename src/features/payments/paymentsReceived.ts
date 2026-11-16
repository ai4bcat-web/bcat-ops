/**
 * Payments Received (Ryne 2026-11-15): every customer receipt, credit, debit and reversal in one
 * ledger, all customers. Two sources, one row shape:
 *  - BCAT `ArPayment` rows (payments, credit memos, write-offs, reversals), with what each was applied to;
 *  - the Aljex CRED/DEBT memo rows kept as history (`LegacyAljexRow` MEMO_CRED / MEMO_DEBT).
 *
 * Pure: the page loads the rows, this shapes, filters, totals and exports them. Amounts are integer
 * cents; a credit or a reversal is negative, a payment or a debit positive, so a column adds up to
 * the net cash and adjustments in view.
 */
import { AR_PAYMENT_METHOD_LABEL } from '@/features/ar/arViews'
import type { ArPaymentRecord } from '@/types/tms'
import { isShortPayNote } from '@/lib/paymentDifference'

export type ReceivedType = 'payment' | 'credit' | 'debit' | 'write-off' | 'reversal'

export const RECEIVED_TYPE_LABEL: Record<ReceivedType, string> = {
  payment: 'Payment',
  credit: 'Credit',
  debit: 'Debit',
  'write-off': 'Write-off',
  reversal: 'Reversal',
}

export interface ReceivedInvoiceRef {
  /** The invoice id (= its number) the money went against, or the PRO an Aljex memo names. */
  invoiceId: string
  amountCents: number | null
}

export interface ReceivedRow {
  id: string
  source: 'BCAT' | 'Aljex'
  type: ReceivedType
  /** `YYYY-MM-DD` the money was received or the memo dated. */
  date: string | null
  customerId: string | null
  customerName: string
  /** Method label (Check, ACH, …) or null. */
  method: string | null
  reference: string | null
  /** Signed: payments and debits positive, credits, write-offs and reversals negative. */
  amountCents: number
  appliedCents: number
  unappliedCents: number
  invoices: ReceivedInvoiceRef[]
  recordedBy: string | null
  note: string | null
  /** True once a later reversal has undone this row. */
  reversed: boolean
  /** The reversal's date and reason, when it was read. */
  reversedOn: string | null
  reversedReason: string | null
  /** The BCAT row itself, for Reverse. Null on Aljex history. */
  payment: ArPaymentRecord | null
  /** Overpay accepted as paid in full on this payment: recorded, never kept as customer credit. */
  overAcceptedCents?: number
}

const KIND_TYPE: Record<ArPaymentRecord['kind'], ReceivedType> = {
  PAYMENT: 'payment',
  CREDIT_MEMO: 'credit',
  WRITE_OFF: 'write-off',
  REVERSAL: 'reversal',
}

const ymd = (iso: string | null | undefined): string | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null)

export function fromArPayment(
  p: ArPaymentRecord,
  customerName: (id: string) => string,
  reversalOf: (paymentId: string) => ArPaymentRecord | undefined = () => undefined,
): ReceivedRow {
  const reversal = p.reversedByPaymentId ? reversalOf(p.id) : undefined
  const type = KIND_TYPE[p.kind] ?? 'payment'
  const sign = type === 'payment' ? 1 : -1
  const invoices: ReceivedInvoiceRef[] = (p.applications ?? []).map((a) => ({ invoiceId: a.invoiceId, amountCents: a.amountCents }))
  if (invoices.length === 0 && p.invoiceId) invoices.push({ invoiceId: p.invoiceId, amountCents: null })
  return {
    id: p.id,
    source: 'BCAT',
    type,
    date: ymd(p.receivedAt),
    customerId: p.customerId || null,
    customerName: customerName(p.customerId) || p.customerId || '—',
    method: p.method ? AR_PAYMENT_METHOD_LABEL[p.method] ?? p.method : null,
    reference: p.reference || null,
    amountCents: sign * Math.abs(p.amountCents ?? 0),
    appliedCents: p.appliedCents ?? 0,
    unappliedCents: p.unappliedCents ?? 0,
    invoices,
    recordedBy: p.createdBy || null,
    note: p.note || null,
    reversed: Boolean(p.reversedByPaymentId),
    reversedOn: ymd(reversal?.receivedAt ?? reversal?.createdAt),
    reversedReason: reversal?.note || null,
    payment: p,
    overAcceptedCents: p.overageAcceptedCents ?? 0,
  }
}

/** One Aljex memo row: `fields` is `{ c<n>: { h: header, v: value } }` (or its JSON string). */
export interface AljexMemoRow {
  id: string
  pro: string
  kind: 'MEMO_CRED' | 'MEMO_DEBT' | string
  fields: unknown
}

function memoFields(raw: unknown): Map<string, string> {
  let f = raw
  if (typeof f === 'string') {
    try { f = JSON.parse(f) } catch { f = {} }
  }
  const out = new Map<string, string>()
  if (f && typeof f === 'object') {
    for (const cell of Object.values(f as Record<string, unknown>)) {
      const c = cell as { h?: unknown; v?: unknown } | null
      const h = typeof c?.h === 'string' ? c.h.trim() : ''
      const v = typeof c?.v === 'string' ? c.v.trim() : ''
      // The first occurrence wins (the line-item block repeats Description).
      if (h && v && !out.has(h)) out.set(h, v)
    }
  }
  return out
}

/** `11/05/25` → `2025-11-05`. */
export function aljexDate(v: string | undefined): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec((v ?? '').trim())
  if (!m) return null
  const year = m[3].length === 2 ? `20${m[3]}` : m[3]
  return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

const cents = (v: string | undefined): number => {
  const n = Number((v ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/** Aljex history: a CRED (negative) or DEBT (positive) memo against the PRO in its Reference #. */
export function fromAljexMemo(row: AljexMemoRow, customerIdByName: (name: string) => string | null): ReceivedRow | null {
  if (row.kind !== 'MEMO_CRED' && row.kind !== 'MEMO_DEBT') return null
  const f = memoFields(row.fields)
  const credit = row.kind === 'MEMO_CRED'
  const amount = Math.abs(cents(f.get('Invoice Amount') ?? f.get('Extension')))
  const name = f.get('Customer Name') ?? f.get('Bill To Name') ?? ''
  const refPro = (f.get('Reference #') ?? f.get('Customer Ref #') ?? '').replace(/^#/, '').trim()
  const posted = f.get('Posted Info') ?? ''
  const by = /\d{2}:\d{2}:\d{2}\s*([A-Z0-9._-]+)\s*$/i.exec(posted)?.[1] ?? null
  return {
    id: row.id,
    source: 'Aljex',
    type: credit ? 'credit' : 'debit',
    date: aljexDate(f.get('Invoice Date')) ?? aljexDate(f.get('Created Date')),
    customerId: name ? customerIdByName(name) : null,
    customerName: name || '—',
    method: null,
    reference: `Aljex memo ${row.pro}`,
    amountCents: credit ? -amount : amount,
    appliedCents: amount,
    unappliedCents: 0,
    invoices: refPro ? [{ invoiceId: refPro, amountCents: amount }] : [],
    recordedBy: by ? `${by} (Aljex)` : 'Aljex',
    note: f.get('Description') ?? null,
    reversed: false,
    reversedOn: null,
    reversedReason: null,
    payment: null,
  }
}

/** The list's segmented control: cash receipts, adjustments (credits, debits, write-offs), or both. */
export type ReceivedView = 'payments' | 'adjustments' | 'all'

/** A short pay accepted as paid in full (a write-off with the standard reason), or a payment that accepted an overpay. */
export function isAcceptedDifference(row: ReceivedRow): boolean {
  return (row.type === 'write-off' && isShortPayNote(row.note)) || (row.overAcceptedCents ?? 0) > 0
}

export function inView(row: ReceivedRow, view: ReceivedView): boolean {
  if (view === 'all') return true
  const cash = row.type === 'payment' || (row.type === 'reversal' && row.payment != null)
  return view === 'payments' ? cash : !cash
}

/**
 * Reversed rows are hidden by default (Ryne 2026-11-15): a payment that was reversed and the
 * reversal that undid it cancel out, so the pair only shows with "Show reversed".
 */
export function hideReversed(rows: readonly ReceivedRow[], show: boolean): ReceivedRow[] {
  return show ? [...rows] : rows.filter((r) => !r.reversed && r.type !== 'reversal')
}

export interface ReceivedFilter {
  /** Inclusive `YYYY-MM-DD`; either end may be empty. */
  from: string
  to: string
  /** Customer ids; a memo whose name matched no customer is kept only with no customer picked. */
  customers: string[]
  types: ReceivedType[]
  methods: string[]
  /** Division keys (`BROKERAGE`, `ASSETS/LOCAL`); matched when any applied invoice's shipment is in one. */
  divisions: string[]
  unappliedOnly: boolean
  /** Only accepted differences: short pays closed as paid in full, and overpays accepted. */
  diffsOnly?: boolean
}

export function monthBounds(asOf: string): { from: string; to: string } {
  const [y, m] = asOf.slice(0, 7).split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${asOf.slice(0, 7)}-01`, to: `${asOf.slice(0, 7)}-${String(last).padStart(2, '0')}` }
}

export const NO_METHOD = '(none)'

export function filterReceived(
  rows: readonly ReceivedRow[],
  f: ReceivedFilter,
  divisionsOf: (row: ReceivedRow) => string[],
): ReceivedRow[] {
  return rows.filter((r) => {
    if (f.from && (!r.date || r.date < f.from)) return false
    if (f.to && (!r.date || r.date > f.to)) return false
    if (f.customers.length > 0 && !(r.customerId && f.customers.includes(r.customerId))) return false
    if (f.types.length > 0 && !f.types.includes(r.type)) return false
    if (f.methods.length > 0 && !f.methods.includes(r.method ?? NO_METHOD)) return false
    if (f.unappliedOnly && r.unappliedCents <= 0) return false
    if (f.diffsOnly && !isAcceptedDifference(r)) return false
    if (f.divisions.length > 0) {
      const mine = divisionsOf(r)
      if (!f.divisions.some((d) => mine.some((k) => k === d || k.startsWith(`${d}/`)))) return false
    }
    return true
  })
}

export interface ReceivedTotals {
  count: number
  /** Payments in that still stand (not reversed). */
  paymentsCents: number
  paymentsCount: number
  creditsCents: number
  creditsCount: number
  debitsCents: number
  debitsCount: number
  writeOffsCents: number
  /** Reversal rows listed; they and the rows they reversed are left out of every total. */
  reversalsCount: number
  unappliedCents: number
  /** Σ signed amounts: what the rows in view add up to. */
  netCents: number
}

export function receivedTotals(rows: readonly ReceivedRow[]): ReceivedTotals {
  const t: ReceivedTotals = {
    count: rows.length, paymentsCents: 0, paymentsCount: 0, creditsCents: 0, creditsCount: 0, debitsCents: 0, debitsCount: 0,
    writeOffsCents: 0, reversalsCount: 0, unappliedCents: 0, netCents: 0,
  }
  for (const r of rows) {
    // A reversal and the row it undid cancel out: the pair is listed, but neither is counted as money in.
    if (r.type === 'reversal') { t.reversalsCount += 1; continue }
    if (r.reversed) continue
    t.netCents += r.amountCents
    t.unappliedCents += r.unappliedCents
    if (r.type === 'payment') { t.paymentsCents += r.amountCents; t.paymentsCount += 1 }
    else if (r.type === 'credit') { t.creditsCents += r.amountCents; t.creditsCount += 1 }
    else if (r.type === 'debit') { t.debitsCents += r.amountCents; t.debitsCount += 1 }
    else t.writeOffsCents += r.amountCents
  }
  return t
}

/** Oldest first, with the running sum of signed amounts (one customer's ledger). */
export function withRunningTotal(rows: readonly ReceivedRow[]): Array<ReceivedRow & { runningCents: number }> {
  const sorted = [...rows].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id.localeCompare(b.id))
  let run = 0
  return sorted.map((r) => { run += r.amountCents; return { ...r, runningCents: run } })
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const dollars = (c: number) => (c / 100).toFixed(2)

export function receivedCsv(rows: readonly ReceivedRow[]): string {
  const head = ['Date', 'Customer', 'Type', 'Method', 'Reference', 'Amount', 'Applied', 'Unapplied', 'Applied to', 'Recorded by', 'Source', 'Reversed', 'Note']
  const lines = [head.join(',')]
  for (const r of rows) {
    lines.push([
      r.date ?? '', r.customerName, RECEIVED_TYPE_LABEL[r.type], r.method ?? '', r.reference ?? '',
      dollars(r.amountCents), dollars(r.appliedCents), dollars(r.unappliedCents),
      r.invoices.map((i) => i.invoiceId).join(' '), r.recordedBy ?? '', r.source, r.reversed ? 'Yes' : '', r.note ?? '',
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

/** Upper-cased, punctuation-free: how an Aljex customer name is matched to a BCAT customer. */
export function nameKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '')
}
