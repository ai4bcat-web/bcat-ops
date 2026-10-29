/**
 * tms-directory-actions Lambda handler — Phase 1.
 *
 * Actions:
 *   UPSERT_CUSTOMER, ARCHIVE_CUSTOMER
 *   UPSERT_LOCATION, ARCHIVE_LOCATION
 *   SAVE_DIVISION, SAVE_SETTINGS
 *   PREVIEW_MERGE_LOCATIONS, MERGE_LOCATIONS, RESUME_MERGE
 *
 * Customer/Location/Division/TmsSettings/DirectoryMergeJob are written directly
 * to DynamoDB. Load repoints during merge use the generated AppSync mutation
 * (updateLoad) with IAM auth so subscriptions fire.
 */
import { getAmplifyDataClientConfig, type DataClientEnv } from '@aws-amplify/backend-function/runtime'
import { Amplify } from 'aws-amplify'
import { generateClient } from 'aws-amplify/data'
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  ScanCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { validateCommissionPlans, validatePaySchedule } from '../../../src/lib/commission'
import { teamMembership, validateTeams } from '../../../src/lib/teams'
import { SEED_DIVISIONS, SEED_RULES, validateDivisions, validateRules } from '../../../src/lib/ownership'
import { SEED_VIEWS, slugify, validateView } from '../../../src/lib/shipmentViewDefs'
import type {
  CommissionTrigger,
  OwnershipDivisionRecord,
  OwnershipRuleRecord,
  ShipmentViewFilters,
  ShipmentViewRecord,
  Team,
} from '../../../src/types/tms'

const dynamo = new DynamoDBClient({})
const cognito = new CognitoIdentityProviderClient({})

const TABLE_NAME = process.env.TABLE_NAME ?? ''
const CUSTOMER_TABLE_NAME = process.env.CUSTOMER_TABLE_NAME ?? TABLE_NAME
const LOCATION_TABLE_NAME = process.env.LOCATION_TABLE_NAME ?? TABLE_NAME
const DIVISION_TABLE_NAME = process.env.DIVISION_TABLE_NAME ?? TABLE_NAME
const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME ?? TABLE_NAME
const MERGE_JOB_TABLE_NAME = process.env.MERGE_JOB_TABLE_NAME ?? TABLE_NAME
const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME ?? ''
const USER_PROFILE_TABLE_NAME = process.env.USER_PROFILE_TABLE_NAME ?? ''
// Step R — the self-serve revenue taxonomy and the saved department views. This
// Lambda is their only writer; the client reads the three tables directly.
const OWNERSHIP_DIVISION_TABLE_NAME = process.env.OWNERSHIP_DIVISION_TABLE_NAME ?? ''
const OWNERSHIP_RULE_TABLE_NAME = process.env.OWNERSHIP_RULE_TABLE_NAME ?? ''
const SHIPMENT_VIEW_TABLE_NAME = process.env.SHIPMENT_VIEW_TABLE_NAME ?? ''
const AUDIT_LOG_TABLE_NAME = process.env.AUDIT_LOG_TABLE_NAME ?? ''
const GEOCODE_TOKEN_SECRET = process.env.GEOCODE_TOKEN_SECRET ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
/** Step R: the one BROKERAGE grant. The Shipments page is where loads are built now. */
const TMS_PAGE_GROUP = 'page-tms'

// ── AppSync data client (used only for Load update during merge) ─────────────

// Narrow wrapper around the Amplify data client: this Lambda only uses Load.update.
interface DataClient {
  models: {
    Load: {
      update: (
        input: Record<string, unknown>,
        options?: { condition?: unknown },
      ) => Promise<{ data: Record<string, unknown> | null; errors?: unknown }>
    }
  }
}
let dataClient: DataClient | null = null

async function getDataClient(): Promise<DataClient> {
  if (dataClient) return dataClient
  const env = process.env as unknown as DataClientEnv
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env)
  Amplify.configure(resourceConfig, libraryOptions)
  // Generate the typed Amplify client; cast through unknown because the library's
  // full return type is implementation-internal. This module only uses Load.update.
  dataClient = generateClient() as unknown as DataClient
  return dataClient
}

// ── Types ────────────────────────────────────────────────────────────────────

type Action =
  | 'UPSERT_CUSTOMER'
  | 'SET_CUSTOMER_STATUS'
  | 'UPSERT_LOCATION'
  | 'ARCHIVE_CUSTOMER'
  | 'ARCHIVE_LOCATION'
  | 'SAVE_DIVISION'
  | 'SAVE_SETTINGS'
  | 'PREVIEW_MERGE_LOCATIONS'
  | 'MERGE_LOCATIONS'
  | 'RESUME_MERGE'
  | 'SAVE_OWNERSHIP_DIVISION'
  | 'ARCHIVE_OWNERSHIP_DIVISION'
  | 'SAVE_OWNERSHIP_RULES'
  | 'SAVE_SHIPMENT_VIEW'
  | 'ARCHIVE_SHIPMENT_VIEW'
  | 'ENSURE_OWNERSHIP_SEED'

interface AppSyncIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

interface AppSyncEvent {
  arguments: {
    action: string
    input?: string | Record<string, unknown> | null
  }
  identity?: AppSyncIdentity | null
}

interface Caller {
  email: string
  sub: string
  groups?: string[]
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function getCallerEmail(identity: AppSyncIdentity): Promise<string> {
  const claims = identity.claims ?? {}
  const candidates = [claims.email, identity.username, claims['cognito:username']]
  const found = candidates.find((v): v is string => typeof v === 'string' && v.includes('@'))
  if (found) return found.toLowerCase().trim()
  const lookup = identity.username ?? identity.sub
  if (!lookup) return ''
  try {
    const me = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }))
    return (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
  } catch (err) {
    console.warn('[tms-directory-actions] could not resolve caller email:', String(err))
    return ''
  }
}

function getGroups(identity?: AppSyncIdentity | null): string[] {
  if (!identity) return []
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

async function authorize(action: Action, identity?: AppSyncIdentity | null): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isOwner = email === OWNER_EMAIL
  const isAdmin = groups.includes(ADMIN_GROUP)

  const directoryActions: Partial<Record<Action, true>> = {
    UPSERT_CUSTOMER: true,
    SET_CUSTOMER_STATUS: true,
    ARCHIVE_CUSTOMER: true,
    UPSERT_LOCATION: true,
    ARCHIVE_LOCATION: true,
  }
  // Divisions, rules, views and the seed decide who earns every shipment and what
  // each department sees: shared configuration, owner/ADMIN only, like TMS settings.
  const settingsActions: Partial<Record<Action, true>> = {
    SAVE_DIVISION: true,
    SAVE_SETTINGS: true,
    SAVE_OWNERSHIP_DIVISION: true,
    ARCHIVE_OWNERSHIP_DIVISION: true,
    SAVE_OWNERSHIP_RULES: true,
    SAVE_SHIPMENT_VIEW: true,
    ARCHIVE_SHIPMENT_VIEW: true,
    ENSURE_OWNERSHIP_SEED: true,
  }
  const mergeActions: Partial<Record<Action, true>> = {
    PREVIEW_MERGE_LOCATIONS: true,
    MERGE_LOCATIONS: true,
    RESUME_MERGE: true,
  }

  if (directoryActions[action]) {
    // Anyone who builds loads can create the customer/facility the load needs (inline
    // create) — and from Step R the one Shipments page is where loads are built, so
    // `page-tms` opens the same door `page-loads` always did.
    const ok =
      isOwner || isAdmin ||
      groups.includes('page-customers') || groups.includes('page-locations') ||
      groups.includes('page-loads') || groups.includes(TMS_PAGE_GROUP)
    if (!ok) {
      throw new Error(
        `Forbidden: ${action} requires owner, ADMIN, page-customers, page-locations, page-loads, or ${TMS_PAGE_GROUP}`,
      )
    }
  } else if (settingsActions[action] || mergeActions[action]) {
    // Divisions, TMS settings and merges rewrite shared configuration/history: ADMIN only.
    if (!isOwner && !isAdmin) throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  }

  return { email, sub: identity.sub, groups }
}

// ── Input helpers ──────────────────────────────────────────────────────────────

export function parseInput(input: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (input == null) return {}
  if (typeof input === 'string') {
    if (!input.trim()) return {}
    const parsed: unknown = JSON.parse(input)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Invalid input: must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }
  if (Array.isArray(input) || typeof input !== 'object') throw new Error('Invalid input: must be an object')
  return input
}

function assertDefined<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`${label} is required`)
  return value
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  return trimmed
}

/** Enum columns: a value outside the schema enum breaks the generated list queries for everyone. */
function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | null {
  const v = optionalString(value, 32)
  if (v == null) return null
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${field} must be one of ${allowed.join(', ')}`)
  return v as T
}

function optionalString(value: unknown, maxLen?: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (maxLen != null && trimmed.length > maxLen) throw new Error(`Field exceeds maximum length of ${maxLen}`)
  return trimmed
}

function optionalInteger(value: unknown, options?: { min?: number; max?: number }): number | null {
  if (value == null) return null
  let num: number
  if (typeof value === 'number') num = value
  else if (typeof value === 'string') num = Number(value)
  else throw new Error('Value must be an integer')
  if (!Number.isFinite(num) || !Number.isInteger(num)) throw new Error('Value must be an integer')
  if (options?.min != null && num < options.min) throw new Error(`Value must be at least ${options.min}`)
  if (options?.max != null && num > options.max) throw new Error(`Value must be at most ${options.max}`)
  return num
}

function optionalFloat(value: unknown): number | null {
  if (value == null) return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) throw new Error('Value must be a finite number')
  return num
}

function optionalBoolean(value: unknown): boolean | null {
  if (value == null) return null
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('Value must be a boolean')
}

function optionalStringArray(value: unknown, maxLen?: number): string[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error('Value must be an array')
  return value
    .map((v, i) => {
      if (typeof v !== 'string') throw new Error(`Array element ${i} must be a string`)
      const trimmed = v.trim()
      if (!trimmed) throw new Error(`Array element ${i} cannot be empty`)
      if (maxLen != null && trimmed.length > maxLen) throw new Error(`Array element ${i} exceeds maximum length of ${maxLen}`)
      return trimmed
    })
}

function optionalJsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Value must be a JSON object')
  return value as Record<string, unknown>
}

function optionalJsonArray(value: unknown): unknown[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error('Value must be a JSON array')
  return value
}

function validateAwsIntegerCents(value: unknown, label: string): number | null {
  const num = optionalInteger(value, { min: 0 })
  if (num == null) return null
  if (num < -2_147_483_648 || num > 2_147_483_647) throw new Error(`${label} exceeds GraphQL integer range`)
  return num
}

// ── Customer v2 validators ───────────────────────────────────────────────────

const CUSTOMER_STATUSES = [
  'NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'NURTURING',
  'PENDING', 'ACTIVE', 'DORMANT', 'CLOSED', 'BLOCKED',
] as const
type CustomerStatus = (typeof CUSTOMER_STATUSES)[number]

const CUSTOMER_CONTACT_TYPES = ['PRIMARY', 'BILLING', 'OPERATIONS', 'SALES', 'CLAIMS', 'OTHER'] as const
const CUSTOMER_NOTIFICATIONS = [
  'APPT_SCHEDULED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT',
  'OUT_FOR_DELIVERY', 'UNLOADING', 'DELIVERED', 'INVOICE_SENT',
] as const
const REFERENCE_LEVELS = ['ORDER', 'HANDLING_UNIT', 'PACKAGE', 'STOP'] as const
const CHARGE_CALCS = ['FLAT', 'PER_MILE', 'PER_CWT', 'PERCENT'] as const
const PRICING_MODES = ['MARGIN', 'MARKUP', 'PROFIT'] as const
const INVOICE_FREQUENCIES = ['DAILY', 'TWICE_WEEKLY', 'WEEKLY', 'MONTHLY'] as const

function assertArrayOf<T>(
  value: unknown,
  label: string,
  maxLen: number,
  validate: (item: unknown, index: number) => T,
): T[] | null {
  const arr = optionalJsonArray(value)
  if (arr == null) return null
  if (arr.length > maxLen) throw new Error(`${label} must have at most ${maxLen} elements`)
  return arr.map((item, i) => validate(item, i))
}

function assertRecord(item: unknown, index: number, label: string): Record<string, unknown> {
  if (item == null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`${label} element ${index} must be an object`)
  }
  return item as Record<string, unknown>
}

function assertNonEmptyString(value: unknown, label: string): string {
  const s = assertString(value, label)
  if (!s) throw new Error(`${label} cannot be empty`)
  return s
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((v, i) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} element ${i} must be a non-empty string`)
    return v.trim()
  })
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const s = assertString(value, label)
  if (!(allowed as readonly string[]).includes(s)) throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  return s as T
}

