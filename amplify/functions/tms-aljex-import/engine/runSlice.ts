/**
 * runSlice(store, jobId, deadlineMs): drive one import job as far as the deadline allows.
 *
 * The router sets `status` (and `phase`/`cursor`) before calling; this function owns everything after:
 *   STAGING  -> stage the source -> READY
 *   PLANNING -> the same phases over an overlay store (nothing written) -> PLANNED
 *   RUNNING  -> CUSTOMER, CARRIER, LOCATION, LOAD, AR_LEDGER, AP_LEDGER, FINALIZE -> APPLIED
 * The cursor is persisted after every batch of PROs with a status-conditional update, so a PAUSED or
 * CANCELED written by the router is never overwritten and stops the run at the next batch.
 */
import type { AljexEntityCounts, AljexImportCursor, AljexImportJob, AljexImportPhase, AljexPlanSummary, EngineRow, EngineStore, RunSliceResult } from '../../../../src/types/tms'
import { findUnmapped } from '../../../../src/lib/aljex/profile'
import { collectLocations, locationRow, runCarriers, runCustomers, loadLocationMaps, selectedCarriers, scanRows, text, auditRow, type LocationAcc, type PhaseEnv } from './directory'
import { runApLedger, runArLedger } from './ledger'
import { buildLoadEnv, loadExistingIndex, runLoadPhase } from './load'
import { CrashInjected, MemoryStore } from './memoryStore'
import { loadProfile } from './profileLoad'
import { batchFindingsKey, conservation, phaseFindingsKey, reconcile, runsPrefix } from './reconcile'
import { rootJobIdOf } from './report'
import { seedProCounter } from './seedCounter'
import { readChunk, readStageData, runStage, stageKey, type StageData } from './stage'
import { assertTargets, liveTablesOf, TargetRefused } from './tables'
import { IMPORT_ACTOR, emptyCount, type Counts, type Finding } from './types'
import { stableId } from './util'

export class FaultInjected extends Error {}

const PHASES: AljexImportPhase[] = ['CUSTOMER', 'CARRIER', 'LOCATION', 'LOAD', 'AR_LEDGER', 'AP_LEDGER', 'FINALIZE']
const ACTIVE = new Set(['STAGING', 'PLANNING', 'RUNNING'])

/** AppSync AWSJSON fields may come back as strings; the engine itself writes native objects. */
function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T
    } catch {
      return null
    }
  }
  return v as T
}

async function readJob(store: EngineStore, jobId: string): Promise<AljexImportJob> {
  const [row] = await store.getMany('aljexImportJob', [jobId])
  if (!row) throw new Error(`No such import job: ${jobId}`)
  const job = { ...row } as unknown as AljexImportJob
  job.options = parseJson(row.options) ?? {}
  job.cursor = parseJson(row.cursor)
  job.entityCounts = parseJson(row.entityCounts)
  return job
}

async function fail(store: EngineStore, job: AljexImportJob, message: string): Promise<RunSliceResult> {
  job.status = 'FAILED'
  job.error = message.slice(0, 1000)
  job.finishedAt = store.now()
  job.heartbeatAt = store.now()
  await store.update('aljexImportJob', job.id, { status: 'FAILED', error: job.error, finishedAt: job.finishedAt, heartbeatAt: job.heartbeatAt })
  return { done: true, job }
}

/** Status-conditional job update: false means the router moved the job (PAUSED / CANCELED ...). */
async function saveJob(store: EngineStore, job: AljexImportJob, patch: EngineRow): Promise<boolean> {
  const ok = await store.update('aljexImportJob', job.id, { heartbeatAt: store.now(), ...patch }, { expression: '#s = :st', names: { '#s': 'status' }, values: { ':st': job.status } })
  if (ok) Object.assign(job, patch, { heartbeatAt: store.now() })
  return ok
}

function cloneCounts(c: AljexEntityCounts | null | undefined): Counts {
  return structuredClone(c ?? {}) as Counts
}

function resetEntities(counts: Counts, ...entities: Array<keyof Counts>): void {
  for (const e of entities) counts[e] = emptyCount()
}

