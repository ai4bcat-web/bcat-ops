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
 *
 * Step C adds the outside-carrier side: BOOK_CARRIER runs the shared eligibility
 * gate before it writes an assignment, SET_QUICK_PAY caches the AP deduction,
 * SEND_RATE_CON/VOID_RATE_CON own the rate confirmation's token and S3 copy, and
 * DISPATCH_LOAD moves a booked load onto the road. They reuse the same helpers as
 * everything above — one transaction, one audit row, one CAS.
 *
 * Step D adds the tracking log: LOG_CHECK_CALL writes a LoadCheckCall row, stamps
 * the stop clock and moves the load from it, RESOLVE_INCIDENT closes an exception,
 * SET_NEXT_CHECK_CALL owns the reminder and SET_ETA the carrier's promise. Every
 * change to `checkCallOpen` — a sparse GSI hash key — goes through a raw UpdateItem
 * that REMOVEs, because a stored NULL is an index key DynamoDB refuses.
 */
import { getAmplifyDataClientConfig, type DataClientEnv } from '@aws-amplify/backend-function/runtime'
import { Amplify } from 'aws-amplify'
import { generateClient } from 'aws-amplify/data'
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  ScanCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { createHash, randomBytes, randomUUID } from 'crypto'
import {
  IDX_CARRIERS_BY_SHIPMENT,
  IDX_CHARGES_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  batchGetByIds as storeBatchGetByIds,
  buildSearchKey,
  casCondition,
  conditionCheckUpdatedAtTx,
  conflictError,
  deleteItemTx,
  getById as storeGetById,
  isConflict,
  marshallRow,
  monthOf,
  nowIso,
  numberOrNull,
  putItem,
  queryIndex as storeQueryIndex,
  readBundle as storeReadBundle,
  readStops,
  rederiveShipmentStatus as storeRederiveShipmentStatus,
  shipmentMirrors,
  shipmentStoreFromEnv,
  transact as storeTransact,
  updateItemTx,
  type Bundle,
  type Row,
  type StopShape,
} from '../_shared/shipmentStore'
import {
  assertArrayOf,
  assertEnum,
  assertExpectedUpdatedAt,
  assertIso,
  assertRecord,
  assertString,
  optionalBoolean,
  optionalEnum,
  optionalFloat,
  optionalInteger,
  optionalIso,
  optionalString,
  parseInput,
  type Caller,
} from '../_shared/actionInputs'
import {
  attachDriverDoc,
  commitDocument,
  prepareDocumentUpload,
  rateCarrier,
  readyToInvoice,
  reviewDocument,
  saveGeneratedDocument,
  updateDocument,
  voidDocument,
  type DocumentDeps,
} from './documents'
import {
  acceptCounter,
  cancelQuote,
  convertQuote,
  counterQuote,
  duplicateQuotes,
  markQuoteLost,
  passQuote,
  restoreQuote,
  revertToQuote,
  saveQuote,
  saveQuoteSettings,
  sendQuote,
  sweepExpiredQuotes,
  type BookCarrierExtra,
  type QuoteChargeRules,
  type QuoteDeps,
} from './quotes'
import {
  acceptOffer,
  cancelOpenOffers,
  counterOffer,
  logOffer,
  rejectOffer,
  requestOffers,
} from './offers'
import {
  excludeLaneSample,
  isDeliveredOrLater,
  writeLaneSample,
} from './laneSamples'

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
} from '../../../src/lib/shipmentStatus'
import {
  INCIDENT_TYPES,
  MANUALLY_LOGGABLE_TYPES,
  incidentChargeLines,
  lastKnownPatch,
  stampStopEvent,
  statusAfterCheckCall,
  stopEventId,
} from '../../../src/lib/checkCalls'
import { creditSummaryForCustomer, resolveCreditPolicy, type CreditSummary } from '../../../src/lib/customerCredit'
import { evaluateCarrierBooking } from '../../../src/lib/carrierEligibility'
import { quickPayFee, quickPayTiersOf, tierFor } from '../../../src/lib/quickPay'
import type { Load as LoadForCredit } from '../../../src/types'
import type {
  ArStatus,
  CarrierDocumentRecord,
  CarrierRecord,
  ChargeCalc,
  ChargeCodeDef,
  ChargeSide,
  CheckCallChargeSnapshot,
  CheckCallSource,
  CheckCallType,
  CustomerRecord,
  DefaultCharge,
  IncidentType,
  LoadWorkflowStatus,
  OrderRecord,
  PricingDefaults,
  ShipmentMode,
  ShipmentRecord,
  ShipmentStatus,
  StopEventType,
  TmsSettings as TmsSettingsRecord,
} from '../../../src/types/tms'

const dynamo = new DynamoDBClient({})
const cognito = new CognitoIdentityProviderClient({})
// Step C: the rate confirmation's PDF lands on S3 and its email goes out through SES.
const s3 = new S3Client({})
const ses = new SESv2Client({})

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
// Step C tables. The carrier directory is written by tms-carrier-actions; this
// handler only reads it, and writes the booking counters back onto the row.
const CARRIER_TABLE_NAME = process.env.CARRIER_TABLE_NAME ?? ''
const CARRIER_DOCUMENT_TABLE_NAME = process.env.CARRIER_DOCUMENT_TABLE_NAME ?? ''
const BUCKET_NAME = process.env.BUCKET_NAME ?? ''
const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'ai4bcat@gmail.com'
const PORTAL_ORIGIN = process.env.PORTAL_ORIGIN ?? ''
// Step D tables. The tracking log is written here and by the projector, the public
// tracking Lambda and tms-tracking-actions; the link table is only read here, to
// revoke the carrier's ping link when the carrier comes off the load.
const LOAD_CHECK_CALL_TABLE_NAME = process.env.LOAD_CHECK_CALL_TABLE_NAME ?? ''
const TRACKING_LINK_TABLE_NAME = process.env.TRACKING_LINK_TABLE_NAME ?? ''
// Step E tables. The shipment's document index is written here and by the public
// upload portal; the two driver-app tables are read only, to point a shipment row
// at a POD whose bytes stay where the driver app put them.
const DRIVER_SUBMISSION_TABLE_NAME = process.env.DRIVER_SUBMISSION_TABLE_NAME ?? ''
const DRIVER_SUBMISSION_DOC_TABLE_NAME = process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME ?? ''
// Step H tables. Quotes and lane samples are written here — this Lambda already
// owns the pricing a quote is built on and the booking an offer turns into.
// CarrierContact and Division are read only, to address an offer request at a
// carrier's dispatch desk and to sign a quote with the division's name.
const QUOTE_TABLE_NAME = process.env.QUOTE_TABLE_NAME ?? ''
const LANE_RATE_SAMPLE_TABLE_NAME = process.env.LANE_RATE_SAMPLE_TABLE_NAME ?? ''
const CARRIER_CONTACT_TABLE_NAME = process.env.CARRIER_CONTACT_TABLE_NAME ?? ''
const DIVISION_TABLE_NAME = process.env.DIVISION_TABLE_NAME ?? ''
// An offer request is a ShipmentNotice, the way every other outbound e-mail with a
// shipment behind it is: the table is granted to this Lambda in `backend.ts` and
// the request is recorded on the load's notice log whether SES takes it or not.
const SHIPMENT_NOTICE_TABLE_NAME = process.env.SHIPMENT_NOTICE_TABLE_NAME ?? ''

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const SETTINGS_ID = 'default'

// Amplify derives GSI names from the plural model name and the key fields.
// The four the shipment bundle reads come from `_shared/shipmentStore`.
const IDX_LOADS_BY_CUSTOMER = 'loadsByCustomerId'
const IDX_ORDERS_BY_CUSTOMER = 'ordersByCustomerIdAndPickupAppt'
const IDX_CARRIERS_BY_LOAD = 'loadCarriersByLoadId'
const IDX_CARRIERS_BY_CARRIER_ID = 'loadCarriersByCarrierId'
const IDX_CARRIER_DOCS_BY_CARRIER = 'carrierDocumentsByCarrierIdAndType'
const IDX_CHECK_CALLS_BY_LOAD = 'loadCheckCallsByLoadIdAndAt'

/** DUPLICATE_SHIPMENT ceiling — one transaction per copy, and 20 is the plan's cap. */
const MAX_DUPLICATE_COPIES = 20

// ── Shared shipment store ────────────────────────────────────────────────────

/**
 * Reading a bundle and re-deriving a shipment's status live in
 * `_shared/shipmentStore`, so a worker Lambda derives a shipment exactly the way
 * this handler does. Bind them to this handler's client and tables once.
 */
const store = shipmentStoreFromEnv(dynamo)
const getById = (tableName: string, id: string) => storeGetById(dynamo, tableName, id)
const queryIndex = (tableName: string, indexName: string, keyName: string, keyValue: string) =>
  storeQueryIndex(dynamo, tableName, indexName, keyName, keyValue)
const batchGetByIds = (tableName: string, ids: string[]) => storeBatchGetByIds(dynamo, tableName, ids)
const transact = (items: TransactWriteItem[], label: string) => storeTransact(dynamo, items, label)
const readBundle = (shipmentId: string) => storeReadBundle(store, shipmentId)
const rederiveShipmentStatus = (shipmentId: string, caller: Caller) => storeRederiveShipmentStatus(store, shipmentId, caller)

// ── Document actions (step E) ────────────────────────────────────────────────

/**
 * The document rows, the required-document gate and the carrier rating live in
 * `documents.ts`. They are handed this handler's clients and audit writer rather
 * than building their own, so one Lambda holds one DynamoDB connection pool.
 */
const documentDeps: DocumentDeps = {
  store,
  s3,
  bucket: BUCKET_NAME,
  customerTable: CUSTOMER_TABLE_NAME,
  settingsTable: SETTINGS_TABLE_NAME,
  driverSubmissionTable: DRIVER_SUBMISSION_TABLE_NAME,
  driverSubmissionDocTable: DRIVER_SUBMISSION_DOC_TABLE_NAME,
  writeAudit,
}

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

const AR_STATUSES: readonly ArStatus[] = ['DOCS_NEEDED', 'UNBILLED', 'UNPAID', 'PAID', 'INVOICE_NOT_NEEDED', 'LEGACY']
/**
 * B never infers invoicing or payment; UNPAID/PAID are written by step F only,
 * and LEGACY is written by the Aljex backfill script, never by a person.
 */
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

// Step C. Why a carrier came off a load is a code, not a sentence — these are the
// two lists the bounce/TONU dialog offers, one per outcome.
const BOUNCE_REASONS = ['CARRIER_CANNOT_TAKE', 'GAVE_BACK', 'REJECTED_RATE_CON', 'OTHER'] as const
const TONU_REASONS = ['CUSTOMER_NOT_READY', 'CONSIGNEE_NOT_READY', 'FORGOT_TO_BOUNCE', 'OTHER'] as const
/** A bounce/TONU note is a sentence for the next dispatcher, not a narrative. */
const MAX_REMOVAL_NOTE = 250
const TRACKING_PROVIDERS = ['NONE', 'MANUAL', 'LINK', 'DRIVER_APP', 'MOTIVE'] as const
/** A rate con anybody could still sign; sending a new one or bouncing voids it. */
const OPEN_RATE_CON_STATUSES: readonly string[] = ['SENT', 'OPENED']
/** Nobody emails a ten-megabyte rate confirmation, and SES would refuse it anyway. */
const MAX_RATE_CON_BYTES = 10 * 1024 * 1024
/** How long a signing link lives when neither the caller nor settings say. */
const DEFAULT_RATE_CON_EXPIRY_HOURS = 48
/** Step D. Clock skew between a phone and this Lambda gets five minutes, no more. */
const CHECK_CALL_FUTURE_GRACE_MS = 5 * 60_000
/** A check call is a sentence about where the truck is, not a narrative. */
const MAX_CHECK_CALL_NOTE = 2000
/** The three sides an incident charge may be entered on. */
const INCIDENT_CHARGE_SIDES = ['CUSTOMER', 'CARRIER', 'BOTH'] as const
/**
 * Step G. What a recorded carrier bill does to the charge lines underneath it:
 * they are what AP promised to pay, so they stop moving until the bill is voided.
 */
