/**
 * DynamoDB side of the dashboard rollup: the DashboardRollup table (rows, dirty markers,
 * leases) and the read-only `MonthSource` / `LiveSource` / `LegacyMonthSource` the pure
 * compute in src/lib/dashboardRollup*.ts is fed from. Index names are Amplify's defaults
 * (`<models>By<Key>And<Sort>`), the same ones the other handlers query.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { CONCURRENCY, batchGet, pages, pool } from '../_shared/ddbReads'
import type {
  BillLite,
  InvoiceLite,
  LiveSource,
  LoadLite,
  MonthSource,
  OrderLite,
  SampleLite,
  ShipmentLite,
} from '../../../src/lib/dashboardRollup'
import type { LegacyLoadLite, LegacyMonthSource } from '../../../src/lib/dashboardRollupLegacy'

export type Row = Record<string, unknown>

/** A table row as the rollup stores it (AWSJSON fields travel as strings). */
export interface RollupRow extends Row {
  id: string
  kind: string
  periodKey: string
  version: number
  schemaVersion?: number
  payload?: string | null
  computedAt?: string
  computeMs?: number
  sourceCounts?: string | null
  dirtyAt?: string
  leaseUntil?: number
}

/** The DashboardRollup table, as the engine needs it. */
export interface RollupStore {
  get(id: string): Promise<RollupRow | undefined>
  /** Every row (the table holds ~100). */
  scanAll(): Promise<RollupRow[]>
  put(row: RollupRow): Promise<void>
  /** Idempotent: `D:<rowId>` gets `dirtyAt = at`. */
  markDirty(rowId: string, at: string): Promise<void>
  /** Deletes `D:<rowId>` only while its `dirtyAt` is still `seenDirtyAt`. False when a newer mark landed. */
  clearDirty(rowId: string, seenDirtyAt: string): Promise<boolean>
  /** One recompute per key at a time: true when this caller now holds `K:<rowId>`. */
  acquireLease(rowId: string, nowSec: number, ttlSec: number): Promise<boolean>
  releaseLease(rowId: string): Promise<void>
}

const isConditionFailure = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ConditionalCheckFailedException'

/** Step AI stores conversational-dashboard specs in this table under 'DASH:<id>' (and 'DASH:INDEX'). */
export const isDashboardRowId = (rowId: string): boolean => rowId.startsWith('DASH:')
export const periodKeyOf = (rowId: string): string => rowId.slice(rowId.indexOf(':') + 1)
export const kindOf = (rowId: string): string => rowId.slice(0, rowId.indexOf(':'))

/** A stamped base for rows the Lambda writes with the SDK (AppSync needs __typename and the timestamps). */
function rowBase(id: string, now: string): Row {
  return { __typename: 'DashboardRollup', id, kind: kindOf(id), periodKey: periodKeyOf(id), createdAt: now, updatedAt: now }
}

export function rollupStore(db: DynamoDBDocumentClient, table: string): RollupStore {
  return {
    async get(id) {
      const out = await db.send(new GetCommand({ TableName: table, Key: { id }, ConsistentRead: true }))
      return out.Item as RollupRow | undefined
    },

    async scanAll() {
      const rows: RollupRow[] = []
      let key: Record<string, unknown> | undefined
      do {
        const out = await db.send(new ScanCommand({
          TableName: table,
          ProjectionExpression: 'id, kind, periodKey, schemaVersion, computedAt, dirtyAt, leaseUntil, version',
          ...(key ? { ExclusiveStartKey: key } : {}),
        }))
        rows.push(...((out.Items ?? []) as RollupRow[]).filter((r) => !isDashboardRowId(r.id)))
        key = out.LastEvaluatedKey
      } while (key)
      return rows
    },

    async put(row) {
      await db.send(new PutCommand({ TableName: table, Item: row }))
    },

    async markDirty(rowId, at) {
      await db.send(new UpdateCommand({
        TableName: table,
        Key: { id: `D:${rowId}` },
        UpdateExpression:
          'SET dirtyAt = :at, #k = :d, periodKey = :p, #t = :tn, updatedAt = :at, version = if_not_exists(version, :zero) + :one, createdAt = if_not_exists(createdAt, :at)',
        ExpressionAttributeNames: { '#k': 'kind', '#t': '__typename' },
        ExpressionAttributeValues: { ':at': at, ':d': 'D', ':p': rowId, ':tn': 'DashboardRollup', ':zero': 0, ':one': 1 },
      }))
    },

    async clearDirty(rowId, seenDirtyAt) {
      try {
        await db.send(new DeleteCommand({
          TableName: table,
          Key: { id: `D:${rowId}` },
          ConditionExpression: 'dirtyAt = :seen',
          ExpressionAttributeValues: { ':seen': seenDirtyAt },
        }))
        return true
      } catch (err) {
        if (isConditionFailure(err)) return false
        throw err
      }
    },

    async acquireLease(rowId, nowSec, ttlSec) {
      const id = `K:${rowId}`
      const now = new Date(nowSec * 1000).toISOString()
      try {
        await db.send(new PutCommand({
          TableName: table,
          Item: { ...rowBase(id, now), kind: 'K', periodKey: rowId, leaseUntil: nowSec + ttlSec, version: 1 },
          ConditionExpression: 'attribute_not_exists(id) OR leaseUntil < :now',
          ExpressionAttributeValues: { ':now': nowSec },
        }))
        return true
      } catch (err) {
        if (isConditionFailure(err)) return false
        throw err
      }
    },

    async releaseLease(rowId) {
      await db.send(new DeleteCommand({ TableName: table, Key: { id: `K:${rowId}` } }))
    },
  }
}

