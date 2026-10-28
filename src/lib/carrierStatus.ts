/**
 * A carrier's status, and the rules that move it.
 *
 * Five states: PENDING is a carrier somebody typed in, REVIEW is one being vetted,
 * ACTIVE may be booked, INACTIVE may not until somebody fixes what is wrong, and
 * DO_NOT_USE is a judgement about the company — double brokering, a theft, a claim.
 * Coming back from DO_NOT_USE is an admin's call alone; every other move is open to
 * anyone on the carriers page.
 *
 * Turning a carrier off always has a reason on it, from a list that differs by where
 * it is going: INACTIVE is operational (insurance lapsed, authority gone), DO_NOT_USE
 * is about trust. `effectiveCarrierStatus` is the one booking reads — an ACTIVE
 * carrier whose cargo insurance has all run out is treated as INACTIVE on sight,
 * without anybody writing that to the row.
 *
 * Imports are relative and type-only: the tmsCarrierActions Lambda bundles this file
 * by path, so a `@/` alias would break the function build.
 */
import type {
  CarrierDoNotUseReason,
  CarrierInactiveReason,
  CarrierRecord,
  CarrierStatus,
  CarrierStatusReason,
} from '../types/tms'

export const CARRIER_STATUSES: readonly CarrierStatus[] = [
  'PENDING',
  'REVIEW',
  'ACTIVE',
  'INACTIVE',
  'DO_NOT_USE',
]

export const CARRIER_STATUS_LABELS: Record<CarrierStatus, string> = {
  PENDING: 'Pending',
  REVIEW: 'Review',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  DO_NOT_USE: 'Do not use',
}

/** Why a carrier is switched off — all of these are fixable. */
export const CARRIER_INACTIVE_REASONS: readonly CarrierInactiveReason[] = [
  'EXPIRED_INSURANCE',
  'INACTIVE_AUTHORITY',
  'INACTIVE_AGREEMENT',
  'SAFETY_ISSUES',
  'OTHER',
]

/** Why we will not work with a carrier — all of these are about trust. */
export const CARRIER_DO_NOT_USE_REASONS: readonly CarrierDoNotUseReason[] = [
  'DOUBLE_BROKERING',
  'CARGO_CLAIM',
  'THEFT',
  'FRAUD',
  'SUSPICIOUS_ACTIVITY',
]

export const CARRIER_STATUS_REASON_LABELS: Record<CarrierStatusReason, string> = {
  EXPIRED_INSURANCE: 'Expired insurance',
  INACTIVE_AUTHORITY: 'Inactive authority',
  INACTIVE_AGREEMENT: 'Inactive agreement',
  SAFETY_ISSUES: 'Safety issues',
  OTHER: 'Other',
  DOUBLE_BROKERING: 'Double brokering',
  CARGO_CLAIM: 'Cargo claim',
  THEFT: 'Theft',
  FRAUD: 'Fraud',
  SUSPICIOUS_ACTIVITY: 'Suspicious activity',
}

/**
 * Where a carrier may go from where it is. A row with no status yet is a carrier
 * somebody just typed in, so it reads as PENDING. DO_NOT_USE is the only one-way
 * door: only an admin may open it, and only back to INACTIVE — never straight to
 * ACTIVE, so the carrier has to be re-approved on the way through.
 */
const CARRIER_TRANSITIONS: Record<CarrierStatus, readonly CarrierStatus[]> = {
  PENDING: ['REVIEW', 'ACTIVE', 'INACTIVE', 'DO_NOT_USE'],
  REVIEW: ['ACTIVE', 'INACTIVE', 'DO_NOT_USE'],
  ACTIVE: ['INACTIVE', 'DO_NOT_USE'],
  INACTIVE: ['ACTIVE', 'DO_NOT_USE'],
  DO_NOT_USE: ['INACTIVE'],
}

export function nextCarrierStatuses(
  from: CarrierStatus | null | undefined,
  isAdmin: boolean,
): CarrierStatus[] {
  const current = from ?? 'PENDING'
  if (current === 'DO_NOT_USE' && !isAdmin) return []
  return [...CARRIER_TRANSITIONS[current]]
}

export function canTransitionCarrierStatus(
  from: CarrierStatus | null | undefined,
  to: CarrierStatus,
  isAdmin: boolean,
): boolean {
  return nextCarrierStatuses(from, isAdmin).includes(to)
}

/** Switching a carrier off is always on the record; switching it on is not. */
export function carrierStatusReasonRequired(to: CarrierStatus): boolean {
  return to === 'INACTIVE' || to === 'DO_NOT_USE'
}

export function carrierStatusReasonsFor(to: CarrierStatus): readonly CarrierStatusReason[] {
  if (to === 'INACTIVE') return CARRIER_INACTIVE_REASONS
  if (to === 'DO_NOT_USE') return CARRIER_DO_NOT_USE_REASONS
  return []
}

/** What booking reads. `derived` means nobody wrote this — the insurance did. */
export interface EffectiveCarrierStatus {
  status: CarrierStatus
  reason: CarrierStatusReason | null
  derived: boolean
}

/**
 * The status the carrier's paperwork proves, which is never better than the stored
 * one. An ACTIVE carrier holding only expired cargo policies is INACTIVE until a
 * fresh certificate arrives. A carrier with no cargo policy on file at all is left
 * alone here — that is unverified, not expired, and booking warns about it instead.
 * Never writes.
 */
export function effectiveCarrierStatus(
  carrier: Pick<CarrierRecord, 'status' | 'statusReason' | 'insurancePolicies'>,
  now: Date | string,
): EffectiveCarrierStatus {
  const stored: EffectiveCarrierStatus = {
    status: carrier.status,
    reason: carrier.statusReason ?? null,
    derived: false,
  }
  if (carrier.status !== 'ACTIVE') return stored

  const cargo = (carrier.insurancePolicies ?? []).filter((p) => p?.type === 'CARGO')
  if (cargo.length === 0) return stored

  const at = new Date(now).getTime()
  const allExpired = cargo.every((p) => {
    const expires = p.expiresAt ? new Date(p.expiresAt).getTime() : NaN
    return Number.isFinite(expires) && expires < at
  })
  if (!allExpired) return stored

  return { status: 'INACTIVE', reason: 'EXPIRED_INSURANCE', derived: true }
}
