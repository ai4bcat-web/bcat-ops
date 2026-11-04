/**
 * DynamoDB + S3 EngineStore: the one used by the Lambda worker and by scripts/importAljex.mjs.
 * Transactions map the cancellation reason onto the engine's TxResult so the caller never parses
 * AWS error strings.
 */
import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import type { AljexImportJob, EngineRow, EngineStore, EngineTable, TableSet, TxCondition, TxItem, TxResult } from '../../../../src/types/tms'
import { assertIndexKeys, stampPut } from './stamp'
import { sleep } from './util'

export interface DynamoStoreOptions {
  db: DynamoDBClient
  s3: S3Client
  bucket: string
  tables: TableSet
  now?: () => string
}

const m = (row: EngineRow): Record<string, AttributeValue> => marshall(row, { removeUndefinedValues: true, convertClassInstanceToMap: true })
const THROTTLE = new Set(['ThrottlingError', 'ProvisionedThroughputExceeded', 'TransactionConflict', 'RequestLimitExceeded', 'ThrottlingException'])

function conditionParts(c?: TxCondition): { ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, AttributeValue> } {
  if (!c) return {}
  return {
    ConditionExpression: c.expression,
    ...(c.names && Object.keys(c.names).length ? { ExpressionAttributeNames: { ...c.names } } : {}),
    ...(c.values && Object.keys(c.values).length ? { ExpressionAttributeValues: m(c.values) } : {}),
  }
}

interface UpdateParts {
  UpdateExpression: string
  ExpressionAttributeNames: Record<string, string>
  ExpressionAttributeValues?: Record<string, AttributeValue>
  ConditionExpression?: string
}

/** SET / REMOVE / ADD expression with the caller's condition merged in. */
function buildUpdate(now: string, set: EngineRow | undefined, remove: string[] | undefined, add: Record<string, number> | undefined, cond?: TxCondition): UpdateParts {
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const sets: string[] = []
  const removes: string[] = []
  const adds: string[] = []
  const patch = { ...(set ?? {}) }
  if (patch.updatedAt === undefined) patch.updatedAt = now
  let i = 0
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    names[`#s${i}`] = k
    values[`:s${i}`] = v
    sets.push(`#s${i} = :s${i}`)
    i++
  }
  for (const k of remove ?? []) {
    if (k in patch) continue
    names[`#r${i}`] = k
    removes.push(`#r${i}`)
    i++
  }
  for (const [k, n] of Object.entries(add ?? {})) {
    names[`#a${i}`] = k
    values[`:a${i}`] = n
    adds.push(`#a${i} :a${i}`)
    i++
  }
  const parts: string[] = []
  if (sets.length) parts.push(`SET ${sets.join(', ')}`)
  if (removes.length) parts.push(`REMOVE ${removes.join(', ')}`)
  if (adds.length) parts.push(`ADD ${adds.join(', ')}`)
  const cp = conditionParts(cond)
  Object.assign(names, cp.ExpressionAttributeNames)
  const allValues = { ...values }
  const out: UpdateParts = { UpdateExpression: parts.join(' '), ExpressionAttributeNames: names }
  const marshalled = m(allValues)
  if (cp.ExpressionAttributeValues) Object.assign(marshalled, cp.ExpressionAttributeValues)
  if (Object.keys(marshalled).length) out.ExpressionAttributeValues = marshalled
  if (cp.ConditionExpression) out.ConditionExpression = cp.ConditionExpression
  return out
}

export class DynamoStore implements EngineStore {
  readonly tables: TableSet
  private db: DynamoDBClient
  private s3: S3Client
  private bucket: string
  private clock: () => string

  constructor(opts: DynamoStoreOptions) {
    this.db = opts.db
    this.s3 = opts.s3
    this.bucket = opts.bucket
    this.tables = opts.tables
    this.clock = opts.now ?? (() => new Date().toISOString())
  }

  now(): string {
    return this.clock()
  }

  async getMany(t: EngineTable, ids: string[]): Promise<EngineRow[]> {
    const unique = [...new Set(ids)]
    const out: EngineRow[] = []
    const name = this.tables[t]
    for (let i = 0; i < unique.length; i += 100) {
      let keys: Array<Record<string, AttributeValue>> = unique.slice(i, i + 100).map((id) => m({ id }))
      for (let attempt = 0; keys.length > 0; attempt++) {
        const r = await this.db.send(new BatchGetItemCommand({ RequestItems: { [name]: { Keys: keys } } }))
        out.push(...(r.Responses?.[name] ?? []).map((x) => unmarshall(x)))
        keys = r.UnprocessedKeys?.[name]?.Keys ?? []
        if (keys.length) await sleep(Math.min(2000, 100 * 2 ** attempt))
      }
    }
    return out
  }

