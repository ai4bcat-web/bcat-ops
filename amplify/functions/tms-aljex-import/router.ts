/**
 * tms-aljex-import router — Aljex-exit Phase 0. (`handler.ts` wires it to AWS.)
 *
 * Two jobs in one function:
 *
 *  1. AppSync router for the import pipeline (owner/ADMIN only): prepare an upload, stage,
 *     plan, apply, pause/resume/cancel, reconcile, profile, counter seed, carrier sync.
 *     Every action returns in well under AppSync's 30 s: anything long is handed to
 *  2. the async worker — the same Lambda invoked with `InvocationType: 'Event'` and
 *     `{ kind: 'WORK', jobId }`. It drives the engine's `runSlice` until the deadline
 *     (≤ 900 s minus a safety margin), the engine checkpoints its cursor, and the worker
 *     re-invokes itself while work remains. A job whose heartbeat goes quiet is shown as
 *     Stalled in the UI and `IMPORT_RESUME` re-enters at the cursor.
 *
 * All the logic lives in `createRouter(deps)` so tests run it over the engine's MemoryStore
 * with fake S3 / Lambda / MCP dependencies.
 */
import { randomUUID } from 'crypto'
import type { Caller } from '../_shared/actionInputs'
import type { Row } from '../_shared/shipmentStore'
import { createCsvParser } from '../../../src/lib/aljex/csv'
import { detectLayout } from '../../../src/lib/aljex/layout'
import { mapAljexRow } from '../../../src/lib/aljex/mapRow'
import { DEFAULT_ALJEX_PROFILE } from '../../../src/lib/aljex/profile'
import type {
  AljexImportAction,
  AljexImportJob,
  AljexImportOptions,
  AljexImportStatus,
  AljexMappingProfile,
  AljexPlanSummary,
  AljexRehearsalGate,
  AljexReportLink,
  AljexSampleRow,
  AljexStageSummary,
  EngineRow,
  LegacyAljexFields,
  LegacyAljexRowRecord,
  LegacyAljexRowResult,
  EngineStore,
  ImportReportSummary,
  RunSliceResult,
  SeedProCounterInput,
  SeedProCounterResult,
} from '../../../src/types/tms'
import { legacyAljexColumns } from '../../../src/lib/legacyAljexRow'

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'

export const ACTIONS: AljexImportAction[] = [
  'IMPORT_PREPARE',
  'IMPORT_STAGE',
  'IMPORT_GET',
  'IMPORT_LIST',
  'IMPORT_SAVE_PROFILE',
  'IMPORT_GET_PROFILE',
  'IMPORT_PLAN',
  'IMPORT_APPLY',
  'IMPORT_PAUSE',
  'IMPORT_RESUME',
  'IMPORT_CANCEL',
  'IMPORT_RECONCILE',
  'IMPORT_REPORT_LINKS',
  'IMPORT_SEED_COUNTER',
  'IMPORT_SYNC_CARRIERS',
  'IMPORT_SAMPLE',
  'IMPORT_LEGACY_ROW',
  'IMPORT_STEP',
]

/** A RUNNING job whose heartbeat is older than this is stalled and may be resumed. */
export const STALLED_AFTER_MS = 3 * 60 * 1000
/** Files above this are refused (the plan's 200 MB cap). */
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024
/** The worker keeps this much of the invocation back for its own bookkeeping and the re-invoke. */
const WORKER_MARGIN_MS = 90_000
/** Chain guard: 200 invocations of ~13 minutes is far past any real import. */
const MAX_HOPS = 200
/** Carriers per MyCarrierPackets batch (plan §5.7). */
const MCP_BATCH = 25
export const PRESIGN_SECONDS = 15 * 60
const ACTIVE_STATUSES: AljexImportStatus[] = ['STAGING', 'PLANNING', 'RUNNING']
/** Unmapped values in these columns stop APPLY (rep / dispatcher / safety-rating gaps are only listed). */
const BLOCKING_UNMAPPED_COLUMNS: ReadonlySet<string> = new Set(['status', 'typeOfShipment', 'stopMarkers'])
const TAG_PATTERN = /^[a-z0-9]{3,12}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export class RouterError extends Error {}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface RouterDeps {
  store: EngineStore
  /** Live table names; the engine resolves rehearsal targets from them. */
  bucket: string
  now: () => string
  /** Dev-only gates (fault injection) */
  devStack: boolean
  runSlice: (store: EngineStore, jobId: string, deadlineMs: number) => Promise<RunSliceResult>
  seedProCounter: (store: EngineStore, input: SeedProCounterInput) => Promise<SeedProCounterResult>
  reconcile: (store: EngineStore, jobId: string) => Promise<ImportReportSummary>
  /** Self-invoke, fire and forget. */
  invokeSelf: (payload: Record<string, unknown>) => Promise<void>
  /** Presigned URLs. */
  presignPut: (key: string, contentType: string) => Promise<string>
  presignGet: (key: string) => Promise<string>
  headObject: (key: string) => Promise<{ size: number } | null>
  listObjects: (prefix: string) => Promise<Array<{ key: string; size: number }>>
  getText: (key: string) => Promise<string | null>
  /** Streams the object as text chunks. */
  streamText: (key: string) => AsyncIterable<string>
  putText: (key: string, body: string) => Promise<void>
  /** MyCarrierPackets sync Lambda (RequestResponse). */
  invokeMcp: (payload: Record<string, unknown>) => Promise<McpBatchResponse>
  remainingMs: () => number
  randomId: () => string
}

