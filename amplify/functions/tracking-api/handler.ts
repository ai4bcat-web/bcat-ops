/**
 * tracking-api — the public pages behind a tracking link. No sign-in anywhere.
 *
 *   GET  /t/<code>          where a truck is right now (the Equipment trackingCode)
 *   GET  /s/<token>         the shipment's Customer Link
 *   GET  /l/<token>         the carrier driver's ping page
 *   POST /l/<token>/ping    one tap of that page
 *   GET  /u/<token>         the carrier's upload portal (Step E)
 *   POST /u/<token>/upload  a presigned PUT for one file
 *   POST /u/<token>/commit  the ShipmentDocument row for a file that landed
 *   GET  /q/<token>         a customer's quote, or a carrier's offer (Step H)
 *   POST /q/<token>/respond the one answer that link is good for
 *
 * For the tokenised links the token **is** the TrackingLink row's primary key —
 * 24 random bytes, base64url — so every lookup is a GetItem on a 192-bit key and no
 * index can be walked from outside. The quote link is the one exception: a quote's
 * id is its number, which staff put in a URL, so the same 24 bytes sit in a sparse
 * `linkToken` index instead and are REMOVEd the moment that round is answered. What
 * each page may say is decided once, in `src/lib/trackingLink.ts`,
 * `src/lib/uploadPortal.ts` and `src/lib/quotes.ts`; this file only fetches and guards.
 *
 * This role cannot write Load. A ping is one LoadCheckCall row plus the link's own
 * counters, and "last known" is read back from those. An upload is one PENDING
 * ShipmentDocument row plus the link's counters. A quote answer is one conditioned
 * UpdateItem on the row whose live token the caller is holding — nothing else.
 */
import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { SSMClient } from '@aws-sdk/client-ssm'
import { currentLoadForDriver, laneLabel } from '../../../src/lib/driverJourney'
import { quotePublicView } from '../../../src/lib/quotes'
import { MAX_UPLOADS_PER_LINK, documentKey, documentPrefix } from '../../../src/lib/shipmentDocuments'
import { pendingDeliveryEta } from '../../../src/lib/stopEvents'
import { carrierView, customerView, isLinkToken } from '../../../src/lib/trackingLink'
import { buildTimeline, lastKnownPosition, thinPositions, trackingWindow, type TrackPosition } from '../../../src/lib/trackingTimeline'
import { carrierUploadView, portalUploadAllowed, uploadLinkUsable } from '../../../src/lib/uploadPortal'
import { liveLinkStatuses, planResponse } from './quotes'
import { shipmentRoute, tokenRoute, webhookRoute, type ApiDeps } from './api'
import type { Load, Stop } from '../../../src/types'
import type {
  Division,
  LoadCarrierRecord,
  LoadCheckCallRecord,
  OrderRecord,
  QuoteEvent,
  QuoteRecord,
  ShipmentDocumentRecord,
  ShipmentLoad,
  ShipmentRecord,
  TmsSettings,
  TrackingLinkKind,
  TrackingLinkRecord,
} from '../../../src/types/tms'

// `removeUndefinedValues` is what `marshallRow` in tms-shipment-actions marshalls
// with, and the two lambdas write the same rows: a field nobody set is left off
// the item rather than refused outright, as a bare document client would.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })
const s3 = new S3Client({})
const ssm = new SSMClient({})
const EQUIPMENT_TABLE = process.env.EQUIPMENT_TABLE_NAME!
const TRUCK_LOCATION_TABLE = process.env.TRUCK_LOCATION_TABLE_NAME!
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME!
const LOAD_TABLE = process.env.LOAD_TABLE_NAME!
// Step D
const TRACKING_LINK_TABLE = process.env.TRACKING_LINK_TABLE_NAME!
const LOAD_CHECK_CALL_TABLE = process.env.LOAD_CHECK_CALL_TABLE_NAME!
const SHIPMENT_TABLE = process.env.SHIPMENT_TABLE_NAME!
const ORDER_TABLE = process.env.ORDER_TABLE_NAME!
const LOAD_CARRIER_TABLE = process.env.LOAD_CARRIER_TABLE_NAME!
const DIVISION_TABLE = process.env.DIVISION_TABLE_NAME!
const TMS_SETTINGS_TABLE = process.env.TMS_SETTINGS_TABLE_NAME!
const TRUCK_LOCATION_HISTORY_TABLE = process.env.TRUCK_LOCATION_HISTORY_TABLE_NAME!
// Step E
const SHIPMENT_DOCUMENT_TABLE = process.env.SHIPMENT_DOCUMENT_TABLE_NAME!
const DOCUMENT_BUCKET = process.env.BUCKET_NAME!
// Step H
const QUOTE_TABLE = process.env.QUOTE_TABLE_NAME!
// Step J — the public API and the inbound webhook receipt (see ./api.ts).
const INTEGRATION_TABLE = process.env.INTEGRATION_TABLE_NAME!
const OPENAPI_PARAM_NAME = process.env.OPENAPI_PARAM_NAME!
const INTEGRATION_PARAM_PATH = process.env.INTEGRATION_PARAM_PATH!

/** Everything the Step J routes are allowed to touch, handed over once. */
const apiDeps: ApiDeps = {
  ddb,
  ssm,
  integrationTable: INTEGRATION_TABLE,
  shipmentTable: SHIPMENT_TABLE,
  loadTable: LOAD_TABLE,
  orderTable: ORDER_TABLE,
  openApiParamName: OPENAPI_PARAM_NAME,
  integrationParamPath: INTEGRATION_PARAM_PATH,
}

