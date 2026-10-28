/**
 * tms-carrier-actions Lambda handler — Step C.
 *
 * One writer for the carrier directory: the Carrier profile, its people, where its
 * money goes, and its paperwork. Booking, rate confirmations and dispatch live in
 * tms-shipment-actions — a carrier row never moves a load from here.
 *
 * Actions:
 *   UPSERT_CARRIER, SET_CARRIER_STATUS
 *   UPSERT_CONTACT, ARCHIVE_CONTACT
 *   UPSERT_PAYMENT_METHOD, ARCHIVE_PAYMENT_METHOD
 *   PREPARE_DOCUMENT, COMMIT_DOCUMENT, DELETE_DOCUMENT
 *   SAVE_CARRIER_SETTINGS
 *
 * Carrier/CarrierContact/CarrierPaymentMethod/CarrierDocument/TmsSettings are
 * written with the raw DynamoDB SDK, in a TransactWriteItems whenever more than one
 * row has to move together (the single primary contact, the single preferred payment
 * method). Every edit of an existing row is a compare-and-swap on `updatedAt`, so
 * two people editing the same carrier cannot silently overwrite each other.
 *
 * Money is integer cents and percentages are basis points, everywhere.
 */
import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'

import {
  CARRIER_STATUSES,
  canTransitionCarrierStatus,
  carrierStatusReasonRequired,
  carrierStatusReasonsFor,
} from '../../../src/lib/carrierStatus'
import { normalizeQuickPayTiers } from '../../../src/lib/quickPay'
import { normalizeName } from '../../../src/lib/tmsDirectory'
import type { CarrierStatus, CarrierStatusReason, InsurancePolicy } from '../../../src/types/tms'

const dynamo = new DynamoDBClient({})
const cognito = new CognitoIdentityProviderClient({})
const s3 = new S3Client({})

const TABLE_NAME = process.env.TABLE_NAME ?? ''
const CARRIER_TABLE_NAME = process.env.CARRIER_TABLE_NAME ?? TABLE_NAME
const CARRIER_CONTACT_TABLE_NAME = process.env.CARRIER_CONTACT_TABLE_NAME ?? TABLE_NAME
const CARRIER_PAYMENT_METHOD_TABLE_NAME = process.env.CARRIER_PAYMENT_METHOD_TABLE_NAME ?? TABLE_NAME
const CARRIER_DOCUMENT_TABLE_NAME = process.env.CARRIER_DOCUMENT_TABLE_NAME ?? TABLE_NAME
const LOAD_CARRIER_TABLE_NAME = process.env.LOAD_CARRIER_TABLE_NAME ?? ''
const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME ?? TABLE_NAME
const AUDIT_LOG_TABLE_NAME = process.env.AUDIT_LOG_TABLE_NAME ?? ''
const BUCKET_NAME = process.env.BUCKET_NAME ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const CARRIER_PAGE_GROUP = 'page-carriers'
const SETTINGS_ID = 'default'

// Amplify derives GSI names from the plural model name and the key fields.
const IDX_CARRIERS_BY_NORMALIZED_NAME = 'carriersByNormalizedName'
const IDX_CARRIERS_BY_MC = 'carriersByMcNumber'
const IDX_CARRIERS_BY_DOT = 'carriersByDotNumber'
const IDX_CONTACTS_BY_CARRIER = 'carrierContactsByCarrierId'
const IDX_PAYMENT_METHODS_BY_CARRIER = 'carrierPaymentMethodsByCarrierId'
const IDX_DOCUMENTS_BY_CARRIER = 'carrierDocumentsByCarrierIdAndType'
const IDX_LOAD_CARRIERS_BY_CARRIER = 'loadCarriersByCarrierId'

/** One carrier's certificates. Fifty is well past what a real carrier files. */
const MAX_INSURANCE_POLICIES = 50
/** DynamoDB's own ceiling on a single transaction. */
const MAX_TRANSACT_ITEMS = 100
/** A certificate or a W-9 is a few hundred kilobytes; 25 MB is already generous. */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
/** Long enough for a slow upstream link, short enough that a leaked URL is worthless. */
const UPLOAD_EXPIRY_SECONDS = 300

const PDF_TYPE = 'application/pdf'
const PNG_TYPE = 'image/png'
const JPEG_TYPE = 'image/jpeg'

// ── Types ────────────────────────────────────────────────────────────────────

type Action =
  | 'UPSERT_CARRIER'
  | 'SET_CARRIER_STATUS'
  | 'UPSERT_CONTACT'
  | 'ARCHIVE_CONTACT'
  | 'UPSERT_PAYMENT_METHOD'
  | 'ARCHIVE_PAYMENT_METHOD'
  | 'PREPARE_DOCUMENT'
  | 'COMMIT_DOCUMENT'
  | 'DELETE_DOCUMENT'
  | 'SAVE_CARRIER_SETTINGS'

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
  groups: string[]
  isAdmin: boolean
}

type Row = Record<string, unknown>

// ── Enums (mirrors of the inline schema enums) ───────────────────────────────