function optionalEnumStrict<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  if (value == null) return null
  return assertEnum(value, allowed, label)
}

function optionalAddress(value: unknown): Record<string, unknown> | null {
  const obj = optionalJsonObject(value)
  if (obj == null) return null
  return {
    street: optionalString(obj.street, 255),
    city: optionalString(obj.city, 100),
    state: optionalString(obj.state, 50),
    zip: optionalString(obj.zip, 20),
    country: optionalString(obj.country, 50),
  }
}

function validateCustomerContacts(value: unknown, billToIds: Set<string>): Record<string, unknown>[] | null {
  return assertArrayOf(value, 'contacts', 100, (item, i) => {
    const c = assertRecord(item, i, 'contacts')
    const id = assertNonEmptyString(c.id, `contacts[${i}].id`)
    const types = assertStringArray(c.types ?? [], `contacts[${i}].types`)
    for (const t of types) {
      if (!CUSTOMER_CONTACT_TYPES.includes(t as (typeof CUSTOMER_CONTACT_TYPES)[number])) {
        throw new Error(`contacts[${i}].types contains invalid value: ${t}`)
      }
    }
    const notifications = assertStringArray(c.notifications ?? [], `contacts[${i}].notifications`)
    for (const n of notifications) {
      if (!CUSTOMER_NOTIFICATIONS.includes(n as (typeof CUSTOMER_NOTIFICATIONS)[number])) {
        throw new Error(`contacts[${i}].notifications contains invalid value: ${n}`)
      }
    }
    const billToId = c.billToId == null ? null : optionalString(c.billToId, 100)
    if (billToId && !billToIds.has(billToId)) {
      throw new Error(`contacts[${i}].billToId references a bill-to not present in this payload`)
    }
    return {
      id,
      name: assertNonEmptyString(c.name, `contacts[${i}].name`),
      email: optionalString(c.email, 254),
      phone: optionalString(c.phone, 50),
      title: optionalString(c.title, 100),
      types,
      billToId,
      notifications,
      active: optionalBoolean(c.active) ?? true,
    }
  })
}

function validateBillToParties(value: unknown): { items: Record<string, unknown>[]; defaultId: string | null; ids: Set<string> } {
  const items = assertArrayOf(value, 'billToParties', 100, (item, i) => {
    const b = assertRecord(item, i, 'billToParties')
    return {
      id: assertNonEmptyString(b.id, `billToParties[${i}].id`),
      name: assertNonEmptyString(b.name, `billToParties[${i}].name`),
      address: optionalAddress(b.address),
      email: optionalString(b.email, 254),
      phone: optionalString(b.phone, 50),
      paymentTermsDays: optionalInteger(b.paymentTermsDays, { min: 0 }),
      isDefault: optionalBoolean(b.isDefault) ?? false,
    }
  })
  const ids = new Set(items?.map((b) => String(b.id)) ?? [])
  const defaults = items?.filter((b) => b.isDefault) ?? []
  if (defaults.length > 1) throw new Error('At most one bill-to party may be default')
  return { items: items ?? [], defaultId: (defaults[0]?.id as string) ?? null, ids }
}

function validateRequiredReferences(value: unknown): Record<string, unknown>[] | null {
  return assertArrayOf(value, 'requiredReferences', 100, (item, i) => {
    const r = assertRecord(item, i, 'requiredReferences')
    const code = assertNonEmptyString(r.code, `requiredReferences[${i}].code`)
    const level = assertEnum(r.level, REFERENCE_LEVELS, `requiredReferences[${i}].level`)
    const count = optionalInteger(r.countOnNewOrder, { min: 0, max: 10 }) ?? 0
    return { code, label: optionalString(r.label, 100), level, display: optionalBoolean(r.display) ?? true, countOnNewOrder: count }
  })
}

function validateChargeCodeOverrides(value: unknown): Record<string, unknown>[] | null {
  return assertArrayOf(value, 'chargeCodeOverrides', 100, (item, i) => {
    const o = assertRecord(item, i, 'chargeCodeOverrides')
    return {
      code: assertNonEmptyString(o.code, `chargeCodeOverrides[${i}].code`),
      display: optionalBoolean(o.display) ?? true,
      customerCode: optionalString(o.customerCode, 50),
      label: optionalString(o.label, 100),
      category: optionalString(o.category, 100),
      calculatedBy: optionalEnumStrict(o.calculatedBy, CHARGE_CALCS, `chargeCodeOverrides[${i}].calculatedBy`),
      defaultAmountCents: validateAwsIntegerCents(o.defaultAmountCents, `chargeCodeOverrides[${i}].defaultAmountCents`),
    }
  })
}

function validateChargeCodes(value: unknown): Record<string, unknown>[] | null {
  return assertArrayOf(value, 'chargeCodes', 1000, (item, i) => {
    const d = assertRecord(item, i, 'chargeCodes')
    return {
      code: assertNonEmptyString(d.code, `chargeCodes[${i}].code`),
      label: assertNonEmptyString(d.label, `chargeCodes[${i}].label`),
      category: optionalString(d.category, 100),
      calculatedBy: assertEnum(d.calculatedBy, CHARGE_CALCS, `chargeCodes[${i}].calculatedBy`),
      defaultAmountCents: validateAwsIntegerCents(d.defaultAmountCents, `chargeCodes[${i}].defaultAmountCents`),
    }
  })
}

function validateDefaultCharges(value: unknown): Record<string, unknown>[] | null {
  return assertArrayOf(value, 'defaultCharges', 100, (item, i) => {
    const d = assertRecord(item, i, 'defaultCharges')
    return {
      code: assertNonEmptyString(d.code, `defaultCharges[${i}].code`),
      amountCents: validateAwsIntegerCents(d.amountCents, `defaultCharges[${i}].amountCents`) ?? 0,
      count: optionalInteger(d.count, { min: 0 }),
    }
  })
}

function validatePricingDefaults(value: unknown): Record<string, unknown> | null {
  const obj = optionalJsonObject(value)
  if (obj == null) return null
  const mode = assertEnum(obj.mode, PRICING_MODES, 'pricingDefaults.mode')
  return {
    mode,
    defaultBps: optionalInteger(obj.defaultBps, { min: 0, max: 10000 }),
    defaultProfitCents: validateAwsIntegerCents(obj.defaultProfitCents, 'pricingDefaults.defaultProfitCents'),
    minProfitCents: validateAwsIntegerCents(obj.minProfitCents, 'pricingDefaults.minProfitCents'),
    maxProfitCents: validateAwsIntegerCents(obj.maxProfitCents, 'pricingDefaults.maxProfitCents'),
    singleChargeCode: optionalString(obj.singleChargeCode, 50),
    distribution: optionalString(obj.distribution, 100),
    gpSplitBps: optionalInteger(obj.gpSplitBps, { min: 0, max: 10000 }),
  }
}

function validateQuotingDefaults(value: unknown): Record<string, unknown> | null {
  const obj = optionalJsonObject(value)
  if (obj == null) return null
  const portalStatusMask = optionalStringArray(obj.portalStatusMask, 50)
  const blockedLtlCarrierIds = optionalStringArray(obj.blockedLtlCarrierIds, 100)
  const selfQuoteCarrierIds = optionalStringArray(obj.selfQuoteCarrierIds, 100)
  return {
    defaultMode: optionalString(obj.defaultMode, 50),
    hoursToQuote: optionalInteger(obj.hoursToQuote, { min: 0 }),
    notes: optionalString(obj.notes, 4000),
    portalLtlDispatchMode: optionalString(obj.portalLtlDispatchMode, 50),
    portalStatusMask,
    blockedLtlCarrierIds,
    selfQuoteCarrierIds,
  }
}

function validateVisibilityPrefs(value: unknown): Record<string, unknown> | null {
  const obj = optionalJsonObject(value)
  if (obj == null) return null
  return {
    milestoneEmails: optionalBoolean(obj.milestoneEmails) ?? false,
    sharedTrackingLink: optionalBoolean(obj.sharedTrackingLink) ?? false,
    shipperPortal: optionalBoolean(obj.shipperPortal) ?? false,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

/** ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly. */
function conflictError(itemLabel: string, cause: unknown): Error {
  const error = new Error(`This ${itemLabel} was changed by someone else — reload and try again.`)
  ;(error as Error & { cause?: unknown }).cause = cause
  return error
}

// ── Normalization ─────────────────────────────────────────────────────────────

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(llc|inc|ltd|llp|corp|co|company|enterprises)\b/g, '')
    .trim()
}

interface AddressShape {
  street?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
}

