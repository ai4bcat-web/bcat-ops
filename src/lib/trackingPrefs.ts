/**
 * Steps AJ/AK — how a customer's loads are tracked, and how the driver is texted.
 *
 * Three independent choices, each set on the Customer and optionally overridden on one
 * Shipment (`Shipment.trackingPrefs`). Resolved at read time, key by key:
 * shipment override → customer → default. Nothing is copied onto a new shipment.
 *
 *  - mode     AGENT | MANUAL | NONE. MANUAL and NONE stop every *automatic* request (NONE: this
 *             load is not tracked at all); a person's action is never blocked. null (a legacy
 *             customer) leaves Step V's switches in charge.
 *  - method   EMAIL | SMS | BOTH. Intersects the channels the plan enables; never adds one.
 *  - driverSms WORK_THEN_PERSONAL | WORK_ONLY | PERSONAL — which number the driver is texted on.
 *
 * Feedback 9: the mode is chosen PER LOAD when the carrier is booked. The customer's value is only a
 * suggestion until the load's mode is CONFIRMED (`override.confirmedAt`, stamped by SET_TRACKING_PREFS
 * with `confirmed: true`); automation never auto-runs on an unconfirmed load (`allowsAutoRequests`).
 * Legacy rule: a shipment created before `TRACKING_CONFIRMATION_STARTS_AT`, or one that already has a
 * pinned mode, counts as confirmed, so live tracking is not silenced by this change.
 *
 * Pure: shared by the Lambdas (imported the way `trackingAutomation` is) and the UI.
 */

export type TrackingMode = 'AGENT' | 'MANUAL' | 'NONE'
export type TrackingMethod = 'EMAIL' | 'SMS' | 'BOTH'
export type DriverSmsTarget = 'WORK_THEN_PERSONAL' | 'WORK_ONLY' | 'PERSONAL'

export const TRACKING_MODES: readonly TrackingMode[] = ['AGENT', 'MANUAL', 'NONE']

/** What a customer default may be: NONE only makes sense for one load. */
export const CUSTOMER_TRACKING_MODES: readonly TrackingMode[] = ['AGENT', 'MANUAL']

/** Shipments created before this instant are confirmed by default (the deploy of per-load tracking mode). */
export const TRACKING_CONFIRMATION_STARTS_AT = '2026-11-06T00:00:00.000Z'
export const TRACKING_METHODS: readonly TrackingMethod[] = ['EMAIL', 'SMS', 'BOTH']
export const DRIVER_SMS_TARGETS: readonly DriverSmsTarget[] = ['WORK_THEN_PERSONAL', 'WORK_ONLY', 'PERSONAL']

export const DEFAULT_DRIVER_SMS_TARGET: DriverSmsTarget = 'WORK_THEN_PERSONAL'

export const TRACKING_MODE_LABELS: Record<TrackingMode, string> = {
  AGENT: 'AI agent tracking',
  MANUAL: 'Manual',
  NONE: 'No tracking',
}
export const TRACKING_METHOD_LABELS: Record<TrackingMethod, string> = {
  EMAIL: 'E-mail thread (dispatcher)',
  SMS: 'SMS to driver',
  BOTH: 'Both',
}
export const DRIVER_SMS_TARGET_LABELS: Record<DriverSmsTarget, string> = {
  WORK_THEN_PERSONAL: 'Truck work phone, personal as fallback',
  WORK_ONLY: 'Truck work phone only',
  PERSONAL: 'Personal phone',
}

/** The per-shipment override. A missing key inherits the customer. */
export interface TrackingPrefsOverride {
  mode?: TrackingMode
  method?: TrackingMethod
  driverSms?: DriverSmsTarget
  /** Set by SET_TRACKING_PREFS when the person confirms the mode for this load. */
  confirmedAt?: string
  confirmedBy?: string
}

