import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { LAST_MODEL_STAGE, MODEL_STAGE, PRODUCTION_MODELS } from '../amplify/data/stages'
import { runAwProd } from './awProd.mjs'
import {
  AwProdRefusal, PROD_API_ID, checkBackupStamp, confirmTokenFor, createCheckpoint, createLog, evaluateRun, maskPro, parseStage, requiredStage, resolveProdSuffix, scrub,
} from './lib/awProdGuard.mjs'

const stages = { MODEL_STAGE, PRODUCTION_MODELS, LAST_MODEL_STAGE }
const NOW = new Date(2026, 10, 9, 12, 0, 0)
const GOOD_STATE = { rootStack: 'root', rootStatus: 'UPDATE_COMPLETE', runningJobs: 0, stage: 3 }
const GOOD_STAMP = { ok: true, ageMinutes: 10, reason: null }

let dir
let writes
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awprod-'))
  writes = []
})

/** Fake dependencies; `handler` replaces the step body. DynamoDB answers DescribeTable only (counts are fixed). */
function fakeDeps({ state = GOOD_STATE, stamp = GOOD_STAMP, handler } = {}) {
  const dynamo = { send: vi.fn(async (cmd) => { if (cmd instanceof DescribeTableCommand) return { Table: { ItemCount: 5 } }; throw new Error('unexpected dynamo call') }) }
  const doc = { send: vi.fn(async () => ({ Count: 5 })) }
  return {
    dynamo, doc,
    stages: async () => stages,
    readProdState: async () => state,
    checkBackupStamp: () => stamp,
    handlers: { customers: handler ?? (async () => { writes.push('write'); return { status: 'applied' } }), tax: async () => ({}) },
  }
}

const run = (argv, { env = {}, deps = fakeDeps() } = {}) => {
  const out = []
  return runAwProd({ argv, env, now: NOW, deps, logDir: dir, out: (s) => out.push(s) }).then((r) => ({ ...r, out }))
}
const ARGS = ['customers', '--suffix', PROD_API_ID, '--file', 'x.csv']
const CONFIRM = { AW_PROD_CONFIRM: confirmTokenFor('customers', NOW) }

describe('refusal matrix', () => {
  it('refuses a wrong suffix and the dev suffix', () => {
    expect(() => resolveProdSuffix('nc3jsnxdmjhkpequimypiatkma')).toThrow(/DEV/)
    expect(() => resolveProdSuffix('nc3jsnxdmjhkpequimypiatkma-NONE')).toThrow(/DEV/)
    expect(() => resolveProdSuffix('abcdef')).toThrow(AwProdRefusal)
    expect(() => resolveProdSuffix(undefined)).toThrow(/required/)
    expect(resolveProdSuffix(PROD_API_ID)).toBe(`${PROD_API_ID}-NONE`)
  })

  it('apply without the typed confirmation or with another step name is refused and nothing is written', async () => {
    for (const env of [{}, { AW_PROD_CONFIRM: confirmTokenFor('carriers', NOW) }, { AW_PROD_CONFIRM: '2026-11-08-customers' }]) {
      const r = await run([...ARGS, '--apply'], { env })
      expect(r.status).toBe('refused')
      expect(r.failures.join()).toMatch(/AW_PROD_CONFIRM=2026-11-09-customers/)
    }
    expect(writes).toEqual([])
  })

  it('refuses a missing or stale backup stamp, and says how to create it', async () => {
    const stale = await run([...ARGS, '--apply'], { env: CONFIRM, deps: fakeDeps({ stamp: { ok: false, ageMinutes: 400, reason: 'backup stamp is 400 min old (limit 360)' } }) })
    expect(stale.status).toBe('refused')
    expect(stale.failures.join()).toMatch(/LATEST_BACKUP_STAMP/)
    const fs = { existsSync: () => false }
    expect(checkBackupStamp({ now: NOW, fs }).ok).toBe(false)
    const old = { existsSync: () => true, statSync: () => ({ mtime: new Date(NOW.getTime() - 7 * 3600_000) }) }
    expect(checkBackupStamp({ now: NOW, fs: old }).ok).toBe(false)
    const fresh = { existsSync: () => true, statSync: () => ({ mtime: new Date(NOW.getTime() - 3600_000) }) }
    expect(checkBackupStamp({ now: NOW, fs: fresh }).ok).toBe(true)
    expect(writes).toEqual([])
  })

  it('refuses when the root stack is not UPDATE_COMPLETE or an Amplify job is running', async () => {
    const a = await run([...ARGS, '--apply'], { env: CONFIRM, deps: fakeDeps({ state: { ...GOOD_STATE, rootStatus: 'UPDATE_IN_PROGRESS' } }) })
    expect(a.failures.join()).toMatch(/UPDATE_IN_PROGRESS/)
    const b = await run([...ARGS, '--apply'], { env: CONFIRM, deps: fakeDeps({ state: { ...GOOD_STATE, runningJobs: 1 } }) })
    expect(b.failures.join()).toMatch(/running/)
    expect(writes).toEqual([])
  })

  it('refuses when BCAT_SCHEMA_STAGE is below the step\'s stage', async () => {
    const r = await run([...ARGS, '--apply'], { env: CONFIRM, deps: fakeDeps({ state: { ...GOOD_STATE, stage: 2 } }) })
    expect(r.failures.join()).toMatch(/stage >= 3/)
    expect(requiredStage('customers', stages)).toBe(3)
    expect(requiredStage('backfill', stages)).toBe(2)
    expect(requiredStage('jenny', stages)).toBe(1)
    expect(requiredStage('tax-ids', stages)).toBe(1)
    expect(parseStage(undefined)).toBe(4)
    expect(parseStage('2')).toBe(2)
  })

  it('applies when every guard passes, and records before/after counts', async () => {
    const r = await run([...ARGS, '--apply'], { env: CONFIRM })
    expect(r.status).toBe('applied')
    expect(writes).toEqual(['write'])
    const log = readFileSync(r.logPath, 'utf8')
    expect(log).toMatch(/table Customer: before 5, after 5, delta 0/)
  })
})