const FINALIZED_CHARGES_MESSAGE =
  'That assignment\'s bill is recorded; void it first, then change what the carrier is owed'

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
  | 'BOOK_CARRIER'
  | 'SET_QUICK_PAY'
  | 'SEND_RATE_CON'
  | 'VOID_RATE_CON'
  | 'DISPATCH_LOAD'
  | 'REMOVE_LOAD_CARRIER'
  | 'RECALC_CHARGES'
  | 'UPDATE_CARRIER_CHARGES'
  | 'SET_AR_STATUS'
  | 'LOG_CHECK_CALL'
  | 'RESOLVE_INCIDENT'
  | 'SET_NEXT_CHECK_CALL'
  | 'SET_ETA'
  | 'GET_SHIPMENT_BUNDLE'
  | 'BACKFILL_SHIPMENT'
  | 'PREPARE_DOCUMENT_UPLOAD'
  | 'COMMIT_DOCUMENT'
  | 'SAVE_GENERATED_DOCUMENT'
  | 'ATTACH_DRIVER_DOC'
  | 'REVIEW_DOCUMENT'
  | 'UPDATE_DOCUMENT'
  | 'VOID_DOCUMENT'
  | 'READY_TO_INVOICE'
  | 'RATE_CARRIER'
  // Step H — the sell side of a quote, which is the quotes page's own work.
  | 'SAVE_QUOTE'
  | 'SEND_QUOTE'
  | 'COUNTER_QUOTE'
  | 'ACCEPT_COUNTER'
  | 'MARK_QUOTE_LOST'
  | 'RESTORE_QUOTE'
  | 'CANCEL_QUOTE'
  | 'PASS_QUOTE'
  | 'SWEEP_EXPIRED_QUOTES'
  | 'DUPLICATE_QUOTE'
  | 'CONVERT_QUOTE'
  | 'REVERT_TO_QUOTE'
  | 'SAVE_QUOTE_SETTINGS'
  // Step H — the buy side, which is dispatch's work as much as the quote desk's.
  | 'REQUEST_OFFERS'
  | 'LOG_OFFER'
  | 'COUNTER_OFFER'
  | 'REJECT_OFFER'
  | 'ACCEPT_OFFER'

/**
 * Step H. Quoting is its own desk: a rep who prices freight all day has no business
 * moving a load's status or re-pricing a shipment that already exists, and a
 * dispatcher covering loads has no business sending a customer a price. So the sell
 * side is `page-quotes` and the loads page alone cannot reach it — the same shape
 * finance uses for its AP actions (`tms-finance-actions/handler.ts:102-172`).
 */
const QUOTE_ACTIONS: Record<string, true> = {
  SAVE_QUOTE: true,
  SEND_QUOTE: true,
  COUNTER_QUOTE: true,
  ACCEPT_COUNTER: true,
  MARK_QUOTE_LOST: true,
  RESTORE_QUOTE: true,
  CANCEL_QUOTE: true,
  PASS_QUOTE: true,
  SWEEP_EXPIRED_QUOTES: true,
  DUPLICATE_QUOTE: true,
  CONVERT_QUOTE: true,
  REVERT_TO_QUOTE: true,
  SAVE_QUOTE_SETTINGS: true,
}

/**
 * Finding a truck is both desks' work — the quote desk shops a lane while it is
 * still quoting it, dispatch shops the leg it has to cover — so either page key
 * opens the buy side. `ACCEPT_OFFER` is the exception that proves it: booking is
 * BOOK_CARRIER, and it requires exactly what BOOK_CARRIER requires.
 */
const OFFER_ACTIONS: Record<string, true> = {
  REQUEST_OFFERS: true,
  LOG_OFFER: true,
  COUNTER_OFFER: true,
  REJECT_OFFER: true,
}

/** Org defaults are an admin act in every router here. */
const QUOTE_ADMIN_ONLY_ACTIONS: Record<string, true> = { SAVE_QUOTE_SETTINGS: true }

const QUOTES_PAGE_GROUP = 'page-quotes'
const LOADS_PAGE_GROUP = 'page-loads'

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
  // Step H. The sell side belongs to the quote desk and nobody else; the buy side
  // belongs to either desk. Both are decided before the loads-page rule below, so
  // `page-quotes` alone still cannot touch a load's status or its charges.
  if (QUOTE_ACTIONS[action]) {
    if (!isAdmin && !groups.includes(QUOTES_PAGE_GROUP)) {
      throw new Error(`Forbidden: ${action} requires owner, ADMIN, or ${QUOTES_PAGE_GROUP}`)
    }
    if (QUOTE_ADMIN_ONLY_ACTIONS[action] && !isAdmin) {
      throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
    }
    return { email, sub: identity.sub, groups, isAdmin }
  }
  if (OFFER_ACTIONS[action]) {
    if (!isAdmin && !groups.includes(LOADS_PAGE_GROUP) && !groups.includes(QUOTES_PAGE_GROUP)) {
      throw new Error(`Forbidden: ${action} requires owner, ADMIN, ${LOADS_PAGE_GROUP}, or ${QUOTES_PAGE_GROUP}`)
    }
    return { email, sub: identity.sub, groups, isAdmin }
  }
  // Building and moving freight is the loads page's job; everything here belongs to
  // it. Step G's one exception: what a carrier is owed is edited from the AP desk
  // as often as from dispatch, so `page-carrierPay` may do that and nothing else.
  const carrierPay = action === 'UPDATE_CARRIER_CHARGES' && groups.includes('page-carrierPay')
  if (!isAdmin && !groups.includes(LOADS_PAGE_GROUP) && !carrierPay) {
    throw new Error(
      action === 'UPDATE_CARRIER_CHARGES'
        ? `Forbidden: ${action} requires owner, ADMIN, page-loads, or page-carrierPay`
        : `Forbidden: ${action} requires owner, ADMIN, or page-loads`,
    )
  }
  return { email, sub: identity.sub, groups, isAdmin }
}

// ── DynamoDB helpers ─────────────────────────────────────────────────────────

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

function resequence(stops: StopShape[]): StopShape[] {
  return stops.map((s, i) => ({ ...s, sequence: i }))
}

/** The stop clock, as the status ladder reads it: type, order and the two stamps. */
function stopTimesOf(stops: StopShape[]): { type: 'pickup' | 'delivery'; sequence: number; arrivedAt: string | null; departedAt: string | null }[] {
  return stops.map((s) => ({
    type: s.type === 'delivery' ? ('delivery' as const) : ('pickup' as const),
    sequence: s.sequence ?? 0,
    arrivedAt: s.arrivedAt ?? null,
    departedAt: s.departedAt ?? null,
  }))
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

// ── Credit ───────────────────────────────────────────────────────────────────

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
  /** The row this line already is, when it is being rewritten rather than minted. */
  existing: Row | null = null,
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
    // Who first put this money on the load, which an edit does not change. These
    // come off our own row, not off the request, so they are read and not validated.
    createdBy: typeof existing?.createdBy === 'string' ? existing.createdBy : caller.email,
    createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : now,
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

/**
 * Step F: once an order is invoiced its money lives on the Invoice row, which
 * this router cannot touch. Canceling or deleting the shipment under it would
 * strand an open receivable, so both refuse and name the bill to void first.
 *
 * Step G: the same is true of the other side. An assignment carrying `invoiceId`
 * has a CarrierBill that is not voided — VOID_BILL is what clears the field — and
 * canceling the shipment under it would strand a payable.
 */
async function assertNoInvoicedOrders(shipmentId: string, verb: string): Promise<void> {
  const orders = await queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const invoiced = orders.find((order) => order.arStatus === 'UNPAID' || order.arStatus === 'PAID')
  if (invoiced) {
    const label = optionalString(invoiced.invoiceNumber, 100) ?? optionalString(invoiced.invoiceId, 100) ?? 'an invoice'
    throw new Error(`This shipment has invoice ${label}; void the invoice first, then ${verb} the shipment`)
  }
  const assignments = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const billed = assignments.find((assignment) => assignment.invoiceId)
  if (billed) {
    const label = optionalString(billed.carrierName, 200) ?? 'a carrier'
    throw new Error(`${label} has a carrier bill on this shipment; void the bill first, then ${verb} the shipment`)
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
    await assertNoInvoicedOrders(shipmentId, 'cancel')
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
  const bundle = await readBundle(shipmentId)
  // Step H. A shipment canceled after it delivered does not un-deliver: the lane
  // keeps the sample it recorded and the statistics stop counting it.
  if (patch.status === 'CANCELED') {
    for (const load of bundle.loads) await excludeLaneSample(quoteDeps, String(load.id))
  }
  return bundle as unknown as Row
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
  // Step H. Delivered and priced is a lane rate sample; `writeLaneSample` is the
  // judge of the second half and of everything else that makes a sample a sample.
  if (isDeliveredOrLater(requested)) await writeLaneSample(quoteDeps, loadId)
  return rederiveShipmentStatus(shipmentId, caller)
}

// ── DELETE / RESTORE ─────────────────────────────────────────────────────────

const DELETABLE_STATUSES: readonly string[] = ['DRAFT', 'CANCELED', 'TENDER_REJECTED']

/**
 * The carrier legs of one shipment that are sitting on the AP board.
 *
 * `apOpen` is the sparse marker behind "every outside carrier we still owe money on".
 * A deleted shipment is one nobody can open, so a leg of it is work no one can do —
 * it comes off the board with the shipment and goes back on if the shipment is restored.
 * A leg that is paid, bounced or own-fleet never carried the marker in the first place.
 */
async function apBoardLegsOf(shipmentId: string): Promise<Row[]> {
  const assignments = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  return assignments.filter((row) => row.kind === 'CARRIER')
}

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
  await assertNoInvoicedOrders(shipmentId, 'delete')
  const apBoardLegsClosed = await applySoftDelete(shipment, caller, expectedUpdatedAt)
  await writeAudit('SHIPMENT', shipmentId, 'DELETE_SHIPMENT', caller, { status, apBoardLegsClosed })
  return readBundle(shipmentId) as unknown as Row
}

/**
 * The soft-delete itself: the shipment's marker, and the AP board markers that come
 * off with it.
 *
 * The marker, and only the marker: the leg keeps its charges, its rung and its
 * timestamps, so a restore is a re-SET rather than a reconstruction, and `updatedAt`
 * does not move under a client holding the assignment's CAS token.
 */
async function applySoftDelete(shipment: Row, caller: Caller, expectedUpdatedAt: string | null): Promise<string[]> {
  const shipmentId = String(shipment.id)
  const now = nowIso()
  const openLegs = (await apBoardLegsOf(shipmentId)).filter((row) => row.apOpen)
  await transact(
    [
      updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
        deletedAt: now,
        deletedBy: caller.email,
        updatedBy: caller.email,
        updatedAt: now,
        version: (numberOrNull(shipment.version) ?? 1) + 1,
      }, expectedUpdatedAt),
      ...openLegs.map((row) => updateItemTx(LOAD_CARRIER_TABLE_NAME, String(row.id), {}, null, { remove: ['apOpen'] })),
    ],
    'shipment',
  )
  return openLegs.map((row) => String(row.id))
}

/**
 * Step H. The same write without DELETE_SHIPMENT's gates: a convert that failed
 * half way is taking back a shipment it just made, and a revert has already proved
 * the shipment is unbilled, uncovered and single-order. Neither is a person
 * deleting somebody's freight, so neither asks `cancelDeleteAdminOnly`.
 */
