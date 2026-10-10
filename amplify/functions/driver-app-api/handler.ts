/**
 * Driver PWA HTTP API (Lambda Function URL).
 *
 * All routes except `/auth/*` and `/email-intake/*` require a driver-pool id token.
 * The handler verifies the token with aws-jwt-verify and resolves the caller's roster
 * record server-side. A submission belonging to another driver returns 404 with no
 * payload.
 *
 * `/email-intake/*` is a shared-secret endpoint for the loads inbox Gmail bridge; it
 * is routed before any Cognito branch and can never reach a driver-scoped route.
 */

import { randomUUID, createHash, timingSafeEqual } from 'crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { CognitoJwtVerifier } from 'aws-jwt-verify'
import {
  buildSettlement,
  listWeekStarts,
  type Settlement,
  type RawAmazonTrip,
  type RawCredit,
  type RawDeduction,
  type RawDriverPaySetting,
  type RawFuelTransaction,
  type FactoringFields,
} from './settlement'
import { weekStartOfISO } from '../../../src/features/driver-pay/week'
import { splitCityState, normalizeZip } from '../../../src/lib/otrInvoice'
import { buildPodIndex, loadHasPod, normalizePro, type PodIndex } from '../../../src/lib/podPresence'
import {
  currentLoadForDriver,
  driverIsOnLoad,
  laneLabel,
  lastApptAt,
  recentLoadsForDriver,
} from '../../../src/lib/driverJourney'
import type { Load, Stop } from '../../../src/types'
import { isEligiblePayGroup } from './scope'
import { deliveredWindowEnd } from './deliveredWindow'

/** Exclusive end of a pay week — the Sunday after it, as a bare date. */
function weekEndExclusive(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 7)
  return d.toISOString().slice(0, 10)
}
/*
 * How far back the week picker looks. Ivan's drivers care about the week they are in and
 * the one just gone; a year of history on a phone is scrolling, not information.
 */
const PAPERWORK_HISTORY_START = '2026-09-01'
import { driverProgramOf } from '../../../src/lib/driverProgram'
import { pmStatus, type PmStatus } from '../../../src/lib/pmDue'
import { toHosDay, type HosDay, type MotiveLog } from '../../../src/lib/motiveHos'
import {
  summarizeWeek, weekStartOf, weekDays, recentWeekStarts, isOpenShift, rowMinutes,
  STANDARD_DAY_MINUTES, type TimeClockRow,
} from '../../../src/lib/timeClock'
import { isOvernightLoad } from '../../../src/lib/overnightLoads'
import { getStops } from '../../../src/lib/stops'
import { chicagoDateStr } from '../../../src/lib/date'
import { locateCity } from '../../../src/lib/eldRadius'
import {
  applyStopEvent, estimateEta, planDeliveryEta, withEta, type LatLng, type StopEvent,
} from '../../../src/lib/stopEvents'
import {
  buildPaperworkLoad,
  driverIsOnPaperworkLoad,
  summarize,
  type LoadTimeRow,
  type PaperworkLoadLike,
  type PodDocRow,
  referenceOf,
} from './paperwork'
import {
  OWNER_OP_FIRST_PERIOD,
  ownerOpTripsFor,
  ownerOpCarriesWeeklyCharges,
  type OwnerOpLoadLike,
  type OwnerOpTrip,
} from '../../../src/lib/ownerOperatorTrips'
import { notifyRateconSubmitted, notifyPodAdded,
  notifyMiscAdded, RATECON_SUBJECT_PREFIX, type SubmissionNotice, type ThreadRefs } from './notify'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

/*
 * The dispatch number drivers call and text, shown at the top of the app. Read from the
 * same SSM parameter the Dispatch Lambdas use, so buying a new number never needs a
 * release here; cached per container, null when it is not set up yet.
 */
const ssm = new SSMClient({})
const DISPATCH_PARAM_PATH = process.env.DISPATCH_PARAM_PATH ?? ''
let dispatchPhoneCache: { at: number; value: string | null } | null = null
async function dispatchPhone(): Promise<string | null> {
  if (dispatchPhoneCache && Date.now() - dispatchPhoneCache.at < 5 * 60 * 1000) return dispatchPhoneCache.value
  if (!DISPATCH_PARAM_PATH) return null
  let value: string | null = null
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: `${DISPATCH_PARAM_PATH.replace(/\/+$/, '')}/DISPATCH_NUMBER` }))
    value = r.Parameter?.Value?.trim() || null
  } catch (err) {
    console.warn('[driver-app-api] dispatch number unavailable', String(err))
  }
  if (value) dispatchPhoneCache = { at: Date.now(), value }
  return value
}

const DRIVER_SUBMISSION_TABLE = process.env.DRIVER_SUBMISSION_TABLE_NAME!
const DRIVER_SUBMISSION_DOC_TABLE = process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME!
/** pod-actions runs the scan cleanup. Absent in stacks where PODs are not wired. */
const POD_FUNCTION_NAME = process.env.POD_FUNCTION_NAME ?? ''
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME!
const DRIVER_LOAD_TIME_TABLE = process.env.DRIVER_LOAD_TIME_TABLE_NAME ?? ''
const DRIVER_PAY_SETTING_TABLE = process.env.DRIVER_PAY_SETTING_TABLE_NAME!
const AMAZON_TRIP_TABLE = process.env.AMAZON_TRIP_TABLE_NAME!
const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME!
const CUSTOMER_TABLE_NAME = process.env.CUSTOMER_TABLE_NAME ?? ''
const LOCATION_TABLE_NAME = process.env.LOCATION_TABLE_NAME ?? ''
const POD_DOCUMENT_TABLE_NAME = process.env.POD_DOCUMENT_TABLE_NAME ?? ''
const EQUIPMENT_TABLE = process.env.EQUIPMENT_TABLE_NAME ?? ''
const TRUCK_LOCATION_TABLE = process.env.TRUCK_LOCATION_TABLE_NAME ?? ''
const MAINTENANCE_TASK_TABLE = process.env.MAINTENANCE_TASK_TABLE_NAME ?? ''
const MOTIVE_API_KEY = process.env.MOTIVE_API_KEY ?? ''
const MOTIVE_BASE = 'https://api.gomotive.com/v1'
const TIME_CLOCK_TABLE = process.env.TIME_CLOCK_TABLE_NAME ?? ''
const PAY_DEDUCTION_TABLE = process.env.DRIVER_PAY_DEDUCTION_TABLE_NAME!
const PAY_CREDIT_TABLE = process.env.DRIVER_PAY_CREDIT_TABLE_NAME!
const FUEL_TX_TABLE = process.env.FUEL_TRANSACTION_TABLE_NAME!
const BUCKET = process.env.BUCKET_NAME!
const DRIVER_USER_POOL_ID = process.env.DRIVER_USER_POOL_ID!
const DRIVER_USER_POOL_CLIENT_ID = process.env.DRIVER_USER_POOL_CLIENT_ID!

/*
 * ── Impersonation ───────────────────────────────────────────────────────────
 *
 * An admin can open a driver's app as that driver, so "what are they seeing?" is answered
 * by looking rather than by asking someone on a truck to describe a screen.
 *
 * Three things make that safe to have at all, and none of them is optional:
 *
 *   - the STAFF pool is only ever consulted when the caller asks for it explicitly, by
 *     sending this header. A staff token on an ordinary request is still rejected.
 *   - the caller must be an admin. Being a staff member is not enough.
 *   - it is READ ONLY. Every write is refused while impersonating, so nothing a driver
 *     did can ever have been done by somebody else wearing their name.
 *
 * Every accepted impersonation is written to the audit log before the request is served.
 */
const IMPERSONATE_HEADER = 'x-bcat-impersonate-driver'
const STAFF_USER_POOL_ID = process.env.STAFF_USER_POOL_ID ?? ''
const STAFF_USER_POOL_CLIENT_ID = process.env.STAFF_USER_POOL_CLIENT_ID ?? ''
const AUDIT_LOG_TABLE = process.env.AUDIT_LOG_TABLE_NAME ?? ''

/** Who may do it. Deliberately a list, not a group: this reads another person's pay. */
const IMPERSONATION_ADMINS = ['ryne@bcatcorp.com', 'dennis@bcatcorp.com']

const staffVerifier = STAFF_USER_POOL_ID && STAFF_USER_POOL_CLIENT_ID
  ? CognitoJwtVerifier.create({
      userPoolId: STAFF_USER_POOL_ID,
      tokenUse: 'id',
      clientId: STAFF_USER_POOL_CLIENT_ID,
    })
  : null

const verifier = CognitoJwtVerifier.create({
  userPoolId: DRIVER_USER_POOL_ID,
  tokenUse: 'id',
  clientId: DRIVER_USER_POOL_CLIENT_ID,
})

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const MAX_PAGES = 12
/**
 * Any image, or a PDF.
 *
 * This was four named types, and it is the second place a driver's own photo was refused:
 * a phone that hands over a HEIC — which every recent iPhone does — got "unsupported
 * content type" back from the upload it had just been allowed to start. The cleanup
 * pipeline decides for itself what it can improve and keeps the original when it cannot,
 * so there is nothing here for this list to protect.
 */
function isAcceptedUploadType(contentType: string, fileName = ''): boolean {
  const type = (contentType || '').toLowerCase()
  if (type.startsWith('image/')) return true
  if (type === 'application/pdf') return true
  return /\.(pdf|jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i.test(fileName)
}
const EMAIL_ACCEPTED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
const PRESIGN_EXPIRY = 300
const DOC_GET_EXPIRY = 300
const MAX_EMAIL_BODY_EXCERPT = 1000
const EMAIL_SUBMISSION_ID_PREFIX = 'email:'
const MIN_DRIVER_NAME_MATCH_LENGTH = 3

interface FnUrlEvent {
  rawPath: string
  queryStringParameters?: Record<string, string | undefined>
  body?: string | null
  isBase64Encoded?: boolean
  headers?: Record<string, string | undefined>
  requestContext: {
    http: {
      method: string
      sourceIp?: string
    }
  }
}

interface DriverRow {
  id: string
  name: string
  active: boolean
  email?: string | null
  // Which fleet they run in. These two decide whether the app shows a settlement or
  // paperwork — see src/lib/driverProgram.ts for why pay group is NOT the input.
  fleetGroup?: string | null
  driverType?: string | null
  /** Equipment.id of the truck this driver runs — what the PM line is read from. */
  assignedTruckId?: string | null
  /** Motive user id, set by staff. The ONLY thing that links a driver to their ELD logs. */
  motiveDriverId?: number | string | null
  /** Whether this driver accrues PTO. Today only Jason Smith and Charles Best. */
  ptoEligible?: boolean | null
}

interface DriverPaySettingRow {
  id: string
  driverId: string
  active?: boolean | null
  payGroup?: string | null
  payPercent: number
  expensesBeforePercent: boolean
  email?: string | null
  fuelCardNumber?: string | null
  fuelCardHistory?: unknown
  fixedExpenses?: unknown
  rateHistory?: unknown
}

interface DriverSubmissionRow {
  stopId?: string | null
  stopLabel?: string | null
  id: string
  driverId: string
  driverName: string
  status: string
  source?: string | null
  externalMessageId?: string | null
  loadId?: string | null
  referenceNumber?: string | null
  note?: string | null
  slackChannelId?: string | null
  slackMessageTs?: string | null
  emailMessageId?: string | null
  emailSubject?: string | null
  notifiedAt?: string | null
  notificationError?: string | null
  slackNotifiedAt?: string | null
  emailNotifiedAt?: string | null
  createdAt: string
  updatedAt: string
  pendingUploads?: PendingUploads
  /** The finished single PDF per kind, once the pages have been cleaned and merged. */
  combinedPodKey?: string | null
  combinedRateconKey?: string | null
  combinedAt?: string | null
}

interface DriverSubmissionDocRow {
  id: string
  submissionId: string
  driverId: string
  kind: string
  s3Key: string
  fileName?: string | null
  contentType?: string | null
  byteSize?: number | null
  pageNumber: number
  uploadedAt: string
  notifiedAt?: string | null
  createdAt?: string
  updatedAt?: string
  /** The cleaned copy, and how the cleanup went. See pod-actions/scan.ts. */
  enhancedKey?: string | null
  scanStatus?: string | null
}

interface PendingPage {
  fileName: string
  contentType: string
  byteSize: number
  s3Key: string
}

/** What a submission can carry. MISC is photos or other paperwork from a stop — kept as-is, never merged or cleaned. */
type DocKind = 'RATECON' | 'POD' | 'MISC'
const DOC_KINDS: readonly DocKind[] = ['RATECON', 'POD', 'MISC']
function isDocKind(v: unknown): v is DocKind { return typeof v === 'string' && (DOC_KINDS as readonly string[]).includes(v) }

interface PendingUploads {
  RATECON?: PendingPage[]
  POD?: PendingPage[]
  MISC?: PendingPage[]
}

interface UploadTarget {
  pageNumber: number
  url: string
  s3Key: string
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

function reply(status: number, body: unknown) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function parseBody(event: FnUrlEvent): unknown {
  if (!event.body) return {}
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError(400, 'Invalid JSON')
  }
}

function extractBearer(headers?: Record<string, string | undefined>): string | null {
  const auth = headers?.authorization ?? headers?.Authorization
  if (!auth) return null
  const parts = auth.split(' ')
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') return parts[1]
  return null
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

function getString(value: unknown, key: string): string | undefined {
  const v = getField(value, key)
  return typeof v === 'string' ? v : undefined
}

function getStringOrNull(value: unknown, key: string): string | null {
  const v = getField(value, key)
  return v === null || v === undefined ? null : String(v)
}

function getField(value: unknown, key: string): unknown {
  if (value && typeof value === 'object') {
    return (value as Record<string, unknown>)[key]
  }
  return undefined
}

function assertArrayField(value: unknown, key: string): unknown[] | undefined {
  if (value && typeof value === 'object' && key in value) {
    const v = (value as Record<string, unknown>)[key]
    if (Array.isArray(v)) return v
  }
  return undefined
}

async function scan<T = Record<string, unknown>>(
  table: string,
  filter?: string,
  names?: Record<string, string>,
  values?: Record<string, unknown>,
): Promise<T[]> {
  const items: T[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: table,
        ...(filter ? { FilterExpression: filter } : {}),
        ...(names && Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        /*
         * An EMPTY values object must be omitted, not sent. `{}` is truthy, so the old
         * guard passed `ExpressionAttributeValues: {}` with no FilterExpression and
         * DynamoDB rejected the whole scan: "ExpressionAttributeValues can only be
         * specified when using expressions". A full-table scan is a legitimate call here
         * and it was failing outright.
         */
        ...(values && Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        ExclusiveStartKey: lastKey,
      }),
    )
    if (res.Items) items.push(...(res.Items as T[]))
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)
  return items
}

async function getItem<T>(table: string, key: Record<string, unknown>): Promise<T | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: table,
      Key: key,
    }),
  )
  return (res.Item as T | undefined) ?? null
}

async function resolveDriverAndSetting(emailLower: string): Promise<{
  driver: DriverRow
  setting: DriverPaySettingRow
} | null> {
  const drivers = await scan<DriverRow>(DRIVER_TABLE)
  const driverByEmail = drivers.find((d) => d.active !== false && normalizeEmail(d.email ?? '') === emailLower)

  let driverId: string | undefined
  if (driverByEmail) {
    driverId = driverByEmail.id
  }

  const settings = await scan<DriverPaySettingRow>(DRIVER_PAY_SETTING_TABLE)
  let setting: DriverPaySettingRow | undefined

  if (driverId) {
    setting = settings.find((s) => s.driverId === driverId && s.active !== false && isEligiblePayGroup(s.payGroup))
  }

  if (!driverByEmail && !setting) {
    const settingByEmail = settings.find(
      (s) => s.active !== false && isEligiblePayGroup(s.payGroup) && normalizeEmail(s.email ?? '') === emailLower,
    )
    if (settingByEmail) {
      setting = settingByEmail
      driverId = settingByEmail.driverId
    }
  }

  if (!driverId) return null
  const driver = driverByEmail ?? drivers.find((d) => d.id === driverId)
  if (!driver || driver.active === false) return null

  const effective = setting ?? syntheticPaperworkSetting(driver)
  if (!effective) return null

  return { driver, setting: effective }
}

/*
 * A pay setting for a driver who has none, and should not need one.
 *
 * DriverPaySetting carries a percentage, a fuel card and fixed expenses — the machinery of
 * a settlement. Ivan's own drivers are not settled a percentage, so nobody ever created one
 * for them: all five (Charles Best, Eulalio Cortez, Jason Smith, John Brittich, Joshua Kly)
 * have no row at all. Both the sign-in path and the impersonation path required one, so
 * every Ivan driver was refused by the API — "Driver has no active pay setting" — which is
 * why Ivan paperwork could not be opened for any of them, by them or by an admin.
 *
 * Synthesised ONLY for a driver whose own record positively says LOCAL. A missing setting
 * on anyone else stays an error: inventing 0% for a driver who is owed a percentage would
 * render as a $0 check, and a settlement that silently reads zero is far worse than one
 * that refuses to load.
 */
