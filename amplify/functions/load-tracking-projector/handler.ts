/**
 * load-tracking-projector Lambda — DynamoDB stream consumer on the Load table.
 *
 * The driver app, the POD close and the dispatch MMS auto-POD all stamp
 * `stops[].arrivedAt` / `departedAt` straight into the Load row and never touch
 * `Load.status`. This projector turns each newly stamped time into the matching
 * LoadCheckCall row and walks the load up the same `loadStatusFromStopTimes`
 * ladder the staff actions use, so a leg that was reported by a driver reads on
 * the board exactly like one a dispatcher called in.
 *
 * Side effects are deliberately tiny and provable:
 *   • legacy own-fleet loads (no `shipmentId`) are ignored entirely;
 *   • the only writes are LoadCheckCall (Put), Load (Update), Order (references:
 *     trailer, paperwork place) and — through `rederiveShipmentStatus` — Shipment.
 *     A voided shipment is never written. No Slack, no Twilio, no SES, which is
 *     why this is the one Load-stream consumer left enabled on the dev stack;
 *   • each stop event has a deterministic id (`evt:<loadId>:<stopId>:<event>`)
 *     written with `attribute_not_exists(id)`, so whoever logged it first wins
 *     and a stream retry, or a staff action that logged the same arrival, is a
 *     silent no-op rather than a duplicate row;
 *   • the Load update is conditioned on the image's own `updatedAt`, so a staff
 *     write that landed in between wins and we simply skip;
 *   • our own Load write changes no stop time, so the record it generates fails
 *     the "stops changed" gate and the loop ends there.
 */
import {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import {
  getById,
  readStops,
  rederiveShipmentStatus,
  shipmentStoreFromEnv,
  marshallRow,
  numberOrNull,
  transact,
  updateItemTx,
  isConflict,
  type Row,
  type ShipmentStoreDeps,
  type StopShape,
} from '../_shared/shipmentStore'
import { lastKnownPatch, statusAfterCheckCall, stopEventId } from '../../../src/lib/checkCalls'
import { normalizePaperworkLocation, paperworkLocationLabel } from '../../../src/lib/paperworkLocation'
import { splitCityState } from '../../../src/lib/locationAutoSave'
import { LOAD_WORKFLOW_STATUSES, type StopTimesLike } from '../../../src/lib/shipmentStatus'
import type { LoadStatusSource, LoadWorkflowStatus, StopEventType } from '../../../src/types/tms'

const dynamo = new DynamoDBClient({})

/** Who the Load row says last wrote it, once the projector has had its turn. */
export const PROJECTOR_ACTOR = 'load-tracking-projector'

// Minimal shape of the DynamoDB stream event (avoids an @types/aws-lambda dependency).
interface StreamRecord {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE'
  dynamodb?: {
    NewImage?: Record<string, AttributeValue>
    OldImage?: Record<string, AttributeValue>
  }
}
export interface StreamEvent { Records?: StreamRecord[] }

export interface ProjectorDeps {
  /** Client, tables and clock, exactly as the shipment router builds them. */
  store: ShipmentStoreDeps
  checkCallTable: string
  /** The driver roster, cached per container by the Lambda entry point. */
  drivers: () => Promise<DriverRoster>
}

export interface ProjectorSummary {
  /** Stream records in the batch. */
  records: number
  /** Records that carried a shipment and a changed stop image. */
  considered: number
  /** LoadCheckCall rows written. */
  events: number
  /** Stop events somebody else had already logged. */
  skipped: number
  /** Loads moved forward on the status ladder. */
  statusWrites: number
  /** Load updates refused because a staff write landed first. */
  conflicts: number
  /** Order reference rows (trailer, paperwork place) rewritten from the Load. */
  mirrored: number
}

// ── Driver roster ────────────────────────────────────────────────────────────

/** Driver ids, and their e-mails, as the stream sees `updatedBy`. */
export interface DriverRoster {
  ids: Set<string>
  byEmail: Map<string, string>
}

export function buildDriverRoster(rows: Row[]): DriverRoster {
  const ids = new Set<string>()
  const byEmail = new Map<string, string>()
  for (const row of rows) {
    const id = String(row.id ?? '')
    if (!id) continue
    ids.add(id)
    const email = String(row.email ?? '').trim().toLowerCase()
    if (email) byEmail.set(email, id)
  }
  return { ids, byEmail }
}

/** The driver behind this write, or null when a person or a job made it. */
export function driverIdFor(roster: DriverRoster, actor: string | null | undefined): string | null {
  const who = (actor ?? '').trim()
  if (!who) return null
  // The driver app writes `driver:<id>` on some paths and the bare id on others.
  const bare = who.startsWith('driver:') ? who.slice('driver:'.length) : who
  if (roster.ids.has(bare)) return bare
  return roster.byEmail.get(bare.toLowerCase()) ?? null
}

let rosterCache: { at: number; roster: DriverRoster } | null = null

/** Drivers, cached per container for a minute — same shape as `ownerOperators()`. */
export async function driverRoster(db: DynamoDBClient, tableName: string): Promise<DriverRoster> {
  if (rosterCache && Date.now() - rosterCache.at < 60_000) return rosterCache.roster
  const rows: Row[] = []
  if (tableName) {
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined
    do {
      const result = await db.send(new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'id, email',
        ExclusiveStartKey,
      }))
      for (const item of result.Items ?? []) rows.push(unmarshall(item))
      ExclusiveStartKey = result.LastEvaluatedKey
    } while (ExclusiveStartKey)
  }
  const roster = buildDriverRoster(rows)
  rosterCache = { at: Date.now(), roster }
  return roster
}