async function softDeleteShipment(shipmentId: string, caller: Caller): Promise<void> {
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment || shipment.deletedAt) return
  const apBoardLegsClosed = await applySoftDelete(shipment, caller, null)
  await writeAudit('SHIPMENT', shipmentId, 'DELETE_SHIPMENT', caller, {
    status: String(shipment.status ?? ''),
    apBoardLegsClosed,
    viaQuote: true,
  })
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
  // Back on the board under the same rule the rest of AP uses: an outside carrier we
  // are still on the hook for. A leg paid or bounced while the shipment was away stays
  // off, and one with no `apStatusChangedAt` was never in the sparse index to begin with.
  const reopen = (await apBoardLegsOf(shipmentId)).filter((row) =>
    !row.apOpen
    && (row.status === 'ACTIVE' || row.status === 'TONU')
    && row.apStatus !== 'PAID'
    && typeof row.apStatusChangedAt === 'string'
    && row.apStatusChangedAt !== '')
  await transact(
    [
      updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
        deletedAt: null,
        deletedBy: null,
        updatedBy: caller.email,
        updatedAt: now,
        version: (numberOrNull(shipment.version) ?? 1) + 1,
      }, expectedUpdatedAt),
      ...reopen.map((row) => updateItemTx(LOAD_CARRIER_TABLE_NAME, String(row.id), { apOpen: 'OPEN' }, null)),
    ],
    'shipment',
  )
  await writeAudit('SHIPMENT', shipmentId, 'RESTORE_SHIPMENT', caller, {
    apBoardLegsReopened: reopen.map((row) => String(row.id)),
  })
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
        // Step G. The copy owes its own money: nothing of the source's bill comes
        // across, and an own-fleet leg gets no AP rung at all — it is settled through
        // driver pay. `apOpen` is a sparse index hash key, so it is left off the row
        // entirely (`marshallRow` drops the undefined) rather than stored as a NULL
        // the index refuses.
        apStatus: sourceCarrier.kind === 'CARRIER' ? 'AWAITING_INVOICE' : undefined,
        apOpen: sourceCarrier.kind === 'CARRIER' ? 'OPEN' : undefined,
        apStatusChangedAt: sourceCarrier.kind === 'CARRIER' ? now : undefined,
        apBalanceCents: null,
        apPaidAt: null,
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

  // Step D: the stamps this call sets for the first time. Each one is a stop event
  // the tracking log has to carry, exactly as the driver app's would be.
  const newStamps: { stopId: string; event: StopEventType; at: string }[] = []

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
      const before = stops[i]
      if (arrivedAt && !String(before.arrivedAt ?? '').trim()) {
        newStamps.push({ stopId: String(before.id), event: 'ARRIVED', at: arrivedAt })
      }
      if (departedAt && !String(before.departedAt ?? '').trim()) {
        newStamps.push({ stopId: String(before.id), event: 'DEPARTED', at: departedAt })
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
    ? loadStatusFromStopTimes(stopTimesOf(stops), currentStatus)
    : currentStatus

  // The tracking log is written before the load moves, so a reader who sees the new
  // status can already see what proved it. The `evt:` id is derived from the stop,
  // so a stamp the driver app's projector already reported is a no-op here.
  for (const stamp of newStamps) {
    if (!shipmentId) break
    await putCheckCallIfAbsent(checkCallRow({
      id: stopEventId(loadId, stamp.stopId, stamp.event),
      loadId,
      shipmentId,
      loadCarrierId: optionalString(load.activeLoadCarrierId, 100),
      stopId: stamp.stopId,
      at: stamp.at,
      type: stamp.event,
      source: 'MANUAL',
      statusBefore: currentStatus,
      statusAfter: derivedStatus && derivedStatus !== currentStatus ? derivedStatus : null,
    }, caller))
  }

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
function retireCarrier(
  existing: Row,
  reason: string,
  outcome: 'BOUNCED' | 'TONU',
  caller: Caller,
  extra: Row = {},
): TransactWriteItem {
  const now = nowIso()
  return updateItemTx(LOAD_CARRIER_TABLE_NAME, String(existing.id), {
    status: outcome,
    removalReason: reason,
    removedAt: now,
    removedBy: caller.email,
    // Whatever else leaves with the assignment — the dispatcher's note, a rate con
    // nobody may sign any more — rides the same update, because DynamoDB refuses two
    // writes to one item inside one transaction.
    ...extra,
    updatedBy: caller.email,
    updatedAt: now,
  }, null, {
    // Step G. A bounced carrier hauled nothing and is owed nothing, so the row
    // leaves AP's worklist with its charges. A TONU'd one showed up and is still
    // owed, so it stays. `apOpen` is a sparse index hash key: it has to leave the
    // row rather than be set to null, which DynamoDB refuses outright.
    remove: outcome === 'BOUNCED' ? ['apOpen'] : [],
  })
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
    // No apStatus: an own-fleet leg is paid through a driver settlement and never
    // enters AP at all.
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
  // Step H. A covered load never shows a live request.
  await cancelOpenOffers(quoteDeps, loadId, caller)
  return rederiveShipmentStatus(shipmentId, caller)
}

async function assignCarrier(input: Row, caller: Caller): Promise<Row> {
  // A carrier out of the directory goes through the booking gate, which checks its
  // authority, insurance and documents before it is allowed to hold freight.
  if (input.carrierId != null) {
    throw new Error('Use BOOK_CARRIER for a directory carrier')
  }
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
    // No `carrierId`: this path is refused above when one is given, and a NULL on
    // the `loadCarriersByCarrierId` hash key is an item DynamoDB will not take.
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
    // Step G. The AP worklist is an index on `apOpen`; a carrier we owe money to
    // is on it from the moment they are booked.
    apOpen: 'OPEN',
    apStatusChangedAt: now,
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
  // Step H. A covered load never shows a live request.
  await cancelOpenOffers(quoteDeps, loadId, caller)
  return rederiveShipmentStatus(shipmentId, caller)
}

async function removeLoadCarrier(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const outcome = assertEnum(input.outcome, ['BOUNCED', 'TONU'] as const, 'outcome')
  // Why a carrier came off a load is the whole record; it is never optional, and it
  // is one of the codes that fits the outcome rather than whatever was typed.
  const reason = assertEnum(input.reason, outcome === 'BOUNCED' ? BOUNCE_REASONS : TONU_REASONS, 'reason')
  const note = optionalString(input.note, MAX_REMOVAL_NOTE)

  const carrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!carrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (carrier.status !== 'ACTIVE') throw new Error('That assignment has already been removed')
  // Step G. A bounce deletes the carrier's charge lines, which is the money a
  // recorded bill was written against. The bill has to be voided first; a TONU is
  // fine, because the assignment keeps its money and is still owed.
  if (outcome === 'BOUNCED' && carrier.invoiceId) {
    throw new Error('That assignment has a carrier bill; void the bill first, then bounce the carrier')
  }
  const loadId = String(carrier.loadId)
  const shipmentId = String(carrier.shipmentId)
  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)

  // A rate con the carrier could still open is dead the moment they come off.
  const voidsRateCon = OPEN_RATE_CON_STATUSES.includes(String(carrier.rateConStatus ?? ''))
  // So is the tracking link their driver was texted: we no longer track this truck,
  // and a live token on a carrier we dropped is a public page nobody is watching.
  const removedAt = nowIso()
  const trackingLink = await activeCarrierPingLink(carrier)
  const stopsTracking = trackingLink != null || carrier.trackingStartedAt != null
  await transact(
    [
      retireCarrier(carrier, reason, outcome, caller, {
        removalNote: note,
        ...(voidsRateCon ? { rateConStatus: 'VOIDED', rateConToken: null } : {}),
        ...(stopsTracking ? { trackingLinkId: null, trackingStoppedAt: removedAt } : {}),
      }),
      ...(trackingLink
        ? [updateItemTx(TRACKING_LINK_TABLE_NAME, String(trackingLink.id), {
            status: 'REVOKED',
            revokedAt: removedAt,
            revokedBy: caller.email,
            updatedBy: caller.email,
            updatedAt: removedAt,
          }, null)]
        : []),
    ],
    'assignment',
  )

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
  // The reminder belonged to the carrier that just came off. Leaving it armed
  // keeps the worklist, the nav badge and the notifier nagging the rep to call a
  // truck that is no longer on the load. Clearing goes through the REMOVE path
  // because `checkCallOpen` is a sparse GSI hash key that refuses a stored NULL.
  if (load.checkCallOpen != null || load.nextCheckCallAt != null) {
    await writeCheckCallSchedule({ loadId, nextCheckCallAt: null, note: null, caller, expectedUpdatedAt: null })
  }

  await writeAudit('LOAD_CARRIER', loadCarrierId, `REMOVE_LOAD_CARRIER:${outcome}`, caller, {
    loadId, reason, note, voidedRateCon: voidsRateCon, revokedTrackingLink: trackingLink != null,
  })
  // Step H. A TONU after the freight delivered does not un-deliver it: the lane
  // keeps the sample it recorded and the statistics stop counting it. `load` was
  // read before the removal, so this is the rung the load was actually at.
  if (outcome === 'TONU' && isDeliveredOrLater(load.status)) await excludeLaneSample(quoteDeps, loadId)
  return rederiveShipmentStatus(shipmentId, caller)
}

// ── Carrier booking (step C) ─────────────────────────────────────────────────

/** A recipient line in an email header; a comma or a newline in one is an attack. */
function assertEmail(value: unknown, label: string): string {
  const v = assertString(value, label)
  if (v.length > 200 || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(v)) {
    throw new Error(`${label} must be an email address`)
  }
  return v
}

/** What is on the truck, as the order described it — the gate's DESCRIPTION field. */
function freightDescriptionOf(order: Row | null): string | null {
  const freight = Array.isArray(order?.freight) ? (order?.freight as Row[]) : []
  const described = freight
    .map((f) => (typeof f?.description === 'string' ? f.description.trim() : ''))
    .filter(Boolean)
  return described.length > 0 ? described.join('; ') : null
}

/**
 * The quick-pay cache carried on a LoadCarrier row. `days` of null clears it; any
 * other number has to be one of the configured tiers exactly, because a fee nobody
 * agreed to is a fee we cannot deduct.
 */
function quickPayPatch(days: number | null, rateCents: number, settings: Row | null): Row {
  if (days == null) {
    return { quickPay: false, quickPayDays: null, quickPayFeeBps: null, quickPayFeeCents: null }
  }
  const tier = tierFor(days, quickPayTiersOf(settings as unknown as TmsSettingsRecord | null))
  if (!tier) throw new Error(`${days} days is not one of the quick-pay tiers`)
  return {
    quickPay: true,
    quickPayDays: tier.days,
    quickPayFeeBps: tier.feeBps,
    quickPayFeeCents: quickPayFee(rateCents, tier.feeBps),
  }
}

/**
 * What one carrier alone is owed: their own CARRIER-side charge lines. The load's
 * cached totals are the whole load's and, after a TONU and a rebook, still carry
 * the retired carrier's retained line — never the basis for this carrier's pay.
 */
function carrierOwnCostCents(charges: Row[], loadCarrierId: string): number {
  return charges
    .filter((c) => c.side === 'CARRIER' && String(c.loadCarrierId ?? '') === loadCarrierId)
    .reduce((sum, c) => sum + (numberOrNull(c.amountCents) ?? 0), 0)
}

/**
 * Book a directory carrier onto a load.
 *
 * Everything that could stop the booking is decided by `evaluateCarrierBooking`,
 * the same library the dialog previewed with: blocks refuse, warnings have to be
 * acknowledged by key, and the keys that were acknowledged are kept on the row so
 * the next person can see what was waved through and by whom.
 */