const IDX_ORDERS_BY_SHIPMENT = 'ordersByShipmentId'
const IDX_LOADS_BY_SHIPMENT = 'loadsByShipmentId'
const IDX_CARRIERS_BY_SHIPMENT = 'loadCarriersByShipmentId'
const IDX_CHECK_CALLS_BY_SHIPMENT = 'loadCheckCallsByShipmentIdAndAt'
const IDX_CHECK_CALLS_BY_LOAD = 'loadCheckCallsByLoadIdAndAt'
// Amplify pluralises the model for the physical index name: TruckLocationHistory
// → truckLocationHistories…, exactly like ordersByShipmentId above.
const IDX_POSITIONS_BY_TRUCK = 'truckLocationHistoriesByTruckIdAndLocatedAt'
const IDX_DOCUMENTS_BY_SHIPMENT = 'shipmentDocumentsByShipmentIdAndUploadedAt'
// The public link's only door in: the token is not the key, and a Scan from a
// public Lambda is out of the question.
const IDX_QUOTES_BY_TOKEN = 'quotesByLinkToken'

/** The wording every dead link gets, whatever killed it: nothing leaks which. */
const LINK_GONE = 'This tracking link is no longer active'
/** The wording every dead quote link gets, whatever killed it. */
const QUOTE_LINK_GONE = 'This quote link is no longer active'
/** Somebody — them, a rep, or a sweep — moved this round before this answer landed. */
const QUOTE_ANSWERED = 'This quote has already been answered'
/** A leaked link cannot be scraped forever. */
// Both public pages refresh every 60s while their tab is visible, so a customer
// watching a load all week legitimately spends thousands of requests. The cap is
// an abuse ceiling, not a budget: 30k is ~3 weeks of continuous visible polling,
// comfortably past the 14-day customer link and the delivery + 72h carrier link.
const MAX_LINK_REQUESTS = 30_000
const MAX_LINK_PINGS = 500
/** One tap a minute is plenty; the rest is a stuck finger or a script. */
const MIN_PING_GAP_MS = 60_000
/** A cell-tower fix is useless for proving where the freight is. */
const MAX_ACCURACY_M = 5000
/** How many timeline rows a public page is allowed to pull. */
const EVENT_LIMIT = 200
const POSITION_LIMIT = 500
/** How many documents one shipment's portal page may pull. */
const DOCUMENT_LIMIT = 200
/** An upload link that has run out, been revoked, or never was one. */
const UPLOAD_LINK_GONE = 'That upload link is no longer active.'
/** The file budget is spent; a carrier with more to send talks to a person. */
const UPLOAD_BUDGET_SPENT = 'This link has received all the files it can. Call dispatch.'
/** Long enough for a phone on truck-stop wifi to push 15 MB, short enough to be useless later. */
const PRESIGN_EXPIRY_SECONDS = 300
// `customerView` keeps its own copy of this fallback; the portal view takes the
// broker name as an argument, so the same default lives here rather than being
// exported out of a pure lib for one caller.
const BROKER_FALLBACK = 'BCAT Logistics'

type Row = Record<string, unknown>

interface FnUrlEvent {
  rawPath?: string
  body?: string
  isBase64Encoded?: boolean
  /** Lower-cased by the Function URL; the Step J routes read `authorization` and `x-bcat-signature`. */
  headers?: Record<string, string | undefined>
  requestContext?: { http?: { method?: string; sourceIp?: string } }
}

function reply(status: number, body: unknown) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) }
}

export interface TrackingView {
  unit: string
  driver: string | null
  position: { lat: number; lon: number; description: string | null; locatedAt: string } | null
  load: { pro: string | null; lane: string; eta: { at: string; basis: 'motive' | 'appt' } | null } | null
  generatedAt: string
}

async function truckByCode(code: string): Promise<Record<string, unknown> | null> {
  let token: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: EQUIPMENT_TABLE,
      FilterExpression: 'trackingCode = :c AND #t = :truck',
      ExpressionAttributeNames: { '#t': 'type' },
      ExpressionAttributeValues: { ':c': code, ':truck': 'truck' },
      ProjectionExpression: 'id, unitNumber, assignedDriverId, active',
      ExclusiveStartKey: token as Record<string, never> | undefined,
    }))
    const hit = (r.Items ?? [])[0]
    if (hit) return hit
    token = r.LastEvaluatedKey
  } while (token)
  return null
}

async function driverFor(truck: Record<string, unknown>): Promise<{ id: string; name: string } | null> {
  const direct = typeof truck.assignedDriverId === 'string' ? truck.assignedDriverId : ''
  if (direct) {
    const r = await ddb.send(new GetCommand({ TableName: DRIVER_TABLE, Key: { id: direct }, ProjectionExpression: 'id, #n', ExpressionAttributeNames: { '#n': 'name' } }))
    if (r.Item?.name) return { id: direct, name: String(r.Item.name) }
  }
  // The driver side of the assignment, when the equipment side is behind.
  const r = await ddb.send(new ScanCommand({
    TableName: DRIVER_TABLE,
    FilterExpression: 'assignedTruckId = :t',
    ExpressionAttributeValues: { ':t': truck.id },
    ProjectionExpression: 'id, #n',
    ExpressionAttributeNames: { '#n': 'name' },
  }))
  const d = (r.Items ?? [])[0]
  return d?.name ? { id: String(d.id), name: String(d.name) } : null
}

async function loadsFor(driverId: string, since: string): Promise<Load[]> {
  const out: Load[] = []
  let token: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: LOAD_TABLE,
      FilterExpression: '(deliveryDriverId = :d OR pickupDriverId = :d) AND deliveryAppt >= :since',
      ExpressionAttributeValues: { ':d': driverId, ':since': since },
      ProjectionExpression: 'id, aljexId, pickupDriverId, deliveryDriverId, pickupAppt, deliveryAppt, originCity, destinationCity, stops, truckId',
      ExclusiveStartKey: token as Record<string, never> | undefined,
    }))
    out.push(...((r.Items ?? []) as Load[]))
    token = r.LastEvaluatedKey
  } while (token)
  return out
}