const CARRIER_TYPES = ['TL', 'LTL', 'CARTAGE', 'LINEHAUL', 'AIR', 'OCEAN', 'RAIL', 'AGENT'] as const
const AUTHORITY_STATUSES = ['ACTIVE', 'INACTIVE', 'NONE', 'UNKNOWN'] as const
const SAFETY_RATINGS = ['SATISFACTORY', 'CONDITIONAL', 'UNSATISFACTORY', 'NONE', 'UNKNOWN'] as const
const COMPLIANCE_CHECK_STATUSES = ['PASS', 'FAIL', 'INCOMPLETE', 'PARTIAL', 'NONE'] as const
const INSURANCE_POLICY_TYPES = ['AUTO_LIABILITY', 'CARGO', 'GENERAL_LIABILITY', 'WORKERS_COMP', 'OTHER'] as const
const CARRIER_CONTACT_TYPES = [
  'ACCOUNTING', 'AFTER_HOURS', 'CLAIMS', 'DISPATCH', 'DRIVER', 'EMERGENCY', 'MANAGER', 'OWNER',
] as const
const PAYMENT_METHOD_KINDS = ['ACH', 'WIRE', 'CHECK', 'ZELLE', 'VENMO', 'EFT'] as const
const PAYEE_TYPES = ['CARRIER', 'FACTOR'] as const
const PAYMENT_METHOD_STATUSES = ['ACTIVE', 'INACTIVE'] as const
const CARRIER_DOCUMENT_TYPES = [
  'AUTHORITY', 'COI_AUTO', 'COI_CARGO', 'COI_GENERAL', 'W9', 'CARRIER_AGREEMENT',
  'FACTOR_NOA', 'CDL', 'RATE_CON', 'OTHER',
] as const
const BOOKING_REQUIRED_FIELDS = ['COMMODITY', 'DESCRIPTION', 'VALUE', 'WEIGHT'] as const
const RATE_CON_REQUIRED_FIELDS = [
  'DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER', 'TRAILER_NUMBER', 'PICKUP_ETA', 'PLATES', 'VIN',
] as const

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
    console.warn('[tms-carrier-actions] could not resolve caller email:', String(err))
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
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)

  // Org-wide booking rules are not a carrier edit: they decide who every dispatcher
  // may book tomorrow, so they stay with the people who own the configuration.
  const adminActions: Partial<Record<Action, true>> = { SAVE_CARRIER_SETTINGS: true }

  if (adminActions[action]) {
    if (!isAdmin) throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  } else if (!isAdmin && !groups.includes(CARRIER_PAGE_GROUP)) {
    // DELETE_DOCUMENT narrows further inside the action: a page-carriers user may
    // only delete a document they uploaded themselves.
    throw new Error(`Forbidden: ${action} requires owner, ADMIN, or ${CARRIER_PAGE_GROUP}`)
  }

  return { email, sub: identity.sub, groups, isAdmin }
}

// ── Input helpers ────────────────────────────────────────────────────────────

export function parseInput(input: string | Record<string, unknown> | null | undefined): Row {
  if (input == null) return {}
  if (typeof input === 'string') {
    if (!input.trim()) return {}
    const parsed: unknown = JSON.parse(input)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Invalid input: must be a JSON object')
    }
    return parsed as Row
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

function optionalString(value: unknown, maxLen?: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (maxLen != null && trimmed.length > maxLen) throw new Error(`Field exceeds maximum length of ${maxLen}`)
  return trimmed
}

function optionalInteger(value: unknown, options?: { min?: number; max?: number; label?: string }): number | null {
  if (value == null) return null
  const label = options?.label ?? 'Value'
  let num: number
  if (typeof value === 'number') num = value
  else if (typeof value === 'string') num = Number(value)
  else throw new Error(`${label} must be an integer`)
  if (!Number.isFinite(num) || !Number.isInteger(num)) throw new Error(`${label} must be an integer`)
  if (options?.min != null && num < options.min) throw new Error(`${label} must be at least ${options.min}`)
  if (options?.max != null && num > options.max) throw new Error(`${label} must be at most ${options.max}`)
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
  return value.map((v, i) => {
    if (typeof v !== 'string') throw new Error(`Array element ${i} must be a string`)
    const trimmed = v.trim()
    if (!trimmed) throw new Error(`Array element ${i} cannot be empty`)
    if (maxLen != null && trimmed.length > maxLen) throw new Error(`Array element ${i} exceeds maximum length of ${maxLen}`)
    return trimmed
  })
}

function optionalJsonObject(value: unknown): Row | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Value must be a JSON object')
  return value as Row
}

function optionalJsonArray(value: unknown): unknown[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error('Value must be a JSON array')
  return value
}

function assertRecord(item: unknown, index: number, label: string): Row {
  if (item == null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`${label} element ${index} must be an object`)
  }
  return item as Row
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

/** Every member of a stored string array has to be a schema enum member, or the generated list query breaks for everyone. */
function optionalEnumArray<T extends string>(value: unknown, allowed: readonly T[], label: string): T[] | null {
  const arr = optionalStringArray(value, 64)
  if (arr == null) return null
  return arr.map((v, i) => assertEnum(v, allowed, `${label}[${i}]`))
}

function validateAwsIntegerCents(value: unknown, label: string): number | null {
  const num = optionalInteger(value, { min: 0, label })
  if (num == null) return null
  if (num > 2_147_483_647) throw new Error(`${label} exceeds GraphQL integer range`)
  return num
}

function optionalIsoDate(value: unknown, label: string): string | null {
  const text = optionalString(value, 40)
  if (text == null) return null
  if (Number.isNaN(Date.parse(text))) throw new Error(`${label} must be an ISO date`)
  return text
}

function optionalAddress(value: unknown): Row | null {
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

function isConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')
}

// ── Insurance ────────────────────────────────────────────────────────────────

/**
 * Certificates are the one part of the carrier row booking refuses to trust blindly:
 * `effectiveCarrierStatus` reads these dates, so a typo here switches a carrier off.
 */
function validateInsurancePolicies(value: unknown): InsurancePolicy[] | null {
  const arr = optionalJsonArray(value)
  if (arr == null) return null
  if (arr.length > MAX_INSURANCE_POLICIES) {
    throw new Error(`insurancePolicies must have at most ${MAX_INSURANCE_POLICIES} elements`)
  }
  return arr.map((raw, i) => {
    const obj = assertRecord(raw, i, 'insurancePolicies')
    const label = `insurancePolicies[${i}]`
    return {
      // A policy the client built in the browser may arrive without an id; give it one
      // now so later edits can address the same row instead of replacing the list.
      id: optionalString(obj.id, 100) ?? newId(),
      type: assertEnum(obj.type, INSURANCE_POLICY_TYPES, `${label}.type`),
      company: optionalString(obj.company, 255),
      policyNumber: optionalString(obj.policyNumber, 100),
      agentName: optionalString(obj.agentName, 255),
      agentPhone: optionalString(obj.agentPhone, 50),
      limitCents: validateAwsIntegerCents(obj.limitCents, `${label}.limitCents`),
      deductibleCents: validateAwsIntegerCents(obj.deductibleCents, `${label}.deductibleCents`),
      effectiveAt: optionalIsoDate(obj.effectiveAt, `${label}.effectiveAt`),
      expiresAt: optionalIsoDate(obj.expiresAt, `${label}.expiresAt`),
      exclusions: optionalString(obj.exclusions, 2000),
    }
  })
}

// ── DynamoDB helpers ─────────────────────────────────────────────────────────