async function bookCarrier(input: Row, caller: Caller, extra?: BookCarrierExtra): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const carrierId = assertString(input.carrierId, 'carrierId')
  // Read without a floor: a negative buy is NEGATIVE_CARRIER_CHARGE, refused by the
  // gate with every other reason rather than on its own.
  const carrierRateCents = optionalInteger(input.carrierRateCents, { label: 'carrierRateCents' })
  if (carrierRateCents == null) throw new Error('carrierRateCents is required')
  const acknowledged = input.acknowledgeWarnings == null
    ? []
    : assertArrayOf(input.acknowledgeWarnings, 'acknowledgeWarnings', (v, i) =>
        assertString(v, `acknowledgeWarnings[${i}]`))
  const contactId = optionalString(input.contactId, 100)

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')
  if (String(load.updatedAt ?? '') !== expectedUpdatedAt) throw conflictError('load', null)
  if (String(load.status ?? '') !== 'SOURCING') {
    throw new Error('Only a load that is still sourcing can be booked')
  }

  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  if (shipment.deletedAt) throw new Error('That shipment is deleted')
  const mode = optionalEnum(shipment.mode, SHIPMENT_MODES, 'mode')
  if (!isTruckloadMode(mode)) throw new Error('Only a truckload shipment books an outside carrier')
  if (bundle.loadCarriers.some((c) => c.loadId === loadId && c.status === 'ACTIVE')) {
    throw new Error('That load already has an active assignment')
  }
  const order = bundle.orders.find((o) => o.id === load.orderId) ?? bundle.orders[0] ?? null
  const orderId = optionalString(load.orderId, 100) ?? optionalString(order?.id, 100) ?? ''
  const existingFinancials = bundle.financials.find((f) => f.id === loadId) ?? null
  if (existingFinancials?.frozenAt) {
    throw new Error('This load\'s financials are frozen and can no longer be changed')
  }

  const [carrier, documents, settings] = await Promise.all([
    getById(CARRIER_TABLE_NAME, carrierId),
    queryIndex(CARRIER_DOCUMENT_TABLE_NAME, IDX_CARRIER_DOCS_BY_CARRIER, 'carrierId', carrierId),
    getSettings(),
  ])
  if (!carrier) throw new Error(`Carrier not found: ${carrierId}`)
  const carrierName = optionalString(carrier.name, 200)

  // Everything else this carrier is already holding, with the day it loads: a truck
  // promised to two shippers at the same hour is the oldest way to lose freight.
  const otherRows = (await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_CARRIER_ID, 'carrierId', carrierId))
    .filter((c) => c.status === 'ACTIVE' && String(c.loadId) !== loadId)
  const otherLoads = await batchGetByIds(LOAD_TABLE_NAME, otherRows.map((c) => String(c.loadId)))
  const pickupByLoad = new Map(otherLoads.map((l) => [String(l.id), optionalString(l.pickupAppt, 60)]))

  const { blocks, warnings } = evaluateCarrierBooking({
    carrier: carrier as unknown as CarrierRecord,
    documents: documents as unknown as CarrierDocumentRecord[],
    load: {
      id: loadId,
      pickupAppt: optionalString(load.pickupAppt, 60),
      commodity: optionalString(load.commodity, 200),
      weight: numberOrNull(load.weight),
      cargoValueCents: numberOrNull(load.cargoValueCents),
      freightDescription: freightDescriptionOf(order),
      activeLoadCarrierId: optionalString(load.activeLoadCarrierId, 100),
      assignmentType: optionalString(load.assignmentType, 40),
    },
    financials: existingFinancials ? { topSpendCents: numberOrNull(existingFinancials.topSpendCents) } : null,
    carrierRateCents,
    otherActiveLoadCarriers: otherRows.map((c) => ({
      loadId: String(c.loadId),
      pickupAppt: pickupByLoad.get(String(c.loadId)) ?? null,
    })),
    settings: settings as unknown as TmsSettingsRecord | null,
    now: nowIso(),
    isAdmin: caller.isAdmin,
  })

  if (blocks.length > 0) {
    throw new Error(`${carrierName ?? 'That carrier'} cannot be booked: ${blocks.map((b) => b.detail).join(' ')}`)
  }
  const acknowledgedKeys = new Set(acknowledged)
  const unacknowledged = warnings.filter((w) => !acknowledgedKeys.has(w.key))
  if (unacknowledged.length > 0) {
    throw new Error(`Acknowledge these before booking: ${unacknowledged.map((w) => w.detail).join(' ')}`)
  }
  // Defence in depth: an admin-only finding is already a block for everybody else,
  // so a non-admin arriving here having ticked one is not to be taken at their word.
  if (!caller.isAdmin) {
    const adminOnly = warnings.filter((w) => w.adminOnly && acknowledgedKeys.has(w.key))
    if (adminOnly.length > 0) {
      throw new Error(`Only an admin can book past: ${adminOnly.map((w) => w.detail).join(' ')}`)
    }
  }

  const customer = await getById(CUSTOMER_TABLE_NAME, String(shipment.customerId))
  const rules = chargeCodeRules(settings, customer)
  const newCarrierId = `lcr-${randomUUID()}`
  const linehaul: ChargeInput = {
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
  }
  const added: ChargeInput[] = [
    linehaul,
    ...(input.charges == null
      ? []
      : assertArrayOf(input.charges, 'charges', (item, i) => validateChargeInput(item, i, rules))
    ).map((c) => ({
      ...c,
      loadId: c.loadId ?? loadId,
      loadCarrierId: c.side === 'CARRIER' ? c.loadCarrierId ?? newCarrierId : null,
    })),
  ]
  // The load's existing lines are priced again with the new ones so the cached
  // totals are the whole load's, not just the carrier's slice of it.
  const kept = bundle.charges.filter((c) =>
    c.loadId ? String(c.loadId) === loadId : String(c.orderId ?? '') === orderId)
  const { amounts, totals } = priceFor(
    [...kept.map(chargeRowToInput), ...added],
    { miles: numberOrNull(load.miles), weightLbs: numberOrNull(load.weight) },
    pricingDefaultsOf(customer),
    marginFloorBpsOf(settings),
  )
  const addedRows = added.map((c, i) =>
    chargeRow(c, amounts[kept.length + i], { shipmentId, orderId, loadId }, caller))
  // Money on a LoadCarrier is that carrier's own — the rate agreed with them and
  // the charge lines booked against their row. Money on LoadFinancials is the
  // whole load's, which after a TONU still carries the retired carrier's line.
  // Mixing the two pays a new carrier a previous carrier's money on the rate con.
  const carrierCostCents = carrierOwnCostCents(addedRows, newCarrierId)

  const now = nowIso()
  const sequence = bundle.loadCarriers
    .filter((c) => c.loadId === loadId)
    .reduce((max, c) => Math.max(max, numberOrNull(c.sequence) ?? 0), 0) + 1
  const equipmentType = optionalString(input.equipmentType, 80) ?? optionalString(load.equipmentType, 80)
  const trackingProvider = optionalEnum(input.trackingProvider, TRACKING_PROVIDERS, 'trackingProvider') ?? 'MANUAL'
  const paymentTermsDays =
    optionalInteger(input.paymentTermsDays, { min: 0, max: 365, label: 'paymentTermsDays' }) ??
    numberOrNull(carrier.paymentTermsDays) ??
    numberOrNull(settings?.defaultCarrierTermsDays)
  const quickPay = quickPayPatch(
    optionalInteger(input.quickPayDays, { min: 1, max: 365, label: 'quickPayDays' }),
    carrierRateCents,
    settings,
  )

  const loadCarrier: Row = {
    id: newCarrierId,
    __typename: 'LoadCarrier',
    loadId,
    shipmentId,
    kind: 'CARRIER',
    status: 'ACTIVE',
    sequence,
    // A snapshot of who was booked: the directory may be edited afterwards, but
    // this is the carrier the rate confirmation names.
    carrierId,
    carrierName,
    carrierMc: optionalString(carrier.mcNumber, 40),
    carrierRepId: optionalString(input.carrierRepId, 100) ?? optionalString(load.carrierRepId, 100),
    dispatcherName: optionalString(input.dispatcherName, 120) ?? optionalString(carrier.dispatcherName, 120),
    dispatcherPhone: optionalString(input.dispatcherPhone, 40) ?? optionalString(carrier.dispatcherPhone, 40),
    dispatcherEmail: optionalString(input.dispatcherEmail, 200) ?? optionalString(carrier.dispatcherEmail, 200),
    driverName: optionalString(input.driverName, 120),
    driverPhone: optionalString(input.driverPhone, 40),
    driver2Name: optionalString(input.driver2Name, 120),
    driver2Phone: optionalString(input.driver2Phone, 40),
    truckNumber: optionalString(input.truckNumber, 40),
    trailerNumber: optionalString(input.trailerNumber, 40),
    plates: optionalString(input.plates, 40),
    vin: optionalString(input.vin, 40),
    paymentTermsDays,
    ...quickPay,
    rateConStatus: 'NOT_SENT',
    rateConVersion: 0,
    bookedAt: now,
    bookingWarnings: warnings.map((w) => w.key),
    carrierRateCents,
    costCents: carrierCostCents,
    apStatus: 'AWAITING_INVOICE',
    // Step G. The AP worklist is an index on `apOpen`; a carrier we owe money to
    // is on it from the moment they are booked.
    apOpen: 'OPEN',
    apStatusChangedAt: now,
    // Step H. An offer that won the load names itself on the assignment it bought.
    ...(extra?.loadCarrierFields ?? {}),
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }

  await transact(
    [
      // The Load itself is written through AppSync a moment later, under the same
      // CAS. Guarding it here too means a load that moved since we read it leaves
      // no ACTIVE assignment, no charges and no bumped loadCount behind.
      conditionCheckUpdatedAtTx(LOAD_TABLE_NAME, loadId, expectedUpdatedAt),
      putItem(LOAD_CARRIER_TABLE_NAME, loadCarrier),
      ...addedRows.map((row) => putItem(LOAD_CHARGE_TABLE_NAME, row)),
      putItem(
        LOAD_FINANCIALS_TABLE_NAME,
        financialsRow(
          loadId,
          shipmentId,
          orderId || null,
          totals,
          (numberOrNull(existingFinancials?.version) ?? 0) + 1,
          caller,
          existingFinancials,
        ),
        false,
      ),
      // How much freight a carrier has hauled for us, kept on their own row so the
      // directory can sort by it without reading every load.
      updateItemTx(CARRIER_TABLE_NAME, carrierId, {
        loadCount: (numberOrNull(carrier.loadCount) ?? 0) + 1,
        lastLoadAt: now,
        updatedBy: caller.email,
        updatedAt: now,
      }, null),
      // Step H. ACCEPT_OFFER stamps its offer WON and closes the round's losers
      // here, so the quote thread and the assignment land together or not at all.
      ...(extra?.writes ?? []),
    ],
    'booking',
  )

  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update(
      {
        id: loadId,
        assignmentType: 'CARRIER',
        activeLoadCarrierId: newCarrierId,
        carrierName,
        equipmentType,
        trackingProvider,
        status: 'BOOKED',
        statusChangedAt: now,
        statusChangedBy: caller.email,
        statusSource: 'USER',
        updatedBy: caller.email,
      },
      { condition: { updatedAt: { eq: expectedUpdatedAt } } },
    ),
    'Load update',
  )

  await writeAudit('LOAD_CARRIER', newCarrierId, 'BOOK_CARRIER', caller, {
    loadId,
    carrierId,
    carrierRateCents,
    contactId,
    blocks: [],
    warnings: warnings.map((w) => w.key),
    acknowledged,
  })
  // Step H. A covered load never shows a live request. ACCEPT_OFFER's own winner
  // is already WON by the transaction above, so this only closes the rest.
  await cancelOpenOffers(quoteDeps, loadId, caller)
  return rederiveShipmentStatus(shipmentId, caller)
}

// ── SET_QUICK_PAY ────────────────────────────────────────────────────────────

/**
 * Quick pay is a deduction from what we owe the carrier, cached here so AP never
 * has to re-derive it. It is not a charge line: the rate confirmation prints it as
 * an informational net-payable, and the money moves in step G.
 */
async function setQuickPay(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const quickPayDays = optionalInteger(input.quickPayDays, { min: 1, max: 365, label: 'quickPayDays' })

  const carrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!carrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  const status = String(carrier.status ?? '')
  if (status !== 'ACTIVE' && status !== 'TONU') {
    throw new Error('Quick pay belongs to an assignment that is still owed money')
  }
  if (carrier.chargesFinalizedAt) {
    throw new Error('This assignment\'s charges are finalized and can no longer be changed')
  }
  const loadId = String(carrier.loadId)
  const shipmentId = String(carrier.shipmentId)
  const financials = await getById(LOAD_FINANCIALS_TABLE_NAME, loadId)
  if (financials?.frozenAt) {
    throw new Error('This load\'s financials are frozen and can no longer be changed')
  }

  const settings = quickPayDays == null ? null : await getSettings()
  // The fee is a deduction from what THIS carrier is owed. Their own lines are the
  // basis; the row's cached rate is the fallback for an assignment that has none.
  const ownCharges = quickPayDays == null
    ? []
    : await queryIndex(LOAD_CHARGE_TABLE_NAME, IDX_CHARGES_BY_SHIPMENT, 'shipmentId', shipmentId)
  const ownCostCents = carrierOwnCostCents(ownCharges, loadCarrierId)
  const basisCents = ownCostCents > 0 ? ownCostCents : numberOrNull(carrier.carrierRateCents) ?? 0
  const patch = quickPayPatch(quickPayDays, basisCents, settings)
  const now = nowIso()
  await transact(
    [updateItemTx(LOAD_CARRIER_TABLE_NAME, loadCarrierId, {
      ...patch,
      updatedBy: caller.email,
      updatedAt: now,
    }, null)],
    'quick pay',
  )

  await writeAudit('LOAD_CARRIER', loadCarrierId, 'SET_QUICK_PAY', caller, { loadId, ...patch })
  return readBundle(shipmentId) as unknown as Row
}

