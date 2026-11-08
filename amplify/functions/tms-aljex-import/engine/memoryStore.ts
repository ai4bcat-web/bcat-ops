/**
 * In-memory EngineStore for vitest and for the PLAN overlay. It enforces what DynamoDB enforces and
 * the engine must never trip over: transaction atomicity, one write per item per transaction,
 * ≤ 100 items, conditional puts/updates, and the GSI rule (an index key is never '' or NULL).
 *
 * With a `base` store it is an overlay: reads see base rows with this store's writes layered on top;
 * entity writes land only here. Jobs and objects pass straight through to the base.
 */
import type { AljexImportJob, EngineRow, EngineStore, EngineTable, TableSet, TxCondition, TxItem, TxResult } from '../../../../src/types/tms'
import { assertIndexKeys, evalCondition, stampPut } from './stamp'

export interface MemoryStoreOptions {
  tables: TableSet
  now?: () => string
  /** Overlay mode: reads fall through to this store, writes stay here. */
  base?: EngineStore
  /** Throw (simulating a crash) when the Nth transaction (1-based, counted per store) is attempted. */
  crashAtTransact?: number
}

export class CrashInjected extends Error {}

const clone = <T>(v: T): T => structuredClone(v)

function project(row: EngineRow, projection?: string[]): EngineRow {
  if (!projection) return clone(row)
  const out: EngineRow = {}
  for (const k of projection) if (k in row) out[k] = clone(row[k])
  return out
}

export class MemoryStore implements EngineStore {
  readonly tables: TableSet
  /** logical table -> id -> row (keyed by logical table so overlay and base physical names never matter). */
  private rows = new Map<EngineTable, Map<string, EngineRow>>()
  private objects = new Map<string, Uint8Array>()
  private clock: () => string
  private base?: EngineStore
  private tick = 0
  transactCount = 0
  crashAtTransact?: number
  readonly jobs = new Map<string, AljexImportJob>()

  constructor(opts: MemoryStoreOptions) {
    this.tables = opts.tables
    this.clock = opts.now ?? (() => new Date().toISOString())
    this.base = opts.base
    this.crashAtTransact = opts.crashAtTransact
  }

  now(): string {
    return this.clock()
  }

  private table(t: EngineTable): Map<string, EngineRow> {
    let m = this.rows.get(t)
    if (!m) this.rows.set(t, (m = new Map()))
    return m
  }

  /** Direct seed for tests (stamps like a real write). */
  seed(t: EngineTable, rows: EngineRow[]): void {
    for (const r of rows) {
      const stamped = stampPut(t, r, this.now())
      assertIndexKeys(t, stamped)
      this.table(t).set(String(r.id), clone(stamped))
    }
  }

  /** Own (overlay) rows of a table: what this store wrote. */
  own(t: EngineTable): EngineRow[] {
    return [...this.table(t).values()].map(clone)
  }

  private async current(t: EngineTable, id: string): Promise<EngineRow | undefined> {
    const own = this.table(t).get(id)
    if (own) return own
    if (!this.base) return undefined
    const [row] = await this.base.getMany(t, [id])
    return row
  }

  async getMany(t: EngineTable, ids: string[]): Promise<EngineRow[]> {
    const out: EngineRow[] = []
    const missing: string[] = []
    for (const id of ids) {
      const own = this.table(t).get(id)
      if (own) out.push(clone(own))
      else missing.push(id)
    }
    if (this.base && missing.length) out.push(...(await this.base.getMany(t, missing)))
    return out
  }

  async *scanAll(t: EngineTable, projection?: string[]): AsyncIterable<EngineRow[]> {
    const own = this.table(t)
    if (this.base) {
      for await (const page of this.base.scanAll(t, projection)) {
        const rest = page.filter((r) => !own.has(String(r.id)))
        if (rest.length) yield rest
      }
    }
    const all = [...own.values()]
    for (let i = 0; i < all.length; i += 100) yield all.slice(i, i + 100).map((r) => project(r, projection))
  }

