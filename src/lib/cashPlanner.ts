/**
 * The Cash planner (Ryne 2026-11-18): he types what is in each bank account and what he owes outside the
 * payables, and this says what to pay this week and what can wait. It is a fixed set of rules, written out
 * on the page, not advice: the same numbers always give the same list.
 *
 * Who pays what. Every carrier bill is a brokerage bill, so it comes out of BCAT's account. Vendor bills
 * (truck leasing, repairs, parts), driver settlements, the card and any other obligation come out of Ivan's.
 *
 * Rules, in the order they are applied:
 *  - "This week" means the next pay Friday (today, when today is a Friday). A bill is in it when it is past due
 *    or due on or before that Friday. Everything else can wait.
 *  - Only an approved bill (To be paid, Partly paid) can be paid. A bill still In review is listed as "approve
 *    first": it takes none of the cash.
 *  - BCAT: cash plus anything moved over from Ivan, less the buffer, is what can be spent. Bills are taken oldest
 *    due date first and paid whole. A bill that does not fit is skipped, and a smaller, later one may still fit.
 *  - Ivan: driver settlements go first and are always paid (they are payroll-like), even if that dips under the
 *    buffer. Then vendor bills (oldest due first), other obligations and the card, each only while cash stays at or
 *    above the buffer. The card is paid down by whatever is left, up to its balance.
 *  - Whatever Ivan has above its buffer after all of that is what it could move to BCAT. Moving it is the owner's
 *    call; the planner only uses the amount typed in.
 *
 * Money in is not counted (customer payments this week would let BCAT pay more), and Ivan's day-to-day costs are
 * covered only by its buffer. Pure: no store, no network.
 */
import { fridayOnOrAfter } from '@/features/ap/cashFridays'
import { findVendorApDuplicates } from '@/lib/vendorApDuplicates'
import type { VendorPayable } from '@/types/vendorAp'

export interface PlannerInputs {
  /** Dollars, as typed. */
  bcatCash: number
  ivanCash: number
  bcatBuffer: number
  ivanBuffer: number
  /** Ivan: driver settlements owed. */
  driverSettlements: number
  /** Ivan: credit card balance and its APR in percent (null when not known). */
  cardBalance: number
  cardApr: number | null
  /** Ivan: anything else due this week. */
  otherObligations: number
  /** Moved from Ivan to BCAT before paying carriers. */
  transfer: number
}

export const DEFAULT_PLANNER_INPUTS: PlannerInputs = {
  bcatCash: 0,
  ivanCash: 0,
  bcatBuffer: 5_000,
  ivanBuffer: 20_000,
  driverSettlements: 0,
  cardBalance: 0,
  cardApr: null,
  otherObligations: 0,
  transfer: 0,
}

/** What the planner needs of a carrier bill. */
export interface PlannerBill {
  id: string
  pro: string
  carrier: string
  /** Who is paid: the carrier, or its factor. */
  payee: string
  /** YYYY-MM-DD. */
  dueAt: string
  balanceCents: number
  status: 'IN_REVIEW' | 'TO_BE_PAID' | 'PARTIAL'
  /** Waiting on the carrier's invoice date: no due date to plan on. */
  datesPending: boolean
}

export type PlanAction = 'pay' | 'wait-cash' | 'approve' | 'later'

export interface PlanBillRow {
  bill: PlannerBill
  action: PlanAction
  daysLate: number
  reason: string
}

export interface BcatPlan {
  payFriday: string
  /** Cash less the buffer, plus the transfer; never below zero. */
  availableCents: number
  pay: PlanBillRow[]
  /** Due by the Friday and approved, but the cash ran out. */
  unpaid: PlanBillRow[]
  /** Due by the Friday but still In review. */
  approve: PlanBillRow[]
  /** Approved, due after the Friday. */
  later: PlanBillRow[]
  /** In review, no invoice date yet. */
  notScheduled: PlannerBill[]
  /** Approved and due by the Friday: what this week asks for. */
  dueByFridayCents: number
  pastDueCents: number
  payCents: number
  /** Cash left of the spendable amount. */
  spareCents: number
  unpaidCents: number
}

export const cents = (dollars: number): number => Math.round((Number.isFinite(dollars) ? dollars : 0) * 100)

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000)

