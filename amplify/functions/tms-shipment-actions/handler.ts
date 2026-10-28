/**
 * tms-shipment-actions Lambda handler — Step B.
 *
 * One writer for the shipment side of the TMS. Three records describe a piece of
 * freight: the Shipment owns the movement and its single status, the Order is the
 * sell side, and the existing Load is the buy side — one row per leg, carrying
 * LoadCarrier assignment rows, cached LoadFinancials and LoadCharge line items.
 *
 * Shipment/Order/LoadCarrier/LoadFinancials/LoadCharge are written with the raw
 * DynamoDB SDK, in a TransactWriteItems whenever more than one of them has to move
 * together. Load is written through the generated AppSync `updateLoad`/`createLoad`
 * mutations so the calendar's subscriptions still fire, exactly as the directory
 * Lambda's merge repoint does.
 *
 * Money is integer cents and percentages are basis points, everywhere. Invoicing
 * and payment are never inferred: this handler writes DOCS_NEEDED, UNBILLED and
 * INVOICE_NOT_NEEDED only — UNPAID/PAID belong to step F.
 */
import { getAmplifyDataClientConfig, type DataClientEnv } from '@aws-amplify/backend-function/runtime'
import { Amplify } from 'aws-amplify'
import { generateClient } from 'aws-amplify/data'
import {
  DynamoDBClient,
  BatchGetItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  ScanCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { createHash, randomUUID } from 'crypto'

import {
  computeFinancials,
  isRateCode,
  type ChargeLineInput,
} from '../../../src/lib/shipmentCharges'
import {
  canTransitionLoadStatus,
  canTransitionShipmentStatus,
  isTruckloadMode,
  loadStatusFromStopTimes,
  shipmentStatusFromLoads,
} from '../../../src/lib/shipmentStatus'
import { creditSummaryForCustomer, resolveCreditPolicy, type CreditSummary } from '../../../src/lib/customerCredit'
import type { Load as LoadForCredit } from '../../../src/types'
import type {
  ArStatus,
  ChargeCalc,
  ChargeSide,
  CustomerRecord,
  DefaultCharge,
  LoadCarrierStatus,
  LoadWorkflowStatus,
  OrderRecord,
  PricingDefaults,
  ShipmentMode,
  ShipmentRecord,
  ShipmentStatus,
  TmsSettings as TmsSettingsRecord,
} from '../../../src/types/tms'

const dynamo = new DynamoDBClient({})
const cognito = new CognitoIdentityProviderClient({})

const SHIPMENT_TABLE_NAME = process.env.SHIPMENT_TABLE_NAME ?? ''
const ORDER_TABLE_NAME = process.env.ORDER_TABLE_NAME ?? ''
const LOAD_CARRIER_TABLE_NAME = process.env.LOAD_CARRIER_TABLE_NAME ?? ''
const LOAD_FINANCIALS_TABLE_NAME = process.env.LOAD_FINANCIALS_TABLE_NAME ?? ''
const LOAD_CHARGE_TABLE_NAME = process.env.LOAD_CHARGE_TABLE_NAME ?? ''
const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME ?? ''
const CUSTOMER_TABLE_NAME = process.env.CUSTOMER_TABLE_NAME ?? ''
const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME ?? ''
const AUDIT_LOG_TABLE_NAME = process.env.AUDIT_LOG_TABLE_NAME ?? ''
const DRIVER_TABLE_NAME = process.env.DRIVER_TABLE_NAME ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const SETTINGS_ID = 'default'

// Amplify derives GSI names from the plural model name and the key fields.
const IDX_ORDERS_BY_SHIPMENT = 'ordersByShipmentId'
const IDX_LOADS_BY_SHIPMENT = 'loadsByShipmentId'
const IDX_LOADS_BY_CUSTOMER = 'loadsByCustomerId'
const IDX_ORDERS_BY_CUSTOMER = 'ordersByCustomerIdAndPickupAppt'
const IDX_CARRIERS_BY_SHIPMENT = 'loadCarriersByShipmentId'
const IDX_CARRIERS_BY_LOAD = 'loadCarriersByLoadId'
const IDX_CHARGES_BY_SHIPMENT = 'loadChargesByShipmentIdAndSortOrder'

/** DUPLICATE_SHIPMENT ceiling — one transaction per copy, and 20 is the plan's cap. */
const MAX_DUPLICATE_COPIES = 20
/** Element-validated JSON arrays are capped so one request cannot blow the item size. */
const MAX_JSON_ELEMENTS = 100

// ── AppSync data client (Load writes only) ───────────────────────────────────

interface LoadMutationResult {
  data: Record<string, unknown> | null
  errors?: unknown
}

/** Narrow wrapper: this Lambda only creates and updates Load through AppSync. */
interface DataClient {
  models: {
    Load: {
      create: (input: Record<string, unknown>) => Promise<LoadMutationResult>
      update: (
        input: Record<string, unknown>,
        options?: { condition?: unknown },
      ) => Promise<LoadMutationResult>
    }
  }
}

let dataClient: DataClient | null = null

async function getDataClient(): Promise<DataClient> {
  if (dataClient) return dataClient
  const env = process.env as unknown as DataClientEnv
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env)
  Amplify.configure(resourceConfig, libraryOptions)
  // The library's full client type is implementation-internal; this module only
  // uses Load.create/Load.update.
  dataClient = generateClient() as unknown as DataClient
  return dataClient
}

function assertLoadWriteOk(result: LoadMutationResult, label: string): Record<string, unknown> {
  const rawErrors = result.errors
  const errors = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : []
  if (result.data == null || errors.length > 0) {
    throw new Error(`${label} failed: ${JSON.stringify(errors)}`)
  }
  return result.data
}

// ── Enums ────────────────────────────────────────────────────────────────────
// The runtime arrays are what validates an incoming string; the types come from
// src/types/tms.ts so a value this router accepts is a value the shared libs and
// the UI already agree on.

const SHIPMENT_MODES: readonly ShipmentMode[] = [
  'FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL',
]

const SHIPMENT_STATUS_VALUES: readonly ShipmentStatus[] = [
  'DRAFT', 'TENDER_PENDING', 'TENDER_REJECTED', 'OPEN', 'ON_HOLD', 'BOOKED', 'PLANNED',
  'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING', 'DELIVERED', 'CANCELED',
]

const LOAD_STATUS_VALUES: readonly LoadWorkflowStatus[] = [
  'SOURCING', 'BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT',
  'RECOVERED', 'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING',
  'DELIVERED', 'INVOICING', 'CANCELED',
]

const CHARGE_SIDES: readonly ChargeSide[] = ['CUSTOMER', 'CARRIER']

const CHARGE_CALCS: readonly ChargeCalc[] = ['FLAT', 'PER_MILE', 'PER_CWT', 'PERCENT']

const AR_STATUSES: readonly ArStatus[] = ['DOCS_NEEDED', 'UNBILLED', 'UNPAID', 'PAID', 'INVOICE_NOT_NEEDED']
/** B never infers invoicing or payment; UNPAID/PAID are written by step F only. */
const AR_STATUSES_WRITABLE: readonly ArStatus[] = ['DOCS_NEEDED', 'UNBILLED', 'INVOICE_NOT_NEEDED']

const REFERENCE_LEVELS = ['ORDER', 'HANDLING_UNIT', 'PACKAGE', 'STOP'] as const
const REFERENCE_VISIBILITIES = ['INTERNAL', 'CUSTOMER', 'CARRIER', 'ALL'] as const
const HANDLING_UNITS = [
  'PALLET', 'SKID', 'CRATE', 'BOX', 'DRUM', 'TOTE', 'BUNDLE', 'ROLL', 'OTHER',
] as const
const DIM_UNITS = ['IN', 'CM'] as const
const WEIGHT_UNITS = ['LB', 'KG'] as const
const STOP_TYPES = ['pickup', 'delivery'] as const
const APPT_REQUESTED_BY = ['CUSTOMER', 'CARRIER', 'BROKER'] as const
const STOP_OPS = [
  'ADD', 'REMOVE', 'SWAP', 'SET_APPT', 'SET_REQUESTED', 'SET_TIMES', 'SET_TYPE',
  'SET_REFS', 'SET_LOCATION',
] as const
type StopOp = (typeof STOP_OPS)[number]

type Action =
  | 'CREATE_SHIPMENT'
  | 'SAVE_ORDER_FORM'
  | 'CHECK_CREDIT'
  | 'SUBMIT_ORDER'
  | 'SET_SHIPMENT_STATUS'
  | 'SET_LOAD_STATUS'
  | 'DELETE_SHIPMENT'
  | 'RESTORE_SHIPMENT'
  | 'TENDER_RESPOND'
  | 'DUPLICATE_SHIPMENT'
  | 'UPDATE_STOP'
  | 'ASSIGN_ASSET'
  | 'ASSIGN_CARRIER'
  | 'REMOVE_LOAD_CARRIER'
  | 'RECALC_CHARGES'
  | 'SET_AR_STATUS'
  | 'GET_SHIPMENT_BUNDLE'
  | 'BACKFILL_SHIPMENT'

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
    console.warn('[tms-shipment-actions] could not resolve caller email:', String(err))
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
  // Building and moving freight is the loads page's job; everything here belongs to it.
  if (!isAdmin && !groups.includes('page-loads')) {
    throw new Error(`Forbidden: ${action} requires owner, ADMIN, or page-loads`)
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
  else if (typeof value === 'string' && value.trim()) num = Number(value)
  else throw new Error(`${label} must be an integer`)
  if (!Number.isFinite(num) || !Number.isInteger(num)) throw new Error(`${label} must be an integer`)
  if (options?.min != null && num < options.min) throw new Error(`${label} must be at least ${options.min}`)
  if (options?.max != null && num > options.max) throw new Error(`${label} must be at most ${options.max}`)
  if (num < -2_147_483_648 || num > 2_147_483_647) throw new Error(`${label} exceeds GraphQL integer range`)
  return num
}

function optionalBoolean(value: unknown): boolean | null {
  if (value == null) return null
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('Value must be a boolean')
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const v = assertString(value, label)
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  return v as T
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  const v = optionalString(value, 64)
  if (v == null) return null
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  return v as T
}

function assertRecord(value: unknown, label: string): Row {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Row
}

function assertArrayOf<T>(
  value: unknown,
  label: string,
  validate: (item: unknown, index: number) => T,
  maxLen = MAX_JSON_ELEMENTS,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > maxLen) throw new Error(`${label} must have at most ${maxLen} entries`)
  return value.map(validate)
}

/** ISO-8601 is what every stop time, appointment and audit row in this system is. */
function assertIso(value: unknown, label: string): string {
  const v = assertString(value, label)
  if (Number.isNaN(Date.parse(v))) throw new Error(`${label} must be an ISO timestamp`)
  return v
}

function optionalIso(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  return assertIso(value, label)
}

function nowIso(): string {
  return new Date().toISOString()
}

/** ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly. */
function conflictError(itemLabel: string, cause: unknown): Error {
  const err = new Error(`This ${itemLabel} was changed by someone else. Reload and try again.`)
  ;(err as Error & { cause?: unknown }).cause = cause
  return err
}

function isConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')
}

function monthOf(appt: string | null | undefined): string | null {
  if (!appt) return null
  const m = /^(\d{4}-\d{2})/.exec(appt)
  return m ? m[1] : null
}

// ── DynamoDB helpers ─────────────────────────────────────────────────────────

async function getById(tableName: string, id: string): Promise<Row | null> {
  if (!tableName) throw new Error('Table name is not configured')
  const result = await dynamo.send(new GetItemCommand({ TableName: tableName, Key: marshall({ id }) }))
  return result.Item ? unmarshall(result.Item) : null
}

async function queryIndex(
  tableName: string,
  indexName: string,
  keyName: string,
  keyValue: string,
): Promise<Row[]> {
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

async function batchGetByIds(tableName: string, ids: string[]): Promise<Row[]> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return []
  const out: Row[] = []
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100)
    let keys = chunk.map((id) => marshall({ id }))
    // BatchGetItem may return part of the request; the rest comes back as unprocessed.
    for (let attempt = 0; attempt < 4 && keys.length > 0; attempt++) {
      const result = await dynamo.send(
        new BatchGetItemCommand({ RequestItems: { [tableName]: { Keys: keys } } }),
      )
      const got = result.Responses?.[tableName] ?? []
      out.push(...got.map((item) => unmarshall(item)))
      keys = result.UnprocessedKeys?.[tableName]?.Keys ?? []
    }
  }
  return out
}

/**
 * Whole-table read. Only the backfill uses it, and only for the driver roster —
 * a few hundred rows it has to classify before it can tell a truck from a broker.
 */
async function scanTable(tableName: string): Promise<Row[]> {
  if (!tableName) throw new Error('Table name is not configured')
  const items: Row[] = []
  let lastKey: Record<string, AttributeValue> | undefined
  do {
    const result = await dynamo.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey, Limit: 1000 }))
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
 * never been written". Same shape the directory Lambda uses, so a client that can
 * talk to one router can talk to both.
 */
function casCondition(values: Record<string, AttributeValue>, expectedUpdatedAt: string): string {
  values[':casExpectedUpdatedAt'] = { S: expectedUpdatedAt }
  values[':casEmpty'] = { S: '' }
  return '((attribute_exists(updatedAt) AND updatedAt = :casExpectedUpdatedAt) OR (attribute_not_exists(updatedAt) AND :casExpectedUpdatedAt = :casEmpty))'
}

function assertExpectedUpdatedAt(input: Row): string {
  const value = input.expectedUpdatedAt
  if (value == null) throw new Error('expectedUpdatedAt is required')
  if (typeof value !== 'string') throw new Error('expectedUpdatedAt must be a string')
  return value
}

/** Build a SET update for every own key of `patch`, with a CAS guard on updatedAt. */
function updateItemTx(
  tableName: string,
  id: string,
  patch: Row,
  expectedUpdatedAt: string | null,
): TransactWriteItem {
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
      ...(expectedUpdatedAt == null ? {} : { ConditionExpression: casCondition(values, expectedUpdatedAt) }),
    },
  }
}

function deleteItemTx(tableName: string, id: string): TransactWriteItem {
  return { Delete: { TableName: tableName, Key: marshall({ id }) } }
}