function normalizeAddress(value: AddressShape | string): string {
  if (typeof value === 'string') {
    return value.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()
  }
  const parts = [value.street, value.city, value.state, value.zip, value.country]
  return parts
    .map((p) => (typeof p === 'string' ? p.toLowerCase().replace(/[^a-z0-9]/g, ' ') : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Geocode token verification ───────────────────────────────────────────────

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function verifyGeocodeToken(token: string): { lat: number; lng: number; placeId: string; geocodedAt: string; geocodeExpiresAt: string } {
  if (!GEOCODE_TOKEN_SECRET) throw new Error('Geocode token secret is not configured')
  if (!token || typeof token !== 'string') throw new Error('Invalid geocode token')
  const parts = token.split('.')
  if (parts.length !== 2) throw new Error('Malformed geocode token')
  const [payloadB64, sigB64] = parts
  const payloadJson = base64UrlDecode(payloadB64).toString('utf8')
  // Same bytes tms-geocode signed: the JSON payload (see tms-geocode/handler.ts signGeocodePayload).
  const computed = createHmac('sha256', GEOCODE_TOKEN_SECRET).update(payloadJson, 'utf8').digest()
  const provided = base64UrlDecode(sigB64)
  if (computed.length !== provided.length || !timingSafeEqual(computed, provided)) {
    throw new Error('Geocode token signature mismatch')
  }
  const payload = JSON.parse(payloadJson) as Record<string, unknown>
  const lat = optionalFloat(payload.lat)
  const lng = optionalFloat(payload.lng)
  const placeId = assertString(String(payload.placeId ?? ''), 'placeId')
  const geocodedAt = assertString(String(payload.geocodedAt ?? ''), 'geocodedAt')
  const geocodeExpiresAt = assertString(String(payload.geocodeExpiresAt ?? ''), 'geocodeExpiresAt')
  if (lat == null || lng == null) throw new Error('Geocode token missing coordinates')
  if (geocodeExpiresAt <= nowIso()) throw new Error('Geocode token has expired')
  return { lat, lng, placeId, geocodedAt, geocodeExpiresAt }
}

// ── DynamoDB helpers ─────────────────────────────────────────────────────────

async function getById(tableName: string, id: string): Promise<Record<string, unknown> | null> {
  if (!tableName) throw new Error('Table name is not configured')
  const result = await dynamo.send(new GetItemCommand({ TableName: tableName, Key: marshall({ id }), ConsistentRead: true }))
  if (!result.Item) return null
  return unmarshall(result.Item)
}

async function getDivisionByKey(key: string): Promise<Record<string, unknown> | null> {
  if (!DIVISION_TABLE_NAME) throw new Error('Division table name is not configured')
  const result = await dynamo.send(new GetItemCommand({ TableName: DIVISION_TABLE_NAME, Key: marshall({ key }), ConsistentRead: true }))
  if (!result.Item) return null
  return unmarshall(result.Item)
}

async function getSettings(): Promise<Record<string, unknown> | null> {
  if (!SETTINGS_TABLE_NAME) throw new Error('Settings table name is not configured')
  const result = await dynamo.send(new GetItemCommand({ TableName: SETTINGS_TABLE_NAME, Key: marshall({ id: 'default' }), ConsistentRead: true }))
  if (!result.Item) return null
  return unmarshall(result.Item)
}

async function scanActiveCustomers(): Promise<Record<string, unknown>[]> {
  if (!CUSTOMER_TABLE_NAME) throw new Error('Customer table name is not configured')
  const items: Record<string, unknown>[] = []
  let lastKey: Record<string, AttributeValue> | undefined
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: CUSTOMER_TABLE_NAME,
        // A Lambda-written row carries mergedIntoId = NULL, and a NULL attribute EXISTS in DynamoDB.
        FilterExpression: '(attribute_not_exists(active) OR active = :active) AND (attribute_not_exists(mergedIntoId) OR mergedIntoId = :noMerge)',
        ExpressionAttributeValues: { ':active': { BOOL: true }, ':noMerge': { NULL: true } },
        ExclusiveStartKey: lastKey,
        Limit: 500,
      }),
    )
    if (result.Items) items.push(...result.Items.map((i) => unmarshall(i)))
    lastKey = result.LastEvaluatedKey
  } while (lastKey)
  return items
}

async function scanActiveLocations(): Promise<Record<string, unknown>[]> {
  if (!LOCATION_TABLE_NAME) throw new Error('Location table name is not configured')
  const items: Record<string, unknown>[] = []
  let lastKey: Record<string, AttributeValue> | undefined
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: LOCATION_TABLE_NAME,
        // A Lambda-written row carries mergedIntoId = NULL, and a NULL attribute EXISTS in DynamoDB.
        FilterExpression: '(attribute_not_exists(active) OR active = :active) AND (attribute_not_exists(mergedIntoId) OR mergedIntoId = :noMerge)',
        ExpressionAttributeValues: { ':active': { BOOL: true }, ':noMerge': { NULL: true } },
        ExclusiveStartKey: lastKey,
        Limit: 500,
      }),
    )
    if (result.Items) items.push(...result.Items.map((i) => unmarshall(i)))
    lastKey = result.LastEvaluatedKey
  } while (lastKey)
  return items
}

async function scanLoads(): Promise<Record<string, unknown>[]> {
  if (!LOAD_TABLE_NAME) throw new Error('Load table name is not configured')
  const items: Record<string, unknown>[] = []
  let lastKey: Record<string, AttributeValue> | undefined
  do {
    const result = await dynamo.send(new ScanCommand({ TableName: LOAD_TABLE_NAME, ExclusiveStartKey: lastKey, Limit: 1000 }))
    if (result.Items) items.push(...result.Items.map((i) => unmarshall(i)))
    lastKey = result.LastEvaluatedKey
  } while (lastKey)
  return items
}

/** `stops` is AWSJSON: a list once AppSync parsed it, but a raw JSON string if a client double-encoded. */
function loadStops(load: Record<string, unknown>): StopShape[] {
  let v = load.stops
  for (let i = 0; i < 4 && typeof v === 'string'; i++) { try { v = JSON.parse(v) } catch { break } }
  return Array.isArray(v) ? v.filter((s): s is StopShape => !!s && typeof s === 'object') : []
}

function hasStopWithLocationId(load: Record<string, unknown>, locationId: string): boolean {
  return loadStops(load).some((s) => s.locationId === locationId)
}

// ── CAS helpers ───────────────────────────────────────────────────────────────

function updatedAtCondition(expectedUpdatedAt: string): { updatedAt: { eq: string } } | { updatedAt: { attributeExists: false } } {
  if (!expectedUpdatedAt) return { updatedAt: { attributeExists: false } }
  return { updatedAt: { eq: expectedUpdatedAt } }
}

function buildDynamoCasCondition(values: Record<string, AttributeValue>, expectedUpdatedAt: string): string {
  values[':casExpectedUpdatedAt'] = { S: expectedUpdatedAt }
  values[':casEmpty'] = { S: '' }
  return '((attribute_exists(updatedAt) AND updatedAt = :casExpectedUpdatedAt) OR (attribute_not_exists(updatedAt) AND :casExpectedUpdatedAt = :casEmpty))'
}

function assertExpectedUpdatedAt(input: Record<string, unknown>): string {
  const value = assertDefined(input.expectedUpdatedAt, 'expectedUpdatedAt')
  if (typeof value !== 'string') throw new Error('expectedUpdatedAt must be a string')
  return value
}

// ── Stop / legacy mirror helpers ──────────────────────────────────────────────

interface StopShape {
  id?: string
  type?: string
  name?: string | null
  city?: string | null
  appt?: string
  apptType?: string | null
  apptEnd?: string | null
  driverId?: string | null
  colorKey?: string | null
  sequence?: number
  locationId?: string | null
  address?: Record<string, unknown> | null
  refs?: unknown[] | null
  contact?: Record<string, unknown> | null
  arrivedAt?: string | null
  departedAt?: string | null
  pieces?: number | null
  weightLbs?: number | null
  instructions?: string | null
  [key: string]: unknown
}

function deriveLegacyFields(stops: StopShape[]): Record<string, unknown> {
  if (stops.length === 0) return {}
  const pickups = stops.filter((s) => s.type === 'pickup').sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const deliveries = stops.filter((s) => s.type === 'delivery').sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const firstPickup = pickups[0] ?? stops[0]
  const lastDelivery = deliveries[deliveries.length - 1] ?? stops[stops.length - 1]
  return {
    pickupAppt: firstPickup.appt ?? '',
    pickupApptEnd: firstPickup.apptEnd ?? null,
    pickupApptType: firstPickup.apptType ?? null,
    deliveryAppt: lastDelivery.appt ?? '',
    deliveryApptEnd: lastDelivery.apptEnd ?? null,
    deliveryApptType: lastDelivery.apptType ?? null,
    originName: firstPickup.name ?? null,
    originCity: firstPickup.city ?? null,
    destinationName: lastDelivery.name ?? null,
    destinationCity: lastDelivery.city ?? null,
    pickupDriverId: firstPickup.driverId ?? null,
    deliveryDriverId: lastDelivery.driverId ?? null,
  }
}

// ── Customer actions ───────────────────────────────────────────────────────────

function isLeadStatus(status: CustomerStatus | null): boolean {
  if (status == null) return false
  return ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'NURTURING'].includes(status)
}

function isInactiveStatus(status: CustomerStatus | null): boolean {
  return status === 'CLOSED' || status === 'BLOCKED'
}

function deriveActiveFromStatus(status: CustomerStatus | null): boolean {
  if (status == null) return true
  return !isInactiveStatus(status)
}