/** The original route: a truck's permanent link, unchanged since it went out. */
async function truckRoute(code: string) {
  const truck = await truckByCode(code)
  if (!truck || truck.active === false) return reply(404, { error: LINK_GONE })
  const truckId = String(truck.id)
  const now = Date.now()

  const [loc, driver] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TRUCK_LOCATION_TABLE, Key: { truckId }, ProjectionExpression: 'lat, lon, description, locatedAt' })).then((r) => r.Item ?? null),
    driverFor(truck),
  ])

  let load: TrackingView['load'] = null
  if (driver) {
    const since = new Date(now - 3 * 86_400_000).toISOString().slice(0, 10)
    const current = currentLoadForDriver(await loadsFor(driver.id, since), driver.id, now)
    if (current) {
      const eta = pendingDeliveryEta(current)
      load = { pro: (current.aljexId ?? '').trim() || null, lane: laneLabel(current), eta: eta ? { at: eta.etaAt, basis: eta.basis } : null }
    }
  }

  const view: TrackingView = {
    unit: String(truck.unitNumber ?? ''),
    driver: driver?.name ?? null,
    position: loc && typeof loc.lat === 'number' && typeof loc.lon === 'number'
      ? { lat: loc.lat, lon: loc.lon, description: typeof loc.description === 'string' ? loc.description : null, locatedAt: String(loc.locatedAt) }
      : null,
    load,
    generatedAt: new Date(now).toISOString(),
  }
  return reply(200, view)
}

// ── Step D: tokenised links ─────────────────────────────────────────────────

/** AWSJSON comes back as a list, or as a string when something double-encoded it. */
function parseJson<T>(value: unknown): T | null {
  let v: unknown = value
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { return null }
  }
  return v == null ? null : (v as T)
}

async function getRow(table: string, key: Row): Promise<Row | null> {
  const r = await ddb.send(new GetCommand({ TableName: table, Key: key }))
  return (r.Item as Row | undefined) ?? null
}

interface QuerySpec {
  table: string
  index: string
  key: string
  value: string
  sort?: { name: string; from: string; to: string }
  limit?: number
  /** Newest first. */
  desc?: boolean
}

async function queryIndex(spec: QuerySpec): Promise<Row[]> {
  const names: Record<string, string> = { '#k': spec.key }
  const values: Record<string, unknown> = { ':k': spec.value }
  let condition = '#k = :k'
  if (spec.sort) {
    names['#s'] = spec.sort.name
    values[':from'] = spec.sort.from
    values[':to'] = spec.sort.to
    condition += ' AND #s BETWEEN :from AND :to'
  }
  const out: Row[] = []
  let token: Row | undefined
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: spec.table,
      IndexName: spec.index,
      KeyConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ScanIndexForward: spec.desc !== true,
      Limit: spec.limit,
      ExclusiveStartKey: token as Record<string, never> | undefined,
    }))
    out.push(...((r.Items ?? []) as Row[]))
    if (spec.limit != null && out.length >= spec.limit) return out.slice(0, spec.limit)
    token = r.LastEvaluatedKey as Row | undefined
  } while (token)
  return out
}

function toLoad(row: Row): ShipmentLoad {
  return { ...row, id: String(row.id), stops: parseJson<Stop[]>(row.stops) ?? [] } as ShipmentLoad
}

function toOrder(row: Row): OrderRecord {
  return { ...row, references: parseJson(row.references) ?? [] } as unknown as OrderRecord
}

function toEvent(row: Row): LoadCheckCallRecord {
  return { ...row, charges: parseJson(row.charges) } as unknown as LoadCheckCallRecord
}

/**
 * The link, or nothing.
 *
 * Wrong shape, wrong kind, revoked, expired and never-existed are one answer on the
 * way out, so a guess learns nothing. An ACTIVE row found past its date is marked
 * EXPIRED on the way past — the counters stop moving and staff see why.
 */
async function activeLink(token: string, kind: TrackingLinkKind): Promise<TrackingLinkRecord | null> {
  if (!isLinkToken(token)) return null
  const row = await getRow(TRACKING_LINK_TABLE, { id: token })
  if (!row) return null
  const link = row as unknown as TrackingLinkRecord
  if (link.kind !== kind || link.status !== 'ACTIVE') return null
  const expiresAt = Date.parse(link.expiresAt ?? '')
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await expire(token)
    return null
  }
  return link
}

async function expire(token: string): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TRACKING_LINK_TABLE,
      Key: { id: token },
      UpdateExpression: 'SET #s = :expired, updatedAt = :now',
      ConditionExpression: '#s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':expired': 'EXPIRED', ':active': 'ACTIVE', ':now': new Date().toISOString() },
    }))
  } catch {
    // Already expired or revoked by somebody else: the answer is the same either way.
  }
}

/** One more read of this link, if it still has reads left. */
async function countOpen(token: string): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TRACKING_LINK_TABLE,
      Key: { id: token },
      UpdateExpression: 'SET lastOpenedAt = :now ADD requestCount :one, openCount :one',
      ConditionExpression: 'attribute_not_exists(requestCount) OR requestCount < :max',
      ExpressionAttributeValues: { ':now': new Date().toISOString(), ':one': 1, ':max': MAX_LINK_REQUESTS },
    }))
    return true
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

async function settings(): Promise<TmsSettings | null> {
  const row = await getRow(TMS_SETTINGS_TABLE, { id: 'default' })
  if (!row) return null
  return { ...row, trackingContact: parseJson(row.trackingContact) } as unknown as TmsSettings
}

async function divisionFor(loads: ShipmentLoad[]): Promise<Division | null> {
  const key = loads.map((l) => l.divisionKey?.trim()).find((k): k is string => !!k)
  if (!key) return null
  const row = await getRow(DIVISION_TABLE, { key })
  return row ? (row as unknown as Division) : null
}

/** Motive's breadcrumbs for whatever trucks pulled this shipment, inside each leg's window. */
async function motivePositions(loads: ShipmentLoad[], carriers: LoadCarrierRecord[], nowIso: string): Promise<TrackPosition[]> {
  const out: TrackPosition[] = []
  for (const load of loads) {
    const row = load as unknown as Row
    const truckId = typeof row.truckId === 'string' ? row.truckId.trim() : ''
    if (!truckId) continue
    const carrier = carriers.find((lc) => lc.loadId === load.id && lc.status === 'ACTIVE') ?? null
    const window = trackingWindow(load, carrier, nowIso)
    const rows = await queryIndex({
      table: TRUCK_LOCATION_HISTORY_TABLE,
      index: IDX_POSITIONS_BY_TRUCK,
      key: 'truckId',
      value: truckId,
      sort: { name: 'locatedAt', from: window.from, to: window.to },
      limit: POSITION_LIMIT,
    })
    for (const fix of rows) {
      if (typeof fix.lat !== 'number' || typeof fix.lon !== 'number') continue
      out.push({
        truckId,
        lat: fix.lat,
        lon: fix.lon,
        locatedAt: String(fix.locatedAt),
        description: typeof fix.description === 'string' ? fix.description : null,
        speed: typeof fix.speed === 'number' ? fix.speed : null,
      })
    }
  }
  return thinPositions(out)
}

