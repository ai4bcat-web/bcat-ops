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
import './tableEnv'
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
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { createHash, randomBytes, randomUUID } from 'crypto'
import {
  IDX_CARRIERS_BY_SHIPMENT,
  IDX_CHARGES_BY_SHIPMENT,
  IDX_LOADS_BY_SHIPMENT,
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
  type TransactOptions,
} from '../_shared/shipmentStore'
import {
  THREAD_MAILBOX,
  newMessageId,
  sesWireMessageId,
  subjectRef,
  threadKeyFor,
  threadReplyAddress,
} from '../../../src/lib/shipmentThread'
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
  attachInvoiceDoc,
  LOAD_REVIEW_ONLY_MESSAGE,
  commitDocument,
  prepareDocumentUpload,
  rateCarrier,
  readyToInvoice,
  reconcileBilling,
  reviewLoad,
  pushToReviewVerdict,
  reviewDocument,
  saveGeneratedDocument,
  updateDocument,
  voidDocument,
  setLoadRequiredDocs,
  type DocumentDeps,
} from './documents'
import {
  nextQuoteNumber,
  acceptCounter,
  cancelQuote,
  convertQuote,
  counterQuote,
  duplicateQuotes,
  markQuoteLost,
  markQuoteWon,
  passQuote,
  restoreQuote,
  revertToQuote,
  saveQuote,
  saveQuoteSettings,
  sendQuote,
  sweepExpiredQuotes,
  type BookCarrierExtra,
  type BookingVia,
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
  contextOf,
  loadTaxonomy,
  resolveForShipment,
  sameTag,
  tagFor,
  shipmentTagPatch,
  tagPatch,
  type OwnershipDeps,
  type ShipmentRecords,
  type ShipmentTag,
} from './ownershipResolve'
import { assertNotVoided, isVoided } from '../_shared/voided'
import { deleteShipments, latestDeleteExport, restoreDeleted } from './shipmentDelete'
import { shipmentDeleteStore } from './shipmentDeleteStore'
import { SHIPMENT_ACTIONS_TABLES } from './tableEnv'
import { parseTrackingPrefs, validateTrackingPrefsOverride, type TrackingPrefsOverride } from '../../../src/lib/trackingPrefs'
import {
  buildPostInvoiceEntry, cleanGuardedInput, diffSnapshots, isInvoicedOrder, isPostInvoiceGuarded, POST_INVOICE_ACTION,
  postInvoiceCleared, readChangeReason, REASON_REQUIRED_MESSAGE, snapshotOf, type PostInvoiceGuardedAction,
} from './postInvoice'
import { salesRepForDivision } from '../../../src/lib/divisionSalesRep'
import { LEAD_STAGES, promotionFor } from '../../../src/lib/crm/promote'
import { batchShipmentTask, BATCH_TASK_ACTIONS } from './batch'
import { INTAKE_ACTIONS, reconcileOpenIntake, runIntakeAction, type IntakeAction, type IntakeDeps } from './intake'
// ── Step P ──────────────────────────────────────────────────────────────────
// The demo flow's four shipment-side modules. Same bargain as the quote and
// document modules above: they are handed this file's clients, tables and
// bodies, so a posting, a build gate and a carrier offer all go through the
// same transaction, the same CAS and the same audit as everything else here.
import {
  checkBuildGate,
  completeBuild,
  type BuildGateDeps,
} from './buildGate'
import {
  listPostings,
  postLoad,
  unpostLoad,
  postQuoteLoad,
  unpostQuoteLoad,
  type PostingDeps,
} from './postings'
import { priceFromMarket, type MarketRateDeps } from './marketRate'
import { getLaneIntelligence, type LaneIntelDeps } from './laneIntel'
import {
  listCarrierOffers,
  recordCarrierOffer,
  sendCarrierSetupPacket,
  sendSetupPacket,
  type CarrierOfferDeps,
} from './carrierOffers'
import {
  fileInboundOffer,
  assignInboundOffer,
  dismissInboundOffer,
  SYSTEM_CALLER_EMAIL,
  type CarrierInboundDeps,
} from './carrierInbound'
import {
  getDemoState,
  resetDemoData,
  seedDemoData,
  type DemoDeps,
} from './demo'
// Step J decides stub-vs-live for a board and for RateView. The registry is plain
// data the Lambda bundles; the credentials are read from SSM and never stored here.
import { adapterFor } from '../../../src/lib/integrations/adapter'
import { mcpAdapter } from '../../../src/lib/integrations/mcpAdapter'
import { descriptorOf } from '../../../src/lib/integrations/registry'
import { modeOf } from '../../../src/lib/integrations/health'
import type { ProviderKey } from '../../../src/lib/integrations/types'
import { readPageCredentials } from '../_shared/integrationSecrets'

import {
  computeFinancials,
  isRateCode,
  type ChargeLineInput,
} from '../../../src/lib/shipmentCharges'
import { liveCarriersOf, type CarrierLike } from '../../../src/lib/carrierTotals'
import { validateCarrierAdd, validateLegs, type LegStop } from '../../../src/lib/carrierLegs'
import { billLinesFor, billMoneyLockReason, rateConLinesFor, rebilledMoney } from '../../../src/lib/carrierBill'
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
import { applyCoverRules, evaluateCarrierBooking } from '../../../src/lib/carrierEligibility'
import { quickPayFee, quickPayTiersOf, tierFor } from '../../../src/lib/quickPay'
import {
  outsideCarrierLoadPatch,
  ownFleetLoadPatch,
  uncoveredLoadPatch,
  type MirrorStop,
} from '../../../src/lib/loadMirror'
import {
  isCustomerUnresolved,
  unresolvedCustomerMessage,
  type CustomerResolvable,
} from '../../../src/lib/customerResolution'
import { holdDivision, topLevelOf } from '../../../src/lib/ownership'
import { normalizePro } from '../../../src/lib/proNumber'
import { backfillShipmentNumber, digitsOnlyPro } from '../../../src/lib/legacyShipmentNumber'
import type { CarrierBillRecord, LoadChargeRecord, ProScheme } from '../../../src/types/tms'
import {
  MAX_COUNTER_SKIPS,
  derivedLegPro,
  derivedProRefusal,
  formatShipmentNumber,
  numericSchemeSwitchError,
  proSchemeOf,
} from './proScheme'
import { customerDefaultsOf } from '../../../src/lib/intakeLoad'
import { evaluateReleaseGate, releaseGateError } from '../../../src/lib/releaseGate'
import { dedupeEmails, isEmailAddress } from '../../../src/lib/emailAddress'
import { composeRateConCc } from './rateConRecipients'
import { assertBolEmailable, bolEmailBody, bolEmailSubject, deliveryLabel, parseEmailBolInput } from './bolEmail'
import { MAX_GENERATED_BYTES, documentKey } from '../../../src/lib/shipmentDocuments'
import { getStops } from '../../../src/lib/stops'
import type { Load } from '../../../src/types'
import {
  advanceTarget, deriveAssignmentStatus, driverInfoGaps, isCarrierAssignmentStatus, ladderPatch, rungOf,
  type AssignmentFacts, type CarrierAssignmentStatus,
} from '../../../src/lib/carrierAssignment'
import {
  FROZEN_LOCKED_LOAD_KEYS,
  INVOICE_LOCKED_ORDER_KEYS,
  mergeSpecialRequirements,
  validateCarrierDetails,
  validateLoadFieldsV2,
  validateShipmentFlags,
  validateSpecialRequirementsV2,
  validateStopDetailsPatch,
  validateUpdateOrderDetails,
} from './orderForm'
import { loadReleaseGateInput } from '../_shared/releaseGateInput'
import {
  OWN_ASSET_MESSAGES,
  clearStopColors,
  distinctStopDrivers,
  driverProblem,
  evaluatePayLock,
  fillBlankStopDrivers,
  isOwnAssetLoad,
  ownAssetDriverGap,
  type OwnAssetLegFacts,
  type OwnAssetLoadFacts,
  type RosterDriverFacts,
} from '../../../src/lib/ownAssetDriver'
import { isIvanCartageName, resolveOwnFleetDriver, type OwnFleetDriverSource } from '../../../src/lib/ownFleetDrivers'
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
// Step AQ. Read-only, to fill an own-fleet driver's truck # and trailer # from Equipment. Optional: until
// backend.ts wires it (env + GetItem grant) unit numbers come only from what the caller sent.
const EQUIPMENT_TABLE_NAME = process.env.EQUIPMENT_TABLE_NAME ?? ''
// Step W. Read-only: ASSIGN_ASSET refuses to move a load that is already on a stored
// box-truck settlement (BoxTruckTrip.loadId), or the new driver could be paid for it twice.
const BOX_TRUCK_TRIP_TABLE_NAME = process.env.BOX_TRUCK_TRIP_TABLE_NAME ?? ''
const USER_POOL_ID = process.env.USER_POOL_ID ?? 'us-east-1_IbPKPNJC9'
// Step I. ASSIGN_CARRIER_REP and BATCH_SHIPMENT_TASK validate rep ids against real
// UserProfile rows. The table is owned by userManagement; this Lambda only reads it.
const USER_PROFILE_TABLE_NAME = process.env.USER_PROFILE_TABLE_NAME ?? ''
// Aljex-exit: the Aljex code -> user crosswalk (Settings > Users). Written only here.
const ALJEX_CODE_MAP_TABLE_NAME = process.env.ALJEX_CODE_MAP_TABLE_NAME ?? ''
// Step C tables. The carrier directory is written by tms-carrier-actions; this
// handler only reads it, and writes the booking counters back onto the row.
const CARRIER_TABLE_NAME = process.env.CARRIER_TABLE_NAME ?? ''
const CARRIER_DOCUMENT_TABLE_NAME = process.env.CARRIER_DOCUMENT_TABLE_NAME ?? ''
const BUCKET_NAME = process.env.BUCKET_NAME ?? ''
const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'notifications@bcatcorp.com'
const PORTAL_ORIGIN = process.env.PORTAL_ORIGIN ?? ''
// Step D tables. The tracking log is written here and by the projector, the public
// tracking Lambda and tms-tracking-actions; the link table is only read here, to
// revoke the carrier's ping link when the carrier comes off the load.
const LOAD_CHECK_CALL_TABLE_NAME = process.env.LOAD_CHECK_CALL_TABLE_NAME ?? ''
const TRACKING_LINK_TABLE_NAME = process.env.TRACKING_LINK_TABLE_NAME ?? ''
// Step E tables. The shipment's document index is written here and by the public
// upload portal; the two driver-app tables are read only, to point a shipment row
// at a POD whose bytes stay where the driver app put them.
const SHIPMENT_DOCUMENT_TABLE_NAME = process.env.SHIPMENT_DOCUMENT_TABLE_NAME ?? ''
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
// Step R tables, read only. The division tree and the ordered rules that decide
// which business earns a shipment are rows an admin edits from Divisions &
// ownership; `tms-directory-actions` writes them, this router only resolves against
// them and falls back to the seed rows while the tables are still empty.
const OWNERSHIP_DIVISION_TABLE_NAME = process.env.OWNERSHIP_DIVISION_TABLE_NAME ?? ''
const OWNERSHIP_RULE_TABLE_NAME = process.env.OWNERSHIP_RULE_TABLE_NAME ?? ''
// Step R cutover. One row per PRO ever issued, keyed by the normalized PRO. This
// Lambda is the only writer; a claim is never deleted, so a voided PRO stays issued.
const PRO_CLAIM_TABLE_NAME = process.env.PRO_CLAIM_TABLE_NAME ?? ''
// Step P tables. ShipmentPosting is written only here (POST_LOAD / UNPOST_LOAD).
// Integration is read to decide stub-vs-live for a board or RateView.
const SHIPMENT_POSTING_TABLE_NAME = process.env.SHIPMENT_POSTING_TABLE_NAME ?? ''
const INTEGRATION_TABLE_NAME = process.env.INTEGRATION_TABLE_NAME ?? ''
// Step P1/P11. DemoRecord is the seed's own index; ShipmentMessage is read only,
// for the demo checklist's thread count.
const DEMO_RECORD_TABLE_NAME = process.env.DEMO_RECORD_TABLE_NAME ?? ''
const SHIPMENT_MESSAGE_TABLE_NAME = process.env.SHIPMENT_MESSAGE_TABLE_NAME ?? ''
// Step U. IntakeLoad is staged by workflow-agent and changed only here (INTAKE_*).
const INTAKE_LOAD_TABLE_NAME = process.env.INTAKE_LOAD_TABLE_NAME ?? ''

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const SETTINGS_ID = 'default'
/** BCAT_DEV_STACK=true marks the long-lived dev branch stack. */
const IS_DEV_STACK = process.env.BCAT_DEV_STACK === 'true'

// Amplify derives GSI names from the plural model name and the key fields.
// The four the shipment bundle reads come from `_shared/shipmentStore`.
const IDX_LOADS_BY_CUSTOMER = 'loadsByCustomerId'
const IDX_ORDERS_BY_CUSTOMER = 'ordersByCustomerIdAndPickupAppt'
const IDX_CARRIERS_BY_LOAD = 'loadCarriersByLoadId'
const IDX_CARRIERS_BY_CARRIER_ID = 'loadCarriersByCarrierId'
const IDX_CARRIER_DOCS_BY_CARRIER = 'carrierDocumentsByCarrierIdAndType'
const IDX_CHECK_CALLS_BY_LOAD = 'loadCheckCallsByLoadIdAndAt'
const IDX_SHIPMENTS_BY_NUMBER = 'shipmentsByNumber'

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
const transact = (items: TransactWriteItem[], label: string, options?: TransactOptions) =>
  storeTransact(dynamo, items, label, options)
const readBundle = (shipmentId: string) => storeReadBundle(store, shipmentId)
const rederiveShipmentStatus = async (shipmentId: string, caller: Caller) => {
  const result = await storeRederiveShipmentStatus(store, shipmentId, caller)
  await autoPushToReview(shipmentId, caller)
  await reconcileOpenIntake(intakeDeps, shipmentId, caller)
  return result
}

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
  'SET_REFS', 'SET_LOCATION', 'SET_DETAILS',
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
  // Step U. A tender e-mail's partially built load: edit it, dismiss it, or move it to Active.
  | 'INTAKE_SAVE_DRAFT'
  | 'INTAKE_MOVE_TO_ACTIVE'
  | 'INTAKE_MARK_REVIEWED'
  | 'INTAKE_DISMISS'
  | 'INTAKE_LINK_SHIPMENT'
  | 'INTAKE_ATTACH_FILES'
  | 'INTAKE_DELETE'
  | 'INTAKE_NOT_DUPLICATE'
  | 'SAVE_ORDER_FORM'
  | 'CHECK_CREDIT'
  | 'SUBMIT_ORDER'
  | 'SET_SHIPMENT_STATUS'
  | 'SET_LOAD_STATUS'
  // Step R cutover. The two writes the one-record vocabulary needs: the customer a
  // shipment was never matched to, and the PRO a leg carries — `aljexId` is read-only
  // to every client token now, so this is the only way one ever changes.
  | 'SET_SHIPMENT_CUSTOMER'
  | 'SET_LOAD_PRO'
  // The TMS # and PU # a leg carries: read-only to client tokens (they fall back to the PRO), so this is how the calendar edits them.
  | 'SET_LOAD_REFS'
  // Per-stop drivers (unassign, a relay, a split): the calendar's picker. The load's pickup/delivery driver mirrors are written here, not by the client.
  | 'SET_STOP_DRIVERS'
  // Staff void; the owner alone may perform an exported hard delete or restore. PRO claims remain reserved.
  | 'VOID_SHIPMENT'
  | 'DELETE_SHIPMENTS'
  | 'RESTORE_DELETED_SHIPMENTS'
  | 'LATEST_DELETE_EXPORT'
  | 'UNVOID_SHIPMENT'
  | 'LOCK_SHIPMENT'
  | 'PUSH_READY_TO_LOAD_REVIEW'
  | 'UNLOCK_SHIPMENT'
  | 'REPOINT_SHIPMENT_CUSTOMER'
  // Step R. Who earns the shipment: the rules' answer, a person's answer, and the
  // two reads that let an admin see what the rules would say before they say it.
  | 'SET_REV_TAG'
  | 'CLEAR_REV_TAG'
  | 'RESOLVE_REV_TAG'
  | 'SET_SALES_REP'
  | 'LIST_ALJEX_CODES'
  | 'SET_ALJEX_CODE_MAP'
  | 'REASSIGN_SHIPMENTS_BY_REP_CODE'
  | 'ASSIGN_CARRIER_REP'
  | 'ASSIGN_TRACKER'
  | 'SET_TRACKING_PREFS'
  | 'BATCH_SHIPMENT_TASK'
  | 'TEST_OWNERSHIP_RULES'
  | 'RETAG_SHIPMENTS'
  | 'TENDER_RESPOND'
  | 'DUPLICATE_SHIPMENT'
  | 'UPDATE_STOP'
  | 'ASSIGN_ASSET'
  | 'ASSIGN_CARRIER'
  | 'BOOK_CARRIER'
  // AT-plan. Another outside carrier next to the live ones (up to four).
  | 'ADD_CARRIER'
  // Step AM. The cover flow and the assignment ladder it climbs.
  | 'COVER_CARRIER'
  | 'ENTER_DRIVER_INFO'
  | 'MARK_RATE_CON_SIGNED'
  | 'SET_QUICK_PAY'
  | 'SEND_RATE_CON'
  | 'GET_TRACKING_MAILBOX'
  | 'VOID_RATE_CON'
  | 'DISPATCH_LOAD'
  | 'REMOVE_LOAD_CARRIER'
  | 'RECALC_CHARGES'
  | 'UPDATE_CARRIER_CHARGES'
  | 'UPDATE_ORDER_DETAILS'
  | 'UPDATE_LOAD_CARRIER_DETAILS'
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
  // AU-plan. Mail a stored (plain) bill of lading through the shipment thread.
  | 'EMAIL_BOL'
  | 'ATTACH_DRIVER_DOC'
  // The invoice the accounting post generated, filed on its shipment as a document (system caller: tms-finance-actions).
  | 'ATTACH_INVOICE_DOC'
  | 'REVIEW_DOCUMENT'
  | 'UPDATE_DOCUMENT'
  | 'VOID_DOCUMENT'
  // Extra documents one load needs on top of the customer's list (POD / RC are defaults).
  | 'SET_LOAD_REQUIRED_DOCS'
  | 'READY_TO_INVOICE'
  | 'REVIEW_LOAD'
  // Released loads missing from AR or AP; read-only unless createMissingFor names an order.
  | 'RECONCILE_BILLING'
  | 'RATE_CARRIER'
  // Step H — the sell side of a quote, which is the quotes page's own work.
  | 'SAVE_QUOTE'
  | 'SEND_QUOTE'
  | 'COUNTER_QUOTE'
  | 'ACCEPT_COUNTER'
  | 'MARK_QUOTE_LOST'
  | 'MARK_QUOTE_WON'
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
  // Step I — the shipment half of the org defaults. Not quote work and not the
  // loads page's either: org defaults are an admin act in every router here.
  | 'SAVE_SHIPMENT_SETTINGS'
  // ── Step P — the end-to-end demo flow ──────────────────────────────────────
  // P5: the required-fields gate. P6: the load boards. P4: the market rate a
  // quote is priced from. P7: a carrier's answer to a posting. P1/P11: the seed.
  | 'CHECK_BUILD_GATE'
  | 'COMPLETE_BUILD'
  | 'POST_LOAD'
  | 'UNPOST_LOAD'
  | 'LIST_POSTINGS'
  | 'PRICE_FROM_MARKET'
  | 'LANE_INTELLIGENCE'
  | 'POST_QUOTE_LOAD'
  | 'UNPOST_QUOTE_LOAD'
  | 'RECORD_CARRIER_OFFER'
  | 'LIST_CARRIER_OFFERS'
  | 'SEND_SETUP_PACKET'
  | 'SEND_CARRIER_SETUP_PACKET'
  | 'GET_DEMO_STATE'
  | 'SEED_DEMO_DATA'
  | 'RESET_DEMO_DATA'
  | 'LIST_LOAD_CARRIERS_BY_CARRIER'
  // Step AL: inbound carrier offers (mail and calls). FILE is the carrier-inbox system caller's alone.
  | 'FILE_INBOUND_OFFER'
  | 'ASSIGN_INBOUND_OFFER'
  | 'DISMISS_INBOUND_OFFER'

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
  MARK_QUOTE_WON: true,
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
  // Step P7. A carrier's answer to a posting is a BUY-side quote like any other,
  // and the two desks that shop a lane are the two that may record one.
  RECORD_CARRIER_OFFER: true,
  LIST_CARRIER_OFFERS: true,
  SEND_SETUP_PACKET: true,
  SEND_CARRIER_SETUP_PACKET: true,
  // Step P4. Asking what the lane pays is quoting work and dispatch work alike;
  // it writes a price onto a quote only when that quote is still unsent.
  PRICE_FROM_MARKET: true,
  // Step AE. The Rate-intelligence panel's two history sections: bounded index reads, no writes.
  LANE_INTELLIGENCE: true,
  // Step AE. Push to DAT from a quote or spot request: the same board posting as POST_LOAD, with no shipment.
  POST_QUOTE_LOAD: true,
  UNPOST_QUOTE_LOAD: true,
  // Step AL. A rep assigns or dismisses an Unmatched inbound offer; FILE_INBOUND_OFFER is deliberately absent (system caller only).
  ASSIGN_INBOUND_OFFER: true,
  DISMISS_INBOUND_OFFER: true,
}

/**
 * Org defaults are an admin act in every router here.
 *
 * Reverting quote conversion remains owner/ADMIN work, independently of staff's
 * permission to void shipments.
 */
const QUOTE_ADMIN_ONLY_ACTIONS: Record<string, true> = { SAVE_QUOTE_SETTINGS: true, REVERT_TO_QUOTE: true }

/**
 * Step I. Admin-only actions that are not quote work. They are decided in their
 * own branch below, above the loads-page rule a dispatcher would otherwise pass:
 * the settings card lives on the loads page, the defaults behind it do not.
 *
 * Retagging and configuration remain admin-only. VOID_SHIPMENT follows shipment page grants.
 * Hard delete and restore have a stricter owner predicate ahead of the ADMIN bypass.
 */
const ADMIN_ONLY_ACTIONS: Record<string, true> = {
  INTAKE_DELETE: true,
  SAVE_SHIPMENT_SETTINGS: true,
  UNVOID_SHIPMENT: true,
  REPOINT_SHIPMENT_CUSTOMER: true,
  RESOLVE_REV_TAG: true,
  LIST_ALJEX_CODES: true,
  SET_ALJEX_CODE_MAP: true,
  REASSIGN_SHIPMENTS_BY_REP_CODE: true,
  RETAG_SHIPMENTS: true,
  // Step P11. Seeding and resetting the demo mints and voids freight wholesale.
  // Ryne's rule for the Reset button is owner/ADMIN and dev only; the second half
  // is enforced below, from the stack's own flag rather than from the token.
  SEED_DEMO_DATA: true,
  RESET_DEMO_DATA: true,
}

const QUOTES_PAGE_GROUP = 'page-quotes'
const LOADS_PAGE_GROUP = 'page-loads'
const LOAD_REVIEW_PAGE_GROUP = 'page-loadReview'
const LOAD_REVIEW_ACTIONS: Record<string, true> = { READY_TO_INVOICE: true, SET_SALES_REP: true, SET_REV_TAG: true, REVIEW_LOAD: true }
/** The AR and AP pages ask whether every released load reached them; their own page grants may ask. */
const BILLING_RECONCILE_GROUPS = ['page-invoicing', 'page-carrierPay', LOAD_REVIEW_PAGE_GROUP]
/**
 * Step R. The BROKERAGE section's one grant. The TMS merged the loads page, the
 * quotes page and the carrier-pay card into `/tms/*`, so a user who holds this key
 * reaches everything those three keys reached — nothing more.
 */
const TMS_PAGE_GROUP = 'page-tms'
/**
 * Step U. The intake reviewer is a page grant, deliberately narrower than "can open
 * Brokerage": `page-tms` and `page-loads` do not pass, owner/ADMIN and this group do.
 */
const INTAKE_REVIEW_PAGE_GROUP = 'page-intakeReview'
// INTAKE_DELETE is owner/ADMIN only (ADMIN_ONLY_ACTIONS), not a review-group action.
const INTAKE_REVIEW_ACTIONS: Record<string, true> = Object.fromEntries(INTAKE_ACTIONS.filter((a) => a !== 'INTAKE_DELETE').map((a) => [a, true]))

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
  /**
   * Set only by a Lambda that invoked this function directly (AppSync's envelope has no such
   * key), so only a principal holding lambda:InvokeFunction can send it. SYSTEM_CALLERS limits it.
   */
  systemCaller?: string
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

/**
 * Reusable authorization predicate. The batch action uses the strictest predicate
 * of its underlying task, so the same rule decides both a single-row call and a
 * batch row.
 */
function isActionAuthorized(action: Action, caller: Caller): boolean {
  if (action === 'DELETE_SHIPMENTS' || action === 'RESTORE_DELETED_SHIPMENTS' || action === 'LATEST_DELETE_EXPORT') return caller.email === OWNER_EMAIL
  if (caller.isAdmin) return true
  const groups = caller.groups
  const tms = groups.includes(TMS_PAGE_GROUP)
  if (QUOTE_ACTIONS[action]) {
    if (QUOTE_ADMIN_ONLY_ACTIONS[action]) return false
    return groups.includes(QUOTES_PAGE_GROUP) || tms
  }
  if (OFFER_ACTIONS[action]) {
    return groups.includes(LOADS_PAGE_GROUP) || groups.includes(QUOTES_PAGE_GROUP) || tms
  }
  // Whoever builds a shipment from an intake load can tie the two together: the link is the end of the build, not a review step.
  if (action === 'INTAKE_LINK_SHIPMENT' || action === 'INTAKE_ATTACH_FILES') return groups.includes(INTAKE_REVIEW_PAGE_GROUP) || groups.includes(LOADS_PAGE_GROUP) || tms
  if (INTAKE_REVIEW_ACTIONS[action]) return groups.includes(INTAKE_REVIEW_PAGE_GROUP)
  if (LOAD_REVIEW_ACTIONS[action]) return groups.includes(LOAD_REVIEW_PAGE_GROUP) || groups.includes(LOADS_PAGE_GROUP) || tms
  if (action === 'RECONCILE_BILLING') return BILLING_RECONCILE_GROUPS.some((g) => groups.includes(g)) || groups.includes(LOADS_PAGE_GROUP) || tms
  if (ADMIN_ONLY_ACTIONS[action]) return false
  if (action === 'UPDATE_CARRIER_CHARGES') {
    return groups.includes(LOADS_PAGE_GROUP) || tms || groups.includes('page-carrierPay')
  }
  return groups.includes(LOADS_PAGE_GROUP) || tms
}

/** Internal Lambdas that may call this router without a user, and the only actions they may call. */
export const SYSTEM_CALLERS: Record<string, readonly Action[]> = {
  'carrier-inbox': ['FILE_INBOUND_OFFER'],
  // A driver's finished POD upload files its pages on the shipment (waiting for review).
  'driver-app-api': ['ATTACH_DRIVER_DOC'],
  // A generated invoice's PDF is filed on its shipment as an INVOICE document.
  'finance-actions': ['ATTACH_INVOICE_DOC'],
  // A driver's "on site / departed / delivered" tap on the tracking link is filed as a stop event.
  'tracking-api': ['LOG_CHECK_CALL'],
}

export async function authorize(action: Action, identity?: AppSyncIdentity | null, systemCaller?: string | null): Promise<Caller> {
  if (
    typeof systemCaller === 'string' &&
    Object.prototype.hasOwnProperty.call(SYSTEM_CALLERS, systemCaller) &&
    SYSTEM_CALLERS[systemCaller]!.includes(action)
  ) {
    // Never admin: a system caller files inbound offers, nothing else.
    return { email: SYSTEM_CALLER_EMAIL, sub: systemCaller, groups: [], isAdmin: false }
  }
  if (action === 'FILE_INBOUND_OFFER') throw new Error('Forbidden: FILE_INBOUND_OFFER is for the carrier inbox only')
  if (action === 'ATTACH_INVOICE_DOC') throw new Error('Forbidden: ATTACH_INVOICE_DOC is for the finance Lambda only')
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)
  const caller: Caller = { email, sub: identity.sub, groups, isAdmin }
  if (!isActionAuthorized(action, caller)) {
    if (action === 'DELETE_SHIPMENTS' || action === 'RESTORE_DELETED_SHIPMENTS' || action === 'LATEST_DELETE_EXPORT') throw new Error(`Forbidden: ${action} requires the owner`)
    if (ADMIN_ONLY_ACTIONS[action] || QUOTE_ADMIN_ONLY_ACTIONS[action]) {
      throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
    }
    if (INTAKE_REVIEW_ACTIONS[action]) {
      throw new Error(`Forbidden: ${action} requires owner, ADMIN, or ${INTAKE_REVIEW_PAGE_GROUP}`)
    }
    if (LOAD_REVIEW_ACTIONS[action]) throw new Error(
      'Forbidden: ' + action + ' requires owner, ADMIN, page-loadReview, page-loads, or page-tms',
    )
    const tms = groups.includes(TMS_PAGE_GROUP)
    throw new Error(
      action === 'UPDATE_CARRIER_CHARGES'
        ? `Forbidden: ${action} requires owner, ADMIN, page-loads, ${TMS_PAGE_GROUP}, or page-carrierPay`
        : QUOTE_ACTIONS[action] && !tms
          ? `Forbidden: ${action} requires owner, ADMIN, ${QUOTES_PAGE_GROUP}, or ${TMS_PAGE_GROUP}`
          : OFFER_ACTIONS[action] && !tms
            ? `Forbidden: ${action} requires owner, ADMIN, ${LOADS_PAGE_GROUP}, ${QUOTES_PAGE_GROUP}, or ${TMS_PAGE_GROUP}`
            : `Forbidden: ${action} requires owner, ADMIN, page-loads, or ${TMS_PAGE_GROUP}`,
    )
  }
  return caller
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

/** The Shipment attributes LIST_ALJEX_CODES counts from (everything else on a ~190-field row is dead weight). */
const ALJEX_CODE_SHIPMENT_FIELDS = [
  'id', 'salesRepCode', 'salesRepId', 'createdByCode', 'serviceRepCode', 'dispatcherCode', 'voidedAt', 'deletedAt',
] as const

/**
 * Whole-table read as `totalSegments` parallel segmented scans, projecting only `fields`. A
 * sequential scan pays one round trip per 1 MB of stored rows; segments run side by side, which is
 * what an in-region Lambda can do and AppSync cannot. Same rows as `scanTable` (segments partition
 * the table), restricted to the projected attributes.
 */
async function scanTableSegmented(
  tableName: string,
  fields: readonly string[],
  totalSegments = 8,
): Promise<Row[]> {
  if (!tableName) throw new Error('Table name is not configured')
  const names: Record<string, string> = {}
  fields.forEach((f, i) => { names[`#f${i}`] = f })
  const projection = Object.keys(names).join(', ')
  const segment = async (index: number): Promise<Row[]> => {
    const items: Row[] = []
    let lastKey: Record<string, AttributeValue> | undefined
    do {
      const result = await dynamo.send(new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
        Segment: index,
        TotalSegments: totalSegments,
        ProjectionExpression: projection,
        ExpressionAttributeNames: names,
      }))
      if (result.Items) items.push(...result.Items.map((i) => unmarshall(i)))
      lastKey = result.LastEvaluatedKey
    } while (lastKey)
    return items
  }
  const parts = await Promise.all(Array.from({ length: totalSegments }, (_, i) => segment(i)))
  return parts.flat()
}

/**
 * A rep id is a Cognito username. Before a shipment field points at one, confirm
 * the row exists — clearing with null is always allowed.
 */
async function assertRepProfile(repId: string | null, label: string): Promise<void> {
  if (repId == null || repId === '') return
  const profile = await getById(USER_PROFILE_TABLE_NAME, repId)
  if (!profile) throw new Error(`${label} is not a user profile: ${repId}`)
}

/**
 * The profile id when it names an ACTIVE user, else null. Inheritance of a customer's
 * default tracker never fails a create on a stale or deleted profile.
 */
async function activeProfileIdOrNull(value: unknown): Promise<string | null> {
  const id = optionalString(value, 100)
  if (!id) return null
  try {
    const profile = await getById(USER_PROFILE_TABLE_NAME, id)
    return profile && profile.status !== 'INACTIVE' ? id : null
  } catch (err) {
    console.warn('[tms-shipment-actions] tracker profile lookup failed:', String(err))
    return null
  }
}

/** Carrier rep assignment also checks the role, because coverage is its own desk. */
async function assertCarrierRepProfile(repId: string | null): Promise<void> {
  if (repId == null || repId === '') return
  const profile = await getById(USER_PROFILE_TABLE_NAME, repId)
  if (!profile) throw new Error(`Carrier rep is not a user profile: ${repId}`)
  if (profile.role !== 'CARRIER_REP') {
    throw new Error(`${repId} is not a carrier rep`)
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
    arrivedSource: optionalEnum(s.arrivedSource, STOP_TIME_SOURCES, `stops[${index}].arrivedSource`),
    departedSource: optionalEnum(s.departedSource, STOP_TIME_SOURCES, `stops[${index}].departedSource`),
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
    // Step AH: the form's opening hours ride on the contact. The key exists only
    // when the caller sent it, so a contact without hours stays the shape it was.
    ...(c.hours !== undefined ? { hours: optionalString(c.hours, 120) } : {}),
  }
}

/**
 * SET_LOCATION replaces a stop's contact wholesale; the hours the form stored on it
 * survive a caller (the detail's stop card) that never sends them. An explicit null
 * or empty `hours` clears them.
 */
function replaceContact(value: unknown, previous: unknown, label: string): Row {
  const next = validateContact(value, label)
  if ('hours' in next) return next
  const kept = optionalString((previous as Row | null | undefined)?.hours, 120)
  return kept ? { ...next, hours: kept } : next
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
    loadCarrierId: c.loadCarrierId,
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

/**
 * Step AB §5.5 (Ryne R8). The gate on building freight: a prospect (lead stage) becomes an
 * ACTIVE customer on its first shipment, then the unchanged ACTIVE check and the caller's credit
 * gate run. The promotion ignores `requireCustomerApproval` (the first booked shipment is the
 * approval signal) and is KEPT if the shipment creation later fails. PENDING, BLOCKED, CLOSED and
 * DORMANT are never promoted and get the existing refusal text.
 */
async function getBookableCustomer(customerId: string, caller: Caller, via: BookingVia): Promise<Row> {
  const customer = await getById(CUSTOMER_TABLE_NAME, customerId)
  if (customer && !customer.mergedIntoId && promotionFor(optionalString(customer.status, 40)) === 'PROMOTE') {
    const from = String(customer.status)
    const now = nowIso()
    try {
      await dynamo.send(new UpdateItemCommand({
        TableName: CUSTOMER_TABLE_NAME,
        Key: marshall({ id: customerId }),
        UpdateExpression:
          'SET #status = :active, active = :true, statusReason = :reason, statusChangedAt = :now, statusChangedBy = :by, updatedAt = :now, updatedBy = :by',
        ConditionExpression: `attribute_exists(id) AND #status IN (${LEAD_STAGES.map((_, i) => `:lead${i}`).join(', ')})`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':active': 'ACTIVE',
          ':true': true,
          ':reason': 'FIRST_SHIPMENT',
          ':now': now,
          ':by': caller.email,
          ...Object.fromEntries(LEAD_STAGES.map((stage, i) => [`:lead${i}`, stage])),
        }),
      }))
      await writeAudit('CUSTOMER', customerId, 'PROMOTE_PROSPECT', caller, { from, via })
    } catch (err) {
      // Someone moved the stage first; the re-read below decides on whatever it is now.
      if (!isConflict(err)) throw err
    }
  }
  return getActiveCustomer(customerId)
}