describe('dry run', () => {
  it('is the default: the handler sees apply=false and the guards only advise', async () => {
    let seen
    const deps = fakeDeps({ handler: async (ctx) => { seen = ctx.apply; return { status: 'dry-run' } }, state: { ...GOOD_STATE, runningJobs: 2 } })
    const r = await run(ARGS, { deps })
    expect(seen).toBe(false)
    expect(r.status).toBe('dry-run')
    expect(r.out.join('\n')).toMatch(/would currently be refused/)
    // a dry run never scans (only DescribeTable)
    expect(deps.doc.send).not.toHaveBeenCalled()
  })

  it('still refuses the wrong suffix', async () => {
    await expect(run(['customers', '--suffix', 'nc3jsnxdmjhkpequimypiatkma-NONE'])).rejects.toThrow(AwProdRefusal)
  })
})

describe('log hygiene', () => {
  const CANARIES = ['jane.doe@example.com', '312-555-0187', '07-0000003', '666-12-3456', '9876543210123', 'Hunter2Password!', '0b8a6c3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d']
  it('scrub removes e-mails, phones, tax ids, long digits, uuids and secret key/values', () => {
    const line = scrub(`contact ${CANARIES[0]} ${CANARIES[1]} ${CANARIES[2]} ${CANARIES[3]} acct ${CANARIES[4]} ${CANARIES[6]} password=${CANARIES[5]}`)
    for (const c of CANARIES) expect(line).not.toContain(c)
  })

  it('a step that prints PII leaves none in the log file; counts and masked PROs survive', async () => {
    const deps = fakeDeps({
      handler: async (ctx) => {
        ctx.log.info(`row for ${CANARIES[0]} phone ${CANARIES[1]} Fed/SS: ${CANARIES[3]} Web Password: ${CANARIES[5]}`)
        ctx.log.counts('rows', { created: 7, name: 'Jane Doe' })
        ctx.log.info(`PRO ${maskPro('20123')}`)
        return { status: 'applied' }
      },
    })
    const r = await run([...ARGS, '--apply'], { env: CONFIRM, deps })
    const log = readFileSync(r.logPath, 'utf8')
    for (const c of CANARIES) expect(log).not.toContain(c)
    expect(log).not.toContain('Jane Doe')
    expect(log).toContain('created=7')
    expect(log).toContain('***123')
    expect(readdirSync(dir).some((f) => f.startsWith('customers-') && f.endsWith('.log'))).toBe(true)
  })
})

describe('checkpoint resume', () => {
  it('skips completed chunks on a re-run of the same input and not for a different input', () => {
    const a = createCheckpoint('backfill', 'fp1', { dir })
    a.mark('chunk:1')
    a.mark('chunk:2')
    const again = createCheckpoint('backfill', 'fp1', { dir })
    expect(again.has('chunk:1')).toBe(true)
    expect(again.size()).toBe(2)
    expect(createCheckpoint('backfill', 'other-input', { dir }).has('chunk:1')).toBe(false)
    expect(createCheckpoint('backfill', 'fp1', { dir, fresh: true }).has('chunk:1')).toBe(false)
  })

  it('a re-run through runAwProd hands the stored checkpoint to the handler', async () => {
    let first
    const seen = []
    const handler = async (ctx) => {
      seen.push(ctx.ckpt.has('chunk:a'))
      ctx.ckpt.mark('chunk:a')
      first ??= ctx.ckpt.path
      return { status: 'applied' }
    }
    writeFileSync(join(dir, 'x.csv'), 'h\n')
    const args = ['customers', '--suffix', PROD_API_ID, '--source', join(dir, 'x.csv'), '--apply']
    await run(args, { env: CONFIRM, deps: fakeDeps({ handler }) })
    await run(args, { env: CONFIRM, deps: fakeDeps({ handler }) })
    expect(seen).toEqual([false, true])
  })
})