/** A fresh DocumentClient (numbers stay numbers; undefined is dropped). */
export function documentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })
}

// ── Source reads ─────────────────────────────────────────────────────────────

export interface SourceTables {
  shipment: string
  order: string
  load: string
  sample: string
  invoice: string
  carrierBill: string
}

const SHIPMENT_FIELDS = ['id', 'status', 'pickupAppt', 'pickupMonth', 'revDivision', 'revSubdivision', 'voidedAt', 'deletedAt']
const LOAD_FIELDS = ['id', 'shipmentId', 'status', 'pickupAppt', 'revDivision', 'revSubdivision', 'voidedAt', 'pickupDriverId', 'deliveryDriverId', 'rate']
const SAMPLE_FIELDS = ['shipmentId', 'date', 'excluded', 'revenueCents', 'costCents', 'profitCents', 'revDivision', 'revSubdivision', 'podReceivedAt']

const names = (fields: string[]): Record<string, string> => Object.fromEntries(fields.map((f) => [`#${f}`, f]))
const projection = (fields: string[]): string => fields.map((f) => `#${f}`).join(', ')

export interface RollupSource extends MonthSource, LiveSource, LegacyMonthSource {
  shipments(month: string): Promise<ShipmentLite[]>
  loadsOf(shipmentIds: string[]): Promise<Array<LoadLite & LegacyLoadLite>>
}

export function rollupSource(db: DynamoDBDocumentClient, t: SourceTables): RollupSource {
  const shipmentsByIds = async (ids: string[]) => (await batchGet(db, t.shipment, ids, SHIPMENT_FIELDS)) as unknown as ShipmentLite[]
  return {
    async shipments(month) {
      // Voided rows are dropped server-side; a stored explicit NULL counts as not voided.
      const rows = await pages(db, {
        TableName: t.shipment,
        IndexName: 'shipmentsByPickupMonthAndPickupAppt',
        KeyConditionExpression: '#pm = :m',
        FilterExpression: 'attribute_not_exists(#voidedAt) OR attribute_type(#voidedAt, :nul)',
        ProjectionExpression: projection(SHIPMENT_FIELDS),
        ExpressionAttributeNames: { ...names(SHIPMENT_FIELDS), '#pm': 'pickupMonth' },
        ExpressionAttributeValues: { ':m': month, ':nul': 'NULL' },
      })
      return rows as unknown as ShipmentLite[]
    },

    async loadsOf(shipmentIds) {
      const per = await pool([...new Set(shipmentIds)], CONCURRENCY, (shipmentId) =>
        pages(db, {
          TableName: t.load,
          IndexName: 'loadsByShipmentId',
          KeyConditionExpression: '#shipmentId = :s',
          ProjectionExpression: projection(LOAD_FIELDS),
          ExpressionAttributeNames: names(LOAD_FIELDS),
          ExpressionAttributeValues: { ':s': shipmentId },
        }),
      )
      return per.flat() as unknown as Array<LoadLite & LegacyLoadLite>
    },

    async deliveredOrders(shipmentIds) {
      const per = await pool([...new Set(shipmentIds)], CONCURRENCY, (shipmentId) =>
        pages(db, {
          TableName: t.order,
          IndexName: 'ordersByShipmentId',
          KeyConditionExpression: '#s = :s',
          ProjectionExpression: '#s, #d',
          ExpressionAttributeNames: { '#s': 'shipmentId', '#d': 'docsMissing' },
          ExpressionAttributeValues: { ':s': shipmentId },
        }),
      )
      return per.flat() as unknown as OrderLite[]
    },

    async samples(month) {
      const rows = await pages(db, {
        TableName: t.sample,
        IndexName: 'laneRateSamplesBySampleMonthAndDate',
        KeyConditionExpression: '#m = :m',
        ProjectionExpression: projection(SAMPLE_FIELDS),
        ExpressionAttributeNames: { ...names(SAMPLE_FIELDS), '#m': 'sampleMonth' },
        ExpressionAttributeValues: { ':m': month },
      })
      return rows as unknown as SampleLite[]
    },

    shipmentsByIds,

    async loadsByIds(ids) {
      return (await batchGet(db, t.load, ids, LOAD_FIELDS)) as unknown as LoadLite[]
    },

    async openInvoices() {
      const rows = await pages(db, {
        TableName: t.invoice,
        IndexName: 'invoicesByArOpenAndDueAt',
        KeyConditionExpression: '#o = :open',
        ProjectionExpression: '#id, #orderId, #shipmentId, #bal',
        ExpressionAttributeNames: { '#o': 'arOpen', '#id': 'id', '#orderId': 'orderId', '#shipmentId': 'shipmentId', '#bal': 'balanceCents' },
        ExpressionAttributeValues: { ':open': 'OPEN' },
      })
      return rows as unknown as InvoiceLite[]
    },

    async openBills() {
      const rows = await pages(db, {
        TableName: t.carrierBill,
        IndexName: 'carrierBillsByApOpenAndDueAt',
        KeyConditionExpression: '#o = :open',
        ProjectionExpression: '#id, #loadId, #shipmentId, #bal',
        ExpressionAttributeNames: { '#o': 'apOpen', '#id': 'id', '#loadId': 'loadId', '#shipmentId': 'shipmentId', '#bal': 'balanceCents' },
        ExpressionAttributeValues: { ':open': 'OPEN' },
      })
      return rows as unknown as BillLite[]
    },
  }
}