/**
 * Step R cutover. A shipment or order may legitimately point at no customer record
 * at all, so every read of one takes an explicit branch.
 *
 * `String(shipment.customerId)` on an unresolved row is the literal 'null' or
 * 'undefined', and that string used to reach the customer table and come back
 * `Customer not found: undefined` — the failure this whole cutover exists to remove.
 * `isCustomerUnresolved` is the one predicate the board, the detail header and every
 * gate share, so the answer here is the answer the operator was already looking at.
 */
async function customerOf(row: Row): Promise<Row | null> {
  const id = optionalString(row.customerId, 100)
  return id ? getById(CUSTOMER_TABLE_NAME, id) : null
}

/** The same, through the ACTIVE check, for the paths that price against a customer. */
async function activeCustomerOf(row: Row): Promise<Row | null> {
  const id = optionalString(row.customerId, 100)
  return id ? getActiveCustomer(id) : null
}

/**
 * The refusal an action owes the operator when it needs a customer record and the
 * shipment has none. Run BEFORE every other check in the actions that cannot
 * proceed without one — and never instead of the release gate, which still runs on
 * its own afterwards.
 */
function assertCustomerResolved(row: Row, what: string): void {
  if (isCustomerUnresolved(row as unknown as CustomerResolvable)) {
    throw new Error(unresolvedCustomerMessage(row as unknown as CustomerResolvable, what))
  }
}

/** The customer record behind a row, refusing first when there is none to find. */
async function requireCustomer(row: Row, what: string): Promise<Row> {
  assertCustomerResolved(row, what)
  return getActiveCustomer(String(row.customerId))
}

function marginFloorBpsOf(settings: Row | null): number {
  return numberOrNull(settings?.marginFloorBps) ?? 0
}

/**
 * The next shipment number, taken with an atomic ADD so two dispatchers building
 * loads in the same second cannot land on the same one.
 *
 * Under the NUMERIC scheme (Aljex-exit DECIDED-1) the number is the plain counter and it IS the
 * PRO, so a counter value somebody already claimed (an import above the seed, a typed PRO) is
 * skipped by ADDing again rather than failing the create after the number was spent.
 */
async function nextShipmentNumber(caller: Caller): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
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
    if (proSchemeOf(settings) === 'NUMERIC') {
      const key = normalizePro(String(counter))
      if (key && (await getById(PRO_CLAIM_TABLE_NAME, key))) {
        if (attempt >= MAX_COUNTER_SKIPS) {
          throw new Error(`The next ${MAX_COUNTER_SKIPS} PRO numbers are already claimed; raise the shipment counter past them in settings`)
        }
        continue
      }
    }
    return formatShipmentNumber(settings, counter)
  }
}

// ── The PRO claim (step R cutover) ───────────────────────────────────────────

/**
 * A PRO is permanent and is never issued twice. The rule lives in a `ProClaim`
 * row whose id IS the normalized PRO, claimed with a conditional put inside the
 * very transaction that writes the Shipment — a read-then-write across two Lambda
 * invocations has no mutual exclusion, and a GSI on `Load.aljexId` could not answer
 * the question anyway: the live table stores PROs padded ('14547  ') and an index
 * read is eventually consistent besides.
 *
 * A claim is NEVER released. Not when a create rolls back, not when the shipment is
 * voided. That is the whole of Ryne's rule, enforced where it cannot be bypassed.
 */
type ProClaimOrigin = 'CREATE' | 'DUPLICATE' | 'BACKFILL' | 'SET_LOAD_PRO'

/**
 * The PRO as a claim key, or a refusal. `normalizePro` answers null for blank,
 * 'N/A' and anything under three characters: a PRO nobody can claim is a PRO
 * nobody may be issued, because the next person to type the same non-answer would
 * collide with it silently.
 */
function proClaimKey(pro: string): string {
  const key = normalizePro(pro)
  if (!key) {
    throw new Error(`“${pro.trim()}” is not a PRO number — it needs at least three letters or digits`)
  }
  return key
}

function proClaimPut(
  pro: string,
  spec: { loadId: string; shipmentId?: string | null; claimedBy: string; origin: ProClaimOrigin },
): TransactWriteItem {
  const now = nowIso()
  return putItem(PRO_CLAIM_TABLE_NAME, {
    id: proClaimKey(pro),
    __typename: 'ProClaim',
    loadId: spec.loadId,
    shipmentId: spec.shipmentId ?? undefined,
    claimedAt: now,
    claimedBy: spec.claimedBy,
    origin: spec.origin,
    createdAt: now,
    updatedAt: now,
  })
}

/** What the conditional put means when it fails: somebody already owns this PRO. */
function proAlreadyIssuedMessage(pro: string): string {
  return `PRO ${normalizePro(pro) ?? pro.trim()} has already been issued. A PRO is never reused — voiding the shipment it is on does not release it.`
}

/** The highest all-digit PRO anybody holds a claim on, or null. Rare admin read: scans ProClaim ids only. */
async function maxClaimedNumericPro(): Promise<number | null> {
  let max: number | null = null
  let lastKey: Record<string, AttributeValue> | undefined
  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: PRO_CLAIM_TABLE_NAME,
      ProjectionExpression: 'id',
      ExclusiveStartKey: lastKey,
    }))
    for (const item of result.Items ?? []) {
      const id = unmarshall(item).id
      if (typeof id === 'string' && /^\d{3,15}$/.test(id)) max = Math.max(max ?? 0, Number(id))
    }
    lastKey = result.LastEvaluatedKey
  } while (lastKey)
  return max
}

/**
 * A typed PRO that looks like one the counter hands out — `S000123-1` — is refused.
 * Claiming it would pre-empt the counter: the create that eventually reaches that
 * number would fail at Load create, and the number it burned is gone for good.
 *
 * Both spellings are tested, because the claim key is the NORMALIZED PRO: the derived
 * `S000123-1` is owned under `S0001231`, so typing `S0001231`, `S000123 - 1` or
 * `S000123/1` would claim exactly the key the counter is walking toward. Only the raw
 * shape can name the dashed form in the message, so it is kept as well.
 */
function assertNotDerivedPro(pro: string, settings: Row | null): void {
  const refusal = derivedProRefusal(pro, settings, numberOrNull(settings?.nextShipmentNumber), normalizePro(pro))
  if (refusal) throw new Error(refusal)
}

/**
 * Step I. The shipment half of `TmsSettings`, patched the way the quotes half is
 * (`quotes.ts:1566`): every field is optional, `'field' in input` decides whether
 * it moves, and the counter may only ever rise — lowering it points the next
 * shipment at a number that already exists, whose Put is then refused.
 */
async function saveShipmentSettings(input: Row, caller: Caller): Promise<Row> {
  const settings = await getSettings()
  const patch: Row = {}

  if ('shipmentPrefix' in input) {
    const prefix = optionalString(input.shipmentPrefix)
    if (prefix != null && (prefix.length > 8 || !/^[A-Z0-9-]+$/.test(prefix))) {
      throw new Error('A shipment prefix is up to 8 letters, numbers or dashes')
    }
    patch.shipmentPrefix = prefix
  }
  if ('nextShipmentNumber' in input) {
    const next = optionalInteger(input.nextShipmentNumber, { min: 0, label: 'nextShipmentNumber' })
    const current = numberOrNull(settings?.nextShipmentNumber) ?? 0
    if (next != null && next < current) {
      throw new Error(`The shipment counter is at ${current} and can only go forward`)
    }
    if (next != null) patch.nextShipmentNumber = next
  }
  if ('proScheme' in input) {
    const scheme = optionalEnum(input.proScheme, ['DERIVED', 'NUMERIC'] as const, 'proScheme')
    if (scheme == null) throw new Error('proScheme must be DERIVED or NUMERIC')
    if (scheme === 'NUMERIC' && proSchemeOf(settings) !== 'NUMERIC') {
      // The counter walks forward from here, so it has to clear every numeric PRO already claimed.
      const effective = (patch.nextShipmentNumber as number | undefined) ?? numberOrNull(settings?.nextShipmentNumber)
      const switchError = numericSchemeSwitchError(effective, await maxClaimedNumericPro())
      if (switchError) throw new Error(switchError)
    }
    patch.proScheme = scheme
  }
  if ('cancelDeleteAdminOnly' in input) patch.cancelDeleteAdminOnly = optionalBoolean(input.cancelDeleteAdminOnly)
  if ('defaultMode' in input) patch.defaultMode = optionalEnum(input.defaultMode, SHIPMENT_MODES, 'defaultMode')
  if ('arUnbilledStage' in input) patch.arUnbilledStage = optionalString(input.arUnbilledStage, 60)
  if ('apInReviewStage' in input) patch.apInReviewStage = optionalString(input.apInReviewStage, 60)
  if (Object.keys(patch).length === 0) throw new Error('Nothing to save')

  // The settings singleton is created by the directory router; here it is patched,
  // seeding `__typename` the way every counter write on this row already does.
  const names: Record<string, string> = { '#tn': '__typename' }
  const values: Record<string, AttributeValue> = { ':tn': { S: 'TmsSettings' } }
  const sets = ['#tn = if_not_exists(#tn, :tn)']
  for (const [key, value] of Object.entries({ ...patch, updatedBy: caller.email, updatedAt: nowIso() })) {
    names[`#${key}`] = key
    values[`:${key}`] = marshallRow({ [key]: value })[key]
    sets.push(`#${key} = :${key}`)
  }
  await dynamo.send(
    new UpdateItemCommand({
      TableName: SETTINGS_TABLE_NAME,
      Key: marshall({ id: SETTINGS_ID }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  )
  await writeAudit('TMS_SETTINGS', SETTINGS_ID, 'SAVE_SHIPMENT_SETTINGS', caller, patch)
  return { settings: await getById(SETTINGS_TABLE_NAME, SETTINGS_ID) } as unknown as Row
}

// ── Load row construction ────────────────────────────────────────────────────

interface NewLoadSpec {
  /** `TmsSettings.proScheme` when the shipment number was minted; absent = DERIVED. */
  proScheme?: ProScheme
  id: string
  shipmentId: string
  orderId: string
  shipmentNumber: string
  leg: number
  /**
   * Absent when the shipment's customer is not resolved to a record yet. The key is
   * then left off the row entirely rather than written null: `customerId` is the hash
   * key of Load's customer index, and a NULL there is a write DynamoDB refuses — which
   * would strand the shipment transaction that already committed a moment earlier.
   */
  customerId?: string
  customerName: string | null
  /** The PRO this leg is issued under. Absent derives `<shipmentNumber>-<leg>`. */
  pro?: string | null
  /** The PO the legacy entrypoint already carries; falls back to the PRO when blank. */
  tmsId?: string | null
  pickupNumber?: string | null
  stops: StopShape[]
  rateCents: number
  equipmentType: string | null
  divisionKey: string | null
  carrierRepId: string | null
  status: LoadWorkflowStatus
}

function buildLoadInput(spec: NewLoadSpec, caller: Caller): Row {
  const loadNumber = derivedLegPro({ proScheme: spec.proScheme }, spec.shipmentNumber, spec.leg)
  const legacy = deriveLegacyFields(spec.stops)
  const now = nowIso()
  // The legacy identity columns are required and are read all over the own-fleet
  // pages. A shipment-born leg names itself after itself; one born from a PRO the
  // office already says out loud keeps that PRO, and keeps whatever PO the bag
  // carried — the factoring builder puts it in `tmsId` and the driver app reports
  // it as `pickupNumber`, so overwriting either with the PRO loses the PO.
  const aljexId = (spec.pro ?? '').trim() || loadNumber
  return {
    id: spec.id,
    aljexId,
    tmsId: (spec.tmsId ?? '').trim() || aljexId,
    pickupNumber: (spec.pickupNumber ?? '').trim() || aljexId,
    readyToInvoice: false,
    customer: spec.customerName,
    ...(spec.customerId ? { customerId: spec.customerId } : {}),
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

/**
 * Where a shipment came from — every value `Shipment.source` lists in `resource.ts`.
 * `Shipment.source` already listed TENDER; nothing produced one until Step K's tender
 * agent, so the create door now accepts it.
 */
const CREATE_SOURCES = ['MANUAL', 'DUPLICATE', 'FACTORING', 'BACKFILL', 'TENDER'] as const

/**
 * The rate code a customer's linehaul is carried on, everywhere in this router:
 * the carrier side of BOOK_CARRIER, the backfill's imported money, and the
 * customer's own default charges all name it.
 */
const LINEHAUL_CODE = 'LINEHAUL'

/**
 * Keys a leg bag may never carry, because none of them describe freight — they are
 * the shipment's own state, decided here or by the gate.
 *
 * `loadFromFactoringItem` sets `readyToInvoice: true` on every row it builds
 * (`src/features/factoring/loadFromInvoice.ts:37`), and honouring that would walk a
 * brand-new leg straight past `evaluateReleaseGate` into AR. They are refused rather
 * than dropped quietly: a caller that sent one believes it took effect.
 */
const LOAD_BAG_REFUSED: readonly string[] = [
  'readyToInvoice', 'status', 'shipmentId', 'orderId', 'leg', 'loadNumber', 'voidedAt',
  'revDivision', 'revSubdivision',
]

interface LoadBag {
  stops: StopShape[]
  /** The customer's money for this leg, priced as a charge line and never as `Load.rate`. */
  rateCents: number | null
  /** The PO the entrypoint already owns; blank falls back to the PRO on the row. */
  tmsId: string | null
  pickupNumber: string | null
  equipmentType: string | null
  miles: number | null
  weightLbs: number | null
  /** The whitelisted Load columns the caller actually named, validated and nothing else. */
  columns: Row
}

/**
 * The leg bag as a strict whitelist. A key that is neither accepted nor refused is
 * ignored: the legacy builders carry rows shaped like the whole Load model, and most
 * of that model is state this router owns.
 */
function validateLoadBag(raw: unknown): LoadBag {
  const bag = assertRecord(raw ?? {}, 'load')
  for (const key of LOAD_BAG_REFUSED) {
    if (key in bag) {
      throw new Error(`load.${key} belongs to the shipment's own state and cannot be set when it is created`)
    }
  }
  // A leg can be raised half-planned — the calendar opens one with a pickup and no
  // delivery all day — so only the order of the stops that are there is checked.
  const stops = bag.stops == null ? [] : resequence(assertArrayOf(bag.stops, 'load.stops', validateStop))
  assertStopShape(stops, false)

  const miles = optionalInteger(bag.miles, { min: 0, label: 'load.miles' })
  const weightLbs = optionalInteger(bag.weight, { min: 0, label: 'load.weight' })
  const columns: Row = {}
  const take = (key: string, value: unknown): void => {
    if (key in bag) columns[key] = value
  }
  take('pickupAppt', optionalIso(bag.pickupAppt, 'load.pickupAppt') ?? '')
  take('pickupApptEnd', optionalIso(bag.pickupApptEnd, 'load.pickupApptEnd'))
  take('pickupApptType', optionalString(bag.pickupApptType, 40))
  take('deliveryAppt', optionalIso(bag.deliveryAppt, 'load.deliveryAppt') ?? '')
  take('deliveryApptEnd', optionalIso(bag.deliveryApptEnd, 'load.deliveryApptEnd'))
  take('deliveryApptType', optionalString(bag.deliveryApptType, 40))
  take('originName', optionalString(bag.originName, 200))
  take('originCity', optionalString(bag.originCity, 120))
  take('destinationName', optionalString(bag.destinationName, 200))
  take('destinationCity', optionalString(bag.destinationCity, 120))
  take('pickupDriverId', optionalString(bag.pickupDriverId, 100))
  take('deliveryDriverId', optionalString(bag.deliveryDriverId, 100))
  take('truckId', optionalString(bag.truckId, 100))
  take('commodity', optionalString(bag.commodity, 200))
  take('weight', weightLbs)
  take('pieces', optionalInteger(bag.pieces, { min: 0, label: 'load.pieces' }))
  take('piecesUnit', optionalString(bag.piecesUnit, 40))
  take('cargoValueCents', optionalInteger(bag.cargoValueCents, { min: 0, label: 'load.cargoValueCents' }))
  take('miles', miles)
  take('notes', optionalString(bag.notes, 8000))
  take('hot', optionalBoolean(bag.hot))
  take('unscheduled', optionalBoolean(bag.unscheduled))
  // Stops outrank the flat mirrors whenever there are any: `deriveLegacyFields` is
  // what every other write in this router derives them with, and a bag that carries
  // both a stop list and a loose `pickupAppt` is one record disagreeing with itself.
  Object.assign(columns, deriveLegacyFields(stops))

  return {
    stops,
    rateCents: optionalInteger(bag.rateCents, { min: 0, label: 'load.rateCents' }),
    tmsId: optionalString(bag.tmsId, 120),
    pickupNumber: optionalString(bag.pickupNumber, 120),
    equipmentType: optionalString(bag.equipmentType, 80),
    miles,
    weightLbs,
    columns,
  }
}

/**
 * The leg's money as a CUSTOMER linehaul line.
 *
 * Never as a raw `Load.rate`: `buildLoadInput` derives `rate` from the priced totals
 * and the drawer itself documents that writing `rate` on a shipment-born load desyncs
 * `Order.revenueCents` and `LoadFinancials` (`LoadDrawer.tsx:1612`). Applied literally
 * the factoring amount would vanish from the shipment, leaving a $0 order under a $X
 * load. So it goes through the same `priceFor` every other charge does — overwriting
 * the customer's own default linehaul when they have one rather than adding a second.
 */
function withCustomerRate(
  charges: ChargeInput[],
  rateCents: number | null,
  rules: Record<string, ChargeCodeRules>,
): ChargeInput[] {
  if (rateCents == null) return charges
  const existing = charges.findIndex((c) => c.side === 'CUSTOMER' && c.code === LINEHAUL_CODE)
  // FLAT whichever branch runs, and never the customer's default basis. The rate on
  // the bag is a total somebody already invoiced — a $2,500 factoring amount — and a
  // customer whose LINEHAUL default is PER_MILE would turn it into $2,500 a mile on
  // the order, the financials and the `Load.rate` mirror. The drawer's own bridge
  // forces the same thing for the same reason (`loadRateSync.ts:41`).
  if (existing >= 0) {
    return charges.map((c, i) => (i === existing ? { ...c, calculatedBy: 'FLAT', rateCents, count: 1 } : c))
  }
  return [
    ...charges,
    {
      id: null,
      side: 'CUSTOMER',
      code: LINEHAUL_CODE,
      label: rules[LINEHAUL_CODE]?.label ?? 'Linehaul',
      calculatedBy: 'FLAT',
      rateCents,
      count: 1,
      isRate: true,
      release: null,
      sortOrder: charges.length,
      note: null,
      loadId: null,
      loadCarrierId: null,
    },
  ]
}

/**
 * The one door freight comes in through.
 *
 * A caller names either the customer RECORD it sells to or the customer TEXT an
 * operator typed, never both and never neither. The text path asks no customer
 * table and runs no credit check: there is no record to ask, and refusing to record
 * the freight at all is the hole this cutover closes. No Customer is ever created
 * and no name is ever invented.
 */
async function createShipment(input: Row, caller: Caller): Promise<Row> {
  const customerId = optionalString(input.customerId, 100)
  const typedCustomerName = optionalString(input.customerName, 200)
  if ((customerId == null) === (typedCustomerName == null)) {
    throw new Error(
      'A shipment needs exactly one of customerId — the customer record it sells to — or customerName, the text that was typed',
    )
  }

  const settings = await getSettings()
  const customer = customerId ? await getBookableCustomer(customerId, caller, 'CREATE_SHIPMENT') : null
  if (customer) {
    // A customer who may not ship on open credit needs an approved limit before
    // anybody starts building, not at the moment they try to submit.
    const policy = resolveCreditPolicy(customer as unknown as CustomerRecord, settings as unknown as TmsSettingsRecord | null)
    if (policy.freeCreditRequired && policy.creditLimitCents == null) {
      throw new Error(`${String(customer.name ?? customerId)} requires an approved credit limit before an order can be built`)
    }
  }

  const quoting = customer?.quotingDefaults
  const customerMode =
    quoting != null && typeof quoting === 'object' && 'defaultMode' in quoting ? quoting.defaultMode : null
  const mode =
    optionalEnum(input.mode, SHIPMENT_MODES, 'mode') ??
    optionalEnum(customerMode, SHIPMENT_MODES, 'customer.quotingDefaults.defaultMode') ??
    optionalEnum(settings?.defaultMode, SHIPMENT_MODES, 'settings.defaultMode') ??
    'FTL'
  const source = optionalEnum(input.source, CREATE_SOURCES, 'source') ?? 'MANUAL'
  // The run a person applied to get here. It is a back-reference, not a decision:
  // the agent proposed, this caller's own identity is what created the freight.
  const workflowRunId = optionalString(input.workflowRunId, 120)
  const bag = validateLoadBag(input.load)

  const suppliedPro = optionalString(input.pro, 120)
  if (suppliedPro) {
    assertNotDerivedPro(suppliedPro, settings)
    // A courtesy read, not the rule: the conditional put below is what actually
    // decides. Without it a dispatcher who retypes an issued PRO burns a shipment
    // number on every attempt, because the counter moves before the transaction runs.
    if (await getById(PRO_CLAIM_TABLE_NAME, proClaimKey(suppliedPro))) {
      throw new Error(proAlreadyIssuedMessage(suppliedPro))
    }
  }

  const number = await nextShipmentNumber(caller)
  const shipmentId = `shp-${randomUUID()}`
  const orderId = `ord-${randomUUID()}`
  const loadId = `lod-${randomUUID()}`
  const now = nowIso()
  // Both kinds of PRO are claimed. A typed one can never collide with a future
  // derived one, and a derived one can never be retyped onto another leg later.
  const pro = suppliedPro ?? derivedLegPro(settings, number, 1)

  const rules = chargeCodeRules(settings, customer)
  const charges = withCustomerRate(defaultChargesFor(customer, rules), bag.rateCents, rules)
  const { amounts, totals } = priceFor(
    charges,
    { miles: bag.miles, weightLbs: bag.weightLbs },
    pricingDefaultsOf(customer),
    marginFloorBpsOf(settings),
  )

  // Step R. The board reads one row per shipment, so the leg's dates and cities are
  // mirrored up here the way `duplicateShipment` and the backfill mirror theirs.
  // Without them the row misses the pickupMonth index the month-sliced views query,
  // and the pickup, delivery, origin and destination columns come back blank — which
  // the 'Unlinked load' row this create replaced did not do.
  const leg: Row = { stops: JSON.stringify(bag.stops) }
  const stopMirrors: Row = bag.stops.length > 0 ? shipmentMirrors([leg]) : {}
  // `?? undefined` and never '' or null: `pickupMonth` is a GSI hash key and
  // `deriveLegacyFields` writes '' for an undated stop, which DynamoDB refuses — it
  // would take the whole transaction down. An undated leg simply leaves the index.
  const pickupAppt = optionalString(stopMirrors.pickupAppt, 64) ?? optionalString(bag.columns.pickupAppt, 64) ?? undefined
  const deliveryAppt = optionalString(stopMirrors.deliveryAppt, 64) ?? optionalString(bag.columns.deliveryAppt, 64) ?? undefined
  const mirrors: Row = {
    pickupAppt,
    deliveryAppt,
    pickupMonth: monthOf(pickupAppt) ?? undefined,
    originCity: optionalString(stopMirrors.originCity, 120) ?? optionalString(bag.columns.originCity, 120) ?? undefined,
    destinationCity:
      optionalString(stopMirrors.destinationCity, 120) ?? optionalString(bag.columns.destinationCity, 120) ?? undefined,
  }

  const customerName = customer ? optionalString(customer.name, 200) : typedCustomerName
  const defaults = customerDefaultsOf(customer)
  const salesRepId = optionalString(defaults.salesRepId, 100)
  const trackerId = await activeProfileIdOrNull(customer?.defaultTrackerId)
  const shipment: Row = {
    id: shipmentId,
    __typename: 'Shipment',
    number,
    // A tender is freight somebody else offered us: it waits for an accept or a
    // reject (`TENDER_RESPOND`) rather than sitting in a dispatcher's drafts. Every
    // other source still opens as a draft, and `previousStatus` stays null either
    // way — nothing preceded a brand-new row.
    status: source === 'TENDER' ? 'TENDER_PENDING' : 'DRAFT',
    previousStatus: null,
    statusChangedAt: now,
    statusChangedBy: caller.email,
    // Written `?? undefined` and never null: `customerId` is the hash key of a sparse
    // index, and `marshallRow` keeps a null as a DynamoDB NULL, which the index
    // refuses outright (the `apOpen` precedent below). An unresolved shipment simply
    // leaves the customer index, which is right for a row that belongs to no customer.
    customerId: customerId ?? undefined,
    customerName,
    mode,
    parentShipmentId: null,
    orderIds: [orderId],
    loadIds: [loadId],
    ...mirrors,
    source,
    // Step R. The rep who sells the freight, mirrored onto the Load below and kept
    // in step by SET_SALES_REP. The order carries the same id as `customerRepId`.
    salesRepId,
    trackerId,
    workflowRunId,
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
    customerId: customerId ?? undefined,
    customerName,
    customerContactId: null,
    customerRepId: salesRepId,
    billToId: defaults.billToId,
    costCenter: null,
    mode,
    rateType: 'SPOT',
    references: [],
    equipmentType: bag.equipmentType,
    equipmentLengthFt: null,
    specialRequirements: null,
    freight: [],
    customerNotes: null,
    internalNotes: null,
    customerRateCents: totals.customerRateCents,
    revenueCents: totals.revenueCents,
    // Factoring is money OTR has already bought: the Aljex invoice went out before
    // the PRO was ever entered here. LEGACY is the rung that exists for exactly that
    // (`resource.ts` Order.arStatus); DOCS_NEEDED would put a collected bill back
    // into the AR worklist and into the customer's credit exposure.
    arStatus: source === 'FACTORING' ? 'LEGACY' : 'DOCS_NEEDED',
    arStatusChangedAt: now,
    invoiceId: null,
    invoiceEarly: false,
    readyToInvoiceAt: null,
    // The order carries the pickup the AR views sort and age by, same as duplicate's.
    pickupAppt,
    createdBy: caller.email,
    updatedBy: caller.email,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }

  // Built once both rows exist, so the cities and every reference on them are in it,
  // which is what the board's one search box queries.
  shipment.searchKey = buildSearchKey(shipment, [order], [leg])

  const chargeRows = charges.map((c, i) =>
    chargeRow(c, amounts[i], { shipmentId, orderId, loadId }, caller),
  )

  await transact(
    [
      // The claim is first so the cancellation reason maps back to it by index, and
      // it is in THIS transaction so two dispatchers creating the same PRO in the
      // same second cannot both win.
      proClaimPut(pro, { loadId, shipmentId, claimedBy: caller.email, origin: 'CREATE' }),
      putItem(SHIPMENT_TABLE_NAME, shipment),
      putItem(ORDER_TABLE_NAME, order),
      putItem(LOAD_FINANCIALS_TABLE_NAME, financialsRow(loadId, shipmentId, orderId, totals, 1, caller, null)),
      ...chargeRows.map((row) => putItem(LOAD_CHARGE_TABLE_NAME, row)),
    ],
    'shipment',
    { refusals: [proAlreadyIssuedMessage(pro)] },
  )

  const client = await getDataClient()
  const loadInput: Row = {
    ...buildLoadInput(
      {
        id: loadId,
        shipmentId,
        orderId,
        shipmentNumber: number,
        proScheme: proSchemeOf(settings),
        leg: 1,
        customerId: customerId ?? undefined,
        customerName,
        pro,
        tmsId: bag.tmsId,
        pickupNumber: bag.pickupNumber,
        stops: bag.stops,
        rateCents: totals.revenueCents,
        equipmentType: bag.equipmentType,
        divisionKey: optionalString(customer?.defaultDivisionKey, 100),
        carrierRepId: null,
        status: 'SOURCING',
      },
      caller,
    ),
    ...bag.columns,
  }
  // The month the calendar buckets by, re-derived after the bag has had its say: a
  // factoring row carries a loose `pickupAppt` and no stops at all.
  loadInput.pickupMonth = monthOf(optionalString(loadInput.pickupAppt, 64))
  try {
    assertLoadWriteOk(await client.models.Load.create(loadInput), 'Load create')
  } catch (err) {
    // Step R. The shipment has a PRO, and a PRO is permanent even when the leg under
    // it never got written: the number was already taken from the counter and must
    // never be handed out twice. So the draft is voided with the reason, not deleted,
    // and the charge lines — which are money, not a record of anything that happened
    // — come off it. The order and the financials stay beside the shipment they
    // describe, exactly as they do on any other void.
    //
    // The ProClaim row is NOT removed here, and must never be: a claim is released by
    // nothing, so the PRO this attempt consumed can never be issued to anything else.
    const now = nowIso()
    const reason = `Load create failed: ${err instanceof Error ? err.message : String(err)}`
      .slice(0, MAX_VOID_REASON)
    await transact(
      [
        updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
          voidedAt: now,
          voidedBy: caller.email,
          voidReason: reason,
          updatedBy: caller.email,
          updatedAt: now,
          version: 2,
        }, null),
        ...chargeRows.map((row) => deleteItemTx(LOAD_CHARGE_TABLE_NAME, String(row.id))),
      ],
      'shipment rollback',
    )
      // Audit every void, this one included: the PRO was consumed and the board now
      // carries a VOIDED row, so the history has to say who voided it and why.
      .then(() =>
        writeAudit('SHIPMENT', shipmentId, 'VOID_SHIPMENT', caller, {
          number,
          status: 'DRAFT',
          reason,
          apBoardLegsClosed: [],
          loadsCanceled: [],
          viaCreate: true,
        }),
      )
      .catch((rollbackErr) => console.error('[tms-shipment-actions] rollback failed:', String(rollbackErr)))
    throw err
  }

  // Step R. A brand-new draft has no carrier and no driver yet, so this is the
  // catch-all rule's answer — but it is written now rather than left blank, so the
  // board and the dashboard never show an untagged row.
  await applyTagToLoads(shipmentId, caller)
  await writeAudit('SHIPMENT', shipmentId, 'CREATE_SHIPMENT', caller, {
    number, customerId, customerName, mode, source, pro, workflowRunId,
  })
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

/**
 * Resolve `order.quoteId` into the three columns it fills. A quote can be linked
 * only to an order of its own customer and only while no other order holds it; the
 * link is cleared with an explicit null, and never once the order is invoiced.
 */
async function quoteLinkPatch(requested: string | null, order: Row, shipment: Row): Promise<Row> {
  const current = optionalString(order.quoteId, 100)
  if (requested == null) {
    if (!current) return {}
    if (order.invoiceId) throw new Error('This order has an invoice; its quote link can no longer be changed')
    return { quoteId: null, quoteNumber: null, quoteAmountCents: null }
  }
  if (requested === current) return {}
  if (order.invoiceId) throw new Error('This order has an invoice; its quote link can no longer be changed')
  const quote = await getById(QUOTE_TABLE_NAME, requested)
  if (!quote) throw new Error(`Quote not found: ${requested}`)
  if (optionalString(quote.customerId, 100) !== optionalString(shipment.customerId, 100)) {
    throw new Error('That quote belongs to a different customer')
  }
  const heldBy = optionalString(quote.orderId, 100)
  if (heldBy && heldBy !== String(order.id)) throw new Error('That quote is already linked to another order')
  // The quote id is its number (CONVERT_QUOTE writes it the same way).
  return { quoteId: requested, quoteNumber: requested, quoteAmountCents: numberOrNull(quote.amountCents) }
}

/**
 * Every freight line has to be weighed in the same unit, or the total on the rate
 * confirmation is a number with no meaning.
 */
function assertWeightUnitsAgree(freight: Row[]): void {
  const units = new Set(freight.map((f) => String(f.weightUnit ?? 'LB')))
  if (units.size > 1) throw new Error('All freight lines must use the same weight unit')
}

function assertRequiredReferences(customer: Row | null, references: Row[]): void {
  // Nothing to require: an unresolved shipment has no customer record to ask, and
  // the reference rules come back into force the moment one is linked.
  const required = Array.isArray(customer?.requiredReferences) ? (customer?.requiredReferences as Row[]) : []
  for (const req of required) {
    const code = typeof req?.code === 'string' ? req.code : null
    if (!code) continue
    const need = numberOrNull(req.countOnNewOrder) ?? 0
    if (need <= 0) continue
    const have = references.filter((r) => String(r.code) === code && String(r.value ?? '').trim()).length
    if (have < need) {
      throw new Error(`${String(customer?.name ?? 'This customer')} requires ${need} ${code} reference${need === 1 ? '' : 's'}`)
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
  assertNotVoided(shipment)
  if (shipment.status !== 'DRAFT') throw new Error('Only a draft order can be edited on the order form')
  // Step AH "Save draft": skips the two completeness rules below and nothing else.
  // SUBMIT_ORDER strips the flag before it re-saves, so a submit can never ride it.
  const draftSave = input.draftSave === true

  const order = bundle.orders[0]
  if (!order) throw new Error(`Shipment ${shipmentId} has no order`)
  const load = bundle.loads[0]
  if (!load) throw new Error(`Shipment ${shipmentId} has no load`)

  // The stop and order editor has to work before a customer record is linked: that
  // is where an operator fills in the freight they were just handed. The pricing
  // helpers below all take a null customer, so the form prices off org defaults.
  const customer = await activeCustomerOf(shipment)
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
  if (!draftSave) assertRequiredReferences(customer, references)

  const equipmentType = optionalString(orderInput.equipmentType, 80) ?? optionalString(order.equipmentType, 80)
  if (!draftSave && isTruckloadMode(mode) && !equipmentType) {
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

  const loadFieldsPatch = validateLoadFieldsV2(input.loadFields)
  const shipmentFlags = validateShipmentFlags(input.shipmentFlags)
  // miles / weight / commodity keep their long-standing rule: null leaves them alone.
  const miles = loadFieldsPatch.miles as number | null | undefined ?? numberOrNull(load.miles)
  const weightLbs = loadFieldsPatch.weight as number | null | undefined ?? numberOrNull(load.weight)
  const quoteLink = 'quoteId' in orderInput
    ? await quoteLinkPatch(optionalString(orderInput.quoteId, 100), order, shipment)
    : {}

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
  if (existingFinancials?.frozenAt && !postInvoiceCleared(input)) throw new Error('This load\'s financials are frozen and can no longer be changed')

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
          ...shipmentFlags,
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
        ...quoteLink,
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
          ? mergeSpecialRequirements(order.specialRequirements, validateSpecialRequirementsV2(orderInput.specialRequirements))
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
      commodity: (loadFieldsPatch.commodity as string | null | undefined) ?? load.commodity ?? null,
      ...Object.fromEntries(
        ['pieces', 'piecesUnit', 'cargoValueCents', 'hot', 'notes']
          .filter((key) => loadFieldsPatch[key] !== undefined)
          .map((key) => [key, loadFieldsPatch[key]]),
      ),
      rate: totals.revenueCents,
      updatedBy: caller.email,
    }),
    'Load update',
  )

  // Step R. The order form is where the customer's references, equipment, mode and
  // sales rep are set, and all four are things a rule may read. Re-resolve against
  // what was just saved; `applyTagToLoads` writes nothing when nothing moved.
  await applyTagToLoads(shipmentId, caller)

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
  assertNotVoided(currentShipment)
  // Step R cutover. Refused first, before the route and before the re-save: a
  // submitted order is one we will bill, and there is nobody to bill. Keyed on the
  // customer link alone and never on status — the backfill sets status from the stop
  // clock, so an unresolved row can arrive already DELIVERED.
  assertCustomerResolved(currentShipment, 'submitting the order')
  // Submit requires a complete route; drafts can be saved with partial stops.
  const firstLoadId = String((currentShipment.loadIds as string[] | undefined)?.[0] ?? '')
  const submitStops = input.stops != null
    ? resequence(assertArrayOf(input.stops, 'stops', validateStop))
    : readStops(await getById(LOAD_TABLE_NAME, firstLoadId) ?? { stops: '[]' })
  assertStopShape(submitStops, true)
  input.expectedUpdatedAt = String(currentShipment.updatedAt ?? '')
  delete input.draftSave
  const saved = await saveOrderForm(input, caller)
  const shipment = saved.bundle.shipment
  const mode = optionalEnum(shipment.mode, SHIPMENT_MODES, 'mode') ?? 'FTL'
  if (!isTruckloadMode(mode)) {
    throw new Error(`${mode} shipments cannot be submitted yet — only truckload modes are built out`)
  }

  const customer = await requireCustomer(shipment, 'submitting the order')
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

/** The org's "only an admin cancels or voids" switch (TmsSettings.cancelDeleteAdminOnly). Owner/ADMIN always pass. */
async function requireAdminForCancel(action: string, caller: Caller, settings: Row | null): Promise<void> {
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
  assertNotVoided(shipment)
  const current = String(shipment.status ?? 'DRAFT') as ShipmentStatus
  const settings = await getSettings()

  const now = nowIso()
  const patch: Row = { updatedBy: caller.email, updatedAt: now, statusChangedAt: now, statusChangedBy: caller.email }

  if (requested === 'CANCELED') {
    await requireAdminForCancel('CANCEL', caller, settings)
    if (current === 'CANCELED') throw new Error('That shipment is already canceled')
    if (!reason) throw new Error('A cancel reason is required')
    await assertNoInvoicedOrders(shipmentId, 'cancel')
    patch.status = 'CANCELED'
    patch.previousStatus = current
    patch.cancelReason = reason
  } else if (requested === 'UNCANCEL') {
    await requireAdminForCancel('UNCANCEL', caller, settings)
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

const STOP_TIME_SOURCES = ['MANUAL', 'DRIVER_APP', 'TRACKING_LINK'] as const

async function setLoadStatus(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const requested = assertEnum(input.status, LOAD_STATUS_VALUES, 'status')
  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')
  await requireLiveShipment(shipmentId)

  const current = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  if (requested === 'INVOICING') {
    throw new Error('INVOICING is set by invoicing, not by hand')
  }
  if (!canTransitionLoadStatus(current, requested)) {
    throw new Error(`A load cannot go from ${current ?? 'SOURCING'} to ${requested}`)
  }
  if (requested === 'DELIVERED') {
    const legs = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
    await assertOwnAssetDriver(load, legs.find((c) => c.status === 'ACTIVE') ?? null, 'DELIVERED')
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

// ── VOID ─────────────────────────────────────────────────────────────────────

/**
 * A PRO claim is permanent. Void retains freight history; owner hard delete and
 * export restoration are separate actions in shipmentDelete.ts.
 */

/** A void reason is a sentence for whoever reads this PRO in two years. */
const MAX_VOID_REASON = 500

/**
 * The carrier legs of one shipment that are sitting on the AP board.
 *
 * `apOpen` is the sparse marker behind "every outside carrier we still owe money on".
 * A voided shipment is freight nobody will run, so its leg is work no one can do —
 * it comes off the board with the shipment, exactly as the removed soft delete did.
 * A leg that is paid, bounced or own-fleet never carried the marker in the first place.
 */
async function apBoardLegsOf(shipmentId: string): Promise<Row[]> {
  const assignments = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  return assignments.filter((row) => row.kind === 'CARRIER')
}

/**
 * The same guard for the actions that are handed a load, a leg or a check call
 * rather than a shipment: read the shipment they hang off and refuse if it is
 * voided. One extra GetItem, on every write path that moves freight.
 */
async function requireLiveShipment(shipmentId: string): Promise<Row> {
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertNotVoided(shipment)
  return shipment
}

/**
 * The void itself: the three markers on the shipment, the AP board markers that
 * come off with it, and the mirrored loads canceled so the calendar, dispatch and
 * the check-call worklist stop showing freight nobody is running.
 *
 * Nothing is retired beyond that. The legs, the charges, the documents and the
 * history stay exactly where they are — a voided shipment is a readable record of
 * what happened, which is the entire point of never deleting one.
 */
async function applyVoid(
  shipment: Row,
  caller: Caller,
  reason: string,
  expectedUpdatedAt: string | null,
): Promise<{ apBoardLegsClosed: string[]; loadsCanceled: string[] }> {
  const shipmentId = String(shipment.id)
  const now = nowIso()
  const openLegs = (await apBoardLegsOf(shipmentId)).filter((row) => row.apOpen)
  await transact(
    [
      updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
        voidedAt: now,
        voidedBy: caller.email,
        voidReason: reason,
        updatedBy: caller.email,
        updatedAt: now,
        version: (numberOrNull(shipment.version) ?? 1) + 1,
      }, expectedUpdatedAt),
      // `apOpen` is a sparse index hash key: it has to leave the row rather than be
      // set to null, which DynamoDB refuses outright.
      ...openLegs.map((row) => updateItemTx(LOAD_CARRIER_TABLE_NAME, String(row.id), {}, null, { remove: ['apOpen'] })),
    ],
    'shipment',
  )

  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const loadsCanceled: string[] = []
  const client = await getDataClient()
  for (const load of loads) {
    const loadId = String(load.id)
    // The reminder belonged to freight that is no longer moving. `checkCallOpen` is
    // another sparse GSI hash key, so clearing goes through the REMOVE path.
    if (load.checkCallOpen != null || load.nextCheckCallAt != null) {
      await writeCheckCallSchedule({ loadId, nextCheckCallAt: null, note: null, caller, expectedUpdatedAt: null })
    }
    // Our own-fleet readers — the calendar, dispatch, box-truck and owner-operator
    // pay, employee stats, the driver schedule — read the Load table and never
    // join a shipment, so the void is mirrored onto the load itself: `voidedAt`
    // is what takes this freight out of every live working set at once, and the
    // row, its PRO and its history stay readable behind the Voided tab.
    // The driver marks come off too — they key on `stops[].driverId` and the
    // `pickupDriverId`/`deliveryDriverId` mirrors, and a voided shipment that
    // kept them would still pay a driver for freight that never ran.
    // `uncoveredLoadPatch` is the same clear a bounce writes; who held the load
    // stays readable on `assignmentType`, `carrierName` and the LoadCarrier
    // legs, which is the record, so those are deliberately not touched here.
    const { assignmentType: _type, carrierName: _name, ...cleared } = uncoveredLoadPatch(readStops(load) as MirrorStop[])
    const canceling = load.status !== 'CANCELED'
    const preReadyToInvoice = load.readyToInvoice === true
    assertLoadWriteOk(
      await client.models.Load.update({
        id: loadId,
        ...cleared,
        stops: JSON.stringify(cleared.stops),
        voidedAt: now,
        // Nothing about a voided shipment is ready to bill.
        readyToInvoice: false,
        // Record what the void changed so UNVOID_SHIPMENT can restore exactly that.
        // A load that was already CANCELED is not re-canceled, so its status is
        // left alone and no status snapshot is kept.
        previousReadyToInvoice: preReadyToInvoice,
        ...(canceling
          ? {
            status: 'CANCELED',
            statusChangedAt: now,
            statusChangedBy: caller.email,
            // Not a person moving this load: the shipment above it was voided.
            statusSource: 'SYSTEM',
            previousStatus: String(load.status),
          }
          : { previousStatus: null }),
        updatedBy: caller.email,
      }),
      'Load update',
    )
    if (canceling) loadsCanceled.push(loadId)
  }
  return { apBoardLegsClosed: openLegs.map((row) => String(row.id)), loadsCanceled }
}

/**
 * VOID_SHIPMENT. Shipment page access is required by authorize. Billing and repeat
 * voids are refused; the PRO and all freight history survive.
 */
async function voidShipment(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const reason = assertString(input.reason, 'reason')
  if (reason.length > MAX_VOID_REASON) throw new Error(`reason exceeds maximum length of ${MAX_VOID_REASON}`)
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)

  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (isVoided(shipment)) {
    throw new Error(`Shipment ${String(shipment.number ?? shipmentId)} is already voided`)
  }
  await requireAdminForCancel('VOID', caller, await getSettings())
  await assertNoInvoicedOrders(shipmentId, 'void')

  const { apBoardLegsClosed, loadsCanceled } = await applyVoid(shipment, caller, reason, expectedUpdatedAt)
  await writeAudit('SHIPMENT', shipmentId, 'VOID_SHIPMENT', caller, {
    number: optionalString(shipment.number, 60),
    status: optionalString(shipment.status, 40),
    reason,
    apBoardLegsClosed,
    loadsCanceled,
  })
  return readBundle(shipmentId) as unknown as Row
}

/**
 * UNVOID_SHIPMENT. Owner or ADMIN only — enforced in `authorize`. The only legal
 * way back from a void: it clears the void markers, reopens any carrier leg that
 * is still owed money, and restores each mirrored Load to the status the evidence
 * supports. The PRO claim is untouched.
 */
async function unvoidShipment(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const reason = assertString(input.reason, 'reason')
  if (reason.length > MAX_VOID_REASON) throw new Error(`reason exceeds maximum length of ${MAX_VOID_REASON}`)
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)

  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (!isVoided(shipment)) {
    throw new Error(`Shipment ${String(shipment.number ?? shipmentId)} is not voided`)
  }

  const now = nowIso()
  const openLegs = (await apBoardLegsOf(shipmentId)).filter(
    (row) => row.kind === 'CARRIER' && row.apStatus !== 'PAID' && row.apStatus !== 'BOUNCED',
  )
  const apBoardLegsReopened: string[] = openLegs.map((row) => String(row.id))

  await transact(
    [
      updateItemTx(
        SHIPMENT_TABLE_NAME,
        shipmentId,
        {
          updatedBy: caller.email,
          updatedAt: now,
          version: (numberOrNull(shipment.version) ?? 1) + 1,
        },
        expectedUpdatedAt,
        { remove: ['voidedAt', 'voidedBy', 'voidReason'] },
      ),
      ...openLegs.map((row) => updateItemTx(LOAD_CARRIER_TABLE_NAME, String(row.id), { apOpen: 'OPEN' }, null)),
    ],
    'shipment unvoid',
  )

  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const loadsRestored: string[] = []
  const client = await getDataClient()
  for (const load of loads) {
    const loadId = String(load.id)
    const previousStatus = optionalString(load.previousStatus, 40)
    const previousReadyToInvoice = typeof load.previousReadyToInvoice === 'boolean' ? load.previousReadyToInvoice : null
    const patch: Row = {
      id: loadId,
      voidedAt: null,
      updatedBy: caller.email,
    }
    if (previousStatus != null) {
      // The void canceled this load: put its status and readyToInvoice back exactly.
      patch.status = previousStatus
      patch.statusChangedAt = now
      patch.statusChangedBy = caller.email
      patch.statusSource = 'SYSTEM'
      patch.previousStatus = null
      patch.previousReadyToInvoice = null
      patch.readyToInvoice = previousReadyToInvoice === true
      loadsRestored.push(loadId)
    } else {
      // The load was already canceled before the void: its status is left alone,
      // but the void still flipped readyToInvoice, so restore that if we recorded it.
      if (previousReadyToInvoice != null) {
        patch.readyToInvoice = previousReadyToInvoice === true
        patch.previousReadyToInvoice = null
      }
    }
    assertLoadWriteOk(await client.models.Load.update(patch), 'Load update')
  }

  await writeAudit('SHIPMENT', shipmentId, 'UNVOID_SHIPMENT', caller, {
    number: optionalString(shipment.number, 60),
    reason,
    apBoardLegsReopened,
    loadsRestored,
  })
  return readBundle(shipmentId) as unknown as Row
}

/**
 * Step H's rollback, as a void.
 *
 * A convert that failed half way is taking back a shipment it just made, and a
 * revert has already proved the shipment is unbilled, uncovered and single-order.
 * Neither is a person removing somebody's freight, so neither re-asks the gates —
 * but the shipment still only ever gets voided, and the PRO it took still exists.
 */
async function voidShipmentForQuote(shipmentId: string, caller: Caller, reason: string): Promise<void> {
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment || isVoided(shipment)) return
  const { apBoardLegsClosed, loadsCanceled } = await applyVoid(
    shipment,
    caller,
    reason.slice(0, MAX_VOID_REASON),
    null,
  )
  await writeAudit('SHIPMENT', shipmentId, 'VOID_SHIPMENT', caller, {
    number: optionalString(shipment.number, 60),
    status: optionalString(shipment.status, 40),
    reason,
    apBoardLegsClosed,
    loadsCanceled,
    viaQuote: true,
  })
}

// ── Ownership tagging (step R) ───────────────────────────────────────────────

/**
 * Which business earns a shipment, resolved from the division tree and the ordered
 * rules an admin edits. `ownershipResolve.ts` does the reading and the caching;
 * `src/lib/ownership.ts` makes the decision; this section is where the answer is
 * written onto the two mirrored rows.
 */
const ownershipDeps: OwnershipDeps = {
  db: dynamo,
  tables: {
    shipment: SHIPMENT_TABLE_NAME,
    order: ORDER_TABLE_NAME,
    load: LOAD_TABLE_NAME,
    loadCarrier: LOAD_CARRIER_TABLE_NAME,
    driver: DRIVER_TABLE_NAME,
    division: OWNERSHIP_DIVISION_TABLE_NAME,
    rule: OWNERSHIP_RULE_TABLE_NAME,
  },
  getById,
  queryIndex,
}

/** The columns a Load mirrors from its shipment: the tag, and the rep who sold it. */
const LOAD_TAG_FIELDS = ['revDivision', 'revSubdivision', 'revTagSource', 'revRuleId', 'salesRepId'] as const

/**
 * The rep the shipment belongs to: the one on its order, which is what the draft
 * editor writes and what SET_SALES_REP keeps in step with. Falls back to whatever
 * the shipment already carries, so a re-resolve never erases a rep.
 */
function salesRepOf(shipment: Row, order: Row | null): string | null {
  return optionalString(order?.customerRepId, 100) ?? optionalString(shipment.salesRepId, 100)
}

/**
 * Resolve a shipment's owner and write the tag onto the Shipment row.
 *
 * Two rules live here. A `HAND` tag is a person's answer and the rules never
 * overrule it — the shipment keeps what it was given and only the rep is refreshed.
 * And a resolution that fails is logged, not thrown: an unreadable division table is
 * a reporting problem, and refusing to book a truck over one would be a worse bug
 * than an untagged load. The explicit tag actions below do throw, because there the
 * tag is the whole point of the call.
 *
 * A caller that just wrote the leg passes the records it has rather than a
 * shipment id: `readShipmentRecords` finds the ACTIVE leg through a GSI, and a GSI
 * can still be serving the retired leg a moment after the transaction committed —
 * which would tag a load just booked to an outside carrier as own-fleet, with no
 * re-resolve until somebody pressed Retag.
 */
async function applyTag(
  target: string | ShipmentRecords,
  caller: Caller,
  opts: { ignoreHand?: boolean } = {},
): Promise<Row> {
  try {
    const { records, tag } = await resolveForShipment(ownershipDeps, target)
    const shipmentId = String(records.shipment.id)
    const { shipment, order } = records
    const hand = !opts.ignoreHand && shipment.revTagSource === 'HAND'
    const heldDivision = optionalString(shipment.revDivision, 60)
    const intake = !hand && !opts.ignoreHand && shipment.revTagSource === 'INTAKE' && heldDivision != null
    const source: 'HAND' | 'RULE' | 'INTAKE' = hand ? 'HAND' : intake ? 'INTAKE' : 'RULE'
    const held = intake
      ? holdDivision(heldDivision, { revDivision: tag.revDivision, revSubdivision: tag.revSubdivision, ruleId: tag.revRuleId })
      : null
    const effective: ShipmentTag = hand
      ? {
        revDivision: optionalString(shipment.revDivision, 60),
        revSubdivision: optionalString(shipment.revSubdivision, 60),
        revRuleId: null,
      }
      : held
        ? { revDivision: held.revDivision, revSubdivision: held.revSubdivision, revRuleId: held.ruleId }
        : tag
    const taggedBy = hand ? optionalString(shipment.revTaggedBy, 200) : null
    const settingsForRep = salesRepOf(shipment, order) == null ? await getSettings() : null
    const salesRepId = salesRepOf(shipment, order)
      ?? salesRepForDivision(settingsForRep, { revDivision: effective.revDivision, salesRepId: null })

    const unchanged = sameTag(shipment, effective, source, taggedBy)
      && (optionalString(shipment.salesRepId, 100) ?? null) === salesRepId
    if (!unchanged) {
      const now = nowIso()
      await transact(
        [
          updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
            ...shipmentTagPatch(effective, source, taggedBy),
            salesRepId,
            updatedBy: caller.email,
            updatedAt: now,
            version: (numberOrNull(shipment.version) ?? 1) + 1,
          }, null),
          // A rep filled in from the division map is mirrored onto the order, as SET_SALES_REP does.
          ...(order && salesRepId && !optionalString(order.customerRepId, 100)
            ? [updateItemTx(ORDER_TABLE_NAME, String(order.id), {
              customerRepId: salesRepId,
              updatedBy: caller.email,
              updatedAt: now,
              version: (numberOrNull(order.version) ?? 1) + 1,
            }, null)]
            : []),
        ],
        'shipment tag',
      )
    }
    return { ...tagPatch(effective, source), salesRepId }
  } catch (err) {
    console.warn('[tms-shipment-actions] ownership tag skipped:', String(err))
    return {}
  }
}

/**
 * The same, for the paths that are not already writing the Load themselves —
 * CREATE_SHIPMENT, the order form and the backfill. The Load
 * goes through AppSync so the calendar's subscriptions see the change.
 */
async function applyTagToLoads(shipmentId: string, caller: Caller, opts: { ignoreHand?: boolean } = {}): Promise<Row> {
  const patch = await applyTag(shipmentId, caller, opts)
  if (Object.keys(patch).length === 0) return patch
  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  if (loads.length === 0) return patch
  const client = await getDataClient()
  for (const load of loads) {
    if (LOAD_TAG_FIELDS.every((field) => (load[field] ?? null) === (patch[field] ?? null))) continue
    assertLoadWriteOk(
      await client.models.Load.update({ id: String(load.id), ...patch, updatedBy: caller.email }),
      'Load update',
    )
  }
  return patch
}

/**
 * The resolver's records assembled from the rows an assignment action already has.
 *
 * The shipment, the load and the leg are rows this handler read or wrote itself, so
 * a GSI that has not caught up cannot hand the resolver the leg that was just
 * retired. Only the order and the own-fleet driver are read, which is what
 * `readShipmentRecords` would have done anyway.
 */
async function recordsForTag(shipment: Row, load: Row, loadCarrier: Row | null): Promise<ShipmentRecords> {
  const orderId = optionalString(load.orderId, 100)
  const driverId = optionalString(loadCarrier?.driverId, 100)
  const [order, driver] = await Promise.all([
    orderId
      ? getById(ORDER_TABLE_NAME, orderId)
      : queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', String(shipment.id))
        .then((orders) => orders[0] ?? null),
    driverId ? getById(DRIVER_TABLE_NAME, driverId) : Promise.resolve(null),
  ])
  return { shipment, order, load, loadCarrier, driver }
}

/** The division codes an admin may hand-tag with: the active rows, and nothing else. */
async function assertTaggableDivision(divisionCode: string, subdivisionCode: string | null): Promise<void> {
  const taxonomy = await loadTaxonomy(ownershipDeps)
  const active = taxonomy.divisions.filter((d) => d.active)
  const division = active.find((d) => d.code === divisionCode)
  if (!division) throw new Error(`Unknown or archived division: ${divisionCode}`)
  if (division.parentId) throw new Error(`${divisionCode} is a subdivision; tag with its parent and name it as the subdivision`)
  if (!subdivisionCode) return
  const sub = active.find((d) => d.code === subdivisionCode)
  if (!sub) throw new Error(`Unknown or archived division: ${subdivisionCode}`)
  // The pair has to be a parent and its own descendant, or the roll-up lies.
  if (topLevelOf(taxonomy.divisions, subdivisionCode) !== divisionCode) {
    throw new Error(`${subdivisionCode} is not part of ${divisionCode}`)
  }
}

// ── Step AP ─────────────────────────────────────────────────────────────────
/**
 * One row of PUSH_TO_LOAD_REVIEW: the shared requirement verdict (the same list
 * REVIEW_LOAD and the review release read), and only a clean verdict writes the push
 * stamp. Pushing an already-pushed shipment is a no-op reported as such.
 */
async function pushToReview(shipmentId: string, caller: Caller): Promise<{ reasons: string[]; already: boolean }> {
  const { shipment, reasons } = await pushToReviewVerdict(documentDeps, shipmentId)
  if (reasons.length > 0) return { reasons, already: false }
  if (shipment.loadReviewPushedAt) return { reasons: [], already: true }
  const now = nowIso()
  await transact(
    [updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
      loadReviewPushedAt: now,
      loadReviewPushedBy: caller.email,
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(shipment.version) ?? 1) + 1,
    }, null)],
    'load review push',
  )
  await writeAudit('SHIPMENT', shipmentId, 'PUSH_TO_LOAD_REVIEW', caller, { pushedAt: now })
  return { reasons: [], already: false }
}

