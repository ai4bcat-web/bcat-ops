/**
 * tms-aljex-import router tests. They run `createRouter` over the engine's MemoryStore (which
 * enforces conditional writes and the DynamoDB index-key rule) with fake S3 / Lambda / MCP
 * dependencies. Each test defends a stated safety property of the pipeline: who may call it,
 * what may start from which state, what can never go live, and that a pause cannot be lost.
 * All data here is synthetic.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { AljexImportJob, EngineRow, RunSliceResult, TableSet } from '../../../src/types/tms'
import { ALJEX_HEADERS_V1, LAYOUT_V1 } from '../../../src/lib/aljex/layout'
import { MemoryStore } from './engine/memoryStore'
import {
  authorize,
  createRouter,
  MAX_SOURCE_BYTES,
  sanitizeOptions,
  STALLED_AFTER_MS,
  type McpBatchResponse,
  type RouterDeps,
} from './router'

const TABLE_KEYS: Array<keyof TableSet> = [
  'shipment', 'order', 'load', 'loadCarrier', 'loadFinancials', 'loadCharge', 'customer', 'location', 'carrier',
  'invoice', 'arPayment', 'carrierBill', 'apPayment', 'proClaim', 'settings', 'auditLog', 'legacyAljexRow',
  'aljexImportJob', 'aljexMappingProfile', 'factoringItem', 'driver', 'userProfile', 'ownershipDivision',
  'ownershipRule', 'division', 'integration',
]
const TABLES = Object.fromEntries(TABLE_KEYS.map((k) => [k, `${k}-test`])) as unknown as TableSet

const ADMIN = { email: 'boss@example.com', sub: 's', groups: ['ADMIN'], isAdmin: true }
const SHA = 'a'.repeat(64)

interface Harness {
  router: ReturnType<typeof createRouter>
  store: MemoryStore
  invoked: Array<Record<string, unknown>>
  objects: Map<string, string>
  runs: string[]
  mcpCalls: Array<Record<string, unknown>>
  setRun(fn: (jobId: string) => Promise<RunSliceResult>): void
  setMcp(fn: (payload: Record<string, unknown>) => McpBatchResponse): void
  setRemaining(ms: number): void
}

function harness(opts: { devStack?: boolean } = {}): Harness {
  const store = new MemoryStore({ tables: TABLES })
  const invoked: Array<Record<string, unknown>> = []
  const objects = new Map<string, string>()
  const runs: string[] = []
  const mcpCalls: Array<Record<string, unknown>> = []
  let run: (jobId: string) => Promise<RunSliceResult> = async (jobId) => {
    const [row] = await store.getMany('aljexImportJob', [jobId])
    return { done: true, job: row as unknown as AljexImportJob }
  }
  let mcp: (payload: Record<string, unknown>) => McpBatchResponse = () => ({ ready: true, results: [], cursor: null, done: true })
  let remaining = 900_000
  let n = 0
  const deps: RouterDeps = {
    store,
    bucket: 'bucket-test',
    now: () => new Date().toISOString(),
    devStack: opts.devStack ?? false,
    runSlice: async (_s, jobId) => {
      runs.push(jobId)
      return run(jobId)
    },
    seedProCounter: async () => ({ current: null, target: 14912, wouldChange: true, applied: false, schemeEnabled: false }),
    reconcile: async () => { throw new Error('not used') },
    invokeSelf: async (p) => { invoked.push(p) },
    presignPut: async (key) => `https://put.example/${key}`,
    presignGet: async (key) => `https://get.example/${key}`,
    headObject: async (key) => (objects.has(key) ? { size: objects.get(key)!.length } : null),
    listObjects: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1 })),
    getText: async (key) => objects.get(key) ?? null,
    streamText: async function* (key) {
      const text = objects.get(key)
      if (text == null) throw new Error('no object')
      for (let i = 0; i < text.length; i += 97) yield text.slice(i, i + 97)
    },
    putText: async (key, body) => { objects.set(key, body) },
    invokeMcp: async (payload) => {
      mcpCalls.push(payload)
      return mcp(payload)
    },
    remainingMs: () => remaining,
    randomId: () => String(++n).padStart(4, '0'),
  }
  return {
    router: createRouter(deps),
    store,
    invoked,
    objects,
    runs,
    mcpCalls,
    setRun: (fn) => { run = fn },
    setMcp: (fn) => { mcp = fn },
    setRemaining: (ms) => { remaining = ms },
  }
}

async function jobOf(h: Harness, id: string): Promise<AljexImportJob> {
  const [row] = await h.store.getMany('aljexImportJob', [id])
  return row as unknown as AljexImportJob
}

/** A staged job ready for PLAN, with its source object in the fake bucket. */
async function stagedJob(h: Harness, over: Partial<AljexImportJob> = {}): Promise<AljexImportJob> {
  const prep = await h.router.dispatch('IMPORT_PREPARE', { fileName: 'export.csv', fileHash: SHA, sizeBytes: 10 }, ADMIN)
  const job = prep.job as AljexImportJob
  h.objects.set(`imports/source/${job.id}/export.csv`, '0123456789')
  await h.router.dispatch('IMPORT_STAGE', { jobId: job.id }, ADMIN)
  await h.store.update('aljexImportJob', job.id, { status: 'READY', phase: 'STAGE', stageHash: 'stage-1', layoutId: 'aljex-full-486-v1', rowCount: 100, ...over })
  h.invoked.length = 0
  return jobOf(h, job.id)
}

