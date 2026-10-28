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
 *   • the only writes are LoadCheckCall (Put), Load (Update) and — through
 *     `rederiveShipmentStatus` — Shipment. No Slack, no Twilio, no SES, which is
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
  readStops,
  rederiveShipmentStatus,
  shipmentStoreFromEnv,
  marshallRow,
  type Row,
  type ShipmentStoreDeps,
  type StopShape,
} from '../_shared/shipmentStore'
import { lastKnownPatch, statusAfterCheckCall, stopEventId } from '../../../src/lib/checkCalls'
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

// ── Projection ───────────────────────────────────────────────────────────────

/**
 * One stream record. Returns what it wrote so the batch summary is honest.
 *
 * Everything is gated on a changed stop image: a load with no `shipmentId`, an
 * INSERT, a REMOVE, or any edit that left the stop times alone is dropped before
 * a single read — which is what keeps the projector's own Load write from
 * feeding itself.
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
  if (events.length === 0) return null

  const summary: ProjectorSummary = { records: 0, considered: 1, events: 0, skipped: 0, statusWrites: 0, conflicts: 0 }

  const actor = String(load.updatedBy ?? '').trim() || 'system'
  const driverId = driverIdFor(await deps.drivers(), actor)
  const source = driverId ? 'DRIVER_APP' : 'SYSTEM'
  const createdBy = driverId ? `driver:${driverId}` : actor
  const statusSource: LoadStatusSource = driverId ? 'DRIVER_APP' : 'SYSTEM'

  const statusBefore = workflowStatus(load.status)
  const statusAfter = statusAfterCheckCall(stopTimes(stops), statusBefore)
  const now = deps.store.now()

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

  if (!statusAfter) return summary

  const latest = events[events.length - 1]
  const patch: Row = {
    status: statusAfter,
    statusChangedAt: now,
    statusChangedBy: createdBy,
    statusSource,
    ...lastKnownPatch({
      at: latest.at,
      type: latest.event,
      source,
      city: latest.city,
      state: latest.state,
    }),
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
  } catch (err) {
    if (!isConditionFailure(err)) throw err
    // Somebody edited the load between the stamp and this record. Their write
    // carries the status forward through the same ladder; ours would be stale.
    console.log('[load-tracking-projector] load moved under us; skipping status', { loadId })
    summary.conflicts += 1
    return summary
  }

  // Only after a status actually moved: the shipment mirrors a load's state, and
  // a re-derive is a write of its own.
  await rederiveShipmentStatus(deps.store, shipmentId, { email: createdBy })
  return summary
}

export async function projectLoadStream(event: StreamEvent, deps: ProjectorDeps): Promise<ProjectorSummary> {
  const total: ProjectorSummary = { records: 0, considered: 0, events: 0, skipped: 0, statusWrites: 0, conflicts: 0 }
  for (const record of event.Records ?? []) {
    total.records += 1
    const one = await projectRecord(record, deps)
    if (!one) continue
    total.considered += one.considered
    total.events += one.events
    total.skipped += one.skipped
    total.statusWrites += one.statusWrites
    total.conflicts += one.conflicts
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
