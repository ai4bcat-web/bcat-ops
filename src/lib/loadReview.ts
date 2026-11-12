/**
 * Load Review — the pre-billing queue and its five-point checklist, as pure functions.
 *
 * A load enters the queue when it has delivered (or its POD is in ahead of delivery)
 * and has not been released to accounting. It leaves only when `READY_TO_INVOICE`
 * stamps it; a load that fails a check stays, with its reasons.
 *
 * `evaluateReleaseGate` (releaseGate.ts) is the authority for everything it knows
 * about. This file adds the three checks the gate does not own — sales rep, revenue
 * division and customer charges — and groups both under five headings.
 *
 * Imports are relative and alias-free: the Lambda bundles `loadReviewExtras` and
 * `loadReviewRefusal` so the server refuses on exactly the sentences the page shows.
 */
import type { ApStatus, ArStatus, AssignmentType, LoadWorkflowStatus, ShipmentBuildState, ShipmentStatus } from '../types/tms'
import {
  DEFAULT_REVIEW_REQUIREMENTS,
  evaluateReviewRequirements,
  profitFromFacts,
  type ReviewFacts,
  type ReviewRequirement,
} from './reviewRequirements'
import { aggregateApStatus } from './carrierTotals'
import { isReleasedToInvoicing } from './shipmentLists'
import {
  releaseGateError,
  type ReleaseGateReasonCode,
  type ReleaseGateResult,
  type ReleaseGateError,
} from './releaseGate'

export type LoadReviewCheckKey = 'salesRep' | 'revDivision' | 'details' | 'charges' | 'documents'

/** Fixed order everywhere: the dots on the list and the sections in the drawer. */
export const LOAD_REVIEW_CHECKS: readonly LoadReviewCheckKey[] = ['salesRep', 'revDivision', 'details', 'charges', 'documents']

export const LOAD_REVIEW_CHECK_LABEL: Record<LoadReviewCheckKey, string> = {
  salesRep: 'Sales rep',
  revDivision: 'Revenue division',
  details: 'Load details',
  charges: 'Charges',
  documents: 'Documents',
}

export type LoadReviewTab = 'overview' | 'stops' | 'carrier' | 'tracking' | 'documents' | 'financials' | 'carrierPay'

export type LoadReviewAction =
  | { kind: 'SET_SALES_REP' }
  | { kind: 'SET_REV_DIVISION' }
  | { kind: 'OPEN_TAB'; tab: LoadReviewTab }
  | { kind: 'OPEN_DOC_REVIEW' }

export interface LoadReviewReason {
  code: string
  message: string
  check: LoadReviewCheckKey
  action: LoadReviewAction | null
}

export interface LoadReviewCheckResult {
  ok: boolean
  reasons: LoadReviewReason[]
}

export interface LoadReviewVerdict {
  ok: boolean
  checks: Record<LoadReviewCheckKey, LoadReviewCheckResult>
  warnings: string[]
}

/** The stop fields the checklist reads; `Stop` from types/index is assignable. */
export interface LoadReviewStop {
  type?: string
  city?: string | null
  appt?: string | null
}

/** A structural subset of `ShipmentListRow`: passing the board rows type-checks. */
export interface LoadReviewRow {
  id: string
  number: string
  status: ShipmentStatus
  voidedAt?: string | null
  deletedAt?: string | null
  legacyImported?: boolean | null
  deliveredAt?: string | null
  loadStatus?: LoadWorkflowStatus | null
  arStatus?: ArStatus | null
  readyToInvoiceAt?: string | null
  invoiceId?: string | null
  customerId?: string | null
  buildState?: ShipmentBuildState | null
  salesRepId?: string | null
  revDivision?: string | null
  assignmentType?: AssignmentType | null
  apStatus?: ApStatus | null
  /** Every live carrier on the load (AT-plan); absent = read the single `apStatus`. */
  carriers?: { name?: string | null; apStatus?: ApStatus | null; costCents?: number | null }[] | null
  docsRequired?: string[] | null
  docsMissing?: string[] | null
  openIncidentCount?: number | null
  pendingDocReviewCount?: number | null
  stops?: readonly LoadReviewStop[] | null
  orderRevenueCents?: number | null
  revenueCents?: number | null
  costCents?: number | null
  /** Step AP. First order reference and the customer's reference, for the `referenceNumber` requirement. */
  reference?: string | null
  customerReference?: string | null
  loadReviewPushedAt?: string | null
}