async function getById(tableName: string, id: string): Promise<Row | null> {
  if (!tableName) throw new Error('Table name is not configured')
  const result = await dynamo.send(new GetItemCommand({ TableName: tableName, Key: marshall({ id }), ConsistentRead: true }))
  return result.Item ? unmarshall(result.Item) : null
}

async function queryIndex(tableName: string, indexName: string, keyName: string, keyValue: string): Promise<Row[]> {
  if (!tableName) throw new Error('Table name is not configured')
  const items: Row[] = []
  let lastKey: Record<string, AttributeValue> | undefined
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: '#k = :v',
        ExpressionAttributeNames: { '#k': keyName },
        ExpressionAttributeValues: { ':v': { S: keyValue } },
        ExclusiveStartKey: lastKey,
      }),
    )
    if (result.Items) items.push(...result.Items.map((i) => unmarshall(i)))
    lastKey = result.LastEvaluatedKey
  } while (lastKey)
  return items
}

function marshallRow(item: Row): Record<string, AttributeValue> {
  return marshall(item, { removeUndefinedValues: true })
}

function putItem(tableName: string, item: Row, guardNew = true): TransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: marshallRow(item),
      ...(guardNew ? { ConditionExpression: 'attribute_not_exists(id)' } : {}),
    },
  }
}

/**
 * Compare-and-swap on `updatedAt`, with the empty string standing for "this row has
 * never been written". Same shape the directory and shipment Lambdas use.
 */
function buildDynamoCasCondition(values: Record<string, AttributeValue>, expectedUpdatedAt: string): string {
  values[':casExpectedUpdatedAt'] = { S: expectedUpdatedAt }
  values[':casEmpty'] = { S: '' }
  return '((attribute_exists(updatedAt) AND updatedAt = :casExpectedUpdatedAt) OR (attribute_not_exists(updatedAt) AND :casExpectedUpdatedAt = :casEmpty))'
}

function assertExpectedUpdatedAt(input: Row): string {
  const value = assertDefined(input.expectedUpdatedAt, 'expectedUpdatedAt')
  if (typeof value !== 'string') throw new Error('expectedUpdatedAt must be a string')
  return value
}

/** Build a SET update for every own key of `patch`, with a CAS guard on updatedAt. */
function updateItemTx(tableName: string, id: string, patch: Row, expectedUpdatedAt: string | null): TransactWriteItem {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const sets: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#${key}`] = key
    values[`:${key}`] = marshallRow({ [key]: value })[key]
    sets.push(`#${key} = :${key}`)
  }
  return {
    Update: {
      TableName: tableName,
      Key: marshall({ id }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(expectedUpdatedAt == null ? {} : { ConditionExpression: buildDynamoCasCondition(values, expectedUpdatedAt) }),
    },
  }
}

async function transact(items: TransactWriteItem[], label: string): Promise<void> {
  if (items.length === 0) return
  if (items.length > MAX_TRANSACT_ITEMS) {
    throw new Error(`${label} needs ${items.length} writes; the transaction limit is ${MAX_TRANSACT_ITEMS}`)
  }
  try {
    await dynamo.send(new TransactWriteItemsCommand({ TransactItems: items }))
  } catch (err) {
    if (isConflict(err)) throw conflictError(label, err)
    throw err
  }
}

/** A single-row CAS update that hands the written row back. */
async function casUpdate(tableName: string, id: string, patch: Row, expectedUpdatedAt: string, label: string): Promise<Row> {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const sets: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    names[`#${key}`] = key
    values[`:${key}`] = marshallRow({ [key]: value })[key]
    sets.push(`#${key} = :${key}`)
  }
  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ id }),
        ConditionExpression: buildDynamoCasCondition(values, expectedUpdatedAt),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    if (!result.Attributes) throw new Error(`${label} update failed`)
    return unmarshall(result.Attributes)
  } catch (err: unknown) {
    if (isConflict(err)) throw conflictError(label, err)
    throw err
  }
}

/**
 * One audit row per write action. Best effort: a carrier that moved must not be
 * reported as failed because the history table rejected a row.
 */
async function writeAudit(entityType: string, entityId: string, action: string, caller: Caller, changes: Row): Promise<void> {
  if (!AUDIT_LOG_TABLE_NAME) return
  const now = nowIso()
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: AUDIT_LOG_TABLE_NAME,
        Item: marshallRow({
          id: randomUUID(),
          __typename: 'AuditLog',
          entityType,
          entityId,
          action,
          user: caller.email,
          changes: JSON.stringify(changes),
          createdAt: now,
          updatedAt: now,
        }),
      }),
    )
  } catch (err) {
    console.warn('[tms-carrier-actions] audit log write failed:', String(err))
  }
}

// ── Carrier ──────────────────────────────────────────────────────────────────

/**
 * Two rows for the same trucking company is how a do-not-use carrier gets booked
 * anyway, so a name, MC or DOT already on file refuses the write and names the row
 * the operator should open instead.
 */
async function assertNoDuplicateCarrier(
  id: string,
  normalizedName: string,
  mcNumber: string | null,
  dotNumber: string | null,
): Promise<void> {
  const checks: { indexName: string; keyName: string; keyValue: string; label: string }[] = [
    { indexName: IDX_CARRIERS_BY_NORMALIZED_NAME, keyName: 'normalizedName', keyValue: normalizedName, label: 'name' },
  ]
  if (mcNumber) checks.push({ indexName: IDX_CARRIERS_BY_MC, keyName: 'mcNumber', keyValue: mcNumber, label: 'MC number' })
  if (dotNumber) checks.push({ indexName: IDX_CARRIERS_BY_DOT, keyName: 'dotNumber', keyValue: dotNumber, label: 'DOT number' })

  for (const check of checks) {
    if (!check.keyValue) continue
    const rows = await queryIndex(CARRIER_TABLE_NAME, check.indexName, check.keyName, check.keyValue)
    const other = rows.find((r) => r.id !== id)
    if (other) {
      throw new Error(
        `Duplicate carrier ${check.label}: ${String(other.name ?? 'unnamed')} (id ${String(other.id)}) — open that carrier instead`,
      )
    }
  }
}

/**
 * Keys an ordinary profile edit never writes: identity, SET_CARRIER_STATUS's status
 * block, and the booking counters BOOK_CARRIER owns — a profile edit must not roll
 * a load count back.
 */