  async *scanAll(t: EngineTable, projection?: string[]): AsyncIterable<EngineRow[]> {
    let startKey: Record<string, AttributeValue> | undefined
    const names = projection ? Object.fromEntries(projection.map((p, i) => [`#p${i}`, p])) : undefined
    do {
      const r = await this.db.send(
        new ScanCommand({
          TableName: this.tables[t],
          ExclusiveStartKey: startKey,
          ...(projection ? { ProjectionExpression: Object.keys(names!).join(', '), ExpressionAttributeNames: names } : {}),
        }),
      )
      startKey = r.LastEvaluatedKey
      if (r.Items?.length) yield r.Items.map((x) => unmarshall(x))
    } while (startKey)
  }

  async transact(items: TxItem[], label: string): Promise<TxResult> {
    if (items.length === 0) return { ok: true }
    const now = this.now()
    const writes: TransactWriteItem[] = items.map((it) => {
      const TableName = this.tables[it.table]
      if (it.op === 'put') {
        const row = stampPut(it.table, it.item, now)
        assertIndexKeys(it.table, row)
        const cond = it.ifNotExists ? { expression: 'attribute_not_exists(id)' } : it.condition
        return { Put: { TableName, Item: m(row), ...conditionParts(cond) } }
      }
      if (it.op === 'check') {
        return { ConditionCheck: { TableName, Key: m({ id: it.id }), ...conditionParts(it.condition), ConditionExpression: it.condition.expression } }
      }
      if (it.set) assertIndexKeys(it.table, { id: it.id, ...it.set })
      return { Update: { TableName, Key: m({ id: it.id }), ...buildUpdate(now, it.set, it.remove, it.add, it.condition) } }
    })
    try {
      await this.db.send(new TransactWriteItemsCommand({ TransactItems: writes }))
      return { ok: true }
    } catch (err) {
      const e = err as { name?: string; message?: string; CancellationReasons?: Array<{ Code?: string }> }
      if (e.name === 'TransactionCanceledException') {
        const reasons = e.CancellationReasons ?? []
        const failedIndex = reasons.findIndex((r) => r.Code === 'ConditionalCheckFailed')
        if (failedIndex >= 0) return { ok: false, reason: 'CONDITION', failedIndex }
        if (reasons.some((r) => r.Code && THROTTLE.has(r.Code))) return { ok: false, reason: 'THROTTLED', message: `${label}: throttled` }
        return { ok: false, reason: 'ERROR', message: `${label}: ${(e.message ?? '').slice(0, 300)}` }
      }
      if (e.name && THROTTLE.has(e.name)) return { ok: false, reason: 'THROTTLED', message: `${label}: throttled` }
      return { ok: false, reason: 'ERROR', message: `${label}: ${e.name ?? 'Error'} ${(e.message ?? '').slice(0, 300)}` }
    }
  }

  async batchPut(t: EngineTable, rows: EngineRow[]): Promise<void> {
    const name = this.tables[t]
    const now = this.now()
    const requests = rows.map((r) => {
      const row = stampPut(t, r, now)
      assertIndexKeys(t, row)
      return { PutRequest: { Item: m(row) } }
    })
    for (let i = 0; i < requests.length; i += 25) {
      let batch = requests.slice(i, i + 25)
      for (let attempt = 0; batch.length > 0; attempt++) {
        const r = await this.db.send(new BatchWriteItemCommand({ RequestItems: { [name]: batch } }))
        batch = (r.UnprocessedItems?.[name] ?? []) as typeof batch
        if (batch.length) await sleep(Math.min(2000, 100 * 2 ** attempt))
      }
    }
  }

  async update(t: EngineTable, id: string, patch: EngineRow, cond?: TxCondition): Promise<boolean> {
    assertIndexKeys(t, { id, ...patch })
    try {
      await this.db.send(new UpdateItemCommand({ TableName: this.tables[t], Key: m({ id }), ...buildUpdate(this.now(), patch, undefined, undefined, cond) }))
      return true
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false
      throw err
    }
  }

  async putJob(job: AljexImportJob): Promise<void> {
    const row = stampPut('aljexImportJob', job as unknown as EngineRow, this.now())
    await this.db.send(new PutItemCommand({ TableName: this.tables.aljexImportJob, Item: m({ ...row, updatedAt: this.now() }) }))
  }

  async putObject(key: string, body: Uint8Array | string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }))
  }

  async *getObject(key: string): AsyncIterable<Uint8Array> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    const body = r.Body as AsyncIterable<Uint8Array> | undefined
    if (!body) throw new Error(`Empty S3 object: ${key}`)
    yield* body
  }
}