function syntheticPaperworkSetting(driver: DriverRow): DriverPaySettingRow | null {
  if (driverProgramOf(driver) !== 'PAPERWORK') return null
  return {
    id: `synthetic-paperwork:${driver.id}`,
    driverId: driver.id,
    active: true,
    payGroup: 'LOCAL',
    // Never used: the paperwork endpoints read no pay field, and /settlement refuses a
    // driver on this program outright rather than computing against these.
    payPercent: 0,
    expensesBeforePercent: false,
    email: driver.email ?? null,
  }
}

export interface VerifiedCaller {
  driver: DriverRow
  setting: DriverPaySettingRow
  /** The admin's email when this is an impersonated read, null when it is the driver. */
  impersonatedBy: string | null
}

/** Headers arrive with whatever casing the client sent. */
function headerValue(headers: Record<string, string | undefined> | undefined, name: string): string {
  if (!headers) return ''
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return (value ?? '').trim()
  }
  return ''
}

export function mayImpersonate(email: string): boolean {
  return IMPERSONATION_ADMINS.includes(normalizeEmail(email))
}

/**
 * A driver resolved from a STAFF token, for an admin looking at their app.
 *
 * Verified against the staff pool — never the driver pool — and refused for anyone not on
 * the admin list. The driver is found by id from the header rather than by email from the
 * token, which is the whole point and also the reason every other check here has to hold.
 */
async function loadImpersonatedDriver(
  token: string,
  driverId: string,
): Promise<VerifiedCaller> {
  if (!staffVerifier) throw new ApiError(403, 'Impersonation is not configured')

  let claims: { email?: string; email_verified?: boolean }
  try {
    claims = (await staffVerifier.verify(token)) as { email?: string; email_verified?: boolean }
  } catch (err) {
    throw new ApiError(401, `Invalid staff token: ${err instanceof Error ? err.message : String(err)}`)
  }
  const email = normalizeEmail(claims.email ?? '')
  if (!email) throw new ApiError(401, 'Staff token missing email')
  if (!mayImpersonate(email)) throw new ApiError(403, 'Not permitted to view a driver app')

  const driver = await getItem<DriverRow>(DRIVER_TABLE, { id: driverId })
  if (!driver || driver.active === false) throw new ApiError(404, 'Driver not found')

  const settings = await scan<DriverPaySettingRow>(DRIVER_PAY_SETTING_TABLE)
  const found = settings.find(
    (s) => s.driverId === driverId && s.active !== false && isEligiblePayGroup(s.payGroup),
  )
  // Ivan's drivers have no pay setting by design — see syntheticPaperworkSetting.
  const setting = found ?? syntheticPaperworkSetting(driver)
  if (!setting) throw new ApiError(404, 'Driver has no active pay setting')

  return { driver, setting, impersonatedBy: email }
}

/**
 * Record it. Before the request is served, and never allowed to fail it silently —
 * an impersonation nobody can find afterwards is the thing that makes this dangerous.
 */
