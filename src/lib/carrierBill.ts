/**
 * Carrier bills — everything that decides what we owe one carrier for one
 * assignment, before anything is written.
 *
 * Three rules shape this file:
 *
 * 1. **A bill belongs to one assignment, not to a load.** Every total here comes
 *    from that assignment's own CARRIER charge lines. A load that was TONU'd and
 *    rebooked carries both carriers' lines; paying off the load's cached cost would
 *    hand the second carrier the first one's money.
 * 2. **A bill is a snapshot.** Lines, terms, fee and remit-to are taken at
 *    RECORD_BILL and frozen onto the row. A mistake is voided and re-recorded,
 *    never edited — so nothing here reads a bill to decide what the bill says.
 * 3. **Money is integer cents.** The quick-pay deduction is applied in exactly one
 *    place, `billTotals`, and nothing here divides.
 *
 * Imports are relative: the `tmsFinanceActions` Lambda bundles this file by path and
 * the `@/` alias does not exist in the function build.
 */
import { agingBucket, daysLate } from './arAging'
import { dueDateFor } from './invoiceBuild'
import { DOCUMENT_TYPE_LABELS } from './shipmentDocuments'
import type { PlanApplication } from './paymentApply'
import type { AgingBucket } from './arAging'
import type {
  Address,
  ApPayeeKind,
  ApPaymentMethod,
  ApRemitTo,
  ApSettings,
  CarrierBillLine,
  CarrierBillRecord,
  CarrierPaymentMethodRecord,
  CarrierBillStatus,
  CarrierRecord,
  Division,
  DocGateResult,
  LoadCarrierRecord,
  LoadChargeRecord,
  ShipmentLoad,
  ShipmentRecord,
} from '../types/tms'

/** Net terms when neither the assignment, the carrier nor the org has said otherwise. */
const DEFAULT_CARRIER_TERMS_DAYS = 30

function positiveDays(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const days = Math.trunc(value)
  return days > 0 ? days : null
}

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text || null
}