  async transact(items: TxItem[], label: string): Promise<TxResult> {
    this.transactCount += 1
    if (this.crashAtTransact !== undefined && this.transactCount === this.crashAtTransact) {
      throw new CrashInjected(`crash injected before transaction ${this.transactCount} (${label})`)
    }
    if (items.length === 0) return { ok: true }
    if (items.length > 100) return { ok: false, reason: 'ERROR', message: 'Transaction has more than 100 items' }
    const seen = new Set<string>()
    for (const it of items) {
      const id = it.op === 'put' ? String(it.item.id) : it.id
      const key = `${it.table}:${id}`
      if (seen.has(key)) return { ok: false, reason: 'ERROR', message: `Transaction targets ${key} twice` }
      seen.add(key)
    }
    const staged = new Map<string, { table: EngineTable; row: EngineRow }>()
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const id = it.op === 'put' ? String(it.item.id) : it.id
      const existing = await this.current(it.table, id)
      if (it.op === 'put') {
        if (it.ifNotExists && existing) return { ok: false, reason: 'CONDITION', failedIndex: i }
        if (!evalCondition(it.condition, existing)) return { ok: false, reason: 'CONDITION', failedIndex: i }
        const row = stampPut(it.table, it.item, this.now())
        assertIndexKeys(it.table, row)
        staged.set(`${it.table}:${id}`, { table: it.table, row: clone(row) })
      } else if (it.op === 'check') {
        if (!evalCondition(it.condition, existing)) return { ok: false, reason: 'CONDITION', failedIndex: i }
      } else {
        if (!evalCondition(it.condition, existing)) return { ok: false, reason: 'CONDITION', failedIndex: i }
        const row = this.applyUpdate(it.table, id, existing, it.set, it.remove, it.add)
        staged.set(`${it.table}:${id}`, { table: it.table, row })
      }
    }
    for (const { table, row } of staged.values()) this.table(table).set(String(row.id), row)
    return { ok: true }
  }

  private applyUpdate(
    t: EngineTable,
    id: string,
    existing: EngineRow | undefined,
    set?: EngineRow,
    remove?: string[],
    add?: Record<string, number>,
  ): EngineRow {
    const row: EngineRow = existing ? clone(existing) : stampPut(t, { id }, this.now())
    for (const [k, v] of Object.entries(set ?? {})) if (v !== undefined) row[k] = clone(v)
    for (const k of remove ?? []) if (!(set && k in set)) delete row[k]
    for (const [k, n] of Object.entries(add ?? {})) row[k] = (typeof row[k] === 'number' ? (row[k] as number) : 0) + n
    row.updatedAt = (set?.updatedAt as string | undefined) ?? this.now()
    assertIndexKeys(t, row)
    return row
  }

  async batchPut(t: EngineTable, rows: EngineRow[]): Promise<void> {
    for (const r of rows) {
      const row = stampPut(t, r, this.now())
      assertIndexKeys(t, row)
      this.table(t).set(String(r.id), clone(row))
    }
  }

  async update(t: EngineTable, id: string, patch: EngineRow, cond?: TxCondition): Promise<boolean> {
    const existing = await this.current(t, id)
    if (!evalCondition(cond, existing)) return false
    this.table(t).set(id, this.applyUpdate(t, id, existing, patch))
    return true
  }

  async putJob(job: AljexImportJob): Promise<void> {
    if (this.base) return this.base.putJob(job)
    this.jobs.set(job.id, clone(job))
    const row = stampPut('aljexImportJob', job as unknown as EngineRow, this.now())
    this.table('aljexImportJob').set(job.id, clone(row))
  }

  async putObject(key: string, body: Uint8Array | string): Promise<void> {
    if (this.base) return this.base.putObject(key, body)
    this.objects.set(key, typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
  }

  async *getObject(key: string): AsyncIterable<Uint8Array> {
    if (this.base) {
      yield* this.base.getObject(key)
      return
    }
    const body = this.objects.get(key)
    if (!body) throw new Error(`No such object: ${key}`)
    // Several small slices so chunk-boundary bugs in the parser would surface.
    for (let i = 0; i < body.length; i += 4096) yield body.subarray(i, i + 4096)
  }

  objectKeys(): string[] {
    return [...this.objects.keys()]
  }

  objectText(key: string): string | undefined {
    const b = this.objects.get(key)
    return b ? Buffer.from(b).toString('utf8') : undefined
  }

  /** Stable checksum of every entity row (for idempotency and kill/resume equality tests). */
  checksum(): string {
    const parts: string[] = []
    for (const [t, m] of [...this.rows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (t === 'aljexImportJob') continue
      for (const [id, row] of [...m.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        // Per-run bookkeeping (start/done audit rows) is not part of the imported data.
        if (t === 'auditLog' && String(row.action).startsWith('ALJEX_IMPORT_APPLY_')) continue
        const copy = { ...row }
        delete copy.createdAt
        delete copy.updatedAt
        delete copy.importedAt
        delete copy.claimedAt
        parts.push(`${t}|${id}|${JSON.stringify(sortKeys(copy))}`)
      }
    }
    return parts.join('\n')
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sortKeys(x)]),
    )
  }
  return v
}