async function writeFindings(store: EngineStore, key: string, findings: Finding[]): Promise<void> {
  if (findings.length) await store.putObject(key, JSON.stringify(findings))
}

/** Guards that need the staged data / other jobs (plan §4.7 rules 2 and 3). Returns a refusal message or null. */
async function applyGuards(store: EngineStore, job: AljexImportJob, stage: StageData, profileVersion: number, accepted: Set<string>, profile: Parameters<typeof findUnmapped>[0]): Promise<string | null> {
  if (job.synthetic === true && !stage.index.syntheticOk) return 'synthetic is refused: the staged data has a PRO outside 900000-999999 or a customer/carrier name without the ZZ prefix'
  if (typeof job.options?.expectedRows === 'number' && job.options.expectedRows !== stage.index.rows) return `expectedRows ${job.options.expectedRows} does not match the staged ${stage.index.rows} rows`
  const blocking = findUnmapped(profile, stage.index.distinct).filter((u) => u.blocking && !accepted.has(u.value))
  if (blocking.length) return `${blocking.length} unmapped value(s) block APPLY: ${blocking.slice(0, 5).map((b) => `${b.column}:${b.value}`).join(', ')}`
  if (job.parentJobId) {
    const [parent] = (await store.getMany('aljexImportJob', [job.parentJobId])) as unknown as AljexImportJob[]
    if (!parent || parent.status !== 'PLANNED') return 'the parent PLAN is missing or not PLANNED'
    if (parent.stageHash !== job.stageHash || parent.profileVersion !== job.profileVersion) return 'the PLAN no longer matches this stage/profile; plan again'
  }
  if ((job.target ?? 'LIVE') === 'LIVE' && job.synthetic !== true) {
    let ok = false
    for await (const page of store.scanAll('aljexImportJob', ['id', 'target', 'status', 'stageHash', 'profileVersion', 'options'])) {
      for (const r of page) {
        const opts = parseJson<{ reconciled?: boolean }>(r.options)
        if (r.target === 'REHEARSAL' && r.status === 'APPLIED' && r.stageHash === job.stageHash && r.profileVersion === profileVersion && opts?.reconciled === true) ok = true
      }
    }
    if (!ok) return 'a LIVE apply of real data needs a RECONCILED rehearsal run with the same stageHash and profileVersion'
  }
  return null
}

export async function runSlice(store: EngineStore, jobId: string, deadlineMs: number): Promise<RunSliceResult> {
  const job = await readJob(store, jobId)
  if (!ACTIVE.has(job.status)) return { done: true, job }
  try {
    const root = await rootJobIdOf(store, job)
    if (job.status === 'STAGING') return await stagePhase(store, job, root)
    // Plans only read the live tables; the liveTag guard is for writes.
    const guardJob = job.status === 'PLANNING' ? { ...job, liveTag: job.liveTag || 'plan' } : job
    assertTargets(liveTablesOf(store.tables), store.tables, guardJob, store.targetPolicy)
    if (job.status === 'PLANNING') return await planPhase(store, job, root)
    return await applyPhase(store, job, root, deadlineMs)
  } catch (err) {
    if (err instanceof FaultInjected || err instanceof CrashInjected) throw err
    if (err instanceof TargetRefused) return fail(store, job, err.message)
    return fail(store, job, err instanceof Error ? err.message : String(err))
  }
}

async function stagePhase(store: EngineStore, job: AljexImportJob, root: string): Promise<RunSliceResult> {
  const { profile } = await loadProfile(store, job)
  const res = await runStage(store, job, root)
  const stage = await readStageData(store, root)
  const patch: EngineRow = {
    status: 'READY',
    phase: 'STAGE',
    stageHash: res.stageHash,
    layoutId: stage.index.layoutId,
    profileVersion: profile.version,
    rowCount: res.rows,
    entityCounts: stage.index.stageCounts,
    cursor: { phase: 'STAGE' },
    error: null,
  }
  if (!(await saveJob(store, job, patch))) return { done: true, job: await readJob(store, job.id) }
  return { done: true, job }
}