/**
 * A load is in Load Review only once it has been released to review (the push stamp), as in Aljex: a delivered load is not in the
 * queue just because it is delivered. Not void, not released. Imported history qualifies when it was pushed (Ryne 2026-11-09).
 */
export function inLoadReviewQueue(row: LoadReviewRow): boolean {
  if (row.voidedAt || row.deletedAt || row.status === 'CANCELED') return false
  if (isReleasedToInvoicing(row)) return false
  return Boolean(row.loadReviewPushedAt)
}

/** The released half of the lookback: not legacy, not void, released within `days`. */
export function releasedWithin(row: LoadReviewRow, now: number, days = 14): boolean {
  if (row.legacyImported === true || row.voidedAt || row.deletedAt) return false
  if (!row.readyToInvoiceAt) return false
  const at = Date.parse(row.readyToInvoiceAt)
  return Number.isFinite(at) && now - at <= days * 86_400_000
}

/** Every gate code belongs to exactly one heading; a new code fails to compile until placed. */
export const GATE_CODE_CHECK: Record<ReleaseGateReasonCode, LoadReviewCheckKey> = {
  VOIDED: 'details',
  CANCELED: 'details',
  NOT_DELIVERED: 'details',
  DOC_MISSING: 'documents',
  REFERENCE_MISSING: 'details',
  CARRIER_NOT_ASSIGNED: 'details',
  DRIVER_MISSING: 'details',
  CARRIER_RATE_MISSING: 'charges',
  CARRIER_CHARGES_UNSETTLED: 'charges',
  OPEN_EXCEPTIONS: 'details',
}

const GATE_CODE_TAB: Record<ReleaseGateReasonCode, LoadReviewAction | null> = {
  VOIDED: null,
  CANCELED: null,
  NOT_DELIVERED: { kind: 'OPEN_TAB', tab: 'tracking' },
  DOC_MISSING: { kind: 'OPEN_TAB', tab: 'documents' },
  REFERENCE_MISSING: { kind: 'OPEN_TAB', tab: 'overview' },
  CARRIER_NOT_ASSIGNED: { kind: 'OPEN_TAB', tab: 'carrier' },
  DRIVER_MISSING: { kind: 'OPEN_TAB', tab: 'carrier' },
  CARRIER_RATE_MISSING: { kind: 'OPEN_TAB', tab: 'carrierPay' },
  CARRIER_CHARGES_UNSETTLED: { kind: 'OPEN_TAB', tab: 'carrierPay' },
  OPEN_EXCEPTIONS: { kind: 'OPEN_TAB', tab: 'tracking' },
}

function reason(code: string, message: string, check: LoadReviewCheckKey, action: LoadReviewAction | null): LoadReviewReason {
  return { code, message, check, action }
}

function blank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0
}

/** Where each requirement's failure is drawn and what the reviewer can click to fix it. */
const REQUIREMENT_PLACEMENT: Record<ReviewRequirement, { check: LoadReviewCheckKey; action: LoadReviewAction }> = {
  revDivision: { check: 'revDivision', action: { kind: 'SET_REV_DIVISION' } },
  salesRep: { check: 'salesRep', action: { kind: 'SET_SALES_REP' } },
  referenceNumber: { check: 'details', action: { kind: 'OPEN_TAB', tab: 'overview' } },
  podReceived: { check: 'documents', action: { kind: 'OPEN_TAB', tab: 'documents' } },
  revenueEntered: { check: 'charges', action: { kind: 'OPEN_TAB', tab: 'financials' } },
  expenseEntered: { check: 'charges', action: { kind: 'OPEN_TAB', tab: 'carrierPay' } },
  profitEntered: { check: 'charges', action: { kind: 'OPEN_TAB', tab: 'financials' } },
}

/** The facts the board row can state; unknown stays null and therefore fails. */
export function reviewFactsOfRow(row: LoadReviewRow): ReviewFacts {
  const revenueCents = row.orderRevenueCents ?? row.revenueCents ?? null
  const expenseCents = row.costCents ?? null
  return {
    revDivision: row.revDivision,
    salesRepId: row.salesRepId,
    referenceNumber: row.reference ?? row.customerReference ?? null,
    // `docsMissing` only speaks about the types the customer requires. When POD is not on that list
    // the row cannot say whether one is on file, so it is unknown (null), not "not received": the
    // server reads the real documents and decides (see pushRefusals).
    podReceived: !Array.isArray(row.docsMissing)
      ? null
      : row.docsRequired?.includes('POD') === true ? !row.docsMissing.includes('POD') : null,
    revenueCents,
    expenseCents,
    profitCents: profitFromFacts(revenueCents, expenseCents),
  }
}

