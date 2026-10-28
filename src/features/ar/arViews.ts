/**
 * Pure projections behind `/ar`. Everything here decides; `ArPage` and `InvoiceDetail`
 * render what these functions return — the `carrierViews.ts` split.
 *
 * Nothing in this file reads the network or the clock: the page passes one `asOf` so the
 * tab strip, the aging chips and the CSV all answer as of the same instant.
 */
import { agingBucket, daysLate, type AgingBucket } from '@/lib/arAging'
import type {
  ArPaymentKind,
  ArPaymentMethod,
  ArPaymentRecord,
  CustomerRecord,
  InvoiceRecord,
  ShipmentNoticeRecord,
  ShipmentNoticeStatus,
} from '@/types/tms'

export type ArTabKey = 'to-invoice' | 'docs-needed' | 'unpaid' | 'paid' | 'payments' | 'aging'

export const AR_TABS: { key: ArTabKey; label: string }[] = [
  { key: 'to-invoice', label: 'To invoice' },
  { key: 'docs-needed', label: 'Docs needed' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'paid', label: 'Paid' },
  { key: 'payments', label: 'Payments & credits' },
  { key: 'aging', label: 'Aging' },
]

/**
 * One batch is one transaction per order on a 60 s Lambda. Twenty-five is what the plan
 * sizes the button to; the selection refuses the twenty-sixth rather than timing out.
 */
export const BATCH_GENERATE_LIMIT = 25

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `2026-10-28` → `Oct 28, 2026`.
 *
 * Plain dates are formatted by hand, not through `Date`: `new Date('2026-10-28')` is UTC
 * midnight, and rendering that in Chicago shows the 27th — an invoice dated the 1st would
 * read as issued last month.
 */
export function formatDay(ymd: string | null | undefined): string {
  if (!ymd) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  if (!m) return ymd
  const month = MONTH_NAMES[Number(m[2]) - 1]
  if (!month) return ymd
  return `${month} ${Number(m[3])}, ${m[1]}`
}

/** `2026-10` → `October 2026`, for the Paid tab's month picker. */
export function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym)
  if (!m) return ym
  const long = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][Number(m[2]) - 1]
  return long ? `${long} ${m[1]}` : ym
}