/** Display only; the arithmetic around it is all integer cents. */
function money(cents: number): string {
  const negative = cents < 0
  const abs = Math.abs(Math.trunc(cents))
  const dollars = Math.floor(abs / 100)
  const remainder = abs - dollars * 100
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${grouped}.${String(remainder).padStart(2, '0')}`
}

/** A stored `Record<string, unknown>` address column, read as the address it is. */
function addressOf(value: Record<string, unknown> | null | undefined): Address | null {
  return value ? (value as Address) : null
}

export interface BillLineResult {
  lines: CarrierBillLine[]
  grossCents: number
}

/**
 * What one carrier alone is owed: their own CARRIER-side charge lines, in the order
 * the charges tab shows them.
 *
 * This is `carrierOwnCostCents` (`tms-shipment-actions/handler.ts`) as data. The
 * load's cached `costCents` is the whole load's and, after a TONU and a rebook,
 * still carries the retired carrier's retained line — never the basis for this
 * carrier's pay.
 */
export function billLinesFor(
  charges: readonly LoadChargeRecord[],
  loadCarrierId: string,
): BillLineResult {
  const mine = charges
    .filter((charge) => charge.side === 'CARRIER' && String(charge.loadCarrierId ?? '') === loadCarrierId)
    .slice()
    .sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const lines: CarrierBillLine[] = mine.map((charge) => ({
    chargeId: charge.id,
    code: charge.code,
    label: charge.label ?? null,
    calculatedBy: charge.calculatedBy,
    rateCents: charge.rateCents,
    count: typeof charge.count === 'number' && Number.isFinite(charge.count) ? charge.count : 1,
    amountCents: charge.amountCents,
  }))

  let grossCents = 0
  for (const line of lines) grossCents += line.amountCents
  return { lines, grossCents }
}

/**
 * How long the carrier waits. Quick pay wins outright: paying in two days *is* the
 * term, and the fee that was taken for it is the price of those two days. Below
 * that the assignment wins over the carrier, which wins over the org default. A
 * zero or a blank at any level is not an answer — it falls through.
 */
export function billTermsDays(
  loadCarrier: Pick<LoadCarrierRecord, 'quickPay' | 'quickPayDays' | 'paymentTermsDays'> | null | undefined,
  carrier: Pick<CarrierRecord, 'paymentTermsDays'> | null | undefined,
  settings: Pick<ApSettings, 'defaultCarrierTermsDays'> | null | undefined,
): number {
  const quickPayDays = loadCarrier?.quickPay === true ? positiveDays(loadCarrier.quickPayDays) : null
  return (
    quickPayDays ??
    positiveDays(loadCarrier?.paymentTermsDays) ??
    positiveDays(carrier?.paymentTermsDays) ??
    positiveDays(settings?.defaultCarrierTermsDays) ??
    DEFAULT_CARRIER_TERMS_DAYS
  )
}

/** `billDate` + `termsDays`, in UTC — the AR rule, because AP is read in days too. */
export function billDueDate(billDate: string, termsDays: number): string {
  return dueDateFor(billDate, termsDays)
}

export interface BillPayee {
  kind: ApPayeeKind
  paymentMethodId: string | null
  remitTo: ApRemitTo | null
}

/**
 * Where this carrier's money goes, as the bill will freeze it.
 *
 * The preferred method is the one somebody chose on purpose; the factor method named
 * on the carrier is next, because a factored carrier's own ACH is the account the
 * factor has already bought the receivable out of; a carrier with exactly one method
 * has made the choice by having no other. Anything ambiguous returns no payee and
 * approval refuses — guessing here sends money to the wrong bank.
 *
 * `bankDetailsKey` is never copied. The account itself stays in S3 behind the carrier
 * directory; a bill is read by everyone who can read the AP board.
 */
export function billPayee(
  carrier: Pick<CarrierRecord, 'name' | 'address' | 'email' | 'factorPaymentMethodId'> | null | undefined,
  methods: readonly CarrierPaymentMethodRecord[] | null | undefined,
): BillPayee {
  // `status` is absent on rows minted before the column existed, and those are live
  // methods: only an explicit INACTIVE retires one.
  const active = (methods ?? []).filter((method) => method.status !== 'INACTIVE')
  const factorMethodId = trimmed(carrier?.factorPaymentMethodId)
  const chosen =
    active.find((method) => method.isPreferred === true) ??
    (factorMethodId ? active.find((method) => method.id === factorMethodId) : undefined) ??
    (active.length === 1 ? active[0] : undefined)

  if (!chosen) return { kind: 'CARRIER', paymentMethodId: null, remitTo: null }

  const kind: ApPayeeKind = chosen.recipientType === 'FACTOR' ? 'FACTOR' : 'CARRIER'
  const factorName = trimmed(chosen.factorName)
  const carrierName = trimmed(carrier?.name) ?? ''
  const address =
    kind === 'FACTOR'
      ? addressOf(chosen.factorAddress) ?? addressOf(chosen.remitToAddress)
      : addressOf(chosen.remitToAddress) ?? addressOf(carrier?.address)

  return {
    kind,
    paymentMethodId: chosen.id,
    remitTo: {
      // A factor is paid in the factor's name. The carrier's name on a factored
      // check is a check the factor cannot deposit.
      name: kind === 'FACTOR' ? factorName ?? carrierName : carrierName,
      factorName,
      method: chosen.method as ApPaymentMethod,
      accountLast4: trimmed(chosen.accountLast4),
      payeeEmail: trimmed(chosen.payeeEmail) ?? (kind === 'FACTOR' ? null : trimmed(carrier?.email)),
      address,
    },
  }
}

export interface BillTotalsInput {
  grossCents: number
  loadCarrier: Pick<LoadCarrierRecord, 'quickPay' | 'quickPayFeeCents'> | null | undefined
  payeeKind: ApPayeeKind
}

export interface BillTotals {
  quickPayFeeCents: number
  netCents: number
}

/**
 * Gross less the quick-pay deduction. This is the only place in the system the fee is
 * applied: it is cached on the assignment at booking, snapshotted onto the bill here,
 * and never a CARRIER charge line.
 *
 * A factor is never discounted. The factor advanced the carrier their money on the
 * factor's own terms; taking our quick-pay fee out of the factor's remittance would
 * short an invoice they bought at face value.
 */
export function billTotals(input: BillTotalsInput): BillTotals {
  const grossCents = Math.trunc(input.grossCents)
  const onQuickPay = input.loadCarrier?.quickPay === true && input.payeeKind !== 'FACTOR'
  const cached = input.loadCarrier?.quickPayFeeCents
  const fee = onQuickPay && typeof cached === 'number' && Number.isFinite(cached) ? Math.trunc(cached) : 0
  const quickPayFeeCents = fee > 0 ? fee : 0
  const netCents = Math.max(0, grossCents - quickPayFeeCents)
  return { quickPayFeeCents, netCents }
}

export interface BillReadinessInput {
  loadCarrier: Pick<LoadCarrierRecord, 'id' | 'kind' | 'status' | 'invoiceId' | 'carrierId' | 'carrierName'>
  load: Pick<ShipmentLoad, 'id' | 'loadNumber'> | null | undefined
  /** The directory row behind `loadCarrier.carrierId`, when it resolves. */
  carrier: (Pick<CarrierRecord, 'id' | 'name'> & { mergedIntoId?: string | null }) | null | undefined
  charges: readonly LoadChargeRecord[]
  /** Every bill already recorded against this assignment, voided ones included. */
  existingBills: readonly Pick<CarrierBillRecord, 'id' | 'status' | 'billNumber'>[]
}

export interface BillReadiness {
  ready: boolean
  reasons: string[]
}

/**
 * Every reason this assignment cannot be billed, each a sentence somebody can act on.
 * Nothing short-circuits: a clerk who is told about the missing charges and then,
 * next attempt, that the leg is own-fleet has been made to work twice.
 */
export function billReadiness(input: BillReadinessInput): BillReadiness {
  const { loadCarrier, load, carrier, charges, existingBills } = input
  const reasons: string[] = []
  const legName = trimmed(load?.loadNumber) ? `Load ${trimmed(load?.loadNumber)}` : 'This assignment'

  if (loadCarrier.kind !== 'CARRIER') {
    reasons.push(
      `${legName} is an own-fleet leg; own-fleet legs are paid through driver settlements, not a carrier bill.`,
    )
  }

  if (loadCarrier.status !== 'ACTIVE' && loadCarrier.status !== 'TONU') {
    reasons.push(
      `This assignment is ${loadCarrier.status}; only an ACTIVE or TONU assignment can be billed.`,
    )
  }

  // The slot is `invoiceId` on the assignment, but the open bill is the truth: a
  // second bill on an assignment that already has one pays the same load twice.
  const openBill = existingBills.find((bill) => bill.status !== 'VOID')
  if (trimmed(loadCarrier.invoiceId) || openBill) {
    const which = openBill ? trimmed(openBill.billNumber) ?? openBill.id : trimmed(loadCarrier.invoiceId)
    reasons.push(`This assignment is already billed (${which}); void that bill before recording another.`)
  }

  const { grossCents } = billLinesFor(charges, loadCarrier.id)
  if (!(grossCents > 0)) {
    reasons.push('This assignment has no carrier charges to bill; add the carrier lines first.')
  }

  if (!carrier) {
    reasons.push(
      `${trimmed(loadCarrier.carrierName) ?? 'The carrier'} on this assignment is not in the carrier directory; it cannot be billed.`,
    )
  } else if (trimmed(carrier.mergedIntoId)) {
    reasons.push(
      `${trimmed(carrier.name) ?? 'This carrier'} has been merged into another directory record; bill the surviving carrier.`,
    )
  }

  return { ready: reasons.length === 0, reasons }
}

/** A warning an approver may acknowledge, keyed so the acknowledgement is recorded. */
export interface ApprovalWarning {
  key: string
  message: string
}

export interface ApprovalReadinessInput {
  bill: Pick<
    CarrierBillRecord,
    'status' | 'varianceCents' | 'billedCents' | 'grossCents' | 'recordedEarly' | 'docsOverrideAt'
  >
  loadCarrier: Pick<LoadCarrierRecord, 'status' | 'rateConStatus'>
  load: Pick<ShipmentLoad, 'id' | 'status' | 'loadNumber'> | null | undefined
  gate: Pick<DocGateResult, 'missing'> | null | undefined
  payee: BillPayee | null | undefined
  /** The directory row, for the status warning. Optional: a bill knows its own payee. */
  carrier?: Pick<CarrierRecord, 'name' | 'status'> | null
  settings: Pick<ApSettings, 'apRequireSignedRateCon'> | null | undefined
  isAdmin: boolean
}

export interface ApprovalReadiness {
  blocks: string[]
  warnings: ApprovalWarning[]
}

export const APPROVAL_WARNING_KEYS = {
  rateConUnsigned: 'RATE_CON_UNSIGNED',
  carrierDoNotUse: 'CARRIER_DO_NOT_USE',
  recordedEarly: 'RECORDED_EARLY',
} as const

/**
 * What stands between a recorded bill and TO_BE_PAID.
 *
 * Blocks refuse; warnings are acknowledged by key and kept on the bill as the record
 * of what was waved through and by whom. The split is the whole point of the review
 * stage: a bill whose amount does not match its lines is a mistake to fix, while a
 * carrier we have since blacklisted is a truck that already hauled the freight and is
 * owed for it.
 */
export function approvalReadiness(input: ApprovalReadinessInput): ApprovalReadiness {
  const { bill, loadCarrier, load, gate, payee, carrier, settings, isAdmin } = input
  const blocks: string[] = []
  const warnings: ApprovalWarning[] = []

  const delivered = load?.status === 'DELIVERED'
  const tonu = loadCarrier.status === 'TONU'
  const early = bill.recordedEarly === true
  const legName = trimmed(load?.loadNumber) ? `Load ${trimmed(load?.loadNumber)}` : 'This load'
  if (!delivered && !tonu && !early) {
    blocks.push(`${legName} has not delivered; a carrier is paid for freight that moved.`)
  } else if (!delivered && !tonu && early) {
    warnings.push({
      key: APPROVAL_WARNING_KEYS.recordedEarly,
      message: `${legName} has not delivered and this bill was recorded early; approving pays ahead of the freight.`,
    })
  }

  if (bill.varianceCents !== 0) {
    blocks.push(
      `The carrier's invoice is ${money(bill.billedCents)} but the charge lines total ${money(bill.grossCents)}; fix the lines or void the bill.`,
    )
  }

  const missing = gate?.missing ?? []
  if (missing.length > 0 && !bill.docsOverrideAt) {
    const labels = missing.map((type) => DOCUMENT_TYPE_LABELS[type] ?? type).join(', ')
    blocks.push(`Carrier paperwork is missing: ${labels}. Attach it or override the document gate.`)
  }

  if (!payee || !payee.remitTo) {
    blocks.push('This bill has no payee; set the carrier’s payment method before approving.')
  }

  // The signed rate con is a status, not a document: it is the contract that says
  // what we agreed to pay. Admins may approve without one and own the decision.
  if (settings?.apRequireSignedRateCon !== false && loadCarrier.rateConStatus !== 'SIGNED') {
    const message = 'The rate confirmation for this assignment is not signed; there is no signed agreement behind this amount.'
    if (isAdmin) warnings.push({ key: APPROVAL_WARNING_KEYS.rateConUnsigned, message })
    else blocks.push(message)
  }

  if (carrier?.status === 'DO_NOT_USE') {
    warnings.push({
      key: APPROVAL_WARNING_KEYS.carrierDoNotUse,
      message: `${trimmed(carrier.name) ?? 'This carrier'} is marked DO NOT USE; a truck that hauled the freight is still owed for it.`,
    })
  }

  return { blocks, warnings }
}