/** `GET /s/<token>` — the Customer Link. */
async function customerRoute(token: string) {
  const link = await activeLink(token, 'CUSTOMER_VIEW')
  if (!link) return reply(404, { error: LINK_GONE })
  if (!(await countOpen(token))) return reply(429, { error: 'This tracking link has been opened too many times' })

  const shipmentRow = await getRow(SHIPMENT_TABLE, { id: link.shipmentId })
  if (!shipmentRow) return reply(404, { error: LINK_GONE })
  const shipment = shipmentRow as unknown as ShipmentRecord

  const [orderRows, loadRows, carrierRows, eventRows] = await Promise.all([
    queryIndex({ table: ORDER_TABLE, index: IDX_ORDERS_BY_SHIPMENT, key: 'shipmentId', value: link.shipmentId }),
    queryIndex({ table: LOAD_TABLE, index: IDX_LOADS_BY_SHIPMENT, key: 'shipmentId', value: link.shipmentId }),
    queryIndex({ table: LOAD_CARRIER_TABLE, index: IDX_CARRIERS_BY_SHIPMENT, key: 'shipmentId', value: link.shipmentId }),
    queryIndex({ table: LOAD_CHECK_CALL_TABLE, index: IDX_CHECK_CALLS_BY_SHIPMENT, key: 'shipmentId', value: link.shipmentId, desc: true, limit: EVENT_LIMIT }),
  ])

  const loads = loadRows.map(toLoad)
  const loadCarriers = carrierRows as unknown as LoadCarrierRecord[]
  const events = eventRows.map(toEvent)
  const nowIso = new Date().toISOString()

  const [division, positions] = await Promise.all([
    divisionFor(loads),
    link.showPosition === false ? Promise.resolve<TrackPosition[]>([]) : motivePositions(loads, loadCarriers, nowIso),
  ])

  return reply(200, customerView({
    shipment,
    orders: orderRows.map(toOrder),
    loads,
    loadCarriers,
    events,
    position: link.showPosition === false ? null : lastKnownPosition(buildTimeline({ checkCalls: events, positions })),
    link,
    division,
    nowIso,
  }))
}

/** The driver's own pings, newest first — proof that the taps landed. */
async function pingsForLink(link: TrackingLinkRecord): Promise<LoadCheckCallRecord[]> {
  if (!link.loadId) return []
  const rows = await queryIndex({
    table: LOAD_CHECK_CALL_TABLE,
    index: IDX_CHECK_CALLS_BY_LOAD,
    key: 'loadId',
    value: link.loadId,
    desc: true,
    limit: EVENT_LIMIT,
  })
  return rows.map(toEvent)
}

/** `GET /l/<token>` — the carrier driver's page. */
async function carrierRoute(token: string) {
  const link = await activeLink(token, 'CARRIER_PING')
  if (!link?.loadId) return reply(404, { error: LINK_GONE })
  if (!(await countOpen(token))) return reply(429, { error: 'This tracking link has been opened too many times' })

  const loadRow = await getRow(LOAD_TABLE, { id: link.loadId })
  if (!loadRow) return reply(404, { error: LINK_GONE })

  const [events, settingsRow] = await Promise.all([pingsForLink(link), settings().catch(() => null)])
  return reply(200, carrierView({
    load: toLoad(loadRow),
    events,
    link,
    contactPhone: settingsRow?.trackingContact?.phone?.trim() || null,
    nowIso: new Date().toISOString(),
  }))
}

interface PingFix {
  lat: number
  lng: number
  accuracyM: number | null
}

/** What the driver's browser sent, or the reason it is unusable. */
function readFix(body: unknown): { fix: PingFix } | { error: string } {
  const raw = parseJson<Record<string, unknown>>(body)
  if (!raw || typeof raw !== 'object') return { error: 'Send your location as {lat, lng, accuracyM}' }
  const { lat, lng } = raw
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'That location is out of range' }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) return { error: 'That location is out of range' }
  const accuracy = raw.accuracyM
  const accuracyM = typeof accuracy === 'number' && Number.isFinite(accuracy) ? Math.round(accuracy) : null
  return { fix: { lat, lng, accuracyM } }
}