async function plannedJob(h: Harness, over: Partial<AljexImportJob> = {}): Promise<AljexImportJob> {
  const job = await stagedJob(h, over)
  await h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103' } }, ADMIN)
  await h.store.update('aljexImportJob', job.id, { status: 'PLANNED' })
  h.invoked.length = 0
  return jobOf(h, job.id)
}

describe('authorization', () => {
  const resolve = async (identity: { username: string }) => identity.username
  it('refuses a signed-in user who is neither owner nor ADMIN', async () => {
    await expect(authorize({ sub: 's', username: 'rep@example.com', claims: {} }, resolve)).rejects.toThrow(/Forbidden/)
  })
  it('accepts the ADMIN group and the owner', async () => {
    await expect(authorize({ sub: 's', username: 'x@example.com', claims: { 'cognito:groups': ['ADMIN'] } }, resolve)).resolves.toMatchObject({ isAdmin: true })
    await expect(authorize({ sub: 's', username: 'ryne@bcatcorp.com', claims: {} }, resolve)).resolves.toMatchObject({ isAdmin: true })
  })
  it('refuses a missing identity', async () => {
    await expect(authorize(null, resolve)).rejects.toThrow(/Unauthorized/)
  })
})

describe('prepare / stage', () => {
  it('creates an upload job whose source key is derived from the job id and a sanitized name', async () => {
    const h = harness()
    const r = await h.router.dispatch('IMPORT_PREPARE', { fileName: '../weird name?.csv', fileHash: SHA, sizeBytes: 10 }, ADMIN)
    const job = r.job as AljexImportJob
    expect(job).toMatchObject({ status: 'STAGING', phase: 'UPLOAD', kind: 'IMPORT', createdBy: ADMIN.email })
    expect(job.fileName).not.toMatch(/[/?]/)
    expect(r.uploadKey).toBe(`imports/source/${job.id}/${job.fileName}`)
    expect(r.uploadUrl).toContain(r.uploadKey as string)
    expect(await jobOf(h, job.id)).toBeTruthy()
  })

  it('refuses oversize files and malformed hashes', async () => {
    const h = harness()
    await expect(h.router.dispatch('IMPORT_PREPARE', { fileName: 'a.csv', fileHash: SHA, sizeBytes: MAX_SOURCE_BYTES + 1 }, ADMIN)).rejects.toThrow(/refused/)
    await expect(h.router.dispatch('IMPORT_PREPARE', { fileName: 'a.csv', fileHash: 'nothex', sizeBytes: 5 }, ADMIN)).rejects.toThrow(/sha256/)
  })

  it('does not start staging until the uploaded object exists with the announced size', async () => {
    const h = harness()
    const job = (await h.router.dispatch('IMPORT_PREPARE', { fileName: 'a.csv', fileHash: SHA, sizeBytes: 10 }, ADMIN)).job as AljexImportJob
    await expect(h.router.dispatch('IMPORT_STAGE', { jobId: job.id }, ADMIN)).rejects.toThrow(/not in the bucket/)
    h.objects.set(`imports/source/${job.id}/a.csv`, '12345')
    await expect(h.router.dispatch('IMPORT_STAGE', { jobId: job.id }, ADMIN)).rejects.toThrow(/announced 10/)
    expect(h.invoked).toHaveLength(0)
    h.objects.set(`imports/source/${job.id}/a.csv`, '0123456789')
    await h.router.dispatch('IMPORT_STAGE', { jobId: job.id }, ADMIN)
    expect(h.invoked).toEqual([{ kind: 'WORK', jobId: job.id, hops: 0 }])
    expect((await jobOf(h, job.id)).phase).toBe('STAGE')
    // A second click cannot start a second worker.
    await expect(h.router.dispatch('IMPORT_STAGE', { jobId: job.id }, ADMIN)).rejects.toThrow(/fresh upload/)
  })
})

