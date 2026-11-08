/**
 * Step AI — where dashboard specs live: rows of the EXISTING DashboardRollup table, ids
 * 'DASH:<uuid>' (one per dashboard) and 'DASH:INDEX' (the summary list). No new model.
 *
 * Why an index row: the table also holds ~100 rollup rows of 15-90 KB, so a Scan to list
 * dashboards would read megabytes. LIST is one GetItem of the index; GET is one GetItem of the
 * row; a write is ONE TransactWriteItems (row CAS on `version` + index CAS on its own `version`),
 * so the two cannot drift. The index holds ACTIVE dashboards only (archive removes the entry
 * and stamps the row), ≤ 200 entries (enforced by the caller).
 *
 * The rollup sweep and the client rollup reader ignore every 'DASH:' id.
 */
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import type { DashboardScope, DashboardSpec, DashboardSummary, ScopeKind } from '../../../src/lib/dashboards/types'
import type { Db, Row } from '../_shared/crmStore'

export const DASH_PREFIX = 'DASH:'
export const DASH_INDEX_ID = 'DASH:INDEX'
export const MAX_ACTIVE_DASHBOARDS = 200
export const MAX_PER_OWNER = 50

export const CONFLICT_ERROR = 'Conflict: dashboard changed; reload'

/** A dashboard as stored (the payload JSON plus the row's version/timestamps). */
export interface StoredDashboard {
  /** Bare uuid; the row id is `DASH:<id>`. */
  id: string
  title: string
  scope: ScopeKind
  ownerId: string
  ownerName: string | null
  sharedWith: { userIds: string[]; teamKeys: string[] }
  spec: DashboardSpec
  specVersion: 1
  widgetCount: number
  createdBy: string
  updatedBy: string
  archivedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface DashStore {
  /** Active dashboards' summaries (one read). */
  index(): Promise<DashboardSummary[]>
  get(id: string): Promise<StoredDashboard | null>
  /**
   * Writes `rec` (and the index) atomically. `expectedVersion` null = create (the id must not
   * exist); otherwise the stored version must equal it. Throws `CONFLICT_ERROR` on mismatch.
   * The caller sets `rec.version = expectedVersion + 1` (0 + 1 on create) and the timestamps.
   */
  commit(rec: StoredDashboard, expectedVersion: number | null): Promise<void>
}

export function summaryOf(rec: StoredDashboard): DashboardSummary {
  return {
    id: rec.id,
    title: rec.title,
    scope: rec.scope,
    ownerId: rec.ownerId,
    ownerName: rec.ownerName,
    sharedWith: rec.sharedWith,
    widgetCount: rec.widgetCount,
    updatedAt: rec.updatedAt,
    version: rec.version,
  }
}

export function scopeKindOf(scope: DashboardScope): ScopeKind {
  return scope.kind
}

interface IndexRow extends Row {
  version?: number
  payload?: unknown
}

function parseIndex(row: IndexRow | undefined): { version: number; items: DashboardSummary[] } {
  if (!row) return { version: 0, items: [] }
  const raw = typeof row.payload === 'string' ? safeJson(row.payload) : row.payload
  const list = raw && typeof raw === 'object' && 'items' in raw ? raw.items : null
  const items = Array.isArray(list) ? (list as DashboardSummary[]) : []
  return { version: typeof row.version === 'number' ? row.version : 0, items }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const isCanceled = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'TransactionCanceledException' || err.name === 'ConditionalCheckFailedException')

export function dashStore(db: Db, table: string): DashStore {
  const getRow = async (id: string): Promise<Row | undefined> =>
    (await db.send(new GetCommand({ TableName: table, Key: { id }, ConsistentRead: true }))).Item as Row | undefined

  return {
    async index() {
      return parseIndex((await getRow(DASH_INDEX_ID)) as IndexRow | undefined).items
    },

    async get(id) {
      const row = await getRow(`${DASH_PREFIX}${id}`)
      if (!row) return null
      const body = (typeof row.payload === 'string' ? safeJson(row.payload) : row.payload) as Row | null
      if (!body || typeof body !== 'object') return null
      return {
        ...(body as unknown as StoredDashboard),
        id,
        version: typeof row.version === 'number' ? row.version : 0,
        createdAt: String(row.createdAt ?? ''),
        updatedAt: String(row.updatedAt ?? ''),
      }
    },

    async commit(rec, expectedVersion) {
      const rowId = `${DASH_PREFIX}${rec.id}`
      for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await getRow(rowId)
        const storedVersion = typeof stored?.version === 'number' ? stored.version : null
        if (expectedVersion === null ? stored !== undefined : storedVersion !== expectedVersion) throw new Error(CONFLICT_ERROR)

        const idx = parseIndex((await getRow(DASH_INDEX_ID)) as IndexRow | undefined)
        const items = idx.items.filter((s) => s.id !== rec.id)
        if (!rec.archivedAt) items.push(summaryOf(rec))
        const now = rec.updatedAt
        const body: Omit<StoredDashboard, 'id' | 'version' | 'createdAt' | 'updatedAt'> & Partial<Pick<StoredDashboard, 'id' | 'version' | 'createdAt' | 'updatedAt'>> = { ...rec }
        delete body.id
        delete body.version
        delete body.createdAt
        delete body.updatedAt
        const base = { __typename: 'DashboardRollup', kind: 'DASH', schemaVersion: 1, computedAt: now, updatedAt: now }
        try {
          await db.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: table,
                    Item: { ...base, id: rowId, periodKey: rec.id, createdAt: rec.createdAt, version: rec.version, payload: JSON.stringify(body) },
                    ...(expectedVersion === null
                      ? { ConditionExpression: 'attribute_not_exists(id)' }
                      : { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': expectedVersion } }),
                  },
                },
                {
                  Put: {
                    TableName: table,
                    Item: {
                      ...base,
                      id: DASH_INDEX_ID,
                      periodKey: 'INDEX',
                      createdAt: now,
                      version: idx.version + 1,
                      payload: JSON.stringify({ items }),
                    },
                    ...(idx.version === 0
                      ? { ConditionExpression: 'attribute_not_exists(id)' }
                      : { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': idx.version } }),
                  },
                },
              ],
            }),
          )
          return
        } catch (err) {
          if (!isCanceled(err)) throw err
          // Either row moved (the next loop reports Conflict) or only the index did (retry).
        }
      }
      throw new Error(CONFLICT_ERROR)
    },
  }
}