async function planPhase(store: EngineStore, job: AljexImportJob, root: string): Promise<RunSliceResult> {
  const stage = await readStageData(store, root)
  const { profile, accepted } = await loadProfile(store, job)
  const overlay = new MemoryStore({ tables: store.tables, base: store, now: () => store.now() })
  const counts = cloneCounts(stage.index.stageCounts)
  const findings: Finding[] = []
  const warnings: string[] = []
  const unmapped = findUnmapped(profile, stage.index.distinct).filter((u) => u.blocking && !accepted.has(u.value))
  if (unmapped.length) warnings.push(`${unmapped.length} unmapped value(s) will block APPLY`)
  if (job.synthetic === true && !stage.index.syntheticOk) warnings.push('synthetic is refused for this file')

  // Class counts before anything is written.
  const existing = await loadExistingIndex(store)
  const classes = { CREATE: 0, ENRICH: 0, UNLINKED: 0, CONFLICT: 0 }
  let already = 0
  for (let c = 0; c < stage.masters.chunkCount; c++) {
    for (const row of await readChunk(store, root, c)) {
      if (row.kind !== 'LOAD') continue
      const key = row.proKey as string
      const loadId = stableId('lod', `aljex:${key}`)
      const claim = existing.claims.get(key)
      if (claim === loadId) {
        already += 1
        classes.CREATE += 1
      } else if (existing.loads.has(key)) classes[existing.loads.get(key)!.hasShipment ? 'ENRICH' : 'UNLINKED'] += 1
      else classes[claim ? 'CONFLICT' : 'CREATE'] += 1
    }
  }
  if (already) warnings.push(`${already} row(s) are already imported and will be matched`)

  const env: PhaseEnv = { store: overlay, rootJobId: root, runId: job.id, profile, masters: stage.masters, counts, findings, reentry: false }
  resetEntities(counts, 'CUSTOMER', 'CARRIER', 'LOCATION', 'AR_PAYMENT', 'AP_PAYMENT')
  await runCustomers(env)
  await runCarriers(env)
  await locationPhase(overlay, root, stage, counts)
  const loadEnv = await buildLoadEnv(overlay, job.id, stage, profile)
  await runLoadPhase({
    store: overlay,
    job,
    runId: job.id,
    stage,
    rootJobId: root,
    env: loadEnv,
    counts,
    cursor: { chunk: 0, offset: 0 },
    deadlineMs: Number.MAX_SAFE_INTEGER,
    rowsDone: 0,
    persist: async (_from, _next, batchFindings) => {
      findings.push(...batchFindings)
      return true
    },
  })
  await runArLedger({ store: overlay, root, stage, profile, counts, reentry: false })
  await runApLedger({ store: overlay, root, stage, profile, counts, reentry: false })
  const cons = conservation(counts)
  if (!cons.ok) warnings.push(`conservation broken for ${cons.broken.join(', ')}`)
  const summaryReport = await reconcile(overlay, job.id, { counts, write: false, findings })
  const plan: AljexPlanSummary = { classes, warnings, bridge: summaryReport.bridge }
  await store.putObject(stageKey(root, 'plan-summary.json'), JSON.stringify(plan))
  const patch: EngineRow = { status: 'PLANNED', phase: 'PLAN', entityCounts: counts, cursor: { phase: 'PLAN' }, error: null }
  if (!(await saveJob(store, job, patch))) return { done: true, job: await readJob(store, job.id) }
  return { done: true, job }
}

/** P3: collect every stop of every staged row, resolve against existing locations, write what is new. */
async function locationPhase(store: EngineStore, root: string, stage: StageData, counts: Counts): Promise<void> {
  resetEntities(counts, 'LOCATION')
  const { maps } = await loadLocationMaps(store)
  const pending = new Map<string, LocationAcc>()
  for (let c = 0; c < stage.masters.chunkCount; c++) collectLocations({ maps, pending }, await readChunk(store, root, c), counts)
  await store.batchPut('location', [...pending.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, acc]) => locationRow(id, acc)))
}