describe('evaluateRun is pure', () => {
  it('collects every failure at once', () => {
    const { failures } = evaluateRun({ step: 'loads', apply: true, env: {}, now: NOW, stampState: { ok: false, reason: 'missing' }, state: { rootStatus: 'X', runningJobs: 1, stage: 0 }, stages })
    expect(failures).toHaveLength(5)
  })
  it('createLog writes under the given dir with the step name', () => {
    const l = createLog('verify', { dir, now: NOW })
    l.info('x')
    expect(l.path.startsWith(dir)).toBe(true)
    expect(l.path).toMatch(/verify-.*\.log$/)
  })
})

// ── the offline per-file route (the Lambda refuses production tables in every mode) ─────────────
import { fileArgs, reconcileArgs, stageArgs } from './lib/awProdOffline.mjs'
import { splitProdArgs } from './lib/importAljexArgs.mjs'
import { PROD_SUFFIX as OFFLINE_PROD_SUFFIX } from './lib/awProdGuard.mjs'

describe('offline file steps route through importAljex with the production gate', () => {
  const v = { file: '/x/c.csv', cutoff: '2026-11-07', 'live-tag': 'AW-PROD-1108' }
  it('every file step carries --i-mean-production; only --apply carries the typed confirmation', () => {
    const dry = fileArgs('customers', { ...v, 'live-tag': undefined }, { apply: false, account: '111' })
    expect(dry).toEqual(expect.arrayContaining(['file', '--kind', 'customers', '--file', '/x/c.csv', '--cutoff', '2026-11-07', '--target', 'prod:plan', '--i-mean-production']))
    expect(dry).not.toContain('--apply')
    const apply = fileArgs('ap-expected', v, { apply: true, account: '111' })
    expect(apply).toEqual(expect.arrayContaining(['--kind', 'ap', '--expected-file', '/x/c.csv', '--target', 'prod:AW-PROD-1108', '--apply', '--confirm-prod', `111:${OFFLINE_PROD_SUFFIX}`]))
    expect(() => fileArgs('ar', { ...v, 'live-tag': undefined }, { apply: true, account: '111' })).toThrow(/live-tag/)
    expect(() => fileArgs('ar', { file: 'x' }, { apply: false, account: null })).toThrow(/cutoff/)
  })

  it('stage and reconcile are gated the same way; reconcile needs the bucket and a cutoff', () => {
    expect(stageArgs({ file: '/x/big.csv' })).toEqual(expect.arrayContaining(['stage', '--source', '/x/big.csv', '--i-mean-production']))
    const rec = reconcileArgs({ entity: 'AR', 'source-job': 'j1', 'customers-job': 'j0', cutoff: '2026-11-07' }, { account: '111', bucket: 'b' })
    expect(rec).toEqual(expect.arrayContaining(['reconcile-entity', '--entity', 'AR', '--customers-job', 'j0', '--bucket', 'b', '--i-mean-production', '--apply']))
    expect(() => reconcileArgs({ entity: 'AR', 'source-job': 'j1', cutoff: '2026-11-07' }, { account: '111', bucket: '' })).toThrow(/bucket/)
  })

  it('the wrapper treats a per-file dry run as read-only (no backup demanded) and an apply as a write', () => {
    const base = ['file', '--kind', 'ar', '--file', 'f', '--cutoff', '2026-11-07', '--target', 'prod:T', '--i-mean-production']
    expect(splitProdArgs(base).readOnly).toBe(true)
    expect(splitProdArgs([...base, '--apply']).readOnly).toBe(false)
    expect(splitProdArgs(['stage', '--source', 'f', '--target', 'prod:T']).readOnly).toBe(true)
    expect(splitProdArgs(['reconcile-entity', '--entity', 'AR', '--target', 'prod:T', '--apply']).readOnly).toBe(false)
    // without the prod target the gate flags are refused
    expect(() => splitProdArgs(['file', '--i-mean-production', '--target', 'live:x'])).toThrow(/only apply together/)
  })
})