export interface McpBatchResponse {
  ready: boolean
  reason?: string
  results: Array<{ carrierId: string; result: 'SYNCED' | 'NO_PACKET' | 'ERROR' }>
  cursor: { lastCarrierId: string } | null
  done: boolean
}

type Json = Record<string, unknown>

// ── Small helpers ───────────────────────────────────────────────────────────

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** AWSJSON attributes may come back as JSON text or as native maps; accept both. */
function parseJsonField<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'string') {
    if (!v.trim()) return null
    try {
      return JSON.parse(v) as T
    } catch {
      return null
    }
  }
  return v as T
}

export function normalizeJob(row: EngineRow | Row | null | undefined): AljexImportJob | null {
  if (!row) return null
  const r = row as Json
  return {
    ...(r as unknown as AljexImportJob),
    cursor: parseJsonField(r.cursor),
    options: parseJsonField(r.options),
    entityCounts: parseJsonField(r.entityCounts),
    mapping: parseJsonField(r.mapping),
    counts: parseJsonField(r.counts),
  }
}

function str(input: Json, key: string, max = 500): string {
  const v = input[key]
  if (typeof v !== 'string') return ''
  return v.trim().slice(0, max)
}

function requireStr(input: Json, key: string): string {
  const v = str(input, key)
  if (!v) throw new RouterError(`${key} is required`)
  return v
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '_').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(-120)
  return cleaned || 'aljex-export.csv'
}

/** Follows `parentJobId` to the job that has none (the run that owns the staged chunks). */
export async function rootJobId(store: EngineStore, job: AljexImportJob): Promise<string> {
  let cur = job
  for (let i = 0; i < 8 && cur.parentJobId; i++) {
    const [row] = await store.getMany('aljexImportJob', [cur.parentJobId])
    const parent = normalizeJob(row)
    if (!parent) break
    cur = parent
  }
  return cur.id
}

function newJobId(deps: RouterDeps): string {
  // Sortable by creation time, unique without coordination: aljexrun:<time36>-<random>.
  return `aljexrun:${Date.now().toString(36).padStart(9, '0')}${deps.randomId()}`
}

/** Validates and normalises the options a client may send. Unknown keys (e.g. sourceKey) are dropped. */
export function sanitizeOptions(raw: unknown, devStack: boolean, synthetic: boolean): AljexImportOptions {
  const input = isObject(raw) ? raw : {}
  const out: AljexImportOptions = {}
  if (input.target !== undefined) {
    if (input.target !== 'LIVE' && input.target !== 'REHEARSAL') throw new RouterError('options.target must be LIVE or REHEARSAL')
    out.target = input.target
  }
  if (typeof input.targetTag === 'string' && input.targetTag.trim()) {
    const tag = input.targetTag.trim()
    if (!TAG_PATTERN.test(tag)) throw new RouterError('options.targetTag must be 3-12 lowercase letters or digits')
    out.targetTag = tag
  }
  if (typeof input.liveTag === 'string' && input.liveTag.trim()) out.liveTag = input.liveTag.trim().slice(0, 60)
  for (const key of ['cutoffDate', 'carrierCutoffDate', 'unbilledLegacyBefore', 'asOf'] as const) {
    const v = input[key]
    if (v == null || v === '') continue
    if (typeof v !== 'string' || !DATE_PATTERN.test(v)) throw new RouterError(`options.${key} must be YYYY-MM-DD`)
    out[key] = v
  }
  for (const key of ['carrierWindowMonths', 'expectedRows', 'sliceEvery'] as const) {
    const v = input[key]
    if (v == null || v === '') continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10_000_000) throw new RouterError(`options.${key} must be a positive integer`)
    out[key] = v
  }
  if (input.synthetic === true) out.synthetic = true
  // Fault injection exists for the dev harness only: dev stack AND a synthetic file.
  if (typeof input.faultAfterRows === 'number' && devStack && synthetic) {
    out.faultAfterRows = Math.max(1, Math.floor(input.faultAfterRows))
  }
  return out
}

// ── Authorization ───────────────────────────────────────────────────────────

export interface AppSyncIdentity {
  sub: string
  username: string
  claims: Record<string, unknown>
}

function getGroups(identity?: AppSyncIdentity | null): string[] {
  if (!identity) return []
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export type EmailResolver = (identity: AppSyncIdentity) => Promise<string>

export async function authorize(identity: AppSyncIdentity | null | undefined, resolveEmail: EmailResolver): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await resolveEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)
  if (!isAdmin) throw new Error('Forbidden: Aljex import requires owner or ADMIN')
  return { email, sub: identity.sub, groups, isAdmin }
}

// ── The router ──────────────────────────────────────────────────────────────

export interface Router {
  dispatch(action: string, input: Json, caller: Caller): Promise<Json>
  work(payload: { kind: string; jobId: string; hops?: number }): Promise<Json>
}