/**
 * Ryne 2026-11-09: a shipment that is DELIVERED and passes the Load Review requirement verdict (reference numbers, sales rep, order details,
 * documents) moves to Load Review by itself. Runs after every status re-derive; a failure or a not-ready shipment is silent, because the
 * save that triggered it already succeeded and the verdict is re-read the next time anything changes.
 */
async function autoPushToReview(shipmentId: string, caller: Caller): Promise<boolean> {
  try {
    const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
    if (!shipment || shipment.status !== 'DELIVERED' || shipment.loadReviewPushedAt) return false
    const done = await pushToReview(shipmentId, { ...caller, email: SYSTEM_CALLER_EMAIL })
    return done.reasons.length === 0 && !done.already
  } catch (err) {
    console.error('[shipment-actions] auto push to Load Review failed', shipmentId, err instanceof Error ? err.message : String(err))
    return false
  }
}

/** PUSH_READY_TO_LOAD_REVIEW — sweep every delivered shipment not yet in Load Review and push the ones that pass the verdict. */
async function pushReadyToReview(caller: Caller): Promise<Row> {
  let pushed = 0
  let checked = 0
  let key: Record<string, AttributeValue> | undefined
  do {
    const page = await dynamo.send(new ScanCommand({
      TableName: SHIPMENT_TABLE_NAME,
      ExclusiveStartKey: key,
      FilterExpression: '#s = :d AND attribute_not_exists(loadReviewPushedAt) AND attribute_not_exists(voidedAt)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':d': { S: 'DELIVERED' } },
      ProjectionExpression: 'id',
    }))
    for (const item of page.Items ?? []) {
      checked += 1
      if (await autoPushToReview(String(item.id?.S ?? ''), caller)) pushed += 1
    }
    key = page.LastEvaluatedKey
  } while (key)
  await writeAudit('SHIPMENT', 'batch', 'PUSH_READY_TO_LOAD_REVIEW', caller, { checked, pushed })
  return { checked, pushed }
}

/** SET_REV_TAG — a person says who earned this load, and the rules stop arguing. */
async function setRevTag(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const divisionCode = assertString(input.divisionCode, 'divisionCode')
  const subdivisionCode = optionalString(input.subdivisionCode, 60)
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertNotVoided(shipment)
  await assertTaggableDivision(divisionCode, subdivisionCode)

  const tag: ShipmentTag = { revDivision: divisionCode, revSubdivision: subdivisionCode, revRuleId: null }
  // An intake promotion holds the division it arrived under but lets the driver decide the subdivision.
  const source: 'HAND' | 'INTAKE' = input.source === 'INTAKE' && !subdivisionCode ? 'INTAKE' : 'HAND'
  const now = nowIso()
  await transact(
    [updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
      ...shipmentTagPatch(tag, source, caller.email),
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(shipment.version) ?? 1) + 1,
    }, null)],
    'shipment tag',
  )
  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const client = await getDataClient()
  for (const load of loads) {
    assertLoadWriteOk(
      await client.models.Load.update({ id: String(load.id), ...tagPatch(tag, source), updatedBy: caller.email }),
      'Load update',
    )
  }
  await writeAudit('SHIPMENT', shipmentId, 'SET_REV_TAG', caller, {
    from: { revDivision: shipment.revDivision ?? null, revSubdivision: shipment.revSubdivision ?? null },
    to: tag,
  })
  return readBundle(shipmentId) as unknown as Row
}

/** CLEAR_REV_TAG — back to whatever the rules say, as of right now. */
async function clearRevTag(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertNotVoided(shipment)
  const patch = await applyTagToLoads(shipmentId, caller, { ignoreHand: true })
  await writeAudit('SHIPMENT', shipmentId, 'CLEAR_REV_TAG', caller, {
    from: { revDivision: shipment.revDivision ?? null, revSubdivision: shipment.revSubdivision ?? null },
    to: { revDivision: patch.revDivision ?? null, revSubdivision: patch.revSubdivision ?? null },
  })
  return readBundle(shipmentId) as unknown as Row
}

/**
 * RESOLVE_REV_TAG — re-resolve the ownership tag from the shipment as it stands.
 *
 * Used after a customer re-point that moved revenue onto a different customer:
 * the Auto Shipper rule keys on CUSTOMER_IS, so the tag that matched the old
 * customer may no longer match the new one. A hand tag still wins, just like on
 * create, save and SET_SHIPMENT_CUSTOMER.
 */
async function resolveRevTag(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertNotVoided(shipment)
  const patch = await applyTagToLoads(shipmentId, caller)
  await writeAudit('SHIPMENT', shipmentId, 'RESOLVE_REV_TAG', caller, {
    from: { revDivision: shipment.revDivision ?? null, revSubdivision: shipment.revSubdivision ?? null },
    to: { revDivision: patch.revDivision ?? null, revSubdivision: patch.revSubdivision ?? null },
  })
  return readBundle(shipmentId) as unknown as Row
}

/**
 * SET_SALES_REP. The rep is one fact kept in three places: the Shipment the board
 * groups by, the Load every own-fleet reader already has in hand, and the Order,
 * which is where the draft editor and the invoice read it from.
 */
async function setSalesRep(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  if (!('repId' in input)) throw new Error('repId is required; send null to clear it')
  const repId = optionalString(input.repId, 100)
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertNotVoided(shipment)
  await assertRepProfile(repId, 'Sales rep')

  const orders = await queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const now = nowIso()
  await transact(
    [
      updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
        salesRepId: repId,
        updatedBy: caller.email,
        updatedAt: now,
        version: (numberOrNull(shipment.version) ?? 1) + 1,
      }, null),
      ...orders.map((order) => updateItemTx(ORDER_TABLE_NAME, String(order.id), {
        customerRepId: repId,
        updatedBy: caller.email,
        updatedAt: now,
        version: (numberOrNull(order.version) ?? 1) + 1,
      }, null)),
    ],
    'sales rep',
  )
  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const client = await getDataClient()
  for (const load of loads) {
    assertLoadWriteOk(
      await client.models.Load.update({ id: String(load.id), salesRepId: repId, updatedBy: caller.email }),
      'Load update',
    )
  }
  await writeAudit('SHIPMENT', shipmentId, 'SET_SALES_REP', caller, { from: shipment.salesRepId ?? null, to: repId })
  return readBundle(shipmentId) as unknown as Row
}

// ── Aljex code mapping (Settings > Users) ───────────────────────────────────
// The import stores the Aljex Salesrep / staff codes verbatim on each Shipment. The crosswalk
// code -> user lives in AljexCodeMap (`<kind>:<code>`), and a reassign applies a sales rep code
// to every shipment carrying it, so Ryne can map them after the import without a re-import.

const ALJEX_CODE_KINDS = ['SALES_REP', 'STAFF'] as const
/** Stop with this much of the 120 s budget used; the caller repeats while `hasMore`. */
const ALJEX_REASSIGN_BUDGET_MS = 90_000

function aljexCodeOf(value: unknown, label: string): string {
  const code = assertString(value, label).trim()
  if (!code || code.length > 40) throw new Error(`${label} must be 1-40 characters`)
  return code
}

async function userNameOf(userId: string, label: string): Promise<string> {
  const profile = await getById(USER_PROFILE_TABLE_NAME, userId)
  if (!profile) throw new Error(`${label} is not a user profile: ${userId}`)
  return String(profile.name ?? profile.email ?? userId)
}

/** Upsert one crosswalk row, keeping whatever the patch does not name. */
async function putAljexCodeMap(kind: string, code: string, patch: Row, caller: Caller): Promise<Row> {
  if (!ALJEX_CODE_MAP_TABLE_NAME) throw new Error('Aljex code map table is not configured')
  const id = `${kind}:${code}`
  const existing = await getById(ALJEX_CODE_MAP_TABLE_NAME, id)
  const now = nowIso()
  const row: Row = {
    ...(existing ?? {}),
    id,
    __typename: 'AljexCodeMap',
    kind,
    code,
    ...patch,
    updatedBy: caller.email,
    createdAt: (existing?.createdAt as string | undefined) ?? now,
    updatedAt: now,
  }
  await dynamo.send(new PutItemCommand({ TableName: ALJEX_CODE_MAP_TABLE_NAME, Item: marshallRow(row) }))
  return row
}

/** LIST_ALJEX_CODES. Every code found on shipments, plus mapped codes no shipment carries. */
async function listAljexCodes(): Promise<Row> {
  const [shipments, maps] = await Promise.all([
    scanTableSegmented(SHIPMENT_TABLE_NAME, ALJEX_CODE_SHIPMENT_FIELDS),
    ALJEX_CODE_MAP_TABLE_NAME ? scanTable(ALJEX_CODE_MAP_TABLE_NAME) : Promise.resolve([] as Row[]),
  ])
  const mapOf = new Map<string, Row>()
  for (const m of maps) mapOf.set(String(m.id), m)
  const sales = new Map<string, { total: number; byUser: Map<string, number> }>()
  const staff = new Map<string, number>()
  for (const s of shipments) {
    const code = optionalString(s.salesRepCode, 40)
    if (code) {
      const entry = sales.get(code) ?? { total: 0, byUser: new Map<string, number>() }
      entry.total++
      if (!isVoided(s)) {
        const rep = typeof s.salesRepId === 'string' ? s.salesRepId : ''
        entry.byUser.set(rep, (entry.byUser.get(rep) ?? 0) + 1)
      }
      sales.set(code, entry)
    }
    const seen = new Set<string>()
    for (const field of ['createdByCode', 'serviceRepCode', 'dispatcherCode'] as const) {
      const c = optionalString(s[field], 40)
      if (c) seen.add(c)
    }
    for (const c of seen) staff.set(c, (staff.get(c) ?? 0) + 1)
  }
  const codes: Row[] = []
  const row = (kind: string, code: string, shipmentCount: number, pending: (userId: string | null) => number): Row => {
    const map = mapOf.get(`${kind}:${code}`)
    const userId = (map?.userId as string | undefined) ?? null
    return {
      kind,
      code,
      shipmentCount,
      pendingCount: userId ? pending(userId) : 0,
      userId,
      userName: (map?.userName as string | undefined) ?? null,
      lastAppliedAt: (map?.lastAppliedAt as string | undefined) ?? null,
      lastAppliedBy: (map?.lastAppliedBy as string | undefined) ?? null,
      lastAppliedCount: numberOrNull(map?.lastAppliedCount),
    }
  }
  const codeKeys = new Set<string>([...sales.keys()])
  for (const m of maps) if (m.kind === 'SALES_REP') codeKeys.add(String(m.code))
  for (const code of [...codeKeys].sort()) {
    const entry = sales.get(code)
    codes.push(row('SALES_REP', code, entry?.total ?? 0, (userId) => {
      let pending = 0
      for (const [rep, n] of entry?.byUser ?? []) if (rep !== userId) pending += n
      return pending
    }))
  }
  const staffKeys = new Set<string>([...staff.keys()])
  for (const m of maps) if (m.kind === 'STAFF') staffKeys.add(String(m.code))
  for (const code of [...staffKeys].sort()) codes.push(row('STAFF', code, staff.get(code) ?? 0, () => 0))
  return { codes }
}

/** SET_ALJEX_CODE_MAP. Stores the crosswalk only; shipments change when a reassign runs. */
async function setAljexCodeMap(input: Row, caller: Caller): Promise<Row> {
  const kind = assertEnum(input.kind, ALJEX_CODE_KINDS, 'kind')
  const code = aljexCodeOf(input.code, 'code')
  const userId = optionalString(input.userId, 100)
  const userName = userId ? await userNameOf(userId, 'User') : null
  const map = await putAljexCodeMap(kind, code, { userId, userName }, caller)
  await writeAudit('ALJEX_CODE_MAP', `${kind}:${code}`, 'SET_ALJEX_CODE_MAP', caller, { to: userId })
  return { map }
}

/**
 * REASSIGN_SHIPMENTS_BY_REP_CODE. Applies one Aljex Salesrep code to a user across every
 * shipment carrying it, by exactly SET_SALES_REP's semantics: Shipment.salesRepId, the
 * Order's customerRepId and the Load's salesRepId move together; a voided shipment is skipped
 * (SET_SALES_REP refuses one); no Commission row is read or written, so commissions already
 * earned keep the rep they were earned for and later ones key on the Order's new customerRepId.
 * Idempotent (a shipment already on the rep is skipped), audited per shipment and per run, and
 * it stops at a time budget with `hasMore` so a second call finishes the rest.
 */