/**
 * Where a bill stands once money has moved against it.
 *
 * VOID is terminal — a voided bill that somehow receives a payment stays voided and
 * the payment is the thing to unwind. Otherwise a balance at or below zero is PAID
 * (an overpayment is still paid), any money at all applied is PARTIAL, and a bill
 * nobody has paid keeps the rung the review stage put it on.
 */
export function billStatusAfter(
  netCents: number,
  paidCents: number,
  creditedCents: number,
  prior: CarrierBillStatus,
): CarrierBillStatus {
  if (prior === 'VOID') return 'VOID'
  const applied = Math.trunc(paidCents) + Math.trunc(creditedCents)
  if (Math.trunc(netCents) - applied <= 0) return 'PAID'
  if (applied > 0) return 'PARTIAL'
  return prior
}

/**
 * Which bills a payment's credit slice paid for.
 *
 * The planner returns one `fromCreditsCents` for the whole payment, not a split: a
 * credit is money against the carrier, not against any one bill. The convention here
 * is first-application-first — the earlier applications absorb the credit until it is
 * gone. It decides only what a remittance line prints as "credit applied"; the cash
 * total, the bill balances and the credit's remaining balance are the same either way.
 */
export function apFundingSplit(
  applications: readonly PlanApplication[],
  fromCreditsCents: number,
): Record<string, number> {
  let remaining = Math.max(0, Math.trunc(fromCreditsCents))
  const split: Record<string, number> = {}
  for (const application of applications) {
    if (remaining <= 0) break
    const amount = Math.max(0, Math.trunc(application.amountCents))
    const take = Math.min(remaining, amount)
    if (take <= 0) continue
    split[application.documentId] = (split[application.documentId] ?? 0) + take
    remaining -= take
  }
  return split
}