// ── Stop events ──────────────────────────────────────────────────────────────

/** One stop time that went from blank to stamped between two images. */
export interface StopEventFound {
  stopId: string
  event: StopEventType
  at: string
  sequence: number
  city: string | null
  state: string | null
}

const stamped = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function placeOf(stop: StopShape): { city: string | null; state: string | null } {
  const address = stop.address && typeof stop.address === 'object' ? stop.address : null
  const city = typeof address?.city === 'string' ? address.city.trim() : ''
  const state = typeof address?.state === 'string' ? address.state.trim() : ''
  // The booked address first, the "Chicago, IL" string the stop always carries second.
  const fallback = splitCityState(typeof stop.city === 'string' ? stop.city : null)
  return { city: city || fallback.city, state: state || fallback.state }
}

/**
 * The stop times this change created. An existing stamp that merely moved is not
 * an event: the first report of an arrival is the one the log keeps.
 */
export function newStopEvents(next: StopShape[], prev: StopShape[]): StopEventFound[] {
  const before = new Map(prev.map((s) => [String(s.id ?? ''), s]))
  const found: StopEventFound[] = []
  for (const stop of next) {
    const stopId = String(stop.id ?? '')
    if (!stopId) continue
    const old = before.get(stopId)
    const place = placeOf(stop)
    const sequence = Number(stop.sequence ?? 0)
    for (const event of ['ARRIVED', 'DEPARTED'] as const) {
      const key = event === 'ARRIVED' ? 'arrivedAt' : 'departedAt'
      const at = stamped(stop[key])
      if (!at || stamped(old?.[key])) continue
      found.push({ stopId, event, at, sequence, city: place.city, state: place.state })
    }
  }
  // Oldest first: the row the status lands on is the last one in the batch.
  return found.sort((a, b) =>
    a.at.localeCompare(b.at) ||
    a.sequence - b.sequence ||
    (a.event === b.event ? 0 : a.event === 'ARRIVED' ? -1 : 1))
}

/** The stops the status ladder reads: pickups and deliveries, with their times. */
function stopTimes(stops: StopShape[]): StopTimesLike[] {
  const out: StopTimesLike[] = []
  for (const stop of stops) {
    if (stop.type !== 'pickup' && stop.type !== 'delivery') continue
    out.push({
      type: stop.type,
      sequence: stop.sequence ?? null,
      arrivedAt: stamped(stop.arrivedAt) || null,
      departedAt: stamped(stop.departedAt) || null,
    })
  }
  return out
}