async function recordImpersonation(by: string, driver: DriverRow, path: string): Promise<void> {
  if (!AUDIT_LOG_TABLE) {
    console.error('[driver-app-api] IMPERSONATION WITH NO AUDIT TABLE', { by, driverId: driver.id, path })
    return
  }
  const now = nowIso()
  try {
    await ddb.send(
      new PutCommand({
        TableName: AUDIT_LOG_TABLE,
        Item: {
          id: randomUUID(),
          __typename: 'AuditLog',
          entityType: 'Driver',
          entityId: driver.id,
          action: 'IMPERSONATE_DRIVER_APP',
          user: by,
          changes: JSON.stringify({ driverName: driver.name, path }),
          createdAt: now,
          updatedAt: now,
        },
      }),
    )
  } catch (err) {
    // Logged loudly either way: CloudWatch is the fallback record.
    console.error('[driver-app-api] could not write the impersonation audit row', {
      by, driverId: driver.id, path,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  console.log('[driver-app-api] impersonation', { by, driverId: driver.id, driverName: driver.name, path })
}

async function loadVerifiedDriver(event: FnUrlEvent): Promise<VerifiedCaller> {
  const token = extractBearer(event.headers)
  if (!token) throw new ApiError(401, 'Missing authorization')

  // Only ever consulted when the caller asks for it by name.
  const impersonating = headerValue(event.headers, IMPERSONATE_HEADER)
  if (impersonating) {
    const caller = await loadImpersonatedDriver(token, impersonating)
    await recordImpersonation(caller.impersonatedBy!, caller.driver, event.rawPath ?? '')
    return caller
  }

  let claims: { email?: string; email_verified?: boolean }
  try {
    claims = (await verifier.verify(token)) as { email?: string; email_verified?: boolean }
  } catch (err) {
    throw new ApiError(401, `Invalid token: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (claims.email_verified !== true) {
    throw new ApiError(401, 'Email not verified')
  }
  const email = normalizeEmail(claims.email ?? '')
  if (!email) throw new ApiError(401, 'Token missing email')
  const resolved = await resolveDriverAndSetting(email)
  if (!resolved) {
    // The one refusal a driver cannot fix from their side: their Cognito account is fine
    // but no active Driver row carries this email. Logged so dispatch can see WHO was
    // turned away — on 7 Oct an Ivan driver spent a day at a Retry screen and nothing on
    // the server said why.
    console.warn('[driver-app-api] sign-in refused: no active driver with this email', { email })
    throw new ApiError(401, 'Driver not found')
  }
  return { ...resolved, impersonatedBy: null }
}

function ownerOpTripToRaw(trip: OwnerOpTrip, periodStart: string): RawAmazonTrip {
  return {
    id: trip.id,
    periodStart,
    shipmentDate: trip.deliveredAt.slice(0, 10),
    loadId: trip.loadId,
    origin: trip.origin,
    destination: trip.destination,
    miles: trip.miles,
    freightAmount: trip.freightAmount,
    status: null,
    sortOrder: null,
    loadRowId: trip.id,
  }
}

/** Exclusive upper bound: the midnight that starts the day AFTER the pay week ends. */
async function loadOwnerOperatorTripsForWeek(
  driverId: string,
  periodStart: string,
): Promise<RawAmazonTrip[]> {
  // `deliveryAppt` stores a full ISO timestamp while the period end is a bare date, so
  // an inclusive BETWEEN drops every load delivered ON the final Saturday
  // ('2026-10-03T05:00:00.000Z' sorts after '2026-10-03'). Compare against the start of
  // the next day instead, so the driver app and the staff page agree on the last day.
  /*
   * The WHOLE pay week, including loads not yet delivered.
   *
   * This used to stop at today, so a driver looking at their week saw two shipments while
   * the office saw four — Roy's 14604 and 14605 deliver on the 7th and the 9th and simply
   * were not there. Hiding work a driver is about to run, and the money on it, made the
   * app look wrong and the week look emptier than it is.
   *
   * The original worry still stands and is answered a better way: an undelivered load must
   * not read as pay already earned. It is marked NOT_DELIVERED, left off the check amount,
   * and shown with the pay it WILL earn — which is the same thing the staff settlement page
   * does with these loads, and now the two agree.
   *
   * The paperwork endpoint keeps the cap. Asking a driver for a POD on a delivery that has
   * not happened is still noise.
   */
  const loads = await scan<OwnerOpLoadLike>(
    LOAD_TABLE_NAME,
    'deliveryDriverId = :did AND deliveryAppt >= :start AND deliveryAppt < :endEx',
    {},
    { ':did': driverId, ':start': periodStart, ':endEx': weekEndExclusive(periodStart) },
  )
  return ownerOpTripsFor(loads, driverId, periodStart).map((t) => ownerOpTripToRaw(t, periodStart))
}

async function loadOwnerOperatorRawTrips(driverId: string): Promise<RawAmazonTrip[]> {
  const loads = await scan<OwnerOpLoadLike>(LOAD_TABLE_NAME, 'deliveryDriverId = :did', {}, { ':did': driverId })
  // No delivered cap, matching the single-week read above, so the week picker's counts
  // match the page it opens.
  // Bucket by pay week and reuse the ONE derivation the staff page uses — a second copy
  // here is how the cents conversion and the 'N/A' load-id fallback drift apart.
  const weeks = new Set<string>()
  for (const load of loads) {
    if (load.deliveryAppt) weeks.add(weekStartOfISO(load.deliveryAppt.slice(0, 10)))
  }
  const out: RawAmazonTrip[] = []
  for (const periodStart of weeks) {
    for (const trip of ownerOpTripsFor(loads, driverId, periodStart)) {
      out.push(ownerOpTripToRaw(trip, periodStart))
    }
  }
  return out
}

interface LoadFactoringRow {
  id: string
  aljexId?: string | null
  pickupNumber?: string | null
  rate?: number | null
  deliveryAppt?: string | null
  originCity?: string | null
  destinationCity?: string | null
  customerId?: string | null
  rateConfirmKey?: string | null
  stops?: StopFactoringRow[] | null
}

interface StopFactoringRow {
  type?: string | null
  city?: string | null
  locationId?: string | null
  address?: { city?: string | null; state?: string | null; zip?: string | null } | null
}

interface CustomerFactoringRow {
  id: string
  mcNumber?: string | null
}

interface LocationFactoringRow {
  id: string
  city?: string | null
  state?: string | null
  zip?: string | null
}

function cleanFactoringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isFactoringBlocked(fields: Omit<FactoringFields, 'blocked'>): boolean {
  return (
    !fields.invoiceNo ||
    !fields.poNumber ||
    !fields.brokerMc ||
    fields.invoiceAmount == null ||
    !fields.invoiceDate ||
    !fields.fromCity ||
    !fields.fromState ||
    !fields.fromZip ||
    !fields.toCity ||
    !fields.toState ||
    !fields.toZip ||
    !fields.podPresent ||
    !fields.rateconPresent
  )
}

/** City/state/ZIP for a stop, preferring the booked snapshot on the stop, then Location. */
function placeFor(
  cityHint: string | null | undefined,
  stop: StopFactoringRow | undefined,
  locations: Map<string, LocationFactoringRow>,
): { city: string | null; state: string | null; zip: string | null } {
  const address = stop?.address ?? null
  const location = stop?.locationId ? locations.get(stop.locationId) : undefined
  const rawCity = cleanFactoringValue(address?.city) ?? cleanFactoringValue(stop?.city) ?? cleanFactoringValue(cityHint)
  const split = splitCityState(rawCity)
  return {
    city: cleanFactoringValue(address?.city) ?? cleanFactoringValue(split.city) ?? cleanFactoringValue(location?.city),
    state: cleanFactoringValue(address?.state) ?? cleanFactoringValue(split.state) ?? cleanFactoringValue(location?.state),
    zip: normalizeZip(cleanFactoringValue(address?.zip) ?? cleanFactoringValue(location?.zip)) ?? null,
  }
}

function factoringFieldsFor(
  load: LoadFactoringRow,
  customers: Map<string, CustomerFactoringRow>,
  locations: Map<string, LocationFactoringRow>,
  podPresent: boolean,
): FactoringFields {
  const stops = load.stops ?? []
  const origin = placeFor(load.originCity, stops.find((s) => s.type === 'pickup'), locations)
  const destination = placeFor(load.destinationCity, stops.find((s) => s.type === 'delivery'), locations)
  const customer = load.customerId ? customers.get(load.customerId) : undefined
  const fields: Omit<FactoringFields, 'blocked'> = {
    invoiceNo: cleanFactoringValue(load.aljexId),
    poNumber: cleanFactoringValue(load.pickupNumber),
    brokerMc: cleanFactoringValue(customer?.mcNumber),
    // Load.rate is CENTS; the OTR invoice amount is DOLLARS.
    invoiceAmount: load.rate != null && Number.isFinite(load.rate) ? Math.round(load.rate) / 100 : null,
    invoiceDate: load.deliveryAppt ? load.deliveryAppt.slice(0, 10) : null,
    fromCity: origin.city,
    fromState: origin.state,
    fromZip: origin.zip,
    toCity: destination.city,
    toState: destination.state,
    toZip: destination.zip,
    podPresent,
    rateconPresent: !!load.rateConfirmKey,
  }
  return { ...fields, blocked: isFactoringBlocked(fields) }
}

/**
 * Resolve the OTR factoring view for a set of loads. Reads the Load row plus the Customer
 * and Location rows it links to and the load's PodDocument rows, so the driver sees which
 * required fields/documents are missing before the office can factor the load.
 */
async function resolveFactoringFields(loadIds: string[]): Promise<Map<string, FactoringFields>> {
  const out = new Map<string, FactoringFields>()
  const unique = [...new Set(loadIds.filter(Boolean))]
  if (unique.length === 0) return out

  const customerIds = new Set<string>()
  const locationIds = new Set<string>()
  const loads = new Map<string, LoadFactoringRow>()
  for (const id of unique) {
    const load = await getItem<LoadFactoringRow>(LOAD_TABLE_NAME, { id })
    if (!load) continue
    loads.set(id, load)
    if (load.customerId) customerIds.add(load.customerId)
    for (const stop of load.stops ?? []) if (stop.locationId) locationIds.add(stop.locationId)
  }

  const customers = new Map<string, CustomerFactoringRow>()
  if (CUSTOMER_TABLE_NAME) {
    for (const id of customerIds) {
      const row = await getItem<CustomerFactoringRow>(CUSTOMER_TABLE_NAME, { id })
      if (row) customers.set(id, row)
    }
  }

  const locations = new Map<string, LocationFactoringRow>()
  if (LOCATION_TABLE_NAME) {
    for (const id of locationIds) {
      const row = await getItem<LocationFactoringRow>(LOCATION_TABLE_NAME, { id })
      if (row) locations.set(id, row)
    }
  }

  // podKnown stays false while the POD store has not actually answered. A missing POD
  // now holds a driver's pay, and an unconfigured or failing table makes every load look
  // POD-less — so "could not check" must never be mistaken for "there is no POD".
  const podsByLoad = new Set<string>()
  let podKnown = false
  if (POD_DOCUMENT_TABLE_NAME) {
    try {
      for (const id of unique) {
        const res = await ddb.send(
          new QueryCommand({
            TableName: POD_DOCUMENT_TABLE_NAME,
            IndexName: 'podDocumentsByLoadIdAndReceivedAt',
            KeyConditionExpression: 'loadId = :loadId',
            ExpressionAttributeValues: { ':loadId': id },
          }),
        )
        if ((res.Items ?? []).length > 0) podsByLoad.add(id)
      }
      podKnown = true
    } catch (err) {
      console.error('[driver-app-api] could not read PODs — no load will be held for a missing POD', err)
    }
  }

  for (const [id, load] of loads) {
    out.set(id, { ...factoringFieldsFor(load, customers, locations, podsByLoad.has(id)), podKnown })
  }
  return out
}

/**
 * PODs this driver has sent in, from the PWA or uploaded by staff on their behalf.
 *
 * This lambda stores a driver's POD in DriverSubmissionDoc and then computed POD
 * presence from the PodDocument table, so the driver's own scan never counted. Now that
 * a POD decides whether their load is paid, that gap would have shown them a POD they
 * had just sent and a settlement still calling it missing.
 */
async function driverSubmittedPodIndex(driverId: string): Promise<PodIndex> {
  try {
    const [submissions, docs] = await Promise.all([
      scan<DriverSubmissionRow>(DRIVER_SUBMISSION_TABLE, 'driverId = :did', {}, { ':did': driverId }),
      scan<DriverSubmissionDocRow>(DRIVER_SUBMISSION_DOC_TABLE, 'driverId = :did', {}, { ':did': driverId }),
    ])
    const kindsBySubmission = groupBy(docs, (d) => d.submissionId)
    return buildPodIndex({
      jobsdoneLoadIds: [],
      submissions: submissions.map((s) => ({
        loadId: s.loadId ?? null,
        referenceNumber: s.referenceNumber ?? null,
        hasPodDoc: (kindsBySubmission.get(s.id) ?? []).some((d) => d.kind === 'POD'),
      })),
    })
  } catch (err) {
    // The JobsDone side still answers; this only ever adds PODs, never removes one.
    console.error('[driver-app-api] could not read this driver\'s own submissions', err)
    return buildPodIndex({ jobsdoneLoadIds: [], submissions: [] })
  }
}

/** Attach the factoring view to every trip the driver PWA returns. */
async function attachFactoringFields(trips: RawAmazonTrip[], driverId: string): Promise<RawAmazonTrip[]> {
  const [resolved, ownPods] = await Promise.all([
    resolveFactoringFields(
      trips.map((t) => t.loadRowId ?? t.loadId).filter((id): id is string => !!id),
    ),
    driverSubmittedPodIndex(driverId),
  ])
  return trips.map((t) => {
    const key = t.loadRowId ?? t.loadId
    const fields = key ? resolved.get(key) ?? null : null
    if (!fields || fields.podPresent) return { ...t, factoring: fields }
    // A POD this driver sent counts the same as one JobsDone received.
    if (!loadHasPod(ownPods, { id: key ?? '', aljexId: fields.invoiceNo })) return { ...t, factoring: fields }
    // A POD this driver sent is a real answer, so it also settles podKnown.
    const withPod = { ...fields, podPresent: true, podKnown: true }
    return { ...t, factoring: { ...withPod, blocked: isFactoringBlocked(withPod) } }
  })
}

function isDriverOwner(submission: DriverSubmissionRow, driverId: string): boolean {
  return submission.driverId === driverId
}

function parsePath(rawPath: string): { path: string; id?: string; docId?: string } {
  const segments = rawPath.replace(/^\/|\/$/g, '').split('/').filter(Boolean)
  if (segments[0] === 'email-intake' && segments[1] === 'prepare') {
    return { path: '/email-intake/prepare' }
  }
  if (segments[0] === 'email-intake' && segments[1] === 'commit') {
    return { path: '/email-intake/commit' }
  }
  if (segments[0] === 'submissions' && segments[2] === 'uploads') {
    return { path: '/submissions/:id/uploads', id: segments[1] }
  }
  if (segments[0] === 'submissions' && segments[2] === 'complete') {
    return { path: '/submissions/:id/complete', id: segments[1] }
  }
  if (segments[0] === 'submissions' && segments[2] === 'pod') {
    return { path: '/submissions/:id/pod', id: segments[1] }
  }
  if (segments[0] === 'submissions' && segments[2] === 'doc' && segments[4] === 'url') {
    return { path: '/submissions/:id/doc/:docId/url', id: segments[1], docId: segments[3] }
  }
  if (segments[0] === 'settlement' && !segments[1]) {
    return { path: '/settlement' }
  }
  if (segments[0] === 'paperwork' && !segments[1]) {
    return { path: '/paperwork' }
  }
  if (segments[0] === 'paperwork' && segments[1] === 'weeks') {
    return { path: '/paperwork/weeks' }
  }
  if (segments[0] === 'paperwork' && segments[1] === 'detention') {
    return { path: '/paperwork/detention' }
  }
  if (segments[0] === 'paperwork' && segments[1] === 'stop-event') {
    return { path: '/paperwork/stop-event' }
  }
  if (segments[0] === 'trucks' && !segments[1]) {
    return { path: '/trucks' }
  }
  if (segments[0] === 'paperwork' && segments[1] === 'location-note') {
    return { path: '/paperwork/location-note' }
  }
  if (segments[0] === 'maintenance-tasks' && !segments[1]) {
    return { path: '/maintenance-tasks' }
  }
  if (segments[0] === 'me' && segments[1] === 'truck') {
    return { path: '/me/truck' }
  }
  if (segments[0] === 'settlement' && segments[1] === 'weeks') {
    return { path: '/settlement/weeks' }
  }
  if (segments[0] === 'motive' && segments[1] === 'day') {
    return { path: '/motive/day' }
  }
  if (segments[0] === 'timeclock' && !segments[1]) {
    return { path: '/timeclock' }
  }
  if (segments[0] === 'timeclock' && segments[1] === 'punch') {
    return { path: '/timeclock/punch' }
  }
  if (segments[0] === 'staff' && segments[1] === 'motive-days') {
    return { path: '/staff/motive-days' }
  }
  if (segments[0] === 'loads' && segments[1] === 'current') {
    return { path: '/loads/current' }
  }
  if (segments[0] === 'loads' && segments[1] === 'recent') {
    return { path: '/loads/recent' }
  }
  if (segments[0] === 'submissions' && segments[2] === 'docs') {
    return { path: '/submissions/:id/docs', id: segments[1] }
  }
  if (segments[0] === 'submissions' && segments[2] === 'attach') {
    return { path: '/submissions/:id/attach', id: segments[1] }
  }
  return { path: `/${segments.join('/')}` }
}

function emailIntakeSecretOk(provided: unknown): boolean {
  const secret = process.env.LOADS_INTAKE_SECRET ?? ''
  // Fail closed: missing/empty env or non-string input rejects every request.
  if (typeof provided !== 'string' || !secret) return false
  // Hash both sides so timingSafeEqual never throws on length mismatch.
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(secret).digest()
  return a.length === b.length && timingSafeEqual(a, b)
}

function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return (match ? match[1] : from).toLowerCase().trim()
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // keep letters (incl. accented) and numbers; strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pure whole-word name matcher. Exported for unit tests. */
export function nameMatchesBody(driverName: string, body: string): boolean {
  const normalizedName = normalizeForMatch(driverName)
  if (normalizedName.length < MIN_DRIVER_NAME_MATCH_LENGTH) return false
  const nameWords = normalizedName.split(' ').filter(Boolean)
  if (nameWords.length === 0) return false
  const bodyWords = normalizeForMatch(body).split(' ').filter(Boolean)
  for (let i = 0; i <= bodyWords.length - nameWords.length; i++) {
    let match = true
    for (let j = 0; j < nameWords.length; j++) {
      if (bodyWords[i + j] !== nameWords[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

async function resolveDriverByName(
  rawBody: string,
): Promise<{ driverId: string; driverName: string; matched: boolean }> {
  const drivers = await scan<DriverRow>(DRIVER_TABLE)
  const activeDrivers = drivers.filter((d) => d.active !== false)
  const matches = activeDrivers.filter((d) => nameMatchesBody(d.name, rawBody))

  if (matches.length === 1) {
    const driver = matches[0]
    return { driverId: driver.id, driverName: driver.name, matched: true }
  }

  return {
    driverId: 'UNMATCHED',
    driverName: matches.length > 1 ? `Unmatched (${matches.length} candidates)` : 'Unmatched',
    matched: false,
  }
}

/** Pure subject matcher for our own notification emails. Exported for tests. */
export function isOwnNotificationSubject(subject: string): boolean {
  const normalized = subject.trim().toLowerCase()
  const prefix = RATECON_SUBJECT_PREFIX.toLowerCase()
  return normalized.startsWith(prefix) || normalized.startsWith(`re: ${prefix}`)
}

/** Pure loop-guard predicate. Exported for tests. */
export function shouldSkipEmailIntake(
  from: string | undefined,
  subject: string | undefined,
): { skip: boolean; reason?: string } {
  const sesFrom = process.env.SES_FROM_ADDRESS ?? 'onboarding@bcatcorp.com'
  if (from && extractEmailAddress(from) === extractEmailAddress(sesFrom)) {
    return { skip: true, reason: 'self-sent' }
  }
  if (subject && isOwnNotificationSubject(subject)) {
    return { skip: true, reason: 'own-notification' }
  }
  return { skip: false }
}

function validateEmailPages(pages: unknown): { ok: false; error: string } | { ok: true; pages: PendingPage[] } {
  if (!Array.isArray(pages)) return { ok: false, error: 'attachments must be an array' }
  if (pages.length === 0) return { ok: false, error: 'attachments cannot be empty' }
  if (pages.length > MAX_PAGES) return { ok: false, error: `max ${MAX_PAGES} attachments per upload` }
  const out: PendingPage[] = []
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]
    if (!p || typeof p !== 'object') return { ok: false, error: `attachment ${i + 1} invalid` }
    const fileName = getString(p, 'fileName')?.trim() ?? ''
    const contentType = getString(p, 'contentType')?.trim() ?? ''
    const byteSize = Number(getField(p, 'byteSize'))
    if (!fileName) return { ok: false, error: `attachment ${i + 1} missing fileName` }
    if (!EMAIL_ACCEPTED_CONTENT_TYPES.includes(contentType)) {
      return { ok: false, error: `attachment ${i + 1} unsupported content type` }
    }
    if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > MAX_UPLOAD_BYTES) {
      return { ok: false, error: `attachment ${i + 1} size invalid (max ${MAX_UPLOAD_BYTES} bytes)` }
    }
    out.push({ fileName, contentType, byteSize, s3Key: '' })
  }
  return { ok: true, pages: out }
}

function buildEmailNote(subject: string, body: string, matched: boolean): string {
  const excerpt = body.length > MAX_EMAIL_BODY_EXCERPT ? body.slice(0, MAX_EMAIL_BODY_EXCERPT) + '…' : body
  const marker = matched ? '' : '\n\nDRIVER NOT MATCHED'
  return `Subject: ${subject}\n\n${excerpt}${marker}`.trim()
}

function emailSubmissionId(gmailMessageId: string): string {
  return `${EMAIL_SUBMISSION_ID_PREFIX}${gmailMessageId}`
}

async function querySubmissionByExternalMessageId(gmailMessageId: string): Promise<DriverSubmissionRow | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: DRIVER_SUBMISSION_TABLE,
      IndexName: 'driverSubmissionsByExternalMessageId',
      KeyConditionExpression: 'externalMessageId = :gmid',
      ExpressionAttributeValues: { ':gmid': gmailMessageId },
      Limit: 1,
    }),
  )
  const items = result.Items as DriverSubmissionRow[] | undefined
  return items?.[0] ?? null
}

/** Docs already written for a submission. Queries the `submissionId` index rather than scanning:
 *  this runs on every completion (PWA and email), and a full-table Scan gets slower and more
 *  expensive for every submission the table has ever held. `kind` is filtered client-side because
 *  it is not part of the index key. */
async function listSubmissionDocs(
  submissionId: string,
  kind: DocKind,
): Promise<DriverSubmissionDocRow[]> {
  const docs: DriverSubmissionDocRow[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: DRIVER_SUBMISSION_DOC_TABLE,
        IndexName: 'driverSubmissionDocsBySubmissionId',
        KeyConditionExpression: 'submissionId = :sid',
        ExpressionAttributeValues: { ':sid': submissionId },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    )
    for (const item of (res.Items ?? []) as DriverSubmissionDocRow[]) {
      if (item.kind === kind) docs.push(item)
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)
  return docs
}

async function getEmailSubmission(submissionId: string): Promise<DriverSubmissionRow> {
  const submission = await getItem<DriverSubmissionRow>(DRIVER_SUBMISSION_TABLE, { id: submissionId })
  if (!submission) {
    throw new ApiError(404, 'Submission not found')
  }
  return submission
}

async function headS3Object(s3Key: string): Promise<{ contentLength: number; contentType?: string }> {
  const result = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: s3Key }))
  if (result.ContentLength === undefined) {
    throw new ApiError(500, `S3 head missing ContentLength for ${s3Key}`)
  }
  return { contentLength: result.ContentLength, contentType: result.ContentType }
}

function nowIso(): string {
  return new Date().toISOString()
}

function periodEnd(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

function validatePages(pages: unknown): { ok: false; error: string } | { ok: true; pages: PendingPage[] } {
  if (!Array.isArray(pages)) return { ok: false, error: 'pages must be an array' }
  if (pages.length === 0) return { ok: false, error: 'pages cannot be empty' }
  if (pages.length > MAX_PAGES) return { ok: false, error: `max ${MAX_PAGES} pages per upload` }
  const out: PendingPage[] = []
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]
    if (!p || typeof p !== 'object') return { ok: false, error: `page ${i + 1} invalid` }
    const fileName = getString(p, 'fileName')?.trim() ?? ''
    const contentType = getString(p, 'contentType')?.trim() ?? ''
    const byteSize = Number(getField(p, 'byteSize'))
    if (!fileName) return { ok: false, error: `page ${i + 1} missing fileName` }
    if (!isAcceptedUploadType(contentType, fileName)) {
      return { ok: false, error: `page ${i + 1} is not an image or a PDF` }
    }
    if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > MAX_UPLOAD_BYTES) {
      return { ok: false, error: `page ${i + 1} size invalid (max ${MAX_UPLOAD_BYTES} bytes)` }
    }
    out.push({ fileName, contentType, byteSize, s3Key: '' })
  }
  return { ok: true, pages: out }
}

function extFromContentType(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'application/pdf':
      return 'pdf'
    default:
      return 'bin'
  }
}

async function presignedPutTargets(
  driverId: string,
  submissionId: string,
  kind: DocKind,
  pages: PendingPage[],
): Promise<{ targets: UploadTarget[]; pagesWithKeys: PendingPage[] }> {
  const timestamp = Date.now()
  const pagesWithKeys: PendingPage[] = []
  const targets: UploadTarget[] = []

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const ext = extFromContentType(page.contentType)
    const s3Key = `driver-docs/${driverId}/${submissionId}/${kind}/${timestamp}-${i + 1}.${ext}`
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: page.contentType }),
      { expiresIn: PRESIGN_EXPIRY },
    )
    targets.push({ pageNumber: i + 1, url, s3Key })
    pagesWithKeys.push({ ...page, s3Key })
  }

  return { targets, pagesWithKeys }
}

/** Re-sign PUT URLs for pages already saved on a submission so a retry can re-PUT them. */
async function resignPendingUploads(pages: PendingPage[]): Promise<UploadTarget[]> {
  const targets: UploadTarget[] = []
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: BUCKET, Key: page.s3Key, ContentType: page.contentType }),
      { expiresIn: PRESIGN_EXPIRY },
    )
    targets.push({ pageNumber: i + 1, url, s3Key: page.s3Key })
  }
  return targets
}

async function getOwnedSubmission(
  submissionId: string,
  driverId: string,
): Promise<DriverSubmissionRow> {
  const submission = await getItem<DriverSubmissionRow>(DRIVER_SUBMISSION_TABLE, { id: submissionId })
  if (!submission || !isDriverOwner(submission, driverId)) {
    throw new ApiError(404, 'Submission not found')
  }
  return submission
}

async function getOwnedDoc(
  submissionId: string,
  docId: string,
  driverId: string,
): Promise<DriverSubmissionDocRow> {
  const doc = await getItem<DriverSubmissionDocRow>(DRIVER_SUBMISSION_DOC_TABLE, { id: docId })
  if (!doc || doc.driverId !== driverId || doc.submissionId !== submissionId) {
    throw new ApiError(404, 'Document not found')
  }
  return doc
}

async function appendPendingUploads(
  submissionId: string,
  kind: DocKind,
  pages: PendingPage[],
) {
  await ddb.send(
    new UpdateCommand({
      TableName: DRIVER_SUBMISSION_TABLE,
      Key: { id: submissionId },
      UpdateExpression:
        'SET pendingUploads.#kind = list_append(if_not_exists(pendingUploads.#kind, :empty), :pages), updatedAt = :ts',
      ExpressionAttributeNames: { '#kind': kind },
      ExpressionAttributeValues: { ':pages': pages, ':empty': [], ':ts': nowIso() },
      ConditionExpression: 'attribute_exists(id)',
    }),
  )
}

/**
 * Ask pod-actions to clean up the pages just stored.
 *
 * A POD photographed at a dock needs deskewing, cropping and the lighting flattened at
 * least as much as one texted in, and that pipeline is heavy — tesseract and jimp — so it
 * stays in the Lambda that already carries it rather than being bundled into the driver
 * API.
 *
 * ONE Event invocation, never awaited. The old version awaited a cleanup call per page and
 * then the merge, so a driver stood at a dock watching a spinner for the length of the
 * whole pipeline having already done their part. Nothing downstream needs the cleaned copy
 * to exist yet — every reader falls back to the original until it does — so the upload
 * returns as soon as the pages are stored.
 *
 * Every failure is swallowed: the pages are saved and the original is the copy we keep.
 */
async function requestScanCleanup(
  docs: DriverSubmissionDocRow[],
  submissionId: string,
  kind: 'RATECON' | 'POD',
): Promise<void> {
  if (!POD_FUNCTION_NAME || docs.length === 0) return
  const lambda = new LambdaClient({})

  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: POD_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ action: 'scanDriverDocs', submissionId, kind })),
      }),
    )
  } catch (err) {
    console.error('[driver-app-api] could not queue the scan cleanup', {
      submissionId,
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * A POD submission this driver already has for the same shipment.
 *
 * A driver photographs a bill of lading at the dock, then finds a second page in the cab,
 * or a signature they missed. Every send used to create a NEW submission, so the office saw
 * two half-PODs for one shipment and the app showed whichever it happened to find first.
 *
 * Matched on the PRO the driver typed, by the same rule the office matches on (normalizePro
 * in src/lib/podPresence.ts). Without a reference there is nothing to match on and a new
 * submission is the only honest answer — a loose POD belongs to whatever load staff assign
 * it to, not to the last one this driver happened to send.
 */
/**
 * The submission more POD pages for this shipment belong on, out of everything this driver
 * has sent. Pure, so the rule can be tested without standing up DynamoDB.
 *
 * Newest first: if a driver somehow has two for one PRO, pages go on the one they are
 * actually working, and staff can merge the older one.
 */
export function pickOpenPodSubmission<T extends { referenceNumber?: string | null; createdAt?: string }>(
  submissions: T[],
  referenceNumber: string | null,
): T | null {
  const want = normalizePro(referenceNumber)
  if (!want) return null
  return (
    submissions
      .filter((sub) => normalizePro(sub.referenceNumber ?? null) === want)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null
  )
}


/**
 * The load a driver's PRO points at, so the submission is attached at the moment it is made.
 *
 * A driver types a PRO; nothing ever turned that into a link. Every submission sat with
 * loadId null forever — Chad's POD for 14547 among them — and only the screens that
 * additionally match on the PRO ever found it. Everything keyed on loadId did not: the
 * load's own documents, the factoring queue, and anything built on them.
 *
 * Attaching here means the POD belongs to the load from the moment it arrives, rather than
 * being re-derived by every reader that happens to remember to try the PRO as well.
 *
 * Deliberately forgiving: a PRO that matches nothing leaves the submission unattached, as
 * before, because a POD with nowhere to go must still be kept.
 */
async function resolveLoadIdByPro(referenceNumber: string | null): Promise<string | null> {
  const want = normalizePro(referenceNumber)
  if (!want || !LOAD_TABLE_NAME) return null
  try {
    const loads = await scan<{ id: string; aljexId?: string | null }>(LOAD_TABLE_NAME)
    // The live table stores PROs padded ("14547  "), which is why this compares normalized.
    const hits = loads.filter((l) => normalizePro(l.aljexId ?? null) === want)

    /*
     * One match, or none. A PRO is supposed to be unique and very nearly is — one number
     * is on two loads today — but attaching a POD to the WRONG load is worse than leaving
     * it unattached, because an unattached POD still shows against the load by PRO and
     * someone can place it by hand. A guess would quietly paper the wrong shipment.
     */
    if (hits.length !== 1) {
      if (hits.length > 1) {
        console.warn('[driver-app-api] PRO matches more than one load; leaving the POD unattached', {
          referenceNumber, matches: hits.map((h) => h.id),
        })
      }
      return null
    }
    return hits[0].id
  } catch (err) {
    // A failed lookup costs a link, not the document. Never fail the upload over it.
    console.error('[driver-app-api] could not resolve a load for the PRO', {
      referenceNumber,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function openPodSubmissionFor(
  driverId: string,
  referenceNumber: string | null,
): Promise<DriverSubmissionRow | null> {
  if (!normalizePro(referenceNumber)) return null
  try {
    const mine = await scan<DriverSubmissionRow>(
      DRIVER_SUBMISSION_TABLE,
      'driverId = :did',
      {},
      { ':did': driverId },
    )
    return pickOpenPodSubmission(mine, referenceNumber)
  } catch (err) {
    // A failed lookup costs a duplicate submission, which staff can merge. Failing the
    // upload instead would cost the POD.
    console.error('[driver-app-api] could not look for an open POD submission', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function persistDocs(
  submissionId: string,
  driverId: string,
  kind: DocKind,
  pages: PendingPage[],
): Promise<DriverSubmissionDocRow[]> {
  const now = nowIso()
  const docs: DriverSubmissionDocRow[] = pages.map((p, i) => ({
    id: randomUUID(),
    submissionId,
    driverId,
    kind,
    s3Key: p.s3Key,
    fileName: p.fileName,
    contentType: p.contentType,
    byteSize: p.byteSize,
    pageNumber: i + 1,
    uploadedAt: now,
    // PENDING from the moment it is stored. The cleanup is queued rather than awaited, so
    // without this a page sits with no status at all and every screen has to guess whether
    // it is waiting on something or simply never going to be cleaned. A MISC photo is
    // never cleaned — a picture of a damaged pallet is not a page to deskew.
    scanStatus: kind === 'MISC' ? 'ORIGINAL_ONLY' : 'PENDING',
    createdAt: now,
    updatedAt: now,
  }))

  await Promise.all(
    docs.map((doc) =>
      ddb.send(
        new PutCommand({
          TableName: DRIVER_SUBMISSION_DOC_TABLE,
          Item: doc,
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      ),
    ),
  )

  return docs
}

async function fetchS3Bytes(s3Key: string, expectedByteSize: number): Promise<Buffer> {
  if (!Number.isFinite(expectedByteSize) || expectedByteSize <= 0 || expectedByteSize > MAX_UPLOAD_BYTES) {
    throw new ApiError(400, `Attachment size invalid for ${s3Key}`)
  }
  const head = await headS3Object(s3Key)
  if (head.contentLength > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, `Attachment exceeds max size: ${s3Key}`)
  }
  if (head.contentLength !== expectedByteSize) {
    throw new ApiError(422, `Attachment size mismatch for ${s3Key}`)
  }
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }))
  if (!res.Body) throw new ApiError(500, 'Empty S3 body')
  const bytes = await res.Body.transformToByteArray()
  return Buffer.from(bytes)
}

async function notifyForKind(
  submission: DriverSubmissionRow,
  kind: DocKind,
  pages: PendingPage[],
): Promise<{ refs: Partial<ThreadRefs>; errors: string[] }> {
  const attachments: SubmissionNotice['attachments'] = []
  // Misc photos are announced, not attached — nothing downstream wants the bytes in an email.
  for (const page of kind === 'MISC' ? [] : pages) {
    try {
      const bytes = await fetchS3Bytes(page.s3Key, page.byteSize)
      attachments.push({ fileName: page.fileName, contentType: page.contentType, bytes })
    } catch (err) {
      return { refs: {}, errors: [`S3 fetch ${page.s3Key}: ${err instanceof Error ? err.message : String(err)}`] }
    }
  }

  const notice: SubmissionNotice = {
    submissionId: submission.id,
    driverName: submission.driverName,
    referenceNumber: submission.referenceNumber,
    note: submission.note,
    attachments,
  }

  try {
    if (kind === 'RATECON') {
      const result = await notifyRateconSubmitted(notice)
      return { refs: result.refs, errors: result.error ? [result.error] : [] }
    }
    if (kind === 'MISC') {
      const result = await notifyMiscAdded({
        driverName: submission.driverName, referenceNumber: submission.referenceNumber, note: submission.note,
        count: pages.length, stopLabel: submission.stopLabel ?? null,
      })
      return { refs: {}, errors: result.error ? [result.error] : [] }
    }
    const parentRefs: Partial<ThreadRefs> = {
      slackChannelId: submission.slackChannelId ?? undefined,
      slackMessageTs: submission.slackMessageTs ?? undefined,
      emailMessageId: submission.emailMessageId ?? undefined,
      emailSubject: submission.emailSubject ?? undefined,
    }
    const result = await notifyPodAdded(notice, parentRefs)
    return { refs: result.refs, errors: result.error ? [result.error] : [] }
  } catch (err) {
    return { refs: {}, errors: [err instanceof Error ? err.message : String(err)] }
  }
}

async function completeSubmission(
  driverId: string,
  submissionId: string,
  kind: DocKind,
): Promise<{ ok: boolean; error?: string }> {
  const submission = await getOwnedSubmission(submissionId, driverId)
  const pending = submission.pendingUploads ?? {}
  const pages = pending[kind] ?? []

  if (pages.length === 0) {
    // Nothing left to upload for this leg; a previous successful notify may already exist.
    return { ok: true }
  }

  const docs = await persistDocs(submissionId, driverId, kind, pages)
  // Clean up the scan the same way a texted POD is cleaned, then merge the pages into one
  // PDF. Best-effort: the pages are already stored and readable on their own. Misc photos
  // are kept exactly as taken.
  if (kind !== 'MISC') await requestScanCleanup(docs, submissionId, kind)
  const { refs, errors } = await notifyForKind(submission, kind, pages)
  const now = nowIso()

  // Merge fresh partial refs with whatever the row already had. If this is a retry after a
  // partial failure, we must keep the earlier successful channel's handle; we only overwrite
  // it when this notify attempt produced a fresh value for that channel.
  const mergedRefs: Partial<ThreadRefs> = {
    slackChannelId: refs.slackChannelId || submission.slackChannelId || undefined,
    slackMessageTs: refs.slackMessageTs || submission.slackMessageTs || undefined,
    emailMessageId: refs.emailMessageId || submission.emailMessageId || undefined,
    emailSubject: refs.emailSubject || submission.emailSubject || undefined,
  }

  const slackSuccess = !!mergedRefs.slackChannelId && !!mergedRefs.slackMessageTs
  const emailSuccess = !!mergedRefs.emailMessageId && !!mergedRefs.emailSubject

  const setClauses: string[] = ['#s = :status', 'updatedAt = :now']
  const removeClauses: string[] = []
  const names: Record<string, string> = { '#s': 'status', '#kind': kind }
  const values: Record<string, unknown> = {
    ':status': slackSuccess && emailSuccess ? 'NOTIFIED' : submission.status,
    ':now': now,
  }

  function addSet(name: string, value: unknown, valueKey: string) {
    if (value !== undefined && value !== null) {
      setClauses.push(`${name} = ${valueKey}`)
      values[valueKey] = value
    }
  }

  addSet('slackChannelId', mergedRefs.slackChannelId, ':chan')
  addSet('slackMessageTs', mergedRefs.slackMessageTs, ':ts')
  addSet('emailMessageId', mergedRefs.emailMessageId, ':mid')
  addSet('emailSubject', mergedRefs.emailSubject, ':sub')

  if (slackSuccess) {
    setClauses.push('slackNotifiedAt = :slackAt')
    values[':slackAt'] = now
  }
  if (emailSuccess) {
    setClauses.push('emailNotifiedAt = :emailAt')
    values[':emailAt'] = now
  }

  if (errors.length === 0) {
    removeClauses.push('notificationError')
  } else {
    setClauses.push('notificationError = :err')
    values[':err'] = errors.join('; ')
  }

  removeClauses.push('pendingUploads.#kind')

  const updateClauses: string[] = []
  if (setClauses.length > 0) updateClauses.push(`SET ${setClauses.join(', ')}`)
  if (removeClauses.length > 0) updateClauses.push(`REMOVE ${removeClauses.join(', ')}`)

  await ddb.send(
    new UpdateCommand({
      TableName: DRIVER_SUBMISSION_TABLE,
      Key: { id: submissionId },
      UpdateExpression: updateClauses.join(' '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(id)',
    }),
  )

  await Promise.all(
    docs.map((doc) =>
      ddb.send(
        new UpdateCommand({
          TableName: DRIVER_SUBMISSION_DOC_TABLE,
          Key: { id: doc.id },
          UpdateExpression: 'SET notifiedAt = :now, updatedAt = :now',
          ExpressionAttributeValues: { ':now': now },
        }),
      ),
    ),
  )

  return errors.length > 0 ? { ok: true, error: errors.join('; ') } : { ok: true }
}

/**
 * When this driver's own truck is next due for a PM.
 *
 * Reads the same two sources the fleet dashboard does — the last PM on the Equipment
 * record, Motive's odometer on TruckLocation — through the one shared rule in
 * src/lib/pmDue.ts, so the driver's phone and the office cannot drift apart.
 *
 * Null when there is simply no truck to report on: a driver with nothing assigned has no
 * PM, and an empty gauge is noise. Everything softer than that — a truck with no last PM
 * recorded, or one Motive has not reported on — comes back as UNKNOWN with a reason,
 * because those are states somebody should fix rather than hide.
 */
interface EquipmentRow {
  id: string
  type?: string | null
  unitNumber?: string | null
  active?: boolean | null
  assignedDriverId?: string | null
  eldSource?: string | null
  motiveVehicleNumber?: string | null
}

interface MaintenanceTaskRow {
  id: string
  equipmentId: string
  title: string
  priority?: string | null
  status?: string | null
  notes?: string | null
  dueDate?: string | null
  completedDate?: string | null
  createdAt: string
}

/** The truck on the driver's row, as the app names it. Null when none is assigned. */
async function truckForDriver(driver: DriverRow): Promise<{ id: string; unitNumber: string } | null> {
  const truckId = (driver.assignedTruckId ?? '').trim()
  if (!truckId || !EQUIPMENT_TABLE) return null
  try {
    const truck = (await ddb.send(new GetCommand({ TableName: EQUIPMENT_TABLE, Key: { id: truckId } }))).Item as EquipmentRow | undefined
    return truck ? { id: truck.id, unitNumber: String(truck.unitNumber ?? '').trim() } : null
  } catch (err) {
    console.error('[driver-app-api] could not read the driver\'s truck', { truckId, err })
    return null
  }
}

/** The latest ELD fix for the driver's assigned truck, or null when there is none. */
async function truckFixForDriver(driver: DriverRow): Promise<LatLng | null> {
  const truckId = (driver.assignedTruckId ?? '').trim()
  if (!truckId || !TRUCK_LOCATION_TABLE) return null
  try {
    const loc = (await ddb.send(new GetCommand({ TableName: TRUCK_LOCATION_TABLE, Key: { truckId } }))).Item as
      | { lat?: unknown; lon?: unknown } | undefined
    return typeof loc?.lat === 'number' && typeof loc?.lon === 'number' ? { lat: loc.lat, lng: loc.lon } : null
  } catch (err) {
    console.error('[driver-app-api] could not read the truck fix', { truckId, err })
    return null
  }
}

/**
 * Where a stop is: the directory location's geocode when the stop is linked to one,
 * else the city centroid. Null when neither places it — the ETA then falls back to
 * the appointment rather than guess.
 */
async function stopCoords(stop: Stop | undefined): Promise<LatLng | null> {
  if (!stop) return null
  if (stop.locationId && LOCATION_TABLE_NAME) {
    try {
      const loc = (await ddb.send(new GetCommand({ TableName: LOCATION_TABLE_NAME, Key: { id: stop.locationId } }))).Item as
        | { lat?: unknown; lng?: unknown } | undefined
      if (typeof loc?.lat === 'number' && typeof loc?.lng === 'number') return { lat: loc.lat, lng: loc.lng }
    } catch (err) {
      console.error('[driver-app-api] could not read the stop location', { locationId: stop.locationId, err })
    }
  }
  const city = stop.address?.city && stop.address?.state
    ? `${stop.address.city}, ${stop.address.state}`
    : stop.city
  return locateCity(city) ?? null
}

async function pmForDriver(
  driver: DriverRow,
): Promise<(PmStatus & { truckNumber: string | null }) | null> {
  const truckId = (driver.assignedTruckId ?? '').trim()
  if (!truckId || !EQUIPMENT_TABLE) return null

  try {
    const truck = (
      await ddb.send(new GetCommand({ TableName: EQUIPMENT_TABLE, Key: { id: truckId } }))
    ).Item as Record<string, unknown> | undefined
    if (!truck) return null

    let odometer: number | null = null
    if (TRUCK_LOCATION_TABLE) {
      const loc = (
        await ddb.send(new GetCommand({ TableName: TRUCK_LOCATION_TABLE, Key: { truckId } }))
      ).Item as Record<string, unknown> | undefined
      odometer = typeof loc?.odometer === 'number' ? loc.odometer : null
    }

    return {
      ...pmStatus({
        lastPmMileage: typeof truck.lastPmMileage === 'number' ? truck.lastPmMileage : null,
        lastPmDate: typeof truck.lastPmDate === 'string' ? truck.lastPmDate : null,
        currentOdometer: odometer,
      }),
      truckNumber: typeof truck.unitNumber === 'string' ? truck.unitNumber.trim() || null : null,
    }
  } catch (err) {
    // The PM line is a nicety; it must never take the whole account screen down with it.
    console.error('[driver-app-api] could not read the PM status', {
      truckId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * One day of this driver's hours of service, read from Motive.
 *
 * Ivan drivers only, and read-only. Duty status is a federal record: the FMCSA requires
 * edits to go through the certified ELD, so the app shows what Motive holds and sends the
 * driver to the Motive app to change anything. Nothing here writes.
 *
 * The link is the explicit motiveDriverId on the Driver record and nothing else. Motive's
 * org carries "Chuck Best" against our "Charles Best" and two people called "Jason Smith",
 * so a name match here would eventually put one driver's legally-significant log in front
 * of another. See src/lib/motiveDriverMatch.ts.
 */
async function hosForDriver(
  driver: DriverRow,
  date: string,
): Promise<{ ok: true; day: HosDay | null } | { ok: false; reason: string }> {
  if (!MOTIVE_API_KEY) return { ok: false, reason: 'Motive is not configured' }

  const linked = driver.motiveDriverId
  if (linked == null || String(linked).trim() === '') {
    return { ok: false, reason: 'No Motive account is linked to this driver yet' }
  }

  const url =
    `${MOTIVE_BASE}/logs?driver_ids[]=${encodeURIComponent(String(linked))}` +
    `&start_date=${encodeURIComponent(date)}&end_date=${encodeURIComponent(date)}&per_page=10`

  const res = await fetch(url, { headers: { 'X-Api-Key': MOTIVE_API_KEY } })
  if (!res.ok) {
    console.error('[driver-app-api] Motive logs call failed', { status: res.status, date })
    return { ok: false, reason: `Motive did not answer (${res.status})` }
  }

  const body = (await res.json()) as { logs?: Array<{ log?: MotiveLog }> }
  const log = (body.logs ?? []).map((l) => l?.log).find((l): l is MotiveLog => !!l)
  // A day with no log is not an error — a driver who did not work has nothing to show.
  return { ok: true, day: log ? toHosDay(log) : null }
}

/**
 * The Chicago calendar day right now. The clock belongs to the day a driver is working,
 * not to UTC — a 7pm shift must not land on tomorrow's card.
 */
function chicagoToday(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
}

/** Every time clock row for one driver. Scanned once and filtered — the table is small. */
async function timeClockRowsFor(driverId: string): Promise<TimeClockRow[]> {
  if (!TIME_CLOCK_TABLE) return []
  const out: TimeClockRow[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: TIME_CLOCK_TABLE,
        FilterExpression: 'driverId = :d',
        ExpressionAttributeValues: { ':d': driverId },
        ExclusiveStartKey,
      }),
    )
    out.push(...((r.Items ?? []) as TimeClockRow[]))
    ExclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (ExclusiveStartKey)
  return out
}

/**
 * The shift this driver currently has running, if any.
 *
 * Checked before every clock-in so one driver cannot have two open shifts — a double
 * clock-in is how a day ends up counted twice, and the second one is almost always a
 * mis-tap rather than a genuine second shift.
 */
function openShiftIn(rows: TimeClockRow[]): TimeClockRow | null {
  return rows.find(isOpenShift) ?? null
}

/**
 * The overnight runs in one pay period, and what they earned.
 *
 * Shown on the time clock because that is where a driver looks to see what a period came
 * to. Scoped to the SAME Monday-to-Sunday week the card uses, so the loads listed and the
 * hours above them describe one period rather than two overlapping ones.
 *
 * Gross, and only gross: Ivan drivers have nothing deducted, so a net figure would be the
 * same number wearing a label that invites someone to look for the difference.
 */
async function overnightForWeek(
  driverId: string,
  weekStart: string,
): Promise<{ weekStart: string; loads: Array<Record<string, unknown>>; grossCents: number }> {
  const txt = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const days = weekDays(weekStart)
  const from = days[0]
  const to = days[6]

  const loads = await scan<Record<string, unknown>>(LOAD_TABLE_NAME)
  const mine = loads.filter((l) => {
    if (!driverIsOnPaperworkLoad(l as never, driverId)) return false
    const delivered = String(l.deliveryAppt ?? '').slice(0, 10)
    return delivered >= from && delivered <= to
  })

  const out = mine
    .filter((l) =>
      isOvernightLoad([
        `${txt(l.originCity)}${txt(l.originState) ? `, ${txt(l.originState)}` : ''}`,
        `${txt(l.destinationCity)}${txt(l.destinationState) ? `, ${txt(l.destinationState)}` : ''}`,
      ]),
    )
    .map((l) => ({
      id: String(l.id),
      reference: txt(l.aljexId) || txt(l.pickupNumber) || String(l.id).slice(-6),
      origin: txt(l.originCity) || null,
      destination: txt(l.destinationCity) || null,
      deliveredOn: String(l.deliveryAppt ?? '').slice(0, 10) || null,
      rateCents: typeof l.rate === 'number' ? l.rate : null,
    }))
    .sort((a, b) => String(a.deliveredOn ?? '').localeCompare(String(b.deliveredOn ?? '')))

  return {
    weekStart,
    loads: out,
    grossCents: out.reduce((n, l) => n + (l.rateCents ?? 0), 0),
  }
}

/**
 * A staff caller, for routes that are about the fleet rather than about one driver.
 *
 * The impersonation path verifies the same token but then narrows to a single driver and
 * writes an audit entry, which is right for "look at their app" and wrong for "show me the
 * office a report". Same staff pool, same permission check, no impersonation.
 */
async function verifyStaff(event: FnUrlEvent): Promise<string> {
  const token = extractBearer(event.headers)
  if (!token) throw new ApiError(401, 'Missing authorization')
  if (!staffVerifier) throw new ApiError(403, 'Staff access is not configured')
  let claims: { email?: string }
  try {
    claims = (await staffVerifier.verify(token)) as { email?: string }
  } catch (err) {
    throw new ApiError(401, `Invalid staff token: ${err instanceof Error ? err.message : String(err)}`)
  }
  const email = normalizeEmail(claims.email ?? '')
  if (!email) throw new ApiError(401, 'Staff token missing email')
  if (!mayImpersonate(email)) throw new ApiError(403, 'Not permitted')
  return email
}

interface TruckDay {
  firstMoveAt: string | null
  lastMoveAt: string | null
  drivingSeconds: number
  onDutySeconds: number
  /** Unit numbers the day was logged against — these drivers swap trucks. */
  vehicles: string[]
}

/**
 * When each driver's truck was actually moving, by day, for the hours page.
 *
 * The signal is the ELD's own DRIVING segments. A driver cannot set those by hand the way
 * they can a clock-in — the device logs them from vehicle motion — so they are the honest
 * check on a time card. On-duty-not-driving is reported alongside, because a driver doing a
 * pre-trip or waiting at a dock is working while the truck is still.
 *
 * One Motive call for every driver over the whole period rather than one per driver per
 * day: /v1/logs takes a list of driver ids and a date range, and a fortnight of five drivers
 * would otherwise be seventy requests to learn the same thing.
 */
async function motiveDaysFor(
  driverIds: string[],
  from: string,
  to: string,
): Promise<Record<string, Record<string, TruckDay>>> {
  const out: Record<string, Record<string, TruckDay>> = {}
  if (!MOTIVE_API_KEY) return out

  const drivers = await scan<DriverRow>(DRIVER_TABLE)
  // Only drivers with an explicit Motive link; a name match must never decide whose log
  // this is. See src/lib/motiveDriverMatch.ts.
  const linked = drivers.filter(
    (d) => driverIds.includes(d.id) && d.motiveDriverId != null && String(d.motiveDriverId).trim() !== '',
  )
  if (linked.length === 0) return out

  const byMotiveId = new Map(linked.map((d) => [String(d.motiveDriverId), d.id]))
  const params = linked.map((d) => `driver_ids[]=${encodeURIComponent(String(d.motiveDriverId))}`).join('&')
  const url = `${MOTIVE_BASE}/logs?${params}&start_date=${encodeURIComponent(from)}&end_date=${encodeURIComponent(to)}&per_page=100`

  try {
    const res = await fetch(url, { headers: { 'X-Api-Key': MOTIVE_API_KEY } })
    if (!res.ok) {
      console.error('[driver-app-api] Motive logs failed for the hours page', { status: res.status })
      return out
    }
    const body = (await res.json()) as { logs?: Array<{ log?: MotiveLog & { driver?: { id?: number } } }> }
    for (const row of body.logs ?? []) {
      const log = row?.log
      if (!log) continue
      const driverId = byMotiveId.get(String(log.driver?.id ?? ''))
      const date = String(log.date ?? '').slice(0, 10)
      if (!driverId || !date) continue
      const day = toHosDay(log)
      const moving = day.segments.filter((sg) => sg.type === 'driving')
      out[driverId] ??= {}
      out[driverId][date] = {
        firstMoveAt: moving[0]?.startAt ?? null,
        lastMoveAt: moving.length ? (moving[moving.length - 1].endAt ?? null) : null,
        drivingSeconds: day.drivingSeconds,
        onDutySeconds: day.onDutySeconds,
        /*
         * Which truck(s) the day was logged against.
         *
         * These drivers swap trucks, so naming the vehicle is what stops a perfectly normal
         * day looking like a discrepancy. The log itself follows the DRIVER — Motive keys
         * hours of service to the person, not the vehicle — so a swap never moved the
         * comparison onto somebody else's wheels in the first place; this just makes that
         * legible to whoever is reading the row.
         */
        vehicles: Array.isArray(log.vehicle_numbers)
          ? log.vehicle_numbers.map((v) => String(v).trim()).filter(Boolean)
          : [],
      }
    }
  } catch (err) {
    // The hours page works without it; the comparison column simply says nothing.
    console.error('[driver-app-api] could not read Motive for the hours page', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return out
}

function groupBy<T, K extends string | number | symbol>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    const list = map.get(key) ?? []
    list.push(item)
    map.set(key, list)
  }
  return map
}

async function handleEmailIntakePrepare(event: FnUrlEvent) {
  const body = parseBody(event)
  if (!emailIntakeSecretOk(getString(body, 'secret'))) {
    return reply(401, { error: 'unauthorized' })
  }

  const gmailMessageId = getString(body, 'gmailMessageId') ?? ''
  const from = getString(body, 'from') ?? ''
  const subject = getString(body, 'subject') ?? ''
  const rawBody = getString(body, 'body') ?? ''

  if (!gmailMessageId) return reply(400, { error: 'gmailMessageId required' })

  const skip = shouldSkipEmailIntake(from, subject)
  if (skip.skip) {
    return reply(200, { skipped: true, reason: skip.reason })
  }

  // Idempotency: deterministic id plus conditional Put prevents duplicate rows even when
  // two bridge calls race after the query below finds nothing.
  const submissionId = emailSubmissionId(gmailMessageId)
  const existing = await querySubmissionByExternalMessageId(gmailMessageId)
  if (existing) {
    // A second call for the same message is only a no-op once the docs are actually committed.
    // If the previous attempt died between prepare and commit (S3 PUT failed, bridge crashed),
    // the row sits at NEW with pendingUploads and nothing was ever notified - returning a bare
    // `skipped` there strands the rate con forever. Hand back fresh presigned targets instead so
    // the caller can finish the job.
    const committed = await listSubmissionDocs(existing.id, 'RATECON')
    if (committed.length > 0) {
      return reply(200, { skipped: true, reason: 'duplicate', submissionId: existing.id })
    }

    const retry = validateEmailPages(assertArrayField(body, 'attachments'))
    if (!retry.ok) return reply(400, { error: retry.error })
    const resumed = await presignedPutTargets(existing.driverId, existing.id, 'RATECON', retry.pages)
    // Write the whole `pendingUploads` map, not the nested `pendingUploads.RATECON` path: when a
    // row has no `pendingUploads` attribute at all, real DynamoDB rejects a nested SET with a
    // ValidationException on the document path. A full-map write works either way.
    const pending: PendingUploads = { ...(existing.pendingUploads ?? {}), RATECON: resumed.pagesWithKeys }
    await ddb.send(
      new UpdateCommand({
        TableName: DRIVER_SUBMISSION_TABLE,
        Key: { id: existing.id },
        UpdateExpression: 'SET pendingUploads = :pending, updatedAt = :ts',
        ExpressionAttributeValues: { ':pending': pending, ':ts': nowIso() },
      }),
    )
    return reply(200, {
      resumed: true,
      submissionId: existing.id,
      driverId: existing.driverId,
      driverName: existing.driverName,
      targets: resumed.targets,
    })
  }

  const { driverId, driverName, matched } = await resolveDriverByName(rawBody)

  const validation = validateEmailPages(assertArrayField(body, 'attachments'))
  if (!validation.ok) return reply(400, { error: validation.error })

  const { targets, pagesWithKeys } = await presignedPutTargets(driverId, submissionId, 'RATECON', validation.pages)

  const now = nowIso()
  const note = buildEmailNote(subject, rawBody, matched)

  try {
    await ddb.send(
      new PutCommand({
        TableName: DRIVER_SUBMISSION_TABLE,
        Item: {
          id: submissionId,
          __typename: 'DriverSubmission',
          driverId,
          driverName,
          status: 'NEW',
          source: 'EMAIL',
          externalMessageId: gmailMessageId,
          note,
          createdAt: now,
          updatedAt: now,
          pendingUploads: { RATECON: pagesWithKeys } satisfies PendingUploads,
        },
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      // Lost a race with a call that is in flight RIGHT NOW for this same message. Do not resume
      // here: re-presigning would rewrite pendingUploads under the live caller and the two would
      // commit different key sets.
      //
      // This is NOT `duplicate`. A duplicate is finished work and the caller should retire the
      // message; `in-flight` means someone else may yet fail, so the caller must leave the message
      // eligible for a later poll - which is the only thing that makes backing off self-healing.
      return reply(200, { skipped: true, reason: 'in-flight', submissionId })
    }
    throw err
  }

  return reply(200, { submissionId, driverId, driverName, driverMatched: matched, targets })
}

async function handleEmailIntakeCommit(event: FnUrlEvent) {
  const body = parseBody(event)
  if (!emailIntakeSecretOk(getString(body, 'secret'))) {
    return reply(401, { error: 'unauthorized' })
  }

  const gmailMessageId = getString(body, 'gmailMessageId') ?? ''
  const submissionId = getString(body, 'submissionId') ?? ''
  if (!gmailMessageId) return reply(400, { error: 'gmailMessageId required' })
  if (!submissionId) return reply(400, { error: 'submissionId required' })

  const submission = await getEmailSubmission(submissionId)
  // Ownership check: an email-sourced row must never be mutable via a driver token,
  // and a driver-sourced row must never be mutable via this secret.
  if (submission.source !== 'EMAIL' || submission.externalMessageId !== gmailMessageId) {
    return reply(404, { error: 'Submission not found' })
  }

  // Idempotent: do not re-persist docs or re-notify if this submission already committed.
  const existingDocs = await listSubmissionDocs(submissionId, 'RATECON')
  if (existingDocs.length > 0) {
    return reply(200, {
      ok: true,
      notified: submission.status === 'NOTIFIED',
      error: submission.notificationError ?? undefined,
    })
  }

  const attachments = assertArrayField(body, 'attachments')
  if (!attachments || attachments.length === 0) {
    return reply(400, { error: 'attachments required' })
  }

  // The caller supplies s3Keys, so they are confined to THIS submission's own prefix — the exact
  // set of keys prepare handed out. Without this, a bridge bug or a leaked secret could attach any
  // object in the bucket to a submission and have notifyForKind email it out.
  const allowedPrefix = `driver-docs/${submission.driverId}/${submissionId}/RATECON/`
  const pages: PendingPage[] = []
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    if (!att || typeof att !== 'object') return reply(400, { error: `attachment ${i + 1} invalid` })
    const fileName = getString(att, 'fileName')?.trim() ?? ''
    const contentType = getString(att, 'contentType')?.trim() ?? ''
    const byteSize = Number(getField(att, 'byteSize'))
    const s3Key = getString(att, 's3Key') ?? ''
    if (!fileName) return reply(400, { error: `attachment ${i + 1} missing fileName` })
    if (!s3Key) return reply(400, { error: `attachment ${i + 1} missing s3Key` })
    if (!s3Key.startsWith(allowedPrefix)) {
      return reply(403, { error: `attachment ${i + 1} key outside this submission` })
    }
    if (!Number.isFinite(byteSize) || byteSize <= 0) {
      return reply(400, { error: `attachment ${i + 1} size invalid` })
    }

    let head
    try {
      head = await headS3Object(s3Key)
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'NotFound' || name === 'NoSuchKey') {
        return reply(503, { error: 'attachment verification failed' })
      }
      throw err
    }

    if (head.contentLength !== byteSize) {
      return reply(422, { error: `attachment size mismatch: ${fileName}` })
    }
    pages.push({ fileName, contentType, byteSize, s3Key })
  }

  // Prime pendingUploads and reuse the exact same completeSubmission path as the PWA.
  //
  // NOTE the expression shape: `pendingUploads.#kind`, NOT an attribute name containing a dot.
  // An ExpressionAttributeName is a single attribute NAME, so mapping one to 'pendingUploads.RATECON'
  // creates a top-level attribute literally called "pendingUploads.RATECON"; the nested map the
  // reader walks (`submission.pendingUploads.RATECON` in completeSubmission) stays empty and the
  // commit silently notifies nothing.
  await ddb.send(
    new UpdateCommand({
      TableName: DRIVER_SUBMISSION_TABLE,
      Key: { id: submissionId },
      UpdateExpression: 'SET pendingUploads.#kind = :pages, updatedAt = :ts',
      ExpressionAttributeNames: { '#kind': 'RATECON' },
      ExpressionAttributeValues: { ':pages': pages, ':ts': nowIso() },
      ConditionExpression: 'attribute_exists(id)',
    }),
  )

  const result = await completeSubmission(submission.driverId, submissionId, 'RATECON')
  return reply(200, { ok: true, notified: !result.error, error: result.error })
}

export const handler = async (event: FnUrlEvent) => {
  try {
    const { path, id, docId } = parsePath(event.rawPath)
    const method = event.requestContext.http.method.toUpperCase()

    // Shared-secret email intake routes are handled BEFORE any Cognito branch so the
    // secret can never reach a driver-scoped route and vice versa.
    if (method === 'POST' && path === '/email-intake/prepare') {
      return await handleEmailIntakePrepare(event)
    }

    if (method === 'POST' && path === '/email-intake/commit') {
      return await handleEmailIntakeCommit(event)
    }

    /*
     * Staff-only, and handled before the driver branch so a driver token can never reach it:
     * it answers about other people's days, which is the office's business and not a
     * driver's.
     */
    if (method === 'GET' && path === '/staff/motive-days') {
      await verifyStaff(event)
      const q = event.queryStringParameters ?? {}
      const ids = String(q.driverIds ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      const from = String(q.from ?? '').trim()
      const to = String(q.to ?? '').trim()
      if (!ids.length) return reply(400, { error: 'driverIds required' })
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return reply(400, { error: 'from and to must be YYYY-MM-DD' })
      }
      return reply(200, { days: await motiveDaysFor(ids, from, to) })
    }

    const { driver, setting, impersonatedBy } = await loadVerifiedDriver(event)
    const driverId = driver.id

    /*
     * An impersonated session can look and cannot touch.
     *
     * This is the line that makes the whole feature safe to have. Without it an admin
     * could upload, replace or remove a driver's POD while wearing their identity, and
     * every record of it — the submission, the Slack-free email, the settlement — would
     * say the driver did it. One check, in one place, covering every route rather than
     * each one remembering.
     */
    if (impersonatedBy && method !== 'GET') {
      return reply(403, {
        error: 'You are viewing this driver app, not signed in as the driver. Changes have to be made from the staff pages.',
      })
    }

    if (method === 'GET' && path === '/me') {
      const program = driverProgramOf({ ...driver, payGroup: setting.payGroup })
      console.log('[driver-app-api] me', { driverId: driver.id, driverName: driver.name, program })
      return reply(200, {
        driverId: driver.id,
        name: driver.name,
        // Roy and Lee carry '' on the Driver row and their real address on the pay
        // setting, and '' is not nullish — a ?? chain leaves their account screen blank.
        email: driver.email || setting.email || '',
        payGroup: setting.payGroup ?? 'AMAZON',
        // Which page this driver gets: a settlement, or paperwork with no money on it.
        // The app routes on this rather than on payGroup — see src/lib/driverProgram.ts.
        program,
        active: driver.active !== false,
        // null for a driver with no truck assigned; the app simply omits the line.
        pm: await pmForDriver(driver),
        // The truck they are in — what the ELD fix, the PM line and dispatch all key on.
        truck: await truckForDriver(driver),
        // The number to call or text dispatch, pinned to the top of the app.
        dispatchPhone: await dispatchPhone(),
      })
    }

    /*
     * The maintenance tasks on the driver's truck — what they reported and what the shop
     * has open on that unit — so a driver can see their report was received and whether
     * it is done. Same rows the office's Maintenance page shows for the unit.
     */
    if (method === 'GET' && path === '/maintenance-tasks') {
      if (!MAINTENANCE_TASK_TABLE) return reply(503, { error: 'Maintenance is not configured' })
      const truck = await truckForDriver(driver)
      if (!truck) return reply(200, { truck: null, tasks: [] })
      const rows = await scan<MaintenanceTaskRow>(MAINTENANCE_TASK_TABLE, 'equipmentId = :e', {}, { ':e': truck.id })
      const tasks = rows
        .map((t) => ({
          id: t.id, title: t.title, priority: t.priority ?? 'med', status: t.status ?? 'upcoming',
          notes: t.notes ?? null, dueDate: t.dueDate ?? null, completedDate: t.completedDate ?? null,
          createdAt: t.createdAt, reportedByMe: (t.notes ?? '').includes(`[driver:${driver.id}]`),
        }))
        .sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === 'upcoming' ? -1 : 1))
      return reply(200, { truck, tasks })
    }

    /*
     * A driver reports a problem with their truck. It becomes an ordinary maintenance task
     * on the unit — the same row the office creates from the Maintenance page — tagged in
     * its notes with who reported it, so the shop sees it where it already looks.
     */
    if (method === 'POST' && path === '/maintenance-tasks') {
      if (!MAINTENANCE_TASK_TABLE) return reply(503, { error: 'Maintenance is not configured' })
      const body = JSON.parse(event.body || '{}') as { title?: string; notes?: string; priority?: string; truckId?: string }
      const title = (body.title ?? '').trim().slice(0, 200)
      if (!title) return reply(400, { error: 'say what the problem is' })
      const priority = body.priority === 'high' || body.priority === 'low' ? body.priority : 'med'
      let truck: { id: string; unitNumber: string } | null = null
      if (body.truckId) {
        const picked = (await ddb.send(new GetCommand({ TableName: EQUIPMENT_TABLE, Key: { id: body.truckId.trim() } }))).Item as EquipmentRow | undefined
        if (picked && picked.active !== false) truck = { id: picked.id, unitNumber: String(picked.unitNumber ?? '').trim() }
      } else {
        truck = await truckForDriver(driver)
      }
      if (!truck) return reply(400, { error: 'Pick your truck first, so the shop knows which unit' })
      const now = nowIso()
      const details = (body.notes ?? '').trim().slice(0, 2000)
      const task = {
        __typename: 'MaintenanceTask',
        id: `task-${Date.now()}-${randomUUID().slice(0, 8)}`,
        equipmentId: truck.id,
        title,
        priority,
        status: 'upcoming',
        autoDot: false,
        notes: `Reported by ${driver.name} from the driver app on ${now.slice(0, 10)}.${details ? `\n${details}` : ''}\n[driver:${driver.id}]`,
        createdAt: now,
        updatedAt: now,
      }
      await ddb.send(new PutCommand({ TableName: MAINTENANCE_TASK_TABLE, Item: task, ConditionExpression: 'attribute_not_exists(id)' }))
      console.log('[driver-app-api] maintenance task reported', { driverId, truck: truck.unitNumber, title, priority })
      return reply(200, { task: { id: task.id, title, priority, status: 'upcoming', createdAt: now, truck: { id: truck.id, unitNumber: String(truck.unitNumber ?? '').trim() } } })
    }

    /*
     * The trucks a driver can pick from at the start of the day. Every active truck, who
     * is in it now, and whether it has a Motive gateway — the point of picking is that the
     * ELD logs land on the right name.
     */
    if (method === 'GET' && path === '/trucks') {
      if (!EQUIPMENT_TABLE) return reply(503, { error: 'Trucks are not configured' })
      const [trucks, roster] = await Promise.all([
        scan<EquipmentRow>(EQUIPMENT_TABLE, '#t = :truck', { '#t': 'type' }, { ':truck': 'truck' }),
        scan<DriverRow>(DRIVER_TABLE),
      ])
      const nameById = new Map(roster.map((d) => [d.id, d.name]))
      const list = trucks
        .filter((t) => t.active !== false && (t.unitNumber ?? '').trim())
        .map((t) => ({
          id: t.id,
          unitNumber: String(t.unitNumber).trim(),
          eld: (t.eldSource ?? '').toLowerCase() === 'motive' && !!(t.motiveVehicleNumber ?? '').trim(),
          holder: t.assignedDriverId ? (nameById.get(t.assignedDriverId) ?? null) : null,
          yours: t.assignedDriverId === driver.id,
        }))
        .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }))
      return reply(200, { trucks: list })
    }

    /*
     * The driver says which truck they are in. One driver per truck and one truck per
     * driver, written on both sides — the same assignment the office makes from the fleet
     * page, so the dashboard, the PM line and the ELD match all read the same answer.
     */
    if (method === 'POST' && path === '/me/truck') {
      if (!EQUIPMENT_TABLE) return reply(503, { error: 'Trucks are not configured' })
      const body = JSON.parse(event.body || '{}') as { truckId?: string }
      const truckId = (body.truckId ?? '').trim()
      if (!truckId) return reply(400, { error: 'truckId is required' })
      const truck = (await ddb.send(new GetCommand({ TableName: EQUIPMENT_TABLE, Key: { id: truckId } }))).Item as EquipmentRow | undefined
      if (!truck || truck.type !== 'truck' || truck.active === false) return reply(404, { error: 'truck not found' })

      const now = nowIso()
      const roster = await scan<DriverRow>(DRIVER_TABLE)
      // Whoever had this truck gives it up; whatever else this driver had is released.
      const previousHolders = roster.filter((d) => d.assignedTruckId === truckId && d.id !== driver.id)
      const otherTrucks = (await scan<EquipmentRow>(EQUIPMENT_TABLE, 'assignedDriverId = :me', {}, { ':me': driver.id }))
        .filter((t) => t.id !== truckId)
      await Promise.all([
        ddb.send(new UpdateCommand({
          TableName: DRIVER_TABLE, Key: { id: driver.id },
          UpdateExpression: 'SET assignedTruckId = :t, updatedAt = :u',
          ExpressionAttributeValues: { ':t': truckId, ':u': now },
        })),
        ddb.send(new UpdateCommand({
          TableName: EQUIPMENT_TABLE, Key: { id: truckId },
          UpdateExpression: 'SET assignedDriverId = :d, updatedAt = :u',
          ExpressionAttributeValues: { ':d': driver.id, ':u': now },
        })),
        ...previousHolders.map((d) => ddb.send(new UpdateCommand({
          TableName: DRIVER_TABLE, Key: { id: d.id },
          UpdateExpression: 'SET assignedTruckId = :n, updatedAt = :u',
          ExpressionAttributeValues: { ':n': null, ':u': now },
        }))),
        ...otherTrucks.map((t) => ddb.send(new UpdateCommand({
          TableName: EQUIPMENT_TABLE, Key: { id: t.id },
          UpdateExpression: 'SET assignedDriverId = :n, updatedAt = :u',
          ExpressionAttributeValues: { ':n': null, ':u': now },
        }))),
      ])
      console.log('[driver-app-api] truck picked', {
        driverId: driver.id, driverName: driver.name, truckId, unitNumber: truck.unitNumber,
        released: { drivers: previousHolders.map((d) => d.name), trucks: otherTrucks.map((t) => t.unitNumber) },
      })
      return reply(200, { truck: { id: truck.id, unitNumber: String(truck.unitNumber ?? '').trim() } })
    }

    /*
     * Ivan paperwork.
     *
     * Deliberately NOT folded into /settlement. That endpoint's job is to explain a
     * check, and every field on it is a pay field; bolting a "hide the money" flag onto it
     * would leave one `if` between an Ivan driver and the rate of every load they haul.
     * A separate endpoint whose payload has no money in it cannot make that mistake.
     */
    /*
     * This driver's own hours of service for one day, from Motive. Read-only.
     *
     * Ivan drivers only — owner operators do not get hours in their app, so the check is
     * the same driverProgramOf the rest of the app routes on rather than a second rule
     * that could drift from it.
     */
    if (method === 'GET' && path === '/motive/day') {
      if (driverProgramOf({ ...driver, payGroup: setting.payGroup }) !== 'PAPERWORK') {
        return reply(409, { error: 'Hours of service are an Ivan driver feature.' })
      }
      const date = (event.queryStringParameters?.date ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply(400, { error: 'date must be YYYY-MM-DD' })
      }
      const hos = await hosForDriver(driver, date)
      return hos.ok
        ? reply(200, { date, linked: true, day: hos.day })
        : reply(200, { date, linked: false, day: null, reason: hos.reason })
    }

    /*
     * The employee time clock. Ivan drivers only — owner operators are settled a percentage
     * and do not clock, so the gate is driverProgramOf again rather than a second rule.
     */
    if (path === '/timeclock' || path === '/timeclock/punch') {
      if (driverProgramOf({ ...driver, payGroup: setting.payGroup }) !== 'PAPERWORK') {
        return reply(409, { error: 'The time clock is an Ivan driver feature.' })
      }
      if (!TIME_CLOCK_TABLE) return reply(503, { error: 'Time clock is not configured' })

      const rows = await timeClockRowsFor(driverId)

      if (method === 'GET' && path === '/timeclock') {
        const weekParam = (event.queryStringParameters?.week ?? '').trim()
        const today = chicagoToday()
        const weekStart = weekParam ? weekStartOf(weekParam) : weekStartOf(today)
        const open = openShiftIn(rows)
        return reply(200, {
          today,
          week: summarizeWeek(weekStart, rows),
          // The pay period's overnight runs and what they earned — the one place money
          // reaches an Ivan driver. Gross: nothing is deducted from it.
          overnight: await overnightForWeek(driverId, weekStart),
          // Newest first, so the app's week picker needs no sorting of its own.
          weeks: recentWeekStarts(today, 12),
          openShift: open,
          // Only Jason and Chuck accrue PTO; the app hides the button for everyone else.
          ptoEligible: driver.ptoEligible === true,
          /*
           * An admin viewing a driver's app must never punch their clock, so the punch
           * route refuses outright. Saying so here lets the app disable the button rather
           * than letting staff press it and meet a 403 — the refusal is the right behaviour
           * either way, but a disabled button explains itself and an error does not.
           */
          readOnly: Boolean(impersonatedBy),
        })
      }

      if (method === 'POST' && path === '/timeclock/punch') {
        if (impersonatedBy) {
          // An admin looking at a driver's app must never punch their clock for them.
          return reply(403, { error: 'Read-only while viewing as a driver.' })
        }
        const body = parseBody(event) as Record<string, unknown>
        const action = String(body.action ?? '')
        const nowIso = new Date().toISOString()

        if (action === 'IN') {
          const already = openShiftIn(rows)
          // Idempotent rather than an error: a double tap should not be a failure screen.
          if (already) return reply(200, { ok: true, openShift: already, alreadyOpen: true })
          const item: TimeClockRow = {
            id: randomUUID(),
            driverId,
            workDate: chicagoToday(),
            kind: 'WORK',
            clockInAt: nowIso,
            clockOutAt: null,
            minutes: null,
            source: 'DRIVER',
          }
          await ddb.send(new PutCommand({ TableName: TIME_CLOCK_TABLE, Item: {
            ...item, __typename: 'TimeClockEntry', createdAt: nowIso, updatedAt: nowIso,
          } }))
          return reply(200, { ok: true, openShift: item })
        }

        if (action === 'OUT') {
          const open = openShiftIn(rows)
          if (!open) return reply(200, { ok: true, openShift: null, alreadyClosed: true })
          const closed = { ...open, clockOutAt: nowIso }
          await ddb.send(new UpdateCommand({
            TableName: TIME_CLOCK_TABLE,
            Key: { id: open.id },
            UpdateExpression: 'SET clockOutAt = :o, #m = :m, updatedAt = :u',
            ExpressionAttributeNames: { '#m': 'minutes' },
            ExpressionAttributeValues: {
              ':o': nowIso,
              // Totalled on close, so the figure is fixed at the moment it was earned.
              ':m': rowMinutes(closed),
              ':u': nowIso,
            },
          }))
          return reply(200, { ok: true, openShift: null, minutes: rowMinutes(closed) })
        }

        if (action === 'HOLIDAY' || action === 'PTO') {
          if (action === 'PTO' && driver.ptoEligible !== true) {
            return reply(403, { error: 'PTO is not set up for this driver.' })
          }
          const workDate = String(body.date ?? '').trim()
          if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
            return reply(400, { error: 'date must be YYYY-MM-DD' })
          }
          const item: TimeClockRow = {
            id: randomUUID(),
            driverId,
            workDate,
            kind: action,
            clockInAt: null,
            clockOutAt: null,
            minutes: STANDARD_DAY_MINUTES,
            note: typeof body.note === 'string' ? body.note.slice(0, 200) : null,
            source: 'DRIVER',
          }
          await ddb.send(new PutCommand({ TableName: TIME_CLOCK_TABLE, Item: {
            ...item, __typename: 'TimeClockEntry', createdAt: nowIso, updatedAt: nowIso,
          } }))
          return reply(200, { ok: true, entry: item })
        }

        return reply(400, { error: 'action must be IN, OUT, HOLIDAY or PTO' })
      }
    }

    if (method === 'GET' && (path === '/paperwork' || path === '/paperwork/weeks')) {
      const weekParam = event.queryStringParameters?.week ?? ''
      const weekStart = weekParam ? weekStartOfISO(weekParam) : weekStartOfISO(new Date().toISOString().slice(0, 10))

      // Scanned on the delivery window, then narrowed in code: a driver's assignment lives
      // inside the stops array, which a DynamoDB filter cannot reach into.
      const windowStart = path === '/paperwork/weeks' ? PAPERWORK_HISTORY_START : weekStart
      /*
       * Never past today. A driver cannot have paperwork for a load they have not
       * delivered, so asking for it is noise — and on the week list it would count loads
       * against them that are not yet theirs to answer for.
       */
      const windowEndEx = path === '/paperwork/weeks'
        ? deliveredWindowEnd(weekStartOfISO(new Date().toISOString().slice(0, 10)), new Date())
        : deliveredWindowEnd(weekStart, new Date())

      /*
       * The week view also takes a load by its PICKUP: a run that loads today and delivers
       * tomorrow is today's work — its pickup is on the day sheet and may sit in
       * detention — even though its delivery is still ahead. The history list stays on
       * deliveries, which is what a past week is made of.
       */
      const byDelivery = await scan<PaperworkLoadLike>(
        LOAD_TABLE_NAME,
        'deliveryAppt >= :start AND deliveryAppt < :endEx',
        {},
        { ':start': windowStart, ':endEx': windowEndEx },
      )
      const byPickup = path === '/paperwork/weeks'
        ? []
        : await scan<PaperworkLoadLike>(
            LOAD_TABLE_NAME,
            'pickupAppt >= :start AND pickupAppt < :endEx',
            {},
            { ':start': windowStart, ':endEx': windowEndEx },
          )
      const seen = new Set<string>()
      const candidates = [...byDelivery, ...byPickup].filter((l) => !seen.has(l.id) && seen.add(l.id))
      const mine = candidates.filter((l) => driverIsOnPaperworkLoad(l, driverId))

      // POD pages and recorded times for exactly these loads.
      const [docs, subs, times] = await Promise.all([
        scan<PodDocRow & { submissionId?: string | null }>(DRIVER_SUBMISSION_DOC_TABLE, 'driverId = :did', {}, { ':did': driverId }),
        scan<{ id: string; loadId?: string | null; referenceNumber?: string | null }>(DRIVER_SUBMISSION_TABLE, 'driverId = :did', {}, { ':did': driverId }),
        DRIVER_LOAD_TIME_TABLE
          ? scan<LoadTimeRow>(DRIVER_LOAD_TIME_TABLE, 'driverId = :did', {}, { ':did': driverId })
          : Promise.resolve([] as LoadTimeRow[]),
      ])

      // A doc knows its submission; the submission knows the load. Join once.
      const subById = new Map(subs.map((x) => [x.id, x]))
      function docsForLoad(load: PaperworkLoadLike): PodDocRow[] {
        const pro = normalizePro(referenceOf(load))
        return docs.filter((d) => {
          const sub = d.submissionId ? subById.get(d.submissionId) : undefined
          if (!sub) return false
          if (sub.loadId && sub.loadId === load.id) return true
          return !!pro && normalizePro(sub.referenceNumber ?? '') === pro
        })
      }

      const built = mine
        .map((l) => buildPaperworkLoad(l, docsForLoad(l), times.filter((t) => t.loadId === l.id), driverId))
        .sort((a, b) => String(a.deliveryAppt ?? '').localeCompare(String(b.deliveryAppt ?? '')))

      /*
       * A stop booked from the directory often carries only the facility name; the street
       * lives on the Location record. The driver needs the street, so fill it from there.
       */
      if (path === '/paperwork' && LOCATION_TABLE_NAME) {
        type LocRow = { street?: string | null; city?: string | null; state?: string | null; zip?: string | null; hours?: string | null; dockNotes?: string | null; notes?: string | null; driverNotes?: unknown }
        const cache = new Map<string, LocRow | null>()
        for (const l of built) {
          const raw = mine.find((x) => x.id === l.id)
          const rawStops = raw ? (getStops(raw as unknown as Load) as Stop[]) : []
          for (const st of l.stops) {
            const locationId = rawStops.find((s) => s.id === st.id)?.locationId
            if (!locationId) continue
            if (!cache.has(locationId)) {
              try {
                cache.set(locationId, ((await ddb.send(new GetCommand({ TableName: LOCATION_TABLE_NAME, Key: { id: locationId } }))).Item ?? null) as LocRow | null)
              } catch { cache.set(locationId, null) }
            }
            const loc = cache.get(locationId)
            if (!loc) continue
            if (!st.street) {
              st.street = loc.street?.trim() || null
              st.city = st.city ?? (loc.city?.trim() || null)
              st.state = st.state ?? (loc.state?.trim() || null)
              st.zip = st.zip ?? (loc.zip?.trim() || null)
            }
            // Hours, dock notes and what other drivers said — the reason the place is on file.
            const rawNotes = typeof loc.driverNotes === 'string' ? JSON.parse(loc.driverNotes) : loc.driverNotes
            st.location = {
              id: locationId,
              hours: loc.hours?.trim() || null,
              dockNotes: loc.dockNotes?.trim() || null,
              notes: loc.notes?.trim() || null,
              driverNotes: Array.isArray(rawNotes)
                ? (rawNotes as Array<{ at?: string; by?: string; text?: string }>)
                    .filter((n) => n && typeof n.text === 'string')
                    .map((n) => ({ at: String(n.at ?? ''), by: String(n.by ?? ''), text: String(n.text) }))
                : [],
            }
          }
        }
      }

      /*
       * A Motive-based ETA is re-run from the truck's latest fix on every read, so the
       * number the driver (and dispatch) sees tracks the truck rather than the moment the
       * pickup was departed. Only while rolling: once arrived, the ETA is history.
       */
      if (path === '/paperwork') {
        const fix = await truckFixForDriver(driver)
        if (fix) {
          for (const l of built) {
            for (const st of l.stops) {
              if (st.etaBasis !== 'motive' || st.arrivedAt || st.departedAt || !st.yours) continue
              const raw = mine.find((x) => x.id === l.id)
              const dest = raw ? await stopCoords((getStops(raw as unknown as Load) as Stop[]).find((s) => s.id === st.id)) : null
              if (dest) st.etaAt = estimateEta(fix, dest, nowIso())
            }
          }
        }
      }

      if (path === '/paperwork/weeks') {
        // One row per week that has work in it, plus the week in progress, newest first.
        const byWeek = new Map<string, typeof built>()
        for (const l of built) {
          const wk = weekStartOfISO(String(l.deliveryAppt ?? '').slice(0, 10))
          if (!wk) continue
          byWeek.set(wk, [...(byWeek.get(wk) ?? []), l])
        }
        const current = weekStartOfISO(new Date().toISOString().slice(0, 10))
        if (!byWeek.has(current)) byWeek.set(current, [])
        const weeks = [...byWeek.entries()]
          .map(([wk, loads]) => ({ weekStart: wk, ...summarize(loads) }))
          .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
        return reply(200, { weeks })
      }

      // The POD counts are owed only on loads that have delivered; a load taken by its
      // pickup today still has its delivery ahead and cannot be missing a POD yet.
      const delivered = built.filter((l) => String(l.deliveryAppt ?? '').slice(0, 10) < windowEndEx)
      return reply(200, {
        weekStart,
        // Chicago, like the appointments: a driver at 11pm is still on today's sheet.
        today: chicagoDateStr(new Date()),
        loads: built,
        ...summarize(delivered),
        loadCount: built.length,
      })
    }

    /*
     * The driver reports a facility event — on site, or departed — at one of their stops.
     * Stamped on the load's stop itself, which is what the loads board derives the
     * lifecycle from, so dispatch sees the load move the moment the driver taps.
     */
    if (method === 'POST' && path === '/paperwork/stop-event') {
      const body = JSON.parse(event.body || '{}') as { loadId?: string; stopId?: string; event?: string }
      const loadId = (body.loadId ?? '').trim()
      const stopId = (body.stopId ?? '').trim()
      const ev = (body.event ?? '').trim().toUpperCase()
      if (!loadId) return reply(400, { error: 'loadId is required' })
      if (!stopId) return reply(400, { error: 'stopId is required' })
      if (ev !== 'ARRIVED' && ev !== 'DEPARTED') return reply(400, { error: 'event must be ARRIVED or DEPARTED' })

      const found = await ddb.send(new GetCommand({ TableName: LOAD_TABLE_NAME, Key: { id: loadId } }))
      const load = found.Item as (PaperworkLoadLike & { updatedAt?: string }) | undefined
      if (!load || !driverIsOnPaperworkLoad(load, driverId)) {
        return reply(404, { error: 'load not found' })
      }
      const stops = getStops(load as unknown as Load) as Stop[]
      const stop = stops.find((s) => s.id === stopId)
      if (!stop) return reply(404, { error: 'stop not found on this load' })

      const now = nowIso()
      let next = applyStopEvent(stops, stopId, ev as StopEvent, now)
      let eta: { stopId: string; etaAt: string; basis: 'motive' | 'appt' } | null = null

      // Leaving the pickup is when the delivery ETA becomes worth stating.
      if (ev === 'DEPARTED' && stop.type === 'pickup') {
        const plan = planDeliveryEta(load as unknown as Load, next, stop, driverId, now)
        if (plan.kind === 'motive') {
          const [fix, dest] = await Promise.all([truckFixForDriver(driver), stopCoords(plan.stop)])
          // No fix or no coordinates: fall back to the appointment rather than say nothing.
          const etaAt = fix && dest ? estimateEta(fix, dest, now) : plan.stop.appt
          if (etaAt) eta = { stopId: plan.stop.id, etaAt, basis: fix && dest ? 'motive' : 'appt' }
        } else if (plan.kind === 'appt' && plan.stop.appt) {
          eta = { stopId: plan.stop.id, etaAt: plan.stop.appt, basis: 'appt' }
        }
        if (eta) next = withEta(next, eta.stopId, eta.etaAt, eta.basis, now)
      }

      // Only `stops` and the audit fields change; the condition keeps a concurrent staff
      // edit from being overwritten with a stale copy.
      await ddb.send(new UpdateCommand({
        TableName: LOAD_TABLE_NAME,
        Key: { id: loadId },
        UpdateExpression: 'SET stops = :stops, updatedAt = :now, updatedBy = :by',
        ConditionExpression: load.updatedAt ? 'updatedAt = :prev' : 'attribute_not_exists(updatedAt)',
        ExpressionAttributeValues: {
          ':stops': next, ':now': now, ':by': driver.email ?? driverId,
          ...(load.updatedAt ? { ':prev': load.updatedAt } : {}),
        },
      }))
      console.log('[driver-app-api] stop event', { driverId, loadId, stopId, event: ev, eta })
      return reply(200, { ok: true, loadId, stopId, event: ev, at: now, eta })
    }

    /*
     * A driver leaves a note about a place — the gate code, which dock, who to ask for.
     * Appended to the directory record so the next driver sent there reads it, and the
     * office sees it on the location. Only for a stop on a load this driver is on.
     */
    if (method === 'POST' && path === '/paperwork/location-note') {
      if (!LOCATION_TABLE_NAME) return reply(503, { error: 'The directory is not configured' })
      const body = JSON.parse(event.body || '{}') as { loadId?: string; locationId?: string; text?: string }
      const loadId = (body.loadId ?? '').trim()
      const locationId = (body.locationId ?? '').trim()
      const text = (body.text ?? '').trim().slice(0, 1000)
      if (!loadId) return reply(400, { error: 'loadId is required' })
      if (!locationId) return reply(400, { error: 'locationId is required' })
      if (!text) return reply(400, { error: 'say something first' })
      const found = await ddb.send(new GetCommand({ TableName: LOAD_TABLE_NAME, Key: { id: loadId } }))
      const load = found.Item as PaperworkLoadLike | undefined
      if (!load || !driverIsOnPaperworkLoad(load, driverId)) return reply(404, { error: 'load not found' })
      if (!(getStops(load as unknown as Load) as Stop[]).some((s) => s.locationId === locationId)) {
        return reply(404, { error: 'that place is not a stop on this load' })
      }
      const note = { at: nowIso(), driverId, by: driver.name, text }
      await ddb.send(new UpdateCommand({
        TableName: LOCATION_TABLE_NAME,
        Key: { id: locationId },
        UpdateExpression: 'SET driverNotes = list_append(if_not_exists(driverNotes, :empty), :note), updatedAt = :u',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':empty': [], ':note': [note], ':u': nowIso() },
      }))
      console.log('[driver-app-api] location note', { driverId, locationId, loadId })
      return reply(200, { ok: true, note: { at: note.at, by: note.by, text: note.text } })
    }

    /* The driver flags (or clears) detention at one stop. */
    if (method === 'POST' && path === '/paperwork/detention') {
      if (!DRIVER_LOAD_TIME_TABLE) return reply(503, { error: 'Detention flags are not configured' })
      const body = JSON.parse(event.body || '{}') as { loadId?: string; stopId?: string; detention?: unknown }
      const loadId = (body.loadId ?? '').trim()
      const stopId = (body.stopId ?? '').trim()
      if (!loadId) return reply(400, { error: 'loadId is required' })
      if (!stopId) return reply(400, { error: 'stopId is required' })
      if (typeof body.detention !== 'boolean') return reply(400, { error: 'detention must be true or false' })

      /*
       * A driver may only flag a stop on a load they are actually on. Without this check
       * the loadId is caller-supplied and anyone's flag could be written onto anyone's load.
       */
      const found = await ddb.send(new GetCommand({ TableName: LOAD_TABLE_NAME, Key: { id: loadId } }))
      const load = found.Item as PaperworkLoadLike | undefined
      if (!load || !driverIsOnPaperworkLoad(load, driverId)) {
        return reply(404, { error: 'load not found' })
      }
      const stop = (getStops(load as unknown as Load) as Stop[]).find((s) => s.id === stopId)
      if (!stop) return reply(404, { error: 'stop not found on this load' })

      const id = `${driverId}#${loadId}#${stopId}`
      const now = nowIso()
      const existing = await ddb.send(new GetCommand({ TableName: DRIVER_LOAD_TIME_TABLE, Key: { id } }))
      await ddb.send(new PutCommand({
        TableName: DRIVER_LOAD_TIME_TABLE,
        Item: {
          id, loadId, driverId, stopId,
          leg: String(stop.type ?? '').toUpperCase(),
          detention: body.detention,
          createdAt: (existing.Item?.createdAt as string | undefined) ?? now,
          updatedAt: now,
          updatedBy: driver.email ?? driverId,
        },
      }))
      return reply(200, { ok: true, loadId, stopId, detention: body.detention })
    }

    /*
     * A driver on the paperwork program has no settlement, and must not be shown one.
     * Refused outright rather than computed: their synthesised pay setting carries 0%, and
     * a settlement built from it would render as a real $0.00 check.
     */
    if (driverProgramOf({ ...driver, payGroup: setting.payGroup }) === 'PAPERWORK'
        && (path === '/settlement' || path === '/settlement/weeks')) {
      return reply(409, { error: 'This driver has paperwork, not a settlement. Use /paperwork.' })
    }

    if (method === 'GET' && path === '/settlement/weeks') {
      const ownerOnly = setting.payGroup === 'OWNER_OPERATOR'
      const [amazonTrips, brokerageTrips, deductions, adjustments, fuel] = await Promise.all([
        ownerOnly ? Promise.resolve([] as RawAmazonTrip[])
          : scan<RawAmazonTrip>(AMAZON_TRIP_TABLE, 'driverId = :did', {}, { ':did': driverId }),
        loadOwnerOperatorRawTrips(driverId),
        scan<RawDeduction & { periodStart: string }>(PAY_DEDUCTION_TABLE, 'driverId = :did', {}, { ':did': driverId }),
        scan<RawCredit & { periodStart: string }>(PAY_CREDIT_TABLE, 'driverId = :did', {}, { ':did': driverId }),
        scan<RawFuelTransaction>(FUEL_TX_TABLE),
      ])
      // One week can carry both Relay trips and brokerage deliveries from Sep 27, and the
      // driver is owed every line of it — the office splits them across two statements
      // whose sum is this one check, because the weekly charges are counted once. Before
      // that date brokerage loads were not settled to the driver at all.
      const trips = [...amazonTrips, ...brokerageTrips.filter((t) => ownerOpCarriesWeeklyCharges(t.periodStart))]
      const weeks = listWeekStarts(trips, new Date(), ownerOnly || trips.length === 0 ? OWNER_OP_FIRST_PERIOD : undefined)
      // Which weeks the picker offers, and from how many trips. A driver who says "this
      // week is missing" is usually looking at the newest week this list returned.
      console.log('[driver-app-api] settlement weeks', {
        driverId,
        payGroup: setting.payGroup ?? null,
        amazonTrips: amazonTrips.length,
        brokerageTrips: brokerageTrips.length,
        newestWeek: weeks[0] ?? null,
        weekCount: weeks.length,
      })
      const out: { weekStart: string; gross: number; net: number; tripCount: number }[] = []
      // The week in progress is always offered, even with nothing in it yet, so the
      // app can open on it instead of on the last week that happened to have trips.
      const currentWeekStart = weekStartOfISO(new Date().toISOString().slice(0, 10))
      for (const start of weeks) {
        const weekTrips = trips.filter((t) => t.periodStart === start)
        if (start !== currentWeekStart && !weekTrips.length && !ownerOpCarriesWeeklyCharges(start)) continue
        const mine = adjustments.filter((c) => c.periodStart === start)
        const settlement = buildSettlement(start, weekTrips, setting,
          deductions.filter((d) => d.periodStart === start),
          mine.filter((c) => (c.kind ?? 'CREDIT') !== 'DEBIT'),
          mine.filter((c) => c.kind === 'DEBIT'), fuel)
        out.push({
          weekStart: start,
          gross: settlement.grossPay,
          net: settlement.checkAmount,
          tripCount: settlement.trips.length,
        })
      }
      return reply(200, { weeks: out })
    }

    if (method === 'GET' && path === '/settlement') {
      const rawWeek = event.queryStringParameters?.week ?? ''
      if (!rawWeek) return reply(400, { error: 'week required' })
      const weekStart = weekStartOfISO(rawWeek)
      const ownerOp = ownerOpCarriesWeeklyCharges(weekStart)
      if (setting.payGroup === 'OWNER_OPERATOR' && !ownerOp) {
        return reply(400, { error: 'week before owner-operator start' })
      }
      const [amazonWeekTrips, brokerageWeekTrips] = await Promise.all([
        setting.payGroup === 'OWNER_OPERATOR'
          ? Promise.resolve([] as RawAmazonTrip[])
          : scan<RawAmazonTrip>(
              AMAZON_TRIP_TABLE,
              'driverId = :did AND periodStart = :week',
              {},
              { ':did': driverId, ':week': weekStart },
            ),
        ownerOp ? loadOwnerOperatorTripsForWeek(driverId, weekStart) : Promise.resolve([] as RawAmazonTrip[]),
      ])
      const trips = await attachFactoringFields([...amazonWeekTrips, ...brokerageWeekTrips], driverId)
      /*
       * Logged on every settlement read, not only on failure.
       *
       * "My week is empty" was undiagnosable: a response with no trips is a success, so
       * nothing reached CloudWatch and there was no way to tell a driver looking at the
       * wrong week from a query that found nothing. These four counts separate those.
       */
      console.log('[driver-app-api] settlement', {
        driverId,
        weekStart,
        payGroup: setting.payGroup ?? null,
        ownerOpWeek: ownerOp,
        amazonTrips: amazonWeekTrips.length,
        brokerageTrips: brokerageWeekTrips.length,
      })
      return reply(200, await buildSettlementForDriver(driverId, weekStart, trips, setting))
    }

    if (method === 'GET' && path === '/submissions') {
      const submissions = await scan<DriverSubmissionRow>(
        DRIVER_SUBMISSION_TABLE,
        'driverId = :did',
        {},
        { ':did': driverId },
      )
      const docs = await scan<DriverSubmissionDocRow>(
        DRIVER_SUBMISSION_DOC_TABLE,
        'driverId = :did',
        {},
        { ':did': driverId },
      )
      const docsBySubmission = groupBy(docs, (d) => d.submissionId)
      const summaries = submissions
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((s) => ({
          id: s.id,
          status: s.status,
          referenceNumber: s.referenceNumber ?? null,
          note: s.note ?? null,
          loadId: s.loadId ?? null,
          stopId: s.stopId ?? null,
          stopLabel: s.stopLabel ?? null,
          createdAt: s.createdAt,
          notifiedAt: s.notifiedAt ?? null,
          docs:
            (docsBySubmission.get(s.id) ?? []).map((d) => ({
              id: d.id,
              kind: d.kind,
              fileName: d.fileName ?? '',
              contentType: d.contentType ?? '',
              pageNumber: d.pageNumber,
              uploadedAt: d.uploadedAt,
              /* Whether the cleaned copy exists, so the app can say which one it is
                 showing rather than leaving a driver to wonder why their photo looks
                 different from the one they took. */
              enhanced: d.scanStatus === 'READY' && !!d.enhancedKey,
              scanStatus: d.scanStatus ?? null,
            })),
          /*
           * The finished single PDF per kind. This is what a driver should preview and
           * what the office sends on; the loose pages behind it only matter while the
           * merge has not run yet.
           */
          documents: (['POD', 'RATECON'] as const)
            .map((kind) => {
              const key = kind === 'POD' ? s.combinedPodKey : s.combinedRateconKey
              const pages = (docsBySubmission.get(s.id) ?? []).filter((d) => d.kind === kind)
              if (!key && pages.length === 0) return null
              return {
                kind: kind as DocKind,
                /* `combined-POD` addresses the merged PDF in the doc-url route; a loose
                   page falls back to its own id until the merge produces one. */
                docId: key ? `combined-${kind}` : pages[0].id,
                pageCount: pages.length || 1,
                enhanced: pages.some((d) => d.scanStatus === 'READY' && !!d.enhancedKey),
                contentType: key ? 'application/pdf' : (pages[0].contentType ?? ''),
                combined: !!key,
              }
            })
            .filter((d): d is NonNullable<typeof d> => d !== null)
            // Misc photos are never merged: each one is its own document.
            .concat(
              (docsBySubmission.get(s.id) ?? [])
                .filter((d) => d.kind === 'MISC')
                .sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))
                .map((d) => ({ kind: 'MISC' as const, docId: d.id, pageCount: 1, enhanced: false, contentType: d.contentType ?? '', combined: false })),
            ),
        }))
      return reply(200, { submissions: summaries })
    }

    if (method === 'GET' && path === '/submissions/:id/uploads' && id) {
      const kind = event.queryStringParameters?.kind ?? ''
      if (!isDocKind(kind)) {
        return reply(400, { error: "kind must be 'RATECON', 'POD' or 'MISC'" })
      }
      const submission = await getOwnedSubmission(id, driverId)
      const pages = submission.pendingUploads?.[kind] ?? []
      return reply(200, { uploads: await resignPendingUploads(pages) })
    }

    if (method === 'POST' && path === '/submissions') {
      const body = parseBody(event)
      const kind = getString(body, 'kind') ?? 'RATECON'
      if (!isDocKind(kind)) {
        return reply(400, { error: "kind must be 'RATECON', 'POD' or 'MISC'" })
      }
      const validation = validatePages(assertArrayField(body, 'pages'))
      if (!validation.ok) return reply(400, { error: validation.error })
      const pages = validation.pages
      const now = nowIso()
      const referenceNumber = getStringOrNull(body, 'referenceNumber')

      /*
       * More pages for a shipment this driver has already sent a POD for go ONTO that
       * submission. Two submissions for one PRO means the office gets two half-PODs and
       * the app shows whichever it finds first.
       */
      if (kind === 'POD') {
        const existing = await openPodSubmissionFor(driverId, referenceNumber)
        if (existing) {
          const more = await presignedPutTargets(driverId, existing.id, 'POD', pages)
          await appendPendingUploads(existing.id, 'POD', more.pagesWithKeys)
          return reply(200, { submissionId: existing.id, uploads: more.targets })
        }
      }

      const submissionId = randomUUID()
      const { targets, pagesWithKeys } = await presignedPutTargets(driverId, submissionId, kind, pages)

      // Attach it to the load now, from the PRO the driver typed. See resolveLoadIdByPro.
      const resolvedLoadId = await resolveLoadIdByPro(referenceNumber)

      await ddb.send(
        new PutCommand({
          TableName: DRIVER_SUBMISSION_TABLE,
          Item: {
            id: submissionId,
            __typename: 'DriverSubmission',
            driverId,
            driverName: driver.name,
            status: resolvedLoadId ? 'LINKED' : 'NEW',
            referenceNumber,
            ...(resolvedLoadId ? { loadId: resolvedLoadId } : {}),
            note: getStringOrNull(body, 'note'),
            // Where a MISC submission was taken, so the office sees "Pickup — Batory Oakley".
            ...(kind === 'MISC' ? { stopId: getStringOrNull(body, 'stopId'), stopLabel: getStringOrNull(body, 'stopLabel') } : {}),
            createdAt: now,
            updatedAt: now,
            pendingUploads: { [kind]: pagesWithKeys } satisfies PendingUploads,
          },
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      )

      return reply(200, { submissionId, uploads: targets })
    }

    if (method === 'POST' && path === '/submissions/:id/pod' && id) {
      const body = parseBody(event)
      const validation = validatePages(assertArrayField(body, 'pages'))
      if (!validation.ok) return reply(400, { error: validation.error })
      await getOwnedSubmission(id, driverId)
      const { targets, pagesWithKeys } = await presignedPutTargets(driverId, id, 'POD', validation.pages)
      await appendPendingUploads(id, 'POD', pagesWithKeys)
      return reply(200, { uploads: targets })
    }

    if (method === 'POST' && path === '/submissions/:id/complete' && id) {
      const body = parseBody(event)
      const kind = getString(body, 'kind') ?? ''
      if (!isDocKind(kind)) {
        return reply(400, { error: "kind must be 'RATECON', 'POD' or 'MISC'" })
      }
      const result = await completeSubmission(driverId, id, kind)
      return reply(200, result.error ? { ok: true, error: result.error } : { ok: true })
    }

    /*
     * Open a document.
     *
     * `docId` may be `combined-POD` / `combined-RATECON`, meaning the merged PDF rather
     * than one page of it. For a real page the CLEANED copy is served where the scan
     * pipeline produced one: that is the version the office and the broker see, and a
     * driver checking their own upload should be looking at the same thing they are.
     */
    if (method === 'GET' && path === '/submissions/:id/doc/:docId/url' && id && docId) {
      let key: string
      if (docId === 'combined-POD' || docId === 'combined-RATECON') {
        const submission = await getOwnedSubmission(id, driverId)
        const combined =
          docId === 'combined-POD' ? submission.combinedPodKey : submission.combinedRateconKey
        if (!combined) throw new ApiError(404, 'Document not found')
        key = combined
      } else {
        const doc = await getOwnedDoc(id, docId, driverId)
        key = doc.scanStatus === 'READY' && doc.enhancedKey ? doc.enhancedKey : doc.s3Key
      }
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: DOC_GET_EXPIRY },
      )
      return reply(200, { url })
    }

    /*
     * Take a document off a submission so the driver can send the right one.
     *
     * Only the DynamoDB rows go; the S3 objects stay. A POD decides whether a load is
     * paid and whether an invoice can be factored, so "I sent the wrong page" must be
     * fixable by the person who sent it — and must still be recoverable by the office
     * if it turns out the right page was the one removed.
     */
    if (method === 'DELETE' && path === '/submissions/:id/docs' && id) {
      const kind = event.queryStringParameters?.kind ?? ''
      if (!isDocKind(kind)) {
        return reply(400, { error: "kind must be 'RATECON', 'POD' or 'MISC'" })
      }
      await getOwnedSubmission(id, driverId)
      const docs = await scan<DriverSubmissionDocRow>(
        DRIVER_SUBMISSION_DOC_TABLE,
        'submissionId = :sid AND driverId = :did',
        {},
        { ':sid': id, ':did': driverId },
      )
      const doomed = docs.filter((d) => d.kind === kind)
      for (const doc of doomed) {
        await ddb.send(
          new DeleteCommand({ TableName: DRIVER_SUBMISSION_DOC_TABLE, Key: { id: doc.id } }),
        )
      }
      // The merged PDF has nothing behind it now; leaving the pointer set would keep the
      // document "present" to every readiness check in the system. (Misc photos have none.)
      if (kind !== 'MISC') {
        await ddb.send(
          new UpdateCommand({
            TableName: DRIVER_SUBMISSION_TABLE,
            Key: { id },
            UpdateExpression: 'REMOVE #k SET #u = :u',
            ExpressionAttributeNames: {
              '#k': kind === 'POD' ? 'combinedPodKey' : 'combinedRateconKey',
              '#u': 'updatedAt',
            },
            ExpressionAttributeValues: { ':u': nowIso() },
          }),
        )
      }
      return reply(200, { removed: doomed.length })
    }

    /**
     * The load this driver is working now, with the journey status and the
     * documents still owed. Returns `load: null` when they have nothing open —
     * a rest state in the PWA, not an error.
     */
    if (method === 'GET' && path === '/loads/current') {
      const loads = await scan<Record<string, unknown>>(LOAD_TABLE_NAME)
      const current = currentLoadForDriver(loads as unknown as Load[], driverId, Date.now())
      if (!current) return reply(200, { load: null })

      const pods = await scan<{ loadId?: string }>(
        POD_DOCUMENT_TABLE_NAME,
        'loadId = :l',
        {},
        { ':l': current.id },
      )
      return reply(200, {
        load: {
          id: current.id,
          proNumber: (current.aljexId ?? '').trim(),
          lane: laneLabel(current),
          originCity: current.originCity ?? null,
          destinationCity: current.destinationCity ?? null,
          pickupAppt: current.pickupAppt ?? null,
          deliveryAppt: current.deliveryAppt ?? null,
          customer: current.customer ?? null,
          // What still blocks invoicing, so a driver sees why a load is held.
          hasRateConfirmation: Boolean((current.rateConfirmKey ?? '').trim()),
          hasPod: pods.length > 0,
        },
      })
    }

    /**
     * The driver's recent loads, for attaching a POD that was sent without a load
     * number. Wider than /loads/current on purpose: a POD photographed at a dock on
     * Friday may only get attached on Monday, so last week's loads must be findable.
     */
    if (method === 'GET' && path === '/loads/recent') {
      const loads = await scan<Record<string, unknown>>(LOAD_TABLE_NAME)
      const mine = recentLoadsForDriver(loads as unknown as Load[], driverId, Date.now())
      return reply(200, {
        loads: mine.slice(0, 50).map((l) => ({
          id: l.id,
          proNumber: (l.aljexId ?? '').trim(),
          lane: laneLabel(l),
          customer: l.customer ?? null,
          deliveryAppt: lastApptAt(l) || null,
        })),
      })
    }

    /**
     * Attach a POD the driver already sent to one of their loads.
     *
     * A driver often has the signed paperwork before the office has built the load, so
     * the POD goes in unattached and is matched afterwards. Setting `loadId` is what
     * makes it count against the load — and therefore what releases the load's pay.
     *
     * Both halves are checked against this driver: their own submission, their own
     * load. A load that is not theirs is a 404 with no payload, same as everywhere else
     * here, so nothing about another driver's work is discoverable.
     */
    if (method === 'POST' && path === '/submissions/:id/attach' && id) {
      const body = parseBody(event)
      const loadId = (getString(body, 'loadId') ?? '').trim()
      if (!loadId) return reply(400, { error: 'loadId required' })

      const submission = await getItem<DriverSubmissionRow>(DRIVER_SUBMISSION_TABLE, { id })
      if (!submission || !isDriverOwner(submission, driverId)) {
        return reply(404, { error: 'Not found' })
      }

      const row = await getItem<Record<string, unknown>>(LOAD_TABLE_NAME, { id: loadId })
      if (!row || !driverIsOnLoad(row as unknown as Load, driverId)) {
        return reply(404, { error: 'Not found' })
      }

      const now = nowIso()
      await ddb.send(
        new UpdateCommand({
          TableName: DRIVER_SUBMISSION_TABLE,
          Key: { id },
          UpdateExpression: 'SET loadId = :l, #st = :s, updatedAt = :t',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':l': loadId, ':s': 'LINKED', ':t': now },
        }),
      )

      return reply(200, {
        submissionId: id,
        loadId,
        proNumber: ((row.aljexId as string | undefined) ?? '').trim(),
      })
    }

    return reply(404, { error: 'Not found' })
  } catch (err) {
    if (err instanceof ApiError) {
      // Every refusal, with the path. 4xx used to leave no trace at all, which made a
      // driver's "Retry" screen impossible to diagnose from here.
      console.warn('[driver-app-api] refused', { status: err.status, path: event.rawPath ?? '', error: err.message })
      return reply(err.status, { error: err.message })
    }
    console.error('[driver-app-api] unhandled error', err)
    return reply(500, { error: 'Internal error' })
  }
}

async function buildSettlementForDriver(
  driverId: string,
  periodStart: string,
  trips: RawAmazonTrip[],
  setting: RawDriverPaySetting,
): Promise<Settlement> {
  const [deductions, creditsAndDebits, fuelTxs] = await Promise.all([
    scan<RawDeduction>(PAY_DEDUCTION_TABLE, 'driverId = :did AND periodStart = :week', {}, {
      ':did': driverId,
      ':week': periodStart,
    }),
    scan<RawCredit>(PAY_CREDIT_TABLE, 'driverId = :did AND periodStart = :week', {}, {
      ':did': driverId,
      ':week': periodStart,
    }),
    scan<RawFuelTransaction>(FUEL_TX_TABLE, 'transactionDate BETWEEN :start AND :end', {}, {
      ':start': periodStart,
      ':end': periodEnd(periodStart),
    }),
  ])


  const credits = creditsAndDebits.filter((c) => (c.kind ?? 'CREDIT') !== 'DEBIT')
  const debits = creditsAndDebits.filter((c) => c.kind === 'DEBIT')

  return buildSettlement(periodStart, trips, setting, deductions, credits, debits, fuelTxs)
}