/** `POST /l/<token>/ping` — one tap. */
async function pingRoute(token: string, event: FnUrlEvent) {
  const link = await activeLink(token, 'CARRIER_PING')
  if (!link?.loadId) return reply(404, { error: LINK_GONE })

  const body = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body
  const read = readFix(body)
  if ('error' in read) return reply(400, { error: read.error })
  const { fix } = read

  if (fix.accuracyM != null && fix.accuracyM > MAX_ACCURACY_M) {
    return reply(409, { error: 'Location too imprecise — turn on precise location' })
  }

  const now = Date.now()
  const since = link.lastPingAt ? now - Date.parse(link.lastPingAt) : Number.POSITIVE_INFINITY
  if (Number.isFinite(since) && since < MIN_PING_GAP_MS) {
    return reply(429, { error: 'Thanks — your location is already in. Tap again in a minute.' })
  }
  if ((link.pingCount ?? 0) >= MAX_LINK_PINGS) {
    return reply(429, { error: 'This link has sent all the updates it can. Call dispatch.' })
  }

  const nowIso = new Date(now).toISOString()
  // The counter moves first: it is the guard, and a tap that is refused must not
  // leave an event row behind claiming the freight was there.
  try {
    await ddb.send(new UpdateCommand({
      TableName: TRACKING_LINK_TABLE,
      Key: { id: token },
      UpdateExpression: 'SET lastPingAt = :now, lastPingLat = :lat, lastPingLng = :lng, lastPingAccuracyM = :acc, updatedAt = :now ADD pingCount :one',
      ConditionExpression: '(attribute_not_exists(pingCount) OR pingCount < :max) AND (attribute_not_exists(lastPingAt) OR lastPingAt < :cutoff)',
      ExpressionAttributeValues: {
        ':now': nowIso,
        ':lat': fix.lat,
        ':lng': fix.lng,
        ':acc': fix.accuracyM,
        ':one': 1,
        ':max': MAX_LINK_PINGS,
        ':cutoff': new Date(now - MIN_PING_GAP_MS).toISOString(),
      },
    }))
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'ConditionalCheckFailedException') {
      return reply(429, { error: 'Thanks — your location is already in. Tap again in a minute.' })
    }
    throw err
  }

  await ddb.send(new PutCommand({
    TableName: LOAD_CHECK_CALL_TABLE,
    Item: {
      id: randomUUID(),
      loadId: link.loadId,
      shipmentId: link.shipmentId,
      loadCarrierId: link.loadCarrierId ?? null,
      at: nowIso,
      type: 'TRACKING_PING',
      source: 'LINK',
      lat: fix.lat,
      lng: fix.lng,
      accuracyM: fix.accuracyM,
      createdBy: `link:${token.slice(0, 8)}`,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  }))

  return reply(200, { ok: true, at: nowIso })
}

// ── Step E: the carrier upload portal ───────────────────────────────────────

/**
 * The upload link, or nothing.
 *
 * Same answer for wrong shape, wrong kind, revoked, expired and never-existed, so a
 * guessed token learns nothing; and an ACTIVE row found past its date is marked
 * EXPIRED on the way past, exactly like the Step D pages.
 */
async function uploadLink(token: string): Promise<TrackingLinkRecord | null> {
  if (!isLinkToken(token)) return null
  const row = await getRow(TRACKING_LINK_TABLE, { id: token })
  if (!row) return null
  const link = row as unknown as TrackingLinkRecord
  if (uploadLinkUsable(link, new Date().toISOString())) return link
  if (link.kind === 'CARRIER_UPLOAD' && link.status === 'ACTIVE') await expire(token)
  return null
}

/** `GET /u/<token>` — what the carrier still owes us, and what it has already sent. */
async function uploadViewRoute(token: string) {
  const link = await uploadLink(token)
  if (!link?.loadId || !link.loadCarrierId) return reply(404, { error: UPLOAD_LINK_GONE })
  if (!(await countOpen(token))) return reply(429, { error: 'This tracking link has been opened too many times' })

  const [loadRow, carrierRow, documentRows, settingsRow] = await Promise.all([
    getRow(LOAD_TABLE, { id: link.loadId }),
    getRow(LOAD_CARRIER_TABLE, { id: link.loadCarrierId }),
    // Every document on the shipment; `carrierUploadView` picks out this carrier's own.
    queryIndex({ table: SHIPMENT_DOCUMENT_TABLE, index: IDX_DOCUMENTS_BY_SHIPMENT, key: 'shipmentId', value: link.shipmentId, limit: DOCUMENT_LIMIT }),
    settings().catch(() => null),
  ])
  if (!loadRow || !carrierRow) return reply(404, { error: UPLOAD_LINK_GONE })

  const load = toLoad(loadRow)
  const division = await divisionFor([load])
  return reply(200, carrierUploadView({
    link,
    load,
    loadCarrier: carrierRow as unknown as LoadCarrierRecord,
    documents: documentRows as unknown as ShipmentDocumentRecord[],
    brokerName: division?.name?.trim() || BROKER_FALLBACK,
    contactPhone: settingsRow?.trackingContact?.phone?.trim() || null,
    nowIso: new Date().toISOString(),
  }))
}

interface PortalFile {
  type: string
  name: string
  contentType: string
  sizeBytes: number
  documentId: string
  s3Key: string
}

/** What the carrier's browser says it is sending, or the reason it is unusable. */
function readFile(body: unknown, committing: boolean): { file: PortalFile } | { error: string } {
  const raw = parseJson<Record<string, unknown>>(body)
  if (!raw || typeof raw !== 'object') return { error: 'Send the file as {type, name, contentType, sizeBytes}.' }
  const { type, name, contentType, sizeBytes, documentId, s3Key } = raw
  if (typeof type !== 'string' || typeof contentType !== 'string') {
    return { error: 'Send the file as {type, name, contentType, sizeBytes}.' }
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 255) return { error: 'That file needs a name.' }
  if (typeof sizeBytes !== 'number') return { error: 'Send the file as {type, name, contentType, sizeBytes}.' }
  // The id is a DynamoDB key and half of the S3 key, so only the shape this route
  // mints is ever accepted back.
  if (committing && (typeof documentId !== 'string' || !/^sdoc-[0-9a-fA-F-]{36}$/.test(documentId))) {
    return { error: 'That upload is not one this link started.' }
  }
  if (committing && (typeof s3Key !== 'string' || !s3Key)) return { error: 'That upload is not one this link started.' }
  return {
    file: {
      type,
      name: name.trim(),
      contentType,
      sizeBytes,
      documentId: typeof documentId === 'string' ? documentId : '',
      s3Key: typeof s3Key === 'string' ? s3Key : '',
    },
  }
}