// ── Rate confirmation ────────────────────────────────────────────────────────

/** Split a base64 blob into 76-char MIME lines (RFC 2045). */
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n')
}

/**
 * The rate confirmation, as the carrier receives it: the PDF attached, and the
 * signing link they open to agree to it. Built as raw MIME because SES's simple
 * content has nowhere to put an attachment.
 */
async function sendRateConEmail(args: {
  to: string[]
  cc: string[]
  subject: string
  body: string
  filename: string
  pdfBase64: string
}): Promise<void> {
  const boundary = `=_bcatratecon_${Date.now().toString(36)}`
  const raw =
    `From: ${FROM_ADDRESS}\r\n` +
    `To: ${args.to.join(', ')}\r\n` +
    (args.cc.length > 0 ? `Cc: ${args.cc.join(', ')}\r\n` : '') +
    `Subject: ${args.subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n` +
    `\r\n` +
    `${args.body}\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/pdf; name="${args.filename}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="${args.filename}"\r\n` +
    `\r\n` +
    `${wrap76(args.pdfBase64)}\r\n` +
    `--${boundary}--\r\n`

  await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM_ADDRESS,
    Destination: { ToAddresses: args.to, CcAddresses: args.cc.length > 0 ? args.cc : undefined },
    Content: { Raw: { Data: new TextEncoder().encode(raw) } },
  }))
}

/**
 * Send the rate confirmation the browser built.
 *
 * Each send is a new version: a fresh PDF on S3, a fresh CarrierDocument row, and a
 * fresh token — which is exactly what voids the previous link, since the token is
 * the only way into the signing page.
 */
async function sendRateCon(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const pdfBase64 = assertString(input.pdfBase64, 'pdfBase64')
  const to = assertArrayOf(input.to, 'to', (v, i) => assertEmail(v, `to[${i}]`), 20)
  if (to.length === 0) throw new Error('A rate confirmation needs at least one recipient')
  const cc = input.cc == null ? [] : assertArrayOf(input.cc, 'cc', (v, i) => assertEmail(v, `cc[${i}]`), 20)
  const expiresHours = optionalInteger(input.expiresHours, { min: 1, max: 720, label: 'expiresHours' })

  const carrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!carrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (carrier.status !== 'ACTIVE') {
    throw new Error('Only the carrier currently on the load can be sent a rate confirmation')
  }
  const carrierId = optionalString(carrier.carrierId, 100)
  if (!carrierId) throw new Error('That assignment is not a directory carrier; book it with BOOK_CARRIER first')
  const loadId = String(carrier.loadId)
  const shipmentId = String(carrier.shipmentId)
  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  if (!BUCKET_NAME) throw new Error('Document storage is not configured')

  const bytes = Buffer.from(pdfBase64, 'base64')
  if (bytes.length === 0) throw new Error('pdfBase64 is not a readable document')
  if (bytes.length > MAX_RATE_CON_BYTES) throw new Error('That rate confirmation is too large to send')

  const settings = await getSettings()
  const version = (numberOrNull(carrier.rateConVersion) ?? 0) + 1
  const loadNumber = optionalString(load.loadNumber, 60) ?? loadId
  const s3Key = `rate-confirms/carrier/${loadId}/${loadCarrierId}-v${version}.pdf`
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    Body: bytes,
    ContentType: 'application/pdf',
  }))

  const hours = expiresHours ?? numberOrNull(settings?.rateConExpiryHours) ?? DEFAULT_RATE_CON_EXPIRY_HOURS
  const now = nowIso()
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString()
  const token = randomBytes(32).toString('base64url')
  const documentId = `cdoc-${randomUUID()}`
  const filename = `rate-con-${loadNumber}-v${version}.pdf`

  await transact(
    [
      putItem(CARRIER_DOCUMENT_TABLE_NAME, {
        id: documentId,
        __typename: 'CarrierDocument',
        carrierId,
        type: 'RATE_CON',
        name: filename,
        s3Key,
        contentType: 'application/pdf',
        sizeBytes: bytes.length,
        expiresAt: null,
        loadCarrierId,
        source: 'GENERATED',
        uploadedBy: caller.email,
        createdAt: now,
        updatedAt: now,
      }),
      updateItemTx(LOAD_CARRIER_TABLE_NAME, loadCarrierId, {
        rateConStatus: 'SENT',
        rateConToken: token,
        rateConSentAt: now,
        rateConSentTo: to.join(', '),
        rateConExpiresAt: expiresAt,
        rateConDocumentId: documentId,
        rateConVersion: version,
        // The signing API's per-token rate limit counts from zero for each new link.
        rateConRequestCount: 0,
        updatedBy: caller.email,
        updatedAt: now,
      }, null),
    ],
    'rate confirmation',
  )

  const signUrl = PORTAL_ORIGIN
    ? `${PORTAL_ORIGIN.replace(/\/+$/, '')}/sign/rate-con/${token}`
    : ''
  const body =
    `Attached is the rate confirmation for load ${loadNumber}.\r\n\r\n` +
    (signUrl ? `Review and sign it here: ${signUrl}\r\n\r\n` : '') +
    `This link expires ${expiresAt}.\r\n\r\n— Ivan Cartage`
  try {
    await sendRateConEmail({
      to,
      cc,
      subject: `Rate confirmation — load ${loadNumber}`,
      body,
      filename,
      pdfBase64,
    })
  } catch (err) {
    console.error('[tms-shipment-actions] rate con email failed', err)
    // ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly.
    const failure = new Error(`The rate confirmation was saved but the email could not be sent: ${String(err)}`)
    ;(failure as Error & { cause?: unknown }).cause = err
    throw failure
  }

  await writeAudit('LOAD_CARRIER', loadCarrierId, 'SEND_RATE_CON', caller, {
    loadId, version, to, cc, expiresAt, documentId, s3Key,
  })
  return readBundle(shipmentId) as unknown as Row
}

/** Kill the open link without putting anybody else on the load. */
async function voidRateCon(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const carrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!carrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  const status = String(carrier.rateConStatus ?? 'NOT_SENT')
  if (!OPEN_RATE_CON_STATUSES.includes(status)) {
    throw new Error('Only a rate confirmation that has been sent and not yet signed can be voided')
  }
  const now = nowIso()
  await transact(
    [updateItemTx(LOAD_CARRIER_TABLE_NAME, loadCarrierId, {
      rateConStatus: 'VOIDED',
      rateConToken: null,
      updatedBy: caller.email,
      updatedAt: now,
    }, null)],
    'rate confirmation',
  )
  await writeAudit('LOAD_CARRIER', loadCarrierId, 'VOID_RATE_CON', caller, {
    loadId: String(carrier.loadId), from: status,
  })
  return readBundle(String(carrier.shipmentId)) as unknown as Row
}

// ── DISPATCH_LOAD ────────────────────────────────────────────────────────────

/**
 * Put a booked load on the road. An unsigned rate confirmation does not stop a
 * dispatch — the truck is already rolling — but it is written onto the assignment
 * so nobody has to remember it was never signed.
 */
async function dispatchLoad(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const dispatchedAt = assertIso(input.dispatchedAt, 'dispatchedAt')

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')
  const current = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  if (current !== 'BOOKED') throw new Error('Only a booked load can be dispatched')
  if (!canTransitionLoadStatus(current, 'DISPATCHED')) {
    throw new Error(`A load cannot go from ${current ?? 'SOURCING'} to DISPATCHED`)
  }

  const carriers = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
  const active = carriers.find((c) => c.status === 'ACTIVE') ?? null
  if (!active) throw new Error('That load has nobody on it to dispatch')

  const warnings = new Set(
    (Array.isArray(active.bookingWarnings) ? active.bookingWarnings : []).map((w) => String(w)),
  )
  if (String(active.rateConStatus ?? '') !== 'SIGNED') warnings.add('RATE_CON_NOT_SIGNED')

  const now = nowIso()
  const patch: Row = {
    dispatchedAt,
    dispatchNote: optionalString(input.note, 1000),
    bookingWarnings: [...warnings],
    updatedBy: caller.email,
    updatedAt: now,
  }
  // Only what the dispatcher filled in moves; a blank box never clears what the
  // carrier already told us at booking.
  const pickupEtaAt = optionalIso(input.pickupEtaAt, 'pickupEtaAt')
  if (pickupEtaAt) patch.pickupEtaAt = pickupEtaAt
  const driverName = optionalString(input.driverName, 120)
  if (driverName) patch.driverName = driverName
  const driverPhone = optionalString(input.driverPhone, 40)
  if (driverPhone) patch.driverPhone = driverPhone
  const truckNumber = optionalString(input.truckNumber, 40)
  if (truckNumber) patch.truckNumber = truckNumber
  const trailerNumber = optionalString(input.trailerNumber, 40)
  if (trailerNumber) patch.trailerNumber = trailerNumber
  const trackingProvider = optionalEnum(input.trackingProvider, TRACKING_PROVIDERS, 'trackingProvider')
  const nextCheckCallAt = optionalIso(input.nextCheckCallAt, 'nextCheckCallAt')
  const nextCheckCallNote = optionalString(input.nextCheckCallNote, 1000)
  // The dispatch is the first row of the load's tracking log, and it carries the
  // reminder it just scheduled so the timeline reads back as what actually happened.
  const event = checkCallRow({
    id: randomUUID(),
    loadId,
    shipmentId,
    loadCarrierId: String(active.id),
    at: dispatchedAt,
    type: 'DISPATCH',
    source: 'SYSTEM',
    statusBefore: current,
    statusAfter: 'DISPATCHED',
    note: patch.dispatchNote as string | null,
    pickupEtaAt: pickupEtaAt ?? (optionalString(active.pickupEtaAt, 40)),
    nextCheckCallAt,
    nextCheckCallNote,
  }, caller)
  await transact(
    [
      updateItemTx(LOAD_CARRIER_TABLE_NAME, String(active.id), patch, null),
      putItem(LOAD_CHECK_CALL_TABLE_NAME, event),
    ],
    'dispatch',
  )

  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadId,
      status: 'DISPATCHED',
      statusChangedAt: now,
      statusChangedBy: caller.email,
      statusSource: 'USER',
      ...(trackingProvider ? { trackingProvider } : {}),
      // The sparse marker is what the check-call worklist is built from.
      ...(nextCheckCallAt ? { nextCheckCallAt, checkCallOpen: 'OPEN' } : {}),
      ...(nextCheckCallNote ? { nextCheckCallNote } : {}),
      updatedBy: caller.email,
    }),
    'Load update',
  )

  await writeAudit('LOAD_CARRIER', String(active.id), 'DISPATCH_LOAD', caller, {
    loadId, dispatchedAt, warnings: [...warnings],
  })
  return rederiveShipmentStatus(shipmentId, caller)
}

// ── Pricing (RECALC_CHARGES, UPDATE_CARRIER_CHARGES) ─────────────────────────

/** Everything a charge line says about money and what it is for. */
const CHARGE_CONTENT_FIELDS = [
  'side', 'orderId', 'loadId', 'loadCarrierId', 'code', 'label', 'calculatedBy',
  'rateCents', 'count', 'amountCents', 'isRate', 'release', 'sortOrder', 'note',
] as const

function sameCharge(existing: Row | null, next: Row): boolean {
  if (!existing) return false
  return CHARGE_CONTENT_FIELDS.every((field) => (existing[field] ?? null) === (next[field] ?? null))
}

/**
 * A recorded bill is a promise to pay an exact number, so the lines under it stop
 * moving: once an assignment carries `chargesFinalizedAt`, its CARRIER lines may
 * not be edited, dropped or added to by any path through here. Voiding the bill
 * clears the stamp and reopens them.
 */
