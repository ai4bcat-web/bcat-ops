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
import { createHmac, timingSafeEqual } from 'crypto'

const dynamo = new DynamoDBClient({})
const cognito = new CognitoIdentityProviderClient({})

const TABLE_NAME = process.env.TABLE_NAME ?? ''
const CUSTOMER_TABLE_NAME = process.env.CUSTOMER_TABLE_NAME ?? TABLE_NAME
const LOCATION_TABLE_NAME = process.env.LOCATION_TABLE_NAME ?? TABLE_NAME
const DIVISION_TABLE_NAME = process.env.DIVISION_TABLE_NAME ?? TABLE_NAME
const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME ?? TABLE_NAME
const MERGE_JOB_TABLE_NAME = process.env.MERGE_JOB_TABLE_NAME ?? TABLE_NAME
const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME ?? ''
const GEOCODE_TOKEN_SECRET = process.env.GEOCODE_TOKEN_SECRET ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'

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
  | 'UPSERT_LOCATION'
  | 'ARCHIVE_CUSTOMER'
  | 'ARCHIVE_LOCATION'
  | 'SAVE_DIVISION'
  | 'SAVE_SETTINGS'
  | 'PREVIEW_MERGE_LOCATIONS'
  | 'MERGE_LOCATIONS'
  | 'RESUME_MERGE'

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
    ARCHIVE_CUSTOMER: true,
    UPSERT_LOCATION: true,
    ARCHIVE_LOCATION: true,
  }
  const settingsActions: Partial<Record<Action, true>> = { SAVE_DIVISION: true, SAVE_SETTINGS: true }
  const mergeActions: Partial<Record<Action, true>> = {
    PREVIEW_MERGE_LOCATIONS: true,
    MERGE_LOCATIONS: true,
    RESUME_MERGE: true,
  }

  if (directoryActions[action]) {
    // Anyone who builds loads can create the customer/facility the load needs (inline create).
    const ok = isOwner || isAdmin || groups.includes('page-customers') || groups.includes('page-locations') || groups.includes('page-loads')
    if (!ok) throw new Error(`Forbidden: ${action} requires owner, ADMIN, page-customers, page-locations, or page-loads`)
  } else if (settingsActions[action] || mergeActions[action]) {
    // Divisions, TMS settings and merges rewrite shared configuration/history: ADMIN only.
    if (!isOwner && !isAdmin) throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  }

  return { email, sub: identity.sub }
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

  if (existing) {
    if (existing.mergedIntoId) throw new Error('Cannot edit a merged customer')
    if (existing.active === false && input.active !== true) {
      throw new Error('Cannot edit an archived customer; unarchive via another action')
    }
  }

  const others = (await scanActiveCustomers()).filter((c) => c.id !== id)
  for (const other of others) {
    const otherNames = [normalizeName(String(other.name ?? '')), ...((other.aliases as string[] | undefined) ?? []).map(normalizeName)]
    if (allNames.some((n) => otherNames.includes(n))) {
      throw new Error(`Duplicate customer name: ${other.name} (id ${other.id}) — pick the existing record or add the name as its alias`)
    }
  }

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
    active: optionalBoolean(input.active) ?? true,
    // Unset stays null: the /batory/i name fallback remains in force until an admin decides.
    apptWorkflow: optionalEnum(input.apptWorkflow, ['NONE', 'BATORY'] as const, 'apptWorkflow'),
    mergedIntoId: undefined,
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

// ── Main handler ───────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent): Promise<Record<string, unknown>> => {
  const action = event.arguments.action as Action
  const caller = await authorize(action, event.identity)
  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'UPSERT_CUSTOMER':
      return upsertCustomer(input, caller)
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
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