/** `POST /u/<token>/upload` — one presigned PUT. Writes nothing. */
async function uploadPrepareRoute(token: string, event: FnUrlEvent) {
  const link = await uploadLink(token)
  if (!link?.loadCarrierId) return reply(404, { error: UPLOAD_LINK_GONE })

  const prepared = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body
  const read = readFile(prepared, false)
  if ('error' in read) return reply(400, { error: read.error })
  const { file } = read
  const allowed = portalUploadAllowed(file.type, file.contentType, file.sizeBytes)
  if (!allowed.ok) return reply(400, { error: allowed.reason })

  // The budget is spent on committed files, and checked here: a presigned URL the
  // carrier never uses must not lock anybody out.
  if ((link.uploadCount ?? 0) >= MAX_UPLOADS_PER_LINK) return reply(429, { error: UPLOAD_BUDGET_SPENT })

  const documentId = `sdoc-${randomUUID()}`
  const s3Key = documentKey(link.shipmentId, documentId, file.name, file.contentType)
  // Pinned to both the type and the exact length, so the signed URL cannot be reused
  // to put something else — or something very large — into our bucket. `content-type`
  // sits in the presigner's unsignableHeaders by default, so naming it in
  // signableHeaders is what actually binds it; the name has to be lowercase because
  // that is the canonical form the signer compares against, and the browser's
  // `putPresignedFile` sends the matching `Content-Type` header.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: DOCUMENT_BUCKET, Key: s3Key, ContentType: file.contentType, ContentLength: file.sizeBytes }),
    { expiresIn: PRESIGN_EXPIRY_SECONDS, signableHeaders: new Set(['content-type']) },
  )
  return reply(200, { uploadUrl, s3Key, documentId })
}

/**
 * `POST /u/<token>/commit` — the row for a file that landed.
 *
 * The only write the public role has besides the link's own counters, and it is one
 * PENDING ShipmentDocument row. No Order, Load, LoadCarrier, Shipment or TmsSettings
 * write may ever appear in these routes: a carrier-portal upload influences a billing
 * decision only after a member of staff accepts it, in `tmsShipmentActions`.
 */
async function uploadCommitRoute(token: string, event: FnUrlEvent) {
  const link = await uploadLink(token)
  if (!link?.loadCarrierId) return reply(404, { error: UPLOAD_LINK_GONE })

  const committed = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body
  const read = readFile(committed, true)
  if ('error' in read) return reply(400, { error: read.error })
  const { file } = read
  const allowed = portalUploadAllowed(file.type, file.contentType, file.sizeBytes)
  if (!allowed.ok) return reply(400, { error: allowed.reason })

  // The document id is inside its own key, so a commit can only claim bytes this
  // link's own presign minted, under this shipment's prefix.
  if (!file.s3Key.startsWith(`${documentPrefix(link.shipmentId)}${file.documentId}-`)) {
    return reply(400, { error: 'That file does not belong to this load.' })
  }

  // The ceiling has to hold here too, not only on presign: a link holder can ask for
  // any number of presigned PUTs in one burst while the count is still low and commit
  // them all inside the five-minute window, so a prepare-only check is no ceiling at
  // all. This is the same count the prepare route reads, off the link row already
  // loaded above.
  if ((link.uploadCount ?? 0) >= MAX_UPLOADS_PER_LINK) {
    // A retried commit of a file this link already wrote is not a twenty-first file:
    // the row exists and was paid for, so repeating it answers 200 exactly as the
    // ConditionalCheckFailedException path below does. Punishing a retry would strand
    // a carrier whose first answer was lost on the way back.
    const existing = await getRow(SHIPMENT_DOCUMENT_TABLE, { id: file.documentId })
    if (existing) return reply(200, { ok: true, documentId: file.documentId })
    return reply(429, { error: UPLOAD_BUDGET_SPENT })
  }

  let head: { ContentLength?: number; ContentType?: string }
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: DOCUMENT_BUCKET, Key: file.s3Key }))
  } catch {
    return reply(409, { error: 'That file has not finished uploading — try again.' })
  }
  // The bytes have to be the ones the presign was issued for. S3 omits ContentType
  // only when the PUT carried none, which the presigned URL cannot do, so a missing
  // one is not treated as a mismatch.
  if (head.ContentLength !== file.sizeBytes || (head.ContentType ?? file.contentType) !== file.contentType) {
    return reply(400, { error: 'That file does not match what was uploaded.' })
  }

  const nowIso = new Date().toISOString()
  const by = `link:${token.slice(0, 8)}`
  try {
    await ddb.send(new PutCommand({
      TableName: SHIPMENT_DOCUMENT_TABLE,
      Item: {
        id: file.documentId,
        shipmentId: link.shipmentId,
        loadId: link.loadId ?? null,
        loadCarrierId: link.loadCarrierId,
        type: file.type,
        name: file.name,
        s3Key: file.s3Key,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        source: 'CARRIER_PORTAL',
        // PENDING until staff accept it: nothing a carrier sends satisfies a
        // required document on its own.
        reviewStatus: 'PENDING',
        status: 'ACTIVE',
        version: 1,
        audience: 'ALL',
        uploadLinkId: token,
        uploadedBy: by,
        uploadedAt: nowIso,
        createdBy: by,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      ConditionExpression: 'attribute_not_exists(id)',
    }))
  } catch (err) {
    // A retried commit of the same file: the row is already there, and saying so
    // again would cost the link another slot of its budget.
    if ((err as { name?: string } | null)?.name === 'ConditionalCheckFailedException') {
      return reply(200, { ok: true, documentId: file.documentId })
    }
    throw err
  }

  await ddb.send(new UpdateCommand({
    TableName: TRACKING_LINK_TABLE,
    Key: { id: token },
    UpdateExpression: 'SET lastUploadAt = :now, updatedAt = :now ADD uploadCount :one',
    ExpressionAttributeValues: { ':now': nowIso, ':one': 1 },
  }))

  return reply(200, { ok: true, documentId: file.documentId, uploadedAt: nowIso })
}

// ── Step H: the public quote link ───────────────────────────────────────────

/** The row, with everything it keeps as AWSJSON read back as itself. */
function toQuote(row: Row): QuoteRecord {
  return {
    ...row,
    stops: parseJson<Stop[]>(row.stops) ?? [],
    lines: parseJson(row.lines) ?? [],
    references: parseJson(row.references) ?? [],
    events: parseJson<QuoteEvent[]>(row.events) ?? [],
  } as unknown as QuoteRecord
}

