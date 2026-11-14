/**
 * Pure projections behind `/ap`. Everything here decides; `ApPage` and `BillDetail`
 * render what these functions return — the `arViews.ts` split.
 *
 * No money is computed here. A bill's fee, net, variance and balance are frozen on the
 * row by `RECORD_BILL`, its gates come from `approvalReadiness`, and its buckets come
 * from `@/lib/arAging`: this file only picks, filters, sorts and words them. The dates
 * and the aging chip are AR's helpers imported outright, because a bill 31 days late and
 * an invoice 31 days late have to read the same.
 */
import { isVerifyPaymentBill } from '@/lib/verifyPayment'
import { approvalReadiness, PENDING_DATES_BLOCK, type ApprovalWarning } from '@/lib/carrierBill'
import { daysLate } from '@/lib/arAging'
import type { ApWorklistRow } from '@/hooks/useApWorklist'
import type { CarrierPaymentInfo } from '@/lib/apiClient'
import type {
  ApPayeeKind,
  ApPaymentKind,
  ApPaymentMethod,
  ApPaymentRecord,
  ApSettings,
  CarrierBillRecord,
  CarrierBillStatus,
  CarrierRecord,
  LoadCarrierRecord,
  ShipmentDocumentType,
} from '@/types/tms'

export type ApTabKey = 'awaiting' | 'expected' | 'aging' | 'selected' | 'paid' | 'payments' | 'report' | 'inbox' | 'review'

/**
 * The payable ladder as Ryne reads it: a bill is Expected until somebody enters the carrier's invoice
 * date and due date, Aging once it has them, and Selected once it is chosen for the next pay run.
 * `report` is the by-carrier aging report that used to be called Aging.
 */
export const AP_TABS: { key: ApTabKey; label: string }[] = [
  // 'awaiting' (carrier legs with no bill yet) left the strip on 2026-11-12: a bill is now created when
  // the load moves to billing from Load review, so a leg without one is still Load review's work.
  { key: 'expected', label: 'Expected' },
  { key: 'aging', label: 'Aging' },
  { key: 'selected', label: 'Selected' },
  { key: 'paid', label: 'Paid' },
  { key: 'payments', label: 'Payments & credits' },
  { key: 'report', label: 'Aging report' },
  { key: 'inbox', label: 'AP inbox' },
  { key: 'review', label: 'Needs review' },
]

export const BILL_STATUS_LABEL: Record<CarrierBillStatus, string> = {
  IN_REVIEW: 'In review',
  TO_BE_PAID: 'To be paid',
  PARTIAL: 'Partly paid',
  PAID: 'Paid',
  VOID: 'Void',
}

export const AP_PAYMENT_KIND_LABEL: Record<ApPaymentKind, string> = {
  PAYMENT: 'Payment',
  CREDIT_MEMO: 'Credit',
  REVERSAL: 'Reversal',
}

export const AP_PAYMENT_METHOD_LABEL: Record<ApPaymentMethod, string> = {
  ACH: 'ACH',
  WIRE: 'Wire',
  CHECK: 'Check',
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  EFT: 'EFT',
  CARD: 'Credit card (Amex)',
  OTHER: 'Other',
}

export const AP_PAYEE_KIND_LABEL: Record<ApPayeeKind, string> = {
  CARRIER: 'Carrier',
  FACTOR: 'Factor',
}

/**
 * Who the cheque is actually made out to. A factored carrier is still the carrier we owe
 * — the money goes to their factor, and the row has to say whose name is on it.
 */
export function payeeLabel(bill: Pick<CarrierBillRecord, 'payeeKind' | 'carrierName' | 'remitTo'>): string {
  const carrier = bill.carrierName?.trim() || 'Carrier'
  if (bill.payeeKind !== 'FACTOR') return bill.remitTo?.name?.trim() || carrier
  const factor = bill.remitTo?.factorName?.trim() || bill.remitTo?.name?.trim()
  return factor ? `Factor — ${factor}` : 'Factor'
}

/** `Quick pay 2d` when the assignment is on quick pay, otherwise nothing to say. */
export function quickPayLabel(
  assignment: { quickPay?: boolean | null; quickPayDays?: number | null } | null | undefined,
): string | null {
  if (!assignment?.quickPay) return null
  const days = assignment.quickPayDays
  return days && days > 0 ? `Quick pay ${days}d` : 'Quick pay'
}

/**
 * An own-fleet leg is not AP at all: the driver is paid through their settlement period,
 * and a Record button here would pay for the same freight twice. Legacy rows booked
 * before the ladder stopped stamping own assets can still surface, so the board says so
 * rather than pretending they are bills.
 */