/** The stored status, or null when the row predates the TMS ladder. */
function workflowStatus(value: unknown): LoadWorkflowStatus | null {
  const found = LOAD_WORKFLOW_STATUSES.find((s) => s === value)
  return found ?? null
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** `SET` for every own key of `patch`, with every name escaped (`status` is reserved). */
function setExpression(patch: Row): {
  UpdateExpression: string
  ExpressionAttributeNames: Record<string, string>
  ExpressionAttributeValues: Record<string, AttributeValue>
} {
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
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }
}

const isConditionFailure = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ConditionalCheckFailedException'

/** One stop event as a LoadCheckCall row. Returns false when somebody logged it first. */
async function putEvent(deps: ProjectorDeps, row: Row): Promise<boolean> {
  try {
    await deps.store.db.send(new PutItemCommand({
      TableName: deps.checkCallTable,
      Item: marshallRow(row),
      ConditionExpression: 'attribute_not_exists(id)',
    }))
    return true
  } catch (err) {
    if (isConditionFailure(err)) return false
    throw err
  }
}

// ── Order references mirrored from the Load ──────────────────────────────────

/** The two Load fields only the driver app writes, as references on the order. */
export const TRAILER_REFERENCE_CODE = 'TRAILER_NUMBER'
export const PAPERWORK_REFERENCE_CODE = 'PAPERWORK_LOCATION'
const MIRRORED_CODES: readonly string[] = [TRAILER_REFERENCE_CODE, PAPERWORK_REFERENCE_CODE]

/** `a.json` comes back as a string through AppSync and as a map from DynamoDB. */
function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return null }
}

/** Trailer number as the driver typed it, '' when none. */
export function trailerOf(load: Row): string {
  return stamped(load.trailerNumber)
}

/** "In trailer 5302" for the stored paperworkLocation, '' when nothing usable is filed. */
export function paperworkPlaceOf(load: Row): string {
  const raw = parseJson(load.paperworkLocation)
  if (!raw || typeof raw !== 'object') return ''
  const loc = raw as { kind?: unknown; unit?: unknown }
  const place = normalizePaperworkLocation(loc)
  // An UNKNOWN place is only the carrier of an in-hand / missing answer: not a location.
  if (!place || place.kind === 'UNKNOWN') return ''
  return paperworkLocationLabel(place)
}

/** The wanted value of each mirrored reference; '' means the reference should not exist. */
function wantedReferences(load: Row): Record<string, string> {
  return {
    [TRAILER_REFERENCE_CODE]: trailerOf(load),
    [PAPERWORK_REFERENCE_CODE]: paperworkPlaceOf(load),
  }
}

const REFERENCE_LABEL: Record<string, string> = {
  [TRAILER_REFERENCE_CODE]: 'Trailer',
  [PAPERWORK_REFERENCE_CODE]: 'Paperwork',
}

/**
 * The order's references with the mirrored ones set to `wanted`. Returns null when
 * the order already says exactly that (compare before write: a replay writes nothing).
 */
export function mergeMirroredReferences(current: unknown, wanted: Record<string, string>): Row[] | null {
  const parsed = parseJson(current)
  const list: Row[] = Array.isArray(parsed) ? (parsed as Row[]) : []
  const kept = list.filter((r) => !MIRRORED_CODES.includes(String(r?.code ?? '')))
  const next: Row[] = [...kept]
  for (const code of MIRRORED_CODES) {
    const value = wanted[code]
    if (!value) continue
    next.push({ code, label: REFERENCE_LABEL[code], value, level: 'ORDER', stopId: null, visibility: 'INTERNAL' })
  }
  const sameValues = MIRRORED_CODES.every((code) => {
    const have = list.filter((r) => String(r?.code ?? '') === code)
    const want = wanted[code]
    return want ? have.length === 1 && String(have[0].value ?? '') === want : have.length === 0
  })
  return sameValues ? null : next
}