export function planBcat(bills: readonly PlannerBill[], cashCents: number, bufferCents: number, transferCents: number, today: string): BcatPlan {
  const payFriday = fridayOnOrAfter(today)
  const availableCents = Math.max(0, cashCents + transferCents - bufferCents)
  const open = bills.filter((b) => b.balanceCents > 0)
  const approved: PlannerBill[] = []
  const approve: PlanBillRow[] = []
  const notScheduled: PlannerBill[] = []
  const later: PlanBillRow[] = []
  const row = (bill: PlannerBill, action: PlanAction, reason: string): PlanBillRow => ({ bill, action, daysLate: Math.max(0, daysBetween(bill.dueAt, today)), reason })

  for (const b of open) {
    if (b.status === 'IN_REVIEW' && (b.datesPending || !b.dueAt)) { notScheduled.push(b); continue }
    if (b.dueAt > payFriday) {
      later.push(row(b, 'later', b.status === 'IN_REVIEW' ? 'Due after this Friday and still In review' : 'Due after this Friday'))
      continue
    }
    if (b.status === 'IN_REVIEW') { approve.push(row(b, 'approve', 'Approve it first; it cannot be paid while In review')); continue }
    approved.push(b)
  }
  const byDue = (a: PlanBillRow, b: PlanBillRow) => a.bill.dueAt.localeCompare(b.bill.dueAt) || a.bill.pro.localeCompare(b.bill.pro, undefined, { numeric: true })
  approve.sort(byDue)
  later.sort(byDue)

  const queue = approved.map((b) => row(b, 'pay', '')).sort(byDue)
  let left = availableCents
  const pay: PlanBillRow[] = []
  const unpaid: PlanBillRow[] = []
  let pastDueCents = 0
  let dueByFridayCents = 0
  for (const r of queue) {
    dueByFridayCents += r.bill.balanceCents
    if (r.bill.dueAt < today) pastDueCents += r.bill.balanceCents
    const late = r.daysLate > 0 ? `${r.daysLate} day${r.daysLate === 1 ? '' : 's'} past due` : 'due this week'
    if (r.bill.balanceCents <= left) {
      left -= r.bill.balanceCents
      pay.push({ ...r, action: 'pay', reason: `Pay: ${late}, oldest first` })
    } else {
      unpaid.push({ ...r, action: 'wait-cash', reason: `Not enough cash left for the whole bill (${late})` })
    }
  }
  const sum = (rs: readonly PlanBillRow[]) => rs.reduce((n, r) => n + r.bill.balanceCents, 0)
  return {
    payFriday,
    availableCents,
    pay,
    unpaid,
    approve,
    later,
    notScheduled,
    dueByFridayCents,
    pastDueCents,
    payCents: sum(pay),
    spareCents: left,
    unpaidCents: sum(unpaid),
  }
}

/** A vendor bill the planner can price. */
export interface PlannerVendorBill {
  id: string
  vendor: string
  invoiceNumber: string
  /** YYYY-MM-DD, or '' when the invoice gives none. */
  dueDate: string
  amountCents: number
}

export interface VendorSplit {
  /** NEED_TO_PAY with an amount, once each. */
  priced: PlannerVendorBill[]
  /** NEED_TO_PAY rows that repeat another row (same vendor and invoice, or amount and date). */
  duplicates: VendorPayable[]
  /** NEED_TO_PAY rows with no amount yet. */
  unpriced: VendorPayable[]
}

export function splitVendorBills(items: readonly VendorPayable[]): VendorSplit {
  const open = items.filter((i) => i.status === 'NEED_TO_PAY')
  const dupes = findVendorApDuplicates(open)
  const priced: PlannerVendorBill[] = []
  const duplicates: VendorPayable[] = []
  const unpriced: VendorPayable[] = []
  for (const it of open) {
    if (dupes.has(it.id)) { duplicates.push(it); continue }
    if (it.amount == null || it.amount <= 0) { unpriced.push(it); continue }
    priced.push({ id: it.id, vendor: (it.vendor ?? '').trim() || it.subject, invoiceNumber: (it.invoiceNumber ?? '').trim(), dueDate: it.dueDate ?? '', amountCents: it.amount })
  }
  priced.sort((a, b) => (a.dueDate || '0000').localeCompare(b.dueDate || '0000') || a.vendor.localeCompare(b.vendor))
  return { priced, duplicates, unpriced }
}

export interface IvanLine {
  key: 'settlements' | 'vendor' | 'other' | 'card'
  label: string
  detail: string
  cents: number
  action: 'pay' | 'wait-cash' | 'partial'
  reason: string
}

export interface IvanPlan {
  availableCents: number
  lines: IvanLine[]
  paidCents: number
  /** Cash after everything above. */
  remainingCents: number
  /** What is left above the buffer: what Ivan could move to BCAT. */
  spareAboveBufferCents: number
  belowBuffer: boolean
}

