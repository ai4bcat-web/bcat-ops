// Step AM — the carrier assignment ladder, shared by the Lambda (decides) and the UI (shows).
// No imports from '@/' — the Lambdas bundle this file.
//
// One LoadCarrier row climbs five rungs. Where it is comes from facts, never from a button
// that says "done": MyCarrierPackets decides setup, the rate-con record decides sent/signed,
// and the four driver fields decide the last rung.

export const CARRIER_ASSIGNMENT_STATUSES = [
  'ASSIGNED_SETUP_PENDING',
  'ASSIGNED_SETUP_COMPLETE',
  'RATE_CON_SENT',
  'RATE_CON_SIGNED',
  'DRIVER_INFO_ENTERED',
] as const

export type CarrierAssignmentStatus = (typeof CARRIER_ASSIGNMENT_STATUSES)[number]

export const CARRIER_ASSIGNMENT_LABELS: Record<CarrierAssignmentStatus, string> = {
  ASSIGNED_SETUP_PENDING: 'Carrier assigned - waiting for carrier setup',
  ASSIGNED_SETUP_COMPLETE: 'Carrier setup complete',
  RATE_CON_SENT: 'Rate con sent',
  RATE_CON_SIGNED: 'Rate con signed',
  DRIVER_INFO_ENTERED: 'Driver info entered',
}

/** The four fields tracking (driver SMS, check-call agent) keys off. All are mandatory. */
export const DRIVER_INFO_FIELDS = [
  { key: 'driverName', label: 'driver name' },
  { key: 'driverPhone', label: 'driver phone' },
  { key: 'truckNumber', label: 'truck number' },
  { key: 'trailerNumber', label: 'trailer number' },
] as const

export type DriverInfoKey = (typeof DRIVER_INFO_FIELDS)[number]['key']

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''

/** Labels of the driver fields still empty on this assignment; [] means entered. */
export function driverInfoGaps(row: object | null | undefined): string[] {
  return DRIVER_INFO_FIELDS.filter((f) => !filled((row as Record<string, unknown> | null | undefined)?.[f.key])).map((f) => f.label)
}

export function isCarrierAssignmentStatus(value: unknown): value is CarrierAssignmentStatus {
  return typeof value === 'string' && (CARRIER_ASSIGNMENT_STATUSES as readonly string[]).includes(value)
}

export function rungOf(status: CarrierAssignmentStatus | null | undefined): number {
  return status ? CARRIER_ASSIGNMENT_STATUSES.indexOf(status) : -1
}

/** `assignmentTimes` is a JSON string map of status -> ISO time (AWSJSON); tolerate an object. */
export function parseAssignmentTimes(raw: unknown): Partial<Record<CarrierAssignmentStatus, string>> {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return {} }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Partial<Record<CarrierAssignmentStatus, string>> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isCarrierAssignmentStatus(k) && typeof v === 'string') out[k] = v
  }
  return out
}

export interface AssignmentFacts {
  /** Carrier.status of the directory row. */
  carrierStatus: string | null | undefined
  rateConStatus: string | null | undefined
  rateConSignedAt?: string | null
  driverName?: string | null
  driverPhone?: string | null
  truckNumber?: string | null
  trailerNumber?: string | null
}

/**
 * The rung the facts support. Setup is complete only while the directory carrier is ACTIVE —
 * which only MyCarrierPackets makes it. Rate con and driver facts count only on a set-up carrier,
 * because a rate con cannot be sent to anyone else.
 */
export function deriveAssignmentStatus(facts: AssignmentFacts): CarrierAssignmentStatus {
  if (facts.carrierStatus !== 'ACTIVE') return 'ASSIGNED_SETUP_PENDING'
  if (driverInfoGaps(facts).length === 0) return 'DRIVER_INFO_ENTERED'
  if (facts.rateConStatus === 'SIGNED' || filled(facts.rateConSignedAt)) return 'RATE_CON_SIGNED'
  if (facts.rateConStatus === 'SENT' || facts.rateConStatus === 'OPENED') return 'RATE_CON_SENT'
  return 'ASSIGNED_SETUP_COMPLETE'
}

/** Add `status` to the timestamp map unless it already has a time (first arrival wins). */
export function stampAssignmentTime(
  raw: unknown,
  status: CarrierAssignmentStatus,
  at: string,
): Partial<Record<CarrierAssignmentStatus, string>> {
  const times = parseAssignmentTimes(raw)
  if (!times[status]) times[status] = at
  return times
}

/** The LoadCarrier columns for moving to `status` at `at`; the time map keeps first arrivals. */
export function ladderPatch(
  current: Record<string, unknown>,
  status: CarrierAssignmentStatus,
  at: string,
): { assignmentStatus: CarrierAssignmentStatus; assignmentTimes: string } {
  return { assignmentStatus: status, assignmentTimes: JSON.stringify(stampAssignmentTime(current.assignmentTimes, status, at)) }
}

/**
 * Where an assignment should go next given what is now true, or null. The ladder never walks back:
 * a lapse after the rate con is signed does not un-sign it, it surfaces as a booking warning.
 */
export function advanceTarget(
  current: CarrierAssignmentStatus | null | undefined,
  facts: AssignmentFacts,
): CarrierAssignmentStatus | null {
  const derived = deriveAssignmentStatus(facts)
  return rungOf(derived) > rungOf(current) ? derived : null
}