async function transact(items: TransactWriteItem[], label: string): Promise<void> {
  if (items.length === 0) return
  if (items.length > MAX_JSON_ELEMENTS) {
    throw new Error(`${label} needs ${items.length} writes; the transaction limit is ${MAX_JSON_ELEMENTS}`)
  }
  try {
    await dynamo.send(new TransactWriteItemsCommand({ TransactItems: items }))
  } catch (err) {
    if (isConflict(err)) throw conflictError(label, err)
    throw err
  }
}

/**
 * One audit row per write action. Best effort: a shipment that moved must not be
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
    console.warn('[tms-shipment-actions] audit log write failed:', String(err))
  }
}

// ── Stops ────────────────────────────────────────────────────────────────────

interface StopShape {
  id?: string
  type?: string
  name?: string | null
  city?: string | null
  appt?: string
  apptType?: string | null
  apptEnd?: string | null
  requestedStart?: string | null
  requestedEnd?: string | null
  apptRequestedBy?: string | null
  apptNote?: string | null
  refs?: unknown[] | null
  documentContact?: Row | null
  stopNotes?: string | null
  driverId?: string | null
  truckId?: string | null
  colorKey?: string | null
  sequence?: number
  locationId?: string | null
  address?: Row | null
  contact?: Row | null
  arrivedAt?: string | null
  departedAt?: string | null
  pieces?: number | null
  weightLbs?: number | null
  instructions?: string | null
  [key: string]: unknown
}

/** `stops` is AWSJSON: a list once AppSync parsed it, but a string if double-encoded. */
function readStops(load: Row): StopShape[] {
  let v = load.stops
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { break }
  }
  if (!Array.isArray(v)) return []
  return v
    .filter((s): s is StopShape => !!s && typeof s === 'object')
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}

function resequence(stops: StopShape[]): StopShape[] {
  return stops.map((s, i) => ({ ...s, sequence: i }))
}

/**
 * The legacy mirror columns, recomputed from the stops array. Every own-fleet reader
 * — the calendar, /loads, settlements, the driver app, PODs, factoring — still reads
 * these, so they are rewritten on every stop change.
 */
function deriveLegacyFields(stops: StopShape[]): Row {
  if (stops.length === 0) return {}
  const ordered = [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const pickups = ordered.filter((s) => s.type === 'pickup')
  const deliveries = ordered.filter((s) => s.type === 'delivery')
  const firstPickup = pickups[0] ?? ordered[0]
  const lastDelivery = deliveries[deliveries.length - 1] ?? ordered[ordered.length - 1]
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

function validateStopReference(item: unknown, index: number): Row {
  const r = assertRecord(item, `refs[${index}]`)
  return {
    code: assertString(r.code, `refs[${index}].code`),
    label: optionalString(r.label, 120),
    value: assertString(r.value, `refs[${index}].value`),
    level: optionalEnum(r.level, REFERENCE_LEVELS, `refs[${index}].level`) ?? 'STOP',
    stopId: optionalString(r.stopId, 100),
    visibility: optionalEnum(r.visibility, REFERENCE_VISIBILITIES, `refs[${index}].visibility`) ?? 'INTERNAL',
  }
}

function validateStop(item: unknown, index: number): StopShape {
  const s = assertRecord(item, `stops[${index}]`)
  const type = assertEnum(s.type, STOP_TYPES, `stops[${index}].type`)
  const appt = typeof s.appt === 'string' ? s.appt.trim() : ''
  if (appt && Number.isNaN(Date.parse(appt))) throw new Error(`stops[${index}].appt must be an ISO timestamp`)
  return {
    id: optionalString(s.id, 100) ?? `stp-${randomUUID()}`,
    type,
    name: optionalString(s.name, 200),
    city: optionalString(s.city, 120),
    locationId: optionalString(s.locationId, 100),
    address: s.address == null ? null : assertRecord(s.address, `stops[${index}].address`),
    appt,
    apptType: optionalString(s.apptType, 32),
    apptEnd: optionalIso(s.apptEnd, `stops[${index}].apptEnd`),
    requestedStart: optionalIso(s.requestedStart, `stops[${index}].requestedStart`),
    requestedEnd: optionalIso(s.requestedEnd, `stops[${index}].requestedEnd`),
    apptRequestedBy: optionalEnum(s.apptRequestedBy, APPT_REQUESTED_BY, `stops[${index}].apptRequestedBy`),
    apptNote: optionalString(s.apptNote, 1000),
    refs: s.refs == null ? null : assertArrayOf(s.refs, `stops[${index}].refs`, validateStopReference),
    documentContact: s.documentContact == null ? null : validateContact(s.documentContact, `stops[${index}].documentContact`),
    stopNotes: optionalString(s.stopNotes, 2000),
    contact: s.contact == null ? null : assertRecord(s.contact, `stops[${index}].contact`),
    driverId: optionalString(s.driverId, 100),
    truckId: optionalString(s.truckId, 100),
    colorKey: optionalString(s.colorKey, 32),
    arrivedAt: optionalIso(s.arrivedAt, `stops[${index}].arrivedAt`),
    departedAt: optionalIso(s.departedAt, `stops[${index}].departedAt`),
    pieces: optionalInteger(s.pieces, { min: 0, label: `stops[${index}].pieces` }),
    weightLbs: optionalInteger(s.weightLbs, { min: 0, label: `stops[${index}].weightLbs` }),
    instructions: optionalString(s.instructions, 2000),
    sequence: index,
  }
}

function validateContact(value: unknown, label: string): Row {
  const c = assertRecord(value, label)
  return {
    name: optionalString(c.name, 120),
    phone: optionalString(c.phone, 40),
    email: optionalString(c.email, 200),
  }
}

/**
 * A movement needs somewhere to load and somewhere to unload, and the dates have to
 * run forwards. Everything else about a stop can be filled in later.
 */
function assertStopShape(stops: StopShape[], requireBoth = true): void {
  if (requireBoth) {
    if (!stops.some((s) => s.type === 'pickup')) throw new Error('A shipment needs at least one pickup')
    if (!stops.some((s) => s.type === 'delivery')) throw new Error('A shipment needs at least one delivery')
  }
  const timed = stops.filter((s) => !!s.appt)
  for (let i = 1; i < timed.length; i++) {
    const prev = Date.parse(timed[i - 1].appt as string)
    const next = Date.parse(timed[i].appt as string)
    if (Number.isFinite(prev) && Number.isFinite(next) && next < prev) {
      throw new Error('Stop appointments must run in chronological order')
    }
  }
}

// ── Charges ──────────────────────────────────────────────────────────────────

interface ChargeInput {
  id: string | null
  side: ChargeSide
  code: string
  label: string | null
  calculatedBy: ChargeCalc
  rateCents: number
  count: number
  isRate: boolean
  release: string | null
  sortOrder: number
  note: string | null
  loadId: string | null
  loadCarrierId: string | null
}

interface ChargeCodeRules {
  label: string | null
  calculatedBy: ChargeCalc | null
}

/**
 * The org catalog, with the customer's own overrides applied. A code nobody has
 * defined is still accepted — the line carries its own `calculatedBy` — but a
 * defined one may not be contradicted on the calc it is rated by.
 */
function chargeCodeRules(settings: Row | null, customer: Row | null): Record<string, ChargeCodeRules> {
  const rules: Record<string, ChargeCodeRules> = {}
  const catalog = Array.isArray(settings?.chargeCodes) ? (settings?.chargeCodes as Row[]) : []
  for (const def of catalog) {
    const code = typeof def?.code === 'string' ? def.code : null
    if (!code) continue
    rules[code] = {
      label: typeof def.label === 'string' ? def.label : null,
      calculatedBy: (CHARGE_CALCS as readonly string[]).includes(String(def.calculatedBy))
        ? (def.calculatedBy as ChargeCalc)
        : null,
    }
  }
  const overrides = Array.isArray(customer?.chargeCodeOverrides) ? (customer?.chargeCodeOverrides as Row[]) : []
  for (const ov of overrides) {
    const code = typeof ov?.code === 'string' ? ov.code : null
    if (!code) continue
    const base = rules[code] ?? { label: null, calculatedBy: null }
    rules[code] = {
      label: typeof ov.label === 'string' ? ov.label : base.label,
      calculatedBy: (CHARGE_CALCS as readonly string[]).includes(String(ov.calculatedBy))
        ? (ov.calculatedBy as ChargeCalc)
        : base.calculatedBy,
    }
  }
  return rules
}

function validateChargeInput(
  item: unknown,
  index: number,
  rules: Record<string, ChargeCodeRules>,
): ChargeInput {
  const c = assertRecord(item, `charges[${index}]`)
  const side = assertEnum(c.side, CHARGE_SIDES, `charges[${index}].side`)
  const code = assertString(c.code, `charges[${index}].code`).toUpperCase()
  const defined = rules[code]
  const calculatedBy =
    optionalEnum(c.calculatedBy, CHARGE_CALCS, `charges[${index}].calculatedBy`) ??
    defined?.calculatedBy ??
    'FLAT'
  const rateCents = optionalInteger(c.rateCents, { label: `charges[${index}].rateCents` }) ?? 0
  /*
   * A negative carrier line is a payment back from the carrier, which is a credit
   * memo and not something this router can create. Catching it here keeps a typo
   * from quietly turning a cost into profit.
   */
  if (side === 'CARRIER' && rateCents < 0) {
    throw new Error(`charges[${index}].rateCents cannot be negative on a CARRIER line`)
  }
  const count = optionalInteger(c.count, { min: 0, label: `charges[${index}].count` }) ?? 1
  return {
    id: optionalString(c.id, 100),
    side,
    code,
    label: optionalString(c.label, 120) ?? defined?.label ?? null,
    calculatedBy,
    rateCents,
    count,
    isRate: isRateCode(code),
    release: optionalString(c.release, 120),
    sortOrder: optionalInteger(c.sortOrder, { min: 0, label: `charges[${index}].sortOrder` }) ?? index,
    note: optionalString(c.note, 1000),
    loadId: optionalString(c.loadId, 100),
    loadCarrierId: optionalString(c.loadCarrierId, 100),
  }
}

function chargeRowToInput(row: Row): ChargeInput {
  const code = String(row.code ?? '')
  return {
    id: typeof row.id === 'string' ? row.id : null,
    side: (row.side === 'CARRIER' ? 'CARRIER' : 'CUSTOMER'),
    code,
    label: typeof row.label === 'string' ? row.label : null,
    calculatedBy: (CHARGE_CALCS as readonly string[]).includes(String(row.calculatedBy))
      ? (row.calculatedBy as ChargeCalc)
      : 'FLAT',
    rateCents: typeof row.rateCents === 'number' ? row.rateCents : 0,
    count: typeof row.count === 'number' ? row.count : 1,
    isRate: row.isRate === true,
    release: typeof row.release === 'string' ? row.release : null,
    sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : 0,
    note: typeof row.note === 'string' ? row.note : null,
    loadId: typeof row.loadId === 'string' ? row.loadId : null,
    loadCarrierId: typeof row.loadCarrierId === 'string' ? row.loadCarrierId : null,
  }
}

function toChargeLine(c: ChargeInput): ChargeLineInput {
  return {
    side: c.side,
    code: c.code,
    calculatedBy: c.calculatedBy,
    rateCents: c.rateCents,
    count: c.count,
    isRate: c.isRate,
  }
}

function defaultChargesFor(customer: Row | null, rules: Record<string, ChargeCodeRules>): ChargeInput[] {
  const raw = Array.isArray(customer?.defaultCharges) ? (customer?.defaultCharges as DefaultCharge[]) : []
  return raw
    .filter((d) => typeof d?.code === 'string' && d.code.trim())
    .map((d, i) => {
      const code = d.code.trim().toUpperCase()
      return {
        id: null,
        side: 'CUSTOMER' as ChargeSide,
        code,
        label: rules[code]?.label ?? null,
        calculatedBy: rules[code]?.calculatedBy ?? 'FLAT',
        rateCents: typeof d.amountCents === 'number' ? d.amountCents : 0,
        count: typeof d.count === 'number' && d.count > 0 ? d.count : 1,
        isRate: isRateCode(code),
        release: null,
        sortOrder: i,
        note: null,
        loadId: null,
        loadCarrierId: null,
      }
    })
}

function pricingDefaultsOf(customer: Row | null): PricingDefaults | null {
  const p = customer?.pricingDefaults
  if (p == null || typeof p !== 'object' || Array.isArray(p)) return null
  return p as PricingDefaults
}

// ── Bundle ───────────────────────────────────────────────────────────────────

interface Bundle {
  shipment: Row
  orders: Row[]
  loads: Row[]
  loadCarriers: Row[]
  charges: Row[]
  financials: Row[]
}

async function readBundle(shipmentId: string): Promise<Bundle> {
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  const [orders, loads, loadCarriers, charges] = await Promise.all([
    queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId),
    queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId),
    queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId),
    queryIndex(LOAD_CHARGE_TABLE_NAME, IDX_CHARGES_BY_SHIPMENT, 'shipmentId', shipmentId),
  ])
  // LoadFinancials.id IS the load id, so the totals come back in one BatchGet.
  const financials = await batchGetByIds(LOAD_FINANCIALS_TABLE_NAME, loads.map((l) => String(l.id)))
  loads.sort((a, b) => Number(a.leg ?? 0) - Number(b.leg ?? 0))
  charges.sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
  return { shipment, orders, loads, loadCarriers, charges, financials }
}


// ── Shipment mirrors ─────────────────────────────────────────────────────────

/**
 * The board shows one row per shipment, so the shipment carries a copy of the
 * first pickup and the last delivery across its legs. They are mirrors: the stops
 * on the loads are the truth, and these are rewritten whenever a stop moves.
 */