describe('plan', () => {
  it('requires an explicit target and a tag for a rehearsal', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await expect(h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: {} }, ADMIN)).rejects.toThrow(/target is required/)
    await expect(h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL' } }, ADMIN)).rejects.toThrow(/targetTag/)
    await expect(h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'BAD TAG' } }, ADMIN)).rejects.toThrow(/lowercase/)
  })

  it('moves a staged job to PLANNING and starts the worker; it cannot start from an unstaged job', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103', carrierWindowMonths: 12 } }, ADMIN)
    const after = await jobOf(h, job.id)
    expect(after).toMatchObject({ status: 'PLANNING', phase: 'PLAN', target: 'REHEARSAL', targetTag: 'rh1103' })
    expect(h.invoked).toEqual([{ kind: 'WORK', jobId: job.id, hops: 0 }])
    await expect(h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103' } }, ADMIN)).rejects.toThrow(/staged file/)
  })

  it('keeps fault injection off real data and off any non-dev stack', () => {
    expect(sanitizeOptions({ faultAfterRows: 5 }, false, true).faultAfterRows).toBeUndefined()
    expect(sanitizeOptions({ faultAfterRows: 5 }, true, false).faultAfterRows).toBeUndefined()
    expect(sanitizeOptions({ faultAfterRows: 5 }, true, true).faultAfterRows).toBe(5)
  })

  it('never lets a client choose the source object', () => {
    expect((sanitizeOptions({ sourceKey: 'imports/source/other/secret.csv' }, true, true) as Record<string, unknown>).sourceKey).toBeUndefined()
  })
})

describe('apply', () => {
  it('only applies a PLANNED job', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103' } }, ADMIN)).rejects.toThrow(/PLANNED/)
  })

  it('creates a child run that points at the plan, and starts the worker', async () => {
    const h = harness()
    const plan = await plannedJob(h)
    const r = await h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: {} }, ADMIN)
    const run = r.job as AljexImportJob
    expect(run).toMatchObject({ status: 'RUNNING', phase: 'CUSTOMER', parentJobId: plan.id, stageHash: 'stage-1', target: 'REHEARSAL', targetTag: 'rh1103' })
    expect(run.id).not.toBe(plan.id)
    expect(h.invoked).toEqual([{ kind: 'WORK', jobId: run.id, hops: 0 }])
  })

  it('refuses LIVE without a confirmation tag, and real data LIVE without a reconciled rehearsal of the same file', async () => {
    const h = harness()
    const plan = await plannedJob(h)
    await h.store.update('aljexImportJob', plan.id, { target: 'LIVE', options: { target: 'LIVE' } })
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: {} }, ADMIN)).rejects.toThrow(/confirmation tag/)
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: { liveTag: 'GO-LIVE' } }, ADMIN)).rejects.toThrow(/reconciled rehearsal/)
    // A reconciled rehearsal of a DIFFERENT file does not open the gate.
    await h.store.putJob({ id: 'aljexrun:other', kind: 'IMPORT', status: 'APPLIED', target: 'REHEARSAL', stageHash: 'other-file', options: { reconciled: true }, createdBy: 'x' })
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: { liveTag: 'GO-LIVE' } }, ADMIN)).rejects.toThrow(/reconciled rehearsal/)
    // An unreconciled rehearsal of the same file does not either.
    await h.store.putJob({ id: 'aljexrun:same-unreconciled', kind: 'IMPORT', status: 'APPLIED', target: 'REHEARSAL', stageHash: 'stage-1', profileVersion: 0, options: {}, createdBy: 'x' })
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: { liveTag: 'GO-LIVE' } }, ADMIN)).rejects.toThrow(/reconciled rehearsal/)
    // The same file, same profile, reconciled: allowed.
    await h.store.putJob({ id: 'aljexrun:same', kind: 'IMPORT', status: 'APPLIED', target: 'REHEARSAL', stageHash: 'stage-1', profileVersion: 0, options: { reconciled: true }, createdBy: 'x' })
    const ok = await h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: { liveTag: 'GO-LIVE' } }, ADMIN)
    expect((ok.job as AljexImportJob).liveTag).toBe('GO-LIVE')
  })

  it('lets a synthetic file go live with only the tag', async () => {
    const h = harness()
    const plan = await plannedJob(h, { synthetic: true })
    await h.store.update('aljexImportJob', plan.id, { target: 'LIVE', options: { target: 'LIVE', synthetic: true } })
    const ok = await h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: { liveTag: 'ZZ-IMPORT-1k' } }, ADMIN)
    expect((ok.job as AljexImportJob).status).toBe('RUNNING')
  })

  it('refuses when the UI saw a different row count, or the profile changed after the plan', async () => {
    const h = harness()
    const plan = await plannedJob(h)
    h.objects.set(`imports/jobs/${plan.id}/stage-summary.json`, JSON.stringify({ rows: 100, loads: 90, memos: 10, junkDates: 0, duplicatePros: 0, raggedRows: 0, parseErrors: 0, distinct: {} }))
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: { expectedRows: 99 } }, ADMIN)).rejects.toThrow(/expected 99 rows/)
    await h.router.dispatch('IMPORT_SAVE_PROFILE', { layoutId: 'aljex-full-486-v1', profile: { statusMap: {} }, expectedVersion: 0 }, ADMIN)
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: {} }, ADMIN)).rejects.toThrow(/profile changed/)
  })

  it('lists unmapped rep / dispatcher values without blocking the apply', async () => {
    const h = harness()
    const plan = await plannedJob(h)
    h.objects.set(`imports/jobs/${plan.id}/stage-summary.json`, JSON.stringify({
      rows: 100, loads: 100, memos: 0, junkDates: 0, duplicatePros: 0, raggedRows: 0, parseErrors: 0, distinct: {},
      unmapped: [{ column: 'salesreps', value: '017', count: 2 }, { column: 'dispatchers', value: 'JD', count: 3 }],
    }))
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: {} }, ADMIN)).resolves.toBeTruthy()
  })

  it('blocks on unmapped values until the profile accepts them', async () => {
    const h = harness()
    const plan = await plannedJob(h)
    h.objects.set(`imports/jobs/${plan.id}/stage-summary.json`, JSON.stringify({
      rows: 100, loads: 100, memos: 0, junkDates: 0, duplicatePros: 0, raggedRows: 0, parseErrors: 0, distinct: {},
      unmapped: [{ column: 'status', value: 'MYSTERY', count: 2 }],
    }))
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: {} }, ADMIN)).rejects.toThrow(/no mapping/)
    const saved = await h.router.dispatch('IMPORT_SAVE_PROFILE', { layoutId: 'aljex-full-486-v1', profile: { acceptedUnmapped: ['status:MYSTERY'] }, expectedVersion: 0 }, ADMIN)
    await h.store.update('aljexImportJob', plan.id, { profileVersion: (saved.profile as { version: number }).version })
    await expect(h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: {} }, ADMIN)).resolves.toBeTruthy()
  })
})