/** This month first, then the two before it — the only months the Paid tab offers. */
export function lastThreeMonths(asOf: string): string[] {
  const m = /^(\d{4})-(\d{2})/.exec(asOf)
  const year = m ? Number(m[1]) : new Date().getUTCFullYear()
  const month = m ? Number(m[2]) : new Date().getUTCMonth() + 1
  const out: string[] = []
  for (let back = 0; back < 3; back += 1) {
    const total = year * 12 + (month - 1) - back
    out.push(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`)
  }
  return out
}

export interface AgingChip {
  bucket: AgingBucket
  /** `Current`, `Due today`, `12 days late`. */
  label: string
  days: number
  late: boolean
}

/** The one-word age of an invoice, as the Unpaid row and the detail header show it. */
export function agingChipFor(dueAt: string, asOf: string): AgingChip {
  const days = daysLate(dueAt, asOf)
  const bucket = agingBucket(dueAt, asOf)
  const label = days > 0 ? `${days} day${days === 1 ? '' : 's'} late` : days === 0 ? 'Due today' : 'Current'
  return { bucket, label, days, late: days > 0 }
}

export interface UnpaidFilters {
  customerId: string
  /** '' is every bucket. */
  bucket: AgingBucket | ''
  factored: '' | 'YES' | 'NO'
}

export const EMPTY_UNPAID_FILTERS: UnpaidFilters = { customerId: '', bucket: '', factored: '' }

export function applyUnpaidFilters(
  invoices: InvoiceRecord[],
  filters: UnpaidFilters,
  asOf: string,
): InvoiceRecord[] {
  return invoices.filter((inv) => {
    if (filters.customerId && inv.customerId !== filters.customerId) return false
    if (filters.bucket && agingBucket(inv.dueAt, asOf) !== filters.bucket) return false
    if (filters.factored === 'YES' && inv.factored !== true) return false
    if (filters.factored === 'NO' && inv.factored === true) return false
    return true
  })
}

/** Every customer named by a set of invoices, by name, for a filter's dropdown. */
export function invoiceCustomerOptions(invoices: InvoiceRecord[]): { id: string; name: string }[] {
  const byId = new Map<string, string>()
  for (const inv of invoices) {
    if (!byId.get(inv.customerId)) byId.set(inv.customerId, inv.customerName ?? inv.customerId)
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export const AR_PAYMENT_KIND_LABEL: Record<ArPaymentKind, string> = {
  PAYMENT: 'Payment',
  CREDIT_MEMO: 'Credit memo',
  WRITE_OFF: 'Write-off',
  REVERSAL: 'Reversal',
}

export const AR_PAYMENT_METHOD_LABEL: Record<ArPaymentMethod, string> = {
  CHECK: 'Check',
  ACH: 'ACH',
  WIRE: 'Wire',
  CARD: 'Card',
  FACTOR: 'Factor',
  OTHER: 'Other',
}

/** What this row put against one invoice; 0 when it never touched it. */
export function appliedToInvoice(payment: ArPaymentRecord, invoiceId: string): number {
  if (payment.invoiceId === invoiceId && (payment.applications ?? []).length === 0) return payment.amountCents
  let total = 0
  for (const a of payment.applications ?? []) {
    if (a.invoiceId === invoiceId) total += a.amountCents
  }
  return total
}

/** The rows that moved money on one invoice, newest first. */
export function paymentsForInvoice(
  payments: ArPaymentRecord[],
  invoiceId: string,
): { payment: ArPaymentRecord; amountCents: number }[] {
  return payments
    .map((payment) => ({ payment, amountCents: appliedToInvoice(payment, invoiceId) }))
    .filter((row) => row.amountCents !== 0)
    .sort((a, b) => String(b.payment.receivedAt).localeCompare(String(a.payment.receivedAt)))
}

export const NOTICE_STATUS_LABEL: Record<ShipmentNoticeStatus, string> = {
  SENT: 'Sent',
  NOT_SENT: 'Not sent',
  FAILED: 'Failed',
  COPY: 'Copied',
}

/**
 * What dev actually did. SES is denied outside production, so an invoice e-mail comes
 * back NOT_SENT with the refusal and a signed download — and the page says so instead of
 * claiming a send that never happened.
 */
export function noticeStatusDetail(notice: ShipmentNoticeRecord): string | null {
  if (notice.status === 'SENT') return null
  if (notice.status === 'COPY') return 'Copied for pasting; nothing was e-mailed.'
  const suffix = notice.error ? ` ${notice.error}` : ''
  return `Not sent (SES is off on dev) — nothing reached the customer.${suffix}`
}

/**
 * One invoice's e-mail history out of a shipment's notices, newest first.
 *
 * Notices belong to the shipment, not the invoice, so a re-issued invoice on the same
 * shipment would otherwise show the voided bill's sends. The number in the subject is
 * what separates them.
 */
export function invoiceNotices(
  notices: ShipmentNoticeRecord[],
  invoiceNumber: string,
): ShipmentNoticeRecord[] {
  return notices
    .filter((n) => n.kind === 'INVOICE' && (!invoiceNumber || n.subject.includes(invoiceNumber)))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

/** The bill-to's name off the customer record, or the customer itself when none is set. */
export function billToLabel(
  customer: Pick<CustomerRecord, 'name' | 'billToParties'> | null | undefined,
  billToId: string | null | undefined,
): string {
  if (!billToId) return customer?.name ?? '—'
  const party = (customer?.billToParties ?? []).find((p) => p.id === billToId)
  return party?.name ?? billToId
}

/** Comma-joined recipients come back off the notice; show them as a readable list. */
export function recipientList(to: string | null | undefined): string {
  return (to ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ')
}
