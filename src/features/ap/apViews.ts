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
import { approvalReadiness, type ApprovalWarning } from '@/lib/carrierBill'
import { daysLate } from '@/lib/arAging'
import type { ApWorklistRow } from '@/hooks/useApWorklist'
import type {
  ApPayeeKind,
  ApPaymentKind,
  ApPaymentMethod,
  ApPaymentRecord,
  ApSettings,
  CarrierBillRecord,
  CarrierBillStatus,
  CarrierRecord,
  ShipmentDocumentType,
} from '@/types/tms'

export type ApTabKey = 'awaiting' | 'review' | 'to-pay' | 'paid' | 'payments' | 'aging'

export const AP_TABS: { key: ApTabKey; label: string }[] = [
  { key: 'awaiting', label: 'Awaiting invoice' },
  { key: 'review', label: 'In review' },
  { key: 'to-pay', label: 'To be paid' },
  { key: 'paid', label: 'Paid' },
  { key: 'payments', label: 'Payments & credits' },
  { key: 'aging', label: 'Aging' },
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

/** Bills on the review rung, oldest recorded first — the order the queue is worked. */
export function billsInReview(bills: readonly CarrierBillRecord[]): CarrierBillRecord[] {
  return bills
    .filter((b) => b.status === 'IN_REVIEW')
    .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)))
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
}

export const EMPTY_TO_BE_PAID_FILTERS: ToBePaidFilters = { carrierId: '', due: '', payeeKind: '' }

export function applyToBePaidFilters(
  bills: readonly CarrierBillRecord[],
  filters: ToBePaidFilters,
  asOf: string,
): CarrierBillRecord[] {
  return bills.filter((bill) => {
    if (filters.carrierId && bill.carrierId !== filters.carrierId) return false
    if (filters.payeeKind && bill.payeeKind !== filters.payeeKind) return false
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
  if (!row) return NO_GATES
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