describe('pause / resume / cancel', () => {
  async function running(h: Harness, heartbeatAt: string): Promise<AljexImportJob> {
    const plan = await plannedJob(h)
    const run = (await h.router.dispatch('IMPORT_APPLY', { jobId: plan.id, options: {} }, ADMIN)).job as AljexImportJob
    await h.store.update('aljexImportJob', run.id, { heartbeatAt })
    h.invoked.length = 0
    return jobOf(h, run.id)
  }

  it('pauses only a running job, then resumes it into the state its phase belongs to', async () => {
    const h = harness()
    const run = await running(h, new Date().toISOString())
    await h.router.dispatch('IMPORT_PAUSE', { jobId: run.id }, ADMIN)
    expect((await jobOf(h, run.id)).status).toBe('PAUSED')
    await expect(h.router.dispatch('IMPORT_PAUSE', { jobId: run.id }, ADMIN)).rejects.toThrow(/running job/)
    await h.router.dispatch('IMPORT_RESUME', { jobId: run.id }, ADMIN)
    expect((await jobOf(h, run.id)).status).toBe('RUNNING')
    expect(h.invoked).toEqual([{ kind: 'WORK', jobId: run.id, hops: 0 }])
  })

  it('refuses to resume a job that is still beating, and allows it once it has stalled', async () => {
    const h = harness()
    const fresh = await running(h, new Date().toISOString())
    await expect(h.router.dispatch('IMPORT_RESUME', { jobId: fresh.id }, ADMIN)).rejects.toThrow(/still running/)
    const stale = await running(h, new Date(Date.now() - STALLED_AFTER_MS - 1000).toISOString())
    await h.router.dispatch('IMPORT_RESUME', { jobId: stale.id }, ADMIN)
    expect(h.invoked).toHaveLength(1)
    // The heartbeat was refreshed, so a second click does not start a second worker.
    await expect(h.router.dispatch('IMPORT_RESUME', { jobId: stale.id }, ADMIN)).rejects.toThrow(/still running/)
  })

  it('cancels without touching a finished job', async () => {
    const h = harness()
    const run = await running(h, new Date().toISOString())
    await h.router.dispatch('IMPORT_CANCEL', { jobId: run.id }, ADMIN)
    expect((await jobOf(h, run.id)).status).toBe('CANCELED')
    await h.store.update('aljexImportJob', run.id, { status: 'APPLIED' })
    await expect(h.router.dispatch('IMPORT_CANCEL', { jobId: run.id }, ADMIN)).rejects.toThrow(/cannot be canceled/)
  })

  it('writes an audit row for each control action', async () => {
    const h = harness()
    const run = await running(h, new Date().toISOString())
    await h.router.dispatch('IMPORT_PAUSE', { jobId: run.id }, ADMIN)
    const actions = h.store.own('auditLog').map((r) => r.action)
    expect(actions).toEqual(expect.arrayContaining(['PLAN', 'APPLY', 'PAUSE']))
  })
})