export function isOwnFleet(row: Pick<ApWorklistRow, 'assignment'>): boolean {
  return row.assignment.kind !== 'CARRIER'
}

/**
 * Bills on the review rung, the order the queue is worked: bills still waiting on their invoice date and due date
 * first (that is the next thing somebody has to do to them), then oldest recorded first.
 */
export function billsInReview(bills: readonly CarrierBillRecord[]): CarrierBillRecord[] {
  return bills
    .filter((b) => b.status === 'IN_REVIEW')
    .sort((a, b) =>
      (a.datesPending === true ? 0 : 1) - (b.datesPending === true ? 0 : 1)
      || String(a.recordedAt).localeCompare(String(b.recordedAt)))
}

/** Passed load review and waiting on the carrier's invoice date and due date, oldest recorded first. */
export function billsExpected(bills: readonly CarrierBillRecord[]): CarrierBillRecord[] {
  return bills
    .filter((b) => b.status === 'IN_REVIEW' && b.datesPending === true)
    .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)))
}

const isApproved = (b: Pick<CarrierBillRecord, 'status'>) => b.status === 'TO_BE_PAID' || b.status === 'PARTIAL'

/**
 * Open bills that have their invoice date and are not on a pay run yet, soonest due first. A bill still in
 * review shows here too (it has its dates) but cannot be selected until it is approved.
 */
export function billsAging(bills: readonly CarrierBillRecord[]): CarrierBillRecord[] {
  return bills
    .filter((b) => (b.status === 'IN_REVIEW' && b.datesPending !== true) || (isApproved(b) && b.selectedForPayment !== true))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
}

/** Approved bills chosen for the next pay run, soonest due first. */
export function billsSelected(bills: readonly CarrierBillRecord[]): CarrierBillRecord[] {
  return bills
    .filter((b) => isApproved(b) && b.selectedForPayment === true)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
}

/** Only an approved bill can go on a pay run; a bill still in review has gates to clear first. */
export function canSelectForPayment(bill: Pick<CarrierBillRecord, 'status' | 'datesPending'>): boolean {
  return isApproved(bill) && bill.datesPending !== true
}

export interface InvoiceAgeBucket { key: 'D0_30' | 'D31_60' | 'D61_PLUS'; label: string; count: number; cents: number }

/** Open balances by days since the carrier's invoice date: 0–30, 31–60, 61+. */
export function invoiceAgeBuckets(bills: readonly CarrierBillRecord[], asOf: string): InvoiceAgeBucket[] {
  const out: InvoiceAgeBucket[] = [
    { key: 'D0_30', label: '0–30 days', count: 0, cents: 0 },
    { key: 'D31_60', label: '31–60 days', count: 0, cents: 0 },
    { key: 'D61_PLUS', label: '61+ days', count: 0, cents: 0 },
  ]
  for (const bill of bills) {
    const age = Math.max(0, daysLate(bill.billDate, asOf))
    const bucket = age <= 30 ? out[0]! : age <= 60 ? out[1]! : out[2]!
    bucket.count += 1
    bucket.cents += bill.balanceCents
  }
  return out
}

/** `Factor — Triumph` or `Direct`: who the money is paid to. */
export function payToLabel(bill: Pick<CarrierBillRecord, 'payeeKind' | 'remitTo'>): string {
  if (bill.payeeKind !== 'FACTOR') return 'Direct'
  const factor = bill.remitTo?.factorName?.trim() || bill.remitTo?.name?.trim()
  return factor ? `Factor — ${factor}` : 'Factor'
}

/**
 * The carrier's payment method behind a bill: the one the bill was recorded against, else their preferred
 * active method, else any active one. Null when the carrier has nothing on file.
 */
export function paymentInfoFor(
  bill: Pick<CarrierBillRecord, 'carrierId' | 'paymentMethodId'>,
  infos: readonly CarrierPaymentInfo[],
): CarrierPaymentInfo | null {
  if (bill.paymentMethodId) {
    const exact = infos.find((i) => i.id === bill.paymentMethodId)
    if (exact) return exact
  }
  const mine = infos.filter((i) => i.carrierId === bill.carrierId && i.status !== 'INACTIVE')
  return mine.find((i) => i.isPreferred) ?? mine[0] ?? null
}

/** The e-mail remittance goes to: the address snapshotted on the bill, else the payment method's. */
export function remitEmailOf(
  bill: Pick<CarrierBillRecord, 'remitTo' | 'carrierId' | 'paymentMethodId'>,
  infos: readonly CarrierPaymentInfo[],
): string {
  return bill.remitTo?.payeeEmail?.trim() || paymentInfoFor(bill, infos)?.payeeEmail?.trim() || ''
}

