/**
 * tms-spot-quoter — every DynamoDB call this Lambda makes, behind one interface.
 *
 * `SpotStore` is what the pipeline, the actions and the reconcile pass program against;
 * `createDynamoStore` is the only implementation that touches AWS. Tests pass an
 * in-memory implementation (memoryStore.ts), so what is asserted is *which rows were
 * written*, not which commands were sent.
 *
 * Write surface (least privilege, mirrored by backend.ts IAM): GmailConnection,
 * SpotRequest, SpotSettings (RW); AuditLog (Put). Customer, Quote, TmsSettings,
 * Integration, UserProfile are read-only here — a Quote is only ever created by a rep's
 * browser or by the SPOT_AUTO_QUOTE door in tms-shipment-actions.
 *
 * Amplify `a.json()` columns are written as native maps/lists by every Lambda in this
 * repo; `jsonOf` tolerates the string form too.
 */
import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import type {
  GmailConnectionRecord,
  SpotRequestRecord,
  SpotRequestStatus,
  SpotSettingsRecord,
} from '../../../src/types/tms'

export type Row = Record<string, unknown>

export const IS_DEV_STACK = process.env.BCAT_DEV_STACK === 'true'

const t = (name: string): string => process.env[name] ?? ''

export const IDX_REQUESTS_BY_USER = 'spotRequestsByUserIdAndReceivedAt'
export const IDX_REQUESTS_BY_THREAD = 'spotRequestsByGmailThreadId'

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function isConditionalFailure(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException')
}

/** `a.json()` read back: native value, or a JSON string some other writer left. */
export function jsonOf<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }
  return value as T
}

export interface RequestUpdateGuard {
  /** The write only lands while the row is in one of these statuses. */
  statusIn?: SpotRequestStatus[]
  expectedVersion?: number
}

export interface SpotStore {
  /** The DocumentClient the CRM store writes with; null for in-memory stores. */
  readonly db: unknown

  getSpotSettings(): Promise<SpotSettingsRecord | null>
  putSpotSettings(row: SpotSettingsRecord, expectedVersion?: number): Promise<SpotSettingsRecord>

  getConnection(userId: string): Promise<GmailConnectionRecord | null>
  listConnections(): Promise<GmailConnectionRecord[]>
  putConnection(row: GmailConnectionRecord): Promise<void>
  updateConnection(userId: string, patch: Row, expectedVersion?: number): Promise<GmailConnectionRecord>
  /** Stamp `lastPollStartedAt`; false when another run holds the connection (started after `staleBefore`). */
  claimPoll(userId: string, startedAt: string, staleBefore: string): Promise<boolean>

  getRequest(id: string): Promise<SpotRequestRecord | null>
  /** False when the row already existed. */
  putRequestIfAbsent(row: SpotRequestRecord): Promise<boolean>
  updateRequest(id: string, patch: Row, guard?: RequestUpdateGuard): Promise<SpotRequestRecord>
  requestsByThread(threadId: string): Promise<SpotRequestRecord[]>
  requestsByUser(userId: string, opts?: { status?: SpotRequestStatus; limit?: number }): Promise<SpotRequestRecord[]>
  requestsByStatus(status: SpotRequestStatus, limit?: number): Promise<SpotRequestRecord[]>
  deleteRequest(id: string): Promise<void>

  getCustomer(id: string): Promise<Row | null>
  getQuote(id: string): Promise<Row | null>
  getUserProfile(id: string): Promise<Row | null>
  getTmsSettings(): Promise<Row | null>
  getIntegration(provider: string): Promise<Row | null>

  /** Best effort, never throws. `changes` must not contain message text or tokens. */
  writeAudit(entityType: string, entityId: string, action: string, actorEmail: string, changes: Row): Promise<void>
}