async function upsertCustomer(input: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const name = assertString(input.name, 'name')
  const normalizedName = normalizeName(name)
  const aliases = optionalStringArray(input.aliases, 255)
  const normalizedAliases = aliases?.map(normalizeName) ?? []
  const allNames = [normalizedName, ...normalizedAliases]

  let id: string
  let isCreate = false
  let existing: Record<string, unknown> | null
  if (typeof input.id === 'string' && input.id) {
    id = input.id
    existing = await getById(CUSTOMER_TABLE_NAME, id)
    if (!existing) throw new Error(`Customer not found: ${id}`)
  } else {
    // A create never silently adopts an existing record — the duplicate check below
    // rejects collisions and the client shows its review step with the candidate.
    existing = null
    id = newId()
    isCreate = true
  }

  const existingStatus = (existing?.status as CustomerStatus | undefined) ?? null

  if (existing) {
    if (existing.mergedIntoId) throw new Error('Cannot edit a merged customer')
    // Legacy archived rows (no status, active=false) require explicit reactivation.
    // Once a status exists, active is derived and edits go through SET_CUSTOMER_STATUS.
    if (existingStatus == null && existing.active === false && input.active !== true) {
      throw new Error('Cannot edit an archived customer; unarchive via another action')
    }
  }

  // Status may only change through SET_CUSTOMER_STATUS.
  if (!isCreate && input.status !== undefined) {
    const requested = optionalEnumStrict(input.status, CUSTOMER_STATUSES, 'status')
    if (requested !== existingStatus) {
      throw new Error('Change status with SET_CUSTOMER_STATUS')
    }
  }

  const others = (await scanActiveCustomers()).filter((c) => c.id !== id)
  for (const other of others) {
    const otherNames = [normalizeName(String(other.name ?? '')), ...((other.aliases as string[] | undefined) ?? []).map(normalizeName)]
    if (allNames.some((n) => otherNames.includes(n))) {
      throw new Error(`Duplicate customer name: ${other.name} (id ${other.id}) — pick the existing record or add the name as its alias`)
    }
  }

  // ── JSON array validation (order matters: bill-to IDs are referenced by contacts) ─
  const { items: billToParties, ids: billToIds } = validateBillToParties(input.billToParties)
  const contacts = validateCustomerContacts(input.contacts, billToIds)
  const requiredReferences = validateRequiredReferences(input.requiredReferences)
  const chargeCodeOverrides = validateChargeCodeOverrides(input.chargeCodeOverrides)
  const defaultCharges = validateDefaultCharges(input.defaultCharges)
  const pricingDefaults = validatePricingDefaults(input.pricingDefaults)
  const quotingDefaults = validateQuotingDefaults(input.quotingDefaults)
  const visibilityPrefs = validateVisibilityPrefs(input.visibilityPrefs)

  // ── Admin-only credit fields ───────────────────────────────────────────────
  const isAdmin = caller.email === OWNER_EMAIL || (caller.groups ?? []).includes(ADMIN_GROUP)
  const creditFields = ['creditLimitCents', 'creditHoldFlag', 'freeCreditRequired', 'creditUsageWarningBps', 'maxDaysLate'] as const
  // Step I. `claim-CREDIT_LIMIT_EDIT` is the one claim these fields answer to: a
  // credit manager who is not an admin sets limits, and nothing else admin-only.
  const mayEditCredit = isAdmin || (caller.groups ?? []).includes('claim-CREDIT_LIMIT_EDIT')
  for (const field of creditFields) {
    if (input[field] !== undefined && !mayEditCredit) {
      const existingValue = existing?.[field]
      const requestedValue = field === 'creditLimitCents'
        ? validateAwsIntegerCents(input[field], field)
        : field === 'creditUsageWarningBps'
          ? optionalInteger(input[field], { min: 0, max: 10000 })
          : field === 'maxDaysLate'
            ? optionalInteger(input[field], { min: 0 })
            : optionalBoolean(input[field])
      const coerceBoolean = (field === 'creditHoldFlag' || field === 'freeCreditRequired')
      const normalizedRequested = coerceBoolean ? (requestedValue ?? false) : requestedValue
      const normalizedExisting = coerceBoolean ? (existingValue ?? false) : (existingValue ?? null)
      if (JSON.stringify(normalizedRequested) !== JSON.stringify(normalizedExisting)) {
        throw new Error(`Forbidden: ${field} requires owner or ADMIN`)
      }
    }
  }

  // ── Status defaults and approvals ──────────────────────────────────────────
  const settings = await getSettings()
  const requireApproval = settings?.requireCustomerApproval === true

  let status: CustomerStatus | null = null
  if (isCreate) {
    const requested = optionalEnumStrict(input.status, CUSTOMER_STATUSES, 'status')
    if (requested != null) {
      status = requested
    } else {
      // No status requested: default to ACTIVE, or PENDING if approval is required
      // and the caller is not an owner/admin or primary owner of this account.
      const autoActive = !requireApproval || isAdmin
      status = autoActive ? 'ACTIVE' : 'PENDING'
    }
  }
  // Updates keep existingStatus (status changes are handled by SET_CUSTOMER_STATUS).
  const finalStatus = isCreate ? status : existingStatus
  const active = finalStatus != null ? deriveActiveFromStatus(finalStatus) : (optionalBoolean(input.active) ?? true)

  const now = nowIso()
  const item: Record<string, unknown> = {
    id,
    name,
    contactName: optionalString(input.contactName, 255),
    contactEmail: optionalString(input.contactEmail, 254),
    contactPhone: optionalString(input.contactPhone, 50),
    notes: optionalString(input.notes, 4000),
    mcNumber: optionalString(input.mcNumber, 50),
    dotNumber: optionalString(input.dotNumber, 50),
    billingEmail: optionalString(input.billingEmail, 254),
    billingContactName: optionalString(input.billingContactName, 255),
    billingPhone: optionalString(input.billingPhone, 50),
    billingAddress: optionalJsonObject(input.billingAddress),
    paymentTermsDays: optionalInteger(input.paymentTermsDays, { min: 0 }),
    creditLimitCents: validateAwsIntegerCents(input.creditLimitCents, 'creditLimitCents'),
    creditHoldFlag: optionalBoolean(input.creditHoldFlag),
    requiredDocsForInvoice: optionalStringArray(input.requiredDocsForInvoice, 50),
    defaultDivisionKey: optionalString(input.defaultDivisionKey, 50),
    defaultSalesRepId: optionalString(input.defaultSalesRepId, 100),
    aliases,
    normalizedName,
    active,
    // Unset stays null: the /batory/i name fallback remains in force until an admin decides.
    apptWorkflow: optionalEnum(input.apptWorkflow, ['NONE', 'BATORY'] as const, 'apptWorkflow'),
    mergedIntoId: undefined,

    // Customer v2
    status: finalStatus,
    statusReason: isCreate ? null : (existing?.statusReason as string | undefined) ?? null,
    statusChangedAt: isCreate ? null : (existing?.statusChangedAt as string | undefined) ?? null,
    statusChangedBy: isCreate ? null : (existing?.statusChangedBy as string | undefined) ?? null,
    replacementCustomerId: isCreate ? null : (existing?.replacementCustomerId as string | undefined) ?? null,
    leadSource: optionalString(input.leadSource, 100),
    industry: optionalString(input.industry, 100),
    serviceTier: optionalString(input.serviceTier, 100),
    website: optionalString(input.website, 255),
    freeCreditRequired: optionalBoolean(input.freeCreditRequired),
    creditUsageWarningBps: optionalInteger(input.creditUsageWarningBps, { min: 0, max: 10000 }),
    maxDaysLate: optionalInteger(input.maxDaysLate, { min: 0 }),
    contacts,
    billToParties,
    requiredReferences,
    chargeCodeOverrides,
    defaultCharges,
    pricingDefaults,
    quotingDefaults,
    invoiceFrequency: optionalEnumStrict(input.invoiceFrequency, INVOICE_FREQUENCIES, 'invoiceFrequency'),
    gpSplitBps: optionalInteger(input.gpSplitBps, { min: 0, max: 10000 }),
    rateConTerms: optionalString(input.rateConTerms, 8000),
    visibilityPrefs,
    teamKey: optionalString(input.teamKey, 100),
    operatedById: optionalString(input.operatedById, 100),
    accountOwnerIds: optionalStringArray(input.accountOwnerIds, 100),

    createdBy: isCreate ? caller.email : (existing?.createdBy as string) ?? caller.email,
    updatedBy: caller.email,
    createdAt: isCreate ? now : (existing?.createdAt as string) ?? now,
    updatedAt: now,
  }

  if (isCreate) {
    await dynamo.send(
      new PutItemCommand({
        TableName: CUSTOMER_TABLE_NAME,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
    return item
  }

  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const values: Record<string, AttributeValue> = {}
  const names: Record<string, string> = {}
  const sets: string[] = []
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'createdAt' || key === 'createdBy' || key === 'mergedIntoId') continue
    names[`#${key}`] = key
    values[`:${key}`] = marshall({ [key]: value }, { removeUndefinedValues: true })[key]
    sets.push(`#${key} = :${key}`)
  }
  // mergedIntoId is managed by customer merge (future), not normal edits.

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: CUSTOMER_TABLE_NAME,
        Key: marshall({ id }),
        ConditionExpression: buildDynamoCasCondition(values, expectedUpdatedAt),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error('Customer update failed')
    return unmarshall(result.Attributes)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')) {
      throw conflictError('customer', err)
    }
    throw err
  }
}

async function setCustomerStatus(input: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const id = assertString(input.id, 'id')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const requested = assertEnum(input.status, CUSTOMER_STATUSES, 'status')

  if (requested === 'DORMANT') throw new Error('DORMANT is derived, not a stored status')

  const existing = await getById(CUSTOMER_TABLE_NAME, id)
  if (!existing) throw new Error(`Customer not found: ${id}`)
  if (existing.mergedIntoId) throw new Error('Cannot change status of a merged customer')

  const current = (existing.status as CustomerStatus | undefined) ?? null
  const settings = await getSettings()
  const requireApproval = settings?.requireCustomerApproval === true
  const isAdmin = caller.email === OWNER_EMAIL || (caller.groups ?? []).includes(ADMIN_GROUP)

  // Transition rules
  let nextStatus: CustomerStatus = requested

  if (requested === 'CLOSED' && !isLeadStatus(current)) {
    throw new Error('CLOSED is only allowed from a lead stage')
  }

  if (requested === 'BLOCKED') {
    const reason = assertString(input.reason ?? '', 'reason')
    if (reason.length > 250) throw new Error('reason must be at most 250 characters')
    const replacementId = optionalString(input.replacementCustomerId, 100)
    if (replacementId) {
      if (replacementId === id) throw new Error('replacementCustomerId cannot be the customer itself')
      const replacement = await getById(CUSTOMER_TABLE_NAME, replacementId)
      if (!replacement) throw new Error(`Replacement customer not found: ${replacementId}`)
      if (replacement.mergedIntoId) throw new Error('Replacement customer is merged')
      const replacementStatus = (replacement.status as CustomerStatus | undefined) ?? null
      const replacementActive = replacementStatus != null ? deriveActiveFromStatus(replacementStatus) : replacement.active !== false
      if (!replacementActive) throw new Error('Replacement customer is inactive')
    }
  }

  if (requested === 'ACTIVE') {
    if (current === 'PENDING') {
      if (!isAdmin) throw new Error('PENDING → ACTIVE requires owner or ADMIN')
      nextStatus = 'ACTIVE'
    } else if (current === null || isLeadStatus(current) || current === 'BLOCKED') {
      if (requireApproval && !isAdmin) {
        nextStatus = 'PENDING'
      } else {
        nextStatus = 'ACTIVE'
      }
    } else {
      // ACTIVE → ACTIVE or any other non-terminal transition to ACTIVE is fine.
      nextStatus = 'ACTIVE'
    }
  }

  // Lead stages may transition freely among themselves; nothing extra to enforce.
  // PENDING/BLOCKED/null → ACTIVE handled above. BLOCKED → lead? Plan doesn't mention,
  // so treat as allowed (blocked rows can be reactivated to any open state).

  const now = nowIso()
  const reason = requested === 'BLOCKED' ? assertString(input.reason ?? '', 'reason') : optionalString(input.reason, 250)
  const replacementCustomerId = optionalString(input.replacementCustomerId, 100)
  const statusReason = requested === 'BLOCKED' && reason ? reason : (requested === 'CLOSED' ? reason : null)

  const values: Record<string, AttributeValue> = {
    ':status': { S: nextStatus },
    ':statusReason': statusReason == null ? { NULL: true } : { S: statusReason },
    ':statusChangedAt': { S: now },
    ':statusChangedBy': { S: caller.email },
    ':replacementCustomerId': replacementCustomerId == null ? { NULL: true } : { S: replacementCustomerId },
    ':active': { BOOL: deriveActiveFromStatus(nextStatus) },
    ':updatedAt': { S: now },
    ':updatedBy': { S: caller.email },
  }

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: CUSTOMER_TABLE_NAME,
        Key: marshall({ id }),
        ConditionExpression: buildDynamoCasCondition(values, expectedUpdatedAt),
        UpdateExpression: 'SET #status = :status, statusReason = :statusReason, statusChangedAt = :statusChangedAt, statusChangedBy = :statusChangedBy, replacementCustomerId = :replacementCustomerId, active = :active, updatedAt = :updatedAt, updatedBy = :updatedBy',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error('Customer status update failed')
    return unmarshall(result.Attributes)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')) {
      throw conflictError('customer', err)
    }
    throw err
  }
}

async function archiveCustomer(input: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const id = assertString(input.id, 'id')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const existing = await getById(CUSTOMER_TABLE_NAME, id)
  if (!existing) throw new Error(`Customer not found: ${id}`)
  if (existing.mergedIntoId) throw new Error('Cannot archive a merged customer')

  const values: Record<string, AttributeValue> = {
    ':active': { BOOL: false },
    ':updatedAt': { S: nowIso() },
    ':updatedBy': { S: caller.email },
  }

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: CUSTOMER_TABLE_NAME,
        Key: marshall({ id }),
        ConditionExpression: buildDynamoCasCondition(values, expectedUpdatedAt),
        UpdateExpression: 'SET active = :active, updatedAt = :updatedAt, updatedBy = :updatedBy',
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error('Customer archive failed')
    return unmarshall(result.Attributes)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')) {
      throw conflictError('customer', err)
    }
    throw err
  }
}

// ── Location actions ───────────────────────────────────────────────────────────