function shipmentMirrors(loads: Row[]): Row {
  const stops = loads.flatMap((l) => readStops(l))
  const pickups = stops.filter((s) => s.type === 'pickup' && s.appt)
  const deliveries = stops.filter((s) => s.type === 'delivery' && s.appt)
  pickups.sort((a, b) => String(a.appt).localeCompare(String(b.appt)))
  deliveries.sort((a, b) => String(a.appt).localeCompare(String(b.appt)))
  const firstPickup = pickups[0] ?? stops.find((s) => s.type === 'pickup') ?? null
  const lastDelivery = deliveries[deliveries.length - 1] ?? stops.filter((s) => s.type === 'delivery').pop() ?? null
  const pickupAppt = firstPickup?.appt || undefined
  const pickupMonth = monthOf(pickupAppt as string) || undefined
  return {
    pickupAppt,
    deliveryAppt: lastDelivery?.appt || undefined,
    pickupMonth,
    originCity: firstPickup?.city || undefined,
    destinationCity: lastDelivery?.city || undefined,
  }
}

/** Lower-cased number, customer, cities and every reference value, in one field. */
function buildSearchKey(shipment: Row, orders: Row[], loads: Row[]): string {
  const parts: string[] = [String(shipment.number ?? ''), String(shipment.customerName ?? '')]
  const mirrors = shipmentMirrors(loads)
  if (mirrors.originCity) parts.push(String(mirrors.originCity))
  if (mirrors.destinationCity) parts.push(String(mirrors.destinationCity))
  for (const order of orders) {
    const refs = Array.isArray(order.references) ? (order.references as Row[]) : []
    for (const ref of refs) {
      if (typeof ref?.value === 'string') parts.push(ref.value)
    }
  }
  for (const load of loads) {
    for (const stop of readStops(load)) {
      const refs = Array.isArray(stop.refs) ? (stop.refs as Row[]) : []
      for (const ref of refs) {
        if (typeof ref?.value === 'string') parts.push(ref.value)
      }
    }
  }
  return parts.filter(Boolean).join(' ').toLowerCase().slice(0, 1800)
}

// ── Credit ───────────────────────────────────────────────────────────────────

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Everything the customer currently has riding on us, scored against their limit.
 *
 * The bucketing, the policy resolution and the block reasons all live in
 * `src/lib/customerCredit.ts`, which is also what the customer board renders — so
 * the number a dispatcher is refused by is the number they were already looking at.
 */
async function creditSummary(customer: Row, settings: Row | null, projectedCents: number): Promise<CreditSummary> {
  const customerId = String(customer.id)
  const [orders, loads] = await Promise.all([
    queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_CUSTOMER, 'customerId', customerId),
    queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_CUSTOMER, 'customerId', customerId),
  ])
  const shipments = await batchGetByIds(SHIPMENT_TABLE_NAME, orders.map((o) => String(o.shipmentId)))
  /*
   * DynamoDB hands back `Record<string, unknown>`; these rows came out of the very
   * tables whose shape the schema declares, and the library only reads scalar
   * fields off them. Casting once here is the boundary.
   */
  const typed = { orders, shipments, loads } as unknown as {
    orders: OrderRecord[]
    shipments: ShipmentRecord[]
    loads: LoadForCredit[]
  }
  const typedCustomer = customer as unknown as CustomerRecord
  const typedSettings = settings as unknown as TmsSettingsRecord | null
  return creditSummaryForCustomer(typedCustomer, typedSettings, typed, { projectedCents })
}

function assertCreditClear(summary: CreditSummary, customerName: string): void {
  if (summary.hold) throw new Error(`${customerName} is on credit hold`)
  if (summary.blockReasons.includes('NO_CREDIT_LIMIT')) {
    throw new Error(`${customerName} requires an approved credit limit before an order can be submitted`)
  }
  if (summary.blockReasons.includes('CREDIT_LIMIT_REACHED')) {
    throw new Error(`${customerName} would exceed its credit limit with this order`)
  }
  if (summary.blockReasons.includes('INVOICE_PAST_MAX_DAYS_LATE')) {
    throw new Error(`${customerName} has an invoice past its maximum days late`)
  }
}

// ── Customer / settings ──────────────────────────────────────────────────────

async function getSettings(): Promise<Row | null> {
  return getById(SETTINGS_TABLE_NAME, SETTINGS_ID)
}

async function getActiveCustomer(customerId: string): Promise<Row> {
  const customer = await getById(CUSTOMER_TABLE_NAME, customerId)
  if (!customer) throw new Error(`Customer not found: ${customerId}`)
  if (customer.mergedIntoId) throw new Error('That customer has been merged into another record')
  // A row with no status predates Customer v2; it is active unless it was archived.
  const active = customer.status == null ? customer.active !== false : customer.status === 'ACTIVE'
  if (!active) throw new Error(`${String(customer.name ?? customerId)} is not an active customer`)
  return customer
}

function marginFloorBpsOf(settings: Row | null): number {
  return numberOrNull(settings?.marginFloorBps) ?? 0
}

/**
 * The next shipment number, taken with an atomic ADD so two dispatchers building
 * loads in the same second cannot land on the same one.
 */
async function nextShipmentNumber(caller: Caller): Promise<string> {
  const now = nowIso()
  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: SETTINGS_TABLE_NAME,
      Key: marshall({ id: SETTINGS_ID }),
      // ADD both increments and seeds the counter, so the very first shipment on a
      // fresh environment gets S000001 without anyone having saved settings first.
      UpdateExpression:
        'ADD nextShipmentNumber :one SET createdAt = if_not_exists(createdAt, :now), updatedAt = :now, updatedBy = :by, #tn = if_not_exists(#tn, :tn)',
      ExpressionAttributeNames: { '#tn': '__typename' },
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':now': { S: now },
        ':by': { S: caller.email },
        ':tn': { S: 'TmsSettings' },
      },
      ReturnValues: 'ALL_NEW',
    }),
  )
  const settings = result.Attributes ? unmarshall(result.Attributes) : null
  const counter = numberOrNull(settings?.nextShipmentNumber) ?? 1
  const prefix = typeof settings?.shipmentPrefix === 'string' && settings.shipmentPrefix.trim()
    ? settings.shipmentPrefix.trim()
    : 'S'
  return `${prefix}${String(counter).padStart(6, '0')}`
}

// ── Load row construction ────────────────────────────────────────────────────

interface NewLoadSpec {
  id: string
  shipmentId: string
  orderId: string
  shipmentNumber: string
  leg: number
  customerId: string
  customerName: string | null
  stops: StopShape[]
  rateCents: number
  equipmentType: string | null
  divisionKey: string | null
  carrierRepId: string | null
  status: LoadWorkflowStatus
}

function buildLoadInput(spec: NewLoadSpec, caller: Caller): Row {
  const loadNumber = `${spec.shipmentNumber}-${spec.leg}`
  const legacy = deriveLegacyFields(spec.stops)
  const now = nowIso()
  return {
    id: spec.id,
    // The legacy identity columns are required and are read all over the own-fleet
    // pages; a shipment-born load names itself after its leg.
    aljexId: loadNumber,
    tmsId: loadNumber,
    pickupNumber: loadNumber,
    readyToInvoice: false,
    customer: spec.customerName,
    customerId: spec.customerId,
    rate: spec.rateCents,
    stops: JSON.stringify(spec.stops),
    pickupAppt: (legacy.pickupAppt as string) ?? '',
    deliveryAppt: (legacy.deliveryAppt as string) ?? '',
    pickupApptEnd: legacy.pickupApptEnd ?? null,
    pickupApptType: legacy.pickupApptType ?? null,
    deliveryApptEnd: legacy.deliveryApptEnd ?? null,
    deliveryApptType: legacy.deliveryApptType ?? null,
    originName: legacy.originName ?? null,
    originCity: legacy.originCity ?? null,
    destinationName: legacy.destinationName ?? null,
    destinationCity: legacy.destinationCity ?? null,
    pickupDriverId: legacy.pickupDriverId ?? null,
    deliveryDriverId: legacy.deliveryDriverId ?? null,
    shipmentId: spec.shipmentId,
    orderId: spec.orderId,
    loadNumber,
    leg: spec.leg,
    status: spec.status,
    statusChangedAt: now,
    statusChangedBy: caller.email,
    statusSource: 'USER',
    assignmentType: 'NEED_TO_COVER',
    carrierRepId: spec.carrierRepId,
    equipmentType: spec.equipmentType,
    divisionKey: spec.divisionKey,
    trackingProvider: 'NONE',
    pickupMonth: monthOf(legacy.pickupAppt as string),
    createdBy: caller.email,
    updatedBy: caller.email,
  }
}

function chargeRow(
  charge: ChargeInput,
  amountCents: number,
  ids: { shipmentId: string; orderId: string; loadId: string },
  caller: Caller,
): Row {
  const now = nowIso()
  return {
    id: charge.id ?? `chg-${randomUUID()}`,
    __typename: 'LoadCharge',
    shipmentId: ids.shipmentId,
    side: charge.side,
    orderId: charge.side === 'CUSTOMER' ? ids.orderId : null,
    loadId: charge.loadId ?? ids.loadId,
    loadCarrierId: charge.side === 'CARRIER' ? charge.loadCarrierId : null,
    code: charge.code,
    label: charge.label,
    calculatedBy: charge.calculatedBy,
    rateCents: charge.rateCents,
    count: charge.count,
    amountCents,
    isRate: charge.isRate,
    release: charge.release,
    sortOrder: charge.sortOrder,
    note: charge.note,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }
}

interface FinancialsTotals {
  customerRateCents: number
  revenueCents: number
  carrierRateCents: number
  costCents: number
  profitCents: number
  marginBps: number
  topSpendCents: number
  targetBuyCents: number | null
}

function financialsRow(
  loadId: string,
  shipmentId: string,
  orderId: string | null,
  totals: FinancialsTotals,
  version: number,
  caller: Caller,
  existing: Row | null,
): Row {
  const now = nowIso()
  return {
    id: loadId,
    __typename: 'LoadFinancials',
    loadId,
    shipmentId,
    orderId,
    customerRateCents: totals.customerRateCents,
    revenueCents: totals.revenueCents,
    carrierRateCents: totals.carrierRateCents,
    costCents: totals.costCents,
    profitCents: totals.profitCents,
    marginBps: totals.marginBps,
    topSpendCents: totals.topSpendCents,
    targetBuyCents: totals.targetBuyCents,
    frozenAt: existing?.frozenAt ?? null,
    frozenBy: existing?.frozenBy ?? null,
    updatedBy: caller.email,
    version,
    createdAt: (existing?.createdAt as string | undefined) ?? now,
    updatedAt: now,
  }
}

/** Amount per line and the resulting totals, for one load's slice of the charges. */
function priceFor(
  charges: ChargeInput[],
  ctx: { miles?: number | null; weightLbs?: number | null },
  pricing: PricingDefaults | null,
  marginFloorBps: number,
): { amounts: number[]; totals: FinancialsTotals } {
  const result = computeFinancials(charges.map(toChargeLine), ctx, pricing, marginFloorBps)
  return {
    amounts: result.lines.map((l) => l.amountCents),
    totals: {
      customerRateCents: result.customerRateCents,
      revenueCents: result.revenueCents,
      carrierRateCents: result.carrierRateCents,
      costCents: result.costCents,
      profitCents: result.profitCents,
      marginBps: result.marginBps,
      topSpendCents: result.topSpendCents,
      targetBuyCents: result.targetBuyCents,
    },
  }
}

// ── CREATE_SHIPMENT ──────────────────────────────────────────────────────────

async function createShipment(input: Row, caller: Caller): Promise<Row> {
  const customerId = assertString(input.customerId, 'customerId')
  const customer = await getActiveCustomer(customerId)
  const settings = await getSettings()

  // A customer who may not ship on open credit needs an approved limit before
  // anybody starts building, not at the moment they try to submit.
  const policy = resolveCreditPolicy(customer as unknown as CustomerRecord, settings as unknown as TmsSettingsRecord | null)
  if (policy.freeCreditRequired && policy.creditLimitCents == null) {
    throw new Error(`${String(customer.name ?? customerId)} requires an approved credit limit before an order can be built`)
  }

  const quoting = customer.quotingDefaults
  const customerMode =
    quoting != null && typeof quoting === 'object' && 'defaultMode' in quoting ? quoting.defaultMode : null
  const mode =
    optionalEnum(input.mode, SHIPMENT_MODES, 'mode') ??
    optionalEnum(customerMode, SHIPMENT_MODES, 'customer.quotingDefaults.defaultMode') ??
    optionalEnum(settings?.defaultMode, SHIPMENT_MODES, 'settings.defaultMode') ??
    'FTL'

  const number = await nextShipmentNumber(caller)
  const shipmentId = `shp-${randomUUID()}`
  const orderId = `ord-${randomUUID()}`
  const loadId = `lod-${randomUUID()}`
  const now = nowIso()

  const rules = chargeCodeRules(settings, customer)
  const charges = defaultChargesFor(customer, rules)
  const { amounts, totals } = priceFor(charges, {}, pricingDefaultsOf(customer), marginFloorBpsOf(settings))

  const customerName = optionalString(customer.name, 200)
  const shipment: Row = {
    id: shipmentId,
    __typename: 'Shipment',
    number,
    status: 'DRAFT',
    previousStatus: null,
    statusChangedAt: now,
    statusChangedBy: caller.email,
    customerId,
    customerName,
    mode,
    parentShipmentId: null,
    orderIds: [orderId],
    loadIds: [loadId],
    searchKey: [number, customerName].filter(Boolean).join(' ').toLowerCase(),
    source: 'MANUAL',
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }

  const order: Row = {
    id: orderId,
    __typename: 'Order',
    shipmentId,
    customerId,
    customerName,
    customerContactId: null,
    customerRepId: optionalString(customer.defaultSalesRepId, 100),
    billToId: null,
    costCenter: null,
    mode,
    rateType: 'SPOT',
    references: [],
    equipmentType: null,
    equipmentLengthFt: null,
    specialRequirements: null,
    freight: [],
    customerNotes: null,
    internalNotes: null,
    customerRateCents: totals.customerRateCents,
    revenueCents: totals.revenueCents,
    arStatus: 'DOCS_NEEDED',
    arStatusChangedAt: now,
    invoiceId: null,
    invoiceEarly: false,
    readyToInvoiceAt: null,
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }

  const chargeRows = charges.map((c, i) =>
    chargeRow(c, amounts[i], { shipmentId, orderId, loadId }, caller),
  )

  await transact(
    [
      putItem(SHIPMENT_TABLE_NAME, shipment),
      putItem(ORDER_TABLE_NAME, order),
      putItem(LOAD_FINANCIALS_TABLE_NAME, financialsRow(loadId, shipmentId, orderId, totals, 1, caller, null)),
      ...chargeRows.map((row) => putItem(LOAD_CHARGE_TABLE_NAME, row)),
    ],
    'shipment',
  )

  const client = await getDataClient()
  try {
    assertLoadWriteOk(
      await client.models.Load.create(
        buildLoadInput(
          {
            id: loadId,
            shipmentId,
            orderId,
            shipmentNumber: number,
            leg: 1,
            customerId,
            customerName,
            stops: [],
            rateCents: totals.revenueCents,
            equipmentType: null,
            divisionKey: optionalString(customer.defaultDivisionKey, 100),
            carrierRepId: null,
            status: 'SOURCING',
          },
          caller,
        ),
      ),
      'Load create',
    )
  } catch (err) {
    // The shipment is a draft with no leg; leaving it behind would put an unusable
    // row on the board, so take the three rows back out before reporting the failure.
    await transact(
      [
        deleteItemTx(SHIPMENT_TABLE_NAME, shipmentId),
        deleteItemTx(ORDER_TABLE_NAME, orderId),
        deleteItemTx(LOAD_FINANCIALS_TABLE_NAME, loadId),
        ...chargeRows.map((row) => deleteItemTx(LOAD_CHARGE_TABLE_NAME, String(row.id))),
      ],
      'shipment rollback',
    ).catch((rollbackErr) => console.error('[tms-shipment-actions] rollback failed:', String(rollbackErr)))
    throw err
  }

  await writeAudit('SHIPMENT', shipmentId, 'CREATE_SHIPMENT', caller, { number, customerId, mode })
  return readBundle(shipmentId) as unknown as Row
}

