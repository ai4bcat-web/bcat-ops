// N index/get lookups in ONE AppSync request: { a0: listXByShipmentId(shipmentId:$k0){…} a1: … }.
// AppSync resolves the aliases in parallel server-side (measured: 200 shipment ids, 4 requests,
// ~0.5 s vs 8 sequential trips). Pure transport: callers pass the field selection.

/** Runs one GraphQL operation and returns its `data`. Rejects on any GraphQL error. */
export type GraphqlRunner = (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>

export interface AliasBatchOpts {
  /** Aliases per request (default 100). Halved and retried when AppSync refuses the size. */
  chunk?: number
  /** Requests in flight (default 8). */
  concurrency?: number
  /** `limit` per alias (default 50). An alias that returns a nextToken is re-queried alone to exhaustion. */
  perAliasLimit?: number
  /** Injected transport; defaults to the app's amplify client. */
  run?: GraphqlRunner
}

export interface IndexQuery {
  /** 'listOrderByShipmentId' */
  query: string
  /** 'shipmentId' */
  keyArg: string
  /** 'String!' or an enum type such as 'ShipmentStatus!' */
  keyType: string
  /** Selection set body, e.g. 'id shipmentId arStatus' */
  fields: string
}

/** A composite-key lookup: the hash key plus an equality condition on the sort key. */
export interface IndexSortQuery extends IndexQuery {
  /** 'entityId' — passed as `entityId: { eq: $v }` */
  sortArg: string
  sortType: string
}

export interface GetQuery {
  /** 'getShipment' */
  query: string
  fields: string
}

const DEFAULT_CHUNK = 100
const DEFAULT_CONCURRENCY = 8
const DEFAULT_ALIAS_LIMIT = 50
const FOLLOWUP_LIMIT = 1000
// AppSync's refusals that a smaller request can cure. Deliberately narrow: a schema
// validation error (missing model / field) must fail fast, not fan out to N single requests.
const SIZE_ERROR = /too large|too big|response size|payload|maximum|413/i

let defaultRunner: GraphqlRunner | null = null

/** Wired once by apiClient so this module never imports it (and tests never load amplify). */
export function setDefaultGraphqlRunner(run: GraphqlRunner): void {
  defaultRunner = run
}

function runnerOf(opts?: AliasBatchOpts): GraphqlRunner {
  const run = opts?.run ?? defaultRunner
  if (!run) throw new Error('aliasBatch: no GraphQL runner configured')
  return run
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; errors?: { message?: unknown }[] }
    const parts: string[] = []
    if (typeof e.message === 'string') parts.push(e.message)
    if (Array.isArray(e.errors)) for (const x of e.errors) if (typeof x?.message === 'string') parts.push(x.message)
    return parts.join(' | ')
  }
  return String(err)
}

/** Runs `fn` over items with at most `concurrency` in flight; results keep input order; first failure rejects. */
async function pool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failure: { err: unknown } | null = null
  const worker = async () => {
    while (!failure) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = await fn(items[i])
      } catch (err) {
        failure = { err }
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker))
  if (failure) throw (failure as { err: unknown }).err
  return out
}

/** One request for a chunk; on a size refusal splits in half and retries. */
async function runChunk<I, R>(items: I[], send: (items: I[]) => Promise<R[]>): Promise<R[]> {
  try {
    return await send(items)
  } catch (err) {
    if (items.length > 1 && SIZE_ERROR.test(errorMessage(err))) {
      const mid = Math.ceil(items.length / 2)
      const [a, b] = await Promise.all([runChunk(items.slice(0, mid), send), runChunk(items.slice(mid), send)])
      return [...a, ...b]
    }
    throw err
  }
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, size)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}

type ListAlias<T> = { items?: (T | null)[] | null; nextToken?: string | null } | null | undefined

interface Lookup {
  /** Variable name → [GraphQL type, value]. */
  vars: [name: string, type: string, value: string][]
  /** Argument text with `$` placeholders by index into vars, e.g. 'entityType: $0, entityId: { eq: $1 }'. */
  args: string
}