export interface BillParty {
  name: string
  mcNumber?: string | null
  dotNumber?: string | null
  email?: string | null
  address?: Address | null
}

export interface BillPayeeView {
  kind: ApPayeeKind
  name: string
  factorName?: string | null
  method?: ApPaymentMethod | null
  accountLast4?: string | null
  payeeEmail?: string | null
  address?: Address | null
  paymentMethodId?: string | null
}

export interface BillTotalsView {
  grossCents: number
  quickPayFeeCents: number
  netCents: number
  billedCents: number
  varianceCents: number
  paidCents: number
  creditedCents: number
  balanceCents: number
}

export interface BillAgingView {
  dueAt: string
  /** The date the view was built for, YYYY-MM-DD. */
  asOf: string
  /** Whole days past due; negative before the due date. */
  daysLate: number
  bucket: AgingBucket
  /** Still owed: IN_REVIEW, TO_BE_PAID or PARTIAL. */
  open: boolean
  pastDue: boolean
}

/** What the AP card, the bill detail page and the remittance all read. Data, no JSX. */
export interface BillView {
  id: string
  loadCarrierId: string
  loadId: string
  shipmentId: string
  shipmentNumber?: string | null
  loadNumber?: string | null
  status: CarrierBillStatus
  billNumber?: string | null
  billDate: string
  billMonth: string
  dueAt: string
  termsDays: number
  quickPay: boolean
  quickPayDays?: number | null
  quickPayFeeBps?: number | null
  recordedAt: string
  recordedBy: string
  recordedEarly: boolean
  approvedAt?: string | null
  approvedBy?: string | null
  voidedAt?: string | null
  voidReason?: string | null
  documentId?: string | null
  note?: string | null
  broker: BillParty
  carrier: BillParty
  payee: BillPayeeView
  lines: CarrierBillLine[]
  totals: BillTotalsView
  aging: BillAgingView
}