async function applyPhase(store: EngineStore, job: AljexImportJob, root: string, deadlineMs: number): Promise<RunSliceResult> {
  const stage = await readStageData(store, root)
  const { profile, accepted } = await loadProfile(store, job)
  const refusal = await applyGuards(store, job, stage, job.profileVersion ?? profile.version, accepted, profile)
  if (refusal) return fail(store, job, refusal)

  const cursor: AljexImportCursor = { phase: 'CUSTOMER', ...(job.cursor ?? {}) }
  const entered = new Set<string>(Array.isArray(cursor.entered) ? (cursor.entered as string[]) : [])
  const counts = cloneCounts(job.entityCounts)
  if (!entered.size) {
    for (const k of Object.keys(counts)) delete counts[k as keyof Counts]
    Object.assign(counts, cloneCounts(stage.index.stageCounts))
    if (!job.startedAt) job.startedAt = store.now()
    await store.batchPut('auditLog', [auditRow(`apply-start:${job.id}`, 'AljexImportJob', job.id, 'ALJEX_IMPORT_APPLY_START', { target: job.target ?? 'LIVE', targetTag: job.targetTag ?? null, liveTag: job.liveTag ?? null, synthetic: job.synthetic ?? false })])
  }
  const faultAfter = typeof job.options?.faultAfterRows === 'number' && process.env.BCAT_DEV_STACK === 'true' && job.synthetic === true && cursor.faultFired !== true ? job.options.faultAfterRows : null

  const persist = async (phase: AljexImportPhase, extra: Record<string, unknown> = {}): Promise<boolean> =>
    saveJob(store, job, { phase, cursor: { phase, entered: [...entered], ...extra }, entityCounts: counts, startedAt: job.startedAt })

  const startIndex = Math.max(0, PHASES.indexOf(cursor.phase))
  for (let pi = startIndex; pi < PHASES.length; pi++) {
    const phase = PHASES[pi]
    const reentry = entered.has(phase)
    entered.add(phase)
    const phaseExtra = phase === 'LOAD' && reentry ? { chunk: cursor.chunk ?? 0, offset: cursor.offset ?? 0, rowsDone: cursor.rowsDone ?? 0, faultFired: cursor.faultFired } : {}
    if (!(await persist(phase, phaseExtra))) return { done: true, job: await readJob(store, job.id) }
    const findings: Finding[] = []
    const env: PhaseEnv = { store, rootJobId: root, runId: job.id, profile, masters: stage.masters, counts, findings, reentry }

    if (phase === 'CUSTOMER') {
      resetEntities(counts, 'CUSTOMER')
      await runCustomers(env)
    } else if (phase === 'CARRIER') {
      resetEntities(counts, 'CARRIER')
      await runCarriers(env)
    } else if (phase === 'LOCATION') {
      await locationPhase(store, root, stage, counts)
    } else if (phase === 'LOAD') {
      const loadEnv = await buildLoadEnv(store, job.id, stage, profile)
      const res = await runLoadPhase({
        store,
        job,
        runId: job.id,
        stage,
        rootJobId: root,
        env: loadEnv,
        counts,
        cursor: { chunk: Number(phaseExtra.chunk ?? 0), offset: Number(phaseExtra.offset ?? 0) },
        deadlineMs: deadlineMs - 5000,
        rowsDone: Number(phaseExtra.rowsDone ?? 0),
        persist: async (from, next, batchFindings, rowsDone) => {
          await writeFindings(store, batchFindingsKey(job.id, from.chunk, from.offset), batchFindings)
          const fire = faultAfter != null && rowsDone >= faultAfter
          const ok = await persist('LOAD', { chunk: next.chunk, offset: next.offset, rowsDone, ...(fire ? { faultFired: true } : {}) })
          if (ok && fire) throw new FaultInjected(`fault injected after ${rowsDone} rows`)
          return ok
        },
      })
      if (res.stopped) return { done: true, job: await readJob(store, job.id) }
      if (!res.done) return { done: false, job }
    } else if (phase === 'AR_LEDGER') {
      resetEntities(counts, 'AR_PAYMENT')
      await runArLedger({ store, root, stage, profile, counts, reentry })
    } else if (phase === 'AP_LEDGER') {
      resetEntities(counts, 'AP_PAYMENT')
      await runApLedger({ store, root, stage, profile, counts, reentry })
    } else {
      await finalize(store, job, stage, profile, counts)
      break
    }
    await writeFindings(store, phaseFindingsKey(job.id, phase), findings)
    const next = PHASES[pi + 1]
    if (!(await persist(next))) return { done: true, job: await readJob(store, job.id) }
    if (Date.now() > deadlineMs - 5000 && next !== 'FINALIZE') return { done: false, job }
  }
  return { done: true, job: await readJob(store, job.id) }
}