async function upsertLocation(input: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const name = assertString(input.name, 'name')
  const customerIds = optionalStringArray(input.customerIds, 100)

  let id: string
  let isCreate = false
  let existing: Record<string, unknown> | null
  if (typeof input.id === 'string' && input.id) {
    id = input.id
    existing = await getById(LOCATION_TABLE_NAME, id)
    if (!existing) throw new Error(`Location not found: ${id}`)
  } else {
    // A create never silently adopts an existing record (a same-name facility in another
    // city is a different place); the duplicate check below rejects real collisions.
    existing = null
    id = newId()
    isCreate = true
  }

  if (existing) {
    if (existing.mergedIntoId) throw new Error('Cannot edit a merged location')
    if (existing.active === false && input.active !== true) {
      throw new Error('Cannot edit an archived location; unarchive via another action')
    }
  }

  if (customerIds && customerIds.length > 0) {
    for (const cid of customerIds) {
      const customer = await getById(CUSTOMER_TABLE_NAME, cid)
      if (!customer) throw new Error(`Linked customer not found: ${cid}`)
      if (customer.active === false) throw new Error(`Linked customer is archived: ${cid}`)
      if (customer.mergedIntoId) throw new Error(`Linked customer is merged: ${cid}`)
    }
  }

  const addressChanged = !!existing && (
    normalizeAddress({
      street: optionalString(input.street, 255), city: optionalString(input.city, 100), state: optionalString(input.state, 50),
      zip: optionalString(input.zip, 20), country: optionalString(input.country, 50) ?? 'US',
    }) !== normalizeAddress(existing as AddressShape)
  )
  const geocodeToken = optionalString(input.geocodeToken)
  const inputLat = optionalFloat(input.lat)
  const inputLng = optionalFloat(input.lng)
  const inputPlaceId = optionalString(input.placeId)
  let lat: number | null
  let lng: number | null
  let placeId: string | null
  let geocodedAt: string | null
  let geocodeExpiresAt: string | null
  if (geocodeToken) {
    // New coordinates: only the values tmsGeocode signed are stored — never client-asserted ones.
    const verified = verifyGeocodeToken(geocodeToken)
    if ((inputLat != null && verified.lat !== inputLat) || (inputLng != null && verified.lng !== inputLng)) {
      throw new Error('Geocode token does not match the supplied coordinates')
    }
    if (inputPlaceId && inputPlaceId !== verified.placeId) throw new Error('Geocode token does not match the supplied placeId')
    lat = verified.lat
    lng = verified.lng
    placeId = verified.placeId
    geocodedAt = verified.geocodedAt
    geocodeExpiresAt = verified.geocodeExpiresAt
  } else if (existing && !addressChanged && (inputLat == null || inputLat === optionalFloat(existing.lat)) && (inputLng == null || inputLng === optionalFloat(existing.lng))) {
    // Editing hours/contacts/etc.: the stored geocode was verified when written; keep it.
    lat = optionalFloat(existing.lat)
    lng = optionalFloat(existing.lng)
    placeId = optionalString(existing.placeId)
    geocodedAt = optionalString(existing.geocodedAt)
    geocodeExpiresAt = optionalString(existing.geocodeExpiresAt)
  } else if (inputLat != null || inputLng != null || inputPlaceId) {
    throw new Error('Geocoded coordinates require a verified geocode token')
  } else {
    // Address changed (or plain postal address): the old pin no longer describes it.
    lat = null
    lng = null
    placeId = null
    geocodedAt = null
    geocodeExpiresAt = null
  }

  const address: AddressShape = {
    street: optionalString(input.street, 255),
    city: optionalString(input.city, 100),
    state: optionalString(input.state, 50),
    zip: optionalString(input.zip, 20),
    country: optionalString(input.country, 50) ?? 'US',
  }
  const normalizedName = normalizeName(name)
  const normalizedAddress = normalizeAddress(address)

  // Same name in the same city, or the same street address, is a collision the client
  // must resolve (pick the existing record / add an alias); same name elsewhere is a
  // different facility.
  const normalizedCity = normalizeName(address.city ?? '')
  // "Has an address" = any real part supplied; `country` defaults to US so it never counts.
  // Without one, normalizedAddress is omitted (a GSI key may not be '' or NULL) and the
  // address-collision check is skipped — name+city is still enforced above.
  const hasAddress = !!(address.street || address.city || address.state || address.zip)
  const effectiveNormalizedAddress = hasAddress ? normalizedAddress : undefined

  const others = (await scanActiveLocations()).filter((l) => l.id !== id)
  for (const other of others) {
    if (normalizedName.length > 0 && normalizeName(String(other.name ?? '')) === normalizedName && normalizeName(String(other.city ?? '')) === normalizedCity) {
      throw new Error(`Duplicate location name in ${address.city ?? 'this city'}: ${other.name} (id ${other.id}) — pick the existing record or add its name as an alias`)
    }
    if (effectiveNormalizedAddress && effectiveNormalizedAddress.length > 0 && normalizeAddress(other as AddressShape) === effectiveNormalizedAddress) {
      throw new Error(`Duplicate location address: ${other.name} (id ${other.id}) — pick the existing record`)
    }
  }

  const now = nowIso()
  const item: Record<string, unknown> = {
    id,
    name,
    city: address.city,
    customerName: optionalString(input.customerName, 255),
    apptContactName: optionalString(input.apptContactName, 255),
    apptContactEmail: optionalString(input.apptContactEmail, 254),
    apptContactPhone: optionalString(input.apptContactPhone, 50),
    notes: optionalString(input.notes, 4000),
    street: address.street,
    state: address.state,
    zip: address.zip,
    country: address.country,
    lat,
    lng,
    timezone: optionalString(input.timezone, 100),
    geohash6: optionalString(input.geohash6, 20),
    placeId,
    geocodedAt,
    geocodeExpiresAt,
    facilityType: optionalEnum(input.facilityType, ['SHIPPER', 'RECEIVER', 'BOTH', 'YARD', 'TRUCK_STOP', 'OTHER'] as const, 'facilityType'),
    hours: optionalString(input.hours, 1000),
    apptRule: optionalEnum(input.apptRule, ['FCFS', 'APPT', 'EITHER'] as const, 'apptRule'),
    apptLeadTimeHours: optionalInteger(input.apptLeadTimeHours, { min: 0 }),
    dockNotes: optionalString(input.dockNotes, 2000),
    lumperNotes: optionalString(input.lumperNotes, 2000),
    detentionNotes: optionalString(input.detentionNotes, 2000),
    contacts: optionalJsonArray(input.contacts),
    customerIds,
    aliases: optionalStringArray(input.aliases, 255),
    normalizedName,
    normalizedAddress: effectiveNormalizedAddress,
    mergedIntoId: undefined,
    mergeJobId: undefined,
    active: optionalBoolean(input.active) ?? true,
    createdBy: isCreate ? caller.email : (existing?.createdBy as string) ?? caller.email,
    updatedBy: caller.email,
    createdAt: isCreate ? now : (existing?.createdAt as string) ?? now,
    updatedAt: now,
  }

  if (isCreate) {
    await dynamo.send(
      new PutItemCommand({
        TableName: LOCATION_TABLE_NAME,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
    return item
  }

  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const values: Record<string, AttributeValue> = {}
  const names: Record<string, string> = {}
  const sets: string[] = []
  const removes: string[] = []
  for (const [key, value] of Object.entries(item)) {
    // mergedIntoId/mergeJobId are managed by MERGE_LOCATIONS, never by a normal edit.
    if (key === 'id' || key === 'createdAt' || key === 'createdBy' || key === 'mergedIntoId' || key === 'mergeJobId') continue
    names[`#${key}`] = key
    if (value === undefined) {
      // A GSI key attribute (normalizedAddress) cannot be SET to NULL or '' — drop it.
      removes.push(`#${key}`)
      continue
    }
    values[`:${key}`] = marshall({ [key]: value }, { removeUndefinedValues: true })[key]
    sets.push(`#${key} = :${key}`)
  }
  const updateExpression = `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: LOCATION_TABLE_NAME,
        Key: marshall({ id }),
        ConditionExpression: buildDynamoCasCondition(values, expectedUpdatedAt),
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error('Location update failed')
    return unmarshall(result.Attributes)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')) {
      throw conflictError('location', err)
    }
    throw err
  }
}

async function archiveLocation(input: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const id = assertString(input.id, 'id')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const existing = await getById(LOCATION_TABLE_NAME, id)
  if (!existing) throw new Error(`Location not found: ${id}`)
  if (existing.mergedIntoId) throw new Error('Cannot archive a merged location')

  const values: Record<string, AttributeValue> = {
    ':active': { BOOL: false },
    ':updatedAt': { S: nowIso() },
    ':updatedBy': { S: caller.email },
  }

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: LOCATION_TABLE_NAME,
        Key: marshall({ id }),
        ConditionExpression: buildDynamoCasCondition(values, expectedUpdatedAt),
        UpdateExpression: 'SET active = :active, updatedAt = :updatedAt, updatedBy = :updatedBy',
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error('Location archive failed')
    return unmarshall(result.Attributes)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')) {
      throw conflictError('location', err)
    }
    throw err
  }
}

// ── Division / Settings ────────────────────────────────────────────────────────

async function saveDivision(input: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const key = assertString(input.key, 'key')
  const name = assertString(input.name, 'name')
  const existing = await getDivisionByKey(key)
  const isCreate = existing == null

  const now = nowIso()
  const item: Record<string, unknown> = {
    id: key,
    key,
    name,
    legalName: optionalString(input.legalName, 255),
    mcNumber: optionalString(input.mcNumber, 50),
    dotNumber: optionalString(input.dotNumber, 50),
    scac: optionalString(input.scac, 10),
    remitToName: optionalString(input.remitToName, 255),
    remitToAddress: optionalJsonObject(input.remitToAddress),
    remitToEmail: optionalString(input.remitToEmail, 254),
    invoicePrefix: optionalString(input.invoicePrefix, 10),
    fleetGroup: optionalEnum(input.fleetGroup, ['LOCAL', 'AMAZON', 'BOX_TRUCK'] as const, 'fleetGroup'),
    active: optionalBoolean(input.active) ?? true,
    createdBy: isCreate ? caller.email : (existing?.createdBy as string) ?? caller.email,
    updatedBy: caller.email,
    createdAt: isCreate ? now : (existing?.createdAt as string) ?? now,
    updatedAt: now,
  }

  if (isCreate) {
    await dynamo.send(
      new PutItemCommand({
        TableName: DIVISION_TABLE_NAME,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(#key)',
        ExpressionAttributeNames: { '#key': 'key' },
      }),
    )
    return item
  }

  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const values: Record<string, AttributeValue> = {}
  const names: Record<string, string> = {}
  const sets: string[] = []
  for (const [k, value] of Object.entries(item)) {
    if (k === 'id' || k === 'key' || k === 'createdAt' || k === 'createdBy') continue
    names[`#${k}`] = k
    values[`:${k}`] = marshall({ [k]: value }, { removeUndefinedValues: true })[k]
    sets.push(`#${k} = :${k}`)
  }

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: DIVISION_TABLE_NAME,
        Key: marshall({ key }),
        ConditionExpression: buildDynamoCasCondition(values, expectedUpdatedAt),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error('Division update failed')
    return unmarshall(result.Attributes)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')) {
      throw conflictError('division', err)
    }
    throw err
  }
}

/**
 * Step I. `UserProfile.teamKeys` is a mirror of the `teams` list the settings card
 * edits — the list is where membership is decided, this is the copy every rep-scoped
 * query reads. Best effort, row by row: a staff row that would not take the write is
 * logged the way the audit write is, and never refuses the settings save that caused it.
 */
async function mirrorTeamKeys(teams: Team[], caller: Caller): Promise<void> {
  if (!USER_PROFILE_TABLE_NAME) return
  const membership = teamMembership(teams)
  try {
    let lastKey: Record<string, AttributeValue> | undefined
    do {
      const result = await dynamo.send(
        new ScanCommand({ TableName: USER_PROFILE_TABLE_NAME, ExclusiveStartKey: lastKey, Limit: 500 }),
      )
      for (const raw of result.Items ?? []) {
        const row = unmarshall(raw)
        const id = typeof row.id === 'string' ? row.id : ''
        if (!id) continue
        const keys = membership[id.trim().toLowerCase()] ?? []
        const current = Array.isArray(row.teamKeys)
          ? row.teamKeys.filter((key): key is string => typeof key === 'string')
          : []
        // Only the rows whose membership actually moved are written.
        if (current.length === keys.length && current.every((key, i) => key === keys[i])) continue
        try {
          await dynamo.send(
            new UpdateItemCommand({
              TableName: USER_PROFILE_TABLE_NAME,
              Key: marshall({ id }),
              UpdateExpression: 'SET teamKeys = :keys, updatedBy = :by, updatedAt = :now',
              ExpressionAttributeValues: marshall({ ':keys': keys, ':by': caller.email, ':now': nowIso() }),
            }),
          )
        } catch (err: unknown) {
          console.warn(`[tms-directory-actions] team mirror failed for ${id}:`, String(err))
        }
      }
      lastKey = result.LastEvaluatedKey
    } while (lastKey)
  } catch (err: unknown) {
    console.warn('[tms-directory-actions] team mirror scan failed:', String(err))
  }
}