/** Approved bills waiting on cash — PARTIAL included — soonest due first. */
export function billsToPay(bills: readonly CarrierBillRecord[]): CarrierBillRecord[] {
  return bills
    .filter((b) => b.status === 'TO_BE_PAID' || b.status === 'PARTIAL')
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
}

/** What a month's read actually settled, newest paid first. */
export function paidBills(bills: readonly CarrierBillRecord[]): CarrierBillRecord[] {
  return bills
    .filter((b) => b.status === 'PAID')
    .sort((a, b) => String(b.paidAt ?? b.billDate).localeCompare(String(a.paidAt ?? a.billDate)))
}

export interface ToBePaidFilters {
  carrierId: string
  /** '' is every due date. */
  due: '' | 'OVERDUE' | 'WEEK' | 'LATER'
  payeeKind: '' | ApPayeeKind
  /** Only the bills Ryne has not paid although Aljex says paid (static PRO list). */
  verifyPayment: boolean
}

export const EMPTY_TO_BE_PAID_FILTERS: ToBePaidFilters = { carrierId: '', due: '', payeeKind: '', verifyPayment: false }

export function applyToBePaidFilters(
  bills: readonly CarrierBillRecord[],
  filters: ToBePaidFilters,
  asOf: string,
): CarrierBillRecord[] {
  return bills.filter((bill) => {
    if (filters.carrierId && bill.carrierId !== filters.carrierId) return false
    if (filters.payeeKind && bill.payeeKind !== filters.payeeKind) return false
    if (filters.verifyPayment && !isVerifyPaymentBill(bill)) return false
    if (filters.due) {
      const late = daysLate(bill.dueAt, asOf)
      if (filters.due === 'OVERDUE' && late <= 0) return false
      if (filters.due === 'WEEK' && (late > 0 || late < -7)) return false
      if (filters.due === 'LATER' && late >= -7) return false
    }
    return true
  })
}