async function reassignShipmentsByRepCode(input: Row, caller: Caller): Promise<Row> {
  const code = aljexCodeOf(input.code, 'code')
  const repId = assertString(input.repId, 'repId')
  const dryRun = optionalBoolean(input.dryRun) ?? false
  const repName = await userNameOf(repId, 'Sales rep')
  const started = Date.now()

  const [shipments, orders, loads] = await Promise.all([
    scanTable(SHIPMENT_TABLE_NAME),
    scanTable(ORDER_TABLE_NAME),
    scanTable(LOAD_TABLE_NAME),
  ])
  const ordersOf = new Map<string, Row[]>()
  for (const o of orders) {
    const key = String(o.shipmentId ?? '')
    if (key) ordersOf.set(key, [...(ordersOf.get(key) ?? []), o])
  }
  const loadsOf = new Map<string, Row[]>()
  for (const l of loads) {
    const key = String(l.shipmentId ?? '')
    if (key) loadsOf.set(key, [...(loadsOf.get(key) ?? []), l])
  }

  const result = {
    code, repId, dryRun, matched: 0, updated: 0, skippedAlreadyAssigned: 0, skippedVoided: 0,
    hasMore: false, failed: [] as Array<{ shipmentId: string; reason: string }>,
  }
  let writes: TransactWriteItem[] = []
  let pendingAudits: Array<{ id: string; from: unknown }> = []
  const flush = async (): Promise<void> => {
    if (writes.length === 0) return
    const batch = pendingAudits
    try {
      await transact(writes, 'sales rep reassign')
    } catch (err) {
      for (const b of batch) result.failed.push({ shipmentId: b.id, reason: err instanceof Error ? err.message : String(err) })
      result.updated -= batch.length
      writes = []
      pendingAudits = []
      return
    }
    writes = []
    pendingAudits = []
    await Promise.all(batch.map((b) => writeAudit('SHIPMENT', b.id, 'SET_SALES_REP', caller, {
      from: b.from ?? null, to: repId, viaAljexCode: code,
    })))
  }

  for (const shipment of shipments) {
    if (optionalString(shipment.salesRepCode, 40) !== code) continue
    result.matched++
    if (isVoided(shipment)) { result.skippedVoided++; continue }
    if (shipment.salesRepId === repId) { result.skippedAlreadyAssigned++; continue }
    if (Date.now() - started > ALJEX_REASSIGN_BUDGET_MS) { result.hasMore = true; continue }
    result.updated++
    if (dryRun) continue
    const id = String(shipment.id)
    const now = nowIso()
    const own = ordersOf.get(id) ?? []
    const legs = loadsOf.get(id) ?? []
    const items: TransactWriteItem[] = [
      updateItemTx(SHIPMENT_TABLE_NAME, id, {
        salesRepId: repId, updatedBy: caller.email, updatedAt: now, version: (numberOrNull(shipment.version) ?? 1) + 1,
      }, null),
      ...own.map((o) => updateItemTx(ORDER_TABLE_NAME, String(o.id), {
        customerRepId: repId, updatedBy: caller.email, updatedAt: now, version: (numberOrNull(o.version) ?? 1) + 1,
      }, null)),
      ...legs.map((l) => updateItemTx(LOAD_TABLE_NAME, String(l.id), {
        salesRepId: repId, updatedBy: caller.email, updatedAt: now,
      }, null)),
    ]
    if (writes.length + items.length > 90) await flush()
    writes.push(...items)
    pendingAudits.push({ id, from: shipment.salesRepId })
  }
  if (!dryRun) {
    await flush()
    await putAljexCodeMap('SALES_REP', code, {
      userId: repId, userName: repName,
      lastAppliedAt: nowIso(), lastAppliedBy: caller.email, lastAppliedCount: result.updated,
    }, caller)
    await writeAudit('ALJEX_CODE_MAP', `SALES_REP:${code}`, 'REASSIGN_SHIPMENTS_BY_REP_CODE', caller, {
      to: repId, matched: result.matched, updated: result.updated, hasMore: result.hasMore, failed: result.failed.length,
    })
  }
  return result
}

/**
 * ASSIGN_TRACKER — who is tracking these shipments. One shape for single and bulk:
 * each id is written on its own (a bad id never blocks the others) and reported in
 * `skipped` with the reason. The tracker lives on the Shipment only.
 */
async function assignTracker(input: Row, caller: Caller): Promise<Row> {
  const rawIds = Array.isArray(input.shipmentIds) ? input.shipmentIds : null
  if (!rawIds || rawIds.length < 1 || rawIds.length > 100) throw new Error('shipmentIds must list 1 to 100 shipments')
  const shipmentIds = [...new Set(rawIds.map((id) => assertString(id, 'shipmentIds[]')))]
  if (!('trackerId' in input)) throw new Error('trackerId is required; send null to clear it')
  const trackerId = optionalString(input.trackerId, 100)
  const tracker = trackerId ? await getById(USER_PROFILE_TABLE_NAME, trackerId) : null
  const trackerOk = trackerId == null || (tracker != null && tracker.status !== 'INACTIVE')

  const updated: string[] = []
  const skipped: { shipmentId: string; reason: string }[] = []
  for (const shipmentId of shipmentIds) {
    const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
    if (!shipment) {
      skipped.push({ shipmentId, reason: 'Shipment not found' })
      continue
    }
    if (isVoided(shipment)) {
      skipped.push({ shipmentId, reason: 'Shipment is voided' })
      continue
    }
    if (!trackerOk) {
      skipped.push({ shipmentId, reason: 'Tracker is not an active user profile' })
      continue
    }
    await transact(
      [updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
        trackerId,
        updatedBy: caller.email,
        updatedAt: nowIso(),
        version: (numberOrNull(shipment.version) ?? 1) + 1,
      }, null)],
      'tracker',
    )
    await writeAudit('SHIPMENT', shipmentId, 'ASSIGN_TRACKER', caller, {
      from: shipment.trackerId ?? null,
      to: trackerId,
      batch: shipmentIds.length > 1,
    })
    updated.push(shipmentId)
  }
  return { updated, skipped }
}

/**
 * The stored override for a validated client input: `confirmed: true` stamps who and when (never client-supplied);
 * an edit without it keeps the earlier confirmation; null clears everything. Shared by SET_TRACKING_PREFS and
 * UPDATE_LOAD_CARRIER_DETAILS so a carrier override is stamped identically on both paths.
 */
function stampTrackingPrefs(sent: ReturnType<typeof validateTrackingPrefsOverride>, prior: TrackingPrefsOverride | null, caller: Caller): TrackingPrefsOverride | null {
  if (!sent) return null
  return {
    ...(sent.mode ? { mode: sent.mode } : {}),
    ...(sent.method ? { method: sent.method } : {}),
    ...(sent.driverSms ? { driverSms: sent.driverSms } : {}),
    ...(sent.confirmed
      ? { confirmedAt: nowIso(), confirmedBy: caller.email }
      : prior?.confirmedAt ? { confirmedAt: prior.confirmedAt, ...(prior.confirmedBy ? { confirmedBy: prior.confirmedBy } : {}) } : {}),
  }
}

/**
 * SET_TRACKING_PREFS — the per-shipment override of the customer's tracking mode, method and
 * driver-SMS target (Step AJ), and (feedback 9) the per-load confirmation of that mode.
 * `prefs` is `{ mode?, method?, driverSms?, confirmed? }` (mode may be NONE); a key left out or
 * null inherits the customer, and an empty override (or `prefs: null`) clears the field.
 * Refused on a voided shipment. Same authorization as ASSIGN_TRACKER.
 */
async function setTrackingPrefs(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  if (!('prefs' in input)) throw new Error('prefs is required; send null to inherit everything')
  const sent = validateTrackingPrefsOverride(input.prefs)
  const expectedUpdatedAt = input.expectedUpdatedAt == null ? null : assertExpectedUpdatedAt(input)
  const loadCarrierId = optionalString(input.loadCarrierId, 100)

  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertNotVoided(shipment)
  // Step AT (D5): with `loadCarrierId` the same override is written on that carrier instead of the shipment,
  // and wins over the shipment's for the leg the carrier covers. Same validation, same confirmation stamping.
  const target = loadCarrierId ? await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId) : null
  if (loadCarrierId) {
    if (!target || String(target.shipmentId) !== shipmentId) throw new Error(`Load carrier not found on this shipment: ${loadCarrierId}`)
    if (String(target.status ?? '') !== 'ACTIVE') throw new Error('Only an active carrier assignment can carry a tracking override')
  }
  const holder = target ?? shipment
  // Feedback 9: `confirmed: true` stamps who confirmed the load's mode and when (never client-supplied);
  // a later edit keeps the earlier confirmation; clearing the override (null) clears it too.
  const prior = parseTrackingPrefs(holder.trackingPrefs)
  const prefs = stampTrackingPrefs(sent, prior, caller)

  if (target) {
    await transact(
      [updateItemTx(LOAD_CARRIER_TABLE_NAME, String(target.id), {
        trackingPrefs: prefs,
        updatedBy: caller.email,
        updatedAt: nowIso(),
      }, expectedUpdatedAt)],
      'loadCarrier',
    )
  } else {
    await transact(
      [updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
        trackingPrefs: prefs,
        updatedBy: caller.email,
        updatedAt: nowIso(),
        version: (numberOrNull(shipment.version) ?? 1) + 1,
      }, expectedUpdatedAt)],
      'shipment',
    )
  }
  await writeAudit('SHIPMENT', shipmentId, 'SET_TRACKING_PREFS', caller, {
    from: prior,
    to: prefs,
    ...(target ? { loadCarrierId: String(target.id) } : {}),
  })
  return {
    shipment: await getById(SHIPMENT_TABLE_NAME, shipmentId),
    ...(target ? { loadCarrier: await getById(LOAD_CARRIER_TABLE_NAME, String(target.id)) } : {}),
  } as unknown as Row
}

/**
 * ASSIGN_CARRIER_REP — the coverage desk owns the rep and team on a shipment.
 *
 * The value is written on the Shipment, mirrored onto every Load of the shipment,
 * and stamped on the ACTIVE LoadCarrier row so the board's "Dispatcher Assigned"
 * facet reads one value. Clearing is allowed; a voided shipment is not.
 */
async function assignCarrierRep(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedUpdatedAt = input.expectedUpdatedAt == null ? null : assertExpectedUpdatedAt(input)

  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertNotVoided(shipment)
  const repId = optionalString('repId' in input ? input.repId : shipment.carrierRepId, 100)
  const teamKey = optionalString('teamKey' in input ? input.teamKey : shipment.carrierTeamKey, 100)
  await assertCarrierRepProfile(repId)

  const assignments = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const now = nowIso()
  const version = (numberOrNull(shipment.version) ?? 1) + 1

  const writes: TransactWriteItem[] = [
    updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
      carrierRepId: repId,
      carrierTeamKey: teamKey,
      updatedBy: caller.email,
      updatedAt: now,
      version,
    }, expectedUpdatedAt ?? optionalString(shipment.updatedAt, 100)),
    ...assignments.filter((assignment) => assignment.status === 'ACTIVE').map((assignment) =>
      updateItemTx(LOAD_CARRIER_TABLE_NAME, String(assignment.id), {
        carrierRepId: repId,
        updatedBy: caller.email,
        updatedAt: now,
      }, optionalString(assignment.updatedAt, 100))),
  ]
  await transact(writes, 'carrier rep')

  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const client = await getDataClient()
  for (const load of loads) {
    assertLoadWriteOk(
      await client.models.Load.update({ id: String(load.id), carrierRepId: repId, updatedBy: caller.email }),
      'Load update',
    )
  }
  await writeAudit('SHIPMENT', shipmentId, 'ASSIGN_CARRIER_REP', caller, {
    from: { carrierRepId: shipment.carrierRepId ?? null, carrierTeamKey: shipment.carrierTeamKey ?? null },
    to: { carrierRepId: repId, carrierTeamKey: teamKey },
  })
  return readBundle(shipmentId) as unknown as Row
}

/**
 * TEST_OWNERSHIP_RULES — the Divisions & ownership page's "test a shipment" preview.
 * Reads the same records a real resolution reads and writes nothing at all.
 */
async function testOwnershipRules(input: Row): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const { records, context, resolution } = await resolveForShipment(ownershipDeps, shipmentId)
  return {
    context,
    resolution,
    current: {
      revDivision: records.shipment.revDivision ?? null,
      revSubdivision: records.shipment.revSubdivision ?? null,
      revTagSource: records.shipment.revTagSource ?? null,
      revRuleId: records.shipment.revRuleId ?? null,
      revTaggedBy: records.shipment.revTaggedBy ?? null,
    },
  } as unknown as Row
}

/** DynamoDB's transaction ceiling is 100; a Shipment and its Load are two items. */
const RETAG_BATCH_ITEMS = 90

/**
 * RETAG_SHIPMENTS — re-run the rules over every shipment and report what moved.
 *
 * Five whole-table reads rather than four reads per shipment: at ~900 shipments the
 * per-row version is thousands of round trips, and the rules need the same five
 * tables for all of them. Hand-tagged and voided rows are counted and skipped — a
 * hand tag is a person's answer, and a voided shipment is not work.
 */
async function retagShipments(input: Row, caller: Caller): Promise<Row> {
  const dryRun = optionalBoolean(input.dryRun) ?? true
  const [shipments, orders, loads, legs, drivers] = await Promise.all([
    scanTable(SHIPMENT_TABLE_NAME),
    scanTable(ORDER_TABLE_NAME),
    scanTable(LOAD_TABLE_NAME),
    scanTable(LOAD_CARRIER_TABLE_NAME),
    scanTable(DRIVER_TABLE_NAME),
  ])
  const taxonomy = await loadTaxonomy(ownershipDeps)

  const orderOf = new Map<string, Row>()
  for (const order of orders) {
    const key = String(order.shipmentId ?? '')
    if (key && !orderOf.has(key)) orderOf.set(key, order)
  }
  const loadOf = new Map<string, Row>()
  for (const load of loads) {
    const key = String(load.shipmentId ?? '')
    if (!key) continue
    const held = loadOf.get(key)
    if (!held || Number(load.leg ?? 0) < Number(held.leg ?? 0)) loadOf.set(key, load)
  }
  const legOf = new Map<string, Row>()
  for (const leg of legs) {
    const key = String(leg.loadId ?? '')
    if (key && leg.status === 'ACTIVE') legOf.set(key, leg)
  }
  const driverOf = new Map<string, Row>()
  for (const driver of drivers) driverOf.set(String(driver.id), driver)

  const report = {
    dryRun,
    scanned: 0,
    changed: 0,
    byDivision: {} as Record<string, number>,
    bySubdivision: {} as Record<string, number>,
    handTagged: 0,
  }
  let writes: TransactWriteItem[] = []
  const flush = async (): Promise<void> => {
    if (dryRun || writes.length === 0) return
    await transact(writes, 'retag')
    writes = []
  }

  for (const shipment of shipments) {
    if (isVoided(shipment)) continue
    report.scanned++
    if (shipment.revTagSource === 'HAND') {
      report.handTagged++
      const held = optionalString(shipment.revDivision, 60)
      const heldSub = optionalString(shipment.revSubdivision, 60)
      if (held) report.byDivision[held] = (report.byDivision[held] ?? 0) + 1
      if (heldSub) report.bySubdivision[heldSub] = (report.bySubdivision[heldSub] ?? 0) + 1
      continue
    }
    const shipmentId = String(shipment.id)
    const load = loadOf.get(shipmentId) ?? null
    const leg = load ? legOf.get(String(load.id)) ?? null : null
    const driverId = typeof leg?.driverId === 'string' ? leg.driverId : ''
    const resolved = tagFor(taxonomy, contextOf({
      shipment,
      order: orderOf.get(shipmentId) ?? null,
      load,
      loadCarrier: leg,
      driver: driverId ? driverOf.get(driverId) ?? null : null,
    })).tag
    const heldDivision = shipment.revTagSource === 'INTAKE' ? optionalString(shipment.revDivision, 60) : null
    const tagSource: 'RULE' | 'INTAKE' = heldDivision ? 'INTAKE' : 'RULE'
    const tag: ShipmentTag = heldDivision
      ? (() => {
        const h = holdDivision(heldDivision, { revDivision: resolved.revDivision, revSubdivision: resolved.revSubdivision, ruleId: resolved.revRuleId })
        return { revDivision: h.revDivision, revSubdivision: h.revSubdivision, revRuleId: h.ruleId }
      })()
      : resolved
    if (tag.revDivision) report.byDivision[tag.revDivision] = (report.byDivision[tag.revDivision] ?? 0) + 1
    if (tag.revSubdivision) report.bySubdivision[tag.revSubdivision] = (report.bySubdivision[tag.revSubdivision] ?? 0) + 1
    if (sameTag(shipment, tag, tagSource) && (load == null || sameTag(load, tag, tagSource))) continue

    report.changed++
    if (dryRun) continue
    const now = nowIso()
    writes.push(updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
      ...shipmentTagPatch(tag, tagSource, null),
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(shipment.version) ?? 1) + 1,
    }, null))
    if (load) {
      writes.push(updateItemTx(LOAD_TABLE_NAME, String(load.id), {
        ...tagPatch(tag, tagSource),
        updatedBy: caller.email,
        updatedAt: now,
      }, null))
    }
    if (writes.length >= RETAG_BATCH_ITEMS) await flush()
  }
  await flush()

  if (!dryRun) await writeAudit('SHIPMENT', 'RETAG', 'RETAG_SHIPMENTS', caller, report)
  return report as unknown as Row
}

// ── TENDER_RESPOND ───────────────────────────────────────────────────────────

async function tenderRespond(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const decision = assertEnum(input.decision, ['ACCEPT', 'REJECT', 'RESET'] as const, 'decision')
  const reason = optionalString(input.reason, 500)

  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  assertNotVoided(shipment)
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
    // Refused ahead of everything else: accepting a tender is undertaking to bill
    // it, and an unresolved shipment has nobody to bill.
    assertCustomerResolved(shipment, 'accepting the tender')
    if (current !== 'TENDER_PENDING') throw new Error('Only a pending tender can be accepted')
    const customer = await requireCustomer(shipment, 'accepting the tender')
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

/**
 * The plan, moved onto new dates. The facility events never travel — a copy has not
 * happened yet — but the driver does when the dispatcher asks for it: an own-fleet
 * calendar copy with the driver stripped lands in the unassigned lane, which is not
 * where the person who pressed Duplicate was looking.
 */
function shiftStops(
  stops: StopShape[],
  pickupAppt: string | null,
  deliveryAppt: string | null,
  keepDriver: boolean,
): StopShape[] {
  return stops.map((s) => {
    const next: StopShape = {
      ...s,
      id: `stp-${randomUUID()}`,
      arrivedAt: null,
      departedAt: null,
      ...(keepDriver ? {} : { driverId: null, truckId: null }),
    }
    if (s.type === 'pickup' && pickupAppt) next.appt = pickupAppt
    if (s.type === 'delivery' && deliveryAppt) next.appt = deliveryAppt
    return next
  })
}

async function duplicateShipment(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  // Which leg is being copied, and whether the driver comes with it. Both answer the
  // scheduler's Duplicate, which is pressed on one leg of a multi-leg shipment and by
  // a dispatcher looking at their own fleet's lane.
  const sourceLoadId = optionalString(input.loadId, 100)
  const keepDriver = optionalBoolean(input.keepDriver) ?? false
  // The shipment form's Duplicate: the copy starts with a BLANK customer ref (PO), which a person must type. Off by default, so the
  // board's and the calendar's Duplicate behave as before.
  // The customer ref (PO) is typed fresh on every copy (Ryne 2026-11-11): blank unless a caller explicitly asks to keep it.
  const clearReference = optionalBoolean(input.clearReference) ?? true
  const copies = assertArrayOf(input.copies, 'copies', (item, i) => {
    const c = assertRecord(item, `copies[${i}]`)
    return {
      pickupAppt: optionalIso(c.pickupAppt, `copies[${i}].pickupAppt`),
      deliveryAppt: optionalIso(c.deliveryAppt, `copies[${i}].deliveryAppt`),
    }
  }, MAX_DUPLICATE_COPIES)
  if (copies.length === 0) throw new Error('copies must have at least one entry')

  const source = await readBundle(shipmentId)
  assertNotVoided(source.shipment)
  // A copy of an unresolved shipment carries the same typed customer text forward and
  // stays unresolved; it does not get to invent a record the source never had.
  const customer = await activeCustomerOf(source.shipment)
  const settings = await getSettings()

  const sourceRevenue = source.orders.reduce((sum, o) => sum + (numberOrNull(o.revenueCents) ?? 0), 0)
  if (customer) {
    const summary = await creditSummary(customer, settings, sourceRevenue * copies.length)
    assertCreditClear(summary, String(customer.name ?? source.shipment.customerId))
  }

  const sourceOrder = source.orders[0]
  const sourceLoad = sourceLoadId
    ? source.loads.find((l) => String(l.id) === sourceLoadId)
    : source.loads[0]
  if (sourceLoadId && !sourceLoad) throw new Error(`Load ${sourceLoadId} is not a leg of shipment ${shipmentId}`)
  if (!sourceOrder || !sourceLoad) throw new Error('That shipment cannot be duplicated: it has no order or load')
  const sourceCharges = source.charges.map(chargeRowToInput)
  const sourceCustomerId = optionalString(source.shipment.customerId, 100)
  const sourceCustomerName = optionalString(source.shipment.customerName, 200)
  const client = await getDataClient()
  const created: string[] = []

  // Step W. The driver only travels when the source names a real, usable roster driver:
  // a truck alone, a broker placeholder or an inactive driver leaves the copy uncovered
  // rather than an Ivan Cartage load nobody is on.
  let keptDriverId: string | null = null
  if (keepDriver) {
    const sourceLegacy = deriveLegacyFields(readStops(sourceLoad))
    const candidate = optionalString(sourceLegacy.pickupDriverId, 100) ?? optionalString(sourceLegacy.deliveryDriverId, 100)
    if (candidate && driverProblem(candidate, (await getById(DRIVER_TABLE_NAME, candidate)) as RosterDriverFacts | null) == null) {
      keptDriverId = candidate
    }
  }
  for (const copy of copies) {
    const number = await nextShipmentNumber(caller)
    const newShipmentId = `shp-${randomUUID()}`
    const newOrderId = `ord-${randomUUID()}`
    const newLoadId = `lod-${randomUUID()}`
    const stops = shiftStops(readStops(sourceLoad), copy.pickupAppt, copy.deliveryAppt, keptDriverId != null)
    const now = nowIso()

    const charges = sourceCharges.filter((c) => c.side === 'CUSTOMER').map((c) => ({
      ...c,
      id: null,
      loadId: newLoadId,
      loadCarrierId: null,
    }))

    const { amounts, totals } = priceFor(
      charges,
      { miles: numberOrNull(sourceLoad.miles), weightLbs: numberOrNull(sourceLoad.weight) },
      pricingDefaultsOf(customer),
      marginFloorBpsOf(settings),
    )
    const legacy = deriveLegacyFields(stops)
    const mirrors = shipmentMirrors([{ stops: JSON.stringify(stops) }])
    // An own-fleet copy that kept its driver is already covered by our own asset;
    // leaving it NEED_TO_COVER would file it in the uncovered lane, away from the
    // calendar row the dispatcher pressed Duplicate on. A truck alone is not a driver:
    // the copy is only an Ivan Cartage load when a real, usable roster driver rides
    // along (and then it gets its own leg, below).
    const keptDriver = keptDriverId != null
    // The copy's PRO is derived from its own number and claimed like any other.
    // There is no `-copy` PRO any more: the second duplicate would collide with it.
    const pro = derivedLegPro(settings, number, 1)

    const shipmentRow: Row = {
      ...source.shipment,
      // Imported history is history: the copy is live freight and never inherits the waiver.
      legacyImported: null,
      legacySource: null,
      importRunId: null,
      id: newShipmentId,
      __typename: 'Shipment',
      number,
      status: 'OPEN',
      previousStatus: null,
      statusChangedAt: now,
      statusChangedBy: caller.email,
      holdReason: null,
      cancelReason: null,
      tenderRejectReason: null,
      customerLinkId: null,
      customerLinkSentAt: null,
      deliveredAt: null,
      lastNoticeAt: null,
      lastNoticeStatus: null,
      datPostedAt: null,
      workflowRunId: null,
      parentShipmentId: null,
      // Execution and accounting state never travel; the commercial division does.
      deletedAt: null,
      deletedBy: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
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
    // The copy keeps its source's tracker; a source with none falls back to the customer's default.
    shipmentRow.trackerId = optionalString(source.shipment.trackerId, 100)
      ?? (sourceCustomerId ? await activeProfileIdOrNull((await getById(CUSTOMER_TABLE_NAME, sourceCustomerId))?.defaultTrackerId) : null)
    shipmentRow.searchKey = buildSearchKey(shipmentRow, [sourceOrder], [{ stops: JSON.stringify(stops) }])

    const orderRow: Row = {
      ...sourceOrder,
      id: newOrderId,
      __typename: 'Order',
      shipmentId: newShipmentId,
      ...(clearReference
        ? { references: (Array.isArray(sourceOrder.references) ? (sourceOrder.references as Row[]) : []).filter((r) => String(r?.code ?? '').trim().toUpperCase() !== 'PO') }
        : {}),
      customerRateCents: totals.customerRateCents,
      revenueCents: totals.revenueCents,
      arStatus: 'DOCS_NEEDED',
      arStatusChangedAt: now,
      invoiceId: null,
      readyToInvoiceAt: null,
      invoiceNumber: null,
      invoicedAt: null,
      paidAt: null,
      arBalanceCents: null,
      factoringItemId: null,
      docsMissing: null,
      docsCheckedAt: null,
      docsOverrideAt: null,
      docsOverrideBy: null,
      docsOverrideNote: null,
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
    writes.unshift(proClaimPut(pro, {
      loadId: newLoadId,
      shipmentId: newShipmentId,
      claimedBy: caller.email,
      origin: 'DUPLICATE',
    }))
    await transact(writes, 'shipment', { refusals: [proAlreadyIssuedMessage(pro)] })

    assertLoadWriteOk(
      await client.models.Load.create({
        ...buildLoadInput(
          {
            id: newLoadId,
            shipmentId: newShipmentId,
            orderId: newOrderId,
            shipmentNumber: number,
            proScheme: proSchemeOf(settings),
            leg: 1,
            customerId: sourceCustomerId ?? undefined,
            customerName: sourceCustomerName,
            stops,
            rateCents: totals.revenueCents,
            equipmentType: optionalString(sourceOrder.equipmentType, 80),
            divisionKey: optionalString(sourceLoad.divisionKey, 100),
            carrierRepId: optionalString(sourceLoad.carrierRepId, 100),
            status: keptDriver ? 'BOOKED' : 'SOURCING',
          },
          caller,
        ),
        revDivision: source.shipment.revDivision ?? null,
        revSubdivision: source.shipment.revSubdivision ?? null,
        revTagSource: source.shipment.revTagSource ?? null,
        revRuleId: source.shipment.revRuleId ?? null,
        salesRepId: source.shipment.salesRepId ?? null,
        miles: numberOrNull(sourceLoad.miles),
        weight: numberOrNull(sourceLoad.weight),
        commodity: optionalString(sourceLoad.commodity, 200),
        truckId: keptDriver ? optionalString(sourceLoad.truckId, 100) : null,
        assignmentType: keptDriver ? 'OWN_ASSET' : 'NEED_TO_COVER',
        activeLoadCarrierId: null,
        carrierName: null,
        pickupMonth: monthOf(legacy.pickupAppt as string),
      }),
      'Load create',
    )
    if (keptDriverId) {
      // The copy is a fresh load, so the pay lock does not apply. A relay source copies
      // as one driver on every stop (the TMS rule: one driver per Ivan Cartage load).
      await assignAssetCore({
        loadId: newLoadId,
        driverId: keptDriverId,
        truckId: optionalString(sourceLoad.truckId, 100),
        trailerNumber: optionalString(sourceLoad.trailerNumber, 40),
        flattenSplit: true,
      }, caller, { skipPayLock: true })
    }
    await writeAudit('SHIPMENT', newShipmentId, 'DUPLICATE_SHIPMENT', caller, {
      sourceShipmentId: shipmentId, sourceNumber: source.shipment.number, number, pro,
    })
    created.push(newShipmentId)
  }

  await writeAudit('SHIPMENT', shipmentId, 'DUPLICATE_SHIPMENT', caller, { copies: created.length, created })
  // Every action answers with the bundle of the shipment it was asked about; the
  // board re-reads itself to pick up the new copies. `created` rides alongside it
  // because the scheduler's Duplicate opens the drawer on the copy it just made,
  // and the copy's id reaches nobody through the source's bundle.
  return { ...(await readBundle(shipmentId)), created } as unknown as Row
}

// ── SET_SHIPMENT_CUSTOMER ────────────────────────────────────────────────────

/**
 * Shared write that points a Shipment, its Orders and the mirrored Loads at one
 * customer. Used by both the first link (`SET_SHIPMENT_CUSTOMER`) and the admin
 * correction that re-points freight after it was linked (`REPOINT_SHIPMENT_CUSTOMER`).
 * The rep only ever fills a blank: a shipment or order that already has a sales rep
 * keeps the rep it has.
 */
async function writeCustomerToBundle(
  shipmentId: string,
  customer: Row,
  caller: Caller,
  expectedUpdatedAt: string | null,
  opts: { replaceBillTo?: boolean } = {},
): Promise<void> {
  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  const settings = await getSettings()
  const policy = resolveCreditPolicy(customer as unknown as CustomerRecord, settings as unknown as TmsSettingsRecord | null)
  if (policy.freeCreditRequired && policy.creditLimitCents == null) {
    throw new Error(`${String(customer.name ?? customer.id)} requires an approved credit limit before an order can be built`)
  }

  const customerId = String(customer.id)
  const customerName = optionalString(customer.name, 200)
  const defaults = customerDefaultsOf(customer)
  const defaultRepId = optionalString(defaults.salesRepId, 100)
  const now = nowIso()
  const linked: Row = { ...shipment, customerId, customerName }
  const takesRep = defaultRepId != null && optionalString(shipment.salesRepId, 100) == null
  // The customer's default tracker fills a blank; it never replaces a tracker already set.
  const takesTracker = optionalString(shipment.trackerId, 100) == null
  const defaultTrackerId = takesTracker ? await activeProfileIdOrNull(customer.defaultTrackerId) : null
  await transact(
    [
      updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
        customerId,
        customerName,
        searchKey: buildSearchKey(linked, bundle.orders, bundle.loads),
        ...(takesRep ? { salesRepId: defaultRepId } : {}),
        ...(defaultTrackerId ? { trackerId: defaultTrackerId } : {}),
        updatedBy: caller.email,
        updatedAt: now,
        version: (numberOrNull(shipment.version) ?? 1) + 1,
      }, expectedUpdatedAt),
      ...bundle.orders.map((order) => updateItemTx(ORDER_TABLE_NAME, String(order.id), {
        customerId,
        customerName,
        ...(defaultRepId != null && optionalString(order.customerRepId, 100) == null
          ? { customerRepId: defaultRepId }
          : {}),
        // A first link only fills a blank Bill to. Moving freight to ANOTHER customer re-points Bill to as well: the old customer's party must
        // not stay on the order (Ryne 2026-11-11), so it becomes the new customer's default party, or none.
        ...(opts.replaceBillTo
          ? { billToId: defaults.billToId ?? null }
          : defaults.billToId != null && optionalString(order.billToId, 100) == null
            ? { billToId: defaults.billToId }
            : {}),
        updatedBy: caller.email,
        updatedAt: now,
        version: (numberOrNull(order.version) ?? 1) + 1,
      }, null)),
    ],
    'shipment customer',
  )

  const client = await getDataClient()
  for (const load of bundle.loads) {
    assertLoadWriteOk(
      await client.models.Load.update({
        id: String(load.id),
        customerId,
        customer: customerName,
        updatedBy: caller.email,
      }),
      'Load update',
    )
  }

  // An ownership rule may key on the customer, so the tag is re-resolved from what
  // the shipment says now rather than from what it said before.
  await applyTagToLoads(shipmentId, caller)
}

/**
 * Step R cutover. The only writer of customer identity on freight that already
 * exists, and the way an unresolved shipment stops being unresolved.
 *
 * It runs exactly the checks CREATE_SHIPMENT runs — ACTIVE, and an approved limit
 * for a customer who may not ship on open credit — and then writes the link in one
 * place each: the Shipment, every Order under it and every leg's mirror. Nothing
 * here invents a customer; the id named has to be a record that already exists.
 *
 * Resolution happens once. Re-pointing freight that is already linked at a
 * different customer moves somebody's revenue onto somebody else's ledger, and the
 * invoice, the credit exposure and the commission behind it all moved with it; that
 * is a correction somebody has to make deliberately, not a link action.
 */
async function setShipmentCustomer(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const customerId = assertString(input.customerId, 'customerId')

  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  assertNotVoided(shipment)
  if (!isCustomerUnresolved(shipment as unknown as CustomerResolvable)) {
    throw new Error(
      `${String(shipment.number ?? shipmentId)} is already linked to a customer. Linking happens once — moving freight to a different customer is a correction, not a link, and is out of this action's scope.`,
    )
  }

  const customer = await getActiveCustomer(customerId)
  await writeCustomerToBundle(shipmentId, customer, caller, null)
  await writeAudit('SHIPMENT', shipmentId, 'SET_SHIPMENT_CUSTOMER', caller, {
    customerId,
    customerName: optionalString(customer.name, 200),
    orders: bundle.orders.length,
    loads: bundle.loads.length,
  })
  return readBundle(shipmentId) as unknown as Row
}

/**
 * Step R. Re-point a linked shipment's customer. Owner/ADMIN only: this moves revenue
 * that may already be committed, so it is audited and refused once an order has
 * been invoiced. The invoiced path is handled by `REPOINT_INVOICED_CUSTOMER` in
 * tms-finance-actions, which credits the original invoice and rebills the new customer.
 */
async function repointShipmentCustomer(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const customerId = assertString(input.customerId, 'customerId')
  const reason = assertString(input.reason, 'reason')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)

  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  assertNotVoided(shipment)
  if (isCustomerUnresolved(shipment as unknown as CustomerResolvable)) {
    throw new Error(
      `${String(shipment.number ?? shipmentId)} has no customer yet. Use SET_SHIPMENT_CUSTOMER to link it to a customer.`,
    )
  }

  const orders = await queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const invoiced = orders.find((order) => order.arStatus === 'UNPAID' || order.arStatus === 'PAID')
  if (invoiced) {
    const label = optionalString(invoiced.invoiceNumber, 100) ?? optionalString(invoiced.invoiceId, 100) ?? 'an invoice'
    throw new Error(
      `INVOICED: This shipment has invoice ${label}; re-point an invoiced shipment by crediting the original invoice and rebilling the new customer.`,
    )
  }

  const fromCustomerId = String(shipment.customerId)
  const fromCustomerName = optionalString(shipment.customerName, 200)
  const customer = await getActiveCustomer(customerId)
  const customerName = optionalString(customer.name, 200)
  await writeCustomerToBundle(shipmentId, customer, caller, expectedUpdatedAt, { replaceBillTo: true })
  await writeAudit('SHIPMENT', shipmentId, 'REPOINT_SHIPMENT_CUSTOMER', caller, {
    fromCustomerId,
    fromCustomerName,
    customerId,
    customerName,
    reason,
    orders: bundle.orders.length,
    loads: bundle.loads.length,
  })
  return readBundle(shipmentId) as unknown as Row
}

// ── SET_LOAD_PRO ─────────────────────────────────────────────────────────────

/**
 * The only legal way a PRO ever changes, now that `aljexId` is read-only to every
 * client token (`resource.ts`, the `voidedAt` precedent).
 *
 * The new PRO is claimed with the same conditional put a create uses, and the old
 * claim is left exactly where it is: a PRO that was ever issued stays issued, so
 * the number this leg used to carry can never be handed to anything else.
 */
async function setLoadPro(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const pro = assertString(input.pro, 'pro')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  if (String(load.updatedAt ?? '') !== expectedUpdatedAt) throw conflictError('load', null)
  assertNotVoided(load)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (shipmentId) await requireLiveShipment(shipmentId)

  const settings = await getSettings()
  assertNotDerivedPro(pro, settings)
  const claimKey = proClaimKey(pro)
  // The read is a courtesy so the common case reads well; the conditional put below
  // is the rule, and it is what two dispatchers racing each other actually hit.
  if (await getById(PRO_CLAIM_TABLE_NAME, claimKey)) throw new Error(proAlreadyIssuedMessage(pro))
  await transact(
    [proClaimPut(pro, { loadId, shipmentId, claimedBy: caller.email, origin: 'SET_LOAD_PRO' })],
    'pro claim',
    { refusals: [proAlreadyIssuedMessage(pro)] },
  )

  const previous = optionalString(load.aljexId, 120)
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({ id: loadId, aljexId: pro.trim(), updatedBy: caller.email }),
    'Load update',
  )
  await writeAudit('LOAD', loadId, 'SET_LOAD_PRO', caller, { from: previous, to: pro.trim(), shipmentId })
  return {
    bundle: shipmentId ? await readBundle(shipmentId) : null,
    load: await getById(LOAD_TABLE_NAME, loadId),
  } as unknown as Row
}

// ── SET_LOAD_REFS ────────────────────────────────────────────────────────────