async function saveSettings(input: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const id = 'default'
  const existing = await getSettings()
  const isCreate = existing == null

  const now = nowIso()

  /*
   * A field the caller did not mention keeps the value it already had.
   *
   * This used to rebuild the whole record from the input, so every caller had to send every
   * setting or silently erase the ones it left out — which meant any second editor of this
   * record would wipe the first one's fields. `undefined` (absent) now means "leave it
   * alone"; an explicit `null` still clears, which is how the settings card clears a field.
   */
  const keep = <T,>(raw: unknown, parse: (v: unknown) => T, field: string): T | undefined =>
    raw === undefined ? (existing?.[field] as T | undefined) : parse(raw)

  const item: Record<string, unknown> = {
    id,
    marginFloorBps: keep(input.marginFloorBps, (v) => optionalInteger(v, { min: 0 }), 'marginFloorBps'),
    defaultPaymentTermsDays: keep(input.defaultPaymentTermsDays, (v) => optionalInteger(v, { min: 0 }), 'defaultPaymentTermsDays'),
    accessorialCodes: keep(input.accessorialCodes, optionalJsonArray, 'accessorialCodes'),
    loadStatusRules: keep(input.loadStatusRules, optionalJsonObject, 'loadStatusRules'),
    invoiceNumberFormat: keep(input.invoiceNumberFormat, (v) => optionalString(v, 50), 'invoiceNumberFormat'),
    autoClearPastAppts: keep(input.autoClearPastAppts, (v) => (typeof v === 'boolean' ? v : undefined), 'autoClearPastAppts'),

    // Customer v2 org defaults
    defaultCreditLimitCents: keep(input.defaultCreditLimitCents, (v) => validateAwsIntegerCents(v, 'defaultCreditLimitCents'), 'defaultCreditLimitCents'),
    defaultFreeCreditRequired: keep(input.defaultFreeCreditRequired, (v) => (typeof v === 'boolean' ? v : undefined), 'defaultFreeCreditRequired'),
    defaultCreditUsageWarningBps: keep(input.defaultCreditUsageWarningBps, (v) => optionalInteger(v, { min: 0, max: 10000 }), 'defaultCreditUsageWarningBps'),
    defaultMaxDaysLate: keep(input.defaultMaxDaysLate, (v) => optionalInteger(v, { min: 0 }), 'defaultMaxDaysLate'),
    requireCustomerApproval: keep(input.requireCustomerApproval, (v) => (typeof v === 'boolean' ? v : undefined), 'requireCustomerApproval'),
    defaultRequiredDocs: keep(input.defaultRequiredDocs, (v) => optionalStringArray(v, 50), 'defaultRequiredDocs'),
    defaultRequiredReferences: keep(input.defaultRequiredReferences, validateRequiredReferences, 'defaultRequiredReferences'),
    chargeCodes: keep(input.chargeCodes, (v) => validateChargeCodes(v), 'chargeCodes'),
    rateConTerms: keep(input.rateConTerms, (v) => optionalString(v, 8000), 'rateConTerms'),

    // Step I — teams, the two rep-scoped view limits and the commission defaults.
    teams: keep(input.teams, validateTeams, 'teams'),
    limitCustomerRepView: keep(input.limitCustomerRepView, (v) => (typeof v === 'boolean' ? v : undefined), 'limitCustomerRepView'),
    limitCarrierRepView: keep(input.limitCarrierRepView, (v) => (typeof v === 'boolean' ? v : undefined), 'limitCarrierRepView'),
    commissionsEnabled: keep(input.commissionsEnabled, (v) => (typeof v === 'boolean' ? v : undefined), 'commissionsEnabled'),
    commissionTrigger: keep(input.commissionTrigger, (v) => {
      if (v == null) return null
      if (v !== 'GENERATE_INVOICE' && v !== 'INVOICE_PAID') {
        throw new Error('commissionTrigger must be GENERATE_INVOICE or INVOICE_PAID')
      }
      return v as CommissionTrigger
    }, 'commissionTrigger'),
    commissionPlans: keep(input.commissionPlans, validateCommissionPlans, 'commissionPlans'),
    commissionPaySchedule: keep(input.commissionPaySchedule, validatePaySchedule, 'commissionPaySchedule'),
    commissionApprovalAdminOnly: keep(input.commissionApprovalAdminOnly, (v) => (typeof v === 'boolean' ? v : undefined), 'commissionApprovalAdminOnly'),
    commissionPayAdminOnly: keep(input.commissionPayAdminOnly, (v) => (typeof v === 'boolean' ? v : undefined), 'commissionPayAdminOnly'),

    updatedBy: caller.email,
    createdAt: isCreate ? now : (existing?.createdAt as string) ?? now,
    updatedAt: now,
  }

  if (isCreate) {
    await dynamo.send(
      new PutItemCommand({
        TableName: SETTINGS_TABLE_NAME,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
    if (input.teams !== undefined) await mirrorTeamKeys(item.teams as Team[], caller)
    return item
  }

  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const values: Record<string, AttributeValue> = {}
  const names: Record<string, string> = {}
  const sets: string[] = []
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'createdAt') continue
    names[`#${key}`] = key
    values[`:${key}`] = marshall({ [key]: value }, { removeUndefinedValues: true })[key]
    sets.push(`#${key} = :${key}`)
  }

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: SETTINGS_TABLE_NAME,
        Key: marshall({ id: 'default' }),
        ConditionExpression: buildDynamoCasCondition(values, expectedUpdatedAt),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error('Settings update failed')
    if (input.teams !== undefined) await mirrorTeamKeys(item.teams as Team[], caller)
    return unmarshall(result.Attributes)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')) {
      throw conflictError('settings', err)
    }
    throw err
  }
}

// ── Merge actions ──────────────────────────────────────────────────────────────

const MERGE_PAGE_SIZE = 25

async function loadMergeContext(input: Record<string, unknown>): Promise<{
  sourceId: string
  targetId: string
  sourceLoc: Record<string, unknown>
  targetLoc: Record<string, unknown>
  loads: Record<string, unknown>[]
}> {
  const sourceId = assertString(input.sourceId, 'sourceId')
  const targetId = assertString(input.targetId, 'targetId')
  if (sourceId === targetId) throw new Error('Source and target must differ')

  const [sourceLoc, targetLoc] = await Promise.all([
    getById(LOCATION_TABLE_NAME, sourceId),
    getById(LOCATION_TABLE_NAME, targetId),
  ])
  if (!sourceLoc) throw new Error(`Source location not found: ${sourceId}`)
  if (!targetLoc) throw new Error(`Target location not found: ${targetId}`)
  if (sourceLoc.active === false) throw new Error('Source location is archived')
  if (targetLoc.active === false) throw new Error('Target location is archived')
  if (sourceLoc.mergedIntoId) throw new Error('Source location is already merged')
  if (targetLoc.mergedIntoId) throw new Error('Target location is already merged')

  let cursor: string | null = targetId
  const visited = new Set<string>()
  while (cursor) {
    if (visited.has(cursor)) throw new Error('Merge cycle detected')
    visited.add(cursor)
    const next = await getById(LOCATION_TABLE_NAME, cursor)
    cursor = next && typeof next.mergedIntoId === 'string' ? next.mergedIntoId : null
  }
  if (visited.has(sourceId)) throw new Error('Merge cycle detected')

  const loads = (await scanLoads()).filter((l) => hasStopWithLocationId(l, sourceId))
  return { sourceId, targetId, sourceLoc, targetLoc, loads }
}

async function previewMergeLocations(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { sourceId, targetId, loads } = await loadMergeContext(input)
  return { sourceId, targetId, loadCount: loads.length }
}

async function createMergeJob(
  jobId: string,
  sourceId: string,
  targetId: string,
  loadCount: number,
  caller: Caller,
): Promise<Record<string, unknown>> {
  const now = nowIso()
  const item: Record<string, unknown> = {
    id: jobId,
    sourceId,
    targetId,
    status: 'RUNNING',
    processedCount: 0,
    remainingCount: loadCount,
    error: null,
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }
  await dynamo.send(
    new PutItemCommand({
      TableName: MERGE_JOB_TABLE_NAME,
      Item: marshall(item, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(id)',
    }),
  )
  return item
}

async function updateMergeJob(
  jobId: string,
  patch: Record<string, unknown>,
  caller: Caller,
): Promise<Record<string, unknown>> {
  const values: Record<string, AttributeValue> = { ':updatedAt': { S: nowIso() }, ':updatedBy': { S: caller.email } }
  const names: Record<string, string> = { '#updatedAt': 'updatedAt', '#updatedBy': 'updatedBy' }
  const sets: string[] = ['#updatedAt = :updatedAt', '#updatedBy = :updatedBy']
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'createdAt' || key === 'createdBy') continue
    names[`#${key}`] = key
    values[`:${key}`] = marshall({ [key]: value }, { removeUndefinedValues: true })[key]
    sets.push(`#${key} = :${key}`)
  }
  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: MERGE_JOB_TABLE_NAME,
      Key: marshall({ id: jobId }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  )
  if (!result.Attributes) throw new Error('Merge job update failed')
  return unmarshall(result.Attributes)
}

async function freezeSourceLocation(
  sourceId: string,
  targetId: string,
  jobId: string,
  caller: Caller,
  sourceUpdatedAt?: string,
): Promise<void> {
  const values: Record<string, AttributeValue> = {
    ':targetId': { S: targetId },
    ':jobId': { S: jobId },
    ':active': { BOOL: false },
    ':updatedAt': { S: nowIso() },
    ':updatedBy': { S: caller.email },
  }
  values[':noMerge'] = { NULL: true }
  const conditionParts = ['attribute_exists(id)', '(attribute_not_exists(mergedIntoId) OR mergedIntoId = :noMerge)']
  if (sourceUpdatedAt) {
    values[':sourceUpdatedAt'] = { S: sourceUpdatedAt }
    conditionParts.push('updatedAt = :sourceUpdatedAt')
  }
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: LOCATION_TABLE_NAME,
        Key: marshall({ id: sourceId }),
        ConditionExpression: conditionParts.join(' AND '),
        UpdateExpression:
          'SET mergedIntoId = :targetId, mergeJobId = :jobId, active = :active, updatedAt = :updatedAt, updatedBy = :updatedBy',
        ExpressionAttributeValues: values,
      }),
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')) {
      throw conflictError('location', err)
    }
    throw err
  }
}

function buildRepointedStops(load: Record<string, unknown>, sourceId: string, targetId: string): {
  stops: StopShape[]
  derived: Record<string, unknown>
} {
  const stops = loadStops(load)
  const modifiedStops = stops.map((s) =>
    s.locationId === sourceId
      ? {
          ...s,
          locationId: targetId,
          address: { ...(s.address ?? {}), mergedFromLocationId: sourceId },
        }
      : s,
  )
  const derived = deriveLegacyFields(modifiedStops)
  return { stops: modifiedStops, derived }
}

