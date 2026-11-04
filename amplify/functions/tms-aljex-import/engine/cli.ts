/**
 * Offline driver for the import engine (bundled by scripts/importAljex.mjs). NEVER imported by the Lambda,
 * the router or the UI: it holds the dev-only operations the plan keeps out of every deployed path
 * (rehearsal table copies, restores, and the delete-based rollback).
 *
 *   run        stage -> plan -> apply a file against a rehearsal copy or (tagged) live dev
 *   resume     continue a RUNNING job recorded by an earlier invocation
 *   seed-counter, rehearsal-create/-drop, backup-create/-restore, pitr-restore, drop-copy, rollback
 *
 * Output is aggregates only (counts, sums, timings). Anything row-level goes to a 0700 directory under the
 * OS temp dir, outside the repo, and is the operator's to delete after review.
 */
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BatchWriteItemCommand,
  CreateBackupCommand,
  DeleteBackupCommand,
  DeleteTableCommand,
  DescribeBackupCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListBackupsCommand,
  ListTablesCommand,
  RestoreTableFromBackupCommand,
  RestoreTableToPointInTimeCommand,
} from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import type { S3Client } from '@aws-sdk/client-s3'
import type { AljexEntityCounts, AljexImportJob, EngineRow, EngineStore, EngineTable, TableSet, TxCondition } from '../../../../src/types/tms'
import { DynamoStore } from './dynamoStore'
import { MemoryStore } from './memoryStore'
import { reconcile } from './reconcile'
import { runSlice } from './runSlice'
import { seedProCounter } from './seedCounter'
import { evalCondition } from './stamp'
import { readStageData } from './stage'
import { assertTargets, DEV_SUFFIX, MODEL_NAME, PROD_SUFFIX, resolveTables, TAG_PATTERN, WRITTEN_TABLES } from './tables'
import { stableId } from './util'

const REGION = 'us-east-1'
const JOBS_FILE = join(tmpdir(), 'aljex-cli-jobs.json')

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

const consoleIo: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) }

// ── arguments ────────────────────────────────────────────────────────────────────────────────

export interface Args {
  command: string
  flags: Map<string, string | true>
}

