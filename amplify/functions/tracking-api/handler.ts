/**
 * tracking-api — the public pages behind a tracking link. No sign-in anywhere.
 *
 *   GET  /t/<code>        where a truck is right now (the Equipment trackingCode)
 *   GET  /s/<token>       the shipment's Customer Link
 *   GET  /l/<token>       the carrier driver's ping page
 *   POST /l/<token>/ping  one tap of that page
 *
 * For the three Step D routes the token **is** the TrackingLink row's primary key —
 * 24 random bytes, base64url — so every lookup is a GetItem on a 192-bit key and no
 * index can be walked from outside. What each page may say is decided once, in
 * `src/lib/trackingLink.ts`; this file only fetches and guards.
 *
 * This role cannot write Load. A ping is one LoadCheckCall row plus the link's own
 * counters, and "last known" is read back from those.
 */
import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { currentLoadForDriver, laneLabel } from '../../../src/lib/driverJourney'
import { pendingDeliveryEta } from '../../../src/lib/stopEvents'
import { carrierView, customerView, isLinkToken } from '../../../src/lib/trackingLink'
import { buildTimeline, lastKnownPosition, thinPositions, trackingWindow, type TrackPosition } from '../../../src/lib/trackingTimeline'
import type { Load, Stop } from '../../../src/types'
import type {
  Division,
  LoadCarrierRecord,
  LoadCheckCallRecord,
  OrderRecord,
  ShipmentLoad,
  ShipmentRecord,
  TmsSettings,
  TrackingLinkKind,
  TrackingLinkRecord,
} from '../../../src/types/tms'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
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

const IDX_ORDERS_BY_SHIPMENT = 'ordersByShipmentId'
const IDX_LOADS_BY_SHIPMENT = 'loadsByShipmentId'
const IDX_CARRIERS_BY_SHIPMENT = 'loadCarriersByShipmentId'
const IDX_CHECK_CALLS_BY_SHIPMENT = 'loadCheckCallsByShipmentIdAndAt'
const IDX_CHECK_CALLS_BY_LOAD = 'loadCheckCallsByLoadIdAndAt'
// Amplify pluralises the model for the physical index name: TruckLocationHistory
// → truckLocationHistories…, exactly like ordersByShipmentId above.
const IDX_POSITIONS_BY_TRUCK = 'truckLocationHistoriesByTruckIdAndLocatedAt'

/** The wording every dead link gets, whatever killed it: nothing leaks which. */
const LINK_GONE = 'This tracking link is no longer active'
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

type Row = Record<string, unknown>

interface FnUrlEvent {
  rawPath?: string
  body?: string
  isBase64Encoded?: boolean
  requestContext?: { http?: { method?: string } }
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

const TRUCK_PATH = /^\/t\/([A-Za-z0-9]{6,32})\/?$/
const CUSTOMER_PATH = /^\/s\/([A-Za-z0-9_-]+)\/?$/
const CARRIER_PATH = /^\/l\/([A-Za-z0-9_-]+)\/?$/
const PING_PATH = /^\/l\/([A-Za-z0-9_-]+)\/ping\/?$/

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
    return reply(404, { error: 'Not found' })
  }

  if (method === 'POST') {
    const ping = PING_PATH.exec(path)
    if (ping) return pingRoute(ping[1], event)
    return reply(404, { error: 'Not found' })
  }

  return reply(405, { error: 'Method not allowed' })
}
