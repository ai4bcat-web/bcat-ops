/**
 * The release-to-accounting gate — Ryne's hard rule, as one pure function.
 *
 * A shipment reaches AR only when it has actually delivered, the paperwork the
 * customer bills on is in hand, the references they pay against are filled, the
 * cost of moving it is recorded, and nothing is still open on it. Every path that
 * moves money — READY_TO_INVOICE, PREVIEW_INVOICE, GENERATE_INVOICE,
 * BATCH_GENERATE, PREVIEW_FACTOR, SEND_TO_FACTOR — runs this, server-side, from
 * rows it read itself. There is no override: an admin flag that admits a missing
 * POD is a gate that does not exist.
 *
 * Every reason carries the exact sentence the UI shows, so the browser renders the
 * list rather than re-deriving it, and the Lambda's refusal and the page's warning
 * can never disagree about why.
 *
 * Imports nothing: the two routers bundle this file by relative path.
 */

export type ReleaseGateReasonCode =
  | 'VOIDED'
  | 'CANCELED'
  | 'NOT_DELIVERED'
  | 'DOC_MISSING'
  | 'REFERENCE_MISSING'
  | 'CARRIER_NOT_ASSIGNED'
  | 'CARRIER_CHARGES_UNSETTLED'
  | 'OPEN_EXCEPTIONS'

export interface ReleaseGateReason {
  code: ReleaseGateReasonCode
  /** The one value the sentence is about: a document type, a reference code, a carrier. */
  detail: string | null
  /** The exact sentence the UI shows. */
  message: string
}

export interface ReleaseGateShipment {
  status: string | null
  voidedAt?: string | null
  /** Pre-R soft deletes. A deleted shipment is as gone as a voided one. */
  deletedAt?: string | null
}

export interface ReleaseGateOrderReference {
  code: string
  value?: string | null
}

export interface ReleaseGateOrder {
  arStatus: string | null
  references: ReleaseGateOrderReference[] | null
  invoiceId?: string | null
}

export interface ReleaseGateDocument {
  type: string
  status?: string | null
  voidedAt?: string | null
  reviewStatus?: string | null
  audience?: string | null
}

export interface ReleaseGateLeg {
  kind: 'OWN_ASSET' | 'CARRIER'
  status: string | null
  carrierName?: string | null
  chargesFinalizedAt?: string | null
  /**
   * The rate confirmation is derived, not filed: it counts as paperwork once the
   * carrier signed it (`shipmentDocuments.presentDocTypes`), which is the same rule
   * the Documents tab and the cached gate use.
   */
  rateConStatus?: string | null
}

export interface ReleaseGateInput {
  shipment: ReleaseGateShipment
  /**
   * `arStatus` and `invoiceId` are the caller's business — which rung an order may
   * move to is the router's rule, not this gate's. They travel with the input so a
   * caller never has to read the order twice.
   */
  order: ReleaseGateOrder
  /** The customer's list (or the org default); BOL, POD and RATE_CON are added here. */
  requiredDocTypes: string[]
  requiredReferenceCodes: string[]
  /** `PO` → `PO number`, when the customer's required-references config names one. */
  referenceLabels?: Record<string, string> | null
  documents: ReleaseGateDocument[]
  legs: ReleaseGateLeg[]
  openIncidentCount: number
}

export interface ReleaseGateResult {
  ok: boolean
  missing: ReleaseGateReason[]
}

/** Every refusal message starts with this, so one client parse covers every path. */
export const RELEASE_GATE_ERROR_PREFIX = 'Not ready for accounting'

/**
 * The two document types nobody bills without, whatever the customer's list says.
 * A customer may ask for less than the org default; they may not ask for less than
 * the bill of lading and the proof that it was delivered.
 */
const ALWAYS_REQUIRED_DOC_TYPES = ['BOL', 'POD']

/** Eight call sites build this shape; they stay in lockstep through here. */
function reason(code: ReleaseGateReasonCode, detail: string | null, message: string): ReleaseGateReason {
  return { code, detail, message }
}

/** An ACTIVE row nobody voided, nobody is still reviewing and nobody refused. */
function countsAsPresent(doc: ReleaseGateDocument): boolean {
  if ((doc.status ?? 'ACTIVE') !== 'ACTIVE') return false
  if (doc.voidedAt) return false
  return doc.reviewStatus !== 'PENDING' && doc.reviewStatus !== 'REJECTED'
}

/**
 * What this order has to show before it may be billed: the customer's list, the
 * two that are never optional, and the rate confirmation once somebody else's
 * truck is on the load.
 */