export interface BillDataInput {
  bill: CarrierBillRecord
  bundle: {
    shipment?: Pick<ShipmentRecord, 'number'> | null
    loads?: readonly Pick<ShipmentLoad, 'id' | 'loadNumber'>[] | null
  }
  carrier?: Pick<CarrierRecord, 'name' | 'mcNumber' | 'dotNumber' | 'email' | 'address'> | null
  division?: Pick<Division, 'name' | 'legalName' | 'mcNumber' | 'dotNumber' | 'remitToAddress' | 'remitToEmail'> | null
  /** YYYY-MM-DD the aging is read on; today in UTC when the caller does not say. */
  asOf?: string | null
}

const OPEN_BILL_STATUS: Partial<Record<CarrierBillStatus, true>> = {
  IN_REVIEW: true,
  TO_BE_PAID: true,
  PARTIAL: true,
}

/**
 * One bill as every AP surface reads it.
 *
 * The snapshot wins everywhere it exists: a carrier renamed or a method retired six
 * months after the fact must not change what a bill we already paid says it paid, so
 * the directory row is only a fallback for a field the snapshot never carried.
 */
export function billData(input: BillDataInput): BillView {
  const { bill, bundle, carrier, division } = input
  const asOf = trimmed(input.asOf)?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)
  const remitTo = bill.remitTo ?? null
  const loadNumber =
    trimmed(bill.loadNumber) ??
    trimmed((bundle.loads ?? []).find((load) => load.id === bill.loadId)?.loadNumber)
  const open = OPEN_BILL_STATUS[bill.status] === true
  const late = daysLate(bill.dueAt, asOf)

  return {
    id: bill.id,
    loadCarrierId: bill.loadCarrierId,
    loadId: bill.loadId,
    shipmentId: bill.shipmentId,
    shipmentNumber: trimmed(bill.shipmentNumber) ?? trimmed(bundle.shipment?.number),
    loadNumber,
    status: bill.status,
    billNumber: trimmed(bill.billNumber),
    billDate: bill.billDate,
    billMonth: bill.billMonth,
    dueAt: bill.dueAt,
    termsDays: bill.termsDays,
    quickPay: bill.quickPay === true,
    quickPayDays: bill.quickPayDays ?? null,
    quickPayFeeBps: bill.quickPayFeeBps ?? null,
    recordedAt: bill.recordedAt,
    recordedBy: bill.recordedBy,
    recordedEarly: bill.recordedEarly === true,
    approvedAt: bill.approvedAt ?? null,
    approvedBy: bill.approvedBy ?? null,
    voidedAt: bill.voidedAt ?? null,
    voidReason: trimmed(bill.voidReason),
    documentId: bill.documentId ?? null,
    note: trimmed(bill.note),
    broker: {
      name: trimmed(division?.name) ?? trimmed(division?.legalName) ?? '',
      mcNumber: trimmed(division?.mcNumber),
      dotNumber: trimmed(division?.dotNumber),
      email: trimmed(division?.remitToEmail),
      address: division?.remitToAddress ?? null,
    },
    carrier: {
      name: trimmed(bill.carrierName) ?? trimmed(carrier?.name) ?? '',
      mcNumber: trimmed(bill.carrierMc) ?? trimmed(carrier?.mcNumber),
      dotNumber: trimmed(carrier?.dotNumber),
      email: trimmed(carrier?.email),
      address: addressOf(carrier?.address),
    },
    payee: {
      kind: bill.payeeKind,
      name: trimmed(remitTo?.name) ?? trimmed(bill.carrierName) ?? trimmed(carrier?.name) ?? '',
      factorName: trimmed(remitTo?.factorName),
      method: remitTo?.method ?? null,
      accountLast4: trimmed(remitTo?.accountLast4),
      payeeEmail: trimmed(remitTo?.payeeEmail),
      address: remitTo?.address ?? null,
      paymentMethodId: bill.paymentMethodId ?? null,
    },
    lines: bill.lines ?? [],
    totals: {
      grossCents: bill.grossCents,
      quickPayFeeCents: bill.quickPayFeeCents,
      netCents: bill.netCents,
      billedCents: bill.billedCents,
      varianceCents: bill.varianceCents,
      paidCents: bill.paidCents,
      creditedCents: bill.creditedCents,
      balanceCents: bill.balanceCents,
    },
    aging: {
      dueAt: bill.dueAt,
      asOf,
      daysLate: late,
      bucket: agingBucket(bill.dueAt, asOf),
      open,
      pastDue: open && late > 0,
    },
  }
}