const CARRIER_UPDATE_SKIP: Record<string, true> = {
  id: true,
  createdAt: true,
  createdBy: true,
  status: true,
  statusReason: true,
  statusNote: true,
  statusChangedAt: true,
  statusChangedBy: true,
  loadCount: true,
  lastLoadAt: true,
}

/**
 * Does this tenant insist a carrier be reviewed before it can be booked? Absent
 * settings mean yes: an un-configured tenant keeps the approval queue rather than
 * silently letting anyone mint ACTIVE carriers.
 */
async function carrierApprovalRequired(): Promise<boolean> {
  const settings = await getById(SETTINGS_TABLE_NAME, SETTINGS_ID)
  return settings?.requireCarrierApproval !== false
}

async function upsertCarrier(input: Row, caller: Caller): Promise<Row> {
  const name = assertString(input.name, 'name')
  const normalizedName = normalizeName(name)
  const type = assertEnum(input.type, CARRIER_TYPES, 'type')
  const mcNumber = optionalString(input.mcNumber, 50)
  const dotNumber = optionalString(input.dotNumber, 50)

  let id: string
  let isCreate = false
  let existing: Row | null
  if (typeof input.id === 'string' && input.id) {
    id = input.id
    existing = await getById(CARRIER_TABLE_NAME, id)
    if (!existing) throw new Error(`Carrier not found: ${id}`)
  } else {
    existing = null
    id = newId()
    isCreate = true
  }

  await assertNoDuplicateCarrier(id, normalizedName, mcNumber, dotNumber)

  // A new carrier is unvetted paperwork until somebody looks at it, and who may skip
  // that queue is a tenant decision: with requireCarrierApproval off, anyone on the
  // carriers page may open one already ACTIVE by asking for it. With it on — and when
  // the setting was never saved — only an admin may. Status moves through
  // SET_CARRIER_STATUS afterwards either way.
  const requestedStatus = optionalEnumStrict(input.status, CARRIER_STATUSES, 'status')
  const mayOpenActive = isCreate && requestedStatus === 'ACTIVE'
    && (caller.isAdmin || !(await carrierApprovalRequired()))
  const status: CarrierStatus = isCreate
    ? (mayOpenActive ? 'ACTIVE' : 'PENDING')
    : ((existing?.status as CarrierStatus | undefined) ?? 'PENDING')

  const now = nowIso()
  const item: Row = {
    id,
    __typename: 'Carrier',
    name,
    dbaName: optionalString(input.dbaName, 255),
    normalizedName,
    type,

    status,
    statusReason: null,
    statusNote: null,
    statusChangedAt: now,
    statusChangedBy: caller.email,

    mcNumber,
    dotNumber,
    scac: optionalString(input.scac, 20),
    einNumber: optionalString(input.einNumber, 20),
    inFmcsa: optionalBoolean(input.inFmcsa),
    authorityStatus: optionalEnumStrict(input.authorityStatus, AUTHORITY_STATUSES, 'authorityStatus'),
    authorityGrantedAt: optionalIsoDate(input.authorityGrantedAt, 'authorityGrantedAt'),
    authorityExpiresAt: optionalIsoDate(input.authorityExpiresAt, 'authorityExpiresAt'),
    safetyRating: optionalEnumStrict(input.safetyRating, SAFETY_RATINGS, 'safetyRating'),
    safetyRatingAt: optionalIsoDate(input.safetyRatingAt, 'safetyRatingAt'),
    reviewType: optionalString(input.reviewType, 100),
    reviewedAt: optionalIsoDate(input.reviewedAt, 'reviewedAt'),
    driverInspections: optionalInteger(input.driverInspections, { min: 0, label: 'driverInspections' }),
    driverOos: optionalInteger(input.driverOos, { min: 0, label: 'driverOos' }),
    vehicleInspections: optionalInteger(input.vehicleInspections, { min: 0, label: 'vehicleInspections' }),
    vehicleOos: optionalInteger(input.vehicleOos, { min: 0, label: 'vehicleOos' }),

    insurancePolicies: validateInsurancePolicies(input.insurancePolicies),
    equipment: optionalStringArray(input.equipment, 50),
    cargoTypes: optionalStringArray(input.cargoTypes, 100),
    powerUnits: optionalInteger(input.powerUnits, { min: 0, label: 'powerUnits' }),
    trailerCount: optionalInteger(input.trailerCount, { min: 0, label: 'trailerCount' }),
    driverCount: optionalInteger(input.driverCount, { min: 0, label: 'driverCount' }),

    address: optionalAddress(input.address),
    phone: optionalString(input.phone, 50),
    email: optionalString(input.email, 254),
    website: optionalString(input.website, 255),
    dispatcherName: optionalString(input.dispatcherName, 255),
    dispatcherPhone: optionalString(input.dispatcherPhone, 50),
    dispatcherEmail: optionalString(input.dispatcherEmail, 254),

    paymentTermsDays: optionalInteger(input.paymentTermsDays, { min: 0, label: 'paymentTermsDays' }),
    quickPayEligible: optionalBoolean(input.quickPayEligible),
    defaultQuickPayDays: optionalInteger(input.defaultQuickPayDays, { min: 1, label: 'defaultQuickPayDays' }),
    factorPaymentMethodId: optionalString(input.factorPaymentMethodId, 100),

    highwayStatus: optionalEnumStrict(input.highwayStatus, COMPLIANCE_CHECK_STATUSES, 'highwayStatus'),
    rmisStatus: optionalEnumStrict(input.rmisStatus, COMPLIANCE_CHECK_STATUSES, 'rmisStatus'),
    mcpStatus: optionalString(input.mcpStatus, 100),

    accountOwnerIds: optionalStringArray(input.accountOwnerIds, 100),
    teamKey: optionalString(input.teamKey, 100),
    internalNotes: optionalString(input.internalNotes, 4000),

    loadCount: 0,
    lastLoadAt: null,

    createdBy: isCreate ? caller.email : (existing?.createdBy as string) ?? caller.email,
    updatedBy: caller.email,
    version: ((existing?.version as number | undefined) ?? 0) + 1,
    createdAt: isCreate ? now : (existing?.createdAt as string) ?? now,
    updatedAt: now,
  }

  if (isCreate) {
    await dynamo.send(
      new PutItemCommand({
        TableName: CARRIER_TABLE_NAME,
        Item: marshallRow(item),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
    await writeAudit('CARRIER', id, 'UPSERT_CARRIER', caller, { created: true, name, type, status })
    return item
  }

  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const patch: Row = {}
  for (const [key, value] of Object.entries(item)) {
    if (CARRIER_UPDATE_SKIP[key]) continue
    patch[key] = value
  }

  const saved = await casUpdate(CARRIER_TABLE_NAME, id, patch, expectedUpdatedAt, 'carrier')
  await writeAudit('CARRIER', id, 'UPSERT_CARRIER', caller, { created: false, name, type })
  return saved
}

/**
 * A carrier that just went INACTIVE or DO_NOT_USE may still be sitting on loads that
 * have not rolled yet. Those loads are somebody's phone call, not a machine's: the
 * row is flagged and left alone.
 */
async function flagOpenLoadCarriers(carrierId: string, status: CarrierStatus, caller: Caller): Promise<string[]> {
  if (!LOAD_CARRIER_TABLE_NAME) return []
  const warning = `CARRIER_STATUS_CHANGED:${status}`
  const rows = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_LOAD_CARRIERS_BY_CARRIER, 'carrierId', carrierId)
  const open = rows.filter((row) => row.status === 'ACTIVE' && !row.dispatchedAt)
  const flagged: string[] = []
  const now = nowIso()

  for (const row of open) {
    const current = Array.isArray(row.bookingWarnings)
      ? row.bookingWarnings.filter((w): w is string => typeof w === 'string')
      : []
    if (current.includes(warning)) continue
    const values = marshallRow({
      ':bookingWarnings': [...current, warning],
      ':updatedAt': now,
      ':updatedBy': caller.email,
    })
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: LOAD_CARRIER_TABLE_NAME,
          Key: marshall({ id: String(row.id) }),
          UpdateExpression: 'SET bookingWarnings = :bookingWarnings, updatedAt = :updatedAt, updatedBy = :updatedBy',
          ExpressionAttributeValues: values,
        }),
      )
      flagged.push(String(row.id))
    } catch (err) {
      // The status change is already committed; a failed annotation must not report
      // it as failed. The operator still sees the carrier's new status on the load.
      console.warn('[tms-carrier-actions] could not flag load carrier', String(row.id), String(err))
    }
  }
  return flagged
}

