/**
 * Whether we may put this carrier on this load, and what the booker should know.
 *
 * Two kinds of answer. A block is a refusal: the carrier is barred, the authority is
 * gone, the insurance does not cover the pickup date, the load is already covered.
 * A warning is something the booker acknowledges and books anyway, and what they
 * acknowledged is stored on the assignment.
 *
 * Three findings sit on the line between the two — cargo value over the insurance
 * limit, no cargo insurance at all, and a rate over the load's top spend. Those
 * block anybody who is not an admin; for an admin they come back as warnings marked
 * `adminOnly`, so the UI can say who is allowed to wave this through. A non-admin
 * may never acknowledge one.
 *
 * Insurance is judged against the pickup, not against today: a certificate that
 * lapses the morning of the pickup does not cover the load. Nothing here writes.
 *
 * Imports are relative: the tmsShipmentActions Lambda bundles this file by path for
 * its booking actions, so a `@/` alias would break the function build.
 */
import { effectiveCarrierStatus } from './carrierStatus'
import type {
  CarrierDocumentRecord,
  CarrierDocumentType,
  CarrierRecord,
  InsurancePolicy,
  InsurancePolicyType,
  TmsSettings,
} from '../types/tms'

export type BookingReason =
  | 'STATUS_NOT_ALLOWED'
  | 'DO_NOT_USE'
  | 'AUTHORITY_INACTIVE'
  | 'ALREADY_COVERED'
  | 'NEGATIVE_CARRIER_CHARGE'
  | 'INSURANCE_EXPIRED'
  | 'CARGO_VALUE_EXCEEDS_INSURANCE'
  | 'INSURANCE_UNVERIFIED'
  | 'COST_EXCEEDS_TOP_SPEND'
  | 'INSURANCE_EXPIRING'
  | 'MISSING_DOC'
  | 'DOC_EXPIRED'
  | 'MISSING_REQUIRED_FIELD'
  | 'DOUBLE_BOOKED'

export interface BookingFinding {
  reason: BookingReason
  /** Stable machine key, unique within a result: `${reason}` or `${reason}:${subject}` (e.g. 'MISSING_DOC:W9'). */
  key: string
  /** One-sentence human explanation shown in the UI and stored in bookingWarnings. */
  detail: string
  /** True when this finding is only a warning because the caller is an admin. A non-admin may never acknowledge it. */
  adminOnly: boolean
}

export interface CarrierBookingInput {
  carrier: CarrierRecord
  documents: CarrierDocumentRecord[]
  load: {
    id: string
    pickupAppt?: string | null
    commodity?: string | null
    weight?: number | null
    cargoValueCents?: number | null
    freightDescription?: string | null
    activeLoadCarrierId?: string | null
    assignmentType?: string | null
  }
  financials: { topSpendCents?: number | null } | null
  carrierRateCents: number
  /** Other ACTIVE LoadCarrier rows for THIS carrier, excluding this load. Used for DOUBLE_BOOKED. */
  otherActiveLoadCarriers: { loadId: string; pickupAppt?: string | null }[]
  settings: Pick<
    TmsSettings,
    'allowedCarrierStatuses' | 'requiredCarrierDocs' | 'bookingRequiredFields' | 'insuranceWarnDays'
  > | null
  now: Date | string
  isAdmin: boolean
}

export interface CarrierBookingResult {
  blocks: BookingFinding[]
  warnings: BookingFinding[]
}

export type InsuranceState = 'UPCOMING' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED'

const DAY_MS = 24 * 60 * 60 * 1000

/** Cover we insist on for every load, whatever else the carrier carries. */
const REQUIRED_INSURANCE: readonly InsurancePolicyType[] = ['AUTO_LIABILITY', 'CARGO']

const DEFAULT_ALLOWED_STATUSES: readonly string[] = ['ACTIVE']
const DEFAULT_REQUIRED_DOCS: readonly string[] = [
  'COI_CARGO',
  'COI_AUTO',
  'W9',
  'CARRIER_AGREEMENT',
]
const DEFAULT_INSURANCE_WARN_DAYS = 30

const INSURANCE_LABELS: Record<InsurancePolicyType, string> = {
  AUTO_LIABILITY: 'auto liability',
  CARGO: 'cargo',
  GENERAL_LIABILITY: 'general liability',
  WORKERS_COMP: "workers' comp",
  OTHER: 'other',
}

const DOCUMENT_LABELS: Record<CarrierDocumentType, string> = {
  AUTHORITY: 'authority letter',
  COI_AUTO: 'auto liability certificate',
  COI_CARGO: 'cargo certificate',
  COI_GENERAL: 'general liability certificate',
  W9: 'W-9',
  CARRIER_AGREEMENT: 'carrier agreement',
  FACTOR_NOA: 'factoring notice of assignment',
  CDL: 'CDL',
  RATE_CON: 'rate confirmation',
  OTHER: 'document',
}