export function planIvan(inputs: PlannerInputs, vendor: readonly PlannerVendorBill[], today: string): IvanPlan {
  const cash = cents(inputs.ivanCash)
  const buffer = cents(inputs.ivanBuffer)
  const transfer = cents(inputs.transfer)
  const lines: IvanLine[] = []
  let left = cash - transfer
  const settlements = cents(inputs.driverSettlements)
  if (settlements > 0) {
    left -= settlements
    lines.push({ key: 'settlements', label: 'Driver settlements', detail: 'Owed to drivers', cents: settlements, action: 'pay', reason: 'Paid first, always: payroll-like' })
  }
  // The moment the buffer is checked for everything below: cash after the settlements, less the buffer.
  let room = Math.max(0, left - buffer)
  for (const v of vendor) {
    const late = v.dueDate && v.dueDate < today ? `${daysBetween(v.dueDate, today)} days past due` : v.dueDate ? `due ${v.dueDate}` : 'no due date on the invoice'
    const label = `${v.vendor}${v.invoiceNumber ? ` #${v.invoiceNumber}` : ''}`
    if (v.amountCents <= room) {
      room -= v.amountCents
      left -= v.amountCents
      lines.push({ key: 'vendor', label, detail: v.dueDate || '—', cents: v.amountCents, action: 'pay', reason: `Pay: ${late}` })
    } else {
      lines.push({ key: 'vendor', label, detail: v.dueDate || '—', cents: v.amountCents, action: 'wait-cash', reason: `Not enough cash above the buffer (${late})` })
    }
  }
  const other = cents(inputs.otherObligations)
  if (other > 0) {
    if (other <= room) {
      room -= other
      left -= other
      lines.push({ key: 'other', label: 'Other obligations', detail: 'Typed in', cents: other, action: 'pay', reason: 'Pay: you listed it as due this week' })
    } else {
      lines.push({ key: 'other', label: 'Other obligations', detail: 'Typed in', cents: other, action: 'wait-cash', reason: 'Not enough cash above the buffer' })
    }
  }
  const card = cents(inputs.cardBalance)
  if (card > 0) {
    const apr = inputs.cardApr != null && inputs.cardApr > 0 ? `${inputs.cardApr}% APR` : 'APR not given'
    const pay = Math.min(card, room)
    if (pay >= card) {
      left -= card
      lines.push({ key: 'card', label: 'Credit card', detail: apr, cents: card, action: 'pay', reason: 'Pay in full: card interest is usually the dearest money you owe' })
    } else if (pay > 0) {
      left -= pay
      lines.push({ key: 'card', label: 'Credit card', detail: apr, cents: pay, action: 'partial', reason: `Pay ${(pay / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} of ${(card / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}: all the cash above the buffer` })
    } else {
      lines.push({ key: 'card', label: 'Credit card', detail: apr, cents: 0, action: 'wait-cash', reason: 'No cash above the buffer after the items above' })
    }
  }
  const paidCents = lines.filter((l) => l.action !== 'wait-cash').reduce((n, l) => n + l.cents, 0)
  return {
    availableCents: Math.max(0, cash - transfer - buffer),
    lines,
    paidCents,
    remainingCents: left,
    spareAboveBufferCents: Math.max(0, left - buffer),
    belowBuffer: left < buffer,
  }
}

export interface PlannerResult {
  bcat: BcatPlan
  ivan: IvanPlan
  vendors: VendorSplit
  /** A further amount Ivan could move to BCAT, rounded down to $100 and no more than BCAT is still short. */
  suggestedTransferCents: number
}

export function buildCashPlan(
  inputs: PlannerInputs,
  bills: readonly PlannerBill[],
  vendorItems: readonly VendorPayable[],
  today: string,
): PlannerResult {
  const vendors = splitVendorBills(vendorItems)
  const ivan = planIvan(inputs, vendors.priced, today)
  const bcat = planBcat(bills, cents(inputs.bcatCash), cents(inputs.bcatBuffer), cents(inputs.transfer), today)
  // Both plans already count the transfer typed in, so this is the further amount Ivan could move.
  const suggestedTransferCents = Math.floor(Math.min(ivan.spareAboveBufferCents, bcat.unpaidCents) / 10_000) * 10_000
  return { bcat, ivan, vendors, suggestedTransferCents }
}


/** What the boxes show: the numbers as typed, so a half-typed "1,2" is not rewritten under the cursor. */
export type PlannerFields = Record<keyof PlannerInputs, string>

export const PLANNER_FIELD_KEYS: (keyof PlannerInputs)[] = ['bcatCash', 'ivanCash', 'bcatBuffer', 'ivanBuffer', 'driverSettlements', 'cardBalance', 'cardApr', 'otherObligations', 'transfer']

/** A typed amount: "$1,250.50" reads as 1250.5; anything else reads as nothing. */
export function readAmount(text: string): number {
  const n = Number(text.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function readInputs(f: PlannerFields): PlannerInputs {
  const apr = readAmount(f.cardApr)
  return {
    bcatCash: readAmount(f.bcatCash),
    ivanCash: readAmount(f.ivanCash),
    bcatBuffer: readAmount(f.bcatBuffer),
    ivanBuffer: readAmount(f.ivanBuffer),
    driverSettlements: readAmount(f.driverSettlements),
    cardBalance: readAmount(f.cardBalance),
    cardApr: apr > 0 ? apr : null,
    otherObligations: readAmount(f.otherObligations),
    transfer: readAmount(f.transfer),
  }
}
