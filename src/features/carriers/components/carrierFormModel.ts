/**
 * The carrier form's value and patch model: the string-shaped draft the inputs bind to,
 * the typed patch `upsertCarrier` takes, and the pure conversions between them and a
 * carrier record. It lives apart from `CarrierForm.tsx` because a module that exports a
 * component may export nothing else without breaking Fast Refresh.
 */
import type {
  AuthorityStatus,
  CarrierEquipment,
  CarrierRecord,
  CarrierType,
  ComplianceCheckStatus,
  InsurancePolicy,
  SafetyRating,
} from '@/types/tms'

export const CARRIER_TYPES: CarrierType[] = ['TL', 'LTL', 'CARTAGE', 'LINEHAUL', 'AIR', 'OCEAN', 'RAIL', 'AGENT']
export const CARRIER_EQUIPMENT: CarrierEquipment[] = [
  'CONTAINER', 'FLATBED', 'POWER_ONLY', 'REEFER', 'SPECIALIZED', 'TANKER', 'VAN',
]

export interface CarrierFormValue {
  name: string
  dbaName: string
  type: CarrierType
  mcNumber: string
  dotNumber: string
  scac: string
  einNumber: string
  phone: string
  email: string
  website: string
  street: string
  city: string
  state: string
  zip: string
  dispatcherName: string
  dispatcherPhone: string
  dispatcherEmail: string
  paymentTermsDays: string
  quickPayEligible: boolean
  defaultQuickPayDays: string
  accountOwnersText: string
  teamKey: string
  internalNotes: string
  equipment: string[]
  cargoTypesText: string
  powerUnits: string
  trailerCount: string
  driverCount: string
  inFmcsa: boolean
  authorityStatus: AuthorityStatus | ''
  authorityGrantedAt: string
  authorityExpiresAt: string
  safetyRating: SafetyRating | ''
  safetyRatingAt: string
  reviewType: string
  reviewedAt: string
  driverInspections: string
  driverOos: string
  vehicleInspections: string
  vehicleOos: string
  highwayStatus: ComplianceCheckStatus | ''
  rmisStatus: ComplianceCheckStatus | ''
  mcpStatus: string
}

/** `2026-04-01T00:00:00.000Z` -> `2026-04-01`, which is all a date input accepts. */
function dateInput(iso: string | null | undefined): string {
  return (iso ?? '').slice(0, 10)
}

function address(carrier: CarrierRecord | null, key: string): string {
  const value = (carrier?.address as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' ? value : ''
}

export function carrierFormFrom(carrier: CarrierRecord | null): CarrierFormValue {
  return {
    name: carrier?.name ?? '',
    dbaName: carrier?.dbaName ?? '',
    type: carrier?.type ?? 'TL',
    mcNumber: carrier?.mcNumber ?? '',
    dotNumber: carrier?.dotNumber ?? '',
    scac: carrier?.scac ?? '',
    einNumber: carrier?.einNumber ?? '',
    phone: carrier?.phone ?? '',
    email: carrier?.email ?? '',
    website: carrier?.website ?? '',
    street: address(carrier, 'street'),
    city: address(carrier, 'city'),
    state: address(carrier, 'state'),
    zip: address(carrier, 'zip'),
    dispatcherName: carrier?.dispatcherName ?? '',
    dispatcherPhone: carrier?.dispatcherPhone ?? '',
    dispatcherEmail: carrier?.dispatcherEmail ?? '',
    paymentTermsDays: carrier?.paymentTermsDays == null ? '' : String(carrier.paymentTermsDays),
    quickPayEligible: carrier?.quickPayEligible === true,
    defaultQuickPayDays: carrier?.defaultQuickPayDays == null ? '' : String(carrier.defaultQuickPayDays),
    accountOwnersText: (carrier?.accountOwnerIds ?? []).join('\n'),
    teamKey: carrier?.teamKey ?? '',
    internalNotes: carrier?.internalNotes ?? '',
    equipment: [...(carrier?.equipment ?? [])],
    cargoTypesText: (carrier?.cargoTypes ?? []).join('\n'),
    powerUnits: carrier?.powerUnits == null ? '' : String(carrier.powerUnits),
    trailerCount: carrier?.trailerCount == null ? '' : String(carrier.trailerCount),
    driverCount: carrier?.driverCount == null ? '' : String(carrier.driverCount),
    inFmcsa: carrier?.inFmcsa === true,
    authorityStatus: carrier?.authorityStatus ?? '',
    authorityGrantedAt: dateInput(carrier?.authorityGrantedAt),
    authorityExpiresAt: dateInput(carrier?.authorityExpiresAt),
    safetyRating: carrier?.safetyRating ?? '',
    safetyRatingAt: dateInput(carrier?.safetyRatingAt),
    reviewType: carrier?.reviewType ?? '',
    reviewedAt: dateInput(carrier?.reviewedAt),
    driverInspections: carrier?.driverInspections == null ? '' : String(carrier.driverInspections),
    driverOos: carrier?.driverOos == null ? '' : String(carrier.driverOos),
    vehicleInspections: carrier?.vehicleInspections == null ? '' : String(carrier.vehicleInspections),
    vehicleOos: carrier?.vehicleOos == null ? '' : String(carrier.vehicleOos),
    highwayStatus: carrier?.highwayStatus ?? '',
    rmisStatus: carrier?.rmisStatus ?? '',
    mcpStatus: carrier?.mcpStatus ?? '',
  }
}

function intOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) ? parsed : null
}