async function repointLoadsPage(
  page: Record<string, unknown>[],
  sourceId: string,
  targetId: string,
  caller: Caller,
  _job: { id: string },
): Promise<void> {
  const client = await getDataClient()
  const maxAttempts = 3
  for (let currentLoad of page) {
    const loadId = String(currentLoad.id)
    let succeeded = false
    let attempts = 0
    while (!succeeded && attempts < maxAttempts) {
      const { stops, derived } = buildRepointedStops(currentLoad, sourceId, targetId)
      const result = await client.models.Load.update(
        {
          id: loadId,
          stops: JSON.stringify(stops),  // AWSJSON travels as a string (same as src/lib/apiClient.ts)
          originName: derived.originName as string | null,
          originCity: derived.originCity as string | null,
          destinationName: derived.destinationName as string | null,
          destinationCity: derived.destinationCity as string | null,
          pickupDriverId: derived.pickupDriverId as string | null,
          deliveryDriverId: derived.deliveryDriverId as string | null,
          pickupAppt: derived.pickupAppt as string,
          deliveryAppt: derived.deliveryAppt as string,
          updatedBy: caller.email,
        },
        { condition: updatedAtCondition(String(currentLoad.updatedAt ?? '')) },
      )
      const rawErrors = result.errors
      const errors = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : []
      if (result.data != null && errors.length === 0) {
        succeeded = true
      } else {
        attempts++
        if (attempts >= maxAttempts) {
          throw new Error(`Load ${loadId} could not be repointed after ${maxAttempts} attempts`)
        }
        const fresh = await getById(LOAD_TABLE_NAME, loadId)
        if (!fresh || !hasStopWithLocationId(fresh, sourceId)) {
          // Already handled by another writer; count as done.
          succeeded = true
        } else {
          currentLoad = fresh
        }
      }
    }
  }
}

async function executeMergeJob(
  job: Record<string, unknown>,
  caller: Caller,
): Promise<Record<string, unknown>> {
  const sourceId = String(job.sourceId)
  const targetId = String(job.targetId)
  const processedBefore = Number(job.processedCount ?? 0)
  const loads = (await scanLoads()).filter((l) => hasStopWithLocationId(l, sourceId))
  const page = loads.slice(0, MERGE_PAGE_SIZE)
  const remainingCount = Math.max(loads.length - page.length, 0)
  try {
    if (page.length > 0) {
      await repointLoadsPage(page, sourceId, targetId, caller, { id: String(job.id) })
    }
    const processedCount = processedBefore + page.length
    return await updateMergeJob(
      String(job.id),
      {
        status: remainingCount > 0 ? 'RUNNING' : 'COMPLETED',
        processedCount,
        remainingCount,
        error: null,
      },
      caller,
    )
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    return await updateMergeJob(
      String(job.id),
      { status: 'FAILED', error, processedCount: processedBefore, remainingCount },
      caller,
    )
  }
}

async function mergeLocations(input: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const { sourceId, targetId, sourceLoc, loads } = await loadMergeContext(input)
  const jobId = newId()
  const job = await createMergeJob(jobId, sourceId, targetId, loads.length, caller)
  try {
    await freezeSourceLocation(sourceId, targetId, jobId, caller, sourceLoc.updatedAt as string | undefined)
  } catch (err: unknown) {
    // Never leave a RUNNING job behind a source that was not frozen.
    await updateMergeJob(jobId, { status: 'FAILED', error: err instanceof Error ? err.message : String(err), remainingCount: loads.length }, caller)
    throw err
  }
  return executeMergeJob(job, caller)
}

async function resumeMerge(input: Record<string, unknown>, caller: Caller): Promise<Record<string, unknown>> {
  const jobId = assertString(input.jobId, 'jobId')
  const job = await getById(MERGE_JOB_TABLE_NAME, jobId)
  if (!job) throw new Error(`Merge job not found: ${jobId}`)
  if (job.status === 'COMPLETED') return job

  const sourceLoc = await getById(LOCATION_TABLE_NAME, String(job.sourceId))
  if (!sourceLoc) throw new Error(`Source location not found: ${job.sourceId}`)
  if (sourceLoc.mergedIntoId !== job.targetId) {
    throw new Error('Source location is not frozen for this merge job')
  }

  return executeMergeJob(job, caller)
}

// ── Step R: revenue ownership taxonomy and department views ───────────────────
//
// `OwnershipDivision`, `OwnershipRule` and `ShipmentView` are data an admin edits —
// the three businesses, Ivan's subsidiaries and the department slices are SEED ROWS,
// not constants. This Lambda is their only writer. The rules decide which division
// earns a shipment, so a broken tree (a cycle, a rule pointing at nothing) would
// silently untag the board: every save is validated against the WHOLE resulting set
// by the same pure functions the client and `tmsShipmentActions` resolve with.
//
// Nothing here deletes. Archiving sets `active false`, so a shipment already tagged
// with a division stays resolvable and a rule that was retired can still be read in
// the history.

/** One audit row per write. Best effort: history must not refuse a saved division. */
async function writeAudit(
  entityType: string,
  entityId: string,
  action: string,
  caller: Caller,
  changes: Record<string, unknown>,
): Promise<void> {
  if (!AUDIT_LOG_TABLE_NAME) return
  const now = nowIso()
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: AUDIT_LOG_TABLE_NAME,
        Item: marshall(
          {
            id: randomUUID(),
            __typename: 'AuditLog',
            entityType,
            entityId,
            action,
            user: caller.email,
            changes: JSON.stringify(changes),
            createdAt: now,
            updatedAt: now,
          },
          { removeUndefinedValues: true },
        ),
      }),
    )
  } catch (err) {
    console.warn('[tms-directory-actions] audit log write failed:', String(err))
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ''
  const msg = err instanceof Error ? err.message : String(err)
  return name === 'ConditionalCheckFailedException' || msg.includes('ConditionalCheckFailed')
}

async function scanTable(tableName: string): Promise<Record<string, unknown>[]> {
  if (!tableName) throw new Error('Table is not configured on this function')
  const items: Record<string, unknown>[] = []
  let startKey: Record<string, AttributeValue> | undefined
  do {
    const page: { Items?: Record<string, AttributeValue>[]; LastEvaluatedKey?: Record<string, AttributeValue> } =
      await dynamo.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }))
    for (const item of page.Items ?? []) items.push(unmarshall(item))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return items
}

/**
 * An `a.json()` column is an AWSJSON string through AppSync but a map when it was
 * written with the raw SDK, and both shapes are on the table. Read either.
 */
function asJson<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed) as T
    } catch {
      return null
    }
  }
  return value as T
}

async function listDivisionRows(): Promise<OwnershipDivisionRecord[]> {
  const rows = await scanTable(OWNERSHIP_DIVISION_TABLE_NAME)
  return rows.map((row) => ({
    ...(row as unknown as OwnershipDivisionRecord),
    owners: asJson(row.owners),
    flows: asJson(row.flows),
  }))
}

async function listRuleRows(): Promise<OwnershipRuleRecord[]> {
  const rows = await scanTable(OWNERSHIP_RULE_TABLE_NAME)
  return rows.map((row) => ({
    ...(row as unknown as OwnershipRuleRecord),
    condition: asJson(row.condition) ?? { kind: 'ALWAYS', value: null },
  }))
}

async function listViewRows(): Promise<ShipmentViewRecord[]> {
  const rows = await scanTable(SHIPMENT_VIEW_TABLE_NAME)
  return rows.map((row) => ({
    ...(row as unknown as ShipmentViewRecord),
    filters: asJson(row.filters) ?? {},
    sort: asJson(row.sort),
    audience: asJson(row.audience),
  }))
}

/** The next free slot at the end of a list, so a new row never lands in the middle. */
function nextSortOrder(rows: { sortOrder?: number | null }[], step: number): number {
  let max = 0
  for (const row of rows) {
    const value = typeof row.sortOrder === 'number' && Number.isFinite(row.sortOrder) ? row.sortOrder : 0
    if (value > max) max = value
  }
  return max + step
}

/**
 * Write a whole row back under its version. There is no `expectedUpdatedAt` on these
 * three tables' client inputs, so the CAS token is the `version` this call just read:
 * a second editor who saved in between bumps it and this write is refused.
 */
async function putVersioned(
  tableName: string,
  item: Record<string, unknown>,
  expectedVersion: number | null,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: expectedVersion == null ? 'attribute_not_exists(id)' : '#version = :expectedVersion',
        ExpressionAttributeNames: expectedVersion == null ? undefined : { '#version': 'version' },
        ExpressionAttributeValues:
          expectedVersion == null ? undefined : { ':expectedVersion': { N: String(expectedVersion) } },
      }),
    )
    return item
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) throw conflictError(label, err)
    throw err
  }
}

/** `active false`, version bumped, nothing removed. The only retirement there is. */
async function archiveVersioned(
  tableName: string,
  id: string,
  existing: { version?: number | null },
  caller: Caller,
  label: string,
): Promise<Record<string, unknown>> {
  const values: Record<string, AttributeValue> = {
    ':active': { BOOL: false },
    ':updatedAt': { S: nowIso() },
    ':updatedBy': { S: caller.email },
    ':version': { N: String((existing.version ?? 0) + 1) },
    ':expectedVersion': { N: String(existing.version ?? 0) },
  }
  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ id }),
        ConditionExpression: '#version = :expectedVersion',
        UpdateExpression: 'SET active = :active, updatedAt = :updatedAt, updatedBy = :updatedBy, #version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error(`${label} archive failed`)
    return unmarshall(result.Attributes)
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) throw conflictError(label, err)
    throw err
  }
}

async function saveOwnershipDivision(
  input: Record<string, unknown>,
  caller: Caller,
): Promise<Record<string, unknown>> {
  const code = assertString(input.code, 'code')
  const name = assertString(input.name, 'name')
  const givenId = optionalString(input.id, 64)
  // The id IS the code, so a rename never orphans a shipment already tagged with it.
  if (givenId != null && givenId !== code) {
    throw new Error("A division's code cannot be changed — archive this one and add the new code.")
  }

  const divisions = await listDivisionRows()
  const existing = divisions.find((d) => d.id === code) ?? null
  if (existing == null && givenId != null) {
    throw new Error(`Division not found: ${givenId}`)
  }
  if (existing != null && givenId == null) {
    throw new Error(`Division code "${code}" already exists — open it to edit it.`)
  }

  const now = nowIso()
  const item: Record<string, unknown> = {
    id: code,
    __typename: 'OwnershipDivision',
    code,
    name,
    brand: optionalString(input.brand, 120),
    parentId: optionalString(input.parentId, 64),
    color: optionalString(input.color, 32),
    sortOrder:
      optionalInteger(input.sortOrder, { min: 0, max: 1_000_000 }) ??
      existing?.sortOrder ??
      nextSortOrder(divisions, 10),
    active: optionalBoolean(input.active) ?? existing?.active ?? true,
    owners: optionalJsonObject(input.owners),
    flows: optionalJsonObject(input.flows),
    createdBy: existing?.createdBy ?? caller.email,
    updatedBy: caller.email,
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  // Validated over the resulting SET, not over this row: a parent that closes a cycle
  // is only visible from the whole tree.
  const next = divisions
    .filter((d) => d.id !== code)
    .concat(item as unknown as OwnershipDivisionRecord)
  const errors = validateDivisions(next)
  if (errors.length > 0) throw new Error(errors.join(' '))

  // Structure is not enough: an active subdivision under an archived parent would
  // tag shipments with a top-level code the sidebar and the dashboards no longer
  // list, because `resolveDivision` reads only the matched row's `active` and then
  // rolls up through `parentId`. Every ancestor has to be active too.
  if (item.active === true) {
    const byId = new Map(next.map((d) => [d.id, d]))
    const seen = new Set<string>([code])
    let parentId = optionalString(item.parentId, 64)
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) break
      if (!parent.active) {
        throw new Error(`"${name}" cannot be active under the archived division "${parent.name}"`)
      }
      parentId = parent.parentId ?? null
    }
  }

  await putVersioned(OWNERSHIP_DIVISION_TABLE_NAME, item, existing ? existing.version ?? 0 : null, 'division')
  await writeAudit('OwnershipDivision', code, 'SAVE_OWNERSHIP_DIVISION', caller, {
    created: existing == null,
    name,
    parentId: item.parentId,
    active: item.active,
  })
  return item
}