/** Set the trailer / paperwork references on the load's order. True when the order was written. */
async function mirrorReferences(deps: ProjectorDeps, load: Row, email: string): Promise<boolean> {
  const orderId = String(load.orderId ?? '')
  if (!orderId) return false
  const order = await getById(deps.store.db, deps.store.tables.order, orderId)
  if (!order) return false
  const next = mergeMirroredReferences(order.references, wantedReferences(load))
  if (!next) return false
  const now = deps.store.now()
  try {
    await transact(deps.store.db, [updateItemTx(deps.store.tables.order, orderId, {
      references: next,
      updatedAt: now,
      updatedBy: email,
      version: (numberOrNull(order.version) ?? 1) + 1,
    }, stamped(order.updatedAt))], 'order')
  } catch (err) {
    if (!isConflict(err)) throw err
    // Staff edited the order between our read and write; their save wins and the
    // next Load change re-runs this comparison.
    console.log('[load-tracking-projector] order moved under us; skipping references', { orderId })
    return false
  }
  return true
}

/** Stamp `Shipment.deliveredAt` once, with the same guard shipment-notifier uses. */
async function stampDelivered(deps: ProjectorDeps, bundle: { shipment: Row; loads: Row[] }, fallback: string): Promise<void> {
  if (bundle.shipment.status !== 'DELIVERED' || stamped(bundle.shipment.deliveredAt)) return
  const at = bundle.loads.map((l) => stamped(l.deliveredAt)).filter(Boolean).sort().pop() || fallback
  try {
    await deps.store.db.send(new UpdateItemCommand({
      TableName: deps.store.tables.shipment,
      Key: marshall({ id: String(bundle.shipment.id) }),
      ...setExpression({ deliveredAt: at, updatedAt: deps.store.now(), updatedBy: PROJECTOR_ACTOR }),
      ConditionExpression: 'attribute_not_exists(deliveredAt)',
    }))
  } catch (err) {
    // The notifier stamped it first: same value, nothing to do.
    if (!isConditionFailure(err)) throw err
  }
}

// ── Projection ───────────────────────────────────────────────────────────────

/**
 * One stream record. Returns what it wrote so the batch summary is honest.
 *
 * Everything is gated on a changed stop image or a changed trailer / paperwork
 * place: a load with no `shipmentId`, an INSERT, a REMOVE, the link UpdateItem
 * (`shipmentId, orderId, loadNumber, leg` only), or any other edit is dropped
 * before a single read — which is also what keeps the projector's own Load
 * write from feeding itself.
 */