/** The two order references the shipment form owns: Customer Ref # (code PO, the calendar's TMS #) and Pickup # (code pickup, the calendar's PU #). */
const REF_CUSTOMER_CODE = 'PO'
const REF_PICKUP_CODE = 'pickup'

/** Pure: the order's references with one managed code set to `value` (added when absent, dropped when blank). */
export function withManagedReference(references: readonly Row[], code: string, value: string): Row[] {
  const trimmed = value.trim()
  const rest = references.filter((r) => String(r.code) !== code)
  if (!trimmed) return rest
  const label = code === REF_CUSTOMER_CODE ? 'Ref #' : 'Pickup #'
  const existing = references.find((r) => String(r.code) === code)
  const next: Row = existing ? { ...existing, value: trimmed } : { code, label, value: trimmed, level: 'ORDER', visibility: code === REF_CUSTOMER_CODE ? 'CUSTOMER' : 'ALL' }
  const at = references.findIndex((r) => String(r.code) === code)
  return at >= 0 ? [...rest.slice(0, at), next, ...rest.slice(at)] : [...rest, next]
}

/** The Load.tmsId / pickupNumber a set of order references implies (only for a code that is present). */
export function loadRefsFromReferences(references: readonly Row[]): Row {
  const out: Row = {}
  for (const [code, field] of [[REF_CUSTOMER_CODE, 'tmsId'], [REF_PICKUP_CODE, 'pickupNumber']] as const) {
    const hit = references.find((r) => String(r.code) === code && String(r.value ?? '').trim())
    if (hit) out[field] = String(hit.value).trim()
  }
  return out
}

/**
 * TMS # (the shipment's customer reference) and PU # (its pickup reference), edited from the calendar. Both are read-only to a
 * client Load write, so they go through here: written to the order's references (what the Shipments page shows) AND to the
 * load's own copy (what the calendar column reads), so the two never disagree. A blank one clears the reference; the load copy
 * then falls back to the PRO, as it does at create.
 */
async function setLoadRefs(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const tmsId = input.tmsId === undefined ? undefined : optionalString(input.tmsId, 120) ?? ''
  const pickupNumber = input.pickupNumber === undefined ? undefined : optionalString(input.pickupNumber, 120) ?? ''
  if (tmsId === undefined && pickupNumber === undefined) throw new Error('Nothing to change: send tmsId and/or pickupNumber')

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  assertNotVoided(load)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (shipmentId) await requireLiveShipment(shipmentId)

  const pro = optionalString(load.aljexId, 120) ?? ''
  const patch: Row = { id: loadId, updatedBy: caller.email }
  if (tmsId !== undefined) patch.tmsId = tmsId.trim() || pro
  if (pickupNumber !== undefined) patch.pickupNumber = pickupNumber.trim() || pro

  const orderId = optionalString(load.orderId, 100)
  const order = orderId ? await getById(ORDER_TABLE_NAME, orderId) : null
  if (order) {
    if (order.invoiceId) throw new Error(`This order has invoice ${optionalString(order.invoiceNumber, 100) ?? String(order.invoiceId)}; its references can no longer be changed`)
    let references: Row[] = Array.isArray(order.references) ? (order.references as Row[]) : []
    if (tmsId !== undefined) references = withManagedReference(references, REF_CUSTOMER_CODE, tmsId)
    if (pickupNumber !== undefined) references = withManagedReference(references, REF_PICKUP_CODE, pickupNumber)
    await transact([updateItemTx(ORDER_TABLE_NAME, String(order.id), { references, updatedBy: caller.email, updatedAt: nowIso(), version: (numberOrNull(order.version) ?? 1) + 1 }, null)], 'order references')
  }
  const client = await getDataClient()
  assertLoadWriteOk(await client.models.Load.update(patch), 'Load update')
  await writeAudit('LOAD', loadId, 'SET_LOAD_REFS', caller, {
    ...(tmsId !== undefined ? { tmsId: { from: load.tmsId ?? null, to: patch.tmsId } } : {}),
    ...(pickupNumber !== undefined ? { pickupNumber: { from: load.pickupNumber ?? null, to: patch.pickupNumber } } : {}),
    shipmentId,
  })
  return {
    bundle: shipmentId ? await readBundle(shipmentId) : null,
    load: await getById(LOAD_TABLE_NAME, loadId),
  } as unknown as Row
}

// ── SET_STOP_DRIVERS ─────────────────────────────────────────────────────────

/**
 * Put a roster driver (or nobody) on individual stops of an own-fleet or unassigned load, and keep the load's pickup/delivery
 * driver mirrors in step. The whole-load "one driver for everything" case is ASSIGN_ASSET (it books the truck and the
 * leg); this is what remains: take the driver off, or a relay with a different driver per stop. The mirrors are read-only
 * to a client Load write, so the client cannot do this itself.
 */
async function setStopDrivers(input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const assignments = assertArrayOf(input.assignments, 'assignments', (item, i) => {
    const r = assertRecord(item, `assignments[${i}]`)
    return { stopId: assertString(r.stopId, `assignments[${i}].stopId`), driverId: optionalString(r.driverId, 100) }
  }) as unknown as { stopId: string; driverId: string | null }[]
  if (assignments.length === 0) throw new Error('Nothing to change: send assignments')

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  assertNotVoided(load)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (shipmentId) await requireLiveShipment(shipmentId)
  const assignmentType = String(load.assignmentType ?? '')
  if (assignmentType && assignmentType !== 'OWN_ASSET' && assignmentType !== 'NEED_TO_COVER') {
    throw new Error('This load is covered by an outside carrier: its driver is edited on the carrier card, not on the calendar')
  }

  // An old load with no stored stops is read as a pickup and a delivery (the ids the calendar uses for it); its drivers live on the two
  // mirrors only, so that is all that is written for it.
  const stored = readStops(load)
  const synthetic = stored.length === 0
  const stops: Row[] = synthetic
    ? [
        { id: `${loadId}:pu`, type: 'pickup', sequence: 0, driverId: optionalString(load.pickupDriverId, 100) },
        { id: `${loadId}:de`, type: 'delivery', sequence: 1, driverId: optionalString(load.deliveryDriverId, 100) },
      ]
    : (stored as unknown as Row[])
  for (const a of assignments) if (!stops.some((s) => String(s.id) === a.stopId)) throw new Error(`Stop not found on this load: ${a.stopId}`)
  for (const id of new Set(assignments.map((a) => a.driverId).filter((v): v is string => v != null))) {
    const problem = driverProblem(id, (await getById(DRIVER_TABLE_NAME, id)) as RosterDriverFacts | null)
    if (problem) throw new Error(problem)
  }
  const byStop = new Map(assignments.map((a) => [a.stopId, a.driverId]))
  const nextStops = stops.map((s) => (byStop.has(String(s.id)) ? { ...s, driverId: byStop.get(String(s.id)) ?? null } : s))
  const mirrors: Row = synthetic
    ? { pickupDriverId: (nextStops[0]!.driverId as string | null) ?? null, deliveryDriverId: (nextStops[1]!.driverId as string | null) ?? null }
    : deriveLegacyFields(nextStops as unknown as StopShape[])

  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadId,
      ...(synthetic ? {} : { stops: JSON.stringify(nextStops) }),
      pickupDriverId: mirrors.pickupDriverId ?? null,
      deliveryDriverId: mirrors.deliveryDriverId ?? null,
      updatedBy: caller.email,
    }),
    'Load update',
  )
  await writeAudit('LOAD', loadId, 'SET_STOP_DRIVERS', caller, {
    stops: assignments.map((a) => ({ stopId: a.stopId, driverId: a.driverId })),
    pickupDriverId: mirrors.pickupDriverId ?? null,
    deliveryDriverId: mirrors.deliveryDriverId ?? null,
    shipmentId,
  })
  return {
    bundle: shipmentId ? await readBundle(shipmentId) : null,
    load: await getById(LOAD_TABLE_NAME, loadId),
  } as unknown as Row
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
  if (shipmentId) await requireLiveShipment(shipmentId)

  // A legacy load with no stops array yet: the two stops the form shows (pickup and delivery from the old fields, ids `<loadId>:pu` / `:de`).
  let stops = readStops(load)
  if (stops.length === 0) stops = getStops(load as unknown as Load) as unknown as typeof stops
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
      // An actual time is something that already happened: a few minutes of clock skew, never the future.
      for (const [label, value] of [['arrived', arrivedAt], ['departed', departedAt]] as const) {
        if (value && Date.parse(value) > Date.now() + 5 * 60_000) throw new Error(`A stop cannot be ${label} in the future`)
      }
      // Against what is already on the stop: a new out time may not precede the stop's existing in time, and the reverse.
      const existing = stops[i]
      const inAt = arrivedAt ?? (patch.arrivedAt === null ? null : String(existing.arrivedAt ?? '') || null)
      const outAt = departedAt ?? (patch.departedAt === null ? null : String(existing.departedAt ?? '') || null)
      if (inAt && outAt && Date.parse(outAt) < Date.parse(inAt)) throw new Error('A stop cannot be departed before it was arrived')
      const before = stops[i]
      if (arrivedAt && !String(before.arrivedAt ?? '').trim()) {
        newStamps.push({ stopId: String(before.id), event: 'ARRIVED', at: arrivedAt })
      }
      if (departedAt && !String(before.departedAt ?? '').trim()) {
        newStamps.push({ stopId: String(before.id), event: 'DEPARTED', at: departedAt })
      }
      // Whatever a person sets here is MANUAL, and the driver app / tracking link will not overwrite it; clearing a time clears its source.
      stops = stops.map((s, idx) => idx === i ? {
        ...s,
        arrivedAt: arrivedAt ?? (patch.arrivedAt === null ? null : s.arrivedAt ?? null),
        departedAt: departedAt ?? (patch.departedAt === null ? null : s.departedAt ?? null),
        arrivedSource: arrivedAt ? 'MANUAL' : patch.arrivedAt === null ? null : s.arrivedSource ?? null,
        departedSource: departedAt ? 'MANUAL' : patch.departedAt === null ? null : s.departedSource ?? null,
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
        contact: patch.contact == null ? s.contact ?? null : replaceContact(patch.contact, s.contact, 'patch.contact'),
      } : s)
      break
    }
    case 'SET_DETAILS': {
      const i = indexOfStop()
      const details = validateStopDetailsPatch(patch)
      stops = stops.map((s, idx) => idx === i ? { ...s, ...details } : s)
      break
    }
  }

  stops = resequence(stops)
  // Step W. A stop added, removed, retyped or swapped on an Ivan Cartage load that has not
  // been delivered yet inherits the leg's driver and truck, so the mirrors the Schedule and
  // pay read do not lose the driver. Delivered history is never touched.
  if (['ADD', 'REMOVE', 'SET_TYPE', 'SWAP'].includes(op) && String(load.assignmentType ?? '') === 'OWN_ASSET'
    && !isDeliveredOrLater(load.status) && !load.voidedAt) {
    const legs = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
    const leg = legs.find((c) => c.status === 'ACTIVE' && c.kind === 'OWN_ASSET') ?? null
    const legDriver = leg ? optionalString(leg.driverId, 100) : null
    if (legDriver) {
      stops = fillBlankStopDrivers(stops, legDriver, optionalString(leg!.truckId, 100) ?? optionalString(load.truckId, 100))
    }
  }
  assertStopShape(stops, false)
  const legacy = deriveLegacyFields(stops)

  // Stop times are the one thing that moves a load forward on its own: a truck that
  // has left the pickup is in transit whatever anybody typed.
  const currentStatus = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  const derivedStatus = op === 'SET_TIMES'
    ? loadStatusFromStopTimes(stopTimesOf(stops), currentStatus)
    : currentStatus
  // Step W. Departing the last delivery with nobody on the truck is a delivery no
  // settlement would pick up: refuse before any tracking row is written.
  if (op === 'SET_TIMES' && derivedStatus === 'DELIVERED' && currentStatus !== 'DELIVERED') {
    const legs = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
    await assertOwnAssetDriver(load, legs.find((c) => c.status === 'ACTIVE') ?? null, 'DELIVERED', optionalString(legacy.deliveryDriverId, 100))
  }

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

/**
 * Step W. The one place an Ivan Cartage load's driver is decided on the server. `phase`
 * DISPATCH also needs the driver to be usable; DELIVERED only that somebody is on it.
 */
async function assertOwnAssetDriver(
  load: Row,
  active: Row | null,
  phase: 'DISPATCH' | 'DELIVERED',
  deliveryDriverId?: string | null,
): Promise<void> {
  const facts = { ...load, stops: readStops(load) } as unknown as OwnAssetLoadFacts
  const leg = active as unknown as OwnAssetLegFacts | null
  let driver: RosterDriverFacts | null | undefined
  const legDriverId = active ? optionalString(active.driverId, 100) : null
  if (phase === 'DISPATCH' && legDriverId && isOwnAssetLoad(facts, leg)) {
    driver = (await getById(DRIVER_TABLE_NAME, legDriverId)) as RosterDriverFacts | null
  }
  const gap = ownAssetDriverGap({ load: facts, activeLeg: leg, driver, phase, deliveryDriverId })
  if (gap) throw new Error(gap.message)
}

/** Step AQ. Unit numbers for Equipment ids (active units only). Empty until EQUIPMENT_TABLE_NAME is wired. */
async function ownFleetUnits(ids: Array<unknown>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!EQUIPMENT_TABLE_NAME) return out
  for (const id of new Set(ids.map((v) => optionalString(v, 100)).filter((v): v is string => v != null))) {
    const row = await getById(EQUIPMENT_TABLE_NAME, id)
    const unit = optionalString(row?.unitNumber, 40)
    if (unit && row?.active !== false) out.set(id, unit)
  }
  return out
}

/** Step AQ. The Driver record for an own-fleet driver id, with phone, truck # and trailer # filled from it. */
async function ownFleetDriverRecord(
  driverId: string, asked: { driverPhone?: string | null; truckNumber?: string | null; trailerNumber?: string | null } = {},
): Promise<{ driverName: string; driverPhone: string | null; truckNumber: string | null; trailerNumber: string | null }> {
  const driver = (await getById(DRIVER_TABLE_NAME, driverId)) as OwnFleetDriverSource | null
  const units = await ownFleetUnits([driver?.assignedTruckId, driver?.assignedTrailerId])
  const r = resolveOwnFleetDriver(driverId, driver, asked, (id) => units.get(id) ?? null)
  return { driverName: r.driverName, driverPhone: r.driverPhone, truckNumber: r.truckNumber, trailerNumber: r.trailerNumber }
}

/**
 * Step AQ. Driver fields for an Ivan Cartage assignment written outside ASSIGN_ASSET (ENTER_DRIVER_INFO,
 * UPDATE_LOAD_CARRIER_DETAILS, BOOK_CARRIER). `typed` is what the caller typed: with no `driverId`, a
 * typed driver name is refused; with one, the Driver record answers and fills what was left blank.
 */
async function ownFleetDriverPatch(input: Row, typed: Row): Promise<Row> {
  if (typed.driver2Name || typed.driver2Phone) throw new Error(OWN_ASSET_MESSAGES.freeTextDriver)
  const driverId = optionalString(input.driverId, 100)
  if (!driverId) {
    if (typed.driverName) throw new Error(OWN_ASSET_MESSAGES.freeTextDriver)
    return {}
  }
  return ownFleetDriverRecord(driverId, {
    driverPhone: optionalString(input.driverPhone, 40),
    truckNumber: optionalString(input.truckNumber, 40),
    trailerNumber: optionalString(input.trailerNumber, 40),
  })
}

async function driverLabel(id: string | null): Promise<string> {
  if (!id) return 'nobody'
  const row = await getById(DRIVER_TABLE_NAME, id)
  return optionalString(row?.name, 120) ?? id
}

async function assignAsset(input: Row, caller: Caller): Promise<Row> {
  return assignAssetCore(input, caller, {})
}

/**
 * Step W. Book a roster driver on a load as Ivan Cartage. Every refusal happens before the
 * first write, so a refused call leaves Load, LoadCarrier and AuditLog untouched. The
 * Load fields written are exactly `ownFleetLoadPatch`'s (plus the colour reset on a real
 * driver change): no rate, date or invoice field moves.
 */
async function assignAssetCore(input: Row, caller: Caller, opts: { skipPayLock?: boolean }): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const driverId = assertString(input.driverId, 'driverId')
  const askedTruckId = optionalString(input.truckId, 100)
  const askedTrailerId = optionalString(input.trailerId, 100)
  const askedTruckNumber = optionalString(input.truckNumber, 40)
  const askedTrailerNumber = optionalString(input.trailerNumber, 40)
  const driver2 = input.driver2 == null ? null : assertRecord(input.driver2, 'driver2')
  const flattenSplit = optionalBoolean(input.flattenSplit) ?? false
  const payOverrideReason = optionalString(input.payOverrideReason, 500)

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')
  const shipment = await requireLiveShipment(shipmentId)

  // The roster row is the truth for who this is: the client's typed name is never used.
  const driver = await getById(DRIVER_TABLE_NAME, driverId)
  const problem = driverProblem(driverId, driver as RosterDriverFacts | null)
  if (problem) throw new Error(problem)
  const driverName = optionalString(driver!.name, 120) ?? driverId
  const driverPhone = optionalString(driver!.phone, 40)
  // Step AQ. Truck and trailer default to the ones on the driver record; a second driver is a
  // record too, never a typed name.
  const units = await ownFleetUnits([askedTruckId, askedTrailerId, driver!.assignedTruckId, driver!.assignedTrailerId])
  const filled = resolveOwnFleetDriver(driverId, driver as unknown as OwnFleetDriverSource | null, {
    truckId: askedTruckId, truckNumber: askedTruckNumber, trailerId: askedTrailerId, trailerNumber: askedTrailerNumber,
  }, (id) => units.get(id) ?? null)
  const { truckId, truckNumber, trailerId, trailerNumber } = filled
  const driver2Id = driver2 == null ? null : optionalString(driver2.driverId, 100)
  if (driver2 != null && !driver2Id && (optionalString(driver2.name, 120) || optionalString(driver2.phone, 40))) {
    throw new Error(OWN_ASSET_MESSAGES.freeTextDriver)
  }
  const driver2Resolved = driver2Id ? await ownFleetDriverRecord(driver2Id) : null

  const carriers = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
  const activeCarrier = carriers.find((c) => c.status === 'ACTIVE') ?? null
  if (carriers.filter((c) => c.status === 'ACTIVE').length > 1) {
    throw new Error('Remove the extra carriers first: own fleet cannot share a load with outside carriers')
  }
  const activeOwn = activeCarrier && activeCarrier.kind === 'OWN_ASSET' ? activeCarrier : null
  const stopsBefore = readStops(load)

  // A relay is not flattened by accident.
  const stopDrivers = distinctStopDrivers(stopsBefore as OwnAssetLoadFacts['stops'])
  if (stopDrivers.length >= 2 && !flattenSplit) {
    throw new Error(OWN_ASSET_MESSAGES.relay(await driverLabel(stopDrivers[0]), await driverLabel(stopDrivers[1])))
  }

  const ownFleet = ownFleetLoadPatch(stopsBefore as MirrorStop[], {
    driverId,
    truckId: truckId ?? optionalString(load.truckId, 100),
    trailerNumber: trailerNumber ?? optionalString(load.trailerNumber, 40),
  })

  // Same driver, truck and trailer, mirrors already in step: nothing to do.
  const sameOr = (asked: string | null, held: unknown): boolean => asked == null || asked === (optionalString(held, 100) ?? null)
  if (
    activeOwn
    && optionalString(activeOwn.driverId, 100) === driverId
    && optionalString(activeOwn.driverName, 120) === driverName
    && sameOr(truckId, activeOwn.truckId) && sameOr(trailerId, activeOwn.trailerId)
    && sameOr(truckNumber, activeOwn.truckNumber) && sameOr(trailerNumber, activeOwn.trailerNumber)
    && String(load.assignmentType ?? '') === 'OWN_ASSET'
    && optionalString(load.pickupDriverId, 100) === ownFleet.pickupDriverId
    && optionalString(load.deliveryDriverId, 100) === ownFleet.deliveryDriverId
    && stopDrivers.length === 1 && stopDrivers[0] === driverId
  ) {
    return readBundle(shipmentId) as unknown as Row
  }

  const previousDriverId = (activeOwn ? optionalString(activeOwn.driverId, 100) : null)
    ?? optionalString(load.deliveryDriverId, 100)
    ?? optionalString(load.pickupDriverId, 100)
    ?? stopDrivers[0]
    ?? null
  const driverChanged = [previousDriverId, optionalString(load.pickupDriverId, 100), optionalString(load.deliveryDriverId, 100), ...stopDrivers]
    .some((id) => id != null && id !== driverId)

  // Pay lock: only a change of who gets paid for the delivery can move history.
  let payLock: { state: 'OPEN' | 'CLOSED_WEEK_OVERRIDE'; deliveryDate?: string; reason?: string } = { state: 'OPEN' }
  const movesPay = optionalString(load.deliveryDriverId, 100) !== driverId
  if (movesPay && !opts.skipPayLock) {
    const trips = await scanTable(BOX_TRUCK_TRIP_TABLE_NAME)
    const trip = trips.find((t) => String(t.loadId ?? '') === loadId) ?? null
    const oldDriverId = optionalString(load.deliveryDriverId, 100) ?? previousDriverId
    const lock = evaluatePayLock({
      deliveryAppt: optionalString(load.deliveryAppt, 40),
      todayUtc: nowIso().slice(0, 10),
      boxTrip: trip
        ? { periodStart: String(trip.periodStart ?? ''), driverName: await driverLabel(optionalString(trip.driverId, 100)) }
        : null,
      oldDriverName: await driverLabel(oldDriverId),
      newDriverName: driverName,
      isAdmin: caller.isAdmin,
      reason: payOverrideReason,
    })
    if (lock.state === 'REFUSED') throw new Error(lock.message)
    if (lock.state === 'CLOSED_WEEK_OVERRIDE') payLock = { state: lock.state, deliveryDate: lock.deliveryDate, reason: lock.reason }
  }

  const sequence = carriers.reduce((max, c) => Math.max(max, numberOrNull(c.sequence) ?? 0), 0) + 1
  const newCarrierId = `lcr-${randomUUID()}`
  const now = nowIso()

  const newLeg: Row = {
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
    driver2Name: driver2Resolved?.driverName ?? null,
    driver2Phone: driver2Resolved?.driverPhone ?? null,
    truckId,
    truckNumber,
    trailerId,
    trailerNumber,
    carrierRateCents: 0,
    costCents: 0,
    // No apStatus: an own-fleet leg is paid through a driver settlement and never
    // enters AP at all.
    createdBy: caller.email,
    updatedBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }
  const writes: TransactWriteItem[] = []
  if (activeCarrier) writes.push(retireCarrier(activeCarrier, 'REASSIGNED', 'BOUNCED', caller))
  writes.push(putItem(LOAD_CARRIER_TABLE_NAME, newLeg))
  await transact(writes, 'assignment')

  // The driver and truck live on the stops — exactly where the dispatch drawer puts
  // them — so every own-fleet reader keeps seeing the assignment it already
  // understands. `ownFleetLoadPatch` is that mapping, shared with the backfill so
  // one definition says what an own-fleet load looks like.
  const patchStops = driverChanged ? clearStopColors(ownFleet.stops) : ownFleet.stops
  const currentStatus = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  const nextStatus = currentStatus == null || currentStatus === 'SOURCING' ? 'BOOKED' : currentStatus
  // Step R. The leg is written, so the rules can now see whose truck this is — and
  // they see the row this call just put, not whatever the leg index is still
  // serving.
  const tag = await applyTag(await recordsForTag(shipment, load, newLeg), caller)

  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadId,
      ...ownFleet,
      stops: JSON.stringify(patchStops),
      // The Calendar prefers a stored colour over the driver's own, so a reassigned
      // load must drop the old one to show the new driver's.
      ...(driverChanged ? { colorKey: null } : {}),
      activeLoadCarrierId: newCarrierId,
      ...tag,
      ...(nextStatus !== currentStatus
        ? { status: nextStatus, statusChangedAt: now, statusChangedBy: caller.email, statusSource: 'USER' }
        : {}),
      updatedBy: caller.email,
    }),
    'Load update',
  )

  await writeAudit('LOAD_CARRIER', newCarrierId, 'ASSIGN_ASSET', caller, {
    loadId, driverId, driverName, truckId, truckNumber, trailerNumber, previousDriverId,
    // A closed-week override is a money decision: it is on this row even when there was no
    // previous driver, and so no CHANGE_ASSET_DRIVER row.
    payLock,
  })
  if (driverChanged) {
    const nameOf = (id: string | null, name: string): string => (id ? `${name} (${id})` : 'nobody')
    await writeAudit('LOAD', loadId, 'CHANGE_ASSET_DRIVER', caller, {
      loadId,
      driver: { from: nameOf(previousDriverId, await driverLabel(previousDriverId)), to: nameOf(driverId, driverName) },
      truck: {
        from: optionalString(activeOwn?.truckNumber, 40) ?? optionalString(load.truckId, 100),
        to: truckNumber ?? ownFleet.truckId,
      },
      trailer: {
        from: optionalString(activeOwn?.trailerNumber, 40) ?? optionalString(load.trailerNumber, 40),
        to: ownFleet.trailerNumber,
      },
      previousLegId: activeCarrier ? String(activeCarrier.id) : null,
      relayFlattened: stopDrivers.length >= 2,
      payLock,
    })
  }
  // Step H. A covered load never shows a live request.
  await cancelOpenOffers(quoteDeps, loadId, caller)
  return rederiveShipmentStatus(shipmentId, caller)
}

async function assignCarrier(input: Row, caller: Caller, options: { additional?: boolean } = {}): Promise<Row> {
  // A carrier out of the directory goes through the booking gate, which checks its
  // authority, insurance and documents before it is allowed to hold freight.
  if (input.carrierId != null) {
    throw new Error('Use BOOK_CARRIER for a directory carrier')
  }
  const loadId = assertString(input.loadId, 'loadId')
  const carrierName = assertString(input.carrierName, 'carrierName')
  if (/\bivan\s*cartage\b/i.test(carrierName)) throw new Error(OWN_ASSET_MESSAGES.typedIvanCartage)
  const carrierRateCents = optionalInteger(input.carrierRateCents, { min: 0, label: 'carrierRateCents' })

  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipmentId = optionalString(load.shipmentId, 100)
  if (!shipmentId) throw new Error('That load is not part of a shipment yet')
  const shipment = await requireLiveShipment(shipmentId)

  const carriers = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
  const additional = options.additional === true
  const live = liveRowsOf(carriers, loadId)
  if (!additional && live.length > 1) throw new Error(REMOVE_FIRST_MESSAGE)
  const legIds = additional
    ? assertAdditionalCarrier({ load, live, adding: { carrierId: null, carrierName }, legStopIds: input.legStopIds })
    : []
  const activeCarrier: Row | null = additional ? null : live[0] ?? null
  const sequence = carriers.reduce((max, c) => Math.max(max, numberOrNull(c.sequence) ?? 0), 0) + 1
  const newCarrierId = `lcr-${randomUUID()}`
  const now = nowIso()

  const financials = await getById(LOAD_FINANCIALS_TABLE_NAME, loadId)
  if (financials?.frozenAt) throw new Error('This load\'s financials are frozen and can no longer be changed')

  const newLeg: Row = {
    id: newCarrierId,
    __typename: 'LoadCarrier',
    loadId,
    shipmentId,
    kind: 'CARRIER',
    status: 'ACTIVE',
    sequence,
    ...(legIds.length > 0 ? { legStopIds: legIds } : {}),
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
  }
  const writes: TransactWriteItem[] = []
  if (activeCarrier) writes.push(retireCarrier(activeCarrier, 'REASSIGNED', 'BOUNCED', caller))
  writes.push(putItem(LOAD_CARRIER_TABLE_NAME, newLeg))
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
  // Step R. An outside carrier takes the load off the calendar, out of dispatch and
  // out of every driver settlement: whatever own-fleet assignment was on it before
  // has to be cleared, not merely overwritten with a carrier name.
  const cleared = additional && live.length > 0
    ? null
    : outsideCarrierLoadPatch(readStops(load) as MirrorStop[], { carrierName })
  // The leg this call just wrote is what the rules read; the leg index may still be
  // serving the one it retired.
  const tag = await applyTag(await recordsForTag(shipment, load, newLeg), caller)
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadId,
      ...(cleared ? { ...cleared, stops: JSON.stringify(cleared.stops) } : {}),
      ...(!additional || live.length === 0
        ? {
            activeLoadCarrierId: newCarrierId,
            trackingProvider: optionalEnum(input.trackingProvider, TRACKING_PROVIDERS, 'trackingProvider') ?? 'MANUAL',
          }
        : {}),
      ...tag,
      ...(nextStatus !== currentStatus
        ? { status: nextStatus, statusChangedAt: now, statusChangedBy: caller.email, statusSource: 'USER' }
        : {}),
      updatedBy: caller.email,
    }),
    'Load update',
  )

  await writeAudit('LOAD_CARRIER', newCarrierId, additional ? 'ADD_CARRIER' : 'ASSIGN_CARRIER', caller, {
    loadId, carrierName, carrierRateCents, ...(additional ? { legStopIds: legIds } : {}),
  })
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
  const shipment = await requireLiveShipment(shipmentId)
  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  // AT-plan D6: another live carrier keeps the load covered; only the pointers move.
  const siblings = liveRowsOf(
    await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId),
    loadId,
  ).filter((c) => String(c.id) !== loadCarrierId)
  const primary: Row | null = siblings[0] ?? null
  const siblingRung = leastRung(siblings.map((c) => c.assignmentStatus as CarrierAssignmentStatus | null | undefined))

  // A rate con the carrier could still open is dead the moment they come off.
  const voidsRateCon = OPEN_RATE_CON_STATUSES.includes(String(carrier.rateConStatus ?? ''))
  // So is the tracking link their driver was texted: we no longer track this truck,
  // and a live token on a carrier we dropped is a public page nobody is watching.
  const removedAt = nowIso()
  const repostToDat = optionalBoolean(input.repostToDat) ?? false
  const trackingLink = await activeCarrierPingLink(carrier)
  const stopsTracking = trackingLink != null || carrier.trackingStartedAt != null
  await transact(
    [
      retireCarrier(carrier, reason, outcome, caller, {
        removalNote: note,
        ...(voidsRateCon ? { rateConStatus: 'VOIDED', rateConToken: null } : {}),
        ...(stopsTracking ? { trackingLinkId: null, trackingStoppedAt: removedAt } : {}),
      }),
      // Step AM. With nobody left the retired row keeps its rung as history; with a sibling
      // the shipment shows the least advanced live rung.
      updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, ladderMirror(primary ? siblingRung : null, removedAt), null),
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

  if (primary) {
    const at = nowIso()
    const orderId = String(load.orderId ?? '')
    if (outcome === 'BOUNCED') {
      // The bounced carrier's money left with it: the cached load totals follow, from the
      // lines that remain (the leg index may still serve the ones just deleted).
      const customer = await customerOf(shipment)
      const settings = await getSettings()
      const remaining = (await queryIndex(LOAD_CHARGE_TABLE_NAME, IDX_CHARGES_BY_SHIPMENT, 'shipmentId', shipmentId))
        .filter((c) => String(c.loadCarrierId ?? '') !== loadCarrierId)
        .filter((c) => (c.loadId ? String(c.loadId) === loadId : String(c.orderId ?? '') === orderId))
      const { totals } = priceFor(
        remaining.map(chargeRowToInput),
        { miles: numberOrNull(load.miles), weightLbs: numberOrNull(load.weight) },
        pricingDefaultsOf(customer),
        marginFloorBpsOf(settings),
      )
      const existingFinancials = await getById(LOAD_FINANCIALS_TABLE_NAME, loadId)
      await transact(
        [putItem(
          LOAD_FINANCIALS_TABLE_NAME,
          financialsRow(loadId, shipmentId, orderId || null, totals, (numberOrNull(existingFinancials?.version) ?? 0) + 1, caller, existingFinancials),
          false,
        )],
        'financials',
      )
    }
    const tag = await applyTag(await recordsForTag(shipment, load, primary), caller)
    const client = await getDataClient()
    assertLoadWriteOk(
      await client.models.Load.update({
        id: loadId,
        activeLoadCarrierId: String(primary.id),
        carrierName: optionalString(primary.carrierName, 200),
        assignmentType: 'CARRIER',
        carrierAssignmentStatus: siblingRung,
        ...tag,
        updatedBy: caller.email,
      }),
      'Load update',
    )
    await writeAudit('LOAD_CARRIER', loadCarrierId, `REMOVE_LOAD_CARRIER:${outcome}`, caller, {
      loadId, reason, note, voidedRateCon: voidsRateCon, revokedTrackingLink: trackingLink != null,
      assignmentStatus: carrier.assignmentStatus ?? null, repostToDat: false, stillCovered: true, primaryLoadCarrierId: String(primary.id), at,
    })
    if (outcome === 'TONU' && isDeliveredOrLater(load.status)) await excludeLaneSample(quoteDeps, loadId)
    return rederiveShipmentStatus(shipmentId, caller)
  }
  const now = nowIso()
  // Nobody is on it. The driver, the truck and the trailer come off whether the leg
  // that left was ours or an outside carrier's: a bounce of an own-fleet leg that
  // only cleared `assignmentType` would leave the load on that driver's calendar
  // and in their settlement forever.
  const uncovered = uncoveredLoadPatch(readStops(load) as MirrorStop[])
  // Nobody is on the load now, so that is what the rules are given — not whatever
  // the leg index still has as ACTIVE.
  const tag = await applyTag(await recordsForTag(shipment, load, null), caller)
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update({
      id: loadId,
      ...uncovered,
      stops: JSON.stringify(uncovered.stops),
      activeLoadCarrierId: null,
      carrierAssignmentStatus: null,
      trackingProvider: 'NONE',
      ...tag,
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
    assignmentStatus: carrier.assignmentStatus ?? null, repostToDat,
  })
  // Step H. A TONU after the freight delivered does not un-deliver it: the lane
  // keeps the sample it recorded and the statistics stop counting it. `load` was
  // read before the removal, so this is the rung the load was actually at.
  if (outcome === 'TONU' && isDeliveredOrLater(load.status)) await excludeLaneSample(quoteDeps, loadId)
  const bundle = await rederiveShipmentStatus(shipmentId, caller)
  if (!repostToDat) return bundle
  // Step AM. Optional, default off: put the freight back on DAT through the ordinary POST_LOAD path.
  // The removal is already committed, so a refused or failed post is reported, never thrown.
  let repost: { ok: boolean; message: string }
  try {
    await postLoad(postingDeps, { shipmentId, loadId, providers: ['DAT'] }, caller)
    repost = { ok: true, message: 'Reposted to DAT.' }
  } catch (err) {
    repost = { ok: false, message: err instanceof Error ? err.message : 'The DAT post failed.' }
  }
  await writeAudit('LOAD_CARRIER', loadCarrierId, 'REMOVE_LOAD_CARRIER:REPOST_DAT', caller, { loadId, ok: repost.ok })
  return { ...(await readBundle(shipmentId)) as unknown as Row, repost }
}

async function listLoadCarriersByCarrier(input: Row, caller: Caller): Promise<Row> {
  if (!caller.isAdmin && !caller.groups.includes('page-tms')) {
    throw new Error('Forbidden: LIST_LOAD_CARRIERS_BY_CARRIER requires admin or page-tms')
  }
  const carrierId = assertString(input.carrierId, 'carrierId')
  const rows = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_CARRIER_ID, 'carrierId', carrierId)
  return { loadCarriers: rows }
}

// ── Carrier booking (step C) ─────────────────────────────────────────────────