/**
 * The quote this token is the live secret for, or nothing.
 *
 * The token is not the key — a quote's id is its number, which staff put in a URL
 * — so the way in is the sparse `linkToken` index, and the row is only answerable
 * on the rungs where somebody is actually waiting on an answer. Malformed, spent,
 * already closed, never minted and past its date are one reply on the way out.
 *
 * A row with no `expiresAt` is not expired: it was never given a clock, and the
 * one-use token is the guard. This is `quoteState`'s reading of expiry, not
 * `activeLink`'s, because a quote's clock is a business promise and a tracking
 * link's is a lease.
 */
async function liveQuote(token: string): Promise<QuoteRecord | null> {
  if (!isLinkToken(token)) return null
  const rows = await queryIndex({ table: QUOTE_TABLE, index: IDX_QUOTES_BY_TOKEN, key: 'linkToken', value: token, limit: 2 })
  // One token, one quote. Two rows answering to the same secret is a mint bug, and
  // guessing which one the customer meant is how the wrong freight gets sold.
  if (rows.length !== 1) return null
  const quote = toQuote(rows[0])
  if (quote.linkToken !== token) return null
  if (!liveLinkStatuses(quote.side).includes(quote.status)) return null
  const expiresAt = Date.parse(quote.expiresAt ?? '')
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    await expireQuote(quote)
    return null
  }
  return quote
}

/**
 * A link read past its date dies where it is found, exactly as `expire()` kills a
 * tracking link: LOST/EXPIRED, the token gone, off the open board. Conditioned on
 * the token and the rung it was read at, so a sweep that closed it a second ago
 * wins and this one writes nothing.
 */
async function expireQuote(quote: QuoteRecord): Promise<void> {
  const nowIso = new Date().toISOString()
  try {
    await ddb.send(new UpdateCommand({
      TableName: QUOTE_TABLE,
      Key: { id: quote.id },
      UpdateExpression:
        'SET #st = :lost, lostReason = :expired, closedAt = :now, updatedAt = :now, updatedBy = :by, #vn = if_not_exists(#vn, :zero) + :one REMOVE #lt, #qo',
      ConditionExpression: '#lt = :tok AND #st = :was',
      ExpressionAttributeNames: { '#st': 'status', '#lt': 'linkToken', '#qo': 'quoteOpen', '#vn': 'version' },
      ExpressionAttributeValues: {
        ':lost': 'LOST',
        ':expired': 'EXPIRED',
        ':now': nowIso,
        ':by': `link:${(quote.linkToken ?? '').slice(0, 8)}`,
        ':tok': quote.linkToken,
        ':was': quote.status,
        ':zero': 0,
        ':one': 1,
      },
    }))
  } catch (err) {
    // A sweep or a rep got there first: the link is dead either way.
    if ((err as { name?: string } | null)?.name !== 'ConditionalCheckFailedException') throw err
  }
}

/** One more read of this quote's page, if the link still has reads left. */
async function countQuoteOpen(quote: QuoteRecord): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: QUOTE_TABLE,
      Key: { id: quote.id },
      UpdateExpression: 'ADD requestCount :one',
      ConditionExpression: '#lt = :tok AND (attribute_not_exists(requestCount) OR requestCount < :max)',
      ExpressionAttributeNames: { '#lt': 'linkToken' },
      ExpressionAttributeValues: { ':tok': quote.linkToken, ':one': 1, ':max': MAX_LINK_REQUESTS },
    }))
    return true
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

/** The brokerage name on the page: the quote's own division, or ours. */
async function quoteBrokerName(quote: QuoteRecord): Promise<string> {
  const key = quote.divisionKey?.trim()
  if (!key) return BROKER_FALLBACK
  const row = await getRow(DIVISION_TABLE, { key })
  return (row as unknown as Division | null)?.name?.trim() || BROKER_FALLBACK
}

/** `GET /q/<token>` — the customer's quote, or the carrier's offer. */
async function quoteViewRoute(token: string) {
  const quote = await liveQuote(token)
  if (!quote) return reply(404, { error: QUOTE_LINK_GONE })
  if (!(await countQuoteOpen(quote))) return reply(429, { error: 'This quote link has been opened too many times' })

  const [brokerName, settingsRow] = await Promise.all([quoteBrokerName(quote), settings().catch(() => null)])
  return reply(200, quotePublicView(quote, {
    brokerName,
    termsText: settingsRow?.quoteTermsText ?? null,
    // Sell pages never carry a book-now rate: it is what we will pay, not what
    // anybody is being sold.
    showBookNow: quote.side === 'BUY' && settingsRow?.quoteOffersCarrierSeesBookNow !== false,
    nowIso: new Date().toISOString(),
  }))
}

/**
 * `POST /q/<token>/respond` — the one answer this round's link is good for.
 *
 * The read above is only a courtesy: between it and the write, a rep can counter,
 * a sweep can expire it, or a second tab can answer first. Only the condition —
 * still this token, still a rung that is waiting — makes the answer once-only, and
 * because it is on the base table a stale index read loses honestly with a 410.
 */
