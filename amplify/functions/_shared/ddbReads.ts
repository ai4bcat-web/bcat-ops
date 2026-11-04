/**
 * Paged DynamoDB reads shared by the dashboard rollup and the conversational dashboards
 * (Step AI): `pages` (every page of a Query), `pool` (bounded concurrency), `batchGet`
 * (projected BatchGetItem with unprocessed-key retry), `plain` (string sets -> arrays).
 */
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
  type DynamoDBDocumentClient,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'

export type Row = Record<string, unknown>
/** Anything with the DocumentClient's `send` (the real client or a test double). */
export type DbLike = Pick<DynamoDBDocumentClient, 'send'>

export const CONCURRENCY = 25
const BATCH = 100

/** A DynamoDB string set arrives as a Set; every list-ish field the compute reads is a plain array. */
export function plain<T extends Row>(item: T): T {
  const out: Row = {}
  for (const [k, v] of Object.entries(item)) out[k] = v instanceof Set ? [...v] : v
  return out as T
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function pages(db: DbLike, input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Row[]> {
  const items: Row[] = []
  let key: Record<string, unknown> | undefined
  do {
    const out = await db.send(new QueryCommand({ ...input, ...(key ? { ExclusiveStartKey: key } : {}) }))
    for (const item of out.Items ?? []) items.push(plain(item))
    key = out.LastEvaluatedKey
  } while (key)
  return items
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

export async function batchGet(db: DbLike, table: string, ids: string[], names: string[]): Promise<Row[]> {
  const unique = [...new Set(ids.filter(Boolean))]
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += BATCH) chunks.push(unique.slice(i, i + BATCH))
  const aliases = Object.fromEntries(names.map((n) => [`#${n}`, n]))
  const out = await pool(chunks, 5, async (chunk) => {
    const found: Row[] = []
    let request: Record<string, { Keys: Row[]; ProjectionExpression: string; ExpressionAttributeNames: Record<string, string> }> | undefined = {
      [table]: {
        Keys: chunk.map((id) => ({ id })),
        ProjectionExpression: names.map((n) => `#${n}`).join(', '),
        ExpressionAttributeNames: aliases,
      },
    }
    for (let attempt = 0; request && attempt < 6; attempt++) {
      const res: BatchGetCommandOutput = await db.send(new BatchGetCommand({ RequestItems: request }))
      for (const item of res.Responses?.[table] ?? []) found.push(plain(item))
      const left = res.UnprocessedKeys?.[table]
      request = left?.Keys?.length
        ? { [table]: { Keys: left.Keys as Row[], ProjectionExpression: names.map((n) => `#${n}`).join(', '), ExpressionAttributeNames: aliases } }
        : undefined
      if (request) await sleep(50 * 2 ** attempt)
    }
    if (request) throw new Error(`BatchGetItem on ${table} left unprocessed keys`)
    return found
  })
  return out.flat()
}