/** A recipient line in an email header; a comma or a newline in one is an attack. */
function assertEmail(value: unknown, label: string): string {
  const v = assertString(value, label)
  if (!isEmailAddress(v)) {
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

// ── The assignment ladder (Step AM) ──────────────────────────────────────────
// One LoadCarrier climbs ASSIGNED_SETUP_PENDING -> ... -> DRIVER_INFO_ENTERED
// (src/lib/carrierAssignment.ts). The rung is derived from facts — MCP decides setup, the rate-con
// record decides sent/signed, the four driver fields decide the last — and only ever moves up.

/** Facts for the ladder from an assignment row with this write's changes laid over it. */
function assignmentFacts(row: Row, directoryStatus: unknown, over: Row = {}): AssignmentFacts {
  const merged = { ...row, ...over }
  return {
    carrierStatus: typeof directoryStatus === 'string' ? directoryStatus : null,
    rateConStatus: merged.rateConStatus as string | null | undefined,
    rateConSignedAt: merged.rateConSignedAt as string | null | undefined,
    driverName: merged.driverName as string | null | undefined,
    driverPhone: merged.driverPhone as string | null | undefined,
    truckNumber: merged.truckNumber as string | null | undefined,
    trailerNumber: merged.trailerNumber as string | null | undefined,
  }
}

/** The ladder columns this write earns `row`, or null when it stays where it is. */
function ladderStep(row: Row, directoryStatus: unknown, over: Row, now: string): { to: CarrierAssignmentStatus; cols: Row } | null {
  const current = isCarrierAssignmentStatus(row.assignmentStatus) ? row.assignmentStatus : null
  const to = advanceTarget(current, assignmentFacts(row, directoryStatus, over))
  return to ? { to, cols: ladderPatch(row, to, now) } : null
}

/** The rung shown on the board: mirrored onto the Shipment and the Load. */
function ladderMirror(status: CarrierAssignmentStatus | null, now: string): Row {
  return { carrierAssignmentStatus: status, updatedAt: now }
}

/** Mirror the rung when the shipment row is not already part of the transaction. */
function ladderMirrorWrites(row: Row, status: CarrierAssignmentStatus | null, now: string): TransactWriteItem[] {
  return [
    updateItemTx(SHIPMENT_TABLE_NAME, String(row.shipmentId), ladderMirror(status, now), null),
    updateItemTx(LOAD_TABLE_NAME, String(row.loadId), ladderMirror(status, now), null),
  ]
}

/** AT-plan: why a replace-style booking refuses while several carriers share the load. */
const REMOVE_FIRST_MESSAGE = 'Remove a carrier first or use ADD_CARRIER'

type LiveRow = CarrierLike & Row

/** The ACTIVE rows of one load in booking order (lowest sequence = primary). */
function liveRowsOf(rows: Row[], loadId: string): LiveRow[] {
  return liveCarriersOf(rows as LiveRow[], loadId)
}

/** The least advanced rung of the given ones; a row with no rung counts as the lowest. */
function leastRung(
  rungs: ReadonlyArray<CarrierAssignmentStatus | null | undefined>,
): CarrierAssignmentStatus | null {
  let least: CarrierAssignmentStatus | null = null
  rungs.forEach((rung, index) => {
    if (index === 0 || rungOf(rung) < rungOf(least)) least = rung ?? null
  })
  return least
}

/**
 * The rung to mirror onto the Shipment/Load when `row` moves to `to`: the least advanced
 * among the live carriers (the row itself counted at `to`). One carrier: `to` itself.
 */
async function mirrorRungFor(row: Row, to: CarrierAssignmentStatus): Promise<CarrierAssignmentStatus | null> {
  const loadId = String(row.loadId)
  const live = liveRowsOf(await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId), loadId)
  if (live.length <= 1) return to
  return leastRung(live.map((c) => (String(c.id) === String(row.id) ? to : (c.assignmentStatus as CarrierAssignmentStatus | null | undefined))))
}

/** A file-name fragment for a carrier: letters and digits only. */
function carrierSlug(name: string | null, fallback: string): string {
  const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug || fallback
}

function toLegCarrier(row: Row): { id: string; carrierName: string | null; legStopIds: string[]; kind: 'OWN_ASSET' | 'CARRIER'; carrierId: string | null } {
  return {
    id: String(row.id),
    carrierName: optionalString(row.carrierName, 200),
    legStopIds: Array.isArray(row.legStopIds) ? row.legStopIds.map(String) : [],
    kind: row.kind === 'OWN_ASSET' || isIvanCartageName(optionalString(row.carrierName, 200)) ? 'OWN_ASSET' : 'CARRIER',
    carrierId: optionalString(row.carrierId, 100),
  }
}

/**
 * ADD_CARRIER's gate (AT-plan §5): the load takes another carrier only while it is
 * sourcing, booked or dispatched, under the cap, never next to own fleet, with the same
 * directory carrier twice only on separate stops, and with legs that name real stops.
 * Returns the validated `legStopIds` (empty = all stops).
 */
function assertAdditionalCarrier(args: {
  load: Row
  live: LiveRow[]
  adding: { carrierId: string | null; carrierName: string | null }
  legStopIds: unknown
}): string[] {
  const { load, live, adding } = args
  if (!['SOURCING', 'BOOKED', 'DISPATCHED'].includes(String(load.status ?? ''))) {
    throw new Error('A carrier can be added only while the load is sourcing, booked or dispatched')
  }
  const legStopIds = args.legStopIds == null
    ? []
    : [...new Set(assertArrayOf(args.legStopIds, 'legStopIds', (v, i) => assertString(v, `legStopIds[${i}]`), 50))]
  const legLive = live.map(toLegCarrier)
  if (live.length > 0) {
    const refusal = validateCarrierAdd(legLive, {
      kind: isIvanCartageName(adding.carrierName) ? 'OWN_ASSET' : 'CARRIER',
      carrierId: adding.carrierId,
      legStopIds,
    })
    if (refusal) throw new Error(refusal)
  }
  const checked = validateLegs(
    [...legLive, { id: '__new', carrierName: adding.carrierName, legStopIds }],
    readStops(load) as unknown as LegStop[],
  )
  if (checked.errors.length > 0) throw new Error(checked.errors.join('; '))
  return legStopIds
}

/**
 * Book a directory carrier onto a load.
 *
 * Everything that could stop the booking is decided by `evaluateCarrierBooking`,
 * the same library the dialog previewed with: blocks refuse, warnings have to be
 * acknowledged by key, and the keys that were acknowledged are kept on the row so
 * the next person can see what was waved through and by whom.
 */
async function bookCarrier(input: Row, caller: Caller, extra?: BookCarrierExtra, options: { cover?: boolean; additional?: boolean } = {}): Promise<Row> {
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
  // Voided first: a voided shipment's load is CANCELED, and "it is not sourcing"
  // would be a confusing way to say "that shipment no longer exists".
  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  assertNotVoided(shipment)
  if (String(load.updatedAt ?? '') !== expectedUpdatedAt) throw conflictError('load', null)
  const additional = options.additional === true
  const live = liveRowsOf(bundle.loadCarriers, loadId)
  if (!additional && live.length > 1) throw new Error(REMOVE_FIRST_MESSAGE)
  if (!additional && String(load.status ?? '') !== 'SOURCING') {
    throw new Error('Only a load that is still sourcing can be booked')
  }
  const mode = optionalEnum(shipment.mode, SHIPMENT_MODES, 'mode')
  if (!isTruckloadMode(mode)) throw new Error('Only a truckload shipment books an outside carrier')
  if (!additional && live.length > 0) {
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
  const legIds = additional
    ? assertAdditionalCarrier({ load, live, adding: { carrierId, carrierName }, legStopIds: input.legStopIds })
    : []

  // Everything else this carrier is already holding, with the day it loads: a truck
  // promised to two shippers at the same hour is the oldest way to lose freight.
  const otherRows = (await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_CARRIER_ID, 'carrierId', carrierId))
    .filter((c) => c.status === 'ACTIVE' && String(c.loadId) !== loadId)
  const otherLoads = await batchGetByIds(LOAD_TABLE_NAME, otherRows.map((c) => String(c.loadId)))
  const activeOtherLoads = new Map(
    otherLoads
      .filter((l) => !l.voidedAt && l.status !== 'CANCELED')
      .map((l) => [String(l.id), l] as const),
  )
  const activeOtherRows = otherRows.filter((c) => activeOtherLoads.has(String(c.loadId)))
  const pickupByLoad = new Map(
    activeOtherRows.map((c) => [String(c.loadId), optionalString(activeOtherLoads.get(String(c.loadId))?.pickupAppt, 60)]),
  )

  const evaluated = evaluateCarrierBooking({
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
    ...(additional
      ? {
          additional: true,
          existingCarrierCostCents: live.reduce((sum, c) => sum + (numberOrNull(c.costCents) ?? 0), 0),
        }
      : {}),
    otherActiveLoadCarriers: activeOtherRows.map((c) => ({
      loadId: String(c.loadId),
      pickupAppt: pickupByLoad.get(String(c.loadId)) ?? null,
    })),
    settings: settings as unknown as TmsSettingsRecord | null,
    now: nowIso(),
    isAdmin: caller.isAdmin,
  })

  // Step AM. COVER_CARRIER is BOOK_CARRIER plus the MCP rules: UNACCEPTABLE blocks, MODERATE needs an
  // acknowledgement, and a carrier that is not yet ACTIVE is assigned in the setup-pending state.
  const cover = options.cover === true ? applyCoverRules(carrier, evaluated, { isAdmin: caller.isAdmin }) : null
  const blocks = cover ? cover.blocks : evaluated.blocks
  const warnings = cover ? cover.warnings : evaluated.warnings
  if (blocks.length > 0) {
    throw new Error(`${carrierName ?? 'That carrier'} cannot be ${cover ? 'assigned' : 'booked'}: ${blocks.map((b) => b.detail).join(' ')}`)
  }
  const acknowledgedKeys = new Set(acknowledged)
  const unacknowledged = warnings.filter((w) => !acknowledgedKeys.has(w.key))
  if (unacknowledged.length > 0) {
    // The trailing [ack:KEY,KEY] is machine-readable: the Cover dialog turns it into a checkbox and sends those keys back.
    throw new Error(`Acknowledge these before booking: ${unacknowledged.map((w) => w.detail).join(' ')} [ack:${unacknowledged.map((w) => w.key).join(',')}]`)
  }
  // Defence in depth: an admin-only finding is already a block for everybody else,
  // so a non-admin arriving here having ticked one is not to be taken at their word.
  if (!caller.isAdmin) {
    const adminOnly = warnings.filter((w) => w.adminOnly && acknowledgedKeys.has(w.key))
    if (adminOnly.length > 0) {
      throw new Error(`Only an admin can book past: ${adminOnly.map((w) => w.detail).join(' ')}`)
    }
  }

  const customer = await customerOf(shipment)
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
  // A lone carrier's untagged CARRIER lines are named for it before a second carrier
  // shares the side: an untagged line is refused once two are live.
  const retag = additional && live.length === 1 ? String(live[0].id) : null
  const retagged = retag ? kept.filter((c) => c.side === 'CARRIER' && c.loadCarrierId == null) : []
  const retaggedIds = new Set(retagged.map((c) => String(c.id)))
  const keptInputs = kept.map((c) =>
    retaggedIds.has(String(c.id)) ? { ...chargeRowToInput(c), loadCarrierId: retag } : chargeRowToInput(c))
  const { amounts, totals } = priceFor(
    [...keptInputs, ...added],
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

  const startRung = deriveAssignmentStatus(assignmentFacts({}, carrier.status ?? 'PENDING', {
    rateConStatus: 'NOT_SENT',
    driverName: optionalString(input.driverName, 120),
    driverPhone: optionalString(input.driverPhone, 40),
    truckNumber: optionalString(input.truckNumber, 40),
    trailerNumber: optionalString(input.trailerNumber, 40),
  }))
  const ladderCols = ladderPatch({}, startRung, now)
  // The shipment shows the least advanced rung of its live carriers.
  const mirrorRung = additional ? leastRung([...live.map((c) => c.assignmentStatus as CarrierAssignmentStatus | null | undefined), startRung]) : startRung
  // Step AQ. A directory carrier that is Ivan Cartage takes its driver from our Driver records.
  const ownFleetDriver: Row | null = isIvanCartageName(carrierName)
    ? await ownFleetDriverPatch(input, {
      driverName: optionalString(input.driverName, 120),
      driver2Name: optionalString(input.driver2Name, 120),
      driver2Phone: optionalString(input.driver2Phone, 40),
    })
    : null
  const loadCarrier: Row = {
    id: newCarrierId,
    __typename: 'LoadCarrier',
    loadId,
    shipmentId,
    kind: 'CARRIER',
    status: 'ACTIVE',
    sequence,
    ...(legIds.length > 0 ? { legStopIds: legIds } : {}),
    // A snapshot of who was booked: the directory may be edited afterwards, but
    // this is the carrier the rate confirmation names.
    carrierId,
    carrierName,
    carrierMc: optionalString(carrier.mcNumber, 40),
    carrierRepId: optionalString(input.carrierRepId, 100) ?? optionalString(load.carrierRepId, 100),
    dispatcherName: optionalString(input.dispatcherName, 120) ?? optionalString(carrier.dispatcherName, 120),
    dispatcherPhone: optionalString(input.dispatcherPhone, 40) ?? optionalString(carrier.dispatcherPhone, 40),
    dispatcherEmail: optionalString(input.dispatcherEmail, 200) ?? optionalString(carrier.dispatcherEmail, 200),
    ...(ownFleetDriver ?? {
      driverName: optionalString(input.driverName, 120),
      driverPhone: optionalString(input.driverPhone, 40),
      truckNumber: optionalString(input.truckNumber, 40),
      trailerNumber: optionalString(input.trailerNumber, 40),
    }),
    driver2Name: ownFleetDriver ? null : optionalString(input.driver2Name, 120),
    driver2Phone: ownFleetDriver ? null : optionalString(input.driver2Phone, 40),
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
    // Step AM. The ladder starts where the facts put it: waiting on setup unless the carrier is ACTIVE.
    ...ladderCols,
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
      ...retagged.map((row) => putItem(LOAD_CHARGE_TABLE_NAME, { ...row, loadCarrierId: retag, updatedBy: caller.email, updatedAt: now }, false)),
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
      updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, ladderMirror(mirrorRung, now), null),
      // Step H. ACCEPT_OFFER stamps its offer WON and closes the round's losers
      // here, so the quote thread and the assignment land together or not at all.
      ...(extra?.writes ?? []),
    ],
    'booking',
  )

  // Step R. Booking an outside carrier onto a load our own fleet was holding has to
  // clear the driver, the truck and the stop-level assignment, or the load stays on
  // the calendar and in that driver's settlement while somebody else hauls it.
  const cleared = live.length === 0 ? outsideCarrierLoadPatch(readStops(load) as MirrorStop[], { carrierName }) : null
  // Every record the rules read is already in hand — including the leg this call
  // just put, which the leg index may not be serving yet. An outside carrier never
  // carries one of our drivers, so there is no driver row to look up.
  const tag = await applyTag({ shipment, order, load, loadCarrier, driver: null }, caller)
  const client = await getDataClient()
  assertLoadWriteOk(
    await client.models.Load.update(
      {
        id: loadId,
        ...(cleared ? { ...cleared, stops: JSON.stringify(cleared.stops) } : {}),
        ...(live.length === 0 ? { activeLoadCarrierId: newCarrierId, equipmentType, trackingProvider } : {}),
        carrierAssignmentStatus: mirrorRung,
        ...tag,
        ...(String(load.status ?? '') === 'SOURCING'
          ? { status: 'BOOKED' as const, statusChangedAt: now, statusChangedBy: caller.email, statusSource: 'USER' as const }
          : {}),
        updatedBy: caller.email,
      },
      { condition: { updatedAt: { eq: expectedUpdatedAt } } },
    ),
    'Load update',
  )

  await writeAudit('LOAD_CARRIER', newCarrierId, cover ? 'COVER_CARRIER' : additional ? 'ADD_CARRIER' : 'BOOK_CARRIER', caller, {
    loadId,
    carrierId,
    carrierRateCents,
    contactId,
    assignmentStatus: startRung,
    blocks: [],
    warnings: warnings.map((w) => w.key),
    acknowledged,
    ...(additional ? { legStopIds: legIds } : {}),
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
  await requireLiveShipment(shipmentId)
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
 * One thread e-mail with any number of attachments (the rate confirmation's PDF + signing
 * link, a bill of lading). Built as raw MIME because SES's simple content has nowhere to put
 * an attachment.
 */
async function sendThreadMime(args: {
  to: string[]
  cc: string[]
  subject: string
  body: string
  attachments: { filename: string; contentType: string; base64: string }[]
  messageId: string
  replyTo: string
}): Promise<{ status: 'SENT' | 'NOT_SENT' | 'FAILED'; error: string | null; raw: string; sesMessageId: string | null }> {
  const boundary = `=_bcatthread_${Date.now().toString(36)}`
  const raw =
    `From: ${FROM_ADDRESS}\r\n` +
    `To: ${args.to.join(', ')}\r\n` +
    (args.cc.length > 0 ? `Cc: ${args.cc.join(', ')}\r\n` : '') +
    `Reply-To: ${args.replyTo}\r\n` +
    `Message-ID: ${args.messageId}\r\n` +
    `Subject: ${args.subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n` +
    `${wrap76(Buffer.from(args.body, 'utf8').toString('base64'))}\r\n` +
    `\r\n` +
    args.attachments.map((a) =>
      `--${boundary}\r\n` +
      `Content-Type: ${a.contentType}; name="${a.filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; filename="${a.filename}"\r\n` +
      `\r\n` +
      `${wrap76(a.base64)}\r\n`).join('') +
    `--${boundary}--\r\n`

  try {
    const out = await ses.send(new SendEmailCommand({
      FromEmailAddress: FROM_ADDRESS,
      Destination: { ToAddresses: args.to, CcAddresses: args.cc.length > 0 ? args.cc : undefined },
      Content: { Raw: { Data: new TextEncoder().encode(raw) } },
    }))
    return { status: 'SENT', error: null, raw, sesMessageId: out?.MessageId ?? null }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { status: 'NOT_SENT', error, raw, sesMessageId: null }
  }
}

// Step AM. The driver is the LAST rung of the ladder (entered by the rep, or by the carrier on the
// signing page), so a rate con goes out without one. A tenant may still demand more through
// `rateConRequiredFields`; the driver keys stay in the table for that.
const RATE_CON_SEND_FIELDS: Record<string, { column: string; label: string }> = {
  DRIVER_NAME: { column: 'driverName', label: 'driver name' },
  DRIVER_PHONE: { column: 'driverPhone', label: 'driver phone' },
  DISPATCHER_EMAIL: { column: 'dispatcherEmail', label: 'dispatcher email' },
}

function missingRateConSendFields(carrier: Row, required: readonly string[]): string[] {
  const missing: string[] = []
  for (const key of required) {
    const field = RATE_CON_SEND_FIELDS[key]
    if (!field) continue
    const value = carrier[field.column]
    if (typeof value !== 'string' || !value.trim()) missing.push(field.label)
  }
  return missing
}

function formatMissingFields(fields: string[]): string {
  if (fields.length === 1) return fields[0]
  if (fields.length === 2) return `${fields[0]} and ${fields[1]}`
  return `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`
}

function firstNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  const name = local.split(/[._-]/)[0] ?? ''
  if (!name) return 'BCAT'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** Always on CC for every rate confirmation (Ryne 2026-11-09). */
const ALWAYS_CC_TRACKING = 'tracking@bcatcorp.com'

function trackingMailbox(): string {
  const [local, domain] = THREAD_MAILBOX.split('@')
  return `${local}+tracking@${domain}`
}

/**
 * Send the rate confirmation the browser built.
 *
 * Each send is a new version: a fresh PDF on S3, a fresh CarrierDocument row, and a
 * fresh token — which is exactly what voids the previous link, since the token is
 * the only way into the signing page.
 *
 * Two rules: (1) the carrier must be Active in the system — checked before any side effect, on send and re-send; (2) the
 * sender is always cc'd after the tracking mailbox and typed cc, deduped
 * case-insensitively and never duplicating a `to` address (composeRateConCc).
 */
async function sendRateCon(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const pdfBase64 = assertString(input.pdfBase64, 'pdfBase64')
  const toInput = assertArrayOf(input.to, 'to', (v, i) => assertEmail(v, `to[${i}]`), 20)
  if (toInput.length === 0) throw new Error('A rate confirmation needs at least one recipient')
  const inputCc = input.cc == null ? [] : assertArrayOf(input.cc, 'cc', (v, i) => assertEmail(v, `cc[${i}]`), 20)
  const expiresHours = optionalInteger(input.expiresHours, { min: 1, max: 720, label: 'expiresHours' })

  const carrier = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!carrier) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (carrier.status !== 'ACTIVE') {
    throw new Error('Only the carrier currently on the load can be sent a rate confirmation')
  }
  const carrierId = optionalString(carrier.carrierId, 100)
  if (!carrierId) throw new Error('That assignment is not a directory carrier; book it with BOOK_CARRIER first')
  const directoryCarrier = await getById(CARRIER_TABLE_NAME, carrierId)
  if (!directoryCarrier) throw new Error(`Carrier not found: ${carrierId}`)
  // Ryne 2026-11-10: the only gate is that the carrier is Active in the system. Whether its MyCarrierPackets packet is finished is
  // MyCarrierPackets' business: an Active carrier (even one still "invited" there) can be sent a rate confirmation.
  if (directoryCarrier.status !== 'ACTIVE') {
    throw new Error(`${String(directoryCarrier.name ?? carrier.carrierName ?? 'This carrier')} is not Active in the system (status ${String(directoryCarrier.status ?? 'PENDING')}). A rate confirmation can be sent only to an Active carrier.`)
  }
  const loadId = String(carrier.loadId)
  const shipmentId = String(carrier.shipmentId)
  await requireLiveShipment(shipmentId)
  const load = await getById(LOAD_TABLE_NAME, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (!BUCKET_NAME) throw new Error('Document storage is not configured')
  const liveRows = liveRowsOf(await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId), loadId)
  const multi = liveRows.length > 1
  let rateConGrossCents: number | null = null
  if (multi) {
    // Only this carrier's own lines go on its rate confirmation (the bill snapshots the same).
    const ownLines = rateConLinesFor(
      (await queryIndex(LOAD_CHARGE_TABLE_NAME, IDX_CHARGES_BY_SHIPMENT, 'shipmentId', shipmentId)) as unknown as Parameters<typeof rateConLinesFor>[0],
      { id: loadCarrierId },
      liveRows.length,
      String(liveRows[0].id) === loadCarrierId,
    )
    if (ownLines.lines.length === 0) {
      throw new Error(`${optionalString(carrier.carrierName, 200) ?? 'This carrier'} has no carrier charges yet: enter the carrier rate before sending the rate confirmation.`)
    }
    rateConGrossCents = ownLines.grossCents
  }

  const settings = await getSettings()
  const requiredKeys: string[] = ['DISPATCHER_EMAIL']
  if (Array.isArray(settings?.rateConRequiredFields)) {
    for (const key of settings.rateConRequiredFields as string[]) {
      if (!requiredKeys.includes(key)) requiredKeys.push(key)
    }
  }
  // The dispatcher e-mail defaults to the address the rate con is going to (the carrier's MyCarrierPackets / FMCSA e-mail unless the
  // sender typed another): a blank one no longer stops the send, and it is saved on the assignment.
  const dispatcherEmailDefault = !optionalString(carrier.dispatcherEmail, 200) && toInput.length > 0 ? toInput[0] : null
  const missing = missingRateConSendFields(dispatcherEmailDefault ? { ...carrier, dispatcherEmail: dispatcherEmailDefault } : carrier, requiredKeys)
  if (missing.length) {
    throw new Error(`Add the ${formatMissingFields(missing)} before sending the rate confirmation.`)
  }

  const bytes = Buffer.from(pdfBase64, 'base64')
  if (bytes.length === 0) throw new Error('pdfBase64 is not a readable document')
  if (bytes.length > MAX_RATE_CON_BYTES) throw new Error('That rate confirmation is too large to send')

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
  const carrierLabel = optionalString(carrier.carrierName, 200)?.replace(/[\r\n]+/g, ' ') ?? null
  const filename = multi
    ? `rate-con-${loadNumber}-${carrierSlug(carrierLabel, loadCarrierId)}-v${version}.pdf`
    : `rate-con-${loadNumber}-v${version}.pdf`
  const subject = multi && carrierLabel
    ? `Rate confirmation — load ${loadNumber} — ${carrierLabel} ${subjectRef(shipmentId)}`
    : `Rate confirmation — load ${loadNumber} ${subjectRef(shipmentId)}`
  const messageId = newMessageId(shipmentId, version)
  const composed = composeRateConCc({
    to: toInput,
    // Tracking is always on CC: the shared tracking address plus the mailbox the thread machinery reads.
    extraCc: dedupeEmails([ALWAYS_CC_TRACKING, ...inputCc]),
    tracking: trackingMailbox(),
    sender: isEmailAddress(caller.email) ? caller.email : null,
  })
  if (!composed.senderCopied && caller.email && !isEmailAddress(caller.email)) {
    console.warn('[tms-shipment-actions] sender not copied: caller email is not a valid address')
  }
  const { to, cc } = composed
  const threadKey = String(shipment.threadKey ?? threadKeyFor(shipmentId))
  const firstName = firstNameFromEmail(caller.email)

  const signUrl = PORTAL_ORIGIN
    ? `${PORTAL_ORIGIN.replace(/\/+$/, '')}/sign/rate-con/${token}`
    : ''
  const bodyBase =
    `Attached is the rate confirmation for load ${loadNumber}.\r\n\r\n` +
    (signUrl ? `Review and sign it here: ${signUrl}\r\n\r\n` : '') +
    `This link expires ${expiresAt}.\r\n\r\n` +
    `This e-mail is the tracking thread for load ${loadNumber}. Please reply all (keep tracking@bcatcorp.com on every reply) for all tracking updates; they must stay in this thread.`
  const body = `${bodyBase}\r\n\r\n— ${firstName}, BCAT Tracking`

  const message: Row = {
    id: `msg:${shipmentId}:${randomUUID()}`,
    __typename: 'ShipmentMessage',
    shipmentId,
    threadKey,
    loadId,
    loadCarrierId,
    direction: 'OUT',
    channel: 'EMAIL',
    kind: 'RATE_CON',
    party: 'CARRIER',
    to: to.join(', '),
    cc: cc.join(', '),
    from: FROM_ADDRESS,
    subject,
    body,
    status: 'SENT',
    error: null,
    authorKind: 'PERSON',
    authorName: firstName,
    messageId,
    inReplyTo: null,
    providerRef: null,
    attachments: null,
    documentIds: [documentId],
    trackingLinkId: null,
    workflowRunId: null,
    at: now,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }

  const sentRung = ladderStep(carrier, directoryCarrier.status, { rateConStatus: 'SENT' }, now)
  const mirrorTo = sentRung ? await mirrorRungFor(carrier, sentRung.to) : null
  const transactionItems: TransactWriteItem[] = [
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
      ...(dispatcherEmailDefault ? { dispatcherEmail: dispatcherEmailDefault } : {}),
      rateConToken: token,
      rateConSentAt: now,
      rateConSentTo: to.join(', '),
      rateConExpiresAt: expiresAt,
      rateConDocumentId: documentId,
      rateConVersion: version,
      // The signing API's per-token rate limit counts from zero for each new link.
      rateConRequestCount: 0,
      ...(sentRung?.cols ?? {}),
      updatedBy: caller.email,
      updatedAt: now,
    }, null),
    putItem(SHIPMENT_MESSAGE_TABLE_NAME, message),
  ]
  if (!shipment.threadKey) {
    transactionItems.push(
      updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
        threadKey,
        threadOpenedAt: now,
        ...(sentRung ? ladderMirror(mirrorTo, now) : {}),
        updatedAt: now,
        updatedBy: caller.email,
      }, String(shipment.updatedAt ?? '')),
    )
    if (sentRung) transactionItems.push(updateItemTx(LOAD_TABLE_NAME, loadId, ladderMirror(mirrorTo, now), null))
  } else if (sentRung) {
    transactionItems.push(...ladderMirrorWrites(carrier, mirrorTo, now))
  }

  await transact(transactionItems, 'rate confirmation')

  // E-sign trail. The token left the row the moment it was overwritten, so the new link is recorded
  // under its hash (the old link then answers "replaced" instead of "invalid"), and the link it killed is logged.
  await writeAudit('RATE_CON_TOKEN', createHash('sha256').update(token).digest('hex'), 'rate_con_link_issued', caller, { loadCarrierId, loadId, version })
  const previousVersion = numberOrNull(carrier.rateConVersion) ?? 0
  if (previousVersion > 0) {
    await writeAudit('LOAD_CARRIER', loadCarrierId, 'rate_con_link_superseded', caller, {
      loadId, previousVersion, previousStatus: String(carrier.rateConStatus ?? 'NOT_SENT'), version,
      note: `Version ${version} replaced version ${previousVersion}; the version ${previousVersion} link no longer opens for signing.`,
    })
  }

  const emailOutcome = await sendThreadMime({
    to,
    cc,
    subject,
    body,
    attachments: [{ filename, contentType: 'application/pdf', base64: pdfBase64 }],
    messageId,
    replyTo: threadReplyAddress(shipmentId),
  })

  if (emailOutcome.status !== 'SENT') {
    console.error('[tms-shipment-actions] rate con email failed', emailOutcome.error)
    // Keep the exact message that would have been sent in CloudWatch so dev
    // stacks (where SES is denied) can prove the email body and headers.
    console.log('[tms-shipment-actions] rate con email would have sent:\n', emailOutcome.raw)
    if (process.env.BCAT_DEV_STACK === 'true') {
      // Dev stacks only let SES reach the test mailbox. Patch the row to the
      // real outcome so the thread does not pretend an email was delivered.
      await dynamo.send(new UpdateItemCommand({
        TableName: SHIPMENT_MESSAGE_TABLE_NAME,
        Key: marshall({ id: message.id }),
        UpdateExpression: 'SET #status = :status, #error = :error, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: marshall({
          ':status': 'NOT_SENT',
          ':error': emailOutcome.error,
          ':updatedAt': nowIso(),
        }),
      }))
      console.log('[tms-shipment-actions] dev stack: rate con email failure suppressed; message row marked NOT_SENT')
    } else {
      const failure = new Error(`The rate confirmation was saved but the email could not be sent: ${emailOutcome.error}`)
      ;(failure as Error & { cause?: unknown }).cause = emailOutcome.error
      throw failure
    }
  }

  // SES rewrites the Message-ID header on every send, so the id a reply's In-Reply-To will carry is
  // `<sesMessageId@email.amazonses.com>`. Store that as the row's messageId (the shipmentMessagesByMessageId
  // index then resolves a reply's In-Reply-To) and keep SES's bare id in providerRef.
  if (emailOutcome.status === 'SENT' && emailOutcome.sesMessageId) {
    await dynamo.send(new UpdateItemCommand({
      TableName: SHIPMENT_MESSAGE_TABLE_NAME,
      Key: marshall({ id: message.id }),
      UpdateExpression: 'SET providerRef = :ref, messageId = :mid',
      ExpressionAttributeValues: marshall({ ':ref': emailOutcome.sesMessageId, ':mid': sesWireMessageId(emailOutcome.sesMessageId) }),
    }))
  }

  await writeAudit('LOAD_CARRIER', loadCarrierId, 'SEND_RATE_CON', caller, {
    loadId, version, to, cc, senderCc: composed.senderCopied ? caller.email : null, mcpStatus: optionalString(directoryCarrier.mcpStatus, 100) ?? null,
    assignmentStatus: sentRung?.to ?? carrier.assignmentStatus ?? null,
    expiresAt, documentId, s3Key, threadKey, emailStatus: emailOutcome.status, sesMessageId: emailOutcome.sesMessageId,
    ...(multi ? { liveCarriers: liveRows.length, rateConGrossCents } : {}),
  })
  return readBundle(shipmentId) as unknown as Row
}

/**
 * Mail a stored bill of lading. The PDF is read back from S3 (never trusted from the
 * browser), goes only to the validated recipients the rep picked, is copied to the
 * tracking mailbox and the sender, and rides the shipment thread (opened here when it
 * is not yet) so replies land in it. A rated BOL is a customer copy and is refused
 * before anything is read or sent. A failed send still leaves the message row (status
 * NOT_SENT) and answers with a download link, as the rate confirmation does on a dev stack.
 */
async function emailBol(input: Row, caller: Caller): Promise<Row> {
  const parsed = parseEmailBolInput(input)
  const { shipmentId } = parsed
  const shipment = await requireLiveShipment(shipmentId)
  const doc = assertBolEmailable(await getById(SHIPMENT_DOCUMENT_TABLE_NAME, parsed.documentId), shipmentId)
  if (!BUCKET_NAME) throw new Error('Document storage is not configured')

  const loads = await queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const load = loads.find((l) => l.id === doc.loadId) ?? loads[0] ?? null
  const pro = optionalString(load?.loadNumber, 60) ?? optionalString(shipment.number, 60) ?? shipmentId
  const delivery = load ? deliveryLabel(readStops(load), doc.stopId) : null

  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: String(doc.s3Key) }))
  const bytes = object.Body ? Buffer.from(await object.Body.transformToByteArray()) : Buffer.alloc(0)
  if (bytes.length === 0) throw new Error('That bill of lading has no stored file')
  if (bytes.length > MAX_GENERATED_BYTES) throw new Error('That bill of lading is too large to send')

  const composed = composeRateConCc({
    to: parsed.to,
    extraCc: parsed.cc,
    tracking: trackingMailbox(),
    sender: isEmailAddress(caller.email) ? caller.email : null,
  })
  const { to, cc } = composed
  const now = nowIso()
  const firstName = firstNameFromEmail(caller.email)
  const subject = bolEmailSubject(pro, delivery, subjectRef(shipmentId))
  const body = bolEmailBody(parsed.message, firstName)
  const filename = String(doc.name ?? `bol-${pro}.pdf`).replace(/[\r\n"]+/g, ' ')
  const messageId = newMessageId(shipmentId, numberOrNull(doc.version) ?? 1)
  const threadKey = String(shipment.threadKey ?? threadKeyFor(shipmentId))

  const message: Row = {
    id: `msg:${shipmentId}:${randomUUID()}`,
    __typename: 'ShipmentMessage',
    shipmentId,
    threadKey,
    loadId: optionalString(doc.loadId, 100),
    loadCarrierId: optionalString(doc.loadCarrierId, 100),
    direction: 'OUT',
    channel: 'EMAIL',
    kind: 'OTHER',
    party: parsed.party,
    to: to.join(', '),
    cc: cc.join(', '),
    from: FROM_ADDRESS,
    subject,
    body,
    status: 'SENT',
    error: null,
    authorKind: 'PERSON',
    authorName: firstName,
    messageId,
    inReplyTo: null,
    providerRef: null,
    attachments: null,
    documentIds: [String(doc.id)],
    trackingLinkId: null,
    workflowRunId: null,
    at: now,
    createdBy: caller.email,
    createdAt: now,
    updatedAt: now,
  }
  const items: TransactWriteItem[] = [putItem(SHIPMENT_MESSAGE_TABLE_NAME, message)]
  if (!shipment.threadKey) {
    items.push(
      updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
        threadKey,
        threadOpenedAt: now,
        updatedAt: now,
        updatedBy: caller.email,
      }, String(shipment.updatedAt ?? '')),
    )
  }
  await transact(items, 'bill of lading e-mail')

  const outcome = await sendThreadMime({
    to,
    cc,
    subject,
    body,
    attachments: [{ filename, contentType: 'application/pdf', base64: bytes.toString('base64') }],
    messageId,
    replyTo: threadReplyAddress(shipmentId),
  })

  let downloadUrl: string | null = null
  if (outcome.status === 'SENT') {
    // SES rewrites Message-ID, so store the wire id a reply's In-Reply-To will carry.
    if (outcome.sesMessageId) {
      await dynamo.send(new UpdateItemCommand({
        TableName: SHIPMENT_MESSAGE_TABLE_NAME,
        Key: marshall({ id: message.id }),
        UpdateExpression: 'SET providerRef = :ref, messageId = :mid',
        ExpressionAttributeValues: marshall({ ':ref': outcome.sesMessageId, ':mid': sesWireMessageId(outcome.sesMessageId) }),
      }))
      message.providerRef = outcome.sesMessageId
      message.messageId = sesWireMessageId(outcome.sesMessageId)
    }
  } else {
    console.error('[tms-shipment-actions] bol email failed', outcome.error)
    console.log('[tms-shipment-actions] bol email would have sent:\n', outcome.raw)
    await dynamo.send(new UpdateItemCommand({
      TableName: SHIPMENT_MESSAGE_TABLE_NAME,
      Key: marshall({ id: message.id }),
      UpdateExpression: 'SET #status = :status, #error = :error, #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status', '#error': 'error', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: marshall({ ':status': 'NOT_SENT', ':error': outcome.error, ':updatedAt': nowIso() }),
    }))
    message.status = 'NOT_SENT'
    message.error = outcome.error
    downloadUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: String(doc.s3Key) }), { expiresIn: 300 })
  }

  await writeAudit('SHIPMENT_DOCUMENT', String(doc.id), 'EMAIL_BOL', caller, {
    shipmentId, documentId: doc.id, version: doc.version ?? null, stopId: doc.stopId ?? null,
    party: parsed.party, to, cc, senderCc: composed.senderCopied ? caller.email : null, threadKey,
    emailStatus: outcome.status === 'SENT' ? 'SENT' : 'NOT_SENT', sesMessageId: outcome.sesMessageId,
  })
  return {
    message,
    emailStatus: outcome.status === 'SENT' ? 'SENT' : 'NOT_SENT',
    emailError: outcome.error,
    downloadUrl,
  }
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