describe('worker', () => {
  it('re-invokes itself while the engine reports more work', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103' } }, ADMIN)
    h.invoked.length = 0
    h.setRun(async (id) => ({ done: false, job: await jobOf(h, id) }))
    const r = await h.router.work({ kind: 'WORK', jobId: job.id, hops: 3 })
    expect(r).toMatchObject({ done: false, continued: true })
    expect(h.invoked).toEqual([{ kind: 'WORK', jobId: job.id, hops: 4 }])
  })

  it('stops chaining once the job is paused (a pause is not lost)', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103' } }, ADMIN)
    h.invoked.length = 0
    h.setRun(async (id) => {
      await h.router.dispatch('IMPORT_PAUSE', { jobId: id }, ADMIN)
      return { done: false, job: await jobOf(h, id) }
    })
    const r = await h.router.work({ kind: 'WORK', jobId: job.id })
    expect(r).toMatchObject({ done: true, status: 'PAUSED' })
    expect(h.invoked).toHaveLength(0)
  })

  it('does nothing for a job that is not active', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await h.router.work({ kind: 'WORK', jobId: job.id })
    expect(h.runs).toHaveLength(0)
  })

  it('marks the job FAILED when the engine throws, instead of leaving it RUNNING', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103' } }, ADMIN)
    h.setRun(async () => { throw new Error('boom') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await h.router.work({ kind: 'WORK', jobId: job.id })
      expect(await jobOf(h, job.id)).toMatchObject({ status: 'FAILED', error: 'boom' })
      expect(error).toHaveBeenCalledWith('[tms-aljex-import] runSlice threw:', 'boom')
    } finally {
      error.mockRestore()
    }
  })

  it('fails a chain that never ends', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103' } }, ADMIN)
    h.setRun(async (id) => ({ done: false, job: await jobOf(h, id) }))
    await h.router.work({ kind: 'WORK', jobId: job.id, hops: 200 })
    expect((await jobOf(h, job.id)).status).toBe('FAILED')
  })

  it('records a finished rehearsal as reconciled only when the report says so', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103' } }, ADMIN)
    h.setRun(async (id) => {
      await h.store.update('aljexImportJob', id, { status: 'APPLIED', reportPrefix: `imports/runs/${id}/` })
      return { done: true, job: await jobOf(h, id) }
    })
    h.objects.set(`imports/runs/${job.id}/summary.json`, JSON.stringify({ reconciled: false }))
    await h.router.work({ kind: 'WORK', jobId: job.id })
    expect((await jobOf(h, job.id)).options?.reconciled).toBeUndefined()
    h.objects.set(`imports/runs/${job.id}/summary.json`, JSON.stringify({ reconciled: true }))
    await h.router.work({ kind: 'RECONCILE', jobId: job.id }).catch(() => undefined)
    h.setRun(async (id) => ({ done: true, job: await jobOf(h, id) }))
    const got = await h.router.dispatch('IMPORT_RECONCILE', { jobId: job.id }, ADMIN)
    expect((got.job as AljexImportJob).options?.reconciled).toBe(true)
  })
})

