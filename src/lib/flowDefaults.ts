/**
 * Step P3 — the customer defaults that drive the flow.
 *
 * Three answers live here, and every one of them is the same shape: an org default
 * in `TmsSettings`, optionally narrowed by mode, optionally overridden on the
 * customer. The Lambdas and the UI both import this file so the number a rep sees
 * on the customer page is the number the quoting agent prices with.
 *
 * Ryne, 2026-10-29: target margin 20% by default, configurable by mode (FTL vs
 * LTL) at the org level and overridable per customer (target, floor, auto vs
 * manual reply); required fields default to pickup address, delivery address,
 * bill-to, sales rep and revenue division, and a per-customer list *adds* to that.
 */
import type { CheckCallPlan } from './checkCallPlan'
import { DEFAULT_CHECK_CALL_PLAN, normalizeCheckCallPlan } from './checkCallPlan'

/** The org default Ryne named: 20%. */
export const DEFAULT_MARGIN_TARGET_BPS = 2000

/**
 * The five fields a load must carry before it is Built, as the org asks for them.
 * A customer's own list adds to this; neither list can take one away, because the
 * org's five are what the rest of the system needs to do anything at all.
 */
export const DEFAULT_REQUIRED_LOAD_FIELDS = [
  'pickupAddress',
  'deliveryAddress',
  'billTo',
  'salesRep',
  'revenueDivision',
] as const

/** Every field a required-field list may name, with the label the UI shows. */
export const REQUIRED_FIELD_CATALOG: { key: string; label: string; group: string }[] = [
  { key: 'pickupAddress', label: 'Pickup address', group: 'Stops' },
  { key: 'pickupAppt', label: 'Pickup appointment', group: 'Stops' },
  { key: 'deliveryAddress', label: 'Delivery address', group: 'Stops' },
  { key: 'deliveryAppt', label: 'Delivery appointment', group: 'Stops' },
  { key: 'billTo', label: 'Bill-to party', group: 'Billing' },
  { key: 'customerRate', label: 'Customer rate', group: 'Billing' },
  { key: 'poNumber', label: 'PO number', group: 'References' },
  { key: 'pickupNumber', label: 'Pickup number', group: 'References' },
  { key: 'deliveryNumber', label: 'Delivery number', group: 'References' },
  { key: 'bolNumber', label: 'BOL number', group: 'References' },
  { key: 'salesRep', label: 'Sales rep', group: 'Ownership' },
  { key: 'revenueDivision', label: 'Revenue division', group: 'Ownership' },
  { key: 'carrierRep', label: 'Carrier rep or team', group: 'Ownership' },
  { key: 'equipmentType', label: 'Equipment type', group: 'Freight' },
  { key: 'commodity', label: 'Commodity', group: 'Freight' },
  { key: 'weight', label: 'Weight', group: 'Freight' },
]

const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  REQUIRED_FIELD_CATALOG.map((f) => [f.key, f.label]),
)
const FIELD_ORDER: Record<string, number> = Object.fromEntries(
  REQUIRED_FIELD_CATALOG.map((f, i) => [f.key, i]),
)

/** The label a "Needs: …" line uses, falling back to the raw key for a stale list. */
export function requiredFieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key
}

export interface MarginSettingsSource {
  marginTargetBps?: number | null
  marginTargetBpsByMode?: Record<string, number> | unknown
  marginFloorBps?: number | null
  quoteAutoReplyDefault?: boolean | null
}

export interface CustomerFlowSource {
  marginTargetBps?: number | null
  marginFloorBps?: number | null
  quoteAutoReply?: boolean | null
  requiredLoadFields?: readonly string[] | null
  checkCallPlan?: unknown
  defaultCarrierTeamKey?: string | null
  defaultCarrierRepId?: string | null
}

export interface ResolvedMargin {
  targetBps: number
  floorBps: number
  autoReply: boolean
  /** Where the target came from, so the UI can say "org default" rather than imply a choice. */
  targetSource: 'CUSTOMER' | 'ORG_MODE' | 'ORG' | 'BUILT_IN'
}

function readBpsMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n) && n >= 0 && n < 10000) out[key.toUpperCase()] = Math.round(n)
  }
  return out
}