function assertFinalizedChargesUnchanged(bundle: Bundle, chargeRows: Row[]): void {
  const finalized = new Set(
    bundle.loadCarriers.filter((c) => c.chargesFinalizedAt != null).map((c) => String(c.id)),
  )
  if (finalized.size === 0) return
  const theirs = (row: Row): boolean => row.side === 'CARRIER' && finalized.has(String(row.loadCarrierId ?? ''))
  const before = new Map(bundle.charges.filter(theirs).map((row) => [String(row.id), row]))
  const after = new Map(chargeRows.filter(theirs).map((row) => [String(row.id), row]))
  for (const [id, row] of before) {
    const kept = after.get(id)
    if (!kept || !sameCharge(row, kept)) throw new Error(FINALIZED_CHARGES_MESSAGE)
  }
  for (const id of after.keys()) {
    if (!before.has(id)) throw new Error(FINALIZED_CHARGES_MESSAGE)
  }
}

/** What one assignment is owed, re-derived from its own lines and cached on its row. */
function carrierCachePatch(chargeRows: Row[], loadCarrier: Row, caller: Caller, now: string): Row {
  // Their own lines, not the load's totals: a TONU'd carrier's retained line is
  // still on the load and is not this carrier's money.
  const id = String(loadCarrier.id)
  const ownCostCents = carrierOwnCostCents(chargeRows, id)
  const ownRateCents = carrierOwnCostCents(chargeRows.filter((r) => r.isRate === true), id)
  return {
    carrierRateCents: ownRateCents,
    costCents: ownCostCents,
    // The quick-pay fee is cached off that money, so an edited rate moves it;
    // left alone it prints a stale fee and net payable on the rate con.
    ...(loadCarrier.quickPay === true
      ? { quickPayFeeCents: quickPayFee(ownCostCents, numberOrNull(loadCarrier.quickPayFeeBps) ?? 0) }
      : {}),
    updatedBy: caller.email,
    updatedAt: now,
  }
}

/**
 * Every write that repricing a shipment's first leg implies: the charge lines
 * themselves, the cached LoadFinancials, the order's revenue, the shipment's
 * version and the active carrier's own pay. RECALC_CHARGES is this and nothing
 * else; an incident's charge lines and an AP charge edit go through the same path,
 * so a cached total can never drift from the lines underneath it.
 */
function repriceShipment(args: {
  bundle: Bundle
  charges: ChargeInput[]
  customer: Row | null
  settings: Row | null
  caller: Caller
  /** CAS on the shipment, or null when the caller already CAS'd the load. */
  expectedShipmentUpdatedAt: string | null
}): { writes: TransactWriteItem[]; chargeRows: Row[]; totals: FinancialsTotals } {
  const { bundle, charges, customer, settings, caller } = args
  const { shipment } = bundle
  const shipmentId = String(shipment.id)
  const order = bundle.orders[0]
  const load = bundle.loads[0]
  if (!order || !load) throw new Error('That shipment has no order or load to price')
  const loadId = String(load.id)
  const orderId = String(order.id)
  const existingFinancials = bundle.financials.find((f) => f.id === loadId) ?? null
  const existingById = new Map(bundle.charges.map((row) => [String(row.id), row]))

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
    existingById.get(String(c.id ?? '')) ?? null,
  ))
  const keptIds = new Set(chargeRows.map((r) => String(r.id)))
  const removed = bundle.charges.filter((r) => !keptIds.has(String(r.id)))
  assertFinalizedChargesUnchanged(bundle, chargeRows)
  // Every caller resubmits the whole shipment, so most lines come back exactly as
  // they were. Rewriting one of those would stamp an edit nobody made onto a line
  // this action never claimed to touch — and spend a transaction slot on it.
  const touched = chargeRows.filter((row) => !sameCharge(existingById.get(String(row.id)) ?? null, row))
  const now = nowIso()

  const writes: TransactWriteItem[] = [
    ...touched.map((row) => putItem(LOAD_CHARGE_TABLE_NAME, row, false)),
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
      version: (numberOrNull(shipment.version) ?? 1) + 1,
    }, args.expectedShipmentUpdatedAt),
  ]
  if (activeCarrier) {
    writes.push(updateItemTx(
      LOAD_CARRIER_TABLE_NAME,
      String(activeCarrier.id),
      carrierCachePatch(chargeRows, activeCarrier, caller, now),
      null,
    ))
  }
  return { writes, chargeRows, totals }
}

async function recalcCharges(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedVersion = optionalInteger(input.expectedVersion, { min: 0, label: 'expectedVersion' })
  if (expectedVersion == null) throw new Error('expectedVersion is required')

  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  if (shipment.deletedAt) throw new Error('That shipment is deleted')
  const currentVersion = numberOrNull(shipment.version) ?? 1
  if (currentVersion !== expectedVersion) throw conflictError('shipment', null)

  const load = bundle.loads[0]
  const loadId = load ? String(load.id) : ''
  const existingFinancials = bundle.financials.find((f) => f.id === loadId) ?? null
  if (existingFinancials?.frozenAt) {
    throw new Error('This load\'s financials are frozen and can no longer be changed')
  }

  const customer = await getById(CUSTOMER_TABLE_NAME, String(shipment.customerId))
  const settings = await getSettings()
  const rules = chargeCodeRules(settings, customer)
  const charges = assertArrayOf(input.charges, 'charges', (item, i) => validateChargeInput(item, i, rules))

  const { writes, chargeRows, totals } = repriceShipment({
    bundle,
    charges,
    customer,
    settings,
    caller,
    expectedShipmentUpdatedAt: String(shipment.updatedAt ?? ''),
  })
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
  // Step H. Revenue moves until the invoice freezes it, so a delivered load's
  // lane sample is refreshed by every re-price rather than frozen at delivery.
  if (isDeliveredOrLater(load?.status)) await writeLaneSample(quoteDeps, loadId)
  return readBundle(shipmentId) as unknown as Row
}

/**
 * Rewrite one assignment's CARRIER charge lines, and nothing else.
 *
 * AP settles what a carrier is owed long after the customer's side is done, so
 * this refuses on `chargesFinalizedAt` — a recorded bill names an exact number —
 * and not on `frozenAt`, which froze the customer's lines and says nothing about
 * the carrier's. Every other line on the shipment goes back in untouched, so the
 * load's cached cost, profit and margin are re-derived by the one pricing path
 * rather than patched here.
 */
async function updateCarrierCharges(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const expectedVersion = optionalInteger(input.expectedVersion, { min: 0, label: 'expectedVersion' })
  if (expectedVersion == null) throw new Error('expectedVersion is required')

  const assignment = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!assignment) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (assignment.kind !== 'CARRIER') {
    throw new Error('An own-fleet leg is paid through a driver settlement, not through AP')
  }
  const status = String(assignment.status ?? '')
  if (status !== 'ACTIVE' && status !== 'TONU') {
    throw new Error('These charges belong to an assignment that is still owed money')
  }
  if (assignment.chargesFinalizedAt) throw new Error(FINALIZED_CHARGES_MESSAGE)

  const shipmentId = String(assignment.shipmentId)
  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  if (shipment.deletedAt) throw new Error('That shipment is deleted')
  const currentVersion = numberOrNull(shipment.version) ?? 1
  if (currentVersion !== expectedVersion) throw conflictError('shipment', null)

  const customer = await getById(CUSTOMER_TABLE_NAME, String(shipment.customerId))
  const settings = await getSettings()
  const rules = chargeCodeRules(settings, customer)
  const theirs = (row: Row): boolean =>
    row.side === 'CARRIER' && String(row.loadCarrierId ?? '') === loadCarrierId
  const theirIds = new Set(bundle.charges.filter(theirs).map((row) => String(row.id)))
  const requested = assertArrayOf(input.charges, 'charges', (item, i): ChargeInput => {
    const charge = validateChargeInput(item, i, rules)
    if (charge.side !== 'CARRIER') throw new Error(`charges[${i}].side must be CARRIER`)
    // An id this assignment does not own would rewrite somebody else's line —
    // the customer's, or a TONU'd sibling's — as a carrier charge of this one.
    if (charge.id != null && !theirIds.has(charge.id)) {
      throw new Error(`charges[${i}].id is not a line on this assignment`)
    }
    return { ...charge, loadId: String(assignment.loadId), loadCarrierId }
  })
  // Everything that is not this assignment's money goes back in exactly as it is:
  // the pricing path needs the whole shipment to re-derive the load's totals, and
  // a line that comes back unchanged is not rewritten.
  const others = bundle.charges.filter((row) => !theirs(row)).map(chargeRowToInput)

  const { writes, chargeRows, totals } = repriceShipment({
    bundle,
    charges: [...others, ...requested],
    customer,
    settings,
    caller,
    expectedShipmentUpdatedAt: String(shipment.updatedAt ?? ''),
  })
  const loadId = String(assignment.loadId)
  const active = bundle.loadCarriers.find((c) => c.loadId === loadId && c.status === 'ACTIVE') ?? null
  // A TONU'd assignment is still owed its retained lines, and repricing only
  // re-caches the carrier currently on the load; this one has to be told itself.
  if (String(active?.id ?? '') !== loadCarrierId) {
    writes.push(updateItemTx(
      LOAD_CARRIER_TABLE_NAME,
      loadCarrierId,
      carrierCachePatch(chargeRows, assignment, caller, nowIso()),
      null,
    ))
  }
  await transact(writes, 'charges')

  // `Load.rate` mirrors the order's revenue. The carrier's side cannot move it,
  // but the mirror is rewritten with the totals it belongs to rather than left to
  // drift on the one path that does not refresh it.
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({ id: loadId, rate: totals.revenueCents, updatedBy: caller.email }),
    'Load update',
  )

  await writeAudit('LOAD_CARRIER', loadCarrierId, 'UPDATE_CARRIER_CHARGES', caller, {
    loadId,
    lines: requested.length,
    costCents: carrierOwnCostCents(chargeRows, loadCarrierId),
    loadCostCents: totals.costCents,
  })
  // Step H. Cost moves until the carrier's bill is recorded; same refresh.
  if (isDeliveredOrLater(bundle.loads.find((row) => String(row.id) === loadId)?.status)) {
    await writeLaneSample(quoteDeps, loadId)
  }
  return readBundle(shipmentId) as unknown as Row
}

// ── Check calls and tracking (step D) ────────────────────────────────────────

/** Everything a LoadCheckCall row may carry. Absent keys are never written. */
interface CheckCallRowFields {
  id: string
  loadId: string
  shipmentId: string
  at: string
  type: CheckCallType
  source: CheckCallSource
  loadCarrierId?: string | null
  stopId?: string | null
  incidentType?: IncidentType | null
  /** Only ever the literal 'OPEN'; see below. */
  incidentOpen?: 'OPEN'
  statusBefore?: LoadWorkflowStatus | null
  statusAfter?: LoadWorkflowStatus | null
  city?: string | null
  state?: string | null
  lat?: number | null
  lng?: number | null
  personName?: string | null
  note?: string | null
  charges?: CheckCallChargeSnapshot[] | null
  nextCheckCallAt?: string | null
  nextCheckCallNote?: string | null
  pickupEtaAt?: string | null
  deliveryEtaAt?: string | null
}

/**
 * One row of a load's tracking log.
 *
 * `incidentOpen` is the sparse hash key of the open-exceptions index, so it is
 * only ever written as the literal 'OPEN' — a stored null would be an index key of
 * type NULL, which DynamoDB refuses outright. `marshallRow` drops undefined keys,
 * so a field nobody set never reaches the table.
 */