// ── SAVE_ORDER_FORM ──────────────────────────────────────────────────────────

function validateOrderReference(item: unknown, index: number): Row {
  const r = assertRecord(item, `order.references[${index}]`)
  return {
    code: assertString(r.code, `order.references[${index}].code`),
    label: optionalString(r.label, 120),
    value: assertString(r.value, `order.references[${index}].value`),
    level: optionalEnum(r.level, REFERENCE_LEVELS, `order.references[${index}].level`) ?? 'ORDER',
    stopId: optionalString(r.stopId, 100),
    visibility: optionalEnum(r.visibility, REFERENCE_VISIBILITIES, `order.references[${index}].visibility`) ?? 'INTERNAL',
  }
}

function validateFreightItem(item: unknown, index: number): Row {
  const f = assertRecord(item, `order.freight[${index}]`)
  const dims = f.dims == null ? null : assertRecord(f.dims, `order.freight[${index}].dims`)
  const hazmat = f.hazmat == null ? null : assertRecord(f.hazmat, `order.freight[${index}].hazmat`)
  return {
    id: optionalString(f.id, 100) ?? `frt-${randomUUID()}`,
    handlingUnit: assertEnum(f.handlingUnit, HANDLING_UNITS, `order.freight[${index}].handlingUnit`),
    qty: optionalInteger(f.qty, { min: 0, label: `order.freight[${index}].qty` }) ?? 0,
    description: optionalString(f.description, 500),
    dims: dims == null ? null : {
      l: optionalInteger(dims.l, { min: 0, label: `order.freight[${index}].dims.l` }),
      w: optionalInteger(dims.w, { min: 0, label: `order.freight[${index}].dims.w` }),
      h: optionalInteger(dims.h, { min: 0, label: `order.freight[${index}].dims.h` }),
      unit: assertEnum(dims.unit, DIM_UNITS, `order.freight[${index}].dims.unit`),
    },
    weightLbs: optionalInteger(f.weightLbs, { min: 0, label: `order.freight[${index}].weightLbs` }),
    weightUnit: optionalEnum(f.weightUnit, WEIGHT_UNITS, `order.freight[${index}].weightUnit`) ?? 'LB',
    freightClass: optionalString(f.freightClass, 16),
    nmfc: optionalString(f.nmfc, 32),
    hazmat: hazmat == null ? null : {
      // A hazmat line without a UN number, class and an emergency number is not
      // something a driver can legally haul — refuse it at the door.
      un: assertString(hazmat.un, `order.freight[${index}].hazmat.un`),
      hazClass: assertString(hazmat.hazClass, `order.freight[${index}].hazmat.hazClass`),
      packingGroup: optionalString(hazmat.packingGroup, 16),
      emergencyContact: assertString(hazmat.emergencyContact, `order.freight[${index}].hazmat.emergencyContact`),
    },
    stackable: optionalBoolean(f.stackable),
    highValue: optionalBoolean(f.highValue),
  }
}

function validateSpecialRequirements(value: unknown): Row | null {
  if (value == null) return null
  const s = assertRecord(value, 'order.specialRequirements')
  const tempF = s.tempF == null ? null : assertRecord(s.tempF, 'order.specialRequirements.tempF')
  return {
    team: optionalBoolean(s.team),
    tarps: optionalBoolean(s.tarps),
    straps: optionalBoolean(s.straps),
    liftgate: optionalBoolean(s.liftgate),
    hazmat: optionalBoolean(s.hazmat),
    tempF: tempF == null ? null : {
      target: optionalInteger(tempF.target, { label: 'order.specialRequirements.tempF.target' }),
      min: optionalInteger(tempF.min, { label: 'order.specialRequirements.tempF.min' }),
      max: optionalInteger(tempF.max, { label: 'order.specialRequirements.tempF.max' }),
    },
    other: Array.isArray(s.other)
      ? assertArrayOf(s.other, 'order.specialRequirements.other', (v, i) => assertString(v, `order.specialRequirements.other[${i}]`))
      : null,
  }
}

/**
 * Every freight line has to be weighed in the same unit, or the total on the rate
 * confirmation is a number with no meaning.
 */
function assertWeightUnitsAgree(freight: Row[]): void {
  const units = new Set(freight.map((f) => String(f.weightUnit ?? 'LB')))
  if (units.size > 1) throw new Error('All freight lines must use the same weight unit')
}

function assertRequiredReferences(customer: Row, references: Row[]): void {
  const required = Array.isArray(customer.requiredReferences) ? (customer.requiredReferences as Row[]) : []
  for (const req of required) {
    const code = typeof req?.code === 'string' ? req.code : null
    if (!code) continue
    const need = numberOrNull(req.countOnNewOrder) ?? 0
    if (need <= 0) continue
    const have = references.filter((r) => String(r.code) === code && String(r.value ?? '').trim()).length
    if (have < need) {
      throw new Error(`${String(customer.name ?? 'This customer')} requires ${need} ${code} reference${need === 1 ? '' : 's'}`)
    }
  }
}

interface SavedForm {
  bundle: Bundle
  totals: FinancialsTotals
}

/**
 * Rewrite one draft's order, its stops and its charges in a single transaction.
 * Shared by SAVE_ORDER_FORM and SUBMIT_ORDER, which re-saves before it submits.
 */
async function saveOrderForm(input: Row, caller: Caller): Promise<SavedForm> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  if (shipment.deletedAt) throw new Error('That shipment is deleted')
  if (shipment.status !== 'DRAFT') throw new Error('Only a draft order can be edited on the order form')

  const order = bundle.orders[0]
  if (!order) throw new Error(`Shipment ${shipmentId} has no order`)
  const load = bundle.loads[0]
  if (!load) throw new Error(`Shipment ${shipmentId} has no load`)

  const customer = await getActiveCustomer(String(shipment.customerId))
  const settings = await getSettings()

  const orderInput = assertRecord(input.order ?? {}, 'order')
  const mode = optionalEnum(orderInput.mode, SHIPMENT_MODES, 'order.mode') ?? (shipment.mode as ShipmentMode)
  const references = orderInput.references == null
    ? (Array.isArray(order.references) ? (order.references as Row[]) : [])
    : assertArrayOf(orderInput.references, 'order.references', validateOrderReference)
  const freight = orderInput.freight == null
    ? (Array.isArray(order.freight) ? (order.freight as Row[]) : [])
    : assertArrayOf(orderInput.freight, 'order.freight', validateFreightItem)
  assertWeightUnitsAgree(freight)
  assertRequiredReferences(customer, references)

  const equipmentType = optionalString(orderInput.equipmentType, 80) ?? optionalString(order.equipmentType, 80)
  if (isTruckloadMode(mode) && !equipmentType) {
    throw new Error('A truckload order needs an equipment type')
  }

  const stops = input.stops == null
    ? readStops(load)
    : resequence(assertArrayOf(input.stops, 'stops', validateStop))
  assertStopShape(stops, false)

  const rules = chargeCodeRules(settings, customer)
  const charges = input.charges == null
    ? bundle.charges.map(chargeRowToInput)
    : assertArrayOf(input.charges, 'charges', (item, i) => validateChargeInput(item, i, rules))

  const loadFields = assertRecord(input.loadFields ?? {}, 'loadFields')
  const miles = optionalInteger(loadFields.miles, { min: 0, label: 'loadFields.miles' }) ?? numberOrNull(load.miles)
  const weightLbs = optionalInteger(loadFields.weight, { min: 0, label: 'loadFields.weight' }) ?? numberOrNull(load.weight)

  const { amounts, totals } = priceFor(
    charges,
    { miles, weightLbs },
    pricingDefaultsOf(customer),
    marginFloorBpsOf(settings),
  )

  const now = nowIso()
  const orderIdValue = String(order.id)
  const loadIdValue = String(load.id)
  const legacy = deriveLegacyFields(stops)
  const existingFinancials = bundle.financials.find((f) => f.id === loadIdValue) ?? null
  if (existingFinancials?.frozenAt) throw new Error('This load\'s financials are frozen and can no longer be changed')

  const chargeRows = charges.map((c, i) =>
    chargeRow(c, amounts[i], { shipmentId, orderId: orderIdValue, loadId: loadIdValue }, caller),
  )
  const keptIds = new Set(chargeRows.map((r) => String(r.id)))
  const removed = bundle.charges.filter((r) => !keptIds.has(String(r.id)))

  const mirrors = shipmentMirrors([{ ...load, stops: JSON.stringify(stops) }])
  const nextShipment: Row = {
    ...shipment,
    mode,
    ...mirrors,
  }

  await transact(
    [
      updateItemTx(
        SHIPMENT_TABLE_NAME,
        shipmentId,
        {
          mode,
          ...mirrors,
          searchKey: buildSearchKey(nextShipment, [{ ...order, references }], [{ ...load, stops: JSON.stringify(stops) }]),
          updatedBy: caller.email,
          updatedAt: now,
          version: (numberOrNull(shipment.version) ?? 1) + 1,
        },
        expectedUpdatedAt,
      ),
      updateItemTx(ORDER_TABLE_NAME, orderIdValue, {
        mode,
        rateType: optionalEnum(orderInput.rateType, ['SPOT', 'CONTRACT'] as const, 'order.rateType') ?? order.rateType ?? 'SPOT',
        customerContactId: 'customerContactId' in orderInput
          ? optionalString(orderInput.customerContactId, 100)
          : (order.customerContactId ?? null),
        customerRepId: optionalString(orderInput.customerRepId, 100) ?? order.customerRepId ?? null,
        billToId: 'billToId' in orderInput ? optionalString(orderInput.billToId, 100) : (order.billToId ?? null),
        costCenter: 'costCenter' in orderInput ? optionalString(orderInput.costCenter, 120) : (order.costCenter ?? null),
        references,
        equipmentType,
        equipmentLengthFt: 'equipmentLengthFt' in orderInput
          ? optionalInteger(orderInput.equipmentLengthFt, { min: 0, label: 'order.equipmentLengthFt' })
          : (order.equipmentLengthFt ?? null),
        specialRequirements: 'specialRequirements' in orderInput
          ? validateSpecialRequirements(orderInput.specialRequirements)
          : (order.specialRequirements ?? null),
        freight,
        customerNotes: 'customerNotes' in orderInput
          ? optionalString(orderInput.customerNotes, 8000)
          : (order.customerNotes ?? null),
        internalNotes: 'internalNotes' in orderInput
          ? optionalString(orderInput.internalNotes, 8000)
          : (order.internalNotes ?? null),
        invoiceEarly: optionalBoolean(orderInput.invoiceEarly) ?? order.invoiceEarly ?? false,
        customerRateCents: totals.customerRateCents,
        revenueCents: totals.revenueCents,
        pickupAppt: mirrors.pickupAppt,
        updatedBy: caller.email,
        updatedAt: now,
        version: (numberOrNull(order.version) ?? 1) + 1,
      }, null),
      putItem(
        LOAD_FINANCIALS_TABLE_NAME,
        financialsRow(
          loadIdValue,
          shipmentId,
          orderIdValue,
          totals,
          (numberOrNull(existingFinancials?.version) ?? 0) + 1,
          caller,
          existingFinancials,
        ),
        false,
      ),
      ...chargeRows.map((row) => putItem(LOAD_CHARGE_TABLE_NAME, row, false)),
      ...removed.map((row) => deleteItemTx(LOAD_CHARGE_TABLE_NAME, String(row.id))),
    ],
    'shipment',
  )

  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadIdValue,
      stops: JSON.stringify(stops),
      ...legacy,
      pickupMonth: monthOf(legacy.pickupAppt as string),
      equipmentType,
      miles,
      weight: weightLbs,
      commodity: optionalString(loadFields.commodity, 200) ?? load.commodity ?? null,
      rate: totals.revenueCents,
      updatedBy: caller.email,
    }),
    'Load update',
  )

  await writeAudit('SHIPMENT', shipmentId, 'SAVE_ORDER_FORM', caller, {
    stops: stops.length,
    charges: chargeRows.length,
    revenueCents: totals.revenueCents,
  })

  return { bundle: await readBundle(shipmentId), totals }
}

// ── SUBMIT_ORDER ─────────────────────────────────────────────────────────────