async function quoteRespondRoute(token: string, event: FnUrlEvent) {
  const quote = await liveQuote(token)
  if (!quote) return reply(404, { error: QUOTE_LINK_GONE })

  const sent = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body
  // Only a carrier's accept needs to know whether the book-now rate was on show.
  const settingsRow = quote.side === 'BUY' ? await settings().catch(() => null) : null
  const read = planResponse(quote, parseJson<Record<string, unknown>>(sent ?? null), {
    showBookNow: settingsRow?.quoteOffersCarrierSeesBookNow !== false,
  })
  if ('error' in read) return reply(400, { error: read.error })
  const { plan } = read

  const nowIso = new Date().toISOString()
  const events = [...(quote.events ?? []), {
    at: nowIso,
    by: plan.responderEmail,
    kind: plan.eventKind,
    amountCents: plan.counterCents ?? plan.amountCents ?? null,
    note: plan.message,
  }]

  const sets = [
    '#st = :status',
    '#rp = :response',
    '#ev = :events',
    'responderName = :name',
    'responderEmail = :email',
    'responderIp = :ip',
    'respondedAt = :now',
    'updatedAt = :now',
    'updatedBy = :by',
    '#vn = if_not_exists(#vn, :zero) + :one',
  ]
  const values: Record<string, unknown> = {
    ':status': plan.status,
    ':response': plan.response,
    // A list, not a string: tms-shipment-actions stores the thread as a native
    // DynamoDB list and its `pushEvent` only appends to `Array.isArray(events)`.
    // A string here makes the next staff action throw the whole thread away.
    ':events': events,
    ':name': plan.responderName,
    ':email': plan.responderEmail,
    ':ip': event.requestContext?.http?.sourceIp ?? 'unknown',
    ':now': nowIso,
    ':by': `link:${token.slice(0, 8)}`,
    ':tok': token,
    ':zero': 0,
    ':one': 1,
  }
  if (plan.amountCents != null) {
    sets.push('amountCents = :amount')
    values[':amount'] = plan.amountCents
  }
  if (plan.counterCents != null) {
    sets.push('counterCents = :counter', 'counterBy = :counterBy')
    values[':counter'] = plan.counterCents
    values[':counterBy'] = plan.counterBy
  }
  if (plan.lostReason) {
    sets.push('lostReason = :lostReason')
    values[':lostReason'] = plan.lostReason
  }
  if (plan.acceptedVia) {
    sets.push('acceptedVia = :via')
    values[':via'] = plan.acceptedVia
  }
  if (plan.closes) sets.push('closedAt = :now')

  // The token always goes: one use per round, and the next round mints a new one.
  const removes = plan.closes ? '#lt, #qo' : '#lt'
  const rungs = plan.from.map((status, i) => {
    values[`:from${i}`] = status
    return `:from${i}`
  })

  try {
    await ddb.send(new UpdateCommand({
      TableName: QUOTE_TABLE,
      Key: { id: quote.id },
      UpdateExpression: `SET ${sets.join(', ')}${plan.bumpRounds ? ' ADD #rd :one' : ''} REMOVE ${removes}`,
      ConditionExpression: `#lt = :tok AND #st IN (${rungs.join(', ')})`,
      ExpressionAttributeNames: {
        '#st': 'status',
        '#rp': 'response',
        '#ev': 'events',
        '#lt': 'linkToken',
        '#vn': 'version',
        ...(plan.closes ? { '#qo': 'quoteOpen' } : {}),
        ...(plan.bumpRounds ? { '#rd': 'rounds' } : {}),
      },
      ExpressionAttributeValues: values,
    }))
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'ConditionalCheckFailedException') {
      return reply(410, { error: QUOTE_ANSWERED })
    }
    throw err
  }

  return reply(200, { ok: true, status: plan.status, response: plan.response })
}

const TRUCK_PATH = /^\/t\/([A-Za-z0-9]{6,32})\/?$/
const CUSTOMER_PATH = /^\/s\/([A-Za-z0-9_-]+)\/?$/
const CARRIER_PATH = /^\/l\/([A-Za-z0-9_-]+)\/?$/
const PING_PATH = /^\/l\/([A-Za-z0-9_-]+)\/ping\/?$/
const UPLOAD_PATH = /^\/u\/([A-Za-z0-9_-]+)\/?$/
const UPLOAD_PREPARE_PATH = /^\/u\/([A-Za-z0-9_-]+)\/upload\/?$/
const UPLOAD_COMMIT_PATH = /^\/u\/([A-Za-z0-9_-]+)\/commit\/?$/
// Step H: the public quote link.
const QUOTE_PATH = /^\/q\/([A-Za-z0-9_-]+)\/?$/
const QUOTE_RESPOND_PATH = /^\/q\/([A-Za-z0-9_-]+)\/respond\/?$/
// Step J: BCAT's own API, and the inbound webhook receipt. A shipment number is a
// PRO, not a token, so it keeps its own character class; a provider arrives
// lower-cased and is upper-cased into its `Integration` row key by the route.
const API_TOKEN_PATH = /^\/api\/token\/?$/
const API_SHIPMENT_PATH = /^\/api\/v1\/shipments\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/?$/
const API_WEBHOOK_PATH = /^\/api\/webhooks\/([a-z0-9_]{2,40})\/?$/

export const handler = async (event: FnUrlEvent) => {
  const method = event.requestContext?.http?.method ?? 'GET'
  if (method === 'OPTIONS') return reply(200, { ok: true })
  const path = event.rawPath ?? ''

  if (method === 'GET') {
    const truck = TRUCK_PATH.exec(path)
    if (truck) return truckRoute(truck[1])
    const customer = CUSTOMER_PATH.exec(path)
    if (customer) return customerRoute(customer[1])
    const carrier = CARRIER_PATH.exec(path)
    if (carrier) return carrierRoute(carrier[1])
    const upload = UPLOAD_PATH.exec(path)
    if (upload) return uploadViewRoute(upload[1])
    const quote = QUOTE_PATH.exec(path)
    if (quote) return quoteViewRoute(quote[1])
    const shipment = API_SHIPMENT_PATH.exec(path)
    if (shipment) {
      const answer = await shipmentRoute(apiDeps, shipment[1], event, new Date().toISOString())
      return reply(answer.status, answer.body)
    }
    return reply(404, { error: 'Not found' })
  }

  if (method === 'POST') {
    const ping = PING_PATH.exec(path)
    if (ping) return pingRoute(ping[1], event)
    const prepare = UPLOAD_PREPARE_PATH.exec(path)
    if (prepare) return uploadPrepareRoute(prepare[1], event)
    const commit = UPLOAD_COMMIT_PATH.exec(path)
    if (commit) return uploadCommitRoute(commit[1], event)
    const respond = QUOTE_RESPOND_PATH.exec(path)
    if (respond) return quoteRespondRoute(respond[1], event)
    const apiToken = API_TOKEN_PATH.exec(path)
    if (apiToken) {
      const answer = await tokenRoute(apiDeps, event, new Date().toISOString())
      return reply(answer.status, answer.body)
    }
    const webhook = API_WEBHOOK_PATH.exec(path)
    if (webhook) {
      const answer = await webhookRoute(apiDeps, webhook[1], event, new Date().toISOString())
      return reply(answer.status, answer.body)
    }
    return reply(404, { error: 'Not found' })
  }

  return reply(405, { error: 'Method not allowed' })
}