function usableBps(value: unknown): number | null {
  // `Number(null)` is 0, and 0 is a legal margin — so an unset override would
  // otherwise read as "this customer works for nothing" instead of "inherit".
  // Absent and empty both mean inherit; only a real number is an override.
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  if (n < 0 || n >= 10000) return null
  return Math.round(n)
}

/**
 * The margin a quote for this customer, in this mode, is built with.
 *
 * The floor is never above the target: a floor that beats the target would refuse
 * the very price the settings ask for, so the pair is clamped rather than trusted.
 */
export function resolveMargin(
  settings: MarginSettingsSource | null | undefined,
  customer: CustomerFlowSource | null | undefined,
  mode: string | null | undefined,
): ResolvedMargin {
  const byMode = readBpsMap(settings?.marginTargetBpsByMode)
  const modeKey = (mode ?? '').toUpperCase()
  const customerTarget = usableBps(customer?.marginTargetBps)
  const orgModeTarget = modeKey ? usableBps(byMode[modeKey]) : null
  const orgTarget = usableBps(settings?.marginTargetBps)

  let targetBps = DEFAULT_MARGIN_TARGET_BPS
  let targetSource: ResolvedMargin['targetSource'] = 'BUILT_IN'
  if (customerTarget != null) {
    targetBps = customerTarget
    targetSource = 'CUSTOMER'
  } else if (orgModeTarget != null) {
    targetBps = orgModeTarget
    targetSource = 'ORG_MODE'
  } else if (orgTarget != null) {
    targetBps = orgTarget
    targetSource = 'ORG'
  }

  const floorRaw = usableBps(customer?.marginFloorBps) ?? usableBps(settings?.marginFloorBps) ?? 0
  const floorBps = Math.min(floorRaw, targetBps)

  const autoReply = customer?.quoteAutoReply != null
    ? Boolean(customer.quoteAutoReply)
    : Boolean(settings?.quoteAutoReplyDefault)

  return { targetBps, floorBps, autoReply, targetSource }
}

/**
 * The sell rate a market number turns into at a given margin.
 *
 * Margin, not markup: a 20% margin on a $1,000 buy is $1,250, not $1,200. Rounded
 * to the dollar, because nobody quotes freight in cents.
 */
export function sellRateFromMarket(marketCents: number, targetBps: number): number {
  if (!Number.isFinite(marketCents) || marketCents <= 0) return 0
  const target = Math.max(0, Math.min(9900, Math.round(targetBps)))
  const sell = marketCents / (1 - target / 10000)
  return Math.round(sell / 100) * 100
}

/** The margin, in basis points, a sell/buy pair actually earns. */
export function marginBpsOf(sellCents: number, buyCents: number): number {
  if (!Number.isFinite(sellCents) || sellCents <= 0) return 0
  return Math.round(((sellCents - buyCents) / sellCents) * 10000)
}

/**
 * The required-field list for one customer: the org's list plus the customer's,
 * de-duplicated, in catalog order so two customers never read differently.
 */
export function resolveRequiredFields(
  settings: { defaultRequiredLoadFields?: readonly string[] | null } | null | undefined,
  customer: CustomerFlowSource | null | undefined,
): string[] {
  const org = settings?.defaultRequiredLoadFields?.length
    ? settings.defaultRequiredLoadFields
    : DEFAULT_REQUIRED_LOAD_FIELDS
  const seen = new Set<string>()
  for (const key of [...org, ...(customer?.requiredLoadFields ?? [])]) {
    const trimmed = String(key ?? '').trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen].sort((a, b) => (FIELD_ORDER[a] ?? 999) - (FIELD_ORDER[b] ?? 999) || a.localeCompare(b))
}

/** The check-call plan a load runs on: the load's own, else the customer's, else the org's. */
export function resolveCheckCallPlan(
  settings: { defaultCheckCallPlan?: unknown } | null | undefined,
  customer: CustomerFlowSource | null | undefined,
  load?: { checkCallPlan?: unknown } | null,
): CheckCallPlan {
  return (
    normalizeCheckCallPlan(load?.checkCallPlan)
    ?? normalizeCheckCallPlan(customer?.checkCallPlan)
    ?? normalizeCheckCallPlan(settings?.defaultCheckCallPlan)
    ?? DEFAULT_CHECK_CALL_PLAN
  )
}