async function submitOrder(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const carrierRepId = optionalString(input.carrierRepId, 100)
  // The UI autosaves before submit, so any expectedUpdatedAt it carried is stale.
  // Re-read the current shipment and CAS against that.
  const currentShipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!currentShipment) throw new Error(`Shipment not found: ${shipmentId}`)
  // Submit requires a complete route; drafts can be saved with partial stops.
  const firstLoadId = String((currentShipment.loadIds as string[] | undefined)?.[0] ?? '')
  const submitStops = input.stops != null
    ? resequence(assertArrayOf(input.stops, 'stops', validateStop))
    : readStops(await getById(LOAD_TABLE_NAME, firstLoadId) ?? { stops: '[]' })
  assertStopShape(submitStops, true)
  input.expectedUpdatedAt = String(currentShipment.updatedAt ?? '')
  const saved = await saveOrderForm(input, caller)
  const shipment = saved.bundle.shipment
  const mode = optionalEnum(shipment.mode, SHIPMENT_MODES, 'mode') ?? 'FTL'
  if (!isTruckloadMode(mode)) {
    throw new Error(`${mode} shipments cannot be submitted yet — only truckload modes are built out`)
  }

  const customer = await getActiveCustomer(String(shipment.customerId))
  const settings = await getSettings()
  const summary = await creditSummary(customer, settings, saved.totals.revenueCents)
  assertCreditClear(summary, String(customer.name ?? shipment.customerId))

  const now = nowIso()
  const load = saved.bundle.loads[0]
  await transact(
    [
      updateItemTx(
        SHIPMENT_TABLE_NAME,
        shipmentId,
        {
          status: 'OPEN',
          previousStatus: 'DRAFT',
          statusChangedAt: now,
          statusChangedBy: caller.email,
          updatedBy: caller.email,
          updatedAt: now,
          version: (numberOrNull(shipment.version) ?? 1) + 1,
        },
        String(shipment.updatedAt ?? ''),
      ),
    ],
    'shipment',
  )

  if (load) {
    const client = await getDataClient()
    assertLoadWriteOk(
      await client.models.Load.update({
        id: String(load.id),
        status: 'SOURCING',
        statusChangedAt: now,
        statusChangedBy: caller.email,
        statusSource: 'USER',
        carrierRepId: carrierRepId ?? load.carrierRepId ?? null,
        updatedBy: caller.email,
      }),
      'Load update',
    )
  }

  await writeAudit('SHIPMENT', shipmentId, 'SUBMIT_ORDER', caller, {
    revenueCents: saved.totals.revenueCents,
    carrierRepId,
  })
  return readBundle(shipmentId) as unknown as Row
}

// ── CHECK_CREDIT ─────────────────────────────────────────────────────────────

async function checkCredit(input: Row): Promise<Row> {
  const customerId = assertString(input.customerId, 'customerId')
  const projectedCents = optionalInteger(input.projectedCents, { min: 0, label: 'projectedCents' }) ?? 0
  const customer = await getById(CUSTOMER_TABLE_NAME, customerId)
  if (!customer) throw new Error(`Customer not found: ${customerId}`)
  const settings = await getSettings()
  return (await creditSummary(customer, settings, projectedCents)) as unknown as Row
}

// ── Shipment status ──────────────────────────────────────────────────────────

async function requireAdminForCancelDelete(action: string, caller: Caller, settings: Row | null): Promise<void> {
  if (settings?.cancelDeleteAdminOnly === true && !caller.isAdmin) {
    throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  }
}

async function setShipmentStatus(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const requested = assertEnum(input.status, ['ON_HOLD', 'OPEN', 'CANCELED', 'UNCANCEL'] as const, 'status')
  const reason = optionalString(input.reason, 500)

  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (shipment.deletedAt) throw new Error('That shipment is deleted')
  const current = String(shipment.status ?? 'DRAFT') as ShipmentStatus
  const settings = await getSettings()

  const now = nowIso()
  const patch: Row = { updatedBy: caller.email, updatedAt: now, statusChangedAt: now, statusChangedBy: caller.email }

  if (requested === 'CANCELED') {
    await requireAdminForCancelDelete('CANCEL', caller, settings)
    if (current === 'CANCELED') throw new Error('That shipment is already canceled')
    if (!reason) throw new Error('A cancel reason is required')
    patch.status = 'CANCELED'
    patch.previousStatus = current
    patch.cancelReason = reason
  } else if (requested === 'UNCANCEL') {
    await requireAdminForCancelDelete('UNCANCEL', caller, settings)
    if (current !== 'CANCELED') throw new Error('Only a canceled shipment can be un-canceled')
    patch.status = (optionalEnum(shipment.previousStatus, SHIPMENT_STATUS_VALUES, 'previousStatus') ?? 'OPEN')
    patch.previousStatus = 'CANCELED'
    patch.cancelReason = null
  } else if (requested === 'ON_HOLD') {
    if (current === 'ON_HOLD') throw new Error('That shipment is already on hold')
    if (current === 'DRAFT' || current === 'CANCELED') throw new Error(`A ${current} shipment cannot be put on hold`)
    if (!reason) throw new Error('A hold reason is required')
    patch.status = 'ON_HOLD'
    patch.previousStatus = current
    patch.holdReason = reason
  } else {
    // OPEN — lifting a hold returns the shipment to where it was.
    if (current === 'ON_HOLD') {
      patch.status = optionalEnum(shipment.previousStatus, SHIPMENT_STATUS_VALUES, 'previousStatus') ?? 'OPEN'
      patch.previousStatus = 'ON_HOLD'
      patch.holdReason = null
    } else if (current === 'DRAFT') {
      throw new Error('Submit the order instead of opening the draft directly')
    } else if (!canTransitionShipmentStatus(current, 'OPEN')) {
      throw new Error(`A shipment cannot go from ${current} back to OPEN`)
    } else {
      patch.status = 'OPEN'
      patch.previousStatus = current
    }
  }

  patch.version = (numberOrNull(shipment.version) ?? 1) + 1
  await transact([updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, patch, expectedUpdatedAt)], 'shipment')
  await writeAudit('SHIPMENT', shipmentId, `SET_SHIPMENT_STATUS:${requested}`, caller, { from: current, to: patch.status, reason })
  return readBundle(shipmentId) as unknown as Row
}

/**
 * Re-derive the shipment's status from its legs after any load-level change.
 * Sticky states (draft, tender, hold, cancel) are left alone — a truck arriving
 * does not take a shipment off hold.
 */
async function rederiveShipmentStatus(shipmentId: string, caller: Caller): Promise<Row> {
  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  const current = String(shipment.status ?? 'DRAFT') as ShipmentStatus
  const derived = shipmentStatusFromLoads(
    bundle.loads.map((l) => ({
      status: (l.status ?? null) as LoadWorkflowStatus | null,
      carrierStatuses: bundle.loadCarriers
        .filter((c) => c.loadId === l.id)
        .map((c) => String(c.status) as LoadCarrierStatus),
    })),
    current,
  )
  const mirrors = shipmentMirrors(bundle.loads)
  const now = nowIso()
  const patch: Row = {
    ...mirrors,
    searchKey: buildSearchKey(shipment, bundle.orders, bundle.loads),
    updatedBy: caller.email,
    updatedAt: now,
    version: (numberOrNull(shipment.version) ?? 1) + 1,
  }
  if (derived !== current) {
    patch.status = derived
    patch.previousStatus = current
    patch.statusChangedAt = now
    patch.statusChangedBy = caller.email
  }
  await transact([updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, patch, null)], 'shipment')
  return readBundle(shipmentId) as unknown as Row
}

// ── SET_LOAD_STATUS ──────────────────────────────────────────────────────────

async function setLoadStatus(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const requested = assertEnum(input.status, LOAD_STATUS_VALUES, 'status')
  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')

  const current = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  if (requested === 'INVOICING') {
    throw new Error('INVOICING is set by invoicing, not by hand')
  }
  if (!canTransitionLoadStatus(current, requested)) {
    throw new Error(`A load cannot go from ${current ?? 'SOURCING'} to ${requested}`)
  }

  const now = nowIso()
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadId,
      status: requested,
      statusChangedAt: now,
      statusChangedBy: caller.email,
      statusSource: optionalEnum(input.statusSource, ['USER', 'DRIVER_APP', 'CHECK_CALL', 'BACKFILL'] as const, 'statusSource') ?? 'USER',
      updatedBy: caller.email,
    }),
    'Load update',
  )
  await writeAudit('LOAD', loadId, 'SET_LOAD_STATUS', caller, { from: current, to: requested })
  return rederiveShipmentStatus(shipmentId, caller)
}

// ── DELETE / RESTORE ─────────────────────────────────────────────────────────

const DELETABLE_STATUSES: readonly string[] = ['DRAFT', 'CANCELED', 'TENDER_REJECTED']

async function deleteShipment(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (shipment.deletedAt) throw new Error('That shipment is already deleted')
  const settings = await getSettings()
  await requireAdminForCancelDelete('DELETE_SHIPMENT', caller, settings)
  const status = String(shipment.status ?? '')
  if (!DELETABLE_STATUSES.includes(status)) {
    throw new Error(`A ${status} shipment cannot be deleted — cancel it first`)
  }
  const now = nowIso()
  await transact(
    [updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
      deletedAt: now,
      deletedBy: caller.email,
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(shipment.version) ?? 1) + 1,
    }, expectedUpdatedAt)],
    'shipment',
  )
  await writeAudit('SHIPMENT', shipmentId, 'DELETE_SHIPMENT', caller, { status })
  return readBundle(shipmentId) as unknown as Row
}

async function restoreShipment(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (!shipment.deletedAt) throw new Error('That shipment is not deleted')
  const settings = await getSettings()
  await requireAdminForCancelDelete('RESTORE_SHIPMENT', caller, settings)
  const now = nowIso()
  await transact(
    [updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
      deletedAt: null,
      deletedBy: null,
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(shipment.version) ?? 1) + 1,
    }, expectedUpdatedAt)],
    'shipment',
  )
  await writeAudit('SHIPMENT', shipmentId, 'RESTORE_SHIPMENT', caller, {})
  return readBundle(shipmentId) as unknown as Row
}

// ── TENDER_RESPOND ───────────────────────────────────────────────────────────

async function tenderRespond(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const decision = assertEnum(input.decision, ['ACCEPT', 'REJECT', 'RESET'] as const, 'decision')
  const reason = optionalString(input.reason, 500)

  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  if (shipment.deletedAt) throw new Error('That shipment is deleted')
  const current = String(shipment.status ?? '')
  const now = nowIso()
  const patch: Row = {
    statusChangedAt: now,
    statusChangedBy: caller.email,
    updatedBy: caller.email,
    updatedAt: now,
    version: (numberOrNull(shipment.version) ?? 1) + 1,
  }

  if (decision === 'ACCEPT') {
    if (current !== 'TENDER_PENDING') throw new Error('Only a pending tender can be accepted')
    const customer = await getActiveCustomer(String(shipment.customerId))
    const settings = await getSettings()
    const revenue = bundle.orders.reduce((sum, o) => sum + (numberOrNull(o.revenueCents) ?? 0), 0)
    assertCreditClear(await creditSummary(customer, settings, revenue), String(customer.name ?? shipment.customerId))
    patch.status = 'OPEN'
    patch.previousStatus = current
    patch.tenderRejectReason = null
  } else if (decision === 'REJECT') {
    if (current !== 'TENDER_PENDING') throw new Error('Only a pending tender can be rejected')
    if (!reason) throw new Error('A tender rejection reason is required')
    patch.status = 'TENDER_REJECTED'
    patch.previousStatus = current
    patch.tenderRejectReason = reason
  } else {
    if (current !== 'TENDER_REJECTED') throw new Error('Only a rejected tender can be reset')
    patch.status = 'TENDER_PENDING'
    patch.previousStatus = current
    patch.tenderRejectReason = null
  }

  const writes: TransactWriteItem[] = [updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, patch, expectedUpdatedAt)]
  await transact(writes, 'shipment')

  // Whoever accepts the tender owns covering it.
  if (decision === 'ACCEPT') {
    const client = await getDataClient()
    for (const load of bundle.loads) {
      assertLoadWriteOk(
        await client.models.Load.update({
          id: String(load.id),
          carrierRepId: caller.sub || caller.email,
          updatedBy: caller.email,
        }),
        'Load update',
      )
    }
  }

  await writeAudit('SHIPMENT', shipmentId, `TENDER_RESPOND:${decision}`, caller, { from: current, to: patch.status, reason })
  return readBundle(shipmentId) as unknown as Row
}

// ── DUPLICATE_SHIPMENT ───────────────────────────────────────────────────────

function shiftStops(stops: StopShape[], pickupAppt: string | null, deliveryAppt: string | null): StopShape[] {
  return stops.map((s) => {
    const next: StopShape = {
      ...s,
      id: `stp-${randomUUID()}`,
      // A copy has not happened yet: the facility events and the driver do not
      // travel with it, only the plan does.
      arrivedAt: null,
      departedAt: null,
      driverId: null,
      truckId: null,
    }
    if (s.type === 'pickup' && pickupAppt) next.appt = pickupAppt
    if (s.type === 'delivery' && deliveryAppt) next.appt = deliveryAppt
    return next
  })
}