async function setCarrierStatus(input: Row, caller: Caller): Promise<Row> {
  const id = assertString(input.id, 'id')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const status = assertEnum(input.status, CARRIER_STATUSES, 'status')

  const existing = await getById(CARRIER_TABLE_NAME, id)
  if (!existing) throw new Error(`Carrier not found: ${id}`)
  const from = (existing.status as CarrierStatus | undefined) ?? null

  if (!canTransitionCarrierStatus(from, status, caller.isAdmin)) {
    throw new Error(`Cannot move a carrier from ${from ?? 'PENDING'} to ${status}`)
  }

  // Switching a carrier off is always on the record.
  let reason: CarrierStatusReason | null = null
  if (carrierStatusReasonRequired(status)) {
    if (input.reason == null) throw new Error(`reason is required when a carrier moves to ${status}`)
    reason = assertEnum(input.reason, carrierStatusReasonsFor(status), 'reason')
  }
  const note = optionalString(input.note, 250)

  const now = nowIso()
  const patch: Row = {
    status,
    statusReason: reason,
    statusNote: note,
    statusChangedAt: now,
    statusChangedBy: caller.email,
    version: ((existing.version as number | undefined) ?? 0) + 1,
    updatedBy: caller.email,
    updatedAt: now,
  }

  const saved = await casUpdate(CARRIER_TABLE_NAME, id, patch, expectedUpdatedAt, 'carrier')

  const flagged = status === 'INACTIVE' || status === 'DO_NOT_USE'
    ? await flagOpenLoadCarriers(id, status, caller)
    : []

  await writeAudit('CARRIER', id, 'SET_CARRIER_STATUS', caller, { from, to: status, reason, note, flagged })
  return saved
}

// ── Contacts ─────────────────────────────────────────────────────────────────

async function upsertContact(input: Row, caller: Caller): Promise<Row> {
  const carrierId = assertString(input.carrierId, 'carrierId')
  const carrier = await getById(CARRIER_TABLE_NAME, carrierId)
  if (!carrier) throw new Error(`Carrier not found: ${carrierId}`)

  const name = assertString(input.name, 'name')
  const types = optionalEnumArray(input.types, CARRIER_CONTACT_TYPES, 'types')
  const email = optionalString(input.email, 254)
  const phone = optionalString(input.phone, 50)
  const isPrimary = optionalBoolean(input.isPrimary) ?? false
  const active = optionalBoolean(input.active) ?? true

  let id: string
  let isCreate = false
  let existing: Row | null
  if (typeof input.id === 'string' && input.id) {
    id = input.id
    existing = await getById(CARRIER_CONTACT_TABLE_NAME, id)
    if (!existing) throw new Error(`Carrier contact not found: ${id}`)
    if (existing.carrierId !== carrierId) throw new Error('Carrier contact belongs to another carrier')
  } else {
    existing = null
    id = newId()
    isCreate = true
  }

  const now = nowIso()
  const item: Row = {
    id,
    __typename: 'CarrierContact',
    carrierId,
    name,
    types,
    email,
    phone,
    isPrimary,
    rateConRecipient: optionalBoolean(input.rateConRecipient) ?? false,
    active,
    createdBy: isCreate ? caller.email : (existing?.createdBy as string) ?? caller.email,
    updatedBy: caller.email,
    createdAt: isCreate ? now : (existing?.createdAt as string) ?? now,
    updatedAt: now,
  }

  const writes: TransactWriteItem[] = []
  if (isCreate) {
    writes.push(putItem(CARRIER_CONTACT_TABLE_NAME, item))
  } else {
    const expectedUpdatedAt = assertExpectedUpdatedAt(input)
    const patch: Row = {}
    for (const [key, value] of Object.entries(item)) {
      if (key === 'id' || key === 'createdAt' || key === 'createdBy' || key === 'carrierId') continue
      patch[key] = value
    }
    writes.push(updateItemTx(CARRIER_CONTACT_TABLE_NAME, id, patch, expectedUpdatedAt))
  }

  // One primary per carrier: the new primary demotes the old one in the same write,
  // so there is never a moment where the carrier has two or none.
  const siblings = await queryIndex(CARRIER_CONTACT_TABLE_NAME, IDX_CONTACTS_BY_CARRIER, 'carrierId', carrierId)
  if (isPrimary && active) {
    for (const sibling of siblings) {
      if (sibling.id === id || sibling.isPrimary !== true) continue
      writes.push(
        updateItemTx(
          CARRIER_CONTACT_TABLE_NAME,
          String(sibling.id),
          { isPrimary: false, updatedBy: caller.email, updatedAt: now },
          null,
        ),
      )
    }

    // The primary dispatch contact is who the load board calls; mirror them onto the
    // carrier so booking and the rate con do not have to re-read the contact list.
    if (types?.includes('DISPATCH')) {
      writes.push(
        updateItemTx(
          CARRIER_TABLE_NAME,
          carrierId,
          {
            dispatcherName: name,
            dispatcherPhone: phone,
            dispatcherEmail: email,
            updatedBy: caller.email,
            updatedAt: now,
          },
          null,
        ),
      )
    }
  }

  await transact(writes, 'carrier contact')
  const saved = (await getById(CARRIER_CONTACT_TABLE_NAME, id)) ?? item
  await writeAudit('CARRIER_CONTACT', id, 'UPSERT_CONTACT', caller, { carrierId, created: isCreate, name, isPrimary })
  return saved
}