export function createDynamoStore(): SpotStore {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  })
  const SETTINGS = (): string => t('SPOT_SETTINGS_TABLE_NAME')
  const CONNECTION = (): string => t('GMAIL_CONNECTION_TABLE_NAME')
  const REQUEST = (): string => t('SPOT_REQUEST_TABLE_NAME')

  async function get(table: string, id: string): Promise<Row | null> {
    if (!table) return null
    const got = await db.send(new GetCommand({ TableName: table, Key: { id } }))
    return (got.Item as Row | undefined) ?? null
  }

  /** SET every defined key (version bumped), optional guard; returns the new row. */
  async function patchRow(
    table: string,
    id: string,
    patch: Row,
    guard: { statusIn?: string[]; expectedVersion?: number; mustExist?: boolean } = {},
  ): Promise<Row> {
    const names: Record<string, string> = { '#version': 'version', '#updatedAt': 'updatedAt' }
    const values: Row = { ':one': 1, ':zero': 0, ':now': nowIso() }
    const sets = ['#version = if_not_exists(#version, :zero) + :one', '#updatedAt = :now']
    const removes: string[] = []
    let n = 0
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || key === 'id' || key === 'version') continue
      const nk = `#k${n}`
      names[nk] = key
      if (value === null) {
        removes.push(nk)
      } else {
        const vk = `:v${n}`
        values[vk] = value
        sets.push(`${nk} = ${vk}`)
      }
      n += 1
    }
    const conditions = ['attribute_exists(id)']
    if (guard.statusIn?.length) {
      names['#status'] = 'status'
      conditions.push(`#status IN (${guard.statusIn.map((s, i) => { values[`:s${i}`] = s; return `:s${i}` }).join(', ')})`)
    }
    if (guard.expectedVersion !== undefined) {
      values[':ev'] = guard.expectedVersion
      conditions.push('(attribute_not_exists(#version) AND :ev = :zero OR #version = :ev)')
    }
    try {
      const out = await db.send(new UpdateCommand({
        TableName: table,
        Key: { id },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }))
      return out.Attributes as Row
    } catch (err) {
      if (isConditionalFailure(err)) throw new ConflictError('The row changed since you read it; reload and try again')
      throw err
    }
  }

  async function queryAll(
    table: string,
    index: string,
    field: string,
    value: string,
    opts: { limit?: number; ascending?: boolean; sortField?: string } = {},
  ): Promise<Row[]> {
    const out: Row[] = []
    let key: Record<string, unknown> | undefined
    do {
      const page = await db.send(new QueryCommand({
        TableName: table,
        IndexName: index,
        KeyConditionExpression: '#f = :v',
        ExpressionAttributeNames: { '#f': field },
        ExpressionAttributeValues: { ':v': value },
        ScanIndexForward: opts.ascending ?? false,
        ExclusiveStartKey: key,
      }))
      out.push(...((page.Items ?? []) as Row[]))
      key = page.LastEvaluatedKey
    } while (key && (opts.limit === undefined || out.length < opts.limit))
    return opts.limit === undefined ? out : out.slice(0, opts.limit)
  }

  return {
    db,

    async getSpotSettings() {
      return (await get(SETTINGS(), 'default')) as SpotSettingsRecord | null
    },
    async putSpotSettings(row, expectedVersion) {
      const next = { ...row, id: 'default', version: (row.version ?? 0) + 1, updatedAt: nowIso() }
      try {
        await db.send(new PutCommand({
          TableName: SETTINGS(),
          Item: next,
          ...(expectedVersion === undefined
            ? {}
            : {
                ConditionExpression: expectedVersion === 0
                  ? 'attribute_not_exists(id) OR attribute_not_exists(#version) OR #version = :ev'
                  : '#version = :ev',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':ev': expectedVersion },
              }),
        }))
      } catch (err) {
        if (isConditionalFailure(err)) throw new ConflictError('Settings changed since you opened them; reload and try again')
        throw err
      }
      return next
    },

    async getConnection(userId) {
      return (await get(CONNECTION(), userId)) as GmailConnectionRecord | null
    },
    async listConnections() {
      const out: Row[] = []
      let key: Record<string, unknown> | undefined
      do {
        const page = await db.send(new ScanCommand({ TableName: CONNECTION(), ExclusiveStartKey: key }))
        out.push(...((page.Items ?? []) as Row[]))
        key = page.LastEvaluatedKey
      } while (key)
      return out as unknown as GmailConnectionRecord[]
    },
    async putConnection(row) {
      await db.send(new PutCommand({ TableName: CONNECTION(), Item: { ...row, updatedAt: nowIso() } }))
    },
    async updateConnection(userId, patch, expectedVersion) {
      return (await patchRow(CONNECTION(), userId, patch, { expectedVersion })) as unknown as GmailConnectionRecord
    },
    async claimPoll(userId, startedAt, staleBefore) {
      try {
        await db.send(new UpdateCommand({
          TableName: CONNECTION(),
          Key: { id: userId },
          UpdateExpression: 'SET lastPollStartedAt = :s',
          ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(lastPollStartedAt) OR lastPollStartedAt < :stale)',
          ExpressionAttributeValues: { ':s': startedAt, ':stale': staleBefore },
        }))
        return true
      } catch (err) {
        if (isConditionalFailure(err)) return false
        throw err
      }
    },

    async getRequest(id) {
      return (await get(REQUEST(), id)) as SpotRequestRecord | null
    },
    async putRequestIfAbsent(row) {
      try {
        await db.send(new PutCommand({
          TableName: REQUEST(),
          Item: { ...row, updatedAt: nowIso() },
          ConditionExpression: 'attribute_not_exists(id)',
        }))
        return true
      } catch (err) {
        if (isConditionalFailure(err)) return false
        throw err
      }
    },
    async updateRequest(id, patch, guard) {
      return (await patchRow(REQUEST(), id, patch, guard)) as unknown as SpotRequestRecord
    },
    async requestsByThread(threadId) {
      if (!threadId) return []
      return (await queryAll(REQUEST(), IDX_REQUESTS_BY_THREAD, 'gmailThreadId', threadId)) as unknown as SpotRequestRecord[]
    },
    async requestsByUser(userId, opts = {}) {
      const rows = (await queryAll(REQUEST(), IDX_REQUESTS_BY_USER, 'userId', userId)) as unknown as SpotRequestRecord[]
      const filtered = opts.status ? rows.filter((r) => r.status === opts.status) : rows
      return opts.limit === undefined ? filtered : filtered.slice(0, opts.limit)
    },
    async requestsByStatus(status, limit) {
      const out: Row[] = []
      let key: Record<string, unknown> | undefined
      do {
        const page = await db.send(new ScanCommand({
          TableName: REQUEST(),
          FilterExpression: '#s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status },
          ExclusiveStartKey: key,
        }))
        out.push(...((page.Items ?? []) as Row[]))
        key = page.LastEvaluatedKey
      } while (key && (limit === undefined || out.length < limit))
      const rows = out as unknown as SpotRequestRecord[]
      return limit === undefined ? rows : rows.slice(0, limit)
    },
    async deleteRequest(id) {
      await db.send(new DeleteCommand({ TableName: REQUEST(), Key: { id } }))
    },

    getCustomer: (id) => get(t('CUSTOMER_TABLE_NAME'), id),
    getQuote: (id) => get(t('QUOTE_TABLE_NAME'), id),
    getUserProfile: (id) => get(t('USER_PROFILE_TABLE_NAME'), id),
    getTmsSettings: () => get(t('TMS_SETTINGS_TABLE_NAME'), 'default'),
    getIntegration: (provider) => get(t('INTEGRATION_TABLE_NAME'), provider),

    async writeAudit(entityType, entityId, action, actorEmail, changes) {
      const table = t('AUDIT_LOG_TABLE_NAME')
      if (!table) return
      const now = nowIso()
      try {
        await db.send(new PutCommand({
          TableName: table,
          Item: {
            id: randomUUID(),
            entityType,
            entityId,
            action,
            user: actorEmail,
            changes: JSON.stringify(changes),
            createdAt: now,
            updatedAt: now,
            __typename: 'AuditLog',
          },
        }))
      } catch (err) {
        console.warn('[tms-spot-quoter] audit write failed:', String(err))
      }
    },
  }
}