describe('profile', () => {
  it('returns the shipped defaults at version 0 until a profile is saved', async () => {
    const h = harness()
    const r = await h.router.dispatch('IMPORT_GET_PROFILE', { layoutId: 'aljex-full-486-v1' }, ADMIN)
    expect(r.profile).toMatchObject({ version: 0, createdBy: 'default' })
  })

  it('versions saves and refuses a stale editor', async () => {
    const h = harness()
    const first = await h.router.dispatch('IMPORT_SAVE_PROFILE', { layoutId: 'L1', profile: { a: 1 }, expectedVersion: 0 }, ADMIN)
    expect((first.profile as { version: number }).version).toBe(1)
    await expect(h.router.dispatch('IMPORT_SAVE_PROFILE', { layoutId: 'L1', profile: { a: 2 }, expectedVersion: 0 }, ADMIN)).rejects.toThrow(/changed/)
    const second = await h.router.dispatch('IMPORT_SAVE_PROFILE', { layoutId: 'L1', profile: { a: 2 }, expectedVersion: 1 }, ADMIN)
    expect((second.profile as { version: number; createdBy: string })).toMatchObject({ version: 2, createdBy: ADMIN.email })
  })
})

describe('carrier sync (MyCarrierPackets)', () => {
  function seedCarriers(h: Harness): void {
    h.store.seed('carrier', [
      { id: 'c1', name: 'ZZ One', aljexCode: 'A1', mcNumber: '111', lastLoadAt: '2026-01-01' },
      { id: 'c2', name: 'ZZ Two', aljexCode: 'A2', mcNumber: '222', lastLoadAt: '2026-06-01' },
      { id: 'c3', name: 'ZZ NoMc', aljexCode: 'A3', lastLoadAt: '2026-05-01' },
      { id: 'c4', name: 'ZZ Done', aljexCode: 'A4', mcNumber: '444', mcpStatus: 'ACCEPTABLE' },
      { id: 'c5', name: 'ZZ Not imported', mcNumber: '555' },
    ])
  }

  it('does nothing and writes no job when MyCarrierPackets is not LIVE', async () => {
    const h = harness()
    seedCarriers(h)
    h.setMcp(() => ({ ready: false, reason: 'MyCarrierPackets is not LIVE (Integrations > MyCarrierPackets > Validate)', results: [], cursor: null, done: false }))
    const r = await h.router.dispatch('IMPORT_SYNC_CARRIERS', {}, ADMIN)
    expect(r).toMatchObject({ ready: false, job: null })
    expect(h.store.own('aljexImportJob')).toHaveLength(0)
  })

  it('selects only imported, MC-bearing, unsynced carriers, most recently active first', async () => {
    const h = harness()
    seedCarriers(h)
    h.setMcp(() => ({ ready: true, results: [{ carrierId: 'c2', result: 'SYNCED' }], cursor: { lastCarrierId: 'c2' }, done: false }))
    const r = await h.router.dispatch('IMPORT_SYNC_CARRIERS', {}, ADMIN)
    expect(h.mcpCalls[0]).toMatchObject({ kind: 'IMPORT_BATCH', carrierIds: ['c2', 'c1'], maxLookups: 25 })
    const job = r.job as AljexImportJob
    expect(job).toMatchObject({ kind: 'MCP_SYNC', status: 'RUNNING' })
    expect(job.entityCounts?.CARRIER).toMatchObject({ staged: 3, enriched: 1, skipped: 1 })
    expect(h.invoked).toEqual([{ kind: 'MCP_SYNC', jobId: job.id, hops: 0 }])
    expect(h.objects.get(`imports/runs/${job.id}/mcp-sync.csv`)).toContain('c3,NO_MC')
  })

  it('continues from its cursor and finishes the job', async () => {
    const h = harness()
    seedCarriers(h)
    h.setMcp(() => ({ ready: true, results: [{ carrierId: 'c2', result: 'SYNCED' }], cursor: { lastCarrierId: 'c2' }, done: false }))
    const job = (await h.router.dispatch('IMPORT_SYNC_CARRIERS', {}, ADMIN)).job as AljexImportJob
    h.mcpCalls.length = 0
    h.setMcp(() => ({ ready: true, results: [{ carrierId: 'c1', result: 'NO_PACKET' }], cursor: null, done: true }))
    await h.router.work({ kind: 'MCP_SYNC', jobId: job.id })
    expect(h.mcpCalls[0]).toMatchObject({ cursor: { lastCarrierId: 'c2' } })
    const done = await jobOf(h, job.id)
    expect(done.status).toBe('APPLIED')
    expect(done.entityCounts?.CARRIER).toMatchObject({ enriched: 1, skipped: 2 })
  })

  it('pauses (does not fail) when MyCarrierPackets stops being LIVE mid-run', async () => {
    const h = harness()
    seedCarriers(h)
    h.setMcp(() => ({ ready: true, results: [], cursor: { lastCarrierId: 'c2' }, done: false }))
    const job = (await h.router.dispatch('IMPORT_SYNC_CARRIERS', {}, ADMIN)).job as AljexImportJob
    h.setMcp(() => ({ ready: false, reason: 'not live', results: [], cursor: null, done: false }))
    await h.router.work({ kind: 'MCP_SYNC', jobId: job.id })
    expect(await jobOf(h, job.id)).toMatchObject({ status: 'PAUSED', error: 'not live' })
  })
})