/** Every carrier named by a set of bills, by name, for a filter's dropdown. */
export function billCarrierOptions(bills: readonly CarrierBillRecord[]): { id: string; name: string }[] {
  const byId = new Map<string, string>()
  for (const bill of bills) {
    if (!byId.get(bill.carrierId)) byId.set(bill.carrierId, bill.carrierName ?? bill.carrierId)
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * One pay run is one carrier: a payment carries a carrier and a method, so a selection
 * that spans two carriers cannot be posted as one row. The button reads this.
 */
export function selectionCarrierId(bills: readonly CarrierBillRecord[], selected: readonly string[]): string | null {
  const ids = new Set(bills.filter((b) => selected.includes(b.id)).map((b) => b.carrierId))
  return ids.size === 1 ? [...ids][0]! : null
}

/** What the ticked bills still owe, as the balances already say. */
export function selectionBalanceCents(bills: readonly CarrierBillRecord[], selected: readonly string[]): number {
  return bills.reduce((sum, b) => (selected.includes(b.id) ? sum + b.balanceCents : sum), 0)
}

/** The cost nobody has billed us for yet, straight off the cached assignment rows. */
export function awaitingInvoiceTotals(rows: readonly ApWorklistRow[]): { cents: number; count: number } {
  const billable = rows.filter((row) => !isOwnFleet(row))
  return {
    cents: billable.reduce((sum, row) => sum + row.costCents, 0),
    count: billable.length,
  }
}

/**
 * Average days from the carrier's bill date to the day we paid it, over the bills in
 * hand. Null when nothing in the window has been paid — unmeasured is not zero.
 */
export function avgDaysToPayBills(bills: readonly CarrierBillRecord[]): number | null {
  const days = bills.flatMap((b) => (b.status === 'PAID' && b.paidAt ? [daysLate(b.billDate, b.paidAt)] : []))
  if (days.length === 0) return null
  return Math.round((days.reduce((sum, d) => sum + d, 0) / days.length) * 10) / 10
}

/** What this row put against one bill; 0 when it never touched it. */
export function appliedToBill(payment: ApPaymentRecord, billId: string): number {
  let total = 0
  for (const a of payment.applications ?? []) {
    if (a.billId === billId) total += a.amountCents
  }
  return total
}

/** The rows that moved money on one bill, newest first. */
export function paymentsForBill(
  payments: readonly ApPaymentRecord[],
  billId: string,
): { payment: ApPaymentRecord; amountCents: number }[] {
  return payments
    .map((payment) => ({ payment, amountCents: appliedToBill(payment, billId) }))
    .filter((row) => row.amountCents !== 0)
    .sort((a, b) => String(b.payment.paidAt).localeCompare(String(a.payment.paidAt)))
}

export interface BillGates {
  blocks: string[]
  warnings: ApprovalWarning[]
}

const NO_GATES: BillGates = { blocks: [], warnings: [] }

/**
 * What stands between this bill and the pay run, as the board can see it.
 *
 * The reasoning is `approvalReadiness`'s, fed with the cached fields the worklist already
 * carries; the approve dialog asks the Lambda for the authoritative answer against live
 * documents. With no assignment in hand the board says nothing rather than guessing — an
 * invented block is a bill somebody stops chasing for no reason.
 */
export function billGates(input: {
  bill: CarrierBillRecord
  row: ApWorklistRow | null | undefined
  carrier?: Pick<CarrierRecord, 'name' | 'status'> | null
  settings: Pick<ApSettings, 'apRequireSignedRateCon'> | null
  isAdmin: boolean
}): BillGates {
  const { bill, row, carrier, settings, isAdmin } = input
  if (!row) return bill.datesPending === true ? { blocks: [PENDING_DATES_BLOCK], warnings: [] } : NO_GATES
  return approvalReadiness({
    bill,
    loadCarrier: { status: row.assignment.status, rateConStatus: row.assignment.rateConStatus },
    // The worklist carries the shipment, not the load; a delivered shipment is the
    // delivered leg as far as the board can tell, and the dialog reads the load itself.
    load: {
      id: bill.loadId,
      status: row.shipment?.deliveredAt ? 'DELIVERED' : null,
      loadNumber: bill.loadNumber ?? row.shipmentNumber,
    },
    // `docsMissing` is the cached carrier-scope gate: document types, stored as strings.
    gate: { missing: (row.assignment.docsMissing ?? []) as ShipmentDocumentType[] },
    payee: bill.remitTo ? { kind: bill.payeeKind, remitTo: bill.remitTo, paymentMethodId: bill.paymentMethodId ?? null } : null,
    carrier,
    settings,
    isAdmin,
  })
}

/** One live outside carrier on a shipment's load, as the AP surfaces name its siblings. */
export interface SiblingCarrier {
  loadCarrierId: string
  carrierName: string
  /** The recorded bill, null until Record lands one. */
  billId: string | null
}

/**
 * The OTHER outside carriers live on this bill's load. A load with several carriers has one
 * bill per carrier, all on one PRO; this is how a bill page links its siblings. Empty for a
 * single-carrier load (no chrome), and own-fleet legs are never siblings.
 */
export function siblingCarriers(
  loadCarriers: readonly Pick<LoadCarrierRecord, 'id' | 'loadId' | 'kind' | 'status' | 'carrierName' | 'invoiceId' | 'sequence'>[],
  bill: Pick<CarrierBillRecord, 'loadId' | 'loadCarrierId'>,
): SiblingCarrier[] {
  return loadCarriers
    .filter((lc) => lc.loadId === bill.loadId && lc.id !== bill.loadCarrierId && lc.kind === 'CARRIER' && lc.status === 'ACTIVE')
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id))
    .map((lc) => ({ loadCarrierId: lc.id, carrierName: lc.carrierName || 'Carrier', billId: lc.invoiceId ?? null }))
}

/** `loadId` -> how many distinct carrier legs the loaded worklists show for it. */
export type SharedProIndex = ReadonlyMap<string, number>

/**
 * Count the carrier legs per load across everything the page has read (awaiting rows plus
 * open and settled bills; a voided bill is not a leg). A count above one means the PRO is
 * shared. Only the loaded sets are seen, so it can undercount, never overcount.
 */
export function sharedProIndex(
  rows: readonly Pick<ApWorklistRow, 'loadId' | 'loadCarrierId'>[],
  bills: readonly Pick<CarrierBillRecord, 'loadId' | 'loadCarrierId' | 'status'>[],
): SharedProIndex {
  const legs = new Map<string, Set<string>>()
  const add = (loadId: string, loadCarrierId: string) => {
    const set = legs.get(loadId) ?? new Set<string>()
    set.add(loadCarrierId)
    legs.set(loadId, set)
  }
  for (const r of rows) add(r.loadId, r.loadCarrierId)
  for (const b of bills) if (b.status !== 'VOID') add(b.loadId, b.loadCarrierId)
  return new Map([...legs].map(([loadId, set]) => [loadId, set.size]))
}

/** `Shared PRO · 2 carriers` on a row whose load has a sibling carrier; null otherwise. */
export function sharedProLabel(index: SharedProIndex, loadId: string): string | null {
  const n = index.get(loadId) ?? 0
  return n > 1 ? `Shared PRO · ${n} carriers` : null
}