async function archiveContact(input: Row, caller: Caller): Promise<Row> {
  const id = assertString(input.id, 'id')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const existing = await getById(CARRIER_CONTACT_TABLE_NAME, id)
  if (!existing) throw new Error(`Carrier contact not found: ${id}`)

  const now = nowIso()
  // An archived row also gives up primary: a carrier must never be left with a
  // primary contact nobody can call.
  const saved = await casUpdate(
    CARRIER_CONTACT_TABLE_NAME,
    id,
    { active: false, isPrimary: false, updatedBy: caller.email, updatedAt: now },
    expectedUpdatedAt,
    'carrier contact',
  )
  await writeAudit('CARRIER_CONTACT', id, 'ARCHIVE_CONTACT', caller, { carrierId: existing.carrierId, name: existing.name })
  return saved
}

// ── Payment methods ──────────────────────────────────────────────────────────

/** Only the last four digits ever reach this table; the full number lives behind `bankDetailsKey`. */
function optionalLast4(value: unknown, label: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^\d{1,4}$/.test(trimmed)) {
    throw new Error(`${label} must be at most the last 4 digits — never the full number`)
  }
  return trimmed
}

async function upsertPaymentMethod(input: Row, caller: Caller): Promise<Row> {
  const carrierId = assertString(input.carrierId, 'carrierId')
  const carrier = await getById(CARRIER_TABLE_NAME, carrierId)
  if (!carrier) throw new Error(`Carrier not found: ${carrierId}`)

  // Refuse the whole write rather than quietly dropping a full account number: a
  // caller that sent one has to be fixed, not tolerated.
  for (const forbidden of ['accountNumber', 'routingNumber', 'bankAccountNumber'] as const) {
    if (input[forbidden] !== undefined) {
      throw new Error(`${forbidden} is never stored — send accountLast4/routingLast4 and bankDetailsKey instead`)
    }
  }

  const method = assertEnum(input.method, PAYMENT_METHOD_KINDS, 'method')
  const recipientType = assertEnum(input.recipientType, PAYEE_TYPES, 'recipientType')
  const factorName = optionalString(input.factorName, 255)
  if (recipientType === 'FACTOR' && !factorName) {
    throw new Error('factorName is required when the payee is a factor')
  }
  const isPreferred = optionalBoolean(input.isPreferred) ?? false
  const status = optionalEnumStrict(input.status, PAYMENT_METHOD_STATUSES, 'status') ?? 'ACTIVE'

  let id: string
  let isCreate = false
  let existing: Row | null
  if (typeof input.id === 'string' && input.id) {
    id = input.id
    existing = await getById(CARRIER_PAYMENT_METHOD_TABLE_NAME, id)
    if (!existing) throw new Error(`Carrier payment method not found: ${id}`)
    if (existing.carrierId !== carrierId) throw new Error('Carrier payment method belongs to another carrier')
  } else {
    existing = null
    id = newId()
    isCreate = true
  }

  const now = nowIso()
  const item: Row = {
    id,
    __typename: 'CarrierPaymentMethod',
    carrierId,
    method,
    recipientType,
    factorName,
    factorAddress: optionalAddress(input.factorAddress),
    bankName: optionalString(input.bankName, 255),
    accountName: optionalString(input.accountName, 255),
    accountLast4: optionalLast4(input.accountLast4, 'accountLast4'),
    routingLast4: optionalLast4(input.routingLast4, 'routingLast4'),
    bankDetailsKey: optionalString(input.bankDetailsKey, 512),
    payeeEmail: optionalString(input.payeeEmail, 254),
    remitToAddress: optionalAddress(input.remitToAddress),
    isPreferred,
    status,
    createdBy: isCreate ? caller.email : (existing?.createdBy as string) ?? caller.email,
    updatedBy: caller.email,
    createdAt: isCreate ? now : (existing?.createdAt as string) ?? now,
    updatedAt: now,
  }

  const writes: TransactWriteItem[] = []
  if (isCreate) {
    writes.push(putItem(CARRIER_PAYMENT_METHOD_TABLE_NAME, item))
  } else {
    const expectedUpdatedAt = assertExpectedUpdatedAt(input)
    const patch: Row = {}
    for (const [key, value] of Object.entries(item)) {
      if (key === 'id' || key === 'createdAt' || key === 'createdBy' || key === 'carrierId') continue
      patch[key] = value
    }
    writes.push(updateItemTx(CARRIER_PAYMENT_METHOD_TABLE_NAME, id, patch, expectedUpdatedAt))
  }

  // One preferred payee per carrier: AP reads exactly one row when it cuts the check.
  if (isPreferred && status === 'ACTIVE') {
    const siblings = await queryIndex(
      CARRIER_PAYMENT_METHOD_TABLE_NAME,
      IDX_PAYMENT_METHODS_BY_CARRIER,
      'carrierId',
      carrierId,
    )
    for (const sibling of siblings) {
      if (sibling.id === id || sibling.isPreferred !== true) continue
      writes.push(
        updateItemTx(
          CARRIER_PAYMENT_METHOD_TABLE_NAME,
          String(sibling.id),
          { isPreferred: false, updatedBy: caller.email, updatedAt: now },
          null,
        ),
      )
    }
  }

  await transact(writes, 'carrier payment method')
  const saved = (await getById(CARRIER_PAYMENT_METHOD_TABLE_NAME, id)) ?? item
  await writeAudit('CARRIER_PAYMENT_METHOD', id, 'UPSERT_PAYMENT_METHOD', caller, {
    carrierId,
    created: isCreate,
    method,
    recipientType,
    isPreferred,
  })
  return saved
}