async function duplicateShipment(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const sameCarrier = optionalBoolean(input.sameCarrier) ?? false
  const copies = assertArrayOf(input.copies, 'copies', (item, i) => {
    const c = assertRecord(item, `copies[${i}]`)
    return {
      pickupAppt: optionalIso(c.pickupAppt, `copies[${i}].pickupAppt`),
      deliveryAppt: optionalIso(c.deliveryAppt, `copies[${i}].deliveryAppt`),
    }
  }, MAX_DUPLICATE_COPIES)
  if (copies.length === 0) throw new Error('copies must have at least one entry')

  const source = await readBundle(shipmentId)
  const customer = await getActiveCustomer(String(source.shipment.customerId))
  const settings = await getSettings()

  const sourceRevenue = source.orders.reduce((sum, o) => sum + (numberOrNull(o.revenueCents) ?? 0), 0)
  const summary = await creditSummary(customer, settings, sourceRevenue * copies.length)
  assertCreditClear(summary, String(customer.name ?? source.shipment.customerId))

  const sourceOrder = source.orders[0]
  const sourceLoad = source.loads[0]
  if (!sourceOrder || !sourceLoad) throw new Error('That shipment cannot be duplicated: it has no order or load')
  const sourceCarrier = source.loadCarriers.find((c) => c.loadId === sourceLoad.id && c.status === 'ACTIVE') ?? null
  const sourceCharges = source.charges.map(chargeRowToInput)
  const client = await getDataClient()
  const created: string[] = []

  for (const copy of copies) {
    const number = await nextShipmentNumber(caller)
    const newShipmentId = `shp-${randomUUID()}`
    const newOrderId = `ord-${randomUUID()}`
    const newLoadId = `lod-${randomUUID()}`
    const newCarrierId = `lcr-${randomUUID()}`
    const stops = shiftStops(readStops(sourceLoad), copy.pickupAppt, copy.deliveryAppt)
    const now = nowIso()

    const charges = sourceCharges.map((c) => ({
      ...c,
      id: null,
      loadId: newLoadId,
      loadCarrierId: c.side === 'CARRIER' && sameCarrier ? newCarrierId : null,
    })).filter((c) => c.side === 'CUSTOMER' || sameCarrier)

    const { amounts, totals } = priceFor(
      charges,
      { miles: numberOrNull(sourceLoad.miles), weightLbs: numberOrNull(sourceLoad.weight) },
      pricingDefaultsOf(customer),
      marginFloorBpsOf(settings),
    )
    const legacy = deriveLegacyFields(stops)
    const mirrors = shipmentMirrors([{ stops: JSON.stringify(stops) }])

    const shipmentRow: Row = {
      ...source.shipment,
      id: newShipmentId,
      __typename: 'Shipment',
      number,
      status: 'DRAFT',
      previousStatus: null,
      statusChangedAt: now,
      statusChangedBy: caller.email,
      holdReason: null,
      cancelReason: null,
      tenderRejectReason: null,
      deletedAt: null,
      deletedBy: null,
      orderIds: [newOrderId],
      loadIds: [newLoadId],
      ...mirrors,
      source: 'DUPLICATE',
      createdBy: caller.email,
      updatedBy: caller.email,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    shipmentRow.searchKey = buildSearchKey(shipmentRow, [sourceOrder], [{ stops: JSON.stringify(stops) }])

    const orderRow: Row = {
      ...sourceOrder,
      id: newOrderId,
      __typename: 'Order',
      shipmentId: newShipmentId,
      customerRateCents: totals.customerRateCents,
      revenueCents: totals.revenueCents,
      arStatus: 'DOCS_NEEDED',
      arStatusChangedAt: now,
      invoiceId: null,
      readyToInvoiceAt: null,
      pickupAppt: mirrors.pickupAppt,
      createdBy: caller.email,
      updatedBy: caller.email,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }

    const writes: TransactWriteItem[] = [
      putItem(SHIPMENT_TABLE_NAME, shipmentRow),
      putItem(ORDER_TABLE_NAME, orderRow),
      putItem(LOAD_FINANCIALS_TABLE_NAME, financialsRow(newLoadId, newShipmentId, newOrderId, totals, 1, caller, null)),
      ...charges.map((c, i) =>
        putItem(LOAD_CHARGE_TABLE_NAME, chargeRow(c, amounts[i], { shipmentId: newShipmentId, orderId: newOrderId, loadId: newLoadId }, caller)),
      ),
    ]
    if (sameCarrier && sourceCarrier) {
      writes.push(putItem(LOAD_CARRIER_TABLE_NAME, {
        ...sourceCarrier,
        id: newCarrierId,
        __typename: 'LoadCarrier',
        loadId: newLoadId,
        shipmentId: newShipmentId,
        status: 'ACTIVE',
        sequence: 1,
        removalReason: null,
        removedAt: null,
        removedBy: null,
        rateConSignedAt: null,
        rateConKey: null,
        chargesFinalizedAt: null,
        carrierRateCents: totals.carrierRateCents,
        costCents: totals.costCents,
        apStatus: 'AWAITING_INVOICE',
        invoiceId: null,
        createdBy: caller.email,
        updatedBy: caller.email,
        createdAt: now,
        updatedAt: now,
      }))
    }
    await transact(writes, 'shipment')

    assertLoadWriteOk(
      await client.models.Load.create({
        ...buildLoadInput(
          {
            id: newLoadId,
            shipmentId: newShipmentId,
            orderId: newOrderId,
            shipmentNumber: number,
            leg: 1,
            customerId: String(source.shipment.customerId),
            customerName: optionalString(source.shipment.customerName, 200),
            stops,
            rateCents: totals.revenueCents,
            equipmentType: optionalString(sourceOrder.equipmentType, 80),
            divisionKey: optionalString(sourceLoad.divisionKey, 100),
            carrierRepId: optionalString(sourceLoad.carrierRepId, 100),
            status: sameCarrier && sourceCarrier ? 'BOOKED' : 'SOURCING',
          },
          caller,
        ),
        miles: numberOrNull(sourceLoad.miles),
        weight: numberOrNull(sourceLoad.weight),
        commodity: optionalString(sourceLoad.commodity, 200),
        assignmentType: sameCarrier && sourceCarrier ? sourceCarrier.kind : 'NEED_TO_COVER',
        activeLoadCarrierId: sameCarrier && sourceCarrier ? newCarrierId : null,
        carrierName: sameCarrier && sourceCarrier ? optionalString(sourceCarrier.carrierName, 200) : null,
        pickupMonth: monthOf(legacy.pickupAppt as string),
      }),
      'Load create',
    )
    created.push(newShipmentId)
  }

  await writeAudit('SHIPMENT', shipmentId, 'DUPLICATE_SHIPMENT', caller, { copies: created.length, created })
  // Every action answers with the bundle of the shipment it was asked about; the
  // board re-reads itself to pick up the new copies.
  return readBundle(shipmentId) as unknown as Row
}

// ── UPDATE_STOP ──────────────────────────────────────────────────────────────

async function updateStop(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const op = assertEnum(input.op, STOP_OPS, 'op') as StopOp
  const stopId = optionalString(input.stopId, 100)
  const patch = assertRecord(input.patch ?? {}, 'patch')

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  if (String(load.updatedAt ?? '') !== expectedUpdatedAt) throw conflictError('load', null)
  const shipmentId = optionalString(load.shipmentId, 100)

  let stops = readStops(load)
  const indexOfStop = (): number => {
    if (!stopId) throw new Error('stopId is required for this stop change')
    const i = stops.findIndex((s) => s.id === stopId)
    if (i === -1) throw new Error(`Stop not found: ${stopId}`)
    return i
  }

  switch (op) {
    case 'ADD': {
      const added = validateStop({ ...patch, sequence: stops.length }, stops.length)
      const at = optionalInteger(patch.insertAt, { min: 0, label: 'patch.insertAt' })
      if (at == null || at >= stops.length) stops = [...stops, added]
      else stops = [...stops.slice(0, at), added, ...stops.slice(at)]
      break
    }
    case 'REMOVE': {
      const i = indexOfStop()
      const next = stops.filter((_, idx) => idx !== i)
      // A movement always keeps somewhere to load and somewhere to unload.
      if (!next.some((s) => s.type === 'pickup') || !next.some((s) => s.type === 'delivery')) {
        throw new Error('A load must keep at least one pickup and one delivery')
      }
      stops = next
      break
    }
    case 'SWAP': {
      const i = indexOfStop()
      const withId = assertString(patch.withStopId, 'patch.withStopId')
      const j = stops.findIndex((s) => s.id === withId)
      if (j === -1) throw new Error(`Stop not found: ${withId}`)
      const next = [...stops]
      const tmp = next[i]
      next[i] = next[j]
      next[j] = tmp
      stops = next
      break
    }
    case 'SET_TYPE': {
      const i = indexOfStop()
      const type = assertEnum(patch.type, STOP_TYPES, 'patch.type')
      const next = stops.map((s, idx) => (idx === i ? { ...s, type } : s))
      if (!next.some((s) => s.type === 'pickup') || !next.some((s) => s.type === 'delivery')) {
        throw new Error('A load must keep at least one pickup and one delivery')
      }
      stops = next
      break
    }
    case 'SET_APPT': {
      const i = indexOfStop()
      stops = stops.map((s, idx) => idx === i ? {
        ...s,
        appt: assertIso(patch.appt, 'patch.appt'),
        apptEnd: optionalIso(patch.apptEnd, 'patch.apptEnd'),
        apptType: optionalString(patch.apptType, 32) ?? s.apptType ?? null,
        apptNote: optionalString(patch.apptNote, 1000),
      } : s)
      break
    }
    case 'SET_REQUESTED': {
      const i = indexOfStop()
      stops = stops.map((s, idx) => idx === i ? {
        ...s,
        requestedStart: optionalIso(patch.requestedStart, 'patch.requestedStart'),
        requestedEnd: optionalIso(patch.requestedEnd, 'patch.requestedEnd'),
        apptRequestedBy: optionalEnum(patch.apptRequestedBy, APPT_REQUESTED_BY, 'patch.apptRequestedBy'),
        apptNote: optionalString(patch.apptNote, 1000) ?? s.apptNote ?? null,
      } : s)
      break
    }
    case 'SET_TIMES': {
      const i = indexOfStop()
      const arrivedAt = optionalIso(patch.arrivedAt, 'patch.arrivedAt')
      const departedAt = optionalIso(patch.departedAt, 'patch.departedAt')
      if (arrivedAt && departedAt && Date.parse(departedAt) < Date.parse(arrivedAt)) {
        throw new Error('A stop cannot be departed before it was arrived')
      }
      stops = stops.map((s, idx) => idx === i ? {
        ...s,
        arrivedAt: arrivedAt ?? (patch.arrivedAt === null ? null : s.arrivedAt ?? null),
        departedAt: departedAt ?? (patch.departedAt === null ? null : s.departedAt ?? null),
      } : s)
      break
    }
    case 'SET_REFS': {
      const i = indexOfStop()
      const refs = assertArrayOf(patch.refs ?? [], 'patch.refs', validateStopReference)
      stops = stops.map((s, idx) => idx === i ? {
        ...s,
        refs,
        stopNotes: optionalString(patch.stopNotes, 2000) ?? s.stopNotes ?? null,
        documentContact: patch.documentContact == null ? s.documentContact ?? null : validateContact(patch.documentContact, 'patch.documentContact'),
      } : s)
      break
    }
    case 'SET_LOCATION': {
      const i = indexOfStop()
      stops = stops.map((s, idx) => idx === i ? {
        ...s,
        locationId: optionalString(patch.locationId, 100),
        name: optionalString(patch.name, 200),
        city: optionalString(patch.city, 120),
        address: patch.address == null ? null : assertRecord(patch.address, 'patch.address'),
        contact: patch.contact == null ? s.contact ?? null : validateContact(patch.contact, 'patch.contact'),
      } : s)
      break
    }
  }

  stops = resequence(stops)
  assertStopShape(stops, false)
  const legacy = deriveLegacyFields(stops)

  // Stop times are the one thing that moves a load forward on its own: a truck that
  // has left the pickup is in transit whatever anybody typed.
  const currentStatus = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  const derivedStatus = op === 'SET_TIMES'
    ? loadStatusFromStopTimes(
        stops.map((s) => ({
          type: s.type === 'delivery' ? 'delivery' as const : 'pickup' as const,
          sequence: s.sequence ?? 0,
          arrivedAt: s.arrivedAt ?? null,
          departedAt: s.departedAt ?? null,
        })),
        currentStatus,
      )
    : currentStatus

  const now = nowIso()
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update(
      {
        id: loadId,
        stops: JSON.stringify(stops),
        ...legacy,
        pickupMonth: monthOf(legacy.pickupAppt as string),
        ...(derivedStatus && derivedStatus !== currentStatus
          ? { status: derivedStatus, statusChangedAt: now, statusChangedBy: caller.email, statusSource: 'USER' }
          : {}),
        updatedBy: caller.email,
      },
      { condition: { updatedAt: { eq: expectedUpdatedAt } } },
    ),
    'Load update',
  )

  await writeAudit('LOAD', loadId, `UPDATE_STOP:${op}`, caller, { stopId, stops: stops.length, status: derivedStatus })
  if (!shipmentId) return { id: loadId, stops } as unknown as Row
  return rederiveShipmentStatus(shipmentId, caller)
}

// ── Assignment ───────────────────────────────────────────────────────────────

/**
 * Retire whichever carrier currently holds the load. Nothing is deleted: the row
 * keeps why it stopped being the answer, which is the entire point of having it.
 */
function retireCarrier(existing: Row, reason: string, outcome: 'BOUNCED' | 'TONU', caller: Caller): TransactWriteItem {
  const now = nowIso()
  return updateItemTx(LOAD_CARRIER_TABLE_NAME, String(existing.id), {
    status: outcome,
    removalReason: reason,
    removedAt: now,
    removedBy: caller.email,
    updatedBy: caller.email,
    updatedAt: now,
  }, null)
}