/** A date input gives a bare day; the record stores an ISO instant at UTC midnight. */
function isoOrNull(value: string): string | null {
  if (!value) return null
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/**
 * The patch `upsertCarrier` takes for an existing carrier. `status` is deliberately
 * absent — a carrier only changes status through the status dialog, and the Lambda
 * ignores it on update anyway.
 */
export interface CarrierPatch {
  name: string
  dbaName: string | null
  type: CarrierType
  mcNumber: string | null
  dotNumber: string | null
  scac: string | null
  einNumber: string | null
  phone: string | null
  email: string | null
  website: string | null
  address: Record<string, unknown> | null
  dispatcherName: string | null
  dispatcherPhone: string | null
  dispatcherEmail: string | null
  paymentTermsDays: number | null
  quickPayEligible: boolean
  defaultQuickPayDays: number | null
  accountOwnerIds: string[]
  teamKey: string | null
  internalNotes: string | null
  equipment: string[]
  cargoTypes: string[]
  powerUnits: number | null
  trailerCount: number | null
  driverCount: number | null
  inFmcsa: boolean
  authorityStatus: AuthorityStatus | null
  authorityGrantedAt: string | null
  authorityExpiresAt: string | null
  safetyRating: SafetyRating | null
  safetyRatingAt: string | null
  reviewType: string | null
  reviewedAt: string | null
  driverInspections: number | null
  driverOos: number | null
  vehicleInspections: number | null
  vehicleOos: number | null
  highwayStatus: ComplianceCheckStatus | null
  rmisStatus: ComplianceCheckStatus | null
  mcpStatus: string | null
  insurancePolicies: InsurancePolicy[]
}

export function carrierFormInput(value: CarrierFormValue, policies: InsurancePolicy[]): CarrierPatch {
  const hasAddress = Boolean(value.street || value.city || value.state || value.zip)
  return {
    name: value.name.trim(),
    dbaName: value.dbaName.trim() || null,
    type: value.type,
    mcNumber: value.mcNumber.trim() || null,
    dotNumber: value.dotNumber.trim() || null,
    scac: value.scac.trim() || null,
    einNumber: value.einNumber.trim() || null,
    phone: value.phone.trim() || null,
    email: value.email.trim() || null,
    website: value.website.trim() || null,
    address: hasAddress
      ? { street: value.street.trim(), city: value.city.trim(), state: value.state.trim(), zip: value.zip.trim() }
      : null,
    dispatcherName: value.dispatcherName.trim() || null,
    dispatcherPhone: value.dispatcherPhone.trim() || null,
    dispatcherEmail: value.dispatcherEmail.trim() || null,
    paymentTermsDays: intOrNull(value.paymentTermsDays),
    quickPayEligible: value.quickPayEligible,
    defaultQuickPayDays: intOrNull(value.defaultQuickPayDays),
    accountOwnerIds: lines(value.accountOwnersText),
    teamKey: value.teamKey.trim() || null,
    internalNotes: value.internalNotes.trim() || null,
    equipment: value.equipment,
    cargoTypes: lines(value.cargoTypesText),
    powerUnits: intOrNull(value.powerUnits),
    trailerCount: intOrNull(value.trailerCount),
    driverCount: intOrNull(value.driverCount),
    inFmcsa: value.inFmcsa,
    authorityStatus: value.authorityStatus || null,
    authorityGrantedAt: isoOrNull(value.authorityGrantedAt),
    authorityExpiresAt: isoOrNull(value.authorityExpiresAt),
    safetyRating: value.safetyRating || null,
    safetyRatingAt: isoOrNull(value.safetyRatingAt),
    reviewType: value.reviewType.trim() || null,
    reviewedAt: isoOrNull(value.reviewedAt),
    driverInspections: intOrNull(value.driverInspections),
    driverOos: intOrNull(value.driverOos),
    vehicleInspections: intOrNull(value.vehicleInspections),
    vehicleOos: intOrNull(value.vehicleOos),
    highwayStatus: value.highwayStatus || null,
    rmisStatus: value.rmisStatus || null,
    mcpStatus: value.mcpStatus.trim() || null,
    insurancePolicies: policies,
  }
}

/** The one error worth stopping a save for; everything else the Lambda validates. */
export function carrierFormError(value: CarrierFormValue): string | null {
  if (!value.name.trim()) return 'Carrier name is required.'
  if (value.defaultQuickPayDays && intOrNull(value.defaultQuickPayDays) == null) {
    return 'Quick-pay days must be a whole number.'
  }
  if (value.paymentTermsDays && intOrNull(value.paymentTermsDays) == null) {
    return 'Payment terms must be a whole number of days.'
  }
  return null
}