async function archivePaymentMethod(input: Row, caller: Caller): Promise<Row> {
  const id = assertString(input.id, 'id')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const existing = await getById(CARRIER_PAYMENT_METHOD_TABLE_NAME, id)
  if (!existing) throw new Error(`Carrier payment method not found: ${id}`)

  const now = nowIso()
  const saved = await casUpdate(
    CARRIER_PAYMENT_METHOD_TABLE_NAME,
    id,
    { status: 'INACTIVE', isPreferred: false, updatedBy: caller.email, updatedAt: now },
    expectedUpdatedAt,
    'carrier payment method',
  )
  await writeAudit('CARRIER_PAYMENT_METHOD', id, 'ARCHIVE_PAYMENT_METHOD', caller, {
    carrierId: existing.carrierId,
    method: existing.method,
  })
  return saved
}

// ── Documents ────────────────────────────────────────────────────────────────

function assertDocumentContentType(value: unknown): string {
  const raw = assertString(value, 'contentType').toLowerCase()
  if (raw === PDF_TYPE) return PDF_TYPE
  if (raw === PNG_TYPE) return PNG_TYPE
  if (raw === JPEG_TYPE || raw === 'image/jpg') return JPEG_TYPE
  throw new Error('contentType must be application/pdf, image/png, or image/jpeg')
}

function assertDocumentSize(value: unknown): number {
  const size = optionalInteger(value, { min: 1, max: MAX_DOCUMENT_BYTES, label: 'sizeBytes' })
  if (size == null) throw new Error('sizeBytes is required')
  return size
}

/** `carrier-docs/{carrierId}/{uuid}-{safeName}` — the uuid makes two files of the same name two objects. */
function buildDocumentKey(carrierId: string, name: string, contentType: string): string {
  let ext: string
  if (contentType === PDF_TYPE) ext = 'pdf'
  else if (contentType === PNG_TYPE) ext = 'png'
  else ext = 'jpg'

  const basePart = name.split(/[\\/]/).pop() ?? name
  let cleaned = basePart.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '')
  if (!cleaned) cleaned = 'document'
  const base = cleaned.replace(/\.[^.]+$/, '').slice(0, 120)

  return `carrier-docs/${carrierId}/${randomUUID()}-${base}.${ext}`
}

async function prepareDocument(input: Row): Promise<Row> {
  if (!BUCKET_NAME) throw new Error('Bucket name is not configured')
  const carrierId = assertString(input.carrierId, 'carrierId')
  const carrier = await getById(CARRIER_TABLE_NAME, carrierId)
  if (!carrier) throw new Error(`Carrier not found: ${carrierId}`)

  assertEnum(input.type, CARRIER_DOCUMENT_TYPES, 'type')
  const name = assertString(input.name, 'name')
  const contentType = assertDocumentContentType(input.contentType)
  const sizeBytes = assertDocumentSize(input.sizeBytes)

  const s3Key = buildDocumentKey(carrierId, name, contentType)
  // The signature pins type and length, so the URL cannot be reused to drop something
  // else in the bucket, and COMMIT_DOCUMENT verifies the same two values afterwards.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key, ContentType: contentType, ContentLength: sizeBytes }),
    { expiresIn: UPLOAD_EXPIRY_SECONDS },
  )

  // No audit row: PREPARE writes nothing. COMMIT_DOCUMENT records the document.
  return { uploadUrl, s3Key }
}

async function commitDocument(input: Row, caller: Caller): Promise<Row> {
  if (!BUCKET_NAME) throw new Error('Bucket name is not configured')
  const carrierId = assertString(input.carrierId, 'carrierId')
  const carrier = await getById(CARRIER_TABLE_NAME, carrierId)
  if (!carrier) throw new Error(`Carrier not found: ${carrierId}`)

  const type = assertEnum(input.type, CARRIER_DOCUMENT_TYPES, 'type')
  const name = assertString(input.name, 'name')
  const s3Key = assertString(input.s3Key, 's3Key')
  const contentType = assertDocumentContentType(input.contentType)
  const sizeBytes = assertDocumentSize(input.sizeBytes)
  const expiresAt = optionalIsoDate(input.expiresAt, 'expiresAt')
  const loadCarrierId = optionalString(input.loadCarrierId, 100)

  const prefix = `carrier-docs/${carrierId}/`
  if (!s3Key.startsWith(prefix)) throw new Error('s3Key does not belong to this carrier')

  // A client that retries the commit after a dropped response must not end up with
  // the same file listed twice.
  const existingDocs = await queryIndex(CARRIER_DOCUMENT_TABLE_NAME, IDX_DOCUMENTS_BY_CARRIER, 'carrierId', carrierId)
  const already = existingDocs.find((doc) => doc.s3Key === s3Key)
  if (already) return already

  let head
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key }))
  } catch (err) {
    const errName = err && typeof err === 'object' && 'name' in err ? err.name : undefined
    if (errName === 'NotFound' || errName === 'NoSuchKey') {
      // `new Error(msg, { cause })` needs a newer lib than this function's tsconfig targets.
      const retryable = new Error('The upload has not landed in S3 yet — wait a moment and commit the document again.')
      ;(retryable as Error & { cause?: unknown }).cause = err
      throw retryable
    }
    throw err
  }
  if (head.ContentLength !== sizeBytes) {
    throw new Error(`Document size mismatch: expected ${sizeBytes} bytes, found ${head.ContentLength ?? 0}`)
  }
  if (head.ContentType !== contentType) {
    throw new Error(`Document content type mismatch: expected ${contentType}, found ${head.ContentType ?? 'none'}`)
  }

  const now = nowIso()
  const item: Row = {
    id: newId(),
    __typename: 'CarrierDocument',
    carrierId,
    type,
    name,
    s3Key,
    contentType,
    sizeBytes,
    expiresAt,
    loadCarrierId,
    source: 'UPLOAD',
    uploadedBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: CARRIER_DOCUMENT_TABLE_NAME,
        Item: marshallRow(item),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
  } catch (err: unknown) {
    if (isConflict(err)) throw conflictError('carrier document', err)
    throw err
  }

  await writeAudit('CARRIER_DOCUMENT', String(item.id), 'COMMIT_DOCUMENT', caller, { carrierId, type, name, s3Key })
  return item
}