async function assignAsset(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const driverId = assertString(input.driverId, 'driverId')
  const truckId = optionalString(input.truckId, 100)
  const trailerId = optionalString(input.trailerId, 100)
  const driverName = optionalString(input.driverName, 120)
  const driverPhone = optionalString(input.driverPhone, 40)
  const driver2 = input.driver2 == null ? null : assertRecord(input.driver2, 'driver2')

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')

  const carriers = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
  const activeCarrier = carriers.find((c) => c.status === 'ACTIVE') ?? null
  const sequence = carriers.reduce((max, c) => Math.max(max, numberOrNull(c.sequence) ?? 0), 0) + 1
  const newCarrierId = `lcr-${randomUUID()}`
  const now = nowIso()

  const writes: TransactWriteItem[] = []
  if (activeCarrier) writes.push(retireCarrier(activeCarrier, 'REASSIGNED', 'BOUNCED', caller))
  writes.push(putItem(LOAD_CARRIER_TABLE_NAME, {
    id: newCarrierId,
    __typename: 'LoadCarrier',
    loadId,
    shipmentId,
    kind: 'OWN_ASSET',
    status: 'ACTIVE',
    sequence,
    driverId,
    driverName,
    driverPhone,
    driver2Name: driver2 == null ? null : optionalString(driver2.name, 120),
    driver2Phone: driver2 == null ? null : optionalString(driver2.phone, 40),
    truckId,
    truckNumber: optionalString(input.truckNumber, 40),
    trailerId,
    trailerNumber: optionalString(input.trailerNumber, 40),
    carrierRateCents: 0,
    costCents: 0,
    apStatus: 'AWAITING_INVOICE',
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }))
  await transact(writes, 'assignment')

  // The driver and truck live on the stops — exactly where the dispatch drawer puts
  // them — so every own-fleet reader keeps seeing the assignment it already understands.
  const stops = readStops(load).map((s) => ({ ...s, driverId, ...(truckId ? { truckId } : {}) }))
  const legacy = deriveLegacyFields(stops)
  const currentStatus = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  const nextStatus = currentStatus == null || currentStatus === 'SOURCING' ? 'BOOKED' : currentStatus

  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadId,
      stops: JSON.stringify(stops),
      ...legacy,
      truckId: truckId ?? load.truckId ?? null,
      trailerNumber: optionalString(input.trailerNumber, 40) ?? load.trailerNumber ?? null,
      assignmentType: 'OWN_ASSET',
      activeLoadCarrierId: newCarrierId,
      carrierName: null,
      trackingProvider: 'DRIVER_APP',
      ...(nextStatus !== currentStatus
        ? { status: nextStatus, statusChangedAt: now, statusChangedBy: caller.email, statusSource: 'USER' }
        : {}),
      updatedBy: caller.email,
    }),
    'Load update',
  )

  await writeAudit('LOAD_CARRIER', newCarrierId, 'ASSIGN_ASSET', caller, { loadId, driverId, truckId })
  return rederiveShipmentStatus(shipmentId, caller)
}

async function assignCarrier(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const carrierName = assertString(input.carrierName, 'carrierName')
  const carrierRateCents = optionalInteger(input.carrierRateCents, { min: 0, label: 'carrierRateCents' })

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')

  const carriers = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
  const activeCarrier = carriers.find((c) => c.status === 'ACTIVE') ?? null
  const sequence = carriers.reduce((max, c) => Math.max(max, numberOrNull(c.sequence) ?? 0), 0) + 1
  const newCarrierId = `lcr-${randomUUID()}`
  const now = nowIso()

  const financials = await getById(LOAD_FINANCIALS_TABLE_NAME, loadId)
  if (financials?.frozenAt) throw new Error('This load\'s financials are frozen and can no longer be changed')

  const writes: TransactWriteItem[] = []
  if (activeCarrier) writes.push(retireCarrier(activeCarrier, 'REASSIGNED', 'BOUNCED', caller))
  writes.push(putItem(LOAD_CARRIER_TABLE_NAME, {
    id: newCarrierId,
    __typename: 'LoadCarrier',
    loadId,
    shipmentId,
    kind: 'CARRIER',
    status: 'ACTIVE',
    sequence,
    carrierId: optionalString(input.carrierId, 100),
    carrierName,
    carrierMc: optionalString(input.carrierMc, 40),
    carrierRepId: optionalString(input.carrierRepId, 100) ?? optionalString(load.carrierRepId, 100),
    dispatcherName: optionalString(input.dispatcherName, 120),
    dispatcherPhone: optionalString(input.dispatcherPhone, 40),
    dispatcherEmail: optionalString(input.dispatcherEmail, 200),
    driverName: optionalString(input.driverName, 120),
    driverPhone: optionalString(input.driverPhone, 40),
    truckNumber: optionalString(input.truckNumber, 40),
    trailerNumber: optionalString(input.trailerNumber, 40),
    plates: optionalString(input.plates, 40),
    vin: optionalString(input.vin, 40),
    sealNumber: optionalString(input.sealNumber, 40),
    tripNumber: optionalString(input.tripNumber, 40),
    carrierRateCents: carrierRateCents ?? 0,
    costCents: carrierRateCents ?? 0,
    apStatus: 'AWAITING_INVOICE',
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }))
  // The agreed rate is a charge line like any other, so one place adds up the cost.
  if (carrierRateCents != null) {
    writes.push(putItem(LOAD_CHARGE_TABLE_NAME, chargeRow(
      {
        id: null,
        side: 'CARRIER',
        code: 'LINEHAUL',
        label: 'Linehaul',
        calculatedBy: 'FLAT',
        rateCents: carrierRateCents,
        count: 1,
        isRate: true,
        release: null,
        sortOrder: 0,
        note: null,
        loadId,
        loadCarrierId: newCarrierId,
      },
      carrierRateCents,
      { shipmentId, orderId: String(load.orderId ?? ''), loadId },
      caller,
    )))
  }
  await transact(writes, 'assignment')

  const currentStatus = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  const nextStatus = currentStatus == null || currentStatus === 'SOURCING' ? 'BOOKED' : currentStatus
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadId,
      assignmentType: 'CARRIER',
      activeLoadCarrierId: newCarrierId,
      carrierName,
      trackingProvider: optionalEnum(input.trackingProvider, ['NONE', 'MANUAL', 'LINK', 'DRIVER_APP', 'MOTIVE'] as const, 'trackingProvider') ?? 'MANUAL',
      ...(nextStatus !== currentStatus
        ? { status: nextStatus, statusChangedAt: now, statusChangedBy: caller.email, statusSource: 'USER' }
        : {}),
      updatedBy: caller.email,
    }),
    'Load update',
  )

  await writeAudit('LOAD_CARRIER', newCarrierId, 'ASSIGN_CARRIER', caller, { loadId, carrierName, carrierRateCents })
  return rederiveShipmentStatus(shipmentId, caller)
}

async function removeLoadCarrier(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const outcome = assertEnum(input.outcome, ['BOUNCED', 'TONU'] as const, 'outcome')
  // Why a carrier came off a load is the whole record; it is never optional.
  const reason = assertString(input.reason, 'reason')

  const carrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!carrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (carrier.status !== 'ACTIVE') throw new Error('That assignment has already been removed')
  const loadId = String(carrier.loadId)
  const shipmentId = String(carrier.shipmentId)
  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)

  await transact([retireCarrier(carrier, reason, outcome, caller)], 'assignment')

  // A bounce takes the carrier's money off the load with it. A TONU does not: the
  // truck showed up and is owed, so that line stays and keeps being paid.
  if (outcome === 'BOUNCED') {
    const charges = await queryIndex(LOAD_CHARGE_TABLE_NAME, IDX_CHARGES_BY_SHIPMENT, 'shipmentId', shipmentId)
    const theirs = charges.filter((c) => c.loadCarrierId === loadCarrierId)
    if (theirs.length > 0) {
      await transact(theirs.map((c) => deleteItemTx(LOAD_CHARGE_TABLE_NAME, String(c.id))), 'charges')
    }
  }

  const now = nowIso()
  const stops = readStops(load).map((s) => ({ ...s, driverId: null }))
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadId,
      ...(carrier.kind === 'OWN_ASSET' ? { stops: JSON.stringify(stops), ...deriveLegacyFields(stops) } : {}),
      assignmentType: 'NEED_TO_COVER',
      activeLoadCarrierId: null,
      carrierName: null,
      trackingProvider: 'NONE',
      status: 'SOURCING',
      statusChangedAt: now,
      statusChangedBy: caller.email,
      statusSource: 'USER',
      updatedBy: caller.email,
    }),
    'Load update',
  )

  await writeAudit('LOAD_CARRIER', loadCarrierId, `REMOVE_LOAD_CARRIER:${outcome}`, caller, { loadId, reason })
  return rederiveShipmentStatus(shipmentId, caller)
}

// ── RECALC_CHARGES ───────────────────────────────────────────────────────────

async function recalcCharges(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedVersion = optionalInteger(input.expectedVersion, { min: 0, label: 'expectedVersion' })
  if (expectedVersion == null) throw new Error('expectedVersion is required')

  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  if (shipment.deletedAt) throw new Error('That shipment is deleted')
  const currentVersion = numberOrNull(shipment.version) ?? 1
  if (currentVersion !== expectedVersion) throw conflictError('shipment', null)

  const order = bundle.orders[0]
  const load = bundle.loads[0]
  if (!order || !load) throw new Error('That shipment has no order or load to price')
  const loadId = String(load.id)
  const orderId = String(order.id)

  const existingFinancials = bundle.financials.find((f) => f.id === loadId) ?? null
  if (existingFinancials?.frozenAt) {
    throw new Error('This load\'s financials are frozen and can no longer be changed')
  }

  const customer = await getById(CUSTOMER_TABLE_NAME, String(shipment.customerId))
  const settings = await getSettings()
  const rules = chargeCodeRules(settings, customer)
  const charges = assertArrayOf(input.charges, 'charges', (item, i) => validateChargeInput(item, i, rules))

  const activeCarrier = bundle.loadCarriers.find((c) => c.loadId === loadId && c.status === 'ACTIVE') ?? null
  const { amounts, totals } = priceFor(
    charges,
    { miles: numberOrNull(load.miles), weightLbs: numberOrNull(load.weight) },
    pricingDefaultsOf(customer),
    marginFloorBpsOf(settings),
  )

  const chargeRows = charges.map((c, i) => chargeRow(
    { ...c, loadCarrierId: c.loadCarrierId ?? (c.side === 'CARRIER' ? (activeCarrier ? String(activeCarrier.id) : null) : null) },
    amounts[i],
    { shipmentId, orderId, loadId },
    caller,
  ))
  const keptIds = new Set(chargeRows.map((r) => String(r.id)))
  const removed = bundle.charges.filter((r) => !keptIds.has(String(r.id)))
  const now = nowIso()

  const writes: TransactWriteItem[] = [
    ...chargeRows.map((row) => putItem(LOAD_CHARGE_TABLE_NAME, row, false)),
    ...removed.map((row) => deleteItemTx(LOAD_CHARGE_TABLE_NAME, String(row.id))),
    putItem(
      LOAD_FINANCIALS_TABLE_NAME,
      financialsRow(loadId, shipmentId, orderId, totals, (numberOrNull(existingFinancials?.version) ?? 0) + 1, caller, existingFinancials),
      false,
    ),
    updateItemTx(ORDER_TABLE_NAME, orderId, {
      customerRateCents: totals.customerRateCents,
      revenueCents: totals.revenueCents,
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(order.version) ?? 1) + 1,
    }, null),
    updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
      updatedBy: caller.email,
      updatedAt: now,
      version: currentVersion + 1,
    }, String(shipment.updatedAt ?? '')),
  ]
  if (activeCarrier) {
    writes.push(updateItemTx(LOAD_CARRIER_TABLE_NAME, String(activeCarrier.id), {
      carrierRateCents: totals.carrierRateCents,
      costCents: totals.costCents,
      updatedBy: caller.email,
      updatedAt: now,
    }, null))
  }
  await transact(writes, 'charges')

  // `Load.rate` is what the calendar, settlements and factoring read; it mirrors
  // the order's revenue and is rewritten with it.
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({ id: loadId, rate: totals.revenueCents, updatedBy: caller.email }),
    'Load update',
  )

  await writeAudit('SHIPMENT', shipmentId, 'RECALC_CHARGES', caller, {
    lines: chargeRows.length,
    revenueCents: totals.revenueCents,
    costCents: totals.costCents,
  })
  return readBundle(shipmentId) as unknown as Row
}

// ── SET_AR_STATUS ────────────────────────────────────────────────────────────

async function setArStatus(input: Row, caller: Caller): Promise<Row> {
  const orderId = assertString(input.orderId, 'orderId')
  const requested = assertEnum(input.status, AR_STATUSES, 'status')
  if (!AR_STATUSES_WRITABLE.includes(requested)) {
    throw new Error(`${requested} is recorded by invoicing, not set by hand`)
  }

  const order = await getById(ORDER_TABLE_NAME, orderId)
  if (!order) throw new Error(`Order not found: ${orderId}`)
  const shipment = await getById(SHIPMENT_TABLE_NAME, String(order.shipmentId))
  if (!shipment) throw new Error(`Shipment not found: ${String(order.shipmentId)}`)

  const revenue = numberOrNull(order.revenueCents) ?? 0
  if (requested === 'UNBILLED') {
    const delivered = shipment.status === 'DELIVERED'
    if (!delivered && order.invoiceEarly !== true) {
      throw new Error('An order is only ready to bill once it is delivered, or when it is marked to invoice early')
    }
  }
  if (requested === 'INVOICE_NOT_NEEDED' && revenue !== 0) {
    throw new Error('An order with revenue still needs an invoice')
  }

  const now = nowIso()
  await transact(
    [updateItemTx(ORDER_TABLE_NAME, orderId, {
      arStatus: requested,
      arStatusChangedAt: now,
      readyToInvoiceAt: requested === 'UNBILLED' ? now : order.readyToInvoiceAt ?? null,
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(order.version) ?? 1) + 1,
    }, null)],
    'order',
  )
  await writeAudit('ORDER', orderId, 'SET_AR_STATUS', caller, { from: order.arStatus, to: requested })
  return readBundle(String(order.shipmentId)) as unknown as Row
}

// ── BACKFILL_SHIPMENT ────────────────────────────────────────────────────────

/**
 * Legal-suffix and stop-word stripping, matching `scripts/lib/tmsNormalize.mjs`
 * exactly. The customer backfill wrote `Customer.normalizedName` with that
 * function, so a different key here would fail to find a customer's own row.
 */
const CUSTOMER_LEGAL_SUFFIXES: Record<string, true> = {
  llc: true, inc: true, incorporated: true, corp: true, corporation: true,
  ltd: true, limited: true, co: true, company: true, lp: true, llp: true, dba: true,
}
const CUSTOMER_STOP_WORDS: Record<string, true> = {
  a: true, an: true, the: true, of: true, for: true, and: true,
}