// ── ENTER_DRIVER_INFO / MARK_RATE_CON_SIGNED (Step AM) ───────────────────────

/** The one assignment these two actions work on: live, outside-carrier, directory-backed, set up. */
async function setUpAssignment(loadCarrierId: string, what: string): Promise<{ row: Row; directory: Row }> {
  const row = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!row) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (row.status !== 'ACTIVE') throw new Error('That assignment has already been removed')
  const carrierId = optionalString(row.carrierId, 100)
  if (row.kind === 'OWN_ASSET' || !carrierId) throw new Error(`${what} belongs to an outside-carrier assignment`)
  const directory = await getById(CARRIER_TABLE_NAME, carrierId)
  if (!directory) throw new Error(`Carrier not found: ${carrierId}`)
  if (directory.status !== 'ACTIVE') {
    throw new Error(`${what} is possible only after MyCarrierPackets reports ${String(directory.name ?? row.carrierName ?? 'the carrier')}'s setup complete (carrier status ${String(directory.status ?? 'PENDING')}).`)
  }
  await requireLiveShipment(String(row.shipmentId))
  return { row, directory }
}

/**
 * Driver name, phone, truck # and trailer # — all four. Tracking (the driver SMS, the check-call
 * agent) keys off this record, so dispatch waits for it. Entered by the rep here, or by the carrier
 * on the signing page.
 */
async function enterDriverInfo(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const { row, directory } = await setUpAssignment(loadCarrierId, 'Entering driver info')
  const typed: Row = {
    driverName: optionalString(input.driverName, 120),
    driverPhone: optionalString(input.driverPhone, 40),
    truckNumber: optionalString(input.truckNumber, 40),
    trailerNumber: optionalString(input.trailerNumber, 40),
  }
  // Step AQ. Ivan Cartage takes its driver from our Driver records: phone, truck and trailer are
  // filled from the record when omitted, and a typed name is refused.
  const fields: Row = isIvanCartageName(optionalString(row.carrierName, 200) ?? optionalString(directory.name, 200))
    ? { ...typed, ...(await ownFleetDriverPatch(input, typed)) }
    : typed
  const gaps = driverInfoGaps(fields)
  if (gaps.length > 0) throw new Error(`Driver info is required: enter the ${formatMissingFields(gaps)}.`)

  const now = nowIso()
  const step = ladderStep(row, directory.status, fields, now)
  await transact(
    [
      updateItemTx(LOAD_CARRIER_TABLE_NAME, loadCarrierId, { ...fields, ...(step?.cols ?? {}), updatedBy: caller.email, updatedAt: now }, null),
      ...(step ? ladderMirrorWrites(row, await mirrorRungFor(row, step.to), now) : []),
    ],
    'driver info',
  )
  // Keys only: a name and a phone number never reach the audit log.
  await writeAudit('LOAD_CARRIER', loadCarrierId, 'ENTER_DRIVER_INFO', caller, {
    loadId: String(row.loadId), keys: Object.keys(fields), assignmentStatus: step?.to ?? row.assignmentStatus ?? null,
  })
  return readBundle(String(row.shipmentId)) as unknown as Row
}

/**
 * The carrier signed on paper or by e-mail: the rep uploads the signed PDF (PREPARE_DOCUMENT_UPLOAD +
 * COMMIT_DOCUMENT, type RATE_CON) and names it here. The signing link remains the other way to sign.
 */
async function markRateConSigned(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const documentId = assertString(input.documentId, 'documentId')
  const { row, directory } = await setUpAssignment(loadCarrierId, 'Marking a rate confirmation signed')
  const status = String(row.rateConStatus ?? 'NOT_SENT')
  if (!['SENT', 'OPENED', 'EXPIRED'].includes(status)) {
    throw new Error(status === 'SIGNED'
      ? 'That rate confirmation is already signed'
      : 'Send the rate confirmation first; only one that was sent can be marked signed')
  }
  const document = await getById(SHIPMENT_DOCUMENT_TABLE_NAME, documentId)
  if (!document || document.shipmentId !== row.shipmentId) throw new Error('Upload the signed rate confirmation to this shipment first')
  if (document.type !== 'RATE_CON') throw new Error('The uploaded document must be filed as a rate confirmation')
  if (document.status !== 'ACTIVE') throw new Error('That document has been voided; upload the signed copy again')
  if (document.contentType !== 'application/pdf') throw new Error('The signed rate confirmation must be a PDF')

  const now = nowIso()
  const signed: Row = {
    rateConStatus: 'SIGNED',
    rateConSignedAt: now,
    rateConSignerName: `${caller.email} (marked signed)`,
    rateConKey: String(document.s3Key),
    rateConToken: null,
  }
  const step = ladderStep(row, directory.status, signed, now)
  await transact(
    [
      updateItemTx(LOAD_CARRIER_TABLE_NAME, loadCarrierId, { ...signed, ...(step?.cols ?? {}), updatedBy: caller.email, updatedAt: now }, null),
      ...(step ? ladderMirrorWrites(row, await mirrorRungFor(row, step.to), now) : []),
    ],
    'rate confirmation',
  )
  await writeAudit('LOAD_CARRIER', loadCarrierId, 'MARK_RATE_CON_SIGNED', caller, {
    loadId: String(row.loadId), from: status, documentId, s3Key: String(document.s3Key), assignmentStatus: step?.to ?? row.assignmentStatus ?? null,
  })
  return readBundle(String(row.shipmentId)) as unknown as Row
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
  await requireLiveShipment(shipmentId)
  const current = (optionalEnum(load.status, LOAD_STATUS_VALUES, 'status') ?? null) as LoadWorkflowStatus | null
  const carriers = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', loadId)
  const live = liveRowsOf(carriers, loadId)
  // AT-plan: with several carriers the caller names the one that is rolling.
  const requestedId = optionalString(input.loadCarrierId, 100)
  if (live.length > 1 && !requestedId) {
    throw new Error(`This load has ${live.length} carriers: name the carrier to dispatch (loadCarrierId)`)
  }
  const active: Row | null = requestedId ? live.find((c) => String(c.id) === requestedId) ?? null : live[0] ?? null
  if (requestedId && !active) throw new Error('That carrier is not on this load')
  // The second carrier of a split load goes out after the load is already DISPATCHED.
  const laterCarrier = live.length > 1 && current === 'DISPATCHED' && active != null && active.dispatchedAt == null
  if (current !== 'BOOKED' && !laterCarrier) throw new Error('Only a booked load can be dispatched')
  if (current === 'BOOKED' && !canTransitionLoadStatus(current, 'DISPATCHED')) {
    throw new Error(`A load cannot go from ${current ?? 'SOURCING'} to DISPATCHED`)
  }
  // An Ivan Cartage load with no leg at all is the driverless case, so it gets the driver
  // message and not the generic one.
  await assertOwnAssetDriver(load, active, 'DISPATCH')
  if (!active) throw new Error('That load has nobody on it to dispatch')
  // Step AM. An outside carrier is dispatched only once MyCarrierPackets says it is set up and the four
  // driver fields (name, phone, truck #, trailer #) are on the assignment: tracking keys off them.
  if (active.kind === 'CARRIER') {
    const directory = optionalString(active.carrierId, 100) ? await getById(CARRIER_TABLE_NAME, String(active.carrierId)) : null
    if (directory && directory.status !== 'ACTIVE') {
      throw new Error(`${String(directory.name ?? active.carrierName ?? 'The carrier')} is not set up yet: dispatch waits for MyCarrierPackets to report setup complete.`)
    }
    const gaps = driverInfoGaps(active)
    if (gaps.length > 0) throw new Error(`Driver info is required before dispatch: enter the ${formatMissingFields(gaps)}.`)
  }

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
  // An own-fleet leg's driver is the roster driver; a typed name could only drift from it.
  if (active.kind !== 'OWN_ASSET' && !isIvanCartageName(optionalString(active.carrierName, 200))) {
    const driverName = optionalString(input.driverName, 120)
    if (driverName) patch.driverName = driverName
    const driverPhone = optionalString(input.driverPhone, 40)
    if (driverPhone) patch.driverPhone = driverPhone
  }
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
      ...(current === 'BOOKED'
        ? { status: 'DISPATCHED' as const, statusChangedAt: now, statusChangedBy: caller.email, statusSource: 'USER' as const }
        : {}),
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
function assertFinalizedChargesUnchanged(bundle: Bundle, chargeRows: Row[], reopened: string | null = null): void {
  const finalized = new Set(
    bundle.loadCarriers
      .filter((c) => c.chargesFinalizedAt != null && String(c.id) !== reopened)
      .map((c) => String(c.id)),
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
  /** Extra columns written in the same order / shipment update (UPDATE_ORDER_DETAILS). */
  orderPatch?: Row
  shipmentPatch?: Row
  /**
   * The one finalized assignment this call may reprice: UPDATE_CARRIER_CHARGES on a bill still in
   * review, which re-snapshots that bill in the same transaction.
   */
  reopenedLoadCarrierId?: string | null
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

  const live = liveRowsOf(bundle.loadCarriers, loadId)
  const knownIds = new Set(
    bundle.loadCarriers.filter((c) => String(c.loadId) === loadId && c.status !== 'BOUNCED').map((c) => String(c.id)),
  )
  // AT-plan: an untagged CARRIER line belongs to the only live carrier; with two or more
  // it is refused, and every explicit tag must name a carrier of this load.
  const tagged = charges.map((c): ChargeInput => {
    if (c.side !== 'CARRIER') return c
    if (c.loadCarrierId == null) {
      if (live.length > 1) {
        throw new Error(`Carrier charge ${c.code} must name the carrier it is paid to: ${live.length} carriers are on this load`)
      }
      return { ...c, loadCarrierId: live.length === 1 ? String(live[0].id) : null }
    }
    if (live.length > 1 && !knownIds.has(c.loadCarrierId)) {
      throw new Error(`Carrier charge ${c.code} names a carrier that is not on this load`)
    }
    return c
  })
  const { amounts, totals } = priceFor(
    tagged,
    { miles: numberOrNull(load.miles), weightLbs: numberOrNull(load.weight) },
    pricingDefaultsOf(customer),
    marginFloorBpsOf(settings),
  )

  const chargeRows = tagged.map((c, i) => chargeRow(
    c,
    amounts[i],
    { shipmentId, orderId, loadId },
    caller,
    existingById.get(String(c.id ?? '')) ?? null,
  ))
  const keptIds = new Set(chargeRows.map((r) => String(r.id)))
  const removed = bundle.charges.filter((r) => !keptIds.has(String(r.id)))
  assertFinalizedChargesUnchanged(bundle, chargeRows, args.reopenedLoadCarrierId ?? null)
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
      ...args.orderPatch,
      customerRateCents: totals.customerRateCents,
      revenueCents: totals.revenueCents,
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(order.version) ?? 1) + 1,
    }, null),
    updateItemTx(SHIPMENT_TABLE_NAME, shipmentId, {
      ...args.shipmentPatch,
      updatedBy: caller.email,
      updatedAt: now,
      version: (numberOrNull(shipment.version) ?? 1) + 1,
    }, args.expectedShipmentUpdatedAt),
  ]
  // Every live carrier's cache is re-derived from its own lines.
  for (const carrier of live) {
    writes.push(updateItemTx(
      LOAD_CARRIER_TABLE_NAME,
      String(carrier.id),
      carrierCachePatch(chargeRows, carrier, caller, now),
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
  assertNotVoided(shipment)
  const currentVersion = numberOrNull(shipment.version) ?? 1
  if (currentVersion !== expectedVersion) throw conflictError('shipment', null)

  const load = bundle.loads[0]
  const loadId = load ? String(load.id) : ''
  const existingFinancials = bundle.financials.find((f) => f.id === loadId) ?? null
  if (existingFinancials?.frozenAt && !postInvoiceCleared(input)) {
    throw new Error('This load\'s financials are frozen and can no longer be changed')
  }

  const customer = await customerOf(shipment)
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
/**
 * The bill re-snapshotted from the assignment's new lines: lines, gross, its own quick-pay fee, net,
 * balance and variance. CAS on the bill's version and its review rung, so a bill approved, paid or
 * put on a pay run in the meantime refuses the whole transaction.
 */
function rebillWrite(bill: Row, chargeRows: Row[], loadCarrierId: string, caller: Caller): TransactWriteItem {
  const record = bill as unknown as CarrierBillRecord
  const { lines, grossCents } = billLinesFor(chargeRows as unknown as LoadChargeRecord[], loadCarrierId)
  const money = rebilledMoney(record, grossCents)
  const tx = updateItemTx(CARRIER_BILL_TABLE(), String(bill.id), {
    lines,
    ...money,
    updatedAt: nowIso(),
    updatedBy: caller.email,
    version: (numberOrNull(bill.version) ?? 1) + 1,
  }, null)
  const update = tx.Update!
  update.ExpressionAttributeNames = { ...update.ExpressionAttributeNames, '#rbStatus': 'status', '#rbVersion': 'version', '#rbSel': 'selectedForPayment' }
  update.ExpressionAttributeValues = {
    ...update.ExpressionAttributeValues,
    ':rbStatus': { S: 'IN_REVIEW' },
    ':rbVersion': { N: String(numberOrNull(bill.version) ?? 1) },
    ':rbTrue': { BOOL: true },
  }
  update.ConditionExpression = '#rbStatus = :rbStatus AND #rbVersion = :rbVersion AND (attribute_not_exists(#rbSel) OR #rbSel <> :rbTrue)'
  return tx
}

const CARRIER_BILL_TABLE = (): string => process.env.CARRIER_BILL_TABLE_NAME ?? ''

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
  // A recorded bill freezes the lines, except a bill still in review that no money has touched and
  // no pay run holds: AP corrects the carrier pay there, and the bill is re-snapshotted below in the
  // same transaction so the bill and the charges cannot disagree.
  let openBill: Row | null = null
  if (assignment.chargesFinalizedAt) {
    const billTable = process.env.CARRIER_BILL_TABLE_NAME ?? ''
    openBill = assignment.invoiceId && billTable ? await getById(billTable, String(assignment.invoiceId)) : null
    if (!openBill) throw new Error(FINALIZED_CHARGES_MESSAGE)
    const lock = billMoneyLockReason(openBill as unknown as CarrierBillRecord, { allowApproved: false })
    if (lock) throw new Error(`${lock}, then change what the carrier is owed`)
  }

  const shipmentId = String(assignment.shipmentId)
  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  assertNotVoided(shipment)
  const currentVersion = numberOrNull(shipment.version) ?? 1
  if (currentVersion !== expectedVersion) throw conflictError('shipment', null)

  const customer = await customerOf(shipment)
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
    reopenedLoadCarrierId: openBill ? loadCarrierId : null,
  })
  if (openBill) writes.push(rebillWrite(openBill, chargeRows, loadCarrierId, caller))
  const loadId = String(assignment.loadId)
  const liveIds = new Set(liveRowsOf(bundle.loadCarriers, loadId).map((c) => String(c.id)))
  // A TONU'd assignment is still owed its retained lines, and repricing only
  // re-caches the carrier currently on the load; this one has to be told itself.
  if (!liveIds.has(loadCarrierId)) {
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
    ...(openBill ? { billId: String(openBill.id), billGrossBeforeCents: numberOrNull(openBill.grossCents) } : {}),
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

// ── UPDATE_ORDER_DETAILS (Step AH) ───────────────────────────────────────────

/**
 * Edit the order-level extras of a shipment that has left DRAFT: references, equipment,
 * special requirements, freight, notes, contact, bill-to, quote link, and the load's
 * miles / weight / commodity / pieces / declared value / hot / notes. A draft goes
 * through SAVE_ORDER_FORM; mode, customer, stops and charges have their own actions.
 */
async function updateOrderDetails(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const requested = validateUpdateOrderDetails(input, { reference: validateOrderReference, freight: validateFreightItem })
  const { order: orderIn, loadFields, shipmentFlags } = requested
  if (Object.keys(orderIn).length + Object.keys(loadFields).length + Object.keys(shipmentFlags).length === 0) {
    throw new Error('Nothing to change: send order, loadFields or shipmentFlags')
  }

  const bundle = await readBundle(shipmentId)
  const { shipment } = bundle
  assertNotVoided(shipment)
  if (shipment.status === 'DRAFT') throw new Error('Use SAVE_ORDER_FORM on a draft')
  const order = bundle.orders[0]
  const load = bundle.loads[0]
  if (!order) throw new Error(`Shipment ${shipmentId} has no order`)
  if (!load) throw new Error(`Shipment ${shipmentId} has no load`)
  const loadId = String(load.id)
  const orderId = String(order.id)

  if (order.invoiceId && !postInvoiceCleared(input)) {
    const locked = INVOICE_LOCKED_ORDER_KEYS.filter((key) => key in orderIn)
    if (locked.length > 0) {
      const label = optionalString(order.invoiceNumber, 100) ?? String(order.invoiceId)
      throw new Error(`This order has invoice ${label}; ${locked.join(', ')} can no longer be changed`)
    }
  }
  const existingFinancials = bundle.financials.find((f) => f.id === loadId) ?? null
  const milesNext = 'miles' in loadFields ? (loadFields.miles as number | null) : numberOrNull(load.miles)
  const weightNext = 'weight' in loadFields ? (loadFields.weight as number | null) : numberOrNull(load.weight)
  const repriced = milesNext !== numberOrNull(load.miles) || weightNext !== numberOrNull(load.weight)
  if (repriced && existingFinancials?.frozenAt && !postInvoiceCleared(input)) {
    const locked = FROZEN_LOCKED_LOAD_KEYS.filter((key) => key in loadFields)
    throw new Error(`This load's financials are frozen; ${locked.join(' and ')} can no longer be changed`)
  }

  const customer = await customerOf(shipment)
  const mode = shipment.mode as ShipmentMode
  const references = Array.isArray(orderIn.references) ? (orderIn.references as Row[]) : null
  if (references) assertRequiredReferences(customer, references)
  if (Array.isArray(orderIn.freight)) assertWeightUnitsAgree(orderIn.freight as Row[])
  if ('equipmentType' in orderIn && isTruckloadMode(mode) && !orderIn.equipmentType) {
    throw new Error('A truckload order needs an equipment type')
  }
  const { specialRequirements: srPatch, quoteId: quoteIdIn, ...plainOrder } = orderIn
  const quoteLink = 'quoteId' in orderIn
    ? await quoteLinkPatch(quoteIdIn as string | null, order, shipment)
    : {}
  const orderExtra: Row = {
    ...plainOrder,
    ...quoteLink,
    ...('specialRequirements' in orderIn
      ? { specialRequirements: mergeSpecialRequirements(order.specialRequirements, srPatch as Row | null) }
      : {}),
  }
  const shipmentExtra: Row = {
    ...shipmentFlags,
    ...(references
      ? { searchKey: buildSearchKey({ ...shipment, ...shipmentFlags }, [{ ...order, references }], bundle.loads) }
      : {}),
  }

  const now = nowIso()
  let totals: FinancialsTotals | null = null
  let writes: TransactWriteItem[]
  if (repriced) {
    const settings = await getSettings()
    const priced = repriceShipment({
      bundle: { ...bundle, loads: [{ ...load, miles: milesNext, weight: weightNext }, ...bundle.loads.slice(1)] },
      charges: bundle.charges.map(chargeRowToInput),
      customer,
      settings,
      caller,
      expectedShipmentUpdatedAt: expectedUpdatedAt,
      orderPatch: orderExtra,
      shipmentPatch: shipmentExtra,
    })
    totals = priced.totals
    writes = priced.writes
  } else {
    const stamp = { updatedBy: caller.email, updatedAt: now }
    writes = [
      updateItemTx(
        SHIPMENT_TABLE_NAME,
        shipmentId,
        { ...shipmentExtra, ...stamp, version: (numberOrNull(shipment.version) ?? 1) + 1 },
        expectedUpdatedAt,
      ),
      updateItemTx(
        ORDER_TABLE_NAME,
        orderId,
        { ...orderExtra, ...stamp, version: (numberOrNull(order.version) ?? 1) + 1 },
        null,
      ),
    ]
  }
  await transact(writes, 'shipment')

  const loadPatch: Row = {
    ...loadFields,
    ...('equipmentType' in orderIn ? { equipmentType: orderIn.equipmentType } : {}),
    ...(totals ? { rate: totals.revenueCents } : {}),
    // The load keeps a copy of the customer ref # and pickup # (the calendar reads it): follow the order's references.
    ...(references ? loadRefsFromReferences(references) : {}),
  }
  if (Object.keys(loadPatch).length > 0) {
    const client = await getDataClient()
    assertLoadWriteOk(
      await client.models.Load.update({ id: loadId, ...loadPatch, updatedBy: caller.email }),
      'Load update',
    )
  }
  // References and equipment are what the ownership rules read.
  if ('references' in orderIn || 'equipmentType' in orderIn) await applyTagToLoads(shipmentId, caller)

  // Key names only: the free text, e-mails and notes never reach the audit log.
  await writeAudit('SHIPMENT', shipmentId, 'UPDATE_ORDER_DETAILS', caller, {
    orderKeys: Object.keys(orderIn),
    loadKeys: Object.keys(loadFields),
    shipmentKeys: Object.keys(shipmentFlags),
    repriced,
  })
  if (repriced && isDeliveredOrLater(load.status)) await writeLaneSample(quoteDeps, loadId)
  return readBundle(shipmentId) as unknown as Row
}

// ── UPDATE_LOAD_CARRIER_DETAILS (Step AH) ────────────────────────────────────

/**
 * Correct the contact and equipment details of the ACTIVE outside-carrier assignment in
 * place: dispatcher, driver(s), truck, trailer, plates, VIN, seal and trip number — the
 * fields BOOK_CARRIER does not take. Money, rate con and status are never touched.
 */
async function updateLoadCarrierDetails(input: Row, caller: Caller): Promise<Row> {
  const loadCarrierId = assertString(input.loadCarrierId, 'loadCarrierId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const patch = validateCarrierDetails(input)

  const assignment = await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId)
  if (!assignment) throw new Error(`Load carrier not found: ${loadCarrierId}`)
  if (assignment.kind === 'OWN_ASSET') {
    throw new Error('An own-fleet leg is edited through ASSIGN_ASSET, not here')
  }
  if (String(assignment.status ?? '') !== 'ACTIVE') {
    throw new Error('Only the active carrier assignment can be edited')
  }
  const shipmentId = String(assignment.shipmentId)
  await requireLiveShipment(shipmentId)
  if (String(assignment.updatedAt ?? '') !== expectedUpdatedAt) throw conflictError('assignment', null)
  if (patch.legStopIds !== undefined) {
    const legLoadId = String(assignment.loadId)
    const legLoad = await getById(LOAD_TABLE_NAME, legLoadId)
    const live = liveRowsOf(await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', legLoadId), legLoadId)
    const others = live.filter((c) => String(c.id) !== loadCarrierId).map(toLegCarrier)
    const legStopIds = patch.legStopIds as string[]
    const checked = validateLegs(
      [...others, { ...toLegCarrier(assignment), legStopIds }],
      (legLoad ? readStops(legLoad) : []) as unknown as LegStop[],
    )
    if (checked.errors.length > 0) throw new Error(checked.errors.join('; '))
    const overlap = others.length > 0
      ? validateCarrierAdd(others, { kind: 'CARRIER', carrierId: optionalString(assignment.carrierId, 100), legStopIds })
      : null
    if (overlap) throw new Error(overlap)
  }
  // Step AQ. An Ivan Cartage carrier's driver is a Driver record, never typed; on every other leg a
  // roster id has no meaning here.
  const ivan = isIvanCartageName(optionalString(assignment.carrierName, 200))
  if (!ivan && input.driverId != null) {
    throw new Error('driverId cannot be changed here: money, rate confirmation and status have their own actions')
  }
  const ownFleetPatch: Row = ivan ? await ownFleetDriverPatch(input, patch) : {}
  // Step AT: a details edit of the carrier's override keeps an earlier confirmation, like SET_TRACKING_PREFS.
  if (patch.trackingPrefs !== undefined) {
    patch.trackingPrefs = stampTrackingPrefs(
      patch.trackingPrefs as ReturnType<typeof validateTrackingPrefsOverride>,
      parseTrackingPrefs(assignment.trackingPrefs),
      caller,
    )
  }

  // Step AM. Filling in the last driver field here earns the same rung ENTER_DRIVER_INFO does.
  const directoryId = optionalString(assignment.carrierId, 100)
  const directory = directoryId ? await getById(CARRIER_TABLE_NAME, directoryId) : null
  const now = nowIso()
  const merged: Row = { ...patch, ...ownFleetPatch }
  const step = directory ? ladderStep(assignment, directory.status, merged, now) : null
  await transact(
    [
      updateItemTx(
        LOAD_CARRIER_TABLE_NAME,
        loadCarrierId,
        { ...merged, ...(step?.cols ?? {}), updatedBy: caller.email, updatedAt: now },
        expectedUpdatedAt,
      ),
      ...(step ? ladderMirrorWrites(assignment, await mirrorRungFor(assignment, step.to), now) : []),
    ],
    'assignment',
  )
  await writeAudit('LOAD_CARRIER', loadCarrierId, 'UPDATE_LOAD_CARRIER_DETAILS', caller, {
    loadId: assignment.loadId,
    keys: Object.keys(merged),
  })
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
  await requireLiveShipment(shipmentId)
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
  const activeCarrier: Row | null = liveRowsOf(bundle.loadCarriers, loadId)[0] ?? null
  const financials = bundle.financials.find((f) => f.id === loadId) ?? null
  if (chargeRequests.length > 0 && financials?.frozenAt) {
    throw new Error('This load\'s financials are frozen and can no longer be changed')
  }

  const settings = chargeRequests.length > 0 ? await getSettings() : null
  const customer = chargeRequests.length > 0 ? await customerOf(bundle.shipment) : null
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

  // Who recorded the time: the tracking page's hand-off says so; a person logging a check call is MANUAL.
  const stampSource = optionalEnum(input.stampSource, STOP_TIME_SOURCES, 'stampSource') ?? 'MANUAL'
  const eventId = stopEvent && stopId ? stopEventId(loadId, stopId, stopEvent) : null
  // The driver app's projector writes this same derived id. If it got there first
  // its stamp is the one that counts: the stop clock is left alone and this call is
  // kept as a location update carrying the dispatcher's note.
  const alreadyLogged = eventId != null && (await getById(LOAD_CHECK_CALL_TABLE_NAME, eventId)) != null
  const type: CheckCallType = alreadyLogged ? 'LOCATION_UPDATE' : requestedType
  // Only a stop with an id can be stamped, and `stopId` was checked against them.
  const stamped = stops as (StopShape & { id: string })[]
  const stamp = stopEvent && stopId && !alreadyLogged
    ? stampStopEvent(stamped, stopId, stopEvent, at, stampSource)
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
        ...lastKnownPatch(
          { at, type, source: 'MANUAL', city, state, lat, lng },
          {
            lastKnownAt: load.lastKnownAt as string | null | undefined,
            lastKnownCity: load.lastKnownCity as string | null | undefined,
            lastKnownState: load.lastKnownState as string | null | undefined,
            lastKnownLat: load.lastKnownLat as number | null | undefined,
            lastKnownLng: load.lastKnownLng as number | null | undefined,
          },
        ),
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
  if (row.shipmentId) await requireLiveShipment(String(row.shipmentId))

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
  await requireLiveShipment(shipmentId)

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
  await requireLiveShipment(shipmentId)

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
  const shipmentId = String(order.shipmentId)
  const shipment = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  assertNotVoided(shipment)

  const revenue = numberOrNull(order.revenueCents) ?? 0
  if (requested === 'UNBILLED') {
    // Refused before the gate, never instead of it: UNBILLED is the rung AR works
    // from, and an order with no customer record dies there on a lookup that was
    // never going to find anything.
    assertCustomerResolved(order, 'releasing it to accounting')
    // Ryne's release-to-accounting rule, the same one READY_TO_INVOICE and every
    // finance path run: delivered, every required document and reference present,
    // the cost of the move recorded, nothing still open. `invoiceEarly` used to let
    // an undelivered order through here; it does not any more, because a gate with
    // a flag that opens it is not a gate.
    const bundle = await readBundle(shipmentId)
    const customerId = optionalString(order.customerId, 100)
    const release = evaluateReleaseGate(
      await loadReleaseGateInput(
        {
          db: dynamo,
          tables: {
            ...store.tables,
            customer: CUSTOMER_TABLE_NAME,
            settings: SETTINGS_TABLE_NAME,
            loadCheckCall: LOAD_CHECK_CALL_TABLE_NAME,
          },
        },
        {
          shipmentId,
          orderId,
          shipment: bundle.shipment,
          order,
          orders: bundle.orders,
          loads: bundle.loads,
          loadCarriers: bundle.loadCarriers,
          documents: bundle.documents,
          customer: customerId ? await getById(CUSTOMER_TABLE_NAME, customerId) : null,
          settings: await getSettings(),
        },
      ),
    )
    if (!release.ok) throw releaseGateError(release.missing)
    // Load Review is the only way into billing: a hand-set UNBILLED is the same
    // release by another door. Imported Aljex history (legacyImported) is exempt.
    if (bundle.shipment.legacyImported !== true) throw new Error(LOAD_REVIEW_ONLY_MESSAGE)
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
 * customer whose name or alias it names.
 *
 * Null is a real answer, not a failure. A name that matches nobody, a name two
 * customers both answer to, and a name whose only match is archived all come back
 * null, and the load is backfilled as an UNRESOLVED shipment carrying its typed
 * customer text. Nothing is invented and nothing is lost: for the ambiguous case in
 * particular, writing either candidate would hang one customer's revenue on another
 * customer's ledger, and the whole point is that neither id is written.
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
  /** Null when no customer record was matched — the row is written unresolved. */
  customerId: string | null
  /** The operator's typed customer text, carried verbatim onto the new rows. */
  customerName: string | null
  /** The load's existing PRO, normalized. Null when there is nothing claimable. */
  pro: string | null
  loadStatus: LoadWorkflowStatus
  shipmentStatus: ShipmentStatus
  arStatus: ArStatus
  assignmentType: 'OWN_ASSET' | 'NEED_TO_COVER'
  loadCarrierId: string | null
  driverId: string | null
  revenueCents: number
  /** The Shipment under this load's deterministic id already exists: re-point only. */
  relink: boolean
  skipped: string | null
}

/**
 * Map one legacy load onto a Shipment/Order/Load trio.
 *
 * Nothing here invents history: the number is the bare PRO the office already says
 * out loud (the trimmed Aljex id; `L<pro>` only when that PRO is not all digits or
 * another shipment already holds it), and the status comes from the stop clock.
 * Re-runs and relinks find the shipment by the load id, never by this number.
 *
 * An imported order starts on DOCS_NEEDED and nowhere else. The legacy
 * `readyToInvoice` flag is a dispatcher in Aljex saying the work was done — it is
 * evidence of delivery, which is why `backfillLoadStatus` still reads it, but it
 * is not the release gate. Ryne's rule is that nothing reaches AR without the
 * gate (`src/lib/releaseGate.ts`), and an import carries none of what the gate
 * asks for: no documents, no references, no settled carrier charges. Letting the
 * flag mint UNBILLED would hand imported freight the one rung the gate exists to
 * guard. Where these Aljex-era bills really belong is the LEGACY rung, and
 * `scripts/backfillLegacyAr.mjs` is what moves them there, invoice-safe.
 *
 * When the Shipment already exists — a Load table refreshed from production keeps
 * the freight and loses the link a previous run wrote — that row is the record:
 * the load is pointed back at it and its customer, the number is the one it already
 * carries, and no customer match is asked for, because nothing is being created.
 *
 * A load whose customer text matches no record — or two records, or only an archived
 * one — is no longer skipped. It gets a real Shipment carrying that text and no
 * `customerId` attribute at all, which is the honest record of what is known. The
 * 892 orders a previous run already linked are untouched: `ALREADY_LINKED` is still
 * the first answer this gives.
 */
function planBackfill(
  load: Row,
  brokerDriverIds: Set<string>,
  customerId: string | null,
  existing: Row | null,
  /** Another shipment already holds exactly the bare PRO as its number (checked by `backfillShipments`). */
  numberTaken: boolean,
  /** The ProClaim already standing on this load's PRO, when there is one. */
  claim: Row | null,
): BackfillPlan {
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
  const relink = existing != null
  // A refreshed Load table can point back at a shipment somebody has since voided.
  // Re-linking it would put the freight back on the calendar, in dispatch and in the
  // pay hooks under a shipment that has left the working set, and the void mirror is
  // the only thing keeping it out of them. That is a person's call, not an import's.
  const voidedTarget = relink && (optionalString(existing.voidedAt, 40) || optionalString(existing.deletedAt, 40)) != null
  const existingOrderId = relink && Array.isArray(existing.orderIds) ? optionalString(existing.orderIds[0], 100) : null
  // A PRO claimed by THIS load is a previous run or `scripts/backfillProClaims.mjs`
  // having got there first, and is simply nothing left to do. A PRO claimed by a
  // DIFFERENT load is two pieces of freight under one number, which is the thing the
  // claim exists to catch and is not something an import may paper over.
  const pro = normalizePro(optionalString(load.aljexId, 120))
  const claimedElsewhere = claim != null && String(claim.loadId ?? '') !== loadId
  return {
    loadId,
    shipmentId: stableId('shp', loadId),
    orderId: existingOrderId ?? stableId('ord', loadId),
    number: (relink ? optionalString(existing.number, 40) : null) ?? backfillShipmentNumber(load.aljexId as string | null | undefined, loadId, numberTaken),
    customerId: (relink ? optionalString(existing.customerId, 100) : null) ?? customerId,
    customerName: optionalString(load.customer, 200),
    pro,
    loadStatus,
    shipmentStatus: loadStatus === 'SOURCING' ? 'OPEN' : (loadStatus as ShipmentStatus),
    arStatus: 'DOCS_NEEDED',
    assignmentType: ownAsset ? 'OWN_ASSET' : 'NEED_TO_COVER',
    loadCarrierId: ownAsset ? stableId('lcr', loadId) : null,
    driverId: realDriverId,
    revenueCents,
    relink,
    skipped: load.shipmentId
      ? 'ALREADY_LINKED'
      : voidedTarget
        ? 'SHIPMENT_VOIDED'
        : claimedElsewhere
          ? 'PRO_CLAIMED_BY_OTHER_LOAD'
          : null,
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
    const existing = load.shipmentId ? null : await getById(SHIPMENT_TABLE_NAME, stableId('shp', loadId))
    const existingPro = normalizePro(optionalString(load.aljexId, 120))
    const claim = existingPro ? await getById(PRO_CLAIM_TABLE_NAME, existingPro) : null
    // The bare PRO is the number unless another shipment already holds it. Only a
    // fresh shipment needs the answer: a relink keeps the number it already has.
    const barePro = digitsOnlyPro(load.aljexId as string | null | undefined)
    const numberTaken = !existing && barePro != null
      && (await queryIndex(SHIPMENT_TABLE_NAME, IDX_SHIPMENTS_BY_NUMBER, 'number', barePro))
        .some((s) => String(s.id) !== stableId('shp', loadId))
    const plan = planBackfill(load, brokerDriverIds, resolveBackfillCustomerId(load, customersByName), existing, numberTaken, claim)
    planned.push(plan)
    if (dryRun || plan.skipped) continue

    // The load's PRO is claimed in the same write that gives it a shipment, unless
    // this very load already holds the claim — `scripts/backfillProClaims.mjs` runs
    // ahead of enforcement and may have got there first. A blank or unusable PRO is
    // left unclaimed rather than refused: the freight is real and already in the
    // table, and SET_LOAD_PRO is how it is given a number it can keep.
    const claimWrites = plan.pro != null && claim == null
      ? [proClaimPut(plan.pro, {
        loadId: plan.loadId,
        shipmentId: plan.shipmentId,
        claimedBy: caller.email,
        origin: 'BACKFILL',
      })]
      : []
    const claimRefusals = claimWrites.length > 0 ? [proAlreadyIssuedMessage(String(plan.pro))] : []

    const now = nowIso()
    const customerName = optionalString(load.customer, 200)
    const legacy = deriveLegacyFields(readStops(load))
    // deriveLegacyFields writes '' for an undated stop, and '' is a key DynamoDB
    // refuses on the three Shipment indexes sorted by pickupAppt. Undated stays absent.
    const pickupAppt = optionalString(legacy.pickupAppt, 64) ?? optionalString(load.pickupAppt, 64) ?? undefined
    const deliveryAppt = optionalString(legacy.deliveryAppt, 64) ?? optionalString(load.deliveryAppt, 64) ?? undefined
    const pickupMonth = monthOf(pickupAppt) ?? undefined

    // The rows survive a refresh of the Load table; only the link on the load is lost.
    // Re-running then only has to repoint the load, and the conditional puts guarantee
    // it either way.
    if (!plan.relink) {
      const writes: TransactWriteItem[] = [
        ...claimWrites,
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
      await transact(writes, 'backfill', { refusals: claimRefusals })
    } else if (claimWrites.length > 0) {
      await transact(claimWrites, 'pro claim', { refusals: claimRefusals })
    }

    // On a relink the leg that is really on the load wins over a fresh derivation:
    // the own-asset row a previous run wrote, or a carrier booked on the mirror since.
    let assignmentType: 'OWN_ASSET' | 'CARRIER' | 'NEED_TO_COVER' = plan.assignmentType
    let activeLoadCarrierId = plan.loadCarrierId
    if (plan.relink) {
      const legs = await queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_LOAD, 'loadId', plan.loadId)
      const active: Row | null = liveRowsOf(legs, plan.loadId)[0] ?? null
      activeLoadCarrierId = active ? String(active.id) : null
      assignmentType = active ? (active.kind === 'CARRIER' ? 'CARRIER' : 'OWN_ASSET') : 'NEED_TO_COVER'
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
        assignmentType,
        activeLoadCarrierId,
        ...(pickupMonth ? { pickupMonth } : {}),
        updatedBy: caller.email,
      }),
      'Load update',
    )
    // Step R. A backfilled shipment is tagged the same way a new one is: the leg
    // the plan just wrote names the driver, and the rules read it from there.
    await applyTagToLoads(plan.shipmentId, caller)
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
    userProfile: USER_PROFILE_TABLE_NAME,
  },
  fromAddress: FROM_ADDRESS,
  portalOrigin: PORTAL_ORIGIN,
  randomBytes,
  writeAudit,
  getSettings,
  getBookableCustomer,
  priceFromMarket: (input, caller) => priceFromMarket(marketRateDeps, input, caller),
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
  voidShipmentForQuote,
  assertNoInvoicedOrders,
}

// ── Step P deps ──────────────────────────────────────────────────────────────

/**
 * Step J's answer for a provider, read the way the Integrations page reads it.
 *
 * Credentials live in SSM and never anywhere else; this role may read them and
 * may not write one. An unconnected provider answers `{}`, which `modeOf` turns
 * into STUB — so a board posting or a RateView lookup degrades to a labelled
 * stub rather than to a silent failure.
 */
/**
 * The settings singleton, or an empty row.
 *
 * The Step P modules take `Promise<Row>` rather than `Promise<Row | null>`: an
 * absent settings row means "every org default", which each resolver already
 * answers for, so there is nothing for them to branch on.
 */
async function settingsRowOrEmpty(): Promise<Row> {
  return (await getSettings()) ?? {}
}

async function providerCredentials(provider: string): Promise<Record<string, string>> {
  try {
    return (await readPageCredentials(provider)) ?? {}
  } catch (err) {
    console.warn(`[tms-shipment-actions] could not read ${provider} credentials:`, String(err))
    return {}
  }
}

/**
 * A load board, as this router may use one.
 *
 * No live board adapter is registered yet — Ryne has no DAT or Truckstop
 * credentials — so `adapterFor` hands back the stub, and the stub's own
 * `mode: 'STUB'` is what lands on the posting row. The day a live adapter exists
 * it is passed as the third argument here and nothing else changes.
 */
async function boardAdapterFor(provider: string) {
  const descriptor = descriptorOf(provider as ProviderKey)
  if (!descriptor) throw new Error(`${provider} is not a provider this build knows`)
  const credentials = await providerCredentials(provider)
  const adapter = adapterFor(descriptor, credentials)
  const ctx = { provider: descriptor.key, credentials, settings: {}, now: nowIso() }
  return {
    mode: modeOf(descriptor, credentials),
    post: async (input: Record<string, unknown>) => {
      if (!adapter.post) throw new Error(`${descriptor.label} does not offer posting`)
      return adapter.post(ctx, input)
    },
    // The stub adapter has no `unpost` capability of its own — no provider
    // declares one — so the honest answer is written here rather than faked by
    // calling `post` with a flag and calling the result a take-down.
    unpost: async (input: Record<string, unknown>) => ({
      mode: 'STUB' as const,
      ok: true,
      message: `STUB — no ${descriptor.label} call was made. A live ${descriptor.label} `
        + 'connection would have removed this posting from the board.',
      detail: { provider: descriptor.key, capability: 'unpost', sample: input },
    }),
  }
}

const buildGateDeps: BuildGateDeps = {
  tables: {
    shipment: SHIPMENT_TABLE_NAME,
    order: ORDER_TABLE_NAME,
    load: LOAD_TABLE_NAME,
    customer: CUSTOMER_TABLE_NAME,
    settings: SETTINGS_TABLE_NAME,
  },
  getById,
  queryIndex,
  transact: (items) => transact(items, 'buildGate'),
  readBundle: (shipmentId) => readBundle(shipmentId) as unknown as Promise<Row>,
  getSettings: settingsRowOrEmpty,
  writeAudit,
  now: nowIso,
}

const postingDeps: PostingDeps = {
  tables: {
    posting: SHIPMENT_POSTING_TABLE_NAME,
    shipment: SHIPMENT_TABLE_NAME,
    load: LOAD_TABLE_NAME,
    order: ORDER_TABLE_NAME,
    integration: INTEGRATION_TABLE_NAME,
    quote: QUOTE_TABLE_NAME,
  },
  getById,
  queryIndex,
  transact: (items) => transact(items, 'posting'),
  readBundle,
  writeAudit,
  adapterFor: boardAdapterFor,
  now: nowIso,
}

const laneIntelDeps: LaneIntelDeps = {
  db: dynamo,
  tables: { quote: QUOTE_TABLE_NAME, laneSample: LANE_RATE_SAMPLE_TABLE_NAME, load: LOAD_TABLE_NAME },
  now: nowIso,
}

const marketRateDeps: MarketRateDeps = {
  tables: {
    quote: QUOTE_TABLE_NAME,
    customer: CUSTOMER_TABLE_NAME,
    settings: SETTINGS_TABLE_NAME,
    integration: INTEGRATION_TABLE_NAME,
  },
  getById,
  transact: (items) => transact(items, 'marketRate'),
  writeAudit,
  getSettings: settingsRowOrEmpty,
  credentialsFor: providerCredentials,
  fetchImpl: fetch,
  now: nowIso,
}

const carrierOfferDeps: CarrierOfferDeps = {
  tables: {
    quote: QUOTE_TABLE_NAME,
    carrier: CARRIER_TABLE_NAME,
    carrierDocument: CARRIER_DOCUMENT_TABLE_NAME,
    shipment: SHIPMENT_TABLE_NAME,
    load: LOAD_TABLE_NAME,
    posting: SHIPMENT_POSTING_TABLE_NAME,
    settings: SETTINGS_TABLE_NAME,
  },
  getById,
  queryIndex: (tableName, indexName, keyName, keyValue) =>
    queryIndex(tableName, indexName, keyName, String(keyValue)),
  transact: (items) => transact(items, 'carrierOffer'),
  getSettings: settingsRowOrEmpty,
  writeAudit,
  // One rule for whether a carrier may haul: the same `evaluateCarrierBooking`
  // BOOK_CARRIER runs, asked without a load so it answers about the carrier alone.
  carrierStanding: (carrier, settings) => {
    if (!carrier) {
      return {
        known: false,
        bookable: false,
        blockers: ['That MC is not in the carrier directory yet'],
        warnings: [],
        status: '',
        mcpStatus: null,
      }
    }
    // `evaluateCarrierBooking` answers about a carrier ON a load. An offer has no
    // load yet, so it is asked with an empty leg: the carrier-side findings
    // (authority, insurance, status, paperwork) are exactly the ones that decide
    // whether this offer is worth acting on, and the load-side ones cannot fire
    // without a load to fire about.
    const verdict = evaluateCarrierBooking({
      carrier: carrier as unknown as Parameters<typeof evaluateCarrierBooking>[0]['carrier'],
      documents: [],
      settings: settings as unknown as Parameters<typeof evaluateCarrierBooking>[0]['settings'],
      load: { id: '' },
      financials: null,
      carrierRateCents: 0,
      otherActiveLoadCarriers: [],
      isAdmin: false,
      now: new Date(),
    })
    return {
      known: true,
      bookable: verdict.blocks.length === 0,
      blockers: verdict.blocks.map((b) => b.detail),
      warnings: verdict.warnings.map((w) => w.detail),
      status: String(carrier.status ?? ''),
      mcpStatus: carrier.mcpStatus == null ? null : String(carrier.mcpStatus),
    }
  },
  setupPacketAdapter: async () => {
    const descriptor = descriptorOf('MYCARRIERPACKETS')
    if (!descriptor) throw new Error('MyCarrierPackets is not a provider this build knows')
    const credentials = await providerCredentials('MYCARRIERPACKETS')
    const mode = modeOf(descriptor, credentials)
    const adapter = mode === 'LIVE' ? mcpAdapter(credentials) : adapterFor(descriptor, credentials)
    const ctx = { provider: descriptor.key, credentials, settings: {}, now: nowIso() }
    return {
      mode,
      send: async (input: Record<string, unknown>) => {
        if (adapter.setupPacket) return adapter.setupPacket(ctx, input)
        // Fallback for the stub adapter: the existing sync capability echoes back.
        if (adapter.sync) return adapter.sync(ctx, input)
        throw new Error('MyCarrierPackets does not offer a setup packet')
      },
    }
  },
  // One counter for every quote, buy side and sell side alike.
  nextQuoteNumber: () => nextQuoteNumber(quoteDeps, { email: 'system', sub: 'system', groups: [], isAdmin: true }, nowIso()),
  now: nowIso,
}

const carrierInboundDeps: CarrierInboundDeps = {
  ...carrierOfferDeps,
  tables: { ...carrierOfferDeps.tables, message: SHIPMENT_MESSAGE_TABLE_NAME, proClaim: PRO_CLAIM_TABLE_NAME },
}

/** Intake e-mail files -> the shipment's customer rate con documents (S3 copy under shipment-docs/ + one row each; idempotent per file). */
async function attachIntakeFiles(
  shipmentId: string,
  intakeId: string,
  attachments: { key: string; name: string; contentType: string; size: number }[],
  caller: Caller,
): Promise<number> {
  if (!BUCKET_NAME) return 0
  const allowed = new Set(['application/pdf', 'image/png', 'image/jpeg'])
  const order = (await queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId))[0]
  let attached = 0
  for (const [index, file] of attachments.entries()) {
    if (!allowed.has(file.contentType) || !file.key.startsWith('intake-attachments/')) continue
    const id = `intake-${intakeId}-${index}`
    const key = documentKey(shipmentId, id, file.name, file.contentType)
    try {
      await s3.send(new CopyObjectCommand({ Bucket: BUCKET_NAME, CopySource: `${BUCKET_NAME}/${file.key}`, Key: key }))
      const now = nowIso()
      await transact([putItem(documentDeps.store.tables.shipmentDocument, {
        id, __typename: 'ShipmentDocument', shipmentId, ...(order?.id ? { orderId: String(order.id) } : {}), type: 'CUSTOMER_RATE_CON',
        name: file.name.slice(0, 200), s3Key: key, contentType: file.contentType, sizeBytes: Math.max(0, Math.trunc(file.size) || 0), source: 'UPLOAD',
        audience: 'INTERNAL', status: 'ACTIVE', version: 1, uploadedBy: 'intake', uploadedAt: now, createdBy: caller.email, createdAt: now, updatedAt: now,
      })], 'intake document')
      attached += 1
    } catch (err) {
      console.error('[shipment-actions] intake file not attached', shipmentId, intakeId, err instanceof Error ? err.message : String(err))
    }
  }
  return attached
}

const intakeDeps: IntakeDeps = {
  tables: { intakeLoad: INTAKE_LOAD_TABLE_NAME, shipment: SHIPMENT_TABLE_NAME, order: ORDER_TABLE_NAME, load: LOAD_TABLE_NAME },
  getById,
  queryIndex,
  transact: (items, label) => transact(items, label),
  getSettings,
  getCustomer: (id) => getById(CUSTOMER_TABLE_NAME, id),
  isDivisionActive: (code) => assertTaggableDivision(code, null).then(() => true, () => false),
  writeAudit,
  attachFiles: attachIntakeFiles,
  actions: { createShipment, setRevTag, setSalesRep, assignAsset },
  now: nowIso,
}

const demoDeps: DemoDeps = {
  tables: {
    demo: DEMO_RECORD_TABLE_NAME,
    shipment: SHIPMENT_TABLE_NAME,
    order: ORDER_TABLE_NAME,
    load: LOAD_TABLE_NAME,
    loadCarrier: LOAD_CARRIER_TABLE_NAME,
    customer: CUSTOMER_TABLE_NAME,
    carrier: CARRIER_TABLE_NAME,
    carrierDocument: CARRIER_DOCUMENT_TABLE_NAME,
    quote: QUOTE_TABLE_NAME,
    posting: SHIPMENT_POSTING_TABLE_NAME,
    message: SHIPMENT_MESSAGE_TABLE_NAME,
    document: SHIPMENT_DOCUMENT_TABLE_NAME,
    checkCall: LOAD_CHECK_CALL_TABLE_NAME,
    trackingLink: TRACKING_LINK_TABLE_NAME,
    settings: SETTINGS_TABLE_NAME,
    intakeLoad: INTAKE_LOAD_TABLE_NAME,
  },
  getById,
  queryIndex: (tableName, indexName, keyName, keyValue) =>
    queryIndex(tableName, indexName, keyName, String(keyValue)),
  scanTable,
  transact: (items) => transact(items, 'demo'),
  getSettings: settingsRowOrEmpty,
  writeAudit,
  isDevStack: IS_DEV_STACK,
  actions: {
    createShipment,
    saveOrderForm: async (input: Row, caller: Caller) => ({ bundle: (await saveOrderForm(input, caller)).bundle as unknown as Row }),
    submitOrder,
    setShipmentStatus,
    assignCarrierRep,
    bookCarrier,
    voidShipment,
  },
  now: nowIso,
  randomId: randomUUID,
}

// ── Step AW D.4: post-invoice change rule ────────────────────────────────────

const guardedRunners: Record<PostInvoiceGuardedAction, (input: Row, caller: Caller) => Promise<Row>> = {
  SAVE_ORDER_FORM: async (input, caller) => (await saveOrderForm(input, caller)).bundle as unknown as Row,
  UPDATE_ORDER_DETAILS: updateOrderDetails,
  UPDATE_STOP: updateStop,
  UPDATE_LOAD_CARRIER_DETAILS: updateLoadCarrierDetails,
  RECALC_CHARGES: recalcCharges,
  UPDATE_CARRIER_CHARGES: updateCarrierCharges,
}

/** The shipment an edit targets: named directly, or through its load or carrier assignment. */
async function shipmentIdOfEdit(input: Row): Promise<string | null> {
  const direct = optionalString(input.shipmentId, 100)
  if (direct) return direct
  const loadId = optionalString(input.loadId, 100)
  if (loadId) return optionalString((await getById(LOAD_TABLE_NAME, loadId))?.shipmentId, 100) ?? null
  const loadCarrierId = optionalString(input.loadCarrierId, 100)
  if (loadCarrierId) return optionalString((await getById(LOAD_CARRIER_TABLE_NAME, loadCarrierId))?.shipmentId, 100) ?? null
  return null
}

/**
 * R18. An edit to a shipment that already has an invoice is allowed, but needs a
 * `changeReason` (REASON_REQUIRED otherwise), steps the frozen-financials guards aside,
 * and leaves one POST_INVOICE_CHANGE entry (reason, before, after, who, when) on the
 * Shipment, the Order and the Invoice. The gate's own input keys are never taken from
 * the wire; an un-invoiced shipment runs exactly as before.
 */
async function runPostInvoiceGuarded(action: PostInvoiceGuardedAction, input: Row, caller: Caller): Promise<Row> {
  const run = guardedRunners[action]
  const shipmentId = await shipmentIdOfEdit(input)
  const before = shipmentId ? await readBundle(shipmentId) : null
  const order = before?.orders[0] ?? null
  if (!shipmentId || !before || !isInvoicedOrder(order)) return run(cleanGuardedInput(input, false), caller)

  const verdict = readChangeReason(input)
  if (!verdict.ok) throw new Error(REASON_REQUIRED_MESSAGE)
  const result = await run(cleanGuardedInput(input, true), caller)
  const after = await readBundle(shipmentId)
  const entry = buildPostInvoiceEntry({
    reason: verdict.reason,
    sourceAction: action,
    diff: diffSnapshots(snapshotOf(before), snapshotOf(after)),
    user: caller.email,
    at: nowIso(),
    order,
    shipmentId,
  })
  await writeAudit('SHIPMENT', shipmentId, POST_INVOICE_ACTION, caller, entry as unknown as Row)
  await writeAudit('ORDER', String(order?.id), POST_INVOICE_ACTION, caller, entry as unknown as Row)
  if (entry.invoiceId) await writeAudit('Invoice', entry.invoiceId, POST_INVOICE_ACTION, caller, entry as unknown as Row)
  return result
}

// ── Shipment edit lock ───────────────────────────────────────────────────────
// A person in a shipment's edit form holds it for 10 minutes (the form refreshes it every few minutes and releases it on save and
// exit). Another person gets the holder back instead of the lock. Neither action touches updatedAt, so a lock never makes a
// save's expectedUpdatedAt stale.

const EDIT_LOCK_MS = 10 * 60_000

async function lockShipment(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + EDIT_LOCK_MS).toISOString()
  // "Take over": the holder's tab is stale or forgotten and somebody needs the shipment now. The previous holder's next save is
  // refused by the guard like any other person's, so nothing they had unsaved can overwrite this person's work; it is audited.
  if (input.takeOver === true) {
    const before = await getById(SHIPMENT_TABLE_NAME, shipmentId)
    if (!before) throw new Error('Shipment not found')
    await dynamo.send(new UpdateItemCommand({
      TableName: SHIPMENT_TABLE_NAME,
      Key: { id: { S: shipmentId } },
      UpdateExpression: 'SET editLockUserId = :u, editLockUserName = :n, editLockExpiresAt = :e',
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeValues: { ':u': { S: caller.email }, ':n': { S: caller.email }, ':e': { S: expiresAt } },
    }))
    const previous = optionalString(before.editLockUserId, 200)
    if (previous && previous.toLowerCase() !== caller.email.toLowerCase()) {
      await writeAudit('SHIPMENT', shipmentId, 'LOCK_TAKEN_OVER', caller, { previousHolder: previous, previousExpiresAt: optionalString(before.editLockExpiresAt, 40) })
    }
    return { locked: true, lockedBy: caller.email, expiresAt }
  }
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: SHIPMENT_TABLE_NAME,
      Key: { id: { S: shipmentId } },
      UpdateExpression: 'SET editLockUserId = :u, editLockUserName = :n, editLockExpiresAt = :e',
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(editLockUserId) OR editLockUserId = :u OR editLockExpiresAt < :now)',
      ExpressionAttributeValues: { ':u': { S: caller.email }, ':n': { S: caller.email }, ':e': { S: expiresAt }, ':now': { S: now.toISOString() } },
    }))
    return { locked: true, lockedBy: caller.email, expiresAt }
  } catch (err) {
    if ((err as { name?: string } | null)?.name !== 'ConditionalCheckFailedException') throw err
  }
  // The lock is held by someone else (or the shipment is gone): hand back who.
  const row = await getById(SHIPMENT_TABLE_NAME, shipmentId)
  if (!row) throw new Error('Shipment not found')
  return { locked: false, lockedBy: optionalString(row.editLockUserName, 200), expiresAt: optionalString(row.editLockExpiresAt, 40) }
}