async function deleteDocument(input: Row, caller: Caller): Promise<Row> {
  const id = assertString(input.id, 'id')
  const existing = await getById(CARRIER_DOCUMENT_TABLE_NAME, id)
  if (!existing) throw new Error(`Carrier document not found: ${id}`)

  // Anyone on the carriers page may take back a file they uploaded by mistake;
  // removing somebody else's paperwork is an admin decision.
  if (!caller.isAdmin && caller.email !== existing.uploadedBy) {
    throw new Error('Forbidden: DELETE_DOCUMENT requires owner, ADMIN, or the person who uploaded the document')
  }

  // The row goes; the S3 object stays. The bucket grants no delete, and a half-removed
  // file is worse than an orphan nobody links to.
  await dynamo.send(new DeleteItemCommand({ TableName: CARRIER_DOCUMENT_TABLE_NAME, Key: marshall({ id }) }))

  await writeAudit('CARRIER_DOCUMENT', id, 'DELETE_DOCUMENT', caller, {
    carrierId: existing.carrierId,
    type: existing.type,
    name: existing.name,
    s3Key: existing.s3Key,
  })
  return { id }
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function saveCarrierSettings(input: Row, caller: Caller): Promise<Row> {
  const existing = await getById(SETTINGS_TABLE_NAME, SETTINGS_ID)
  const isCreate = existing == null
  const now = nowIso()

  /*
   * A field the caller did not mention keeps the value it already had: `undefined`
   * (absent) means "leave it alone", an explicit `null` clears. Only the nine carrier
   * settings are written here — the shipment settings on the same row belong to
   * tms-directory-actions SAVE_SETTINGS and are never touched.
   */
  const keep = <T,>(raw: unknown, parse: (v: unknown) => T, field: string): T | undefined =>
    raw === undefined ? (existing?.[field] as T | undefined) : parse(raw)

  const item: Row = {
    id: SETTINGS_ID,
    allowedCarrierStatuses: keep(
      input.allowedCarrierStatuses,
      (v) => optionalEnumArray(v, CARRIER_STATUSES, 'allowedCarrierStatuses'),
      'allowedCarrierStatuses',
    ),
    requireCarrierApproval: keep(
      input.requireCarrierApproval,
      (v) => (typeof v === 'boolean' ? v : undefined),
      'requireCarrierApproval',
    ),
    requiredCarrierDocs: keep(
      input.requiredCarrierDocs,
      (v) => optionalEnumArray(v, CARRIER_DOCUMENT_TYPES, 'requiredCarrierDocs'),
      'requiredCarrierDocs',
    ),
    bookingRequiredFields: keep(
      input.bookingRequiredFields,
      (v) => optionalEnumArray(v, BOOKING_REQUIRED_FIELDS, 'bookingRequiredFields'),
      'bookingRequiredFields',
    ),
    defaultCarrierTermsDays: keep(
      input.defaultCarrierTermsDays,
      (v) => optionalInteger(v, { min: 0, max: 365, label: 'defaultCarrierTermsDays' }),
      'defaultCarrierTermsDays',
    ),
    // The ladder itself decides what is valid: ascending days, never a higher fee for
    // a longer wait. normalizeQuickPayTiers throws with the human reason.
    quickPayTiers: keep(
      input.quickPayTiers,
      (v) => (v == null ? null : normalizeQuickPayTiers(v)),
      'quickPayTiers',
    ),
    rateConExpiryHours: keep(
      input.rateConExpiryHours,
      (v) => optionalInteger(v, { min: 1, max: 720, label: 'rateConExpiryHours' }),
      'rateConExpiryHours',
    ),
    rateConRequiredFields: keep(
      input.rateConRequiredFields,
      (v) => optionalEnumArray(v, RATE_CON_REQUIRED_FIELDS, 'rateConRequiredFields'),
      'rateConRequiredFields',
    ),
    insuranceWarnDays: keep(
      input.insuranceWarnDays,
      (v) => optionalInteger(v, { min: 0, max: 365, label: 'insuranceWarnDays' }),
      'insuranceWarnDays',
    ),

    updatedBy: caller.email,
    createdAt: isCreate ? now : (existing?.createdAt as string) ?? now,
    updatedAt: now,
  }

  if (isCreate) {
    await dynamo.send(
      new PutItemCommand({
        TableName: SETTINGS_TABLE_NAME,
        Item: marshallRow(item),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
    await writeAudit('TMS_SETTINGS', SETTINGS_ID, 'SAVE_CARRIER_SETTINGS', caller, { created: true })
    return item
  }

  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const patch: Row = {}
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'createdAt') continue
    patch[key] = value
  }

  const saved = await casUpdate(SETTINGS_TABLE_NAME, SETTINGS_ID, patch, expectedUpdatedAt, 'settings')
  await writeAudit('TMS_SETTINGS', SETTINGS_ID, 'SAVE_CARRIER_SETTINGS', caller, { created: false })
  return saved
}

// ── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent): Promise<Row> => {
  const action = event.arguments.action as Action
  const caller = await authorize(action, event.identity)
  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'UPSERT_CARRIER':
      return upsertCarrier(input, caller)
    case 'SET_CARRIER_STATUS':
      return setCarrierStatus(input, caller)
    case 'UPSERT_CONTACT':
      return upsertContact(input, caller)
    case 'ARCHIVE_CONTACT':
      return archiveContact(input, caller)
    case 'UPSERT_PAYMENT_METHOD':
      return upsertPaymentMethod(input, caller)
    case 'ARCHIVE_PAYMENT_METHOD':
      return archivePaymentMethod(input, caller)
    case 'PREPARE_DOCUMENT':
      return prepareDocument(input)
    case 'COMMIT_DOCUMENT':
      return commitDocument(input, caller)
    case 'DELETE_DOCUMENT':
      return deleteDocument(input, caller)
    case 'SAVE_CARRIER_SETTINGS':
      return saveCarrierSettings(input, caller)
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