const FIELD_LABELS: Record<string, string> = {
  COMMODITY: 'Commodity',
  DESCRIPTION: 'Freight description',
  VALUE: 'Cargo value',
  WEIGHT: 'Weight',
}

/**
 * Where one policy stands. A certificate with no end date on it is treated as good —
 * we warn about what we know expires, not about what somebody left blank.
 */
export function insuranceState(
  policy: InsurancePolicy,
  now: Date | string,
  warnDays: number,
): InsuranceState {
  const at = new Date(now).getTime()
  const expires = policy.expiresAt ? new Date(policy.expiresAt).getTime() : NaN
  if (!Number.isFinite(expires)) return 'ACTIVE'

  const effective = policy.effectiveAt ? new Date(policy.effectiveAt).getTime() : NaN
  if (Number.isFinite(effective) && effective > at) return 'UPCOMING'

  if (expires < at) return 'EXPIRED'
  if (expires <= at + warnDays * DAY_MS) return 'EXPIRING'
  return 'ACTIVE'
}

/** Out-of-service rate in basis points, or null when there is nothing to divide by. */
export function oosBps(
  inspections: number | null | undefined,
  oos: number | null | undefined,
): number | null {
  if (inspections == null || inspections === 0) return null
  return Math.round(((oos ?? 0) * 10000) / inspections)
}

/**
 * Every reason not to book this carrier on this load, in a fixed order: the flat
 * refusals first, then insurance, then money, then the advisory checks. Findings are
 * unique by `key` within each bucket, so a carrier with two lapsed cargo policies
 * says so once.
 */