/** Release the caller's lock; an ADMIN may break someone else's (`force`). A lock that is not the caller's is left alone. */
async function unlockShipment(input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const force = input.force === true && caller.isAdmin
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: SHIPMENT_TABLE_NAME,
      Key: { id: { S: shipmentId } },
      UpdateExpression: 'REMOVE editLockUserId, editLockUserName, editLockExpiresAt',
      ConditionExpression: force ? 'attribute_exists(id)' : 'attribute_exists(id) AND editLockUserId = :u',
      ...(force ? {} : { ExpressionAttributeValues: { ':u': { S: caller.email } } }),
    }))
    return { released: true }
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'ConditionalCheckFailedException') return { released: false }
    throw err
  }
}

/**
 * The edit lock (LOCK_SHIPMENT) is enforced where the form saves: while another person holds a live lock, these actions are refused for
 * everyone but that person and ADMINs. A system caller and an action without a shipmentId are never refused.
 */
const LOCK_GUARDED_ACTIONS: ReadonlySet<string> = new Set([
  'SAVE_ORDER_FORM', 'UPDATE_ORDER_DETAILS', 'UPDATE_STOP', 'UPDATE_CARRIER_CHARGES', 'UPDATE_LOAD_CARRIER_DETAILS',
  'SET_SALES_REP', 'SET_REV_TAG', 'SET_SHIPMENT_CUSTOMER', 'SUBMIT_ORDER', 'SET_LOAD_PRO',
])

export function lockHeldAgainst(shipment: Row | null | undefined, caller: { email: string; isAdmin?: boolean }, nowMs: number): { by: string; until: string } | null {
  if (!shipment || caller.isAdmin) return null
  const holder = optionalString(shipment.editLockUserId, 200)
  const until = optionalString(shipment.editLockExpiresAt, 40)
  if (!holder || !until || Date.parse(until) <= nowMs || holder.toLowerCase() === caller.email.toLowerCase()) return null
  return { by: optionalString(shipment.editLockUserName, 200) ?? holder, until }
}

async function assertNotLockedByOther(action: string, input: Row, caller: Caller): Promise<void> {
  if (!LOCK_GUARDED_ACTIONS.has(action) || caller.email === SYSTEM_CALLER_EMAIL) return
  const shipmentId = optionalString(input.shipmentId, 100)
  if (!shipmentId) return
  const held = lockHeldAgainst(await getById(SHIPMENT_TABLE_NAME, shipmentId), caller, Date.now())
  if (held) throw new Error(`${held.by} is editing this shipment (locked until ${held.until}). Try again after they save and exit.`)
}

// ── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (event: AppSyncEvent): Promise<Row> => {
  const action = event.arguments.action as Action
  const input = parseInput(event.arguments.input)
  const authorizedAction = action === 'BATCH_SHIPMENT_TASK'
    ? BATCH_TASK_ACTIONS[assertEnum(input.task, Object.keys(BATCH_TASK_ACTIONS) as (keyof typeof BATCH_TASK_ACTIONS)[], 'task')]
    : action
  const caller = await authorize(authorizedAction, event.identity, event.systemCaller)

  await assertNotLockedByOther(action, input, caller)

  if (isPostInvoiceGuarded(action)) return runPostInvoiceGuarded(action, input, caller)

  switch (action) {
    case 'DELETE_SHIPMENTS':
    case 'LATEST_DELETE_EXPORT':
    case 'RESTORE_DELETED_SHIPMENTS': {
      const tables = Object.fromEntries(Object.entries(SHIPMENT_ACTIONS_TABLES).map(([key, model]) => [model, process.env[key] ?? '']))
      const store = shipmentDeleteStore(dynamo, s3, tables, process.env.DATA_SAFETY_BUCKET_NAME ?? '')
      if (action === 'LATEST_DELETE_EXPORT') return latestDeleteExport(store, caller)
      return action === 'DELETE_SHIPMENTS'
        ? { ...(await deleteShipments(store, input, caller)) }
        : { ...(await restoreDeleted(store, input, caller)) }
    }
    case 'CREATE_SHIPMENT': {
      const created = await createShipment(input, caller)
      // The queue must never keep a row for a load that now exists, whatever happens to the form's own link call afterwards.
      const createdId = optionalString((created as { shipment?: { id?: unknown } }).shipment?.id, 100)
      if (createdId) await reconcileOpenIntake(intakeDeps, createdId, caller)
      return created
    }
    case 'INTAKE_SAVE_DRAFT':
    case 'INTAKE_MOVE_TO_ACTIVE':
    case 'INTAKE_MARK_REVIEWED':
    case 'INTAKE_DISMISS':
    case 'INTAKE_LINK_SHIPMENT':
    case 'INTAKE_ATTACH_FILES':
    case 'INTAKE_DELETE':
    case 'INTAKE_NOT_DUPLICATE':
      return runIntakeAction(intakeDeps, action as IntakeAction, input, caller)
    case 'CHECK_CREDIT':
      return checkCredit(input)
    case 'SUBMIT_ORDER':
      return submitOrder(input, caller)
    case 'SET_SHIPMENT_STATUS':
      return setShipmentStatus(input, caller)
    case 'SET_LOAD_STATUS':
      return setLoadStatus(input, caller)
    case 'VOID_SHIPMENT':
      return voidShipment(input, caller)
    case 'UNVOID_SHIPMENT':
      return unvoidShipment(input, caller)
    case 'LOCK_SHIPMENT':
      return lockShipment(input, caller)
    case 'PUSH_READY_TO_LOAD_REVIEW':
      return pushReadyToReview(caller)
    case 'UNLOCK_SHIPMENT':
      return unlockShipment(input, caller)
    case 'REPOINT_SHIPMENT_CUSTOMER':
      return repointShipmentCustomer(input, caller)
    case 'SET_REV_TAG':
      return setRevTag(input, caller)
    case 'CLEAR_REV_TAG':
      return clearRevTag(input, caller)
    case 'RESOLVE_REV_TAG':
      return resolveRevTag(input, caller)
    case 'SET_SALES_REP':
      return setSalesRep(input, caller)
    case 'LIST_ALJEX_CODES':
      return listAljexCodes()
    case 'SET_ALJEX_CODE_MAP':
      return setAljexCodeMap(input, caller)
    case 'REASSIGN_SHIPMENTS_BY_REP_CODE':
      return reassignShipmentsByRepCode(input, caller)
    case 'ASSIGN_TRACKER':
      return assignTracker(input, caller)
    case 'SET_TRACKING_PREFS':
      return setTrackingPrefs(input, caller)
    case 'ASSIGN_CARRIER_REP':
      return assignCarrierRep(input, caller)
    case 'BATCH_SHIPMENT_TASK':
      return { ...(await batchShipmentTask({
        getShipment: (id) => getById(SHIPMENT_TABLE_NAME, id),
        getOrders: (id) => queryIndex(ORDER_TABLE_NAME, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', id),
        getLoadsOf: (id) => queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', id),
        assignAsset,
        // Step AP: a batch release is Load Review's act. The reviewer grant (or ADMIN) only —
        // page-loads / page-tms reach READY_TO_INVOICE singly but not in bulk.
        authorize: (taskAction, actor) => taskAction === 'READY_TO_INVOICE'
          ? actor.isAdmin || actor.groups.includes(LOAD_REVIEW_PAGE_GROUP)
          : isActionAuthorized(taskAction, actor),
        // Every batch release is a Load Review release (the batch refuses one without the marker).
        releaseToBilling: (row, actor) => readyToInvoice(documentDeps, row, actor, { batch: true }),
        setSalesRep,
        setRevTag,
        assignCarrierRep,
        setStatus: setShipmentStatus,
        writeAudit,
        pushToReview,
      }, input, caller)) }
    case 'TEST_OWNERSHIP_RULES':
      return testOwnershipRules(input)
    case 'RETAG_SHIPMENTS':
      return retagShipments(input, caller)
    case 'TENDER_RESPOND':
      return tenderRespond(input, caller)
    case 'DUPLICATE_SHIPMENT':
      return duplicateShipment(input, caller)
    case 'SET_SHIPMENT_CUSTOMER':
      return setShipmentCustomer(input, caller)
    case 'SET_LOAD_PRO':
      return setLoadPro(input, caller)
    case 'SET_LOAD_REFS':
      return setLoadRefs(input, caller)
    case 'SET_STOP_DRIVERS':
      return setStopDrivers(input, caller)
    case 'ASSIGN_ASSET':
      return assignAsset(input, caller)
    case 'ASSIGN_CARRIER':
      return assignCarrier(input, caller)
    case 'BOOK_CARRIER':
      return bookCarrier(input, caller)
    case 'ADD_CARRIER':
      return input.carrierId != null
        ? bookCarrier(input, caller, undefined, { additional: true })
        : assignCarrier(input, caller, { additional: true })
    case 'COVER_CARRIER':
      return bookCarrier(input, caller, undefined, { cover: true })
    case 'ENTER_DRIVER_INFO':
      return enterDriverInfo(input, caller)
    case 'MARK_RATE_CON_SIGNED':
      return markRateConSigned(input, caller)
    case 'SET_QUICK_PAY':
      return setQuickPay(input, caller)
    case 'SEND_RATE_CON':
      return sendRateCon(input, caller)
    // The addresses a person needs to start the tracking thread by hand: the tracking mailbox and this shipment's thread address.
    case 'GET_TRACKING_MAILBOX':
      return { tracking: trackingMailbox(), thread: threadReplyAddress(assertString(input.shipmentId, 'shipmentId')) } as unknown as Row
    case 'VOID_RATE_CON':
      return voidRateCon(input, caller)
    case 'DISPATCH_LOAD':
      return dispatchLoad(input, caller)
    case 'REMOVE_LOAD_CARRIER':
      return removeLoadCarrier(input, caller)
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
    case 'EMAIL_BOL':
      return emailBol(input, caller)
    case 'ATTACH_DRIVER_DOC':
      return attachDriverDoc(documentDeps, input, caller)
    case 'ATTACH_INVOICE_DOC':
      return attachInvoiceDoc(documentDeps, input, caller)
    case 'REVIEW_DOCUMENT':
      return reviewDocument(documentDeps, input, caller)
    case 'UPDATE_DOCUMENT':
      return updateDocument(documentDeps, input, caller)
    case 'VOID_DOCUMENT':
      return voidDocument(documentDeps, input, caller)
    case 'SET_LOAD_REQUIRED_DOCS':
      return setLoadRequiredDocs(documentDeps, input, caller)
    case 'READY_TO_INVOICE':
      return readyToInvoice(documentDeps, input, caller)
    case 'REVIEW_LOAD':
      return reviewLoad(documentDeps, input)
    case 'RECONCILE_BILLING':
      return reconcileBilling(documentDeps, input, caller)
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
    case 'MARK_QUOTE_WON':
      return markQuoteWon(quoteDeps, input, caller)
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
    case 'SAVE_SHIPMENT_SETTINGS':
      return saveShipmentSettings(input, caller)
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

    // ── Step P ──────────────────────────────────────────────────────────────
    case 'CHECK_BUILD_GATE':
      return checkBuildGate(buildGateDeps, input)
    case 'COMPLETE_BUILD':
      return completeBuild(buildGateDeps, input, caller)
    case 'POST_LOAD':
      return postLoad(postingDeps, input, caller)
    case 'UNPOST_LOAD':
      return unpostLoad(postingDeps, input, caller)
    case 'LIST_POSTINGS':
      return listPostings(postingDeps, input)
    case 'PRICE_FROM_MARKET':
      return priceFromMarket(marketRateDeps, input, caller)
    case 'POST_QUOTE_LOAD':
      return postQuoteLoad(postingDeps, input, caller)
    case 'UNPOST_QUOTE_LOAD':
      return unpostQuoteLoad(postingDeps, input, caller)
    case 'LANE_INTELLIGENCE':
      return { ...(await getLaneIntelligence(laneIntelDeps, input)) }
    case 'RECORD_CARRIER_OFFER':
      return recordCarrierOffer(carrierOfferDeps, input, caller)
    case 'LIST_CARRIER_OFFERS':
      return listCarrierOffers(carrierOfferDeps, input)
    case 'SEND_SETUP_PACKET':
      return sendSetupPacket(carrierOfferDeps, input, caller)
    case 'SEND_CARRIER_SETUP_PACKET':
      return sendCarrierSetupPacket(carrierOfferDeps, input, caller)
    case 'GET_DEMO_STATE':
      return getDemoState(demoDeps)
    case 'SEED_DEMO_DATA':
      return seedDemoData(demoDeps, input, caller)
    case 'RESET_DEMO_DATA':
      return resetDemoData(demoDeps, input, caller)
    case 'LIST_LOAD_CARRIERS_BY_CARRIER':
      return listLoadCarriersByCarrier(input, caller)
    case 'FILE_INBOUND_OFFER':
      return fileInboundOffer(carrierInboundDeps, input, caller) as unknown as Row
    case 'ASSIGN_INBOUND_OFFER':
      return assignInboundOffer(carrierInboundDeps, input, caller)
    case 'DISMISS_INBOUND_OFFER':
      return dismissInboundOffer(carrierInboundDeps, input, caller)
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