function checkCallRow(fields: CheckCallRowFields, caller: Caller): Row {
  const now = nowIso()
  return {
    __typename: 'LoadCheckCall',
    ...fields,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Write a check call only if nobody wrote it first.
 *
 * This handler and the driver app's projector race for the same derived `evt:` id.
 * The loser's write is a no-op rather than an error: the stamp is already logged,
 * and logging it twice is exactly what a derived id exists to prevent.
 */
async function putCheckCallIfAbsent(row: Row): Promise<boolean> {
  try {
    await dynamo.send(new PutItemCommand({
      TableName: LOAD_CHECK_CALL_TABLE_NAME,
      Item: marshallRow(row),
      ConditionExpression: 'attribute_not_exists(id)',
    }))
    return true
  } catch (err) {
    if (isConditionalFailure(err)) return false
    throw err
  }
}

/** A conditional write that lost, whether it was alone or inside a transaction. */
function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException' || isConflict(err)
}

/** The live ping link on an assignment, if the driver was ever texted one. */
async function activeCarrierPingLink(carrier: Row): Promise<Row | null> {
  const linkId = optionalString(carrier.trackingLinkId, 100)
  if (!linkId || !TRACKING_LINK_TABLE_NAME) return null
  const link = await getById(TRACKING_LINK_TABLE_NAME, linkId)
  if (!link || link.kind !== 'CARRIER_PING' || link.status !== 'ACTIVE') return null
  return link
}

/**
 * Write the check-call schedule onto a load.
 *
 * `checkCallOpen` is the sparse hash key of the worklist index. Amplify's `update`
 * with null stores a NULL attribute and DynamoDB rejects the whole write with
 * `Type mismatch for Index Key checkCallOpen … Actual: NULL`, so clearing has to
 * REMOVE — which is why this is a raw UpdateItem rather than the generated
 * mutation. Setting a new time drops the notifier's two stamps with it, so the
 * reminder re-arms for the schedule that was just chosen.
 */
async function writeCheckCallSchedule(args: {
  loadId: string
  nextCheckCallAt: string | null
  note: string | null
  caller: Caller
  expectedUpdatedAt: string | null
}): Promise<void> {
  const now = nowIso()
  const names: Record<string, string> = {
    '#updatedAt': 'updatedAt',
    '#updatedBy': 'updatedBy',
    '#checkCallOpen': 'checkCallOpen',
    '#nextCheckCallAt': 'nextCheckCallAt',
    '#nextCheckCallNote': 'nextCheckCallNote',
    '#checkCallDueNotifiedAt': 'checkCallDueNotifiedAt',
    '#checkCallOverdueNotifiedAt': 'checkCallOverdueNotifiedAt',
  }
  const values: Record<string, AttributeValue> = {
    ':updatedAt': { S: now },
    ':updatedBy': { S: args.caller.email },
  }
  const sets = ['#updatedAt = :updatedAt', '#updatedBy = :updatedBy']
  const removes = ['#checkCallDueNotifiedAt', '#checkCallOverdueNotifiedAt']
  if (args.nextCheckCallAt) {
    sets.push('#nextCheckCallAt = :nextCheckCallAt', '#checkCallOpen = :open')
    values[':nextCheckCallAt'] = { S: args.nextCheckCallAt }
    values[':open'] = { S: 'OPEN' }
    if (args.note) {
      sets.push('#nextCheckCallNote = :note')
      values[':note'] = { S: args.note }
    } else {
      removes.push('#nextCheckCallNote')
    }
  } else {
    removes.push('#checkCallOpen', '#nextCheckCallAt', '#nextCheckCallNote')
  }
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: LOAD_TABLE_NAME,
      Key: marshall({ id: args.loadId }),
      UpdateExpression: `SET ${sets.join(', ')} REMOVE ${removes.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(args.expectedUpdatedAt == null
        ? {}
        : { ConditionExpression: casCondition(values, args.expectedUpdatedAt) }),
    }))
  } catch (err) {
    if (isConditionalFailure(err)) throw conflictError('load', err)
    throw err
  }
}

/** A charge the incident dialog asked for, before the lib turns it into lines. */
interface IncidentChargeInput {
  side: ChargeSide | 'BOTH'
  code: string
  label: string | null
  rateCents: number
  count: number
}

function validateIncidentCharge(item: unknown, index: number): IncidentChargeInput {
  const c = assertRecord(item, `charges[${index}]`)
  return {
    side: assertEnum(c.side, INCIDENT_CHARGE_SIDES, `charges[${index}].side`),
    code: assertString(c.code, `charges[${index}].code`).toUpperCase(),
    label: optionalString(c.label, 120),
    rateCents: optionalInteger(c.rateCents, { label: `charges[${index}].rateCents` }) ?? 0,
    count: optionalInteger(c.count, { min: 1, label: `charges[${index}].count` }) ?? 1,
  }
}

/**
 * Log what just happened to a load.
 *
 * The dispatcher's dialog is one call: it stamps the stop clock, moves the load
 * from it, records where the truck is, opens an exception, bills for it and
 * schedules the next reminder. Everything that has to agree — the log row, the
 * charge lines and every cached total — moves in one transaction; the Load itself
 * follows through the generated mutation so the board's subscriptions fire.
 */
async function logCheckCall(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const at = assertIso(input.at, 'at')
  const requestedType = assertString(input.type, 'type') as CheckCallType
  if (!(MANUALLY_LOGGABLE_TYPES as readonly string[]).includes(requestedType)) {
    throw new Error(`A ${requestedType} row is written by the system, not logged by hand`)
  }
  const stopId = optionalString(input.stopId, 100)
  const incidentType = optionalEnum(input.incidentType, INCIDENT_TYPES, 'incidentType')
  const city = optionalString(input.city, 120)
  const state = optionalString(input.state, 40)
  const lat = optionalFloat(input.lat, { min: -90, max: 90, label: 'lat' })
  const lng = optionalFloat(input.lng, { min: -180, max: 180, label: 'lng' })
  const personName = optionalString(input.personName, 120)
  const note = optionalString(input.note, MAX_CHECK_CALL_NOTE)
  const chargeRequests = input.charges == null
    ? []
    : assertArrayOf(input.charges, 'charges', validateIncidentCharge)
  // An absent key leaves the reminder alone; null clears it; a time sets it.
  const schedules = 'nextCheckCallAt' in input
  const nextCheckCallAt = optionalIso(input.nextCheckCallAt, 'nextCheckCallAt')
  const nextCheckCallNote = optionalString(input.nextCheckCallNote, 1000)

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  if (String(load.updatedAt ?? '') !== expectedUpdatedAt) throw conflictError('load', null)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')
  const statusBefore = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  if (statusBefore === 'CANCELED') throw new Error('That load is canceled; there is nothing left to track')
  if (Date.parse(at) > Date.now() + CHECK_CALL_FUTURE_GRACE_MS) {
    throw new Error('A check call cannot be logged in the future')
  }
  if (requestedType === 'INCIDENT' && !incidentType) throw new Error('An incident needs an incident type')

  const stops = readStops(load)
  const stopEvent: StopEventType | null =
    requestedType === 'ARRIVED' || requestedType === 'DEPARTED' ? requestedType : null
  if (stopEvent && !stops.some((s) => s.id === stopId)) {
    throw new Error('An arrival or a departure has to name a stop on this load')
  }

  const bundle = await readBundle(shipmentId)
  const activeCarrier = bundle.loadCarriers.find((c) => c.loadId === loadId && c.status === 'ACTIVE') ?? null
  const financials = bundle.financials.find((f) => f.id === loadId) ?? null
  if (chargeRequests.length > 0 && financials?.frozenAt) {
    throw new Error('This load\'s financials are frozen and can no longer be changed')
  }

  const settings = chargeRequests.length > 0 ? await getSettings() : null
  const customer = chargeRequests.length > 0
    ? await getById(CUSTOMER_TABLE_NAME, String(bundle.shipment.customerId))
    : null
  const order = bundle.orders[0] ?? null
  // The lib refuses a carrier charge with nobody to pay and a negative one.
  const lines = chargeRequests.length === 0 ? [] : incidentChargeLines({
    charges: chargeRequests,
    existing: bundle.charges.map((c) => ({ sortOrder: numberOrNull(c.sortOrder) })),
    orderId: order ? String(order.id) : null,
    loadId,
    loadCarrierId: activeCarrier ? String(activeCarrier.id) : null,
    codes: Array.isArray(settings?.chargeCodes) ? (settings?.chargeCodes as ChargeCodeDef[]) : null,
  })

  const eventId = stopEvent && stopId ? stopEventId(loadId, stopId, stopEvent) : null
  // The driver app's projector writes this same derived id. If it got there first
  // its stamp is the one that counts: the stop clock is left alone and this call is
  // kept as a location update carrying the dispatcher's note.
  const alreadyLogged = eventId != null && (await getById(LOAD_CHECK_CALL_TABLE_NAME, eventId)) != null
  const type: CheckCallType = alreadyLogged ? 'LOCATION_UPDATE' : requestedType
  // Only a stop with an id can be stamped, and `stopId` was checked against them.
  const stamped = stops as (StopShape & { id: string })[]
  const stamp = stopEvent && stopId && !alreadyLogged
    ? stampStopEvent(stamped, stopId, stopEvent, at)
    : { stops: stamped, stamped: false }
  const statusAfter = stamp.stamped ? statusAfterCheckCall(stopTimesOf(stamp.stops), statusBefore) : null

  const chargeIds = lines.map(() => `chg-${randomUUID()}`)
  const event = checkCallRow({
    id: alreadyLogged || eventId == null ? randomUUID() : eventId,
    loadId,
    shipmentId,
    loadCarrierId: activeCarrier ? String(activeCarrier.id) : null,
    stopId,
    at,
    type,
    source: 'MANUAL',
    incidentType: type === 'INCIDENT' ? incidentType : null,
    ...(type === 'INCIDENT' ? { incidentOpen: 'OPEN' as const } : {}),
    statusBefore,
    statusAfter,
    city,
    state,
    lat,
    lng,
    personName,
    note,
    charges: lines.length === 0
      ? null
      : lines.map((line, i) => ({
          side: line.side,
          code: line.code,
          amountCents: line.amountCents,
          chargeId: chargeIds[i],
        })),
    nextCheckCallAt: schedules ? nextCheckCallAt : null,
    nextCheckCallNote: schedules && nextCheckCallAt ? nextCheckCallNote : null,
  }, caller)

  const writes: TransactWriteItem[] = [
    // The Load's own mutation follows through AppSync under the same CAS. Guarding
    // it here too is what makes the money atomic: the projector and the driver app
    // both rewrite `updatedAt`, and one landing in the gap would otherwise leave a
    // billed charge line and an orphan stop event behind — which the retry then
    // downgrades to a location update and bills a second time.
    conditionCheckUpdatedAtTx(LOAD_TABLE_NAME, loadId, expectedUpdatedAt),
    putItem(LOAD_CHECK_CALL_TABLE_NAME, event),
  ]
  let revenueCents: number | null = null
  if (lines.length > 0) {
    // Incident money is priced by the one path that keeps LoadFinancials, the
    // order and the carrier's cached pay agreeing with the lines underneath them.
    const repriced = repriceShipment({
      bundle,
      charges: [
        ...bundle.charges.map(chargeRowToInput),
        ...lines.map((line, i): ChargeInput => ({
          id: chargeIds[i],
          side: line.side,
          code: line.code,
          label: line.label ?? null,
          calculatedBy: 'FLAT',
          rateCents: line.rateCents,
          count: line.count ?? 1,
          isRate: false,
          release: null,
          sortOrder: line.sortOrder ?? 0,
          note: null,
          loadId,
          loadCarrierId: line.loadCarrierId ?? null,
        })),
      ],
      customer,
      settings,
      caller,
      expectedShipmentUpdatedAt: null,
    })
    writes.push(...repriced.writes)
    revenueCents = repriced.totals.revenueCents
  }
  await transact(writes, 'check call')

  const now = nowIso()
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update(
      {
        id: loadId,
        ...(stamp.stamped ? { stops: JSON.stringify(stamp.stops), ...deriveLegacyFields(stamp.stops) } : {}),
        ...(statusAfter
          ? { status: statusAfter, statusChangedAt: now, statusChangedBy: caller.email, statusSource: 'CHECK_CALL' }
          : {}),
        ...(statusAfter === 'DELIVERED' ? { deliveredAt: at } : {}),
        ...lastKnownPatch({ at, type, source: 'MANUAL', city, state, lat, lng }),
        ...(type === 'INCIDENT'
          ? { openIncidentCount: (numberOrNull(load.openIncidentCount) ?? 0) + 1 }
          : {}),
        ...(revenueCents == null ? {} : { rate: revenueCents }),
        updatedBy: caller.email,
      },
      { condition: { updatedAt: { eq: expectedUpdatedAt } } },
    ),
    'Load update',
  )
  // The schedule carries a sparse index key, so it never rides the generated
  // mutation. The CAS above already proved nobody else moved the load.
  if (schedules) {
    await writeCheckCallSchedule({ loadId, nextCheckCallAt, note: nextCheckCallNote, caller, expectedUpdatedAt: null })
  }

  await writeAudit('LOAD', loadId, `LOG_CHECK_CALL:${type}`, caller, {
    checkCallId: event.id,
    at,
    statusAfter,
    incidentType: incidentType ?? null,
    charges: lines.length,
    nextCheckCallAt: schedules ? nextCheckCallAt : null,
  })
  return { bundle: await rederiveShipmentStatus(shipmentId, caller), event } as unknown as Row
}

/**
 * Close an exception. The sparse `incidentOpen` marker is REMOVEd, which is what
 * takes the row off the worklist, and the load's open count is then recounted
 * from the rows rather than decremented: a count is a cache, the rows are truth.
 */
async function resolveIncident(input: Row, caller: Caller): Promise<Row> {
  const checkCallId = assertString(input.checkCallId, 'checkCallId')
  const note = optionalString(input.note, MAX_CHECK_CALL_NOTE)

  const row = await getById(LOAD_CHECK_CALL_TABLE_NAME, checkCallId)
  if (!row) throw new Error(`Check call not found: ${checkCallId}`)
  if (row.type !== 'INCIDENT') throw new Error('That check call is not an incident')
  if (row.resolvedAt) throw new Error('That incident is already resolved')

  const loadId = String(row.loadId)
  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)

  const now = nowIso()
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: LOAD_CHECK_CALL_TABLE_NAME,
      Key: marshall({ id: checkCallId }),
      UpdateExpression:
        'SET #resolvedAt = :at, #resolvedBy = :by, #resolutionNote = :note, #updatedAt = :at REMOVE #incidentOpen',
      ExpressionAttributeNames: {
        '#resolvedAt': 'resolvedAt',
        '#resolvedBy': 'resolvedBy',
        '#resolutionNote': 'resolutionNote',
        '#updatedAt': 'updatedAt',
        '#incidentOpen': 'incidentOpen',
      },
      ExpressionAttributeValues: marshallRow({ ':at': now, ':by': caller.email, ':note': note }),
      // Two dispatchers clearing the same exception must still only count once.
      ConditionExpression: 'attribute_not_exists(resolvedAt)',
    }))
  } catch (err) {
    if (isConditionalFailure(err)) {
      // ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly.
      const already = new Error('That incident is already resolved')
      ;(already as Error & { cause?: unknown }).cause = err
      throw already
    }
    throw err
  }

  // The rows are the truth; the counter is a cache. A decrement from the read
  // above is a lost update the moment two dispatchers close two different
  // exceptions on the same load, so recount what is still open instead.
  const openIncidentCount = (await queryIndex(LOAD_CHECK_CALL_TABLE_NAME, IDX_CHECK_CALLS_BY_LOAD, 'loadId', loadId))
    .filter((c) => c.incidentOpen === 'OPEN').length
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({ id: loadId, openIncidentCount, updatedBy: caller.email }),
    'Load update',
  )

  await writeAudit('LOAD', loadId, 'RESOLVE_INCIDENT', caller, { checkCallId, note, openIncidentCount })
  const shipmentId = String(row.shipmentId)
  return {
    bundle: await readBundle(shipmentId),
    event: await getById(LOAD_CHECK_CALL_TABLE_NAME, checkCallId),
  } as unknown as Row
}

/** The banner's edit, snooze and "no reminder needed", which are all one write. */
async function setNextCheckCall(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  if (!('nextCheckCallAt' in input)) {
    throw new Error('nextCheckCallAt is required; send null for no reminder')
  }
  const nextCheckCallAt = optionalIso(input.nextCheckCallAt, 'nextCheckCallAt')
  const note = optionalString(input.note, 1000)

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  if (String(load.updatedAt ?? '') !== expectedUpdatedAt) throw conflictError('load', null)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')

  await writeCheckCallSchedule({ loadId, nextCheckCallAt, note, caller, expectedUpdatedAt })
  await writeAudit('LOAD', loadId, 'SET_NEXT_CHECK_CALL', caller, { nextCheckCallAt, note })
  return { bundle: await readBundle(shipmentId), event: null } as unknown as Row
}

/**
 * What the carrier now says about when they will be there. It is their promise, so
 * it lives on the assignment, and the tracking log keeps every version of it.
 */
async function setEta(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const pickupEtaAt = optionalIso(input.pickupEtaAt, 'pickupEtaAt')
  const deliveryEtaAt = optionalIso(input.deliveryEtaAt, 'deliveryEtaAt')
  const note = optionalString(input.note, MAX_CHECK_CALL_NOTE)
  if (!pickupEtaAt && !deliveryEtaAt) throw new Error('An ETA update needs a pickup or a delivery time')

  const carrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!carrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (carrier.status !== 'ACTIVE') throw new Error('Only the carrier currently on the load can give an ETA')
  const loadId = String(carrier.loadId)
  const shipmentId = String(carrier.shipmentId)

  const now = nowIso()
  const event = checkCallRow({
    id: randomUUID(),
    loadId,
    shipmentId,
    loadCarrierId,
    at: now,
    type: 'ETA_UPDATE',
    source: 'SYSTEM',
    note,
    pickupEtaAt,
    deliveryEtaAt,
  }, caller)
  await transact(
    [
      updateItemTx(LOAD_CARRIER_TABLE_NAME, loadCarrierId, {
        ...(pickupEtaAt ? { pickupEtaAt } : {}),
        ...(deliveryEtaAt ? { deliveryEtaAt } : {}),
        updatedBy: caller.email,
        updatedAt: now,
      }, expectedUpdatedAt),
      putItem(LOAD_CHECK_CALL_TABLE_NAME, event),
    ],
    'eta',
  )

  await writeAudit('LOAD_CARRIER', loadCarrierId, 'SET_ETA', caller, { loadId, pickupEtaAt, deliveryEtaAt, note })
  return { bundle: await readBundle(shipmentId), event } as unknown as Row
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
  const invoiceId = optionalString(order.invoiceId, 100)
  if (invoiceId) {
    // Step F: the invoice owns the ladder from UNPAID on. Hand-setting the order
    // back to DOCS_NEEDED would leave an issued bill with nothing behind it.
    const label = optionalString(order.invoiceNumber, 100) ?? invoiceId
    throw new Error(`This order has invoice ${label}; void the invoice first`)
  }
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
          // No apStatus: every row this backfill mints is own fleet, which is paid
          // through a driver settlement and never enters AP.
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

// ── Quote, offer and lane-sample actions (step H) ────────────────────────────

/**
 * The quote board, the offer thread and the lane history live in `quotes.ts`,
 * `offers.ts` and `laneSamples.ts`. Like the document module they are handed this
 * handler's clients, tables and bodies rather than building their own: a quote is
 * priced by the same `computeFinancials` as the shipment it becomes, and an offer
 * is booked by this file's `BOOK_CARRIER` with its whole gate intact.
 */
const quoteDeps: QuoteDeps = {
  db: dynamo,
  ses,
  store,
  tables: {
    quote: QUOTE_TABLE_NAME,
    laneSample: LANE_RATE_SAMPLE_TABLE_NAME,
    carrierContact: CARRIER_CONTACT_TABLE_NAME,
    carrier: CARRIER_TABLE_NAME,
    customer: CUSTOMER_TABLE_NAME,
    settings: SETTINGS_TABLE_NAME,
    division: DIVISION_TABLE_NAME,
    order: ORDER_TABLE_NAME,
    load: LOAD_TABLE_NAME,
    loadCarrier: LOAD_CARRIER_TABLE_NAME,
    loadFinancials: LOAD_FINANCIALS_TABLE_NAME,
    shipment: SHIPMENT_TABLE_NAME,
    shipmentNotice: SHIPMENT_NOTICE_TABLE_NAME,
  },
  fromAddress: FROM_ADDRESS,
  portalOrigin: PORTAL_ORIGIN,
  randomBytes,
  writeAudit,
  getSettings,
  getActiveCustomer,
  getById,
  queryIndex,
  transact,
  readBundle,
  chargeCodeRules: (settings, customer) => chargeCodeRules(settings, customer) as QuoteChargeRules,
  validateChargeInput,
  validateStop,
  pricingDefaultsOf,
  marginFloorBpsOf,
  checkCredit,
  assertCreditClear,
  createShipment,
  saveOrderForm,
  submitOrder,
  bookCarrier,
  softDeleteShipment,
  assertNoInvoicedOrders,
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
    case 'BOOK_CARRIER':
      return bookCarrier(input, caller)
    case 'SET_QUICK_PAY':
      return setQuickPay(input, caller)
    case 'SEND_RATE_CON':
      return sendRateCon(input, caller)
    case 'VOID_RATE_CON':
      return voidRateCon(input, caller)
    case 'DISPATCH_LOAD':
      return dispatchLoad(input, caller)
    case 'REMOVE_LOAD_CARRIER':
      return removeLoadCarrier(input, caller)
    case 'RECALC_CHARGES':
      return recalcCharges(input, caller)
    case 'UPDATE_CARRIER_CHARGES':
      return updateCarrierCharges(input, caller)
    case 'SET_AR_STATUS':
      return setArStatus(input, caller)
    case 'LOG_CHECK_CALL':
      return logCheckCall(input, caller)
    case 'RESOLVE_INCIDENT':
      return resolveIncident(input, caller)
    case 'SET_NEXT_CHECK_CALL':
      return setNextCheckCall(input, caller)
    case 'SET_ETA':
      return setEta(input, caller)
    case 'GET_SHIPMENT_BUNDLE':
      return readBundle(assertString(input.shipmentId, 'shipmentId')) as unknown as Row
    case 'BACKFILL_SHIPMENT':
      return backfillShipments(input, caller)
    case 'PREPARE_DOCUMENT_UPLOAD':
      return prepareDocumentUpload(documentDeps, input)
    case 'COMMIT_DOCUMENT':
      return commitDocument(documentDeps, input, caller)
    case 'SAVE_GENERATED_DOCUMENT':
      return saveGeneratedDocument(documentDeps, input, caller)
    case 'ATTACH_DRIVER_DOC':
      return attachDriverDoc(documentDeps, input, caller)
    case 'REVIEW_DOCUMENT':
      return reviewDocument(documentDeps, input, caller)
    case 'UPDATE_DOCUMENT':
      return updateDocument(documentDeps, input, caller)
    case 'VOID_DOCUMENT':
      return voidDocument(documentDeps, input, caller)
    case 'READY_TO_INVOICE':
      return readyToInvoice(documentDeps, input, caller)
    case 'RATE_CARRIER':
      return rateCarrier(documentDeps, input, caller)
    case 'SAVE_QUOTE':
      return saveQuote(quoteDeps, input, caller)
    case 'SEND_QUOTE':
      return sendQuote(quoteDeps, input, caller)
    case 'COUNTER_QUOTE':
      return counterQuote(quoteDeps, input, caller)
    case 'ACCEPT_COUNTER':
      return acceptCounter(quoteDeps, input, caller)
    case 'MARK_QUOTE_LOST':
      return markQuoteLost(quoteDeps, input, caller)
    case 'RESTORE_QUOTE':
      return restoreQuote(quoteDeps, input, caller)
    case 'CANCEL_QUOTE':
      return cancelQuote(quoteDeps, input, caller)
    case 'PASS_QUOTE':
      return passQuote(quoteDeps, input, caller)
    case 'SWEEP_EXPIRED_QUOTES':
      return sweepExpiredQuotes(quoteDeps, caller)
    case 'DUPLICATE_QUOTE':
      return duplicateQuotes(quoteDeps, input, caller)
    case 'CONVERT_QUOTE':
      return convertQuote(quoteDeps, input, caller)
    case 'REVERT_TO_QUOTE':
      return revertToQuote(quoteDeps, input, caller)
    case 'SAVE_QUOTE_SETTINGS':
      return saveQuoteSettings(quoteDeps, input, caller)
    case 'REQUEST_OFFERS':
      return requestOffers(quoteDeps, input, caller)
    case 'LOG_OFFER':
      return logOffer(quoteDeps, input, caller)
    case 'COUNTER_OFFER':
      return counterOffer(quoteDeps, input, caller)
    case 'REJECT_OFFER':
      return rejectOffer(quoteDeps, input, caller)
    case 'ACCEPT_OFFER':
      return acceptOffer(quoteDeps, input, caller)
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
