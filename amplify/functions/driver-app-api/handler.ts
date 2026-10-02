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
} from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
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
import { buildPodIndex, loadHasPod, type PodIndex } from '../../../src/lib/podPresence'
import {
  currentLoadForDriver,
  driverIsOnLoad,
  laneLabel,
  lastApptAt,
  recentLoadsForDriver,
} from '../../../src/lib/driverJourney'
import type { Load } from '../../../src/types'
import { isEligiblePayGroup } from './scope'
import {
  OWNER_OP_FIRST_PERIOD,
  ownerOpTripsFor,
  ownerOpCarriesWeeklyCharges,
  type OwnerOpLoadLike,
  type OwnerOpTrip,
} from '../../../src/lib/ownerOperatorTrips'
import { notifyRateconSubmitted, notifyPodAdded, RATECON_SUBJECT_PREFIX, type SubmissionNotice, type ThreadRefs } from './notify'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const DRIVER_SUBMISSION_TABLE = process.env.DRIVER_SUBMISSION_TABLE_NAME!
const DRIVER_SUBMISSION_DOC_TABLE = process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME!
/** pod-actions runs the scan cleanup. Absent in stacks where PODs are not wired. */
const POD_FUNCTION_NAME = process.env.POD_FUNCTION_NAME ?? ''
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME!
const DRIVER_PAY_SETTING_TABLE = process.env.DRIVER_PAY_SETTING_TABLE_NAME!
const AMAZON_TRIP_TABLE = process.env.AMAZON_TRIP_TABLE_NAME!
const LOAD_TABLE_NAME = process.env.LOAD_TABLE_NAME!
const CUSTOMER_TABLE_NAME = process.env.CUSTOMER_TABLE_NAME ?? ''
const LOCATION_TABLE_NAME = process.env.LOCATION_TABLE_NAME ?? ''
const POD_DOCUMENT_TABLE_NAME = process.env.POD_DOCUMENT_TABLE_NAME ?? ''
const PAY_DEDUCTION_TABLE = process.env.DRIVER_PAY_DEDUCTION_TABLE_NAME!
const PAY_CREDIT_TABLE = process.env.DRIVER_PAY_CREDIT_TABLE_NAME!
const FUEL_TX_TABLE = process.env.FUEL_TRANSACTION_TABLE_NAME!
const BUCKET = process.env.BUCKET_NAME!
const DRIVER_USER_POOL_ID = process.env.DRIVER_USER_POOL_ID!
const DRIVER_USER_POOL_CLIENT_ID = process.env.DRIVER_USER_POOL_CLIENT_ID!

const verifier = CognitoJwtVerifier.create({
  userPoolId: DRIVER_USER_POOL_ID,
  tokenUse: 'id',
  clientId: DRIVER_USER_POOL_CLIENT_ID,
})

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const MAX_PAGES = 12
const ACCEPTED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
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
  fixedExpenses?: unknown
  rateHistory?: unknown
}

interface DriverSubmissionRow {
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
}

interface PendingPage {
  fileName: string
  contentType: string
  byteSize: number
  s3Key: string
}

interface PendingUploads {
  RATECON?: PendingPage[]
  POD?: PendingPage[]
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
  if (!setting) return null

  return { driver, setting }
}

async function loadVerifiedDriver(event: FnUrlEvent): Promise<{ driver: DriverRow; setting: DriverPaySettingRow }> {
  const token = extractBearer(event.headers)
  if (!token) throw new ApiError(401, 'Missing authorization')
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
  if (!resolved) throw new ApiError(401, 'Driver not found')
  return resolved
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
function dayAfterPeriod(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 7)
  return d.toISOString().slice(0, 10)
}

async function loadOwnerOperatorTripsForWeek(
  driverId: string,
  periodStart: string,
): Promise<RawAmazonTrip[]> {
  // `deliveryAppt` stores a full ISO timestamp while the period end is a bare date, so
  // an inclusive BETWEEN drops every load delivered ON the final Saturday
  // ('2026-10-03T05:00:00.000Z' sorts after '2026-10-03'). Compare against the start of
  // the next day instead, so the driver app and the staff page agree on the last day.
  const loads = await scan<OwnerOpLoadLike>(
    LOAD_TABLE_NAME,
    'deliveryDriverId = :did AND deliveryAppt >= :start AND deliveryAppt < :endEx',
    {},
    { ':did': driverId, ':start': periodStart, ':endEx': dayAfterPeriod(periodStart) },
  )
  return ownerOpTripsFor(loads, driverId, periodStart).map((t) => ownerOpTripToRaw(t, periodStart))
}

