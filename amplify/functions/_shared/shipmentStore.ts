/**
 * DynamoDB access for the shipment tables, shared by every Lambda that reads a
 * shipment bundle or re-derives a shipment's status from its legs.
 *
 * These helpers started in tms-shipment-actions and are unchanged: Shipment,
 * Order, LoadCarrier, LoadFinancials and LoadCharge are read and written with the
 * raw DynamoDB SDK, in a TransactWriteItems whenever more than one of them has to
 * move together. Nothing in here reaches for AppSync, Cognito, S3 or SES, so a
 * worker Lambda can call them with nothing but a DynamoDBClient and the same six
 * table-name environment variables.
 *
 * Index names follow Amplify's convention: <models>By<Field>[And<SortKey>].
 */
import {
  BatchGetItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type DynamoDBClient,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

import { shipmentStatusFromLoads } from '../../../src/lib/shipmentStatus'
import type { LoadCarrierStatus, LoadWorkflowStatus, ShipmentStatus } from '../../../src/types/tms'

export type Row = Record<string, unknown>

// Amplify derives GSI names from the plural model name and the key fields.
export const IDX_ORDERS_BY_SHIPMENT = 'ordersByShipmentId'
export const IDX_LOADS_BY_SHIPMENT = 'loadsByShipmentId'
export const IDX_CARRIERS_BY_SHIPMENT = 'loadCarriersByShipmentId'
export const IDX_CHARGES_BY_SHIPMENT = 'loadChargesByShipmentIdAndSortOrder'
export const IDX_DOCUMENTS_BY_SHIPMENT = 'shipmentDocumentsByShipmentIdAndUploadedAt'

/** DynamoDB refuses a transaction longer than this, so say so before it does. */
export const MAX_TRANSACT_ITEMS = 100

export interface ShipmentTables {
  shipment: string
  order: string
  load: string
  loadCarrier: string
  loadFinancials: string
  loadCharge: string
  /**
   * Step E. Set to the empty string by the Lambdas that read a bundle without the
   * ShipmentDocument grant: they get no documents rather than a failed read.
   */
  shipmentDocument: string
}

/**
 * Client, tables and clock in one object, so a second Lambda is one line of wiring:
 * `const store = shipmentStoreFromEnv(dynamo)`.
 */
export interface ShipmentStoreDeps {
  db: DynamoDBClient
  tables: ShipmentTables
  now: () => string
}

export function shipmentTablesFromEnv(env: NodeJS.ProcessEnv = process.env): ShipmentTables {
  return {
    shipment: env.SHIPMENT_TABLE_NAME ?? '',
    order: env.ORDER_TABLE_NAME ?? '',
    load: env.LOAD_TABLE_NAME ?? '',
    loadCarrier: env.LOAD_CARRIER_TABLE_NAME ?? '',
    loadFinancials: env.LOAD_FINANCIALS_TABLE_NAME ?? '',
    loadCharge: env.LOAD_CHARGE_TABLE_NAME ?? '',
    shipmentDocument: env.SHIPMENT_DOCUMENT_TABLE_NAME ?? '',
  }
}

export function shipmentStoreFromEnv(
  db: DynamoDBClient,
  env: NodeJS.ProcessEnv = process.env,
  now: () => string = nowIso,
): ShipmentStoreDeps {
  return { db, tables: shipmentTablesFromEnv(env), now }
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly. */
export function conflictError(itemLabel: string, cause: unknown): Error {
  const err = new Error(`This ${itemLabel} was changed by someone else. Reload and try again.`)
  ;(err as Error & { cause?: unknown }).cause = cause
  return err
}

export function isConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('ConditionalCheckFailed') || msg.includes('TransactionCanceled')
}

export function monthOf(appt: string | null | undefined): string | null {
  if (!appt) return null
  const m = /^(\d{4}-\d{2})/.exec(appt)
  return m ? m[1] : null
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// ── DynamoDB helpers ─────────────────────────────────────────────────────────

export async function getById(db: DynamoDBClient, tableName: string, id: string): Promise<Row | null> {
  if (!tableName) throw new Error('Table name is not configured')
  const result = await db.send(new GetItemCommand({ TableName: tableName, Key: marshall({ id }) }))
  return result.Item ? unmarshall(result.Item) : null
}

export async function queryIndex(
  db: DynamoDBClient,
  tableName: string,
  indexName: string,
  keyName: string,
  keyValue: string,
): Promise<Row[]> {
  if (!tableName) throw new Error('Table name is not configured')
  const items: Row[] = []
  let lastKey: Record<string, AttributeValue> | undefined
  do {
    const result = await db.send(
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

export async function batchGetByIds(db: DynamoDBClient, tableName: string, ids: string[]): Promise<Row[]> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return []
  const out: Row[] = []
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100)
    let keys = chunk.map((id) => marshall({ id }))
    // BatchGetItem may return part of the request; the rest comes back as unprocessed.
    for (let attempt = 0; attempt < 4 && keys.length > 0; attempt++) {
      const result = await db.send(
        new BatchGetItemCommand({ RequestItems: { [tableName]: { Keys: keys } } }),
      )
      const got = result.Responses?.[tableName] ?? []
      out.push(...got.map((item) => unmarshall(item)))
      keys = result.UnprocessedKeys?.[tableName]?.Keys ?? []
    }
  }
  return out
}

export function marshallRow(item: Row): Record<string, AttributeValue> {
  return marshall(item, { removeUndefinedValues: true })
}

export function putItem(tableName: string, item: Row, guardNew = true): TransactWriteItem {
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
export function casCondition(values: Record<string, AttributeValue>, expectedUpdatedAt: string): string {
  values[':casExpectedUpdatedAt'] = { S: expectedUpdatedAt }
  values[':casEmpty'] = { S: '' }
  return '((attribute_exists(updatedAt) AND updatedAt = :casExpectedUpdatedAt) OR (attribute_not_exists(updatedAt) AND :casExpectedUpdatedAt = :casEmpty))'
}

/**
 * Build a SET/REMOVE update for every own key of `patch`, with a CAS guard on updatedAt.
 *
 * `remove` is how a field LEAVES the row instead of being set to null, which is
 * what a sparse index hash key such as `apOpen` or `checkCallOpen` requires:
 * DynamoDB answers `Type mismatch for Index Key … Actual: NULL` and refuses the
 * write. Same shape the finance router's `updateTx` uses.
 */
export function updateItemTx(
  tableName: string,
  id: string,
  patch: Row,
  expectedUpdatedAt: string | null,
  options: { remove?: string[] } = {},
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
  const removes: string[] = []
  for (const key of options.remove ?? []) {
    // A key on both sides would be two actions on one attribute, which DynamoDB
    // rejects; the patch wins, because it is the explicit value.
    if (key in patch) continue
    names[`#${key}`] = key
    removes.push(`#${key}`)
  }
  const parts: string[] = []
  if (sets.length > 0) parts.push(`SET ${sets.join(', ')}`)
  if (removes.length > 0) parts.push(`REMOVE ${removes.join(', ')}`)
  // Before the item is built: the guard seeds `values` with what it compares against.
  const condition = expectedUpdatedAt == null ? null : casCondition(values, expectedUpdatedAt)
  return {
    Update: {
      TableName: tableName,
      Key: marshall({ id }),
      UpdateExpression: parts.join(' '),
      ExpressionAttributeNames: names,
      ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
      ...(condition == null ? {} : { ConditionExpression: condition }),
    },
  }
}

export function deleteItemTx(tableName: string, id: string): TransactWriteItem {
  return { Delete: { TableName: tableName, Key: marshall({ id }) } }
}

/**
 * Guard a row this transaction does not itself write: the whole thing is refused
 * if that row has moved since we read it. Used for the Load behind a booking,
 * whose own mutation goes through AppSync a moment later.
 */
export function conditionCheckUpdatedAtTx(tableName: string, id: string, expectedUpdatedAt: string): TransactWriteItem {
  const values: Record<string, AttributeValue> = {}
  const ConditionExpression = casCondition(values, expectedUpdatedAt)
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: marshall({ id }),
      ConditionExpression,
      ExpressionAttributeValues: values,
    },
  }
}

/**
 * What to say when one particular item in the transaction is the one that was
 * refused, indexed exactly like `items`.
 *
 * A conditional put inside a transaction carries a rule — the PRO claim's
 * `attribute_not_exists(id)` is "this PRO has already been issued" — and the
 * generic "changed by someone else" sentence tells the operator to reload and
 * retry, which is the one thing that will never work. DynamoDB reports which
 * index failed in `CancellationReasons`; this is how a caller reads it.
 */
export interface TransactOptions {
  refusals?: (string | null | undefined)[]
}

/** The refusal the caller wrote for whichever item DynamoDB says failed its check. */
function refusalFor(err: unknown, refusals: (string | null | undefined)[] | undefined): string | null {
  if (!refusals) return null
  const reasons = (err as { CancellationReasons?: { Code?: string }[] } | null)?.CancellationReasons
  if (!Array.isArray(reasons)) return null
  for (let i = 0; i < reasons.length; i++) {
    if (reasons[i]?.Code === 'ConditionalCheckFailed' && refusals[i]) return String(refusals[i])
  }
  return null
}

export async function transact(
  db: DynamoDBClient,
  items: TransactWriteItem[],
  label: string,
  options: TransactOptions = {},
): Promise<void> {
  if (items.length === 0) return
  if (items.length > MAX_TRANSACT_ITEMS) {
    throw new Error(`${label} needs ${items.length} writes; the transaction limit is ${MAX_TRANSACT_ITEMS}`)
  }
  try {
    await db.send(new TransactWriteItemsCommand({ TransactItems: items }))
  } catch (err) {
    const refused = refusalFor(err, options.refusals)
    // The sentence the caller wrote is what the operator reads; the DynamoDB
    // cancellation stays attached as the cause so the log still says which item failed.
    // ES2020 lib lacks the ErrorOptions constructor, so the cause is attached explicitly
    // — the same shape `conflictError` above uses.
    if (refused) {
      const err2 = new Error(refused)
      ;(err2 as Error & { cause?: unknown }).cause = err
      throw err2
    }
    if (isConflict(err)) throw conflictError(label, err)
    throw err
  }
}

// ── Stops ────────────────────────────────────────────────────────────────────

export interface StopShape {
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
export function readStops(load: Row): StopShape[] {
  let v = load.stops
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { break }
  }
  if (!Array.isArray(v)) return []
  return v
    .filter((s): s is StopShape => !!s && typeof s === 'object')
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}

// ── Bundle ───────────────────────────────────────────────────────────────────

export interface Bundle {
  shipment: Row
  orders: Row[]
  loads: Row[]
  loadCarriers: Row[]
  charges: Row[]
  financials: Row[]
  /** Step E: every file the shipment has, oldest first. */
  documents: Row[]
}

/**
 * The shipment's document index. Lambdas that read a bundle without the
 * ShipmentDocument grant — the tracking projector, the notifier — get an empty
 * list rather than a failure, because nothing they do looks at paperwork.
 */
export async function queryShipmentDocuments(
  db: DynamoDBClient,
  tableName: string,
  shipmentId: string,
): Promise<Row[]> {
  if (!tableName) return []
  const documents = await queryIndex(db, tableName, IDX_DOCUMENTS_BY_SHIPMENT, 'shipmentId', shipmentId)
  documents.sort((a, b) => String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')))
  return documents
}

export async function readBundle(deps: ShipmentStoreDeps, shipmentId: string): Promise<Bundle> {
  const { db, tables } = deps
  const shipment = await getById(db, tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  const [orders, loads, loadCarriers, charges, documents] = await Promise.all([
    queryIndex(db, tables.order, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId),
    queryIndex(db, tables.load, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId),
    queryIndex(db, tables.loadCarrier, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId),
    queryIndex(db, tables.loadCharge, IDX_CHARGES_BY_SHIPMENT, 'shipmentId', shipmentId),
    queryShipmentDocuments(db, tables.shipmentDocument, shipmentId),
  ])
  // LoadFinancials.id IS the load id, so the totals come back in one BatchGet.
  const financials = await batchGetByIds(db, tables.loadFinancials, loads.map((l) => String(l.id)))
  loads.sort((a, b) => Number(a.leg ?? 0) - Number(b.leg ?? 0))
  charges.sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
  return { shipment, orders, loads, loadCarriers, charges, financials, documents }
}

// ── Shipment mirrors ─────────────────────────────────────────────────────────

/**
 * The board shows one row per shipment, so the shipment carries a copy of the
 * first pickup and the last delivery across its legs. They are mirrors: the stops
 * on the loads are the truth, and these are rewritten whenever a stop moves.
 */
export function shipmentMirrors(loads: Row[]): Row {
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
export function buildSearchKey(shipment: Row, orders: Row[], loads: Row[]): string {
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

/**
 * Re-derive the shipment's status from its legs after any load-level change.
 * Sticky states (draft, tender, hold, cancel) are left alone — a truck arriving
 * does not take a shipment off hold.
 */
export async function rederiveShipmentStatus(
  deps: ShipmentStoreDeps,
  shipmentId: string,
  caller: { email: string },
): Promise<Row> {
  const bundle = await readBundle(deps, shipmentId)
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
  const now = deps.now()
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
  await transact(deps.db, [updateItemTx(deps.tables.shipment, shipmentId, patch, null)], 'shipment')
  return readBundle(deps, shipmentId) as unknown as Row
}
