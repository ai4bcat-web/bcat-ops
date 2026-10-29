/**
 * Pure projections behind `/commissions`. Everything here decides; `CommissionsPage`
 * and the invoice detail's Commission card only render.
 *
 * The approval ladder is NOT re-derived here. `commissionState` in `src/lib/commission.ts`
 * is the one answer the page and the Lambda both read, so `filterForCaller` asks it rather
 * than writing a second copy of the rules that would drift from the server's.
 */
import { COMMISSION_ROLE_LABELS, commissionState, type CommissionCaller } from '@/lib/commission'
import type { CommissionKind, CommissionRecord, CommissionStatus } from '@/types/tms'

export type CommissionTabKey = 'mine' | 'to-approve' | 'pay-periods' | 'history'

export const COMMISSION_TABS: { key: CommissionTabKey; label: string }[] = [
  { key: 'mine', label: 'Mine' },
  { key: 'to-approve', label: 'To approve' },
  { key: 'pay-periods', label: 'Pay periods' },
  { key: 'history', label: 'History' },
]

export const COMMISSION_STATUSES: readonly CommissionStatus[] = [
  'UN_APPROVED',
  'REP_COUNTERED',
  'MANAGER_COUNTERED',
  'MANAGER_APPROVED',
  'FULLY_APPROVED',
  'PAID',
  'CANCELLED',
] as const

export const COMMISSION_KINDS: readonly CommissionKind[] = ['EARNED', 'ADJUSTMENT', 'REVERSAL'] as const

const STATUS_LABELS: Record<CommissionStatus, string> = {
  UN_APPROVED: 'Un-approved',
  REP_COUNTERED: 'Rep countered',
  MANAGER_COUNTERED: 'Manager countered',
  MANAGER_APPROVED: 'Manager approved',
  FULLY_APPROVED: 'Fully approved',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
}

const STATUS_TONES: Record<CommissionStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  UN_APPROVED: 'outline',
  REP_COUNTERED: 'secondary',
  MANAGER_COUNTERED: 'secondary',
  MANAGER_APPROVED: 'secondary',
  FULLY_APPROVED: 'default',
  PAID: 'default',
  CANCELLED: 'destructive',
}

export function statusLabel(status: CommissionStatus | null | undefined): string {
  return STATUS_LABELS[status ?? 'UN_APPROVED'] ?? String(status)
}

export function statusTone(
  status: CommissionStatus | null | undefined,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  return STATUS_TONES[status ?? 'UN_APPROVED'] ?? 'outline'
}

export const KIND_LABELS: Record<CommissionKind, string> = {
  EARNED: 'Earned',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Reversal',
}

export function kindLabel(kind: CommissionKind | null | undefined): string {
  return KIND_LABELS[kind ?? 'EARNED'] ?? String(kind)
}

export function roleLabel(row: Pick<CommissionRecord, 'roleName'>): string {
  return COMMISSION_ROLE_LABELS[row.roleName] ?? row.roleName
}

/**
 * Why a row is parked for a human, in words the approver can act on.
 *
 * `basisNote` is a code the Lambda writes; an approver is owed the sentence behind it,
 * because "OWN_FLEET_NO_COST" does not tell anybody what to do about a $0 commission.
 */
const REVIEW_REASONS: Record<string, string> = {
  OWN_FLEET_NO_COST:
    'ran on our own trucks, so there is no carrier cost to take a margin from',
  NO_PERSON: 'nobody is named on the records for this role, so there is no one to pay',
  NO_PLAN: 'no commission plan matched this load',
  INVOICE_VOIDED: 'the invoice behind it was voided',
  WRITE_OFF: 'the invoice was written off',
}

export function needsReviewReason(
  row: Pick<CommissionRecord, 'needsReview' | 'basisNote' | 'costFinal'>,
): string | null {
  const note = (row.basisNote ?? '').trim()
  if (note && REVIEW_REASONS[note]) return REVIEW_REASONS[note]
  if (note) return `flagged as ${note.toLowerCase().replace(/_/g, ' ')}`
  if (row.costFinal === false) return 'a carrier assignment is still open, so the cost can still move'
  if (row.needsReview) return 'the run could not settle this one on its own'
  return null
}