export function requiredDocTypesForRelease(requiredDocTypes: string[], legs: ReleaseGateLeg[]): string[] {
  const hasCarrierLeg = legs.some((leg) => leg.status === 'ACTIVE' && leg.kind === 'CARRIER')
  const out: string[] = []
  for (const type of [...requiredDocTypes, ...ALWAYS_REQUIRED_DOC_TYPES, ...(hasCarrierLeg ? ['RATE_CON'] : [])]) {
    const trimmed = typeof type === 'string' ? type.trim() : ''
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * Why this order may not go to accounting, in the order a person would read them.
 *
 * A voided or canceled shipment short-circuits: it is not a list of chores, it is
 * a shipment that is not going to be billed at all. Everything else accumulates,
 * so one trip to the Documents tab can fix all of it.
 */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const { shipment, order, documents, legs } = input

  if (shipment.voidedAt || shipment.deletedAt) {
    return { ok: false, missing: [reason('VOIDED', null, 'Voided shipment')] }
  }
  if (shipment.status === 'CANCELED') {
    return { ok: false, missing: [reason('CANCELED', null, 'Canceled shipment')] }
  }

  const missing: ReleaseGateReason[] = []

  if (shipment.status !== 'DELIVERED') {
    const status = shipment.status ?? 'unset'
    missing.push(reason('NOT_DELIVERED', status, `Not delivered yet (status ${status})`))
  }

  const present = new Set<string>()
  for (const doc of documents) {
    if (countsAsPresent(doc)) present.add(doc.type)
  }
  if (legs.some((leg) => leg.status === 'ACTIVE' && leg.kind === 'CARRIER' && leg.rateConStatus === 'SIGNED')) {
    present.add('RATE_CON')
  }
  for (const type of requiredDocTypesForRelease(input.requiredDocTypes, legs)) {
    if (!present.has(type)) missing.push(reason('DOC_MISSING', type, `Missing document: ${type}`))
  }

  const references = order.references ?? []
  for (const code of input.requiredReferenceCodes) {
    const filled = references.some(
      (ref) => ref.code === code && typeof ref.value === 'string' && ref.value.trim().length > 0,
    )
    if (filled) continue
    const label = input.referenceLabels?.[code]?.trim()
    missing.push(reason('REFERENCE_MISSING', code, `Missing reference: ${label || code}`))
  }

  const active = legs.filter((leg) => leg.status === 'ACTIVE')
  if (active.length === 0) {
    missing.push(reason('CARRIER_NOT_ASSIGNED', null, 'No carrier or driver assigned'))
  }
  // An own-asset leg is already recorded: its cost is a driver settlement, and it
  // never enters AP. Somebody else's truck has to have a bill against it first.
  for (const leg of active) {
    if (leg.kind !== 'CARRIER' || leg.chargesFinalizedAt) continue
    const carrier = leg.carrierName?.trim() || 'the carrier'
    missing.push(
      reason(
        'CARRIER_CHARGES_UNSETTLED',
        leg.carrierName ?? null,
        `Carrier charges not settled: ${carrier} — record the carrier bill first`,
      ),
    )
  }

  const open = Number.isFinite(input.openIncidentCount) ? Math.max(0, Math.trunc(input.openIncidentCount)) : 0
  if (open > 0) {
    missing.push(reason('OPEN_EXCEPTIONS', String(open), `${open} open exception${open === 1 ? '' : 's'}`))
  }

  return { ok: missing.length === 0, missing }
}

/**
 * The refusal both routers throw. AppSync carries only the message to the browser,
 * so the sentences are joined into it; the structured list rides on the error for
 * anything inside the Lambda that reports rather than rethrows (BATCH_GENERATE).
 */
export interface ReleaseGateError extends Error {
  releaseGate: ReleaseGateResult
}

export function releaseGateError(missing: ReleaseGateReason[]): ReleaseGateError {
  const err = new Error(
    `${RELEASE_GATE_ERROR_PREFIX}: ${missing.map((item) => item.message).join('; ')}`,
  ) as ReleaseGateError
  err.releaseGate = { ok: false, missing }
  return err
}

/** The structured list behind a refusal, when there is one. */
export function releaseGateOf(err: unknown): ReleaseGateResult | null {
  if (!err || typeof err !== 'object' || !('releaseGate' in err)) return null
  const candidate = err.releaseGate
  if (!candidate || typeof candidate !== 'object') return null
  if (!('missing' in candidate) || !Array.isArray(candidate.missing)) return null
  if (!('ok' in candidate) || typeof candidate.ok !== 'boolean') return null
  return { ok: candidate.ok, missing: candidate.missing as ReleaseGateReason[] }
}
