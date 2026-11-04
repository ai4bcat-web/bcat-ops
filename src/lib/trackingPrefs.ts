/**
 * Steps AJ/AK — how a customer's loads are tracked, and how the driver is texted.
 *
 * Three independent choices, each set on the Customer and optionally overridden on one
 * Shipment (`Shipment.trackingPrefs`). Resolved at read time, key by key:
 * shipment override → customer → default. Nothing is copied onto a new shipment.
 *
 *  - mode     AGENT | MANUAL. MANUAL stops every *automatic* request; a person's action is
 *             never blocked. null (a legacy customer) leaves Step V's switches in charge.
 *  - method   EMAIL | SMS | BOTH. Intersects the channels the plan enables; never adds one.
 *  - driverSms WORK_THEN_PERSONAL | WORK_ONLY | PERSONAL — which number the driver is texted on.
 *
 * Pure: shared by the Lambdas (imported the way `trackingAutomation` is) and the UI.
 */

export type TrackingMode = 'AGENT' | 'MANUAL'
export type TrackingMethod = 'EMAIL' | 'SMS' | 'BOTH'
export type DriverSmsTarget = 'WORK_THEN_PERSONAL' | 'WORK_ONLY' | 'PERSONAL'

export const TRACKING_MODES: readonly TrackingMode[] = ['AGENT', 'MANUAL']
export const TRACKING_METHODS: readonly TrackingMethod[] = ['EMAIL', 'SMS', 'BOTH']
export const DRIVER_SMS_TARGETS: readonly DriverSmsTarget[] = ['WORK_THEN_PERSONAL', 'WORK_ONLY', 'PERSONAL']

export const DEFAULT_DRIVER_SMS_TARGET: DriverSmsTarget = 'WORK_THEN_PERSONAL'

export const TRACKING_MODE_LABELS: Record<TrackingMode, string> = {
  AGENT: 'AI agent tracking',
  MANUAL: 'Manual',
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
}

export interface EffectiveTrackingPrefs {
  /** null = legacy customer with no choice: Step V's switches decide. */
  mode: TrackingMode | null
  /** null = the plan's channels as configured. */
  method: TrackingMethod | null
  driverSms: DriverSmsTarget
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
  return Object.keys(out).length ? out : null
}

/**
 * Write-side validation for `SET_TRACKING_PREFS`: unlike `parseTrackingPrefs` it refuses
 * rather than drops. `null`/`undefined`/`{}` ⇒ null (clear); a key set to null is "inherit".
 */
export function validateTrackingPrefsOverride(raw: unknown): TrackingPrefsOverride | null {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('prefs must be an object or null')
  const o = raw as Record<string, unknown>
  for (const key of Object.keys(o)) {
    if (key !== 'mode' && key !== 'method' && key !== 'driverSms') throw new Error(`Unknown tracking preference: ${key}`)
  }
  const out: TrackingPrefsOverride = {}
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
  shipment?: { trackingPrefs?: unknown } | null
  customer?: CustomerPrefsLike | null
}): EffectiveTrackingPrefs {
  const override = parseTrackingPrefs(i.shipment?.trackingPrefs)
  const c = i.customer ?? null

  const customerMode = pick(c?.trackingMode, TRACKING_MODES)
  const customerMethod = pick(c?.trackingMethod, TRACKING_METHODS)
  const customerSms = pick(c?.driverSmsTarget, DRIVER_SMS_TARGETS)

  return {
    mode: override?.mode ?? customerMode ?? null,
    method: override?.method ?? customerMethod ?? null,
    driverSms: override?.driverSms ?? customerSms ?? DEFAULT_DRIVER_SMS_TARGET,
    source: {
      mode: override?.mode ? 'SHIPMENT' : customerMode ? 'CUSTOMER' : 'DEFAULT',
      method: override?.method ? 'SHIPMENT' : customerMethod ? 'CUSTOMER' : 'DEFAULT',
      driverSms: override?.driverSms ? 'SHIPMENT' : customerSms ? 'CUSTOMER' : 'DEFAULT',
    },
  }
}

/** False only for MANUAL: no automatic request of any kind. A person's action is never gated by this. */
export function allowsAutoRequests(p: Pick<EffectiveTrackingPrefs, 'mode'>): boolean {
  return p.mode !== 'MANUAL'
}

/** Intersect a plan's channels with the method. BOTH/null leave them alone; the result may be empty. */
export function channelsAllowedBy<T extends string>(method: TrackingMethod | null, channels: readonly T[]): T[] {
  if (method === 'EMAIL') return channels.filter((c) => c === 'EMAIL')
  if (method === 'SMS') return channels.filter((c) => c === 'SMS')
  return [...channels]
}