export interface EffectiveTrackingPrefs {
  /** null = legacy customer with no choice: Step V's switches decide. */
  mode: TrackingMode | null
  /** null = the plan's channels as configured. */
  method: TrackingMethod | null
  driverSms: DriverSmsTarget
  /** False = the mode is still the customer's suggestion: no automatic request may run. */
  confirmed: boolean
  source: {
    mode: 'SHIPMENT' | 'CUSTOMER' | 'DEFAULT'
    method: 'SHIPMENT' | 'CUSTOMER' | 'DEFAULT'
    driverSms: 'SHIPMENT' | 'CUSTOMER' | 'DEFAULT'
  }
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

/**
 * The override as stored: an object (Lambda/bundle) or a JSON string (AppSync's AWSJSON).
 * Unknown keys and unknown enum values are dropped; nothing usable ⇒ null.
 */
export function parseTrackingPrefs(raw: unknown): TrackingPrefsOverride | null {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const out: TrackingPrefsOverride = {}
  const mode = pick(o.mode, TRACKING_MODES)
  const method = pick(o.method, TRACKING_METHODS)
  const driverSms = pick(o.driverSms, DRIVER_SMS_TARGETS)
  if (mode) out.mode = mode
  if (method) out.method = method
  if (driverSms) out.driverSms = driverSms
  if (typeof o.confirmedAt === 'string' && o.confirmedAt) out.confirmedAt = o.confirmedAt
  if (typeof o.confirmedBy === 'string' && o.confirmedBy) out.confirmedBy = o.confirmedBy
  return Object.keys(out).length ? out : null
}

/** What a client sends: the override plus `confirmed: true` ("I confirm this load's mode"); the server stamps who and when. */
export type TrackingPrefsInput = Pick<TrackingPrefsOverride, 'mode' | 'method' | 'driverSms'> & { confirmed?: true }

/**
 * Write-side validation for `SET_TRACKING_PREFS`: unlike `parseTrackingPrefs` it refuses
 * rather than drops. `null`/`undefined`/`{}` ⇒ null (clear); a key set to null is "inherit".
 * `confirmed: true` is the only way to confirm; `confirmedAt` / `confirmedBy` are never accepted from a client.
 */
export function validateTrackingPrefsOverride(raw: unknown): TrackingPrefsInput | null {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('prefs must be an object or null')
  const o = raw as Record<string, unknown>
  for (const key of Object.keys(o)) {
    if (key !== 'mode' && key !== 'method' && key !== 'driverSms' && key !== 'confirmed') throw new Error(`Unknown tracking preference: ${key}`)
  }
  const out: TrackingPrefsInput = {}
  if (o.confirmed != null && o.confirmed !== true && o.confirmed !== false) throw new Error('confirmed must be true')
  if (o.confirmed === true) out.confirmed = true
  const check = <T extends string>(key: 'mode' | 'method' | 'driverSms', allowed: readonly T[]): T | undefined => {
    const v = o[key]
    if (v == null) return undefined
    const hit = pick(v, allowed)
    if (!hit) throw new Error(`${key} must be one of ${allowed.join(', ')}`)
    return hit
  }
  const mode = check('mode', TRACKING_MODES)
  const method = check('method', TRACKING_METHODS)
  const driverSms = check('driverSms', DRIVER_SMS_TARGETS)
  if (mode) out.mode = mode
  if (method) out.method = method
  if (driverSms) out.driverSms = driverSms
  return Object.keys(out).length ? out : null
}

export interface CustomerPrefsLike {
  trackingMode?: string | null
  trackingMethod?: string | null
  driverSmsTarget?: string | null
}

/** Shipment override ?? customer ?? default, per key independently. */
export function effectiveTrackingPrefs(i: {
  shipment?: { trackingPrefs?: unknown; createdAt?: string | null } | null
  customer?: CustomerPrefsLike | null
}): EffectiveTrackingPrefs {
  const override = parseTrackingPrefs(i.shipment?.trackingPrefs)
  const c = i.customer ?? null

  const customerMode = pick(c?.trackingMode, CUSTOMER_TRACKING_MODES)
  const customerMethod = pick(c?.trackingMethod, TRACKING_METHODS)
  const customerSms = pick(c?.driverSmsTarget, DRIVER_SMS_TARGETS)

  return {
    mode: override?.mode ?? customerMode ?? null,
    method: override?.method ?? customerMethod ?? null,
    driverSms: override?.driverSms ?? customerSms ?? DEFAULT_DRIVER_SMS_TARGET,
    confirmed: trackingConfirmed(i.shipment ?? null, override),
    source: {
      mode: override?.mode ? 'SHIPMENT' : customerMode ? 'CUSTOMER' : 'DEFAULT',
      method: override?.method ? 'SHIPMENT' : customerMethod ? 'CUSTOMER' : 'DEFAULT',
      driverSms: override?.driverSms ? 'SHIPMENT' : customerSms ? 'CUSTOMER' : 'DEFAULT',
    },
  }
}

/**
 * Is this load's tracking mode confirmed? Yes when a person confirmed it, when a mode was pinned on
 * the shipment, or when the shipment predates per-load confirmation (legacy rows stay live). No
 * `createdAt` is treated as legacy.
 */
export function trackingConfirmed(
  shipment: { trackingPrefs?: unknown; createdAt?: string | null } | null,
  override: TrackingPrefsOverride | null = parseTrackingPrefs(shipment?.trackingPrefs),
): boolean {
  if (override?.confirmedAt || override?.mode) return true
  const created = shipment?.createdAt ? Date.parse(shipment.createdAt) : NaN
  return Number.isNaN(created) || created < Date.parse(TRACKING_CONFIRMATION_STARTS_AT)
}

/** Why automation must not auto-run, or null when it may: MANUAL / NONE, or a mode nobody confirmed yet. A person's action is never gated by this. */
export function autoRequestBlock(p: Pick<EffectiveTrackingPrefs, 'mode'> & { confirmed?: boolean }): 'MANUAL' | 'NONE' | 'UNCONFIRMED' | null {
  if (p.confirmed === false) return 'UNCONFIRMED'
  if (p.mode === 'NONE') return 'NONE'
  return p.mode === 'MANUAL' ? 'MANUAL' : null
}

/** The sentence automation logs when it skips a load. MANUAL keeps its wording from before per-load mode. */
export const AUTO_BLOCK_NOTE = {
  MANUAL: 'Customer tracking is manual',
  NONE: 'Tracking is switched off for this load',
  UNCONFIRMED: 'Tracking mode not confirmed for this load',
} as const

export function allowsAutoRequests(p: Pick<EffectiveTrackingPrefs, 'mode'> & { confirmed?: boolean }): boolean {
  return autoRequestBlock(p) === null
}

/** A carrier is booked on the load but nobody confirmed how it is tracked: the amber "Tracking mode not set" chip. */
export function trackingModeNotSet(
  shipment: { trackingPrefs?: unknown; createdAt?: string | null } | null,
  hasCarrier: boolean,
): boolean {
  return hasCarrier && !trackingConfirmed(shipment)
}

/** Intersect a plan's channels with the method. BOTH/null leave them alone; the result may be empty. */
export function channelsAllowedBy<T extends string>(method: TrackingMethod | null, channels: readonly T[]): T[] {
  if (method === 'EMAIL') return channels.filter((c) => c === 'EMAIL')
  if (method === 'SMS') return channels.filter((c) => c === 'SMS')
  return [...channels]
}