async function archiveOwnershipDivision(
  input: Record<string, unknown>,
  caller: Caller,
): Promise<Record<string, unknown>> {
  const id = assertString(input.id, 'id')
  const divisions = await listDivisionRows()
  const existing = divisions.find((d) => d.id === id) ?? null
  if (!existing) throw new Error(`Division not found: ${id}`)

  const child = divisions.find((d) => d.id !== id && d.active && d.parentId === existing.code)
  if (child) {
    throw new Error(
      `"${existing.name}" still has an active subsidiary ("${child.name}") — archive the subsidiary first.`,
    )
  }
  const rules = await listRuleRows()
  const rule = rules.find((r) => r.active && r.divisionCode === existing.code)
  if (rule) {
    throw new Error(
      `An active rule ("${rule.name ?? rule.id}") still tags shipments as "${existing.name}" — change or deactivate it first.`,
    )
  }

  const archived = await archiveVersioned(OWNERSHIP_DIVISION_TABLE_NAME, id, existing, caller, 'division')
  await writeAudit('OwnershipDivision', id, 'ARCHIVE_OWNERSHIP_DIVISION', caller, { name: existing.name })
  return archived
}

/**
 * The whole ordered list, every time. Order IS the rule ("first match wins"), so
 * `sortOrder` is the array index × 10 and a rule left out of the list is deactivated
 * rather than deleted — the history of what tagged a shipment has to stay readable.
 */
async function saveOwnershipRules(
  input: Record<string, unknown>,
  caller: Caller,
): Promise<Record<string, unknown>[]> {
  const rules = optionalJsonArray(input.rules)
  if (rules == null) throw new Error('rules is required')
  if (rules.length > 200) throw new Error('rules cannot hold more than 200 entries')

  const divisions = await listDivisionRows()
  const existingRules = await listRuleRows()
  const priorById = new Map(existingRules.map((r) => [r.id, r]))
  const now = nowIso()
  const seenIds = new Set<string>()

  const items = rules.map((raw, index) => {
    const row = assertRecord(raw, index, 'rules')
    const id = optionalString(row.id, 64) ?? `rule-${randomUUID()}`
    if (seenIds.has(id)) throw new Error(`rules[${index}] repeats the rule id "${id}"`)
    seenIds.add(id)
    const prior = priorById.get(id) ?? null
    const condition = optionalJsonObject(row.condition)
    if (!condition) throw new Error(`rules[${index}].condition is required`)
    return {
      id,
      __typename: 'OwnershipRule',
      name: optionalString(row.name, 120),
      sortOrder: index * 10,
      active: optionalBoolean(row.active) ?? true,
      condition: {
        kind: assertString(condition.kind, `rules[${index}].condition.kind`),
        value: optionalString(condition.value, 400),
      },
      divisionCode: assertString(row.divisionCode, `rules[${index}].divisionCode`),
      createdBy: prior?.createdBy ?? caller.email,
      updatedBy: caller.email,
      version: (prior?.version ?? 0) + 1,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    } as Record<string, unknown>
  })

  const errors = validateRules(items as unknown as OwnershipRuleRecord[], divisions)
  if (errors.length > 0) throw new Error(errors.join(' '))

  for (const item of items) {
    const prior = priorById.get(item.id as string) ?? null
    await putVersioned(OWNERSHIP_RULE_TABLE_NAME, item, prior ? prior.version ?? 0 : null, 'ownership rule')
  }

  const deactivated: string[] = []
  for (const prior of existingRules) {
    if (seenIds.has(prior.id) || !prior.active) continue
    await archiveVersioned(OWNERSHIP_RULE_TABLE_NAME, prior.id, prior, caller, 'ownership rule')
    deactivated.push(prior.id)
  }

  await writeAudit('OwnershipRule', 'list', 'SAVE_OWNERSHIP_RULES', caller, {
    saved: items.map((r) => r.id),
    deactivated,
  })
  return items
}

/** Every clause a saved view may carry. An unknown key is a typo that would filter nothing. */
const SHIPMENT_VIEW_FILTER_KEYS: Record<keyof ShipmentViewFilters, 'list' | 'text' | 'flag'> = {
  divisions: 'list',
  subdivisions: 'list',
  statuses: 'list',
  carrierType: 'text',
  repId: 'text',
  pickupWindow: 'text',
  docsState: 'text',
  trackingState: 'text',
  arStatuses: 'list',
  apStatuses: 'list',
  quoteToBooked: 'flag',
  search: 'text',
}

function validateViewFilters(value: unknown): ShipmentViewFilters {
  const raw = optionalJsonObject(value) ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (entry == null) continue
    const kind = SHIPMENT_VIEW_FILTER_KEYS[key as keyof ShipmentViewFilters]
    if (!kind) throw new Error(`"${key}" is not a shipment filter.`)
    if (kind === 'list') out[key] = optionalStringArray(entry, 64)
    else if (kind === 'flag') out[key] = optionalBoolean(entry)
    else out[key] = optionalString(entry, 200)
  }
  return out as ShipmentViewFilters
}

async function saveShipmentView(
  input: Record<string, unknown>,
  caller: Caller,
): Promise<Record<string, unknown>> {
  const name = assertString(input.name, 'name')
  // The slug IS the id and the URL. A new view gets it from its name; an existing one
  // keeps the one its links already carry.
  const slug = optionalString(input.id, 80) ?? optionalString(input.slug, 80) ?? slugify(name)
  if (!slug) throw new Error('The view needs a name with letters or numbers.')

  const views = await listViewRows()
  const existing = views.find((v) => v.id === slug) ?? null
  const now = nowIso()
  const item: Record<string, unknown> = {
    id: slug,
    __typename: 'ShipmentView',
    slug,
    name,
    department: optionalString(input.department, 80),
    description: optionalString(input.description, 400),
    filters: validateViewFilters(input.filters),
    columns: optionalStringArray(input.columns, 64),
    sort: optionalJsonObject(input.sort),
    isDefault: optionalBoolean(input.isDefault) ?? existing?.isDefault ?? false,
    audience: optionalJsonObject(input.audience),
    sortOrder:
      optionalInteger(input.sortOrder, { min: 0, max: 1_000_000 }) ??
      existing?.sortOrder ??
      nextSortOrder(views, 10),
    active: optionalBoolean(input.active) ?? existing?.active ?? true,
    createdBy: existing?.createdBy ?? caller.email,
    updatedBy: caller.email,
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  const errors = validateView(item as unknown as ShipmentViewRecord)
  if (errors.length > 0) throw new Error(errors.join(' '))

  await putVersioned(SHIPMENT_VIEW_TABLE_NAME, item, existing ? existing.version ?? 0 : null, 'shipment view')
  await writeAudit('ShipmentView', slug, 'SAVE_SHIPMENT_VIEW', caller, {
    created: existing == null,
    name,
    filters: item.filters,
  })
  return item
}

async function archiveShipmentView(
  input: Record<string, unknown>,
  caller: Caller,
): Promise<Record<string, unknown>> {
  const id = assertString(input.id, 'id')
  const existing = await getById(SHIPMENT_VIEW_TABLE_NAME, id)
  if (!existing) throw new Error(`Shipment view not found: ${id}`)
  const archived = await archiveVersioned(
    SHIPMENT_VIEW_TABLE_NAME,
    id,
    existing as { version?: number | null },
    caller,
    'shipment view',
  )
  await writeAudit('ShipmentView', id, 'ARCHIVE_SHIPMENT_VIEW', caller, { name: existing.name ?? null })
  return archived
}

/**
 * The three businesses, Ivan's subsidiaries, the seed rules and the ten department
 * views, written once. `attribute_not_exists(id)` per row makes it idempotent AND
 * safe: a row an admin has since edited or archived is never put back.
 */
async function ensureOwnershipSeed(caller: Caller): Promise<Record<string, unknown>> {
  const now = nowIso()
  const stamp = (row: Record<string, unknown>, typename: string): Record<string, unknown> => ({
    ...row,
    __typename: typename,
    createdBy: 'seed',
    updatedBy: 'seed',
    version: 1,
    createdAt: now,
    updatedAt: now,
  })

  const putIfAbsent = async (tableName: string, item: Record<string, unknown>): Promise<boolean> => {
    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: tableName,
          Item: marshall(item, { removeUndefinedValues: true }),
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      )
      return true
    } catch (err: unknown) {
      if (isConditionalCheckFailed(err)) return false
      throw err
    }
  }

  let divisionsCreated = 0
  for (const division of SEED_DIVISIONS) {
    if (await putIfAbsent(OWNERSHIP_DIVISION_TABLE_NAME, stamp({ ...division }, 'OwnershipDivision'))) {
      divisionsCreated += 1
    }
  }
  let rulesCreated = 0
  for (const rule of SEED_RULES) {
    if (await putIfAbsent(OWNERSHIP_RULE_TABLE_NAME, stamp({ ...rule }, 'OwnershipRule'))) rulesCreated += 1
  }
  let viewsCreated = 0
  for (const view of SEED_VIEWS) {
    if (await putIfAbsent(SHIPMENT_VIEW_TABLE_NAME, stamp({ ...view }, 'ShipmentView'))) viewsCreated += 1
  }

  const report = {
    divisionsCreated,
    rulesCreated,
    viewsCreated,
    divisionsPresent: SEED_DIVISIONS.length,
    rulesPresent: SEED_RULES.length,
    viewsPresent: SEED_VIEWS.length,
  }
  if (divisionsCreated + rulesCreated + viewsCreated > 0) {
    await writeAudit('OwnershipDivision', 'seed', 'ENSURE_OWNERSHIP_SEED', caller, report)
  }
  return report
}

// ── Main handler ───────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent): Promise<Record<string, unknown>> => {
  const action = event.arguments.action as Action
  const caller = await authorize(action, event.identity)
  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'UPSERT_CUSTOMER':
      return upsertCustomer(input, caller)
    case 'SET_CUSTOMER_STATUS':
      return setCustomerStatus(input, caller)
    case 'UPSERT_LOCATION':
      return upsertLocation(input, caller)
    case 'ARCHIVE_CUSTOMER':
      return archiveCustomer(input, caller)
    case 'ARCHIVE_LOCATION':
      return archiveLocation(input, caller)
    case 'SAVE_DIVISION':
      return saveDivision(input, caller)
    case 'SAVE_SETTINGS':
      return saveSettings(input, caller)
    case 'PREVIEW_MERGE_LOCATIONS':
      return previewMergeLocations(input)
    case 'MERGE_LOCATIONS':
      return mergeLocations(input, caller)
    case 'RESUME_MERGE':
      return resumeMerge(input, caller)
    case 'SAVE_OWNERSHIP_DIVISION':
      return saveOwnershipDivision(input, caller)
    case 'ARCHIVE_OWNERSHIP_DIVISION':
      return archiveOwnershipDivision(input, caller)
    case 'SAVE_OWNERSHIP_RULES': {
      // The one action whose payload is a list: order IS the rule, so the whole
      // ordered array goes back. AWSJSON carries an array as happily as an object
      // and `saveOwnershipRules` in apiClient.ts is typed to receive one.
      const rules = await saveOwnershipRules(input, caller)
      return rules as unknown as Record<string, unknown>
    }
    case 'SAVE_SHIPMENT_VIEW':
      return saveShipmentView(input, caller)
    case 'ARCHIVE_SHIPMENT_VIEW':
      return archiveShipmentView(input, caller)
    case 'ENSURE_OWNERSHIP_SEED':
      return ensureOwnershipSeed(caller)
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