async function projectRecord(record: StreamRecord, deps: ProjectorDeps): Promise<ProjectorSummary | null> {
  if (record.eventName !== 'MODIFY') return null
  const newImage = record.dynamodb?.NewImage
  if (!newImage) return null
  const load = unmarshall(newImage) as Row
  const shipmentId = String(load.shipmentId ?? '')
  const loadId = String(load.id ?? '')
  if (!shipmentId || !loadId) return null

  const oldImage = record.dynamodb?.OldImage
  const prev = oldImage ? (unmarshall(oldImage) as Row) : {}
  const stops = readStops(load)
  const events = newStopEvents(stops, readStops(prev))
  const referencesChanged =
    trailerOf(load) !== trailerOf(prev) || paperworkPlaceOf(load) !== paperworkPlaceOf(prev)
  if (events.length === 0 && !referencesChanged) return null

  const summary: ProjectorSummary = { records: 0, considered: 1, events: 0, skipped: 0, statusWrites: 0, conflicts: 0, mirrored: 0 }

  const actor = String(load.updatedBy ?? '').trim() || 'system'
  const driverId = driverIdFor(await deps.drivers(), actor)
  const source = driverId ? 'DRIVER_APP' : 'SYSTEM'
  const createdBy = driverId ? `driver:${driverId}` : actor
  const statusSource: LoadStatusSource = driverId ? 'DRIVER_APP' : 'SYSTEM'

  const now = deps.store.now()
  let statusMoved = false
  let latestAt = ''

  if (events.length > 0) {
    const statusBefore = workflowStatus(load.status)
    const statusAfter = statusAfterCheckCall(stopTimes(stops), statusBefore)

    for (const [index, event] of events.entries()) {
      const last = index === events.length - 1
      const written = await putEvent(deps, {
        __typename: 'LoadCheckCall',
        id: stopEventId(loadId, event.stopId, event.event),
        loadId,
        shipmentId,
        loadCarrierId: load.activeLoadCarrierId ?? null,
        stopId: event.stopId,
        at: event.at,
        type: event.event,
        source,
        statusBefore,
        // Only the event the status landed on claims to have moved the load.
        statusAfter: last ? statusAfter : null,
        city: event.city,
        state: event.state,
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
      if (written) summary.events += 1
      else summary.skipped += 1
    }

    if (statusAfter) {
      const latest = events[events.length - 1]
      latestAt = latest.at
      const patch: Row = {
        status: statusAfter,
        statusChangedAt: now,
        statusChangedBy: createdBy,
        statusSource,
        ...lastKnownPatch(
          {
            at: latest.at,
            type: latest.event,
            source,
            city: latest.city,
            state: latest.state,
          },
          {
            lastKnownAt: load.lastKnownAt as string | null | undefined,
            lastKnownCity: load.lastKnownCity as string | null | undefined,
            lastKnownState: load.lastKnownState as string | null | undefined,
            lastKnownLat: load.lastKnownLat as number | null | undefined,
            lastKnownLng: load.lastKnownLng as number | null | undefined,
          },
        ),
        updatedAt: now,
        updatedBy: PROJECTOR_ACTOR,
      }
      if (statusAfter === 'DELIVERED') patch.deliveredAt = latest.at

      const expectedUpdatedAt = stamped(load.updatedAt)
      const expression = setExpression(patch)
      if (expectedUpdatedAt) expression.ExpressionAttributeValues[':expectedUpdatedAt'] = { S: expectedUpdatedAt }
      try {
        await deps.store.db.send(new UpdateItemCommand({
          TableName: deps.store.tables.load,
          Key: marshall({ id: loadId }),
          ...expression,
          ConditionExpression: expectedUpdatedAt
            ? '#updatedAt = :expectedUpdatedAt'
            : 'attribute_not_exists(updatedAt)',
        }))
        summary.statusWrites += 1
        statusMoved = true
      } catch (err) {
        if (!isConditionFailure(err)) throw err
        // Somebody edited the load between the stamp and this record. Their write
        // carries the status forward through the same ladder; ours would be stale.
        console.log('[load-tracking-projector] load moved under us; skipping status', { loadId })
        summary.conflicts += 1
        return summary
      }
    }
  }

  // A voided or deleted shipment is history: nothing below may touch it.
  const shipment = await getById(deps.store.db, deps.store.tables.shipment, shipmentId)
  if (!shipment || stamped(shipment.voidedAt) || stamped(shipment.deletedAt)) return summary

  let orderMirrored = false
  if (referencesChanged) {
    orderMirrored = await mirrorReferences(deps, load, createdBy)
    if (orderMirrored) summary.mirrored += 1
  }

  // Only after something actually moved: the shipment mirrors a load's state, and
  // a re-derive is a write of its own.
  if (statusMoved || orderMirrored) {
    const bundle = await rederiveShipmentStatus(deps.store, shipmentId, { email: createdBy }) as unknown as { shipment: Row; loads: Row[] }
    if (statusMoved) await stampDelivered(deps, bundle, latestAt || now)
  }
  return summary
}

export async function projectLoadStream(event: StreamEvent, deps: ProjectorDeps): Promise<ProjectorSummary> {
  const total: ProjectorSummary = { records: 0, considered: 0, events: 0, skipped: 0, statusWrites: 0, conflicts: 0, mirrored: 0 }
  for (const record of event.Records ?? []) {
    total.records += 1
    const one = await projectRecord(record, deps)
    if (!one) continue
    total.considered += one.considered
    total.events += one.events
    total.skipped += one.skipped
    total.statusWrites += one.statusWrites
    total.conflicts += one.conflicts
    total.mirrored += one.mirrored
  }
  return total
}

export const handler = async (event: StreamEvent): Promise<ProjectorSummary> => {
  const deps: ProjectorDeps = {
    store: shipmentStoreFromEnv(dynamo),
    checkCallTable: process.env.LOAD_CHECK_CALL_TABLE_NAME ?? '',
    drivers: () => driverRoster(dynamo, process.env.DRIVER_TABLE_NAME ?? ''),
  }
  const summary = await projectLoadStream(event, deps)
  console.log('[load-tracking-projector]', summary)
  return summary
}