export interface RequiredFieldSubject {
  stops?: { type?: string | null; address?: unknown; city?: string | null; state?: string | null; appt?: string | null }[] | null
  billToId?: string | null
  salesRepId?: string | null
  revDivision?: string | null
  carrierRepId?: string | null
  carrierTeamKey?: string | null
  customerRateCents?: number | null
  equipmentType?: string | null
  references?: Record<string, unknown> | null
  freight?: { commodity?: string | null; weightLbs?: number | null } | null
}

function hasAddress(stop: RequiredFieldSubject['stops'] extends (infer S)[] | null | undefined ? S : never): boolean {
  if (!stop) return false
  const addr = stop.address as { street?: string | null; city?: string | null; state?: string | null } | null | undefined
  const city = addr?.city ?? stop.city
  const state = addr?.state ?? stop.state
  return Boolean(String(city ?? '').trim() && String(state ?? '').trim())
}

function reference(subject: RequiredFieldSubject, key: string): boolean {
  const refs = subject.references
  if (!refs || typeof refs !== 'object') return false
  const value = (refs as Record<string, unknown>)[key]
  if (Array.isArray(value)) return value.some((v) => String(v ?? '').trim())
  return Boolean(String(value ?? '').trim())
}

/**
 * Which required fields this shipment still lacks, in list order.
 *
 * A field nobody asked for is never reported; a field in the list that the catalog
 * does not know is reported by its raw key rather than silently dropped, so a typo
 * in a customer's list is visible instead of invisible.
 */
export function missingRequiredFields(subject: RequiredFieldSubject, required: readonly string[]): string[] {
  const stops = subject.stops ?? []
  const pickups = stops.filter((s) => (s?.type ?? 'pickup') !== 'delivery')
  const deliveries = stops.filter((s) => s?.type === 'delivery')
  const missing: string[] = []
  for (const key of required) {
    switch (key) {
      case 'pickupAddress':
        if (!pickups.length || !pickups.every(hasAddress)) missing.push(key)
        break
      case 'deliveryAddress':
        if (!deliveries.length || !deliveries.every(hasAddress)) missing.push(key)
        break
      case 'pickupAppt':
        if (!pickups.length || !pickups.every((s) => String(s?.appt ?? '').trim())) missing.push(key)
        break
      case 'deliveryAppt':
        if (!deliveries.length || !deliveries.every((s) => String(s?.appt ?? '').trim())) missing.push(key)
        break
      case 'billTo':
        if (!String(subject.billToId ?? '').trim()) missing.push(key)
        break
      case 'salesRep':
        if (!String(subject.salesRepId ?? '').trim()) missing.push(key)
        break
      case 'revenueDivision':
        if (!String(subject.revDivision ?? '').trim()) missing.push(key)
        break
      case 'carrierRep':
        if (!String(subject.carrierRepId ?? '').trim() && !String(subject.carrierTeamKey ?? '').trim()) missing.push(key)
        break
      case 'customerRate':
        if (!subject.customerRateCents || subject.customerRateCents <= 0) missing.push(key)
        break
      case 'equipmentType':
        if (!String(subject.equipmentType ?? '').trim()) missing.push(key)
        break
      case 'commodity':
        if (!String(subject.freight?.commodity ?? '').trim()) missing.push(key)
        break
      case 'weight':
        if (!subject.freight?.weightLbs || subject.freight.weightLbs <= 0) missing.push(key)
        break
      case 'poNumber':
        if (!reference(subject, 'po')) missing.push(key)
        break
      case 'pickupNumber':
        if (!reference(subject, 'pickup')) missing.push(key)
        break
      case 'deliveryNumber':
        if (!reference(subject, 'delivery')) missing.push(key)
        break
      case 'bolNumber':
        if (!reference(subject, 'bol')) missing.push(key)
        break
      default:
        // A list naming a field this build does not know: say so rather than pass it.
        missing.push(key)
        break
    }
  }
  return missing
}

/** The sentence the shipment header shows while it is still Building. */
export function needsLine(missing: readonly string[]): string {
  if (!missing.length) return ''
  return `Needs: ${missing.map(requiredFieldLabel).join(', ')}`
}