/**
 * The checks the release gate does not own: the customer's Load Review requirements
 * (`resolveReviewRequirements`) evaluated by the one shared function. Run server-side
 * on review releases, pushes and `REVIEW_LOAD`, so the page, the push and the refusal
 * cannot disagree. Imported history is exempt (it cannot be queued; belt and braces).
 */
export function loadReviewExtras(input: {
  shipment: { legacyImported?: boolean | null }
  facts: ReviewFacts
  requirements?: readonly ReviewRequirement[]
}): LoadReviewReason[] {
  if (input.shipment.legacyImported === true) return []
  const { failures } = evaluateReviewRequirements(input.requirements ?? DEFAULT_REVIEW_REQUIREMENTS, input.facts)
  return failures.map((failure) => {
    const placement = REQUIREMENT_PLACEMENT[failure.requirement]
    return reason(failure.code, failure.message, placement.check, placement.action)
  })
}

/**
 * The refusal for a review release. The message starts with the release gate prefix
 * so `releaseGateMessages()` splits it into the same list the drawer draws.
 */
export function loadReviewRefusal(reasons: readonly Pick<LoadReviewReason, 'code' | 'message'>[]): ReleaseGateError {
  // `releaseGateError` joins messages under the shared prefix; the structured list
  // carries a loose code because extras are not gate codes.
  return releaseGateError(reasons.map((r) => ({ code: r.code as ReleaseGateReasonCode, detail: null, message: r.message })))
}

function emptyChecks(): Record<LoadReviewCheckKey, LoadReviewCheckResult> {
  return {
    salesRep: { ok: true, reasons: [] },
    revDivision: { ok: true, reasons: [] },
    details: { ok: true, reasons: [] },
    charges: { ok: true, reasons: [] },
    documents: { ok: true, reasons: [] },
  }
}

function stopSentences(stops: readonly LoadReviewStop[]): LoadReviewReason[] {
  const out: LoadReviewReason[] = []
  stops.forEach((stop, index) => {
    const n = index + 1
    const city = (stop.city ?? '').trim()
    const tab: LoadReviewAction = { kind: 'OPEN_TAB', tab: 'stops' }
    if (!city) {
      out.push(reason('STOP_INCOMPLETE', `Stop ${n} needs a city`, 'details', tab))
    } else if (!/,\s*[A-Za-z]{2}\b/.test(city)) {
      out.push(reason('STOP_INCOMPLETE', `Stop ${n} needs a state`, 'details', tab))
    }
    if (blank(stop.appt)) out.push(reason('STOP_INCOMPLETE', `Stop ${n} needs an appointment`, 'details', tab))
  })
  return out
}

/** What the cached row can say about the release gate; references and the driver rule it cannot see. */
function gateFromRow(row: LoadReviewRow): LoadReviewReason[] {
  const out: LoadReviewReason[] = []
  if (row.status !== 'DELIVERED') {
    out.push(reason('NOT_DELIVERED', `Not delivered yet (status ${row.status})`, 'details', GATE_CODE_TAB.NOT_DELIVERED))
  }
  if (row.docsMissing == null) {
    out.push(reason('DOCS_UNCHECKED', 'Documents not checked yet', 'documents', GATE_CODE_TAB.DOC_MISSING))
  } else {
    for (const type of row.docsMissing) {
      out.push(reason('DOC_MISSING', `Missing document: ${type}`, 'documents', GATE_CODE_TAB.DOC_MISSING))
    }
  }
  if (row.assignmentType == null || row.assignmentType === 'NEED_TO_COVER') {
    out.push(reason('CARRIER_NOT_ASSIGNED', 'No carrier or driver assigned', 'details', GATE_CODE_TAB.CARRIER_NOT_ASSIGNED))
  }
  const apStatus = row.carriers && row.carriers.length > 0
    ? aggregateApStatus(row.carriers.map((c, i) => ({ id: String(i), status: 'ACTIVE' as const, apStatus: c.apStatus })))
    : row.apStatus
  if (row.assignmentType === 'CARRIER' && (apStatus == null || apStatus === 'AWAITING_INVOICE')) {
    out.push(reason(
      'CARRIER_CHARGES_UNSETTLED',
      'Carrier charges not settled — record the carrier bill first',
      'charges',
      GATE_CODE_TAB.CARRIER_CHARGES_UNSETTLED,
    ))
  }
  const open = Math.max(0, Math.trunc(row.openIncidentCount ?? 0))
  if (open > 0) {
    out.push(reason('OPEN_EXCEPTIONS', `${open} open exception${open === 1 ? '' : 's'}`, 'details', GATE_CODE_TAB.OPEN_EXCEPTIONS))
  }
  return out
}