async function finalize(store: EngineStore, job: AljexImportJob, stage: StageData, profile: Parameters<typeof selectedCarriers>[1], counts: Counts): Promise<void> {
  const synthetic = job.synthetic === true
  // Carrier activity for the carriers this run created.
  const { selected } = selectedCarriers(stage.masters, profile)
  for (const m of selected) {
    const id = stableId('car', `aljex:${m.id}`)
    const [row] = await store.getMany('carrier', [id])
    if (row && text(row.aljexCode) === m.id) await store.update('carrier', id, { loadCount: m.loads, ...(m.newestShip ? { lastLoadAt: `${m.newestShip}T12:00:00.000Z` } : {}) })
  }
  await linkSkippedCarriers(store)
  // Highest imported invoice number (the series start must exceed it, DECIDED-6).
  if (!synthetic) {
    let max = 0
    for (const i of await scanRows(store, 'invoice', ['id', 'number', 'createdBy'])) {
      if (text(i.createdBy) === IMPORT_ACTOR && /^\d{1,9}$/.test(text(i.number))) max = Math.max(max, Number(i.number))
    }
    if (max > 0) await store.update('settings', 'default', { maxImportedInvoiceNumber: max }, { expression: 'attribute_not_exists(maxImportedInvoiceNumber) OR maxImportedInvoiceNumber < :v', values: { ':v': max } })
    await seedProCounter(store, { apply: true, enableNumericScheme: false, jobId: job.id })
  }
  const summary = await reconcile(store, job.id, { counts })
  const patch: EngineRow = { status: 'APPLIED', phase: 'DONE', entityCounts: counts, reportPrefix: runsPrefix(job.id), finishedAt: store.now(), appliedAt: store.now(), appliedBy: job.createdBy, cursor: { phase: 'DONE' }, error: null }
  patch.options = { ...(job.options ?? {}), reconciled: summary.reconciled }
  await store.batchPut('auditLog', [auditRow(`apply-done:${job.id}`, 'AljexImportJob', job.id, 'ALJEX_IMPORT_APPLY_DONE', { reconciled: summary.reconciled, findings: summary.findings })])
  await saveJob(store, job, patch)
}

/** Re-point snapshot legs of earlier-skipped carriers whose MC now matches a directory carrier. Conditional on carrierId unset. */
export async function linkSkippedCarriers(store: EngineStore): Promise<number> {
  const byMc = new Map<string, string>()
  for (const c of await scanRows(store, 'carrier', ['id', 'mcNumber', 'aljexCode'])) {
    const mc = text(c.mcNumber).replace(/\D/g, '').replace(/^0+/, '')
    if (mc && text(c.aljexCode)) byMc.set(mc, text(c.id))
  }
  let linked = 0
  for (const lc of await scanRows(store, 'loadCarrier', ['id', 'kind', 'carrierId', 'carrierMc', 'createdBy'])) {
    if (lc.kind !== 'CARRIER' || text(lc.carrierId) || text(lc.createdBy) !== IMPORT_ACTOR) continue
    const target = byMc.get(text(lc.carrierMc).replace(/\D/g, '').replace(/^0+/, ''))
    if (target && (await store.update('loadCarrier', text(lc.id), { carrierId: target }, { expression: 'attribute_not_exists(carrierId)' }))) linked += 1
  }
  return linked
}