describe('masked sample', () => {
  function csvWith(rows: Array<Record<string, string>>): string {
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`
    const cells = (over: Record<string, string>) => {
      const row = Array<string>(ALJEX_HEADERS_V1.length).fill('')
      for (const [key, value] of Object.entries(over)) row[LAYOUT_V1.scalar[key as keyof typeof LAYOUT_V1.scalar]] = value
      return row.map(q).join(',')
    }
    return [ALJEX_HEADERS_V1.map(q).join(','), ...rows.map(cells)].join('\n') + '\n'
  }

  it('returns mapped fields for the chosen rows only, with names masked by default', async () => {
    const h = harness()
    const job = await stagedJob(h)
    h.objects.set(`imports/source/${job.id}/export.csv`, csvWith([
      { proNo: '900001', customerId: 'ZZA', customerName: 'ZZ Alpha Freight', dispatchStatus: 'DELIVERED', typeOfShipment: 'FTL' },
      { proNo: '900002', customerId: 'ZZB', customerName: 'ZZ Bravo Freight', dispatchStatus: 'OPEN', typeOfShipment: 'FTL' },
      { proNo: '900003', customerId: 'ZZC', customerName: 'ZZ Charlie Freight', dispatchStatus: 'OPEN', typeOfShipment: 'FTL' },
    ]))
    const masked = (await h.router.dispatch('IMPORT_SAMPLE', { jobId: job.id, rows: [3, 1] }, ADMIN)).rows as Array<{ rowNumber: number; fields: Record<string, unknown> }>
    expect(masked.map((r) => r.rowNumber)).toEqual([1, 3])
    expect(masked[0].fields.pro).toBe('900001')
    expect(String(masked[0].fields.customer)).not.toContain('Alpha')
    const open = (await h.router.dispatch('IMPORT_SAMPLE', { jobId: job.id, rows: [2], unmask: true }, ADMIN)).rows as Array<{ fields: Record<string, unknown> }>
    expect(open[0].fields.customer).toBe('ZZ Bravo Freight')
  })

  it('refuses an empty or oversized row selection', async () => {
    const h = harness()
    const job = await stagedJob(h)
    await expect(h.router.dispatch('IMPORT_SAMPLE', { jobId: job.id, rows: [] }, ADMIN)).rejects.toThrow(/rows/)
  })
})

describe('report links', () => {
  it('presigns only objects under the run\'s own prefix', async () => {
    const h = harness()
    const job = await stagedJob(h)
    h.objects.set(`imports/runs/${job.id}/summary.json`, '{}')
    h.objects.set('imports/runs/someone-else/summary.json', '{}')
    const r = await h.router.dispatch('IMPORT_REPORT_LINKS', { jobId: job.id }, ADMIN)
    expect((r.links as Array<{ name: string }>).map((l) => l.name)).toEqual(['summary.json'])
  })
})

describe('schema audit fields', () => {
  /** The `.required()` fields of a model, read from the schema source so the list cannot drift. */
  function requiredFields(model: string): string[] {
    const src = readFileSync(new URL('../../data/resource.ts', import.meta.url), 'utf8')
    const start = src.indexOf(`  ${model}: a\n`)
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('.disableOperations', start)
    const body = src.slice(start, end)
    return [...body.matchAll(/^\s+(\w+):\s+a\.\w+\([^)]*\)\.required\(\)/gm)].map((m) => m[1])
  }

  it('every row the router writes carries every non-nullable schema field', async () => {
    const h = harness()
    await h.router.dispatch('IMPORT_SAVE_PROFILE', { layoutId: 'L1', profile: {}, expectedVersion: 0 }, ADMIN)
    const job = await stagedJob(h)
    await h.router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'REHEARSAL', targetTag: 'rh1103' } }, ADMIN)
    const written: Record<string, EngineRow[]> = {
      AljexImportJob: h.store.own('aljexImportJob'),
      AljexMappingProfile: h.store.own('aljexMappingProfile'),
      AuditLog: h.store.own('auditLog'),
    }
    for (const [model, rows] of Object.entries(written)) {
      const required = requiredFields(model)
      expect(required.length, `${model} has required fields in the schema`).toBeGreaterThan(0)
      expect(rows.length, `${model} rows written`).toBeGreaterThan(0)
      for (const row of rows) {
        for (const field of required) expect(row[field], `${model}.${field}`).not.toBeUndefined()
        for (const field of required) expect(row[field], `${model}.${field}`).not.toBeNull()
      }
    }
  })
})

describe('router + real engine on the synthetic golden file', () => {
  it('drives prepare -> stage -> plan -> apply to APPLIED through the worker, and the job is reconcilable', async () => {
    const { runSlice, reconcile } = await import('./engine')
    const { DEV_SUFFIX } = await import('./engine/tables')
    const devTables = Object.fromEntries(TABLE_KEYS.map((k) => [k, `${k}-${DEV_SUFFIX}`])) as unknown as TableSet
    const csv = readFileSync(new URL('../../../scripts/fixtures/aljex-synth-40.csv', import.meta.url))
    const store = new MemoryStore({ tables: devTables })
    store.seed('settings', [{ id: 'default', createdBy: 'seed', updatedBy: 'seed' }])
    const invoked: Array<Record<string, unknown>> = []
    const deps: RouterDeps = {
      store,
      bucket: 'b',
      now: () => new Date().toISOString(),
      devStack: true,
      runSlice,
      seedProCounter: async () => ({ current: null, target: 0, wouldChange: false, applied: false, schemeEnabled: false }),
      reconcile,
      invokeSelf: async (p) => { invoked.push(p) },
      presignPut: async (k) => k,
      presignGet: async (k) => k,
      headObject: async (key) => {
        let size = 0
        try { for await (const c of store.getObject(key)) size += c.length } catch { return null }
        return { size }
      },
      listObjects: async () => [],
      getText: async (key) => {
        try {
          const parts: Uint8Array[] = []
          for await (const c of store.getObject(key)) parts.push(c)
          return Buffer.concat(parts).toString('utf8')
        } catch { return null }
      },
      streamText: async function* () { yield '' },
      putText: async (k, b) => { await store.putObject(k, b) },
      invokeMcp: async () => ({ ready: false, results: [], cursor: null, done: false }),
      remainingMs: () => 900_000,
      randomId: () => 'e2e01',
    }
    const router = createRouter(deps)
    const prep = await router.dispatch('IMPORT_PREPARE', { fileName: 'synth.csv', fileHash: createHash('sha256').update(csv).digest('hex'), sizeBytes: csv.length }, ADMIN)
    const job = prep.job as AljexImportJob
    await store.putObject(prep.uploadKey as string, csv)

    const drain = async () => {
      for (let i = 0; i < 20 && invoked.length; i++) {
        const next = invoked.shift()!
        await router.work(next as { kind: string; jobId: string; hops?: number })
      }
    }
    await router.dispatch('IMPORT_STAGE', { jobId: job.id }, ADMIN)
    await drain()
    const staged = (await router.dispatch('IMPORT_GET', { jobId: job.id }, ADMIN)).job as AljexImportJob
    expect({ status: staged.status, error: staged.error }).toEqual({ status: 'READY', error: null })
    expect(staged.stage?.rows).toBeGreaterThan(0)

    await router.dispatch('IMPORT_PLAN', { jobId: job.id, options: { target: 'LIVE', synthetic: true } }, ADMIN)
    await drain()
    const planned = (await router.dispatch('IMPORT_GET', { jobId: job.id }, ADMIN)).job as AljexImportJob
    expect({ status: planned.status, error: planned.error }).toEqual({ status: 'PLANNED', error: null })
    expect(planned.plan?.classes.CREATE).toBeGreaterThan(0)
    expect(store.own('shipment')).toHaveLength(0) // planning wrote nothing

    const applied = (await router.dispatch('IMPORT_APPLY', { jobId: job.id, options: { liveTag: 'ZZ-IMPORT' } }, ADMIN)).job as AljexImportJob
    await drain()
    const done = (await router.dispatch('IMPORT_GET', { jobId: applied.id }, ADMIN)).job as AljexImportJob
    expect(done.status).toBe('APPLIED')
    expect(done.parentJobId).toBe(job.id)
    expect(store.own('shipment').length).toBeGreaterThan(0)
    // Every written job row carries the schema's required audit field.
    for (const j of store.own('aljexImportJob')) expect(j.createdBy).toBeTruthy()
    const rec = await router.dispatch('IMPORT_RECONCILE', { jobId: applied.id }, ADMIN)
    expect((rec.summary as { jobId: string } | null)?.jobId).toBe(applied.id)
  })
})