function gateReasons(gate: ReleaseGateResult): LoadReviewReason[] {
  return gate.missing.map((item) => reason(item.code, item.message, GATE_CODE_CHECK[item.code] ?? 'details', GATE_CODE_TAB[item.code] ?? null))
}

/**
 * The checklist for one load. With `gate` (the server's `evaluateReleaseGate`) the gate
 * half is authoritative; without it the verdict is derived from cached row fields and
 * is preliminary. `extras` (the server's `loadReviewExtras`) likewise replaces the
 * row-derived rep / division / charges answers when the drawer has them.
 */
export function evaluateLoadReview(input: {
  row: LoadReviewRow
  gate?: ReleaseGateResult | null
  extras?: readonly LoadReviewReason[] | null
  /** Caller's customer-resolution fact; defaults to "no customerId on the row". */
  customerUnresolved?: boolean
  revDivisionActive?: boolean
  /** The customer's resolved Load Review list; defaults to the built-in seven. */
  requirements?: readonly ReviewRequirement[]
}): LoadReviewVerdict {
  const { row, gate } = input
  const reasons: LoadReviewReason[] = gate ? gateReasons(gate) : gateFromRow(row)

  // The "load details" extras that neither gate nor server own.
  const openTab = (tab: LoadReviewTab): LoadReviewAction => ({ kind: 'OPEN_TAB', tab })
  const customerUnresolved = input.customerUnresolved ?? blank(row.customerId)
  if (customerUnresolved) reasons.push(reason('NO_CUSTOMER', 'No customer linked', 'details', openTab('overview')))
  if (row.buildState === 'BUILDING') reasons.push(reason('BUILDING', 'Still being built — required fields are missing', 'details', openTab('overview')))
  if (row.stops) reasons.push(...stopSentences(row.stops))
  if (row.arStatus == null) reasons.push(reason('NO_ORDER', 'No order on this shipment', 'details', null))

  if (input.extras) {
    reasons.push(...input.extras)
  } else {
    // The release gate (supplied or derived from the row) already owns POD; the
    // requirement list stays the same, the sentence is not said twice.
    reasons.push(...loadReviewExtras({
      shipment: { legacyImported: row.legacyImported },
      facts: reviewFactsOfRow(row),
      requirements: (input.requirements ?? DEFAULT_REVIEW_REQUIREMENTS).filter((key) => key !== 'podReceived'),
    }))
  }
  if (input.revDivisionActive === false && !blank(row.revDivision)) {
    reasons.push(reason('REV_DIVISION_INACTIVE', 'Revenue division is inactive', 'revDivision', { kind: 'SET_REV_DIVISION' }))
  }

  const checks = emptyChecks()
  for (const item of reasons) {
    checks[item.check].reasons.push(item)
    checks[item.check].ok = false
  }

  const warnings: string[] = []
  const revenue = row.orderRevenueCents ?? row.revenueCents ?? null
  const cost = row.costCents ?? null
  if (revenue != null && cost != null && cost > revenue) {
    warnings.push(`Cost exceeds revenue by $${Math.round((cost - revenue) / 100).toLocaleString('en-US')}`)
  }
  if ((row.pendingDocReviewCount ?? 0) > 0) {
    const n = row.pendingDocReviewCount as number
    warnings.push(`${n} carrier upload${n === 1 ? ' is' : 's are'} still awaiting review`)
  }

  return { ok: reasons.length === 0, checks, warnings }
}

/** Every failing reason in checklist order — what the "N to fix" chip counts. */
export function failingReasons(verdict: LoadReviewVerdict): LoadReviewReason[] {
  return LOAD_REVIEW_CHECKS.flatMap((key) => verdict.checks[key].reasons)
}

/** Queue rows that still need work or a click; used by the badge and the stat row. */
export function loadReviewCount(rows: readonly LoadReviewRow[]): number {
  let n = 0
  for (const row of rows) if (inLoadReviewQueue(row)) n += 1
  return n
}

/** Days since delivery (whole days, floor). Null when the row carries no delivery time. */
export function reviewAgeDays(row: Pick<LoadReviewRow, 'deliveredAt'>, now: number): number | null {
  if (!row.deliveredAt) return null
  const at = Date.parse(row.deliveredAt)
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.floor((now - at) / 86_400_000))
}