function normalizeCustomerName(raw: unknown): string {
  const text = (typeof raw === 'string' ? raw : '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text
    .split(' ')
    .filter((word, i) => word !== '' && !CUSTOMER_LEGAL_SUFFIXES[word] && (i === 0 || !CUSTOMER_STOP_WORDS[word]))
    .join(' ')
}

/**
 * Every live customer's name, alias and stored dedupe key, from one whole-table
 * read — the batch is up to 50 loads and the roster is a few hundred rows.
 *
 * A key two different customers both answer to is mapped to null: a legacy load
 * naming it cannot be assigned to either without guessing, and guessing here
 * would hang one customer's revenue on another customer's ledger.
 */
async function customerIdsByName(): Promise<Map<string, string | null>> {
  const byName = new Map<string, string | null>()
  for (const row of await scanTable(CUSTOMER_TABLE_NAME)) {
    if (row.mergedIntoId) continue
    const active = row.status == null ? row.active !== false : row.status === 'ACTIVE'
    if (!active) continue
    const id = String(row.id)
    const aliases = Array.isArray(row.aliases) ? row.aliases : []
    for (const candidate of [row.normalizedName, row.name, ...aliases]) {
      const key = normalizeCustomerName(candidate)
      if (!key) continue
      const seen = byName.get(key)
      if (seen === undefined) byName.set(key, id)
      else if (seen !== id) byName.set(key, null)
    }
  }
  return byName
}

/**
 * The customer this legacy load sells to: the id it already carries, or the one
 * customer whose name or alias it names. Unmatched is reported, never invented —
 * `customerId` is the hash key of Shipment's and Order's customer index, and an
 * empty string there is a write DynamoDB rejects outright.
 */
function resolveBackfillCustomerId(load: Row, byName: Map<string, string | null>): string | null {
  const direct = optionalString(load.customerId, 100)
  if (direct) return direct
  const key = normalizeCustomerName(load.customer)
  if (!key) return null
  return byName.get(key) ?? null
}

/** Deterministic id for a backfilled row, matching `scripts/lib/tmsPlan.mjs`. */
function stableId(prefix: string, key: string): string {
  return `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

/**
 * Where a legacy load actually got to, from evidence only.
 *
 * The same rule `src/lib/loadStatus.ts` applies on the calendar: facility in/out
 * times are facts, an appointment is a plan, and a plan proves nothing. A departure
 * implies the arrival nobody stamped. `readyToInvoice` is a human saying the work is
 * done, and it outranks the clock — but it still never implies an invoice was sent.
 */
function backfillLoadStatus(load: Row): LoadWorkflowStatus {
  const stops = readStops(load)
  const stamped = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''
  const touched = (s: StopShape) => stamped(s.arrivedAt) || stamped(s.departedAt)
  const pickups = stops.filter((s) => s.type === 'pickup')
  const deliveries = stops.filter((s) => s.type === 'delivery')
  const lastDelivery = deliveries[deliveries.length - 1]

  if (load.readyToInvoice === true) return 'DELIVERED'
  if (lastDelivery && stamped(lastDelivery.departedAt)) return 'DELIVERED'
  if (deliveries.some(touched)) return 'UNLOADING'
  if (pickups.length > 0 && pickups.every((s) => stamped(s.departedAt))) return 'IN_TRANSIT'
  if (pickups.some(touched)) return 'LOADING'

  const anyDriver =
    stops.some((s) => stamped(s.driverId)) || stamped(load.pickupDriverId) || stamped(load.deliveryDriverId)
  if (!anyDriver) return 'SOURCING'
  // Still waiting on an appointment is still work to do, not a planned load.
  if (stops.some((s) => !stamped(s.appt))) return 'SOURCING'
  return 'BOOKED'
}

interface BackfillPlan {
  loadId: string
  shipmentId: string
  orderId: string
  number: string
  customerId: string | null
  loadStatus: LoadWorkflowStatus
  shipmentStatus: ShipmentStatus
  arStatus: ArStatus
  assignmentType: 'OWN_ASSET' | 'NEED_TO_COVER'
  loadCarrierId: string | null
  driverId: string | null
  revenueCents: number
  skipped: string | null
}

/**
 * Map one legacy load onto a Shipment/Order/Load trio.
 *
 * Nothing here invents history: the number keeps the Aljex id the office already
 * says out loud, the status comes from the stop clock, and AR never goes past
 * UNBILLED because no invoice has been recorded for any of these loads.
 */
function planBackfill(load: Row, brokerDriverIds: Set<string>, customerId: string | null): BackfillPlan {
  const loadId = String(load.id)
  const stops = readStops(load)
  const driverIds = stops
    .map((s) => (typeof s.driverId === 'string' ? s.driverId.trim() : ''))
    .filter(Boolean)
  const hasTruck = stops.some((s) => typeof s.truckId === 'string' && s.truckId.trim())
    || (typeof load.truckId === 'string' && load.truckId.trim() !== '')
  // A broker pseudo-driver is not an asset; the load was never covered by our fleet.
  const realDriverId = driverIds.find((id) => !brokerDriverIds.has(id)) ?? null
  const ownAsset = realDriverId != null || (driverIds.length === 0 && hasTruck)

  const loadStatus = backfillLoadStatus(load)
  const revenueCents = numberOrNull(load.rate) ?? 0
  return {
    loadId,
    shipmentId: stableId('shp', loadId),
    orderId: stableId('ord', loadId),
    number: `L${String(load.aljexId ?? loadId)}`,
    customerId,
    loadStatus,
    shipmentStatus: loadStatus === 'SOURCING' ? 'OPEN' : (loadStatus as ShipmentStatus),
    arStatus: loadStatus !== 'DELIVERED' ? 'DOCS_NEEDED' : (load.readyToInvoice === true ? 'UNBILLED' : 'DOCS_NEEDED'),
    assignmentType: ownAsset ? 'OWN_ASSET' : 'NEED_TO_COVER',
    loadCarrierId: ownAsset ? stableId('lcr', loadId) : null,
    driverId: realDriverId,
    revenueCents,
    skipped: load.shipmentId ? 'ALREADY_LINKED' : customerId ? null : 'NO_CUSTOMER_MATCH',
  }
}

async function backfillShipments(input: Row, caller: Caller): Promise<Row> {
  if (!caller.isAdmin) throw new Error('Forbidden: BACKFILL_SHIPMENT requires owner or ADMIN')
  const dryRun = optionalBoolean(input.dryRun) ?? true
  const loadIds = assertArrayOf(input.loadIds, 'loadIds', (v, i) => assertString(v, `loadIds[${i}]`), 50)
  if (loadIds.length === 0) throw new Error('loadIds must have at least one entry')

  const drivers = await scanTable(DRIVER_TABLE_NAME)
  const brokerDriverIds = new Set(
    drivers.filter((d) => String(d.type ?? '').toLowerCase() === 'broker').map((d) => String(d.id)),
  )
  const customersByName = await customerIdsByName()

  const loads = await batchGetByIds(LOAD_TABLE_NAME, loadIds)
  const loadById: Record<string, Row> = {}
  for (const l of loads) loadById[String(l.id)] = l

  const planned: BackfillPlan[] = []
  const missing: string[] = []
  let applied = 0

  for (const loadId of loadIds) {
    const load = loadById[loadId]
    if (!load) {
      missing.push(loadId)
      continue
    }
    const plan = planBackfill(load, brokerDriverIds, resolveBackfillCustomerId(load, customersByName))
    planned.push(plan)
    if (dryRun || plan.skipped) continue

    const now = nowIso()
    const customerName = optionalString(load.customer, 200)
    const legacy = deriveLegacyFields(readStops(load))
    // deriveLegacyFields writes '' for an undated stop, and '' is a key DynamoDB
    // refuses on the three Shipment indexes sorted by pickupAppt. Undated stays absent.
    const pickupAppt = optionalString(legacy.pickupAppt, 64) ?? optionalString(load.pickupAppt, 64) ?? undefined
    const deliveryAppt = optionalString(legacy.deliveryAppt, 64) ?? optionalString(load.deliveryAppt, 64) ?? undefined
    const pickupMonth = monthOf(pickupAppt) ?? undefined

    // A half-finished earlier run leaves the rows but not the link; re-running then
    // only has to repoint the load, and the conditional puts guarantee it either way.
    const already = await getById(SHIPMENT_TABLE_NAME, plan.shipmentId)
    if (!already) {
      const writes: TransactWriteItem[] = [
        putItem(SHIPMENT_TABLE_NAME, {
          id: plan.shipmentId,
          __typename: 'Shipment',
          number: plan.number,
          status: plan.shipmentStatus,
          statusChangedAt: now,
          statusChangedBy: caller.email,
          customerId: plan.customerId ?? undefined,
          customerName,
          mode: 'FTL',
          orderIds: [plan.orderId],
          loadIds: [plan.loadId],
          pickupAppt,
          deliveryAppt,
          pickupMonth,
          originCity: optionalString(load.originCity, 120),
          destinationCity: optionalString(load.destinationCity, 120),
          searchKey: [plan.number, customerName, load.originCity, load.destinationCity, load.pickupNumber]
            .filter(Boolean).join(' ').toLowerCase(),
          source: 'BACKFILL',
          createdBy: caller.email,
          updatedBy: caller.email,
          version: 1,
          createdAt: (load.createdAt as string | undefined) ?? now,
          updatedAt: now,
        }),
        putItem(ORDER_TABLE_NAME, {
          id: plan.orderId,
          __typename: 'Order',
          shipmentId: plan.shipmentId,
          customerId: plan.customerId ?? undefined,
          customerName,
          mode: 'FTL',
          rateType: 'SPOT',
          references: [],
          freight: [],
          customerRateCents: plan.revenueCents,
          revenueCents: plan.revenueCents,
          arStatus: plan.arStatus,
          arStatusChangedAt: now,
          invoiceEarly: false,
          pickupAppt,
          createdBy: caller.email,
          updatedBy: caller.email,
          version: 1,
          createdAt: (load.createdAt as string | undefined) ?? now,
          updatedAt: now,
        }),
        putItem(LOAD_FINANCIALS_TABLE_NAME, {
          id: plan.loadId,
          __typename: 'LoadFinancials',
          loadId: plan.loadId,
          shipmentId: plan.shipmentId,
          orderId: plan.orderId,
          customerRateCents: plan.revenueCents,
          revenueCents: plan.revenueCents,
          carrierRateCents: 0,
          costCents: 0,
          profitCents: plan.revenueCents,
          marginBps: plan.revenueCents > 0 ? 10000 : 0,
          topSpendCents: plan.revenueCents,
          targetBuyCents: null,
          updatedBy: caller.email,
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ]
      if (plan.revenueCents > 0) {
        writes.push(putItem(LOAD_CHARGE_TABLE_NAME, {
          id: stableId('chg', plan.loadId),
          __typename: 'LoadCharge',
          shipmentId: plan.shipmentId,
          side: 'CUSTOMER',
          orderId: plan.orderId,
          loadId: plan.loadId,
          code: 'LINEHAUL',
          label: 'Linehaul',
          calculatedBy: 'FLAT',
          rateCents: plan.revenueCents,
          count: 1,
          amountCents: plan.revenueCents,
          isRate: true,
          sortOrder: 0,
          createdBy: caller.email,
          createdAt: now,
          updatedAt: now,
        }))
      }
      if (plan.loadCarrierId) {
        writes.push(putItem(LOAD_CARRIER_TABLE_NAME, {
          id: plan.loadCarrierId,
          __typename: 'LoadCarrier',
          loadId: plan.loadId,
          shipmentId: plan.shipmentId,
          kind: 'OWN_ASSET',
          status: 'ACTIVE',
          sequence: 1,
          driverId: plan.driverId,
          truckId: optionalString(load.truckId, 100),
          trailerNumber: optionalString(load.trailerNumber, 40),
          carrierRateCents: 0,
          costCents: 0,
          apStatus: 'AWAITING_INVOICE',
          createdBy: caller.email,
          updatedBy: caller.email,
          createdAt: now,
          updatedAt: now,
        }))
      }
      await transact(writes, 'backfill')
    }

    const client = await getDataClient()
    assertLoadWriteOk(
      await client.models.Load.update({
        id: plan.loadId,
        shipmentId: plan.shipmentId,
        orderId: plan.orderId,
        leg: 1,
        loadNumber: `${plan.number}-1`,
        status: plan.loadStatus,
        statusChangedAt: now,
        statusChangedBy: caller.email,
        statusSource: 'BACKFILL',
        assignmentType: plan.assignmentType,
        activeLoadCarrierId: plan.loadCarrierId,
        ...(pickupMonth ? { pickupMonth } : {}),
        updatedBy: caller.email,
      }),
      'Load update',
    )
    applied++
  }

  if (!dryRun && applied > 0) {
    await writeAudit('SHIPMENT', 'BACKFILL', 'BACKFILL_SHIPMENT', caller, { applied, requested: loadIds.length })
  }
  return {
    dryRun,
    requested: loadIds.length,
    applied,
    skipped: planned.filter((p) => p.skipped).map((p) => ({ loadId: p.loadId, reason: p.skipped })),
    missing,
    planned,
  } as unknown as Row
}

// ── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent): Promise<Row> => {
  const action = event.arguments.action as Action
  const caller = await authorize(action, event.identity)
  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'CREATE_SHIPMENT':
      return createShipment(input, caller)
    case 'SAVE_ORDER_FORM':
      return (await saveOrderForm(input, caller)).bundle as unknown as Row
    case 'CHECK_CREDIT':
      return checkCredit(input)
    case 'SUBMIT_ORDER':
      return submitOrder(input, caller)
    case 'SET_SHIPMENT_STATUS':
      return setShipmentStatus(input, caller)
    case 'SET_LOAD_STATUS':
      return setLoadStatus(input, caller)
    case 'DELETE_SHIPMENT':
      return deleteShipment(input, caller)
    case 'RESTORE_SHIPMENT':
      return restoreShipment(input, caller)
    case 'TENDER_RESPOND':
      return tenderRespond(input, caller)
    case 'DUPLICATE_SHIPMENT':
      return duplicateShipment(input, caller)
    case 'UPDATE_STOP':
      return updateStop(input, caller)
    case 'ASSIGN_ASSET':
      return assignAsset(input, caller)
    case 'ASSIGN_CARRIER':
      return assignCarrier(input, caller)
    case 'REMOVE_LOAD_CARRIER':
      return removeLoadCarrier(input, caller)
    case 'RECALC_CHARGES':
      return recalcCharges(input, caller)
    case 'SET_AR_STATUS':
      return setArStatus(input, caller)
    case 'GET_SHIPMENT_BUNDLE':
      return readBundle(assertString(input.shipmentId, 'shipmentId')) as unknown as Row
    case 'BACKFILL_SHIPMENT':
      return backfillShipments(input, caller)
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
