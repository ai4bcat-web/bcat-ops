/**
 * Offline driver for the import engine (bundled by scripts/importAljex.mjs). NEVER imported by the Lambda,
 * the router or the UI: it holds the dev-only operations the plan keeps out of every deployed path
 * (rehearsal table copies, restores, and the delete-based rollback).
 *
 *   run        stage -> plan -> apply a file against a rehearsal copy or (tagged) live dev
 *   resume     continue a RUNNING job recorded by an earlier invocation
 *   seed-counter, rehearsal-create/-drop, backup-create/-restore, pitr-restore, drop-copy, rollback
 *
 * Production: `main(argv, io, { prod })` where `prod` comes from `productionPolicy()` after scripts/importAljex.mjs passed the
 * shared production gate (scripts/lib/prodGate.mjs). Without that context every command is dev-only.
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
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { AljexEntityCounts, AljexImportJob, EngineRow, EngineStore, EngineTable, EngineTargetPolicy, TableSet, TxCondition } from '../../../../src/types/tms'
import { DynamoStore } from './dynamoStore'
import { MemoryStore } from './memoryStore'
import { reconcile } from './reconcile'
import { runSlice } from './runSlice'
import { seedProCounter } from './seedCounter'
import { evalCondition } from './stamp'
import { readStageData } from './stage'
import { assertTargets, DEV_SUFFIX, MODEL_NAME, ownStackSuffix, productionPolicy, PROD_SUFFIX, resolveTables, TAG_PATTERN, tableSetFor, WRITTEN_TABLES } from './tables'

export { productionPolicy }
import { stableId } from './util'
import { detectFileKind, FILE_KIND_LABEL, FILE_KIND_LAYOUT_ID, refusedHeaders, stripRefusedColumns, type FileKind } from '../../../../src/lib/aljex/fileKinds'
import { parseCsvRows } from '../../../../src/lib/aljex/layouts/apAging'
import { parseCarrierRows } from '../../../../src/lib/aljex/layouts/carriers'
import { decisionStats, reconCsv, RECON_ENTITIES, type ReconEntity } from '../../../../src/lib/aljexReconcile'
import { runFileImport, type FileAction } from '../fileImports'
import { buildReconReport } from '../reconcileEntity'

const REGION = 'us-east-1'
const JOBS_FILE = join(tmpdir(), 'aljex-cli-jobs.json')

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

/**
 * Production mode. Only scripts/importAljex.mjs builds this, and only after scripts/lib/prodGate.mjs passed every gate
 * (BCAT_ALLOW_PROD date, --i-mean-production, fresh prodpre- backups, typed account:suffix). Without it the CLI is
 * dev-only exactly as before.
 */