/** Needs-review rows first, then oldest trigger first — the order an approver works in. */
export function sortForApproval<T extends Pick<CommissionRecord, 'needsReview' | 'triggerAt' | 'id'>>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const review = (a.needsReview ? 0 : 1) - (b.needsReview ? 0 : 1)
    if (review !== 0) return review
    const trigger = (a.triggerAt ?? '').localeCompare(b.triggerAt ?? '')
    if (trigger !== 0) return trigger
    return a.id.localeCompare(b.id)
  })
}

/** Newest trigger first — the Mine and History tabs. */
export function sortNewestFirst<T extends Pick<CommissionRecord, 'triggerAt' | 'id'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const trigger = (b.triggerAt ?? '').localeCompare(a.triggerAt ?? '')
    return trigger !== 0 ? trigger : a.id.localeCompare(b.id)
  })
}

/**
 * The rows this caller has any button on.
 *
 * A filter, never a boundary: the Lambda refuses what it refuses regardless of what the
 * board drew. Hiding a row here only keeps the approve list to the work this person can
 * actually do.
 */
export function filterForCaller(rows: CommissionRecord[], caller: CommissionCaller): CommissionRecord[] {
  return rows.filter((row) => {
    const state = commissionState(row, caller)
    return (
      state.canApprove ||
      state.canCounter ||
      state.canAcceptCounter ||
      state.canOverride ||
      state.canCancel
    )
  })
}

/** RFC-4180: every field quoted, an embedded quote doubled. The AR aging CSV's rule. */
const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

/** Integer cents → a plain `1234.50` a spreadsheet will parse as a number. */
const dollars = (cents: number) => {
  const abs = Math.abs(Math.round(cents))
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** What the plan charged, as the row records it: a percentage, or a flat amount. */
export function rateLabel(
  row: Pick<CommissionRecord, 'rateType' | 'rateBps' | 'rateCents' | 'tierLabel'>,
): string {
  const tier = (row.tierLabel ?? '').trim()
  const suffix = tier ? ` (${tier})` : ''
  if (row.rateType === 'FIXED') return `${dollars(row.rateCents ?? 0)} flat${suffix}`
  if (row.rateBps == null) return tier || '—'
  const pct = row.rateBps / 100
  const of = row.rateType === 'PERCENT_REVENUE' ? 'of revenue' : 'of profit'
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}% ${of}${suffix}`
}

export const COMMISSION_CSV_HEADER = [
  'Shipment',
  'Invoice',
  'Customer',
  'Rep',
  'Role',
  'Kind',
  'Basis',
  'Basis amount',
  'Rate',
  'Plan amount',
  'Net',
  'Status',
  'Month',
  'Triggered',
  'Pay period',
] as const

/** The rows exactly as the table shows them, in the order given. */
export function commissionCsv(rows: CommissionRecord[]): string {
  const lines = [COMMISSION_CSV_HEADER.map(q).join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.shipmentNumber ?? '',
        row.invoiceNumber ?? '',
        row.customerName ?? '',
        row.repName ?? row.repId,
        roleLabel(row),
        kindLabel(row.kind),
        row.basis ?? '',
        dollars(row.basisCents),
        rateLabel(row),
        dollars(row.amountCents),
        dollars(row.netCents),
        statusLabel(row.status),
        row.commissionMonth,
        row.triggerAt,
        row.payPeriodId ?? '',
      ]
        .map(q)
        .join(','),
    )
  }
  return lines.join('\n')
}

/** `2026-10` → `October 2026`. */
export function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym)
  if (!m) return ym
  const long = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][Number(m[2]) - 1]
  return long ? `${long} ${m[1]}` : ym
}

/**
 * `count` months ending with the one `nowIso` falls in, newest first.
 *
 * Built by arithmetic on the string rather than `Date`, for the reason `formatDay` gives:
 * `new Date('2026-10-01')` is UTC midnight and renders in Chicago as September.
 */
export function monthOptions(nowIso: string, count: number): string[] {
  const m = /^(\d{4})-(\d{2})/.exec(nowIso ?? '')
  const now = new Date()
  const year = m ? Number(m[1]) : now.getUTCFullYear()
  const month = m ? Number(m[2]) : now.getUTCMonth() + 1
  const out: string[] = []
  for (let back = 0; back < Math.max(1, Math.trunc(count)); back += 1) {
    const total = year * 12 + (month - 1) - back
    out.push(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`)
  }
  return out
}