async function listLookups<T>(query: string, fields: string, lookups: Lookup[], opts?: AliasBatchOpts): Promise<T[][]> {
  const run = runnerOf(opts)
  const limit = opts?.perAliasLimit ?? DEFAULT_ALIAS_LIMIT
  const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY
  const argText = (l: Lookup, prefix: string) =>
    l.args.replace(/\$(\d+)/g, (_m, i: string) => `$${prefix}${i}`)

  const sendChunk = async (chunk: { l: Lookup; at: number }[]) => {
    const decls: string[] = []
    const vars: Record<string, unknown> = {}
    const body = chunk.map(({ l }, i) => {
      l.vars.forEach(([, type, value], j) => {
        decls.push(`$k${i}_${j}: ${type}`)
        vars[`k${i}_${j}`] = value
      })
      return `a${i}: ${query}(${argText(l, `k${i}_`)}, limit: ${limit}) { items { ${fields} } nextToken }`
    })
    const data = await run(`query BatchByIndex(${decls.join(', ')}) {\n${body.join('\n')}\n}`, vars)
    return chunk.map(({ at }, i) => ({ at, alias: data[`a${i}`] as ListAlias<T> }))
  }

  const results: T[][] = lookups.map(() => [])
  const more: { at: number; token: string }[] = []
  const indexed = lookups.map((l, at) => ({ l, at }))
  const pages = await pool(chunked(indexed, opts?.chunk ?? DEFAULT_CHUNK), concurrency, (c) => runChunk(c, sendChunk))
  for (const page of pages) {
    for (const { at, alias } of page) {
      for (const item of alias?.items ?? []) if (item) results[at].push(item)
      if (alias?.nextToken) more.push({ at, token: alias.nextToken })
    }
  }

  await pool(more, concurrency, async ({ at, token }) => {
    const l = lookups[at]
    const decls = l.vars.map(([, type], j) => `$k${j}: ${type}`).join(', ')
    const vars: Record<string, unknown> = { t: token }
    l.vars.forEach(([, , value], j) => { vars[`k${j}`] = value })
    let next: string | null | undefined = token
    while (next) {
      vars.t = next
      const data = await run(
        `query BatchByIndexMore(${decls}, $t: String) { a: ${query}(${argText(l, 'k')}, limit: ${FOLLOWUP_LIMIT}, nextToken: $t) { items { ${fields} } nextToken } }`,
        vars,
      )
      const alias = data.a as ListAlias<T>
      for (const item of alias?.items ?? []) if (item) results[at].push(item)
      next = alias?.nextToken
    }
  })
  return results
}

/**
 * `{ id → rows }` for every id (an id with no rows maps to []). Ids are de-duplicated. A key with
 * more than `perAliasLimit` rows is paged to exhaustion, never truncated. Any GraphQL error
 * (including a partial one) rejects the whole batch.
 */
export async function batchByIndex<T>(
  q: IndexQuery,
  ids: readonly string[],
  opts?: AliasBatchOpts,
): Promise<Map<string, T[]>> {
  const keys = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
  if (keys.length === 0) return new Map()
  const rows = await listLookups<T>(
    q.query,
    q.fields,
    keys.map((id) => ({ vars: [[q.keyArg, q.keyType, id]], args: `${q.keyArg}: $0` })),
    opts,
  )
  return new Map(keys.map((k, i) => [k, rows[i]]))
}

/**
 * Composite lookups: `(hash, sort)` pairs against an index with a sort key, returned flat in
 * request order. Pairs are de-duplicated.
 */
export async function batchByIndexPairs<T>(
  q: IndexSortQuery,
  pairs: readonly { key: string; sort: string }[],
  opts?: AliasBatchOpts,
): Promise<T[]> {
  const seen = new Set<string>()
  const unique = pairs.filter((p) => {
    const id = `${p.key}\u0000${p.sort}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  if (unique.length === 0) return []
  const rows = await listLookups<T>(
    q.query,
    q.fields,
    unique.map((p) => ({
      vars: [[q.keyArg, q.keyType, p.key], [q.sortArg, q.sortType, p.sort]],
      args: `${q.keyArg}: $0, ${q.sortArg}: { eq: $1 }`,
    })),
    opts,
  )
  return rows.flat()
}

/** `{ id → row }`; an id that does not exist is absent from the map. */
export async function batchGet<T extends { id: string }>(
  q: GetQuery,
  ids: readonly string[],
  opts?: AliasBatchOpts,
): Promise<Map<string, T>> {
  const run = runnerOf(opts)
  const keys = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
  const result = new Map<string, T>()
  if (keys.length === 0) return result

  const sendChunk = async (chunk: string[]): Promise<(T | null)[]> => {
    const decls = chunk.map((_, i) => `$k${i}: ID!`).join(', ')
    const body = chunk.map((_, i) => `a${i}: ${q.query}(id: $k${i}) { ${q.fields} }`).join('\n')
    const vars: Record<string, unknown> = {}
    chunk.forEach((id, i) => { vars[`k${i}`] = id })
    const data = await run(`query BatchGet(${decls}) {\n${body}\n}`, vars)
    return chunk.map((_, i) => (data[`a${i}`] as T | null | undefined) ?? null)
  }

  const pages = await pool(chunked(keys, opts?.chunk ?? DEFAULT_CHUNK), opts?.concurrency ?? DEFAULT_CONCURRENCY, (c) => runChunk(c, sendChunk))
  for (const rows of pages) for (const row of rows) if (row) result.set(row.id, row)
  return result
}