export interface CliContext {
  prod?: EngineTargetPolicy
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
  if (!m) throw new Error('--target must be rehearsal:<tag> or live:<liveTag> (production: scripts/importAljex.mjs --target prod:<liveTag> with every gate)')
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
    readonly targetPolicy?: EngineTargetPolicy,
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
  /** The one row the app must see (a RECONCILE job): written to the real AljexImportJob table. Only `reconcile-entity --apply`, after assertTargets. */
  async putJobRemote(job: AljexImportJob): Promise<void> {
    return super.putJob(job)
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
    readonly targetPolicy?: EngineTargetPolicy,
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
  return Object.fromEntries(Object.entries(MODEL_NAME).map(([k, model]) => [k, `${model}-${ownStackSuffix() ?? DEV_SUFFIX}`])) as unknown as TableSet
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

async function pitrRestore(db: DynamoDBClient, model: string, time: string, as: string, io: CliIo, policy?: EngineTargetPolicy): Promise<void> {
  const suffix = policy ? policy.writeSuffix : ownStackSuffix() ?? DEV_SUFFIX
  const source = `${model}-${suffix}`
  if (!Object.values(MODEL_NAME).includes(model)) throw new Error(`unknown model ${model}`)
  if (!new RegExp(`^${model}-${suffix}-rh[a-z0-9]{3,12}$`).test(as)) throw new Error(`--as must be ${model}-${suffix}-rh<tag>: restores never overwrite a table`)
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

async function openStore(a: Args, spec: TargetSpec, runId: string, sourcePath: string | null, ctx: CliContext): Promise<RunSetup> {
  if (ctx.prod && spec.target !== 'LIVE') throw new Error('production mode runs --target live:<liveTag> jobs only (no rehearsal tables)')
  const tables = ctx.prod ? tableSetFor(ctx.prod.readSuffix, ctx.prod.writeSuffix) : resolveTables(liveTableSet(), { target: spec.target, targetTag: spec.targetTag })
  const objects = new LocalObjects(runDirOf(runId), sourcePath)
  if (a.flags.has('memory')) {
    const book = new JobBook(null)
    return { store: new MemoryCliStore(tables, objects, book, ctx.prod), objects, book }
  }
  const db = new DynamoDBClient({ region: REGION })
  for (const t of WRITTEN_TABLES) {
    if (!(await tableExists(db, tables[t]))) throw new Error(`table ${tables[t]} does not exist${spec.target === 'REHEARSAL' ? ' (run rehearsal-create first)' : ''}`)
  }
  const book = new JobBook(JOBS_FILE)
  return { store: new AwsCliStore(db, tables, objects, book, ctx.prod), objects, book }
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

async function cmdRun(a: Args, io: CliIo, ctx: CliContext): Promise<number> {
  const spec = parseTarget(need(a, 'target'))
  const source = need(a, 'source')
  if (!existsSync(source)) throw new Error(`source not found: ${source}`)
  const sliceEvery = parseSlice(flag(a, 'slice'))
  const synthetic = a.flags.has('synthetic')
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rootId = `aljexrun:${stamp}`
  const { store, objects, book } = await openStore(a, spec, rootId, source, ctx)
  // Fail before any work if the target is unsafe.
  assertTargets(liveTableSet(), store.tables, { target: spec.target, targetTag: spec.targetTag, liveTag: spec.liveTag ?? 'plan' }, store.targetPolicy)
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
  io.out(`run ${rootId} target ${ctx.prod ? `PRODUCTION-GATED ${ctx.prod.writeSuffix} ` : ''}${spec.target}${spec.targetTag ? `:${spec.targetTag}` : ''} ${synthetic ? '(synthetic)' : '(real data)'}${sliceEvery ? ` slice every:${sliceEvery}` : ''}`)

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

async function cmdResume(a: Args, io: CliIo, ctx: CliContext): Promise<number> {
  const id = need(a, 'run')
  const spec = parseTarget(need(a, 'target'))
  const book = new JobBook(JOBS_FILE)
  const [row] = book.get([id])
  if (!row) throw new Error(`no such job in ${JOBS_FILE}`)
  const root = rootOf(book, row)
  const { store } = await openStore(a, spec, root, flag(a, 'source') ?? null, ctx)
  const job = await driveJob(store, id)
  io.out(`job ${id}: ${job.status}`)
  printCounts(io, job.entityCounts)
  return job.status === 'APPLIED' ? 0 : 1
}

async function cmdSeed(a: Args, io: CliIo, ctx: CliContext): Promise<number> {
  const spec = parseTarget(need(a, 'target'))
  const { store } = await openStore(a, spec, `seed-${Date.now()}`, null, ctx)
  assertTargets(liveTableSet(), store.tables, { target: spec.target, targetTag: spec.targetTag, liveTag: spec.liveTag ?? 'plan' }, store.targetPolicy)
  const result = await seedProCounter(store, { apply: a.flags.has('apply'), enableNumericScheme: a.flags.has('enable-numeric'), jobId: flag(a, 'run') ?? null })
  io.out(JSON.stringify(result))
  return 0
}

async function cmdRollback(a: Args, io: CliIo, ctx: CliContext): Promise<number> {
  if (!ctx.prod && !a.flags.has('i-understand-dev-only')) throw new Error('rollback deletes rows; pass --i-understand-dev-only (dev stack only), or run it through scripts/importAljex.mjs --target prod:<liveTag> with every production gate')
  const runId = need(a, 'run')
  const spec = parseTarget(need(a, 'target'))
  if (a.flags.has('memory')) throw new Error('rollback is for AWS tables only')
  const book = new JobBook(JOBS_FILE)
  const [job] = book.get([runId]) as unknown as AljexImportJob[]
  if (!job) throw new Error(`no such job ${runId} in ${JOBS_FILE}`)
  const root = rootOf(book, job as unknown as EngineRow)
  const { store } = await openStore(a, spec, root, null, ctx)
  assertTargets(liveTableSet(), store.tables, { target: spec.target, targetTag: spec.targetTag, liveTag: spec.liveTag ?? 'plan' }, store.targetPolicy)
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

// ── per-file imports, local staging, reconciliation (Step AW) ────────────────────────────────
// The offline replacement for the Lambda's per-file actions (router.ts refuses production tables in every Lambda mode).
// Same engine functions, same printed lines; production only through the importAljex.mjs gate (ctx.prod).

const FILE_COMMANDS: Record<string, { action: FileAction; files: Array<[FileKind, string]> }> = {
  customers: { action: 'CUSTOMERS_MASTER', files: [['CUSTOMERS_MASTER', 'file']] },
  carriers: { action: 'CARRIERS_MASTER', files: [['CARRIERS_MASTER', 'file']] },
  ap: { action: 'AP_FILES', files: [['AP_AGING', 'aging-file'], ['AP_EXPECTED', 'expected-file']] },
  ar: { action: 'AR_FILE', files: [['AR_REPORT', 'file']] },
  'active-check': { action: 'ACTIVE_SHIPMENTS_CHECK', files: [['ACTIVE_SHIPMENTS', 'file']] },
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const money = (cents: number | null): string => (cents == null ? 'n/a' : `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100).toLocaleString('en-US')}.${String(Math.abs(cents) % 100).padStart(2, '0')}`)
const newRunStamp = (): string => `${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}${Math.random().toString(36).slice(2, 8)}`

/** The file without every refused column (Web Password, Fed/SS #, Bank Account, Routing #...): stripped BEFORE anything reads it into a store. */
export function prepareUpload(expected: FileKind, text: string): { csv: string; dropped: string[]; rows: number } {
  const rows = parseCsvRows(text)
  const headers = rows[0] ?? []
  const kind = detectFileKind(headers)
  if (kind !== expected) throw new Error(`The file is not a ${FILE_KIND_LABEL[expected]} (its columns match ${kind ? FILE_KIND_LABEL[kind] : 'no known layout'})`)
  const stripped = stripRefusedColumns(kind, headers, rows.slice(1))
  const q = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const csv = `${[stripped.headers, ...stripped.rows].map((r) => r.map(q).join(',')).join('\n')}\n`
  if (refusedHeaders(kind, stripped.headers).length > 0) throw new Error('Sensitive columns survived the strip: refusing')
  return { csv, dropped: stripped.dropped, rows: stripped.rows.length }
}

function printFileResult(io: CliIo, label: string, mode: string, jobId: string, status: string, result: Awaited<ReturnType<typeof runFileImport>>): void {
  io.out(`\n== ${label} (${mode}) job ${jobId} ${status}`)
  for (const [entity, c] of Object.entries(result.counts ?? {})) {
    if (c) io.out(`  ${entity.padEnd(9)} staged ${c.staged}  created ${c.created}  matched ${c.matched}  enriched ${c.enriched}  skipped ${c.skipped}  conflicts ${c.conflicts}  errors ${c.errors}`)
  }
  for (const [k, v] of Object.entries(result.summary)) {
    if (typeof v === 'number') io.out(`  ${k}: ${/Cents$/.test(k) ? `$${money(v)}` : v}`)
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = Object.entries(v).filter(([, x]) => typeof x === 'number').map(([k2, x]) => `${k2} ${/Cents$/.test(k2) ? `$${money(x as number)}` : x}`)
      if (inner.length) io.out(`  ${k}: ${inner.join(', ')}`)
    }
  }
  const rec = result.reconcile as { bridge?: Array<{ key: string; fileCents: number | null; bcatCents: number | null; diffCents: number | null }>; allMatched?: boolean } | null
  for (const b of rec?.bridge ?? []) io.out(`  tie-out ${String(b.key).padEnd(18)} file $${money(b.fileCents)}  BCAT $${money(b.bcatCents)}  diff $${money(b.diffCents)}`)
  if (rec) io.out(`  every row matched: ${rec.allMatched ? 'YES' : 'NO'}`)
  io.out(`  needs a look: ${result.review.length} (keys only, in the report files)`)
}

/** PLAN view of a store: reads fall through, entity writes stay in memory, and neither job rows nor report objects are written anywhere. */
function planOverlay(store: EngineStore): EngineStore {
  const quiet = Object.create(store) as EngineStore
  quiet.putJob = async () => {}
  quiet.putObject = async () => {}
  return new MemoryStore({ tables: store.tables, base: quiet })
}

async function cmdFile(a: Args, io: CliIo, ctx: CliContext): Promise<number> {
  const name = need(a, 'kind')
  const spec = FILE_COMMANDS[name]
  if (!spec) throw new Error(`--kind must be ${Object.keys(FILE_COMMANDS).join(' | ')}`)
  const tgt = parseTarget(need(a, 'target'))
  const cutoff = need(a, 'cutoff')
  if (!DAY.test(cutoff)) throw new Error('--cutoff must be YYYY-MM-DD')
  const apply = a.flags.has('apply')
  const given = spec.files.filter(([, f]) => flag(a, f))
  if (given.length === 0) throw new Error(`${name} needs ${spec.files.map(([, f]) => `--${f}`).join(' and/or ')}`)
  if (apply && !tgt.liveTag) throw new Error('--apply needs a live tag')
  const stamp = newRunStamp()
  // Strip first: nothing below ever sees a refused column.
  const prepared: Array<{ kind: FileKind; flagName: string; csv: string; id: string; fileName: string }> = []
  for (const [kind, f] of given) {
    const path = need(a, f)
    if (!existsSync(path)) throw new Error(`file not found: ${path}`)
    const raw = readFileSync(path, 'utf8')
    if (kind === 'CARRIERS_MASTER') {
      const rows = parseCsvRows(raw)
      const n = parseCarrierRows(rows[0] ?? [], rows.slice(1)).counts.sensitiveRows
      io.out(`  rows with a value in the columns that are NOT imported: Fed/SS # ${n.fedSs}, Bank Account ${n.bankAccount}, Routing # ${n.routing}`)
    }
    const p = prepareUpload(kind, raw)
    if (p.dropped.length) io.out(`  stripped before upload: ${p.dropped.join(', ')}`)
    const id = `aljexrun:${stamp}${kind === 'AP_EXPECTED' ? 'e' : ''}`
    io.out(`  uploaded ${kind}: job ${id}, ${p.rows} rows`)
    prepared.push({ kind, flagName: f, csv: p.csv, id, fileName: path.split('/').pop() ?? `${kind}.csv` })
  }
  const primary = prepared[0].id
  const { store, objects, book } = await openStore(a, tgt, primary, null, ctx)
  assertTargets(liveTableSet(), store.tables, { target: tgt.target, targetTag: tgt.targetTag, liveTag: tgt.liveTag ?? 'plan' }, store.targetPolicy)
  const texts: Partial<Record<FileKind, string>> = {}
  for (const p of prepared) texts[p.kind] = p.csv
  const label = name
  const planned = await runFileImport(planOverlay(store), spec.action, { runId: `${primary}-plan`, cutoff, texts })
  printFileResult(io, `${label} dry run`, 'PLAN', primary, 'PLANNED', planned)
  if (!apply) {
    io.out('\nDry run only: nothing was written. Add --apply --live-tag <TAG> to apply.')
    return 0
  }
  // APPLY: the stripped copy is the only source file kept (0600, in the run directory), then the guarded store writes.
  const now = new Date().toISOString()
  for (const p of prepared) {
    const rel = `source/${p.fileName}`
    objects.put(rel, p.csv)
    book.put({ id: p.id, kind: 'IMPORT', status: 'RUNNING', phase: 'APPLY', fileName: p.fileName, layoutId: FILE_KIND_LAYOUT_ID[p.kind], target: 'LIVE', liveTag: tgt.liveTag, options: { cutoffDate: cutoff, liveTag: tgt.liveTag, sourcePath: join(objects.dir, rel) }, createdBy: 'awProd-offline', createdAt: now } as unknown as EngineRow)
  }
  const done = await runFileImport(store, spec.action, { runId: primary, cutoff, texts })
  for (const p of prepared) await store.update('aljexImportJob', p.id, { status: 'APPLIED', phase: 'DONE', entityCounts: done.counts, reportPrefix: `imports/runs/${primary}/`, finishedAt: new Date().toISOString(), appliedAt: new Date().toISOString(), appliedBy: 'awProd-offline' })
  printFileResult(io, `${label} apply`, 'APPLY', primary, 'APPLIED', done)
  io.out(`  report files and the stripped source copy: ${objects.dir} (0600; delete after review)`)
  return 0
}

/** Local stage of the big export: STAGE only (no table is read for writing, nothing leaves the machine). Job and stage objects live in the local job book / run directory. */
async function cmdStage(a: Args, io: CliIo, ctx: CliContext): Promise<number> {
  const spec = parseTarget(need(a, 'target'))
  const source = need(a, 'source')
  if (!existsSync(source)) throw new Error(`source not found: ${source}`)
  const rootId = `aljexrun:${newRunStamp()}`
  const { store, book } = await openStore(a, spec, rootId, source, ctx)
  assertTargets(liveTableSet(), store.tables, { target: spec.target, targetTag: spec.targetTag, liveTag: spec.liveTag ?? 'plan' }, store.targetPolicy)
  const fileName = source.split('/').pop() ?? 'export.csv'
  book.put({ id: rootId, kind: 'IMPORT', status: 'STAGING', phase: 'STAGE', fileName, target: spec.target, targetTag: spec.targetTag, liveTag: spec.liveTag, synthetic: false, options: { sourcePath: source }, createdBy: 'awProd-offline' } as unknown as EngineRow)
  const staged = await driveJob(store, rootId)
  if (staged.status !== 'READY') return fail(io, staged)
  const stage = await readStageData(store, rootId)
  io.out(`\n== big export staged: job ${rootId}, ${stage.index.rows} rows, stage hash ${String(staged.stageHash).slice(0, 12)} (no table was written)`)
  return 0
}

const ymd = (v: string | undefined, what: string): string => {
  if (!v || !DAY.test(v)) throw new Error(`${what} must be YYYY-MM-DD`)
  return v
}

async function cmdReconcile(a: Args, io: CliIo, ctx: CliContext): Promise<number> {
  const entity = need(a, 'entity') as ReconEntity
  if (!RECON_ENTITIES.includes(entity)) throw new Error(`--entity must be ${RECON_ENTITIES.join(' | ')}`)
  const spec = parseTarget(need(a, 'target'))
  const cutoff = ymd(flag(a, 'cutoff') ?? new Date().toISOString().slice(0, 10), '--cutoff')
  const asOf = ymd(flag(a, 'as-of') ?? cutoff, '--as-of')
  const apply = a.flags.has('apply')
  const book = new JobBook(JOBS_FILE)
  const jobOf = (id: string): AljexImportJob => {
    const [row] = book.get([id])
    if (!row) throw new Error(`no such job ${id} in ${JOBS_FILE} (jobs of the offline file steps / stage-export live there)`)
    return row as unknown as AljexImportJob
  }
  const source = jobOf(need(a, 'source-job'))
  const customersJob = flag(a, 'customers-job') ? jobOf(flag(a, 'customers-job') as string) : null
  const { store } = await openStore(a, spec, rootOf(book, source as unknown as EngineRow), null, ctx)
  assertTargets(liveTableSet(), store.tables, { target: spec.target, targetTag: spec.targetTag, liveTag: spec.liveTag ?? 'plan' }, store.targetPolicy)
  const paths = new Map<string, string>()
  for (const j of [source, customersJob]) {
    const p = (j?.options as { sourcePath?: string } | null | undefined)?.sourcePath
    if (j && p) paths.set(j.id, p)
  }
  const report = await buildReconReport(store, {
    streamText: async function* (key) {
      const path = paths.get(key.split('/')[2] ?? '')
      if (!path) throw new Error(`no local source file for ${key}`)
      for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })) yield chunk as string
    },
  }, { entity, source, customersJob, asOf, cutoffDate: cutoff, generatedAt: new Date().toISOString() })
  const c = report.counts
  io.out(`\n== reconcile ${entity} job ${source.id}\n  Aljex rows ${c.aljexRows}  BCAT rows ${c.bcatRows}  matched ${c.matched}  Aljex-only ${c.aljexOnly}  BCAT-only ${c.bcatOnly}  mismatched ${c.mismatched}  differences ${c.diffs}`)
  if (report.money) io.out(`  money: Aljex $${money(report.money.aljexCents)}  BCAT $${money(report.money.bcatCents)}  diff $${money(report.money.diffCents)}`)
  if (!apply) {
    io.out('\nDry run only: nothing was written. Add --apply (with --bucket) to publish the report for Jenny.')
    return 0
  }
  const bucket = need(a, 'bucket')
  const aws = store as unknown as AwsCliStore
  if (typeof aws.putJobRemote !== 'function') throw new Error('publishing a reconciliation needs the AWS store (not --memory)')
  const id = `aljexrec:${entity}:${newRunStamp()}`
  const prefix = `imports/runs/${id}/`
  const s3 = new S3Client({ region: REGION })
  const put = (name: string, body: string, type: string) => s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}${name}`, Body: body, ContentType: type }))
  await put(`reconcile-${report.entity.toLowerCase()}.json`, JSON.stringify(report), 'application/json')
  await put(`reconcile-${report.entity.toLowerCase()}.csv`, reconCsv(report, []), 'text/csv')
  const now = new Date().toISOString()
  await aws.putJobRemote({
    id, kind: 'RECONCILE', status: 'APPLIED', phase: 'RECONCILE', parentJobId: source.id, reportPrefix: prefix,
    options: { entity, asOf, cutoffDate: cutoff, ...(customersJob ? { customersJobId: customersJob.id } : {}), counts: report.counts, stats: decisionStats(report.diffs, []) },
    decisions: '[]', startedAt: now, heartbeatAt: now, finishedAt: now, createdBy: 'awProd-offline', createdAt: now, updatedAt: now,
  } as unknown as AljexImportJob)
  io.out(`  published: ${id} (Settings > Data > Aljex reconciliation)`)
  return 0
}


export async function main(argv: string[], io: CliIo = consoleIo, ctx: CliContext = {}): Promise<number> {
  try {
    const a = parseArgs(argv)
    if (ctx.prod && !['run', 'resume', 'seed-counter', 'rollback', 'pitr-restore', 'file', 'stage', 'reconcile-entity'].includes(a.command)) {
      throw new Error(`production mode runs run | resume | seed-counter | rollback | pitr-restore | file | stage | reconcile-entity only; "${a.command}" is dev tooling (backups: scripts/prodBackup.mjs)`)
    }
    const aws = () => new DynamoDBClient({ region: REGION })
    switch (a.command) {
      case 'run':
        return await cmdRun(a, io, ctx)
      case 'resume':
        return await cmdResume(a, io, ctx)
      case 'seed-counter':
        return await cmdSeed(a, io, ctx)
      case 'file':
        return await cmdFile(a, io, ctx)
      case 'stage':
        return await cmdStage(a, io, ctx)
      case 'reconcile-entity':
        return await cmdReconcile(a, io, ctx)
      case 'rollback':
        return await cmdRollback(a, io, ctx)
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
        await pitrRestore(aws(), need(a, 'table'), need(a, 'time'), need(a, 'as'), io, ctx.prod)
        return 0
      case 'rehearsal-list': {
        const r = await aws().send(new ListTablesCommand({}))
        for (const n of r.TableNames ?? []) if (/-rh[a-z0-9]{3,12}$/.test(n)) io.out(n)
        return 0
      }
      default:
        io.err('commands: run | resume | file | stage | reconcile-entity | seed-counter | rollback | rehearsal-create | rehearsal-drop | rehearsal-list | backup-create | backup-restore | pitr-restore | drop-copy')
        return 1
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    return 1
  }
}