export function parseArgs(argv: string[]): Args {
  const [command = '', ...rest] = argv
  const flags = new Map<string, string | true>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`)
    const name = a.slice(2)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      i++
    } else flags.set(name, true)
  }
  return { command, flags }
}

const flag = (a: Args, name: string): string | undefined => {
  const v = a.flags.get(name)
  return typeof v === 'string' ? v : undefined
}
const need = (a: Args, name: string): string => {
  const v = flag(a, name)
  if (!v) throw new Error(`--${name} is required`)
  return v
}

export interface TargetSpec {
  target: 'LIVE' | 'REHEARSAL'
  targetTag: string | null
  liveTag: string | null
}

/** `rehearsal:<tag>` | `live:<liveTag>` */
export function parseTarget(spec: string): TargetSpec {
  const m = /^(rehearsal|live):(.+)$/.exec(spec)
  if (!m) throw new Error('--target must be rehearsal:<tag> or live:<liveTag>')
  if (m[1] === 'rehearsal') {
    if (!TAG_PATTERN.test(m[2])) throw new Error('rehearsal tag must be 3-12 lowercase letters/digits')
    return { target: 'REHEARSAL', targetTag: m[2], liveTag: null }
  }
  return { target: 'LIVE', targetTag: null, liveTag: m[2] }
}

/** `every:8` -> 8 */
export function parseSlice(spec: string | undefined): number | null {
  if (!spec) return null
  const m = /^every:(\d+)$/.exec(spec)
  if (!m || Number(m[1]) < 2) throw new Error('--slice must be every:N with N >= 2')
  return Number(m[1])
}

// ── local object store + job book ────────────────────────────────────────────────────────────

class LocalObjects {
  constructor(
    readonly dir: string,
    private sourcePath: string | null,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  put(key: string, body: Uint8Array | string): void {
    const path = join(this.dir, key)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, body, { mode: 0o600 })
  }

  async *get(key: string): AsyncIterable<Uint8Array> {
    if (key.startsWith('imports/source/')) {
      if (!this.sourcePath) throw new Error('No --source for this run')
      yield* createReadStream(this.sourcePath, { highWaterMark: 1 << 20 })
      return
    }
    const path = join(this.dir, key)
    if (!existsSync(path)) throw new Error(`No such object: ${key}`)
    yield readFileSync(path)
  }
}

/** Jobs of CLI runs are kept in a local file, never in the live AljexImportJob table (a rehearsal must not write live). */
class JobBook {
  private jobs = new Map<string, EngineRow>()
  constructor(private path: string | null) {
    if (path && existsSync(path)) for (const r of JSON.parse(readFileSync(path, 'utf8')) as EngineRow[]) this.jobs.set(String(r.id), r)
  }
  get(ids: string[]): EngineRow[] {
    return ids.flatMap((id) => (this.jobs.has(id) ? [structuredClone(this.jobs.get(id)!)] : []))
  }
  all(): EngineRow[] {
    return [...this.jobs.values()].map((r) => structuredClone(r))
  }
  put(row: EngineRow): void {
    this.jobs.set(String(row.id), structuredClone(row))
    this.flush()
  }
  update(id: string, patch: EngineRow, cond?: TxCondition): boolean {
    const row = this.jobs.get(id)
    if (!evalCondition(cond, row)) return false
    const next = { ...(row ?? { id }) }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v
    this.jobs.set(id, structuredClone(next))
    this.flush()
    return true
  }
  private flush(): void {
    if (!this.path) return
    writeFileSync(this.path, JSON.stringify([...this.jobs.values()]), { mode: 0o600 })
    chmodSync(this.path, 0o600)
  }
}

const NOT_S3 = {} as unknown as S3Client

class AwsCliStore extends DynamoStore {
  constructor(
    db: DynamoDBClient,
    tables: TableSet,
    private local: LocalObjects,
    private book: JobBook,
  ) {
    super({ db, s3: NOT_S3, bucket: 'local', tables })
  }
  override async getMany(t: EngineTable, ids: string[]): Promise<EngineRow[]> {
    return t === 'aljexImportJob' ? this.book.get(ids) : super.getMany(t, ids)
  }
  override async *scanAll(t: EngineTable, projection?: string[]): AsyncIterable<EngineRow[]> {
    if (t === 'aljexImportJob') {
      yield this.book.all()
      return
    }
    yield* super.scanAll(t, projection)
  }
  override async update(t: EngineTable, id: string, patch: EngineRow, cond?: TxCondition): Promise<boolean> {
    return t === 'aljexImportJob' ? this.book.update(id, patch, cond) : super.update(t, id, patch, cond)
  }
  override async putJob(job: AljexImportJob): Promise<void> {
    this.book.put(job as unknown as EngineRow)
  }
  override async putObject(key: string, body: Uint8Array | string): Promise<void> {
    this.local.put(key, body)
  }
  override getObject(key: string): AsyncIterable<Uint8Array> {
    return this.local.get(key)
  }
  /** Dev-only rollback primitive. */
  async deleteIds(t: EngineTable, ids: string[]): Promise<void> {
    const name = this.tables[t]
    for (let i = 0; i < ids.length; i += 25) {
      let batch = ids.slice(i, i + 25).map((id) => ({ DeleteRequest: { Key: marshall({ id }) } }))
      while (batch.length) {
        const r = await (this as unknown as { db: DynamoDBClient }).db.send(new BatchWriteItemCommand({ RequestItems: { [name]: batch } }))
        batch = (r.UnprocessedItems?.[name] ?? []) as typeof batch
      }
    }
  }
}

class MemoryCliStore extends MemoryStore {
  constructor(
    tables: TableSet,
    private local: LocalObjects,
    private book: JobBook,
  ) {
    super({ tables })
  }
  override async getMany(t: EngineTable, ids: string[]): Promise<EngineRow[]> {
    return t === 'aljexImportJob' ? this.book.get(ids) : super.getMany(t, ids)
  }
  override async *scanAll(t: EngineTable, projection?: string[]): AsyncIterable<EngineRow[]> {
    if (t === 'aljexImportJob') {
      yield this.book.all()
      return
    }
    yield* super.scanAll(t, projection)
  }
  override async update(t: EngineTable, id: string, patch: EngineRow, cond?: TxCondition): Promise<boolean> {
    return t === 'aljexImportJob' ? this.book.update(id, patch, cond) : super.update(t, id, patch, cond)
  }
  override async putJob(job: AljexImportJob): Promise<void> {
    this.book.put(job as unknown as EngineRow)
  }
  override async putObject(key: string, body: Uint8Array | string): Promise<void> {
    this.local.put(key, body)
  }
  override getObject(key: string): AsyncIterable<Uint8Array> {
    return this.local.get(key)
  }
}


/** The prepared job of a PLAN / APPLY chain, read from the local job book. */
function rootOf(book: JobBook, row: EngineRow): string {
  let current = row
  for (let hops = 0; typeof current.parentJobId === 'string' && hops < 8; hops++) {
    const [parent] = book.get([current.parentJobId])
    if (!parent) break
    current = parent
  }
  return String(current.id)
}

// ── tables ───────────────────────────────────────────────────────────────────────────────────

export function liveTableSet(): TableSet {
  return Object.fromEntries(Object.entries(MODEL_NAME).map(([k, model]) => [k, `${model}-${DEV_SUFFIX}`])) as unknown as TableSet
}

async function tableExists(db: DynamoDBClient, name: string): Promise<boolean> {
  try {
    await db.send(new DescribeTableCommand({ TableName: name }))
    return true
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') return false
    throw err
  }
}

async function waitActive(db: DynamoDBClient, name: string, io: CliIo): Promise<void> {
  for (let i = 0; i < 360; i++) {
    const r = await db.send(new DescribeTableCommand({ TableName: name }))
    if (r.Table?.TableStatus === 'ACTIVE') return
    if (i % 6 === 5) io.out(`  waiting for ${name} (${r.Table?.TableStatus})`)
    await new Promise((res) => setTimeout(res, 5000))
  }
  throw new Error(`Timed out waiting for ${name}`)
}

const rehearsalName = (live: TableSet, t: (typeof WRITTEN_TABLES)[number], tag: string): string => `${live[t]}-rh${tag}`

function assertTag(tag: string): void {
  if (!TAG_PATTERN.test(tag)) throw new Error('--tag must be 3-12 lowercase letters/digits')
}

function backupNameOf(tag: string, model: string): string {
  return `aljex-rh-${tag}-${model}`
}

async function backupCreate(db: DynamoDBClient, tag: string, only: string[] | null, io: CliIo): Promise<string[]> {
  assertTag(tag)
  const live = liveTableSet()
  const arns: Array<{ model: string; arn: string }> = []
  for (const t of WRITTEN_TABLES.filter((x) => !only || only.includes(MODEL_NAME[x]))) {
    if (!(await tableExists(db, live[t]))) {
      io.err(`skip ${MODEL_NAME[t]}: no live table`)
      continue
    }
    const b = await db.send(new CreateBackupCommand({ TableName: live[t], BackupName: backupNameOf(tag, MODEL_NAME[t]) }))
    arns.push({ model: MODEL_NAME[t], arn: b.BackupDetails!.BackupArn! })
    io.out(`backup started: ${MODEL_NAME[t]}`)
  }
  for (const m of arns) {
    for (let i = 0; i < 360; i++) {
      const d = await db.send(new DescribeBackupCommand({ BackupArn: m.arn }))
      if (d.BackupDescription?.BackupDetails?.BackupStatus === 'AVAILABLE') break
      await new Promise((res) => setTimeout(res, 5000))
    }
  }
  return arns.map((x) => x.model)
}

/** Restore the tag's on-demand backups into `<live>-rh<tag>` siblings (never in place). */
async function backupRestore(db: DynamoDBClient, tag: string, only: string[] | null, io: CliIo): Promise<void> {
  assertTag(tag)
  const live = liveTableSet()
  const byName = new Map<string, string>()
  let token: string | undefined
  do {
    const r = await db.send(new ListBackupsCommand({ ExclusiveStartBackupArn: token }))
    for (const b of r.BackupSummaries ?? []) if (b.BackupName && b.BackupArn && b.BackupStatus === 'AVAILABLE') byName.set(b.BackupName, b.BackupArn)
    token = r.LastEvaluatedBackupArn
  } while (token)
  const restored: Array<(typeof WRITTEN_TABLES)[number]> = []
  for (const t of WRITTEN_TABLES.filter((x) => !only || only.includes(MODEL_NAME[x]))) {
    const arn = byName.get(backupNameOf(tag, MODEL_NAME[t]))
    if (!arn) {
      io.err(`skip ${MODEL_NAME[t]}: no backup for tag ${tag}`)
      continue
    }
    await db.send(new RestoreTableFromBackupCommand({ TargetTableName: rehearsalName(live, t, tag), BackupArn: arn }))
    io.out(`restore started: ${rehearsalName(live, t, tag)}`)
    restored.push(t)
  }
  for (const t of restored) await waitActive(db, rehearsalName(live, t, tag), io)
  writeFileSync(join(tmpdir(), `aljex-rehearsal-${tag}.json`), JSON.stringify({ tag, tables: restored.map((t) => MODEL_NAME[t]) }), { mode: 0o600 })
  io.out(`rehearsal ${tag} ready: ${restored.length} tables`)
}

async function rehearsalDrop(db: DynamoDBClient, tag: string, io: CliIo): Promise<void> {
  assertTag(tag)
  const live = liveTableSet()
  for (const t of WRITTEN_TABLES) {
    const name = rehearsalName(live, t, tag)
    if (name.includes(PROD_SUFFIX) || !name.endsWith(`-rh${tag}`)) throw new Error(`refusing to delete ${name}`)
    if (await tableExists(db, name)) {
      await db.send(new DeleteTableCommand({ TableName: name }))
      io.out(`deleted ${name}`)
    }
  }
  let token: string | undefined
  do {
    const r = await db.send(new ListBackupsCommand({ ExclusiveStartBackupArn: token }))
    for (const b of r.BackupSummaries ?? []) {
      if (b.BackupName?.startsWith(`aljex-rh-${tag}-`) && b.BackupArn) {
        await db.send(new DeleteBackupCommand({ BackupArn: b.BackupArn }))
        io.out(`deleted backup ${b.BackupName}`)
      }
    }
    token = r.LastEvaluatedBackupArn
  } while (token)
}

async function pitrRestore(db: DynamoDBClient, model: string, time: string, as: string, io: CliIo): Promise<void> {
  const source = `${model}-${DEV_SUFFIX}`
  if (!Object.values(MODEL_NAME).includes(model)) throw new Error(`unknown model ${model}`)
  if (!new RegExp(`^${model}-${DEV_SUFFIX}-rh[a-z0-9]{3,12}$`).test(as)) throw new Error(`--as must be ${model}-${DEV_SUFFIX}-rh<tag>: restores never overwrite a table`)
  await db.send(new RestoreTableToPointInTimeCommand({ SourceTableName: source, TargetTableName: as, RestoreDateTime: new Date(time) }))
  io.out(`restoring ${source} @ ${time} -> ${as}`)
  await waitActive(db, as, io)
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────

interface RunSetup {
  store: EngineStore & { deleteIds?: (t: EngineTable, ids: string[]) => Promise<void> }
  objects: LocalObjects
  book: JobBook
}

function runDirOf(id: string): string {
  return join(tmpdir(), `aljex-run-${id.replace(/[^a-z0-9]+/gi, '-')}`)
}

async function openStore(a: Args, spec: TargetSpec, runId: string, sourcePath: string | null): Promise<RunSetup> {
  const live = liveTableSet()
  const tables = resolveTables(live, { target: spec.target, targetTag: spec.targetTag })
  const objects = new LocalObjects(runDirOf(runId), sourcePath)
  if (a.flags.has('memory')) {
    const book = new JobBook(null)
    return { store: new MemoryCliStore(tables, objects, book), objects, book }
  }
  const db = new DynamoDBClient({ region: REGION })
  for (const t of WRITTEN_TABLES) {
    if (!(await tableExists(db, tables[t]))) throw new Error(`table ${tables[t]} does not exist${spec.target === 'REHEARSAL' ? ' (run rehearsal-create first)' : ''}`)
  }
  const book = new JobBook(JOBS_FILE)
  return { store: new AwsCliStore(db, tables, objects, book), objects, book }
}

function dollars(cents: number | null): string {
  if (cents == null) return 'n/a'
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function printCounts(io: CliIo, counts: AljexEntityCounts | null | undefined): void {
  for (const [entity, c] of Object.entries(counts ?? {})) {
    if (c) io.out(`  ${entity.padEnd(11)} staged ${c.staged}  created ${c.created}  matched ${c.matched}  enriched ${c.enriched}  skipped ${c.skipped}  conflicts ${c.conflicts}  errors ${c.errors}`)
  }
}

async function driveJob(store: EngineStore, id: string): Promise<AljexImportJob> {
  for (let i = 0; i < 200; i++) {
    const res = await runSlice(store, id, Date.now() + 14 * 60_000)
    if (res.done) return res.job
  }
  throw new Error('job did not finish in 200 slices')
}

async function cmdRun(a: Args, io: CliIo): Promise<number> {
  const spec = parseTarget(need(a, 'target'))
  const source = need(a, 'source')
  if (!existsSync(source)) throw new Error(`source not found: ${source}`)
  const sliceEvery = parseSlice(flag(a, 'slice'))
  const synthetic = a.flags.has('synthetic')
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rootId = `aljexrun:${stamp}`
  const { store, objects, book } = await openStore(a, spec, rootId, source)
  // Fail before any work if the target is unsafe.
  assertTargets(liveTableSet(), store.tables, { target: spec.target, targetTag: spec.targetTag, liveTag: spec.liveTag ?? 'plan' })
  const base: AljexImportJob = {
    id: rootId,
    kind: 'IMPORT',
    status: 'STAGING',
    phase: 'STAGE',
    fileName: source.split('/').pop() ?? 'export.csv',
    target: spec.target,
    targetTag: spec.targetTag,
    liveTag: spec.liveTag,
    synthetic,
    options: { ...(sliceEvery ? { sliceEvery } : {}), ...(flag(a, 'carrier-cutoff') ? { carrierCutoffDate: flag(a, 'carrier-cutoff') } : {}) },
    createdBy: 'importAljex-cli',
  }
  book.put(base as unknown as EngineRow)
  io.out(`run ${rootId} target ${spec.target}${spec.targetTag ? `:${spec.targetTag}` : ''} ${synthetic ? '(synthetic)' : '(real data)'}${sliceEvery ? ` slice every:${sliceEvery}` : ''}`)

  const t0 = Date.now()
  const staged = await driveJob(store, rootId)
  const tStage = Date.now() - t0
  if (staged.status !== 'READY') return fail(io, staged)
  const stage = await readStageData(store, rootId)
  io.out(`STAGE ${(tStage / 1000).toFixed(1)}s: ${stage.index.rows} rows (${stage.index.loads} loads, ${stage.index.memos} memos, ${stage.index.duplicatePros} identical duplicates, ${stage.index.junkDates} junk dates, ${stage.index.raggedRows} ragged)`)

  await store.update('aljexImportJob', rootId, { status: 'PLANNING' })
  const t1 = Date.now()
  const planned = await driveJob(store, rootId)
  if (planned.status !== 'PLANNED') return fail(io, planned)
  io.out(`PLAN ${((Date.now() - t1) / 1000).toFixed(1)}s`)
  printCounts(io, planned.entityCounts)
  if (a.flags.has('no-apply')) return 0

  const applyId = `${rootId}A`
  const applyJob: AljexImportJob = { ...base, id: applyId, status: 'RUNNING', phase: 'CUSTOMER', parentJobId: rootId, stageHash: planned.stageHash, layoutId: planned.layoutId, profileVersion: planned.profileVersion, cursor: { phase: 'CUSTOMER' } }
  book.put(applyJob as unknown as EngineRow)
  const t2 = Date.now()
  const done = await driveJob(store, applyId)
  const tApply = Date.now() - t2
  if (done.status !== 'APPLIED') return fail(io, done)
  const rate = stage.index.rows / Math.max(0.001, tApply / 1000)
  io.out(`APPLY ${(tApply / 1000).toFixed(1)}s (${rate.toFixed(0)} rows/s)`)
  printCounts(io, done.entityCounts)
  const summary = await reconcile(store, applyId, { write: false })
  io.out('RECONCILE (file | BCAT | difference), dollars')
  for (const b of summary.bridge) io.out(`  ${b.key.padEnd(15)} ${dollars(b.fileCents).padStart(16)} ${dollars(b.bcatCents).padStart(16)} ${dollars(b.diffCents).padStart(12)}`)
  io.out(`  conservation ${summary.conservationOk ? 'OK' : 'BROKEN'}  reconciled ${summary.reconciled ? 'YES' : 'NO'}  open AR ${dollars(summary.openArCents)}  open AP (derived) ${dollars(summary.openApCents)}`)
  io.out(`  findings: ${Object.entries(summary.findings).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
  io.out(`totals: stage ${(tStage / 1000).toFixed(1)}s, plan ${((t2 - t1) / 1000).toFixed(1)}s, apply ${(tApply / 1000).toFixed(1)}s; row-level reports in ${objects.dir} (delete after review)`)
  // Second pass writes the report files too (the summary above was read-only).
  await reconcile(store, applyId)
  await store.update('aljexImportJob', applyId, { options: { ...(done.options ?? {}), reconciled: summary.reconciled } })
  return summary.reconciled ? 0 : 2
}

function fail(io: CliIo, job: AljexImportJob): number {
  io.err(`job ${job.id} ended ${job.status}: ${job.error ?? 'no error recorded'}`)
  return 1
}

async function cmdResume(a: Args, io: CliIo): Promise<number> {
  const id = need(a, 'run')
  const spec = parseTarget(need(a, 'target'))
  const book = new JobBook(JOBS_FILE)
  const [row] = book.get([id])
  if (!row) throw new Error(`no such job in ${JOBS_FILE}`)
  const root = rootOf(book, row)
  const { store } = await openStore(a, spec, root, flag(a, 'source') ?? null)
  const job = await driveJob(store, id)
  io.out(`job ${id}: ${job.status}`)
  printCounts(io, job.entityCounts)
  return job.status === 'APPLIED' ? 0 : 1
}

async function cmdSeed(a: Args, io: CliIo): Promise<number> {
  const spec = parseTarget(need(a, 'target'))
  const { store } = await openStore(a, spec, `seed-${Date.now()}`, null)
  assertTargets(liveTableSet(), store.tables, { target: spec.target, targetTag: spec.targetTag, liveTag: spec.liveTag ?? 'plan' })
  const result = await seedProCounter(store, { apply: a.flags.has('apply'), enableNumericScheme: a.flags.has('enable-numeric'), jobId: flag(a, 'run') ?? null })
  io.out(JSON.stringify(result))
  return 0
}

async function cmdRollback(a: Args, io: CliIo): Promise<number> {
  if (!a.flags.has('i-understand-dev-only')) throw new Error('rollback deletes rows; pass --i-understand-dev-only (dev stack only)')
  const runId = need(a, 'run')
  const spec = parseTarget(need(a, 'target'))
  if (a.flags.has('memory')) throw new Error('rollback is for AWS tables only')
  const book = new JobBook(JOBS_FILE)
  const [job] = book.get([runId]) as unknown as AljexImportJob[]
  if (!job) throw new Error(`no such job ${runId} in ${JOBS_FILE}`)
  const root = rootOf(book, job as unknown as EngineRow)
  const { store } = await openStore(a, spec, root, null)
  assertTargets(liveTableSet(), store.tables, { target: spec.target, targetTag: spec.targetTag, liveTag: spec.liveTag ?? 'plan' })
  const aws = store as unknown as AwsCliStore
  const all = async (t: EngineTable, proj: string[]): Promise<EngineRow[]> => {
    const out: EngineRow[] = []
    for await (const page of store.scanAll(t, proj)) out.push(...page)
    return out
  }
  const shipments = (await all('shipment', ['id', 'importRunId', 'createdBy', 'version'])).filter((s) => s.importRunId === runId && s.createdBy === 'aljex-import' && s.version === 1)
  const shipmentIds = new Set(shipments.map((s) => String(s.id)))
  io.out(`rollback ${runId}: ${shipmentIds.size} shipments from this run`)
  const ids = {
    order: (await all('order', ['id', 'shipmentId'])).filter((r) => shipmentIds.has(String(r.shipmentId))).map((r) => String(r.id)),
    load: (await all('load', ['id', 'shipmentId'])).filter((r) => shipmentIds.has(String(r.shipmentId))).map((r) => String(r.id)),
    loadCarrier: (await all('loadCarrier', ['id', 'shipmentId'])).filter((r) => shipmentIds.has(String(r.shipmentId))).map((r) => String(r.id)),
    loadCharge: (await all('loadCharge', ['id', 'shipmentId'])).filter((r) => shipmentIds.has(String(r.shipmentId))).map((r) => String(r.id)),
    invoice: (await all('invoice', ['id', 'shipmentId'])).filter((r) => shipmentIds.has(String(r.shipmentId))).map((r) => String(r.id)),
    carrierBill: (await all('carrierBill', ['id', 'shipmentId'])).filter((r) => shipmentIds.has(String(r.shipmentId))).map((r) => String(r.id)),
    legacyAljexRow: (await all('legacyAljexRow', ['id', 'shipmentId', 'importRunId'])).filter((r) => shipmentIds.has(String(r.shipmentId)) || (String(r.id).startsWith('aljex:memo:') && r.importRunId === runId)).map((r) => String(r.id)),
    proClaim: (await all('proClaim', ['id', 'shipmentId'])).filter((r) => shipmentIds.has(String(r.shipmentId))).map((r) => String(r.id)),
  }
  const invoiceIds = new Set(ids.invoice)
  const billIds = new Set(ids.carrierBill)
  const onlyOurs = (apps: unknown, set: Set<string>, key: string): boolean => Array.isArray(apps) && apps.length > 0 && apps.every((x) => set.has(String((x as Record<string, unknown>)[key])))
  const arPayments = (await all('arPayment', ['id', 'createdBy', 'applications'])).filter((p) => p.createdBy === 'aljex-import' && String(p.id).startsWith('arp-aljex-') && onlyOurs(p.applications, invoiceIds, 'invoiceId')).map((p) => String(p.id))
  const apPayments = (await all('apPayment', ['id', 'createdBy', 'applications'])).filter((p) => p.createdBy === 'aljex-import' && String(p.id).startsWith('app-aljex-') && onlyOurs(p.applications, billIds, 'billId')).map((p) => String(p.id))
  const stage = await readStageData(store, root).catch(() => null)
  const masters = stage
    ? {
        customer: stage.masters.customers.map((c) => stableId('cus', `aljex:${c.account}`)),
        carrier: stage.masters.carriers.map((c) => stableId('car', `aljex:${c.id}`)),
      }
    : { customer: [] as string[], carrier: [] as string[] }
  const plan: Array<[EngineTable, string[]]> = [
    ['arPayment', arPayments],
    ['apPayment', apPayments],
    ['carrierBill', ids.carrierBill],
    ['invoice', ids.invoice],
    ['loadCharge', ids.loadCharge],
    ['loadCarrier', ids.loadCarrier],
    ['loadFinancials', ids.load],
    ['legacyAljexRow', ids.legacyAljexRow],
    ['proClaim', ids.proClaim],
    ['load', ids.load],
    ['order', ids.order],
    ['shipment', [...shipmentIds]],
    ['customer', masters.customer],
    ['carrier', masters.carrier],
  ]
  for (const [t, list] of plan) io.out(`  ${MODEL_NAME[t].padEnd(16)} ${list.length}`)
  if (!a.flags.has('apply')) {
    io.out('dry run: add --apply to delete')
    return 0
  }
  for (const [t, list] of plan) await aws.deleteIds(t, list)
  io.out('rolled back')
  return 0
}

export async function main(argv: string[], io: CliIo = consoleIo): Promise<number> {
  try {
    const a = parseArgs(argv)
    const aws = () => new DynamoDBClient({ region: REGION })
    switch (a.command) {
      case 'run':
        return await cmdRun(a, io)
      case 'resume':
        return await cmdResume(a, io)
      case 'seed-counter':
        return await cmdSeed(a, io)
      case 'rollback':
        return await cmdRollback(a, io)
      case 'rehearsal-create': {
        const only = flag(a, 'tables')?.split(',') ?? null
        await backupCreate(aws(), need(a, 'tag'), only, io)
        await backupRestore(aws(), need(a, 'tag'), only, io)
        return 0
      }
      case 'backup-create':
        await backupCreate(aws(), need(a, 'tag'), flag(a, 'tables')?.split(',') ?? null, io)
        return 0
      case 'backup-restore':
        await backupRestore(aws(), need(a, 'tag'), flag(a, 'tables')?.split(',') ?? null, io)
        return 0
      case 'rehearsal-drop':
      case 'drop-copy':
        await rehearsalDrop(aws(), need(a, 'tag'), io)
        return 0
      case 'pitr-restore':
        await pitrRestore(aws(), need(a, 'table'), need(a, 'time'), need(a, 'as'), io)
        return 0
      case 'rehearsal-list': {
        const r = await aws().send(new ListTablesCommand({}))
        for (const n of r.TableNames ?? []) if (/-rh[a-z0-9]{3,12}$/.test(n)) io.out(n)
        return 0
      }
      default:
        io.err('commands: run | resume | seed-counter | rollback | rehearsal-create | rehearsal-drop | rehearsal-list | backup-create | backup-restore | pitr-restore | drop-copy')
        return 1
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    return 1
  }
}
