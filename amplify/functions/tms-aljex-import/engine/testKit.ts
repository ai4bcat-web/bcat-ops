/**
 * Test harness for the engine: a MemoryStore over dev-style table names, SYNTHETIC fixtures from
 * scripts/lib/aljexFixture.mjs (never a real export), and a driver that walks a job through
 * STAGE -> PLAN -> APPLY the way the router does.
 */
import type { AljexImportJob, EngineRow, TableSet } from '../../../../src/types/tms'
// @ts-expect-error -- plain .mjs generator without declarations
import { generateAljex, renderAljexCsv } from '../../../../scripts/lib/aljexFixture.mjs'
import { MemoryStore } from './memoryStore'
import { runSlice } from './runSlice'
import { DEV_SUFFIX, MODEL_NAME } from './tables'

export const FIXED_NOW = '2026-11-03T12:00:00.000Z'

export function devTables(suffix = ''): TableSet {
  return Object.fromEntries(Object.entries(MODEL_NAME).map(([k, model]) => [k, `${model}-${DEV_SUFFIX}${suffix}`])) as unknown as TableSet
}

export interface Fixture {
  csv: string
  oracle: Record<string, unknown>
  result: unknown
}

export function makeFixture(opts: { rows: number; seed?: number; anomalies?: 'none' | 'standard' | 'all' }): Fixture {
  const result = generateAljex({ rows: opts.rows, seed: opts.seed ?? 1, anomalies: opts.anomalies ?? 'standard' })
  return { csv: renderAljexCsv(result, {}), oracle: result.oracle, result }
}

export function makeStore(extra: { crashAtTransact?: number; tables?: TableSet } = {}): MemoryStore {
  const store = new MemoryStore({ tables: extra.tables ?? devTables(), now: () => FIXED_NOW, crashAtTransact: extra.crashAtTransact })
  store.seed('settings', [{ id: 'default', defaultPaymentTermsDays: 30 }])
  return store
}

export function baseJob(id: string, over: Partial<AljexImportJob> = {}): AljexImportJob {
  return { id, kind: 'IMPORT', status: 'STAGING', phase: 'STAGE', fileName: 'synthetic.csv', target: 'LIVE', liveTag: 'ZZ-TEST', synthetic: true, options: { minShipDate: '' }, createdBy: 'test', ...over }
}

export async function putJob(store: MemoryStore, job: AljexImportJob): Promise<void> {
  store.seed('aljexImportJob', [job as unknown as EngineRow])
}

export async function getJob(store: MemoryStore, id: string): Promise<AljexImportJob> {
  const [row] = await store.getMany('aljexImportJob', [id])
  return row as unknown as AljexImportJob
}

export async function drive(store: MemoryStore, id: string): Promise<AljexImportJob> {
  for (let i = 0; i < 50; i++) {
    const res = await runSlice(store, id, Date.now() + 60_000)
    if (res.done) break
  }
  return getJob(store, id)
}

export async function stage(store: MemoryStore, csv: string, jobId = 'aljexrun:S', over: Partial<AljexImportJob> = {}): Promise<AljexImportJob> {
  const job = baseJob(jobId, over)
  await store.putObject(`imports/source/${jobId}/${job.fileName}`, csv)
  await putJob(store, job)
  return drive(store, jobId)
}

export async function plan(store: MemoryStore, jobId: string): Promise<AljexImportJob> {
  await store.update('aljexImportJob', jobId, { status: 'PLANNING' })
  return drive(store, jobId)
}

export async function apply(store: MemoryStore, planJobId: string, applyId: string, over: Partial<AljexImportJob> = {}): Promise<AljexImportJob> {
  const parent = await getJob(store, planJobId)
  const job: AljexImportJob = {
    ...baseJob(applyId, { status: 'RUNNING', phase: 'CUSTOMER' }),
    parentJobId: planJobId,
    stageHash: parent.stageHash,
    layoutId: parent.layoutId,
    profileVersion: parent.profileVersion,
    fileName: parent.fileName,
    options: parent.options,
    target: parent.target,
    liveTag: parent.liveTag,
    synthetic: parent.synthetic,
    cursor: { phase: 'CUSTOMER' },
    ...over,
  }
  await putJob(store, job)
  return drive(store, applyId)
}

/** Stage, plan and apply a fixture in one call. */
export async function fullRun(store: MemoryStore, csv: string, tag = 'A'): Promise<{ staged: AljexImportJob; planned: AljexImportJob; applied: AljexImportJob }> {
  const staged = await stage(store, csv, `aljexrun:S${tag}`)
  const planned = await plan(store, `aljexrun:S${tag}`)
  const applied = await apply(store, `aljexrun:S${tag}`, `aljexrun:A${tag}`)
  return { staged, planned, applied }
}