export function evaluateCarrierBooking(input: CarrierBookingInput): CarrierBookingResult {
  const { carrier, documents, load, financials, carrierRateCents, settings, now, isAdmin } = input

  const nowMs = new Date(now).getTime()
  const pickupMs = toTime(load.pickupAppt) ?? nowMs
  const warnDays = settings?.insuranceWarnDays ?? DEFAULT_INSURANCE_WARN_DAYS
  const policies = carrier.insurancePolicies ?? []

  const found: (BookingFinding & { block: boolean })[] = []
  const add = (
    reason: BookingReason,
    key: string,
    detail: string,
    opts: { block: boolean; adminOnly?: boolean },
  ): void => {
    found.push({ reason, key, detail, adminOnly: opts.adminOnly ?? false, block: opts.block })
  }

  // ── flat refusals ──────────────────────────────────────────────────────────
  const allowed = settings?.allowedCarrierStatuses?.length
    ? settings.allowedCarrierStatuses
    : DEFAULT_ALLOWED_STATUSES
  const effective = effectiveCarrierStatus(carrier, now)
  if (!allowed.includes(effective.status)) {
    add(
      'STATUS_NOT_ALLOWED',
      'STATUS_NOT_ALLOWED',
      `Carrier status is ${effective.status}${effective.derived ? ' (derived from expired cargo insurance)' : ''}; only ${allowed.join(', ')} may be booked.`,
      { block: true },
    )
  }
  if (carrier.status === 'DO_NOT_USE') {
    add('DO_NOT_USE', 'DO_NOT_USE', 'This carrier is marked do not use.', { block: true })
  }
  if (carrier.authorityStatus === 'INACTIVE') {
    add(
      'AUTHORITY_INACTIVE',
      'AUTHORITY_INACTIVE',
      "The carrier's operating authority is inactive.",
      { block: true },
    )
  }
  if (load.activeLoadCarrierId) {
    add('ALREADY_COVERED', 'ALREADY_COVERED', 'This load already has an active carrier on it.', {
      block: true,
    })
  }
  if (carrierRateCents < 0) {
    add(
      'NEGATIVE_CARRIER_CHARGE',
      'NEGATIVE_CARRIER_CHARGE',
      'The carrier charges on this load total a negative amount.',
      { block: true },
    )
  }

  // ── insurance that must cover the pickup ───────────────────────────────────
  for (const type of REQUIRED_INSURANCE) {
    const ofType = policies.filter((p) => p?.type === type)
    const covered = ofType.some((p) => {
      const expires = toTime(p.expiresAt)
      return expires == null || expires >= pickupMs
    })
    if (!covered) {
      add(
        'INSURANCE_EXPIRED',
        `INSURANCE_EXPIRED:${type}`,
        `No ${INSURANCE_LABELS[type]} insurance covering the pickup date is on file.`,
        { block: true },
      )
    }
  }

  // ── the three an admin may wave through ────────────────────────────────────
  const cargo = policies.filter((p) => p?.type === 'CARGO')
  const cargoLimit = cargo.length
    ? Math.max(...cargo.map((p) => p.limitCents ?? 0))
    : null
  if (load.cargoValueCents != null && cargoLimit != null && load.cargoValueCents > cargoLimit) {
    add(
      'CARGO_VALUE_EXCEEDS_INSURANCE',
      'CARGO_VALUE_EXCEEDS_INSURANCE',
      `Cargo value ${dollars(load.cargoValueCents)} is over the carrier's cargo insurance limit of ${dollars(cargoLimit)}.`,
      { block: !isAdmin, adminOnly: isAdmin },
    )
  }
  if (cargo.length === 0) {
    add(
      'INSURANCE_UNVERIFIED',
      'INSURANCE_UNVERIFIED',
      'No cargo insurance is on file for this carrier.',
      { block: !isAdmin, adminOnly: isAdmin },
    )
  }
  const topSpend = financials?.topSpendCents
  if (topSpend != null && carrierRateCents > topSpend) {
    add(
      'COST_EXCEEDS_TOP_SPEND',
      'COST_EXCEEDS_TOP_SPEND',
      `Carrier rate ${dollars(carrierRateCents)} is over the top spend of ${dollars(topSpend)} for this load.`,
      { block: !isAdmin, adminOnly: isAdmin },
    )
  }

  // ── advisory ───────────────────────────────────────────────────────────────
  for (const policy of policies) {
    if (!policy) continue
    if (insuranceState(policy, now, warnDays) !== 'EXPIRING') continue
    add(
      'INSURANCE_EXPIRING',
      `INSURANCE_EXPIRING:${policy.type}`,
      `The carrier's ${INSURANCE_LABELS[policy.type] ?? 'insurance'} policy expires ${dateOnly(policy.expiresAt)}, within ${warnDays} days.`,
      { block: false },
    )
  }

  const requiredDocs = settings?.requiredCarrierDocs?.length
    ? settings.requiredCarrierDocs
    : DEFAULT_REQUIRED_DOCS
  for (const type of requiredDocs) {
    const label = DOCUMENT_LABELS[type as CarrierDocumentType] ?? type
    const ofType = documents.filter((d) => d?.type === type)
    if (ofType.length === 0) {
      add('MISSING_DOC', `MISSING_DOC:${type}`, `No ${label} is on file for this carrier.`, {
        block: false,
      })
      continue
    }
    const current = ofType.some((d) => {
      const expires = toTime(d.expiresAt)
      return expires == null || expires >= nowMs
    })
    if (!current) {
      add('DOC_EXPIRED', `DOC_EXPIRED:${type}`, `The ${label} on file has expired.`, {
        block: false,
      })
    }
  }

  for (const field of settings?.bookingRequiredFields ?? []) {
    const value =
      field === 'COMMODITY'
        ? load.commodity
        : field === 'DESCRIPTION'
          ? load.freightDescription
          : field === 'VALUE'
            ? load.cargoValueCents
            : field === 'WEIGHT'
              ? load.weight
              : null
    const blank = value == null || (typeof value === 'string' && value.trim() === '')
    if (blank) {
      add(
        'MISSING_REQUIRED_FIELD',
        `MISSING_REQUIRED_FIELD:${field}`,
        `${FIELD_LABELS[field] ?? field} is needed on the load before booking.`,
        { block: false },
      )
    }
  }

  const pickupDay = utcDay(load.pickupAppt)
  if (pickupDay) {
    for (const other of input.otherActiveLoadCarriers) {
      if (other.loadId === load.id) continue
      if (utcDay(other.pickupAppt) !== pickupDay) continue
      add(
        'DOUBLE_BOOKED',
        `DOUBLE_BOOKED:${other.loadId}`,
        `This carrier is already booked on another load picking up ${pickupDay}.`,
        { block: false },
      )
    }
  }

  const blocks: BookingFinding[] = []
  const warnings: BookingFinding[] = []
  const seenBlocks = new Set<string>()
  const seenWarnings = new Set<string>()
  for (const f of found) {
    const seen = f.block ? seenBlocks : seenWarnings
    if (seen.has(f.key)) continue
    seen.add(f.key)
    ;(f.block ? blocks : warnings).push({
      reason: f.reason,
      key: f.key,
      detail: f.detail,
      adminOnly: f.adminOnly,
    })
  }
  return { blocks, warnings }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function toTime(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** The UTC date portion, which is how two pickups are judged to be the same day. */
function utcDay(value: string | null | undefined): string | null {
  const ms = toTime(value)
  return ms == null ? null : new Date(ms).toISOString().slice(0, 10)
}

function dateOnly(value: string | null | undefined): string {
  return utcDay(value) ?? 'soon'
}

function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}