async function loadOwnerOperatorRawTrips(driverId: string): Promise<RawAmazonTrip[]> {
  const loads = await scan<OwnerOpLoadLike>(LOAD_TABLE_NAME, 'deliveryDriverId = :did', {}, { ':did': driverId })
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
  if (segments[0] === 'settlement' && segments[1] === 'weeks') {
    return { path: '/settlement/weeks' }
  }
  if (segments[0] === 'loads' && segments[1] === 'current') {
    return { path: '/loads/current' }
  }
  if (segments[0] === 'loads' && segments[1] === 'recent') {
    return { path: '/loads/recent' }
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
  kind: 'RATECON' | 'POD',
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
    if (!ACCEPTED_CONTENT_TYPES.includes(contentType)) {
      return { ok: false, error: `page ${i + 1} unsupported content type` }
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
  kind: 'RATECON' | 'POD',
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
  kind: 'RATECON' | 'POD',
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
 * API. Invoked as an Event so a driver's upload never waits on it, and every failure is
 * swallowed: the pages are saved and the original is the copy we keep.
 */
async function requestScanCleanup(
  docs: DriverSubmissionDocRow[],
  submissionId: string,
  kind: 'RATECON' | 'POD',
): Promise<void> {
  if (!POD_FUNCTION_NAME || docs.length === 0) return
  const lambda = new LambdaClient({})

  async function call(action: string, input: Record<string, unknown>, sync: boolean): Promise<void> {
    try {
      await lambda.send(
        new InvokeCommand({
          FunctionName: POD_FUNCTION_NAME,
          // Cleaning is fire-and-forget; the merge has to wait for it, so it is awaited.
          InvocationType: sync ? 'RequestResponse' : 'Event',
          Payload: Buffer.from(
            JSON.stringify({
              arguments: { action, input: JSON.stringify(input) },
              // A system call: no human identity to present, and no email to invent.
              identity: { claims: { bcatSystemCaller: true }, username: 'driver-app-api' },
            }),
          ),
        }),
      )
    } catch (err) {
      console.error('[driver-app-api] scan step failed', {
        action,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Clean every page first — the cleanup only works on images — then merge the results into
  // the one PDF everything downstream reads. Merging first is what left every upload
  // reporting ORIGINAL_ONLY.
  await Promise.all(docs.map((doc) => call('enhanceDriverDoc', { id: doc.id }, true)))
  await call('finalizeDriverDocs', { submissionId, kind }, true)
}

async function persistDocs(
  submissionId: string,
  driverId: string,
  kind: 'RATECON' | 'POD',
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
  kind: 'RATECON' | 'POD',
  pages: PendingPage[],
): Promise<{ refs: Partial<ThreadRefs>; errors: string[] }> {
  const attachments: SubmissionNotice['attachments'] = []
  for (const page of pages) {
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
  kind: 'RATECON' | 'POD',
): Promise<{ ok: boolean; error?: string }> {
  const submission = await getOwnedSubmission(submissionId, driverId)
  const pending = submission.pendingUploads ?? {}
  const pages = kind === 'RATECON' ? (pending.RATECON ?? []) : (pending.POD ?? [])

  if (pages.length === 0) {
    // Nothing left to upload for this leg; a previous successful notify may already exist.
    return { ok: true }
  }

  const docs = await persistDocs(submissionId, driverId, kind, pages)
  // Clean up the scan the same way a texted POD is cleaned, then merge the pages into one
  // PDF. Best-effort: the pages are already stored and readable on their own.
  await requestScanCleanup(docs, submissionId, kind)
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

    const { driver, setting } = await loadVerifiedDriver(event)
    const driverId = driver.id

    if (method === 'GET' && path === '/me') {
      return reply(200, {
        driverId: driver.id,
        name: driver.name,
        // Roy and Lee carry '' on the Driver row and their real address on the pay
        // setting, and '' is not nullish — a ?? chain leaves their account screen blank.
        email: driver.email || setting.email || '',
        payGroup: setting.payGroup ?? 'AMAZON',
        active: driver.active !== false,
      })
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
      for (const start of weeks) {
        const weekTrips = trips.filter((t) => t.periodStart === start)
        if (!weekTrips.length && !ownerOpCarriesWeeklyCharges(start)) continue
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
            })),
        }))
      return reply(200, { submissions: summaries })
    }

    if (method === 'GET' && path === '/submissions/:id/uploads' && id) {
      const kind = event.queryStringParameters?.kind ?? ''
      if (kind !== 'RATECON' && kind !== 'POD') {
        return reply(400, { error: "kind must be 'RATECON' or 'POD'" })
      }
      const submission = await getOwnedSubmission(id, driverId)
      const pages = submission.pendingUploads?.[kind] ?? []
      return reply(200, { uploads: await resignPendingUploads(pages) })
    }

    if (method === 'POST' && path === '/submissions') {
      const body = parseBody(event)
      const kind = getString(body, 'kind') ?? 'RATECON'
      if (kind !== 'RATECON' && kind !== 'POD') {
        return reply(400, { error: "kind must be 'RATECON' or 'POD'" })
      }
      const validation = validatePages(assertArrayField(body, 'pages'))
      if (!validation.ok) return reply(400, { error: validation.error })
      const pages = validation.pages
      const now = nowIso()
      const submissionId = randomUUID()
      const { targets, pagesWithKeys } = await presignedPutTargets(driverId, submissionId, kind, pages)

      await ddb.send(
        new PutCommand({
          TableName: DRIVER_SUBMISSION_TABLE,
          Item: {
            id: submissionId,
            __typename: 'DriverSubmission',
            driverId,
            driverName: driver.name,
            status: 'NEW',
            referenceNumber: getStringOrNull(body, 'referenceNumber'),
            note: getStringOrNull(body, 'note'),
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
      if (kind !== 'RATECON' && kind !== 'POD') {
        return reply(400, { error: "kind must be 'RATECON' or 'POD'" })
      }
      const result = await completeSubmission(driverId, id, kind)
      return reply(200, result.error ? { ok: true, error: result.error } : { ok: true })
    }

    if (method === 'GET' && path === '/submissions/:id/doc/:docId/url' && id && docId) {
      const doc = await getOwnedDoc(id, docId, driverId)
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: doc.s3Key }),
        { expiresIn: DOC_GET_EXPIRY },
      )
      return reply(200, { url })
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