export function createRouter(deps: RouterDeps): Router {
  const { store } = deps

  async function getJob(id: string): Promise<AljexImportJob> {
    if (!id) throw new RouterError('jobId is required')
    const [row] = await store.getMany('aljexImportJob', [id])
    const job = normalizeJob(row)
    if (!job) throw new RouterError(`Import job ${id} not found`)
    return job
  }

  async function readJson<T>(key: string): Promise<T | null> {
    const text = await deps.getText(key)
    if (!text) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  async function audit(caller: Caller, entityId: string, action: string, changes: Json): Promise<void> {
    const now = deps.now()
    await store.batchPut('auditLog', [{
      id: randomUUID(),
      __typename: 'AuditLog',
      entityType: 'AljexImport',
      entityId,
      action,
      user: caller.email,
      changes: JSON.stringify(changes),
      createdAt: now,
      updatedAt: now,
    }])
  }

  /** Conditional status flip; false when the job was not in one of the allowed states. */
  async function flip(job: AljexImportJob, from: AljexImportStatus[], patch: EngineRow): Promise<boolean> {
    const names: Record<string, string> = { '#s': 'status' }
    const values: Record<string, unknown> = {}
    from.forEach((s, i) => { values[`:f${i}`] = s })
    const expression = from.map((_, i) => `#s = :f${i}`).join(' OR ')
    return store.update('aljexImportJob', job.id, { ...patch, updatedAt: deps.now() }, { expression, names, values })
  }

  /** Attach S3-held summaries and the rehearsal gate; none of this is stored on the row. */
  async function decorate(job: AljexImportJob): Promise<AljexImportJob> {
    const root = await rootJobId(store, job)
    const [stage, plan] = await Promise.all([
      readJson<AljexStageSummary>(`imports/jobs/${root}/stage-summary.json`),
      readJson<AljexPlanSummary>(`imports/jobs/${root}/plan-summary.json`),
    ])
    const out: AljexImportJob = { ...job, stage, plan }
    if (job.status === 'PLANNED' || job.status === 'READY') out.rehearsalGate = await rehearsalGate(job)
    return out
  }

  /** Real data may only go LIVE after a reconciled rehearsal of the same file + profile (plan §4.7). */
  async function rehearsalGate(job: AljexImportJob): Promise<AljexRehearsalGate> {
    const options = job.options ?? {}
    if (options.target !== 'LIVE') return { ok: true }
    if (job.synthetic || options.synthetic) return { ok: true }
    if (!job.stageHash) return { ok: false, reason: 'The file has not been staged yet.' }
    for await (const page of store.scanAll('aljexImportJob')) {
      for (const row of page) {
        const j = normalizeJob(row)
        if (!j || j.target !== 'REHEARSAL' || j.status !== 'APPLIED') continue
        if (j.stageHash !== job.stageHash) continue
        if (job.profileVersion != null && j.profileVersion !== job.profileVersion) continue
        if (j.options?.reconciled === true) return { ok: true }
      }
    }
    return { ok: false, reason: 'Real data goes live only after a reconciled rehearsal of this same file and profile. Run it on a rehearsal copy first.' }
  }

  async function kickWorker(jobId: string, kind = 'WORK'): Promise<void> {
    await deps.invokeSelf({ kind, jobId, hops: 0 })
  }

  async function currentProfile(layoutId: string | null | undefined): Promise<AljexMappingProfile | null> {
    if (!layoutId) return null
    const [row] = await store.getMany('aljexMappingProfile', [layoutId])
    if (!row) return null
    return { ...(row as unknown as AljexMappingProfile), profile: parseJsonField(row.profile) ?? {} }
  }

  // ── actions ──────────────────────────────────────────────────────────────

  async function prepare(input: Json, caller: Caller): Promise<Json> {
    const fileName = safeFileName(requireStr(input, 'fileName'))
    const fileHash = requireStr(input, 'fileHash').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(fileHash)) throw new RouterError('fileHash must be a sha256 hex digest')
    const sizeBytes = typeof input.sizeBytes === 'number' ? input.sizeBytes : NaN
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new RouterError('sizeBytes is required')
    if (sizeBytes > MAX_SOURCE_BYTES) throw new RouterError(`The file is ${Math.round(sizeBytes / 1048576)} MB; imports above ${MAX_SOURCE_BYTES / 1048576} MB are refused`)
    const id = newJobId(deps)
    const now = deps.now()
    const layoutId = str(input, 'layoutId', 80) || null
    const job: AljexImportJob = {
      id,
      kind: 'IMPORT',
      status: 'STAGING',
      phase: 'UPLOAD',
      fileName,
      fileHash,
      layoutId,
      options: { sizeBytes } as AljexImportOptions,
      createdBy: caller.email,
      createdAt: now,
      updatedAt: now,
    }
    await store.putJob(job)
    const uploadKey = `imports/source/${id}/${fileName}`
    const uploadUrl = await deps.presignPut(uploadKey, 'text/csv')
    return { job, uploadUrl, uploadKey }
  }

  async function stage(input: Json): Promise<Json> {
    const job = await getJob(requireStr(input, 'jobId'))
    if (job.kind === 'MCP_SYNC') throw new RouterError('That job is a carrier sync, not an import')
    if (job.status !== 'STAGING' || job.phase !== 'UPLOAD') throw new RouterError(`Job is ${job.status}/${job.phase ?? '-'}; staging starts only from a fresh upload`)
    const key = `imports/source/${job.id}/${job.fileName}`
    const head = await deps.headObject(key)
    if (!head) throw new RouterError('The uploaded file is not in the bucket yet')
    const expected = Number(job.options?.sizeBytes ?? 0)
    if (expected && head.size !== expected) throw new RouterError(`Uploaded ${head.size} bytes but the browser announced ${expected}; upload again`)
    const now = deps.now()
    const ok = await flip(job, ['STAGING'], { phase: 'STAGE', startedAt: now, heartbeatAt: now, error: null })
    if (!ok) throw new RouterError('The job changed while starting; refresh and try again')
    await kickWorker(job.id)
    return { job: await decorate(await getJob(job.id)) }
  }

  async function get(input: Json): Promise<Json> {
    const job = await decorate(await getJob(requireStr(input, 'jobId')))
    const summary = await readSummary(job)
    return { job: summary ? { ...job, summary } : job, summary }
  }

  async function readSummary(job: AljexImportJob): Promise<ImportReportSummary | null> {
    if (!job.reportPrefix && job.status !== 'APPLIED') return null
    const prefix = (job.reportPrefix ?? `imports/runs/${job.id}/`).replace(/\/?$/, '/')
    return readJson<ImportReportSummary>(`${prefix}summary.json`)
  }

  async function list(): Promise<Json> {
    const jobs: AljexImportJob[] = []
    for await (const page of store.scanAll('aljexImportJob')) {
      for (const row of page) {
        const j = normalizeJob(row)
        if (j) jobs.push(j)
      }
    }
    jobs.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return { jobs, count: jobs.length }
  }

  async function getProfile(input: Json): Promise<Json> {
    const layoutId = requireStr(input, 'layoutId')
    const stored = await currentProfile(layoutId)
    if (stored) return { profile: stored }
    // Pre-filled from the shipped defaults (ALJEX_MAPPING.md); version 0 = never saved.
    const virtual: AljexMappingProfile = {
      id: layoutId,
      fingerprint: '',
      headerCount: 0,
      version: 0,
      profile: JSON.parse(JSON.stringify(DEFAULT_ALJEX_PROFILE)),
      createdBy: 'default',
      updatedBy: 'default',
    }
    return { profile: virtual }
  }

  async function saveProfile(input: Json, caller: Caller): Promise<Json> {
    const layoutId = requireStr(input, 'layoutId')
    if (!isObject(input.profile)) throw new RouterError('profile is required')
    const expected = typeof input.expectedVersion === 'number' ? input.expectedVersion : 0
    const existing = await currentProfile(layoutId)
    const currentVersion = existing?.version ?? 0
    if (expected !== currentVersion) {
      throw new RouterError(`The profile changed (now version ${currentVersion}); reload before saving`)
    }
    const now = deps.now()
    const version = currentVersion + 1
    const row: EngineRow = {
      id: layoutId,
      __typename: 'AljexMappingProfile',
      fingerprint: str(input, 'fingerprint', 200) || existing?.fingerprint || '',
      headerCount: typeof input.headerCount === 'number' ? input.headerCount : (existing?.headerCount ?? 0),
      version,
      profile: input.profile,
      createdBy: existing?.createdBy ?? caller.email,
      updatedBy: caller.email,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (existing) {
      const ok = await store.update('aljexMappingProfile', layoutId, row, {
        expression: '#v = :v',
        names: { '#v': 'version' },
        values: { ':v': currentVersion },
      })
      if (!ok) throw new RouterError('The profile changed while saving; reload and try again')
    } else {
      const r = await store.transact([{ op: 'put', table: 'aljexMappingProfile', item: row, ifNotExists: true }], 'saveProfile')
      if (!r.ok) throw new RouterError('The profile changed while saving; reload and try again')
    }
    await audit(caller, layoutId, 'SAVE_PROFILE', { version })
    return { profile: { ...(row as unknown as AljexMappingProfile) } }
  }

  async function plan(input: Json, caller: Caller): Promise<Json> {
    const job = await getJob(requireStr(input, 'jobId'))
    if (job.kind === 'MCP_SYNC') throw new RouterError('That job is a carrier sync, not an import')
    if (job.status !== 'READY' && job.status !== 'PLANNED') throw new RouterError(`Plan runs on a staged file; the job is ${job.status}`)
    const synthetic = job.synthetic === true || job.options?.synthetic === true
    const options = sanitizeOptions(input.options, deps.devStack, synthetic)
    if (!options.target) throw new RouterError('options.target is required (LIVE or REHEARSAL)')
    if (options.target === 'REHEARSAL' && !options.targetTag) throw new RouterError('A rehearsal target needs options.targetTag')
    const profile = await currentProfile(job.layoutId)
    const merged: AljexImportOptions = { ...(job.options ?? {}), ...options }
    delete merged.reconciled
    const now = deps.now()
    const ok = await flip(job, ['READY', 'PLANNED'], {
      status: 'PLANNING',
      phase: 'PLAN',
      options: merged,
      target: options.target,
      targetTag: options.targetTag ?? null,
      liveTag: null,
      profileVersion: profile?.version ?? 0,
      heartbeatAt: now,
      error: null,
    })
    if (!ok) throw new RouterError('The job changed while starting the plan; refresh and try again')
    await audit(caller, job.id, 'PLAN', { target: options.target, targetTag: options.targetTag ?? null })
    await kickWorker(job.id)
    return { job: await decorate(await getJob(job.id)) }
  }

  async function apply(input: Json, caller: Caller): Promise<Json> {
    const planned = await getJob(requireStr(input, 'jobId'))
    if (planned.kind === 'MCP_SYNC') throw new RouterError('That job is a carrier sync, not an import')
    if (planned.status !== 'PLANNED') throw new RouterError(`Only a PLANNED job can be applied; this one is ${planned.status}`)
    const synthetic = planned.synthetic === true || planned.options?.synthetic === true
    const sent = sanitizeOptions(input.options, deps.devStack, synthetic)
    const options: AljexImportOptions = { ...(planned.options ?? {}), ...sent }
    const target = options.target ?? planned.target
    if (!target) throw new RouterError('The plan has no target')
    options.target = target
    if (target === 'REHEARSAL' && !options.targetTag) throw new RouterError('A rehearsal target needs options.targetTag')
    if (target === 'LIVE' && !options.liveTag) throw new RouterError('Applying to the live tables needs the confirmation tag (options.liveTag)')
    if (!planned.stageHash) throw new RouterError('The plan has no stage hash')

    // The UI sends the row count it showed; refuse if the staged file is a different size.
    const stageSummary = (await decorate(planned)).stage
    const stagedRows = stageSummary?.rows ?? planned.rowCount ?? null
    if (options.expectedRows != null && stagedRows != null && options.expectedRows !== stagedRows) {
      throw new RouterError(`The UI expected ${options.expectedRows} rows but the staged file has ${stagedRows}; re-plan`)
    }
    // Plan and apply must see the same mapping profile.
    const profile = await currentProfile(planned.layoutId)
    if ((profile?.version ?? 0) !== (planned.profileVersion ?? 0)) {
      throw new RouterError('The mapping profile changed after this plan was made; plan again')
    }
    // Unmapped status / type / stop-marker values block APPLY until mapped or accepted (`<column>:<value>`).
    const accepted = new Set(profile?.profile.acceptedUnmapped ?? [])
    const unmapped = (stageSummary?.unmapped ?? []).filter((u) => BLOCKING_UNMAPPED_COLUMNS.has(u.column) && !accepted.has(`${u.column}:${u.value}`))
    if (unmapped.length > 0) {
      throw new RouterError(`${unmapped.length} value(s) have no mapping; map or accept them in the profile before applying`)
    }
    // Real data needs a reconciled rehearsal first (the engine checks again).
    const gate = await rehearsalGate({ ...planned, options })
    if (!gate.ok) throw new RouterError(gate.reason ?? 'A reconciled rehearsal is required first')

    const id = newJobId(deps)
    const now = deps.now()
    const run: AljexImportJob = {
      id,
      kind: 'IMPORT',
      status: 'RUNNING',
      phase: 'CUSTOMER',
      cursor: { phase: 'CUSTOMER' },
      fileName: planned.fileName,
      fileHash: planned.fileHash,
      stageHash: planned.stageHash,
      layoutId: planned.layoutId,
      profileVersion: planned.profileVersion,
      target,
      targetTag: options.targetTag ?? null,
      liveTag: options.liveTag ?? null,
      options,
      synthetic: synthetic || null,
      rowCount: planned.rowCount ?? null,
      entityCounts: planned.entityCounts ?? null,
      parentJobId: planned.id,
      startedAt: now,
      heartbeatAt: now,
      createdBy: caller.email,
      createdAt: now,
      updatedAt: now,
    }
    await store.putJob(run)
    await audit(caller, id, 'APPLY', { parentJobId: planned.id, target, targetTag: options.targetTag ?? null, liveTag: options.liveTag ?? null, synthetic })
    await kickWorker(id)
    return { job: await decorate(run) }
  }

  async function pause(input: Json, caller: Caller): Promise<Json> {
    const job = await getJob(requireStr(input, 'jobId'))
    const ok = await flip(job, ACTIVE_STATUSES, { status: 'PAUSED' })
    if (!ok) throw new RouterError(`Only a running job can be paused; this one is ${job.status}`)
    await audit(caller, job.id, 'PAUSE', { phase: job.phase ?? null })
    return { job: await getJob(job.id) }
  }

  async function resume(input: Json, caller: Caller): Promise<Json> {
    const job = await getJob(requireStr(input, 'jobId'))
    const now = deps.now()
    if (job.status === 'PAUSED') {
      // A paused job goes back to the state its phase belongs to.
      const status: AljexImportStatus = job.phase === 'STAGE' ? 'STAGING' : job.phase === 'PLAN' ? 'PLANNING' : 'RUNNING'
      if (!(await flip(job, ['PAUSED'], { status, heartbeatAt: now }))) throw new RouterError('The job changed; refresh and try again')
    } else if (ACTIVE_STATUSES.includes(job.status)) {
      const beat = job.heartbeatAt ? Date.parse(job.heartbeatAt) : 0
      if (Date.now() - beat < STALLED_AFTER_MS) throw new RouterError('The job is still running; resume is for paused or stalled jobs')
      // Stalled: re-enter at the cursor under a fresh heartbeat so a second click cannot double-start it.
      if (!(await flip(job, ACTIVE_STATUSES, { heartbeatAt: now }))) throw new RouterError('The job changed; refresh and try again')
    } else {
      throw new RouterError(`A ${job.status} job cannot be resumed`)
    }
    await audit(caller, job.id, 'RESUME', { phase: job.phase ?? null })
    await kickWorker(job.id, job.kind === 'MCP_SYNC' ? 'MCP_SYNC' : 'WORK')
    return { job: await getJob(job.id) }
  }

  async function cancel(input: Json, caller: Caller): Promise<Json> {
    const job = await getJob(requireStr(input, 'jobId'))
    const ok = await flip(job, ['STAGING', 'READY', 'PLANNING', 'PLANNED', 'RUNNING', 'PAUSED'], { status: 'CANCELED', finishedAt: deps.now() })
    if (!ok) throw new RouterError(`A ${job.status} job cannot be canceled`)
    await audit(caller, job.id, 'CANCEL', { phase: job.phase ?? null })
    // Nothing is deleted: rows an applied phase already wrote stay (they are idempotent on re-run).
    return { job: await getJob(job.id) }
  }

  async function reconcileAction(input: Json): Promise<Json> {
    const job = await getJob(requireStr(input, 'jobId'))
    if (job.kind === 'MCP_SYNC') throw new RouterError('That job is a carrier sync')
    if (!['APPLIED', 'RUNNING', 'PAUSED'].includes(job.status)) throw new RouterError(`Reconcile reads the tables after an apply; the job is ${job.status}`)
    const existing = await readSummary(job)
    if (existing && input.force !== true) return { job: await markReconciled(job, existing), summary: existing }
    // Reading the tables back can take minutes: a worker does it and the UI polls IMPORT_GET.
    await deps.invokeSelf({ kind: 'RECONCILE', jobId: job.id, hops: 0 })
    return { job, summary: null }
  }

  async function markReconciled(job: AljexImportJob, summary: ImportReportSummary): Promise<AljexImportJob> {
    if (!summary.reconciled || job.options?.reconciled === true || job.status !== 'APPLIED') return job
    await store.update('aljexImportJob', job.id, { options: { ...(job.options ?? {}), reconciled: true }, updatedAt: deps.now() })
    return getJob(job.id)
  }

  async function reportLinks(input: Json): Promise<Json> {
    const job = await getJob(requireStr(input, 'jobId'))
    const prefix = (job.reportPrefix ?? `imports/runs/${job.id}/`).replace(/\/?$/, '/')
    const objects = await deps.listObjects(prefix)
    const links: AljexReportLink[] = []
    for (const o of objects) {
      links.push({ name: o.key.slice(prefix.length), key: o.key, url: await deps.presignGet(o.key), bytes: o.size })
    }
    return { links }
  }

  async function seed(input: Json): Promise<Json> {
    const r = await deps.seedProCounter(store, {
      apply: input.apply === true,
      enableNumericScheme: input.enableNumericScheme === true,
      jobId: str(input, 'jobId') || null,
    })
    return r as unknown as Json
  }

  // ── carrier sync (plan §5.7) ─────────────────────────────────────────────

  async function eligibleCarrierIds(): Promise<{ ids: string[]; noMc: string[] }> {
    const rows: Array<{ id: string; lastLoadAt: string; hasMc: boolean }> = []
    for await (const page of store.scanAll('carrier', ['id', 'aljexCode', 'mcNumber', 'mcpStatus', 'lastLoadAt'])) {
      for (const c of page) {
        if (!c.aljexCode || c.mcpStatus) continue
        rows.push({ id: String(c.id), lastLoadAt: String(c.lastLoadAt ?? ''), hasMc: !!c.mcNumber })
      }
    }
    rows.sort((a, b) => b.lastLoadAt.localeCompare(a.lastLoadAt) || a.id.localeCompare(b.id))
    return { ids: rows.filter((r) => r.hasMc).map((r) => r.id), noMc: rows.filter((r) => !r.hasMc).map((r) => r.id) }
  }

  async function syncCarriers(input: Json, caller: Caller): Promise<Json> {
    const existingId = str(input, 'jobId')
    if (existingId) {
      const job = await getJob(existingId)
      if (job.kind !== 'MCP_SYNC') throw new RouterError('That job is not a carrier sync')
      return { ready: true, job }
    }
    const { ids, noMc } = await eligibleCarrierIds()
    // The LIVE gate belongs to mcp-sync: ask it with the first real batch. Not LIVE writes nothing.
    const first = await deps.invokeMcp({ kind: 'IMPORT_BATCH', carrierIds: ids, maxLookups: MCP_BATCH, cursor: null })
    if (!first.ready) {
      return { ready: false, reason: first.reason ?? 'MyCarrierPackets is not LIVE (Integrations > MyCarrierPackets > Validate)', job: null }
    }
    const id = newJobId(deps)
    const now = deps.now()
    const counts = { staged: ids.length + noMc.length, created: 0, matched: 0, enriched: 0, skipped: noMc.length, conflicts: 0, errors: 0 }
    for (const r of first.results) tally(counts, r.result)
    const job: AljexImportJob = {
      id,
      kind: 'MCP_SYNC',
      status: first.done ? 'APPLIED' : 'RUNNING',
      phase: 'FINALIZE',
      cursor: first.cursor ? { phase: 'FINALIZE', lastCarrierId: first.cursor.lastCarrierId } : { phase: 'FINALIZE' },
      // staged = eligible; enriched = SYNCED; skipped = NO_PACKET + no-MC; errors = ERROR
      entityCounts: { CARRIER: counts },
      options: { eligibleCarrierIds: ids.length, noMc: noMc.length } as AljexImportOptions,
      startedAt: now,
      heartbeatAt: now,
      ...(first.done ? { finishedAt: now } : {}),
      reportPrefix: `imports/runs/${id}/`,
      createdBy: caller.email,
      createdAt: now,
      updatedAt: now,
    }
    await store.putJob(job)
    await deps.putText(`imports/runs/${id}/mcp-sync.csv`, mcpCsv(noMc.map((c) => ({ carrierId: c, result: 'NO_MC' })).concat(first.results)))
    await audit(caller, id, 'SYNC_CARRIERS', { eligible: ids.length, noMc: noMc.length })
    if (!first.done) await kickWorker(id, 'MCP_SYNC')
    return { ready: true, job }
  }

  function tally(c: { enriched: number; skipped: number; errors: number }, result: string): void {
    if (result === 'SYNCED') c.enriched += 1
    else if (result === 'NO_PACKET') c.skipped += 1
    else c.errors += 1
  }

  function mcpCsv(rows: Array<{ carrierId: string; result: string }>): string {
    return ['carrier_id,result', ...rows.map((r) => `${r.carrierId},${r.result}`)].join('\n') + '\n'
  }

  async function mcpWork(jobId: string, hops: number): Promise<Json> {
    for (let i = 0; i < 1000; i++) {
      const job = await getJob(jobId)
      if (job.status !== 'RUNNING') return { done: job.status === 'APPLIED', status: job.status }
      if (deps.remainingMs() < WORKER_MARGIN_MS) {
        if (hops + 1 > MAX_HOPS) throw new RouterError('carrier sync exceeded the worker chain limit')
        await deps.invokeSelf({ kind: 'MCP_SYNC', jobId, hops: hops + 1 })
        return { done: false, continued: true }
      }
      const { ids } = await eligibleCarrierIds()
      const cursor = job.cursor?.lastCarrierId
      const resp = await deps.invokeMcp({
        kind: 'IMPORT_BATCH',
        carrierIds: ids,
        maxLookups: MCP_BATCH,
        cursor: typeof cursor === 'string' ? { lastCarrierId: cursor } : null,
      })
      if (!resp.ready) {
        await flip(job, ['RUNNING'], { status: 'PAUSED', error: resp.reason ?? 'MyCarrierPackets is no longer LIVE' })
        return { done: false, status: 'PAUSED' }
      }
      const counts = { ...(job.entityCounts?.CARRIER ?? { staged: 0, created: 0, matched: 0, enriched: 0, skipped: 0, conflicts: 0, errors: 0 }) }
      for (const r of resp.results) tally(counts, r.result)
      const prev = (await deps.getText(`imports/runs/${jobId}/mcp-sync.csv`)) ?? 'carrier_id,result\n'
      await deps.putText(`imports/runs/${jobId}/mcp-sync.csv`, prev + resp.results.map((r) => `${r.carrierId},${r.result}`).join('\n') + (resp.results.length ? '\n' : ''))
      const now = deps.now()
      await flip(job, ['RUNNING'], {
        entityCounts: { CARRIER: counts },
        cursor: resp.cursor ? { phase: 'FINALIZE', lastCarrierId: resp.cursor.lastCarrierId } : { phase: 'FINALIZE' },
        heartbeatAt: now,
        ...(resp.done ? { status: 'APPLIED', finishedAt: now } : {}),
      })
      if (resp.done) return { done: true }
    }
    return { done: false }
  }

  // ── masked sample (UI step 3) ────────────────────────────────────────────

  async function sample(input: Json): Promise<Json> {
    const job = await getJob(requireStr(input, 'jobId'))
    const wanted = Array.isArray(input.rows) ? [...new Set((input.rows as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) > 0))].slice(0, 5) : []
    if (wanted.length === 0) throw new RouterError('rows must list 1-5 data row numbers')
    const unmask = input.unmask === true
    const mask = (s: string) => (unmask || !s ? s : `${s.slice(0, 1)}${'*'.repeat(Math.min(8, Math.max(2, s.length - 1)))}`)
    const key = `imports/source/${await rootJobId(store, job)}/${job.fileName}`
    const found: AljexSampleRow[] = []
    let layout: ReturnType<typeof detectLayout> | null = null
    let rowNumber = 0
    let stop = false
    const parser = createCsvParser((cells) => {
      if (stop) return
      if (!layout) {
        layout = detectLayout(cells)
        return
      }
      rowNumber += 1
      if (!wanted.includes(rowNumber)) return
      const row = mapAljexRow(cells, layout, { rowNumber })
      const first = row.stops[0]
      const last = row.stops[row.stops.length - 1]
      found.push({
        rowNumber,
        fields: {
          pro: row.pro,
          kind: row.kind,
          status: row.statusRaw,
          typeOfShipment: row.typeOfShipment,
          customer: mask(row.customer.name),
          carrier: mask(row.carrier?.name ?? ''),
          originCity: first?.city ?? null,
          destinationCity: last?.city ?? null,
          shipDate: row.dates.ship,
          deliveredDate: row.dates.delivered,
          invoiceAmountCents: row.money.invoiceAmountCents,
          paymentsReceivedCents: row.money.paymentsReceivedCents,
          balDueCents: row.money.balDueCents,
        },
      })
      if (found.length === wanted.length) stop = true
    })
    for await (const chunk of deps.streamText(key)) {
      parser.write(chunk)
      if (stop) break
    }
    if (!stop) parser.end()
    found.sort((a, b) => a.rowNumber - b.rowNumber)
    return { rows: found }
  }

  // ── the lossless source row (any of the 486 columns, no re-import) ───────

  async function legacyRow(input: Json): Promise<Json> {
    const pro = requireStr(input, 'pro').trim()
    const found = (await store.getMany('legacyAljexRow', [`aljex:${pro}`, `aljex:memo:${pro}`])).filter((r) => r != null)
    const rows = found.map((r) => ({ ...(r as unknown as LegacyAljexRowRecord), fields: (parseJsonField(r.fields) ?? {}) as LegacyAljexFields }))
    return { rows, columns: legacyAljexColumns(rows[0]?.fields) } satisfies LegacyAljexRowResult
  }

  // ── the worker ───────────────────────────────────────────────────────────

  async function work(payload: { kind: string; jobId: string; hops?: number }): Promise<Json> {
    const hops = payload.hops ?? 0
    if (payload.kind === 'MCP_SYNC') return mcpWork(payload.jobId, hops)
    if (payload.kind === 'RECONCILE') {
      const job = await getJob(payload.jobId)
      const summary = await deps.reconcile(store, job.id)
      await markReconciled(await getJob(job.id), summary)
      return { done: true }
    }
    if (payload.kind !== 'WORK') throw new RouterError(`Unknown worker kind: ${payload.kind}`)
    const job = await getJob(payload.jobId)
    if (!ACTIVE_STATUSES.includes(job.status)) return { done: true, status: job.status }
    const deadline = Date.now() + Math.max(30_000, deps.remainingMs() - WORKER_MARGIN_MS)
    let result: RunSliceResult
    try {
      result = await deps.runSlice(store, job.id, deadline)
    } catch (err) {
      // The engine reports failures on the job itself; this is the net under it.
      const message = err instanceof Error ? err.message : String(err)
      console.error('[tms-aljex-import] runSlice threw:', message)
      await flip(job, ACTIVE_STATUSES, { status: 'FAILED', error: message.slice(0, 1000), finishedAt: deps.now() })
      return { done: true, status: 'FAILED' }
    }
    const after = await getJob(job.id)
    if (result.done || !ACTIVE_STATUSES.includes(after.status)) {
      if (after.status === 'APPLIED') {
        const summary = await readSummary(after)
        if (summary) await markReconciled(after, summary)
      }
      return { done: true, status: after.status }
    }
    if (hops + 1 > MAX_HOPS) {
      await flip(after, ACTIVE_STATUSES, { status: 'FAILED', error: 'Exceeded the worker chain limit', finishedAt: deps.now() })
      return { done: true, status: 'FAILED' }
    }
    await deps.invokeSelf({ kind: 'WORK', jobId: job.id, hops: hops + 1 })
    return { done: false, continued: true }
  }

  async function dispatch(action: string, input: Json, caller: Caller): Promise<Json> {
    switch (action as AljexImportAction) {
      case 'IMPORT_PREPARE': return prepare(input, caller)
      case 'IMPORT_STAGE': return stage(input)
      case 'IMPORT_GET': return get(input)
      case 'IMPORT_LIST': return list()
      case 'IMPORT_SAVE_PROFILE': return saveProfile(input, caller)
      case 'IMPORT_GET_PROFILE': return getProfile(input)
      case 'IMPORT_PLAN': return plan(input, caller)
      case 'IMPORT_APPLY': return apply(input, caller)
      case 'IMPORT_PAUSE': return pause(input, caller)
      case 'IMPORT_RESUME': return resume(input, caller)
      case 'IMPORT_CANCEL': return cancel(input, caller)
      case 'IMPORT_RECONCILE': return reconcileAction(input)
      case 'IMPORT_REPORT_LINKS': return reportLinks(input)
      case 'IMPORT_SEED_COUNTER': return seed(input)
      case 'IMPORT_SYNC_CARRIERS': return syncCarriers(input, caller)
      case 'IMPORT_SAMPLE': return sample(input)
      case 'IMPORT_LEGACY_ROW': return legacyRow(input)
      case 'IMPORT_STEP': {
        // One bounded slice for the CLI/tests: same runSlice, caller-chosen budget (≤ 20 s).
        const id = requireStr(input, 'jobId')
        const budget = Math.min(20_000, Math.max(1_000, typeof input.budgetMs === 'number' ? input.budgetMs : 10_000))
        const res = await deps.runSlice(store, id, Date.now() + budget)
        return { done: res.done, job: await decorate(res.job) }
      }
      default:
        throw new RouterError(`Unknown action: ${action}. Expected one of ${ACTIONS.join(', ')}`)
    }
  }

  return { dispatch, work }
}

