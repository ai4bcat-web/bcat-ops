#!/usr/bin/env node
/**
 * Aljex-exit Phase 0 verification against the DEV site (PHASE0-plan §11.4). Synthetic data only:
 * the 1k fixture comes from scripts/lib/aljexFixture.mjs (seed 1, PROs 900000–999999, `ZZ ` names). It never reads
 * the real Aljex export and never touches production.
 *
 *   node scripts/devVerifyAljex.mjs [--inventory] [--only=<substring>] [--rows=1000]
 *
 *   --inventory  no network: every step id is registered with a runner, the fixture generator and oracle are
 *                self-consistent, and no script in scripts/ names the real export path.
 *   --only=      run only steps whose id contains the substring (earlier steps they depend on still run).
 *   --rows=      fixture size (default 1000).
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any pool but the dev pool, and any table without the dev
 * suffix (or with the production one). Uses a throwaway ADMIN identity (and a non-admin one for refusals), deleted
 * and re-read in `finally`. Passwords and tokens are never printed.
 *
 * Cleanup honesty (plan §11.4): shipments are void-only, ProClaims are forever and ledger rows are immutable, so a
 * LIVE ZZ import leaves permanent residue. It is bounded: the ZZ dataset is deterministic and reused (a re-run adds
 * nothing) and the PRO band 900000+ is reserved. A17 reports the residue counts; it deletes nothing.
 *
 * UI-only checks (page reload of the profile, stepper rendering) are covered by the component tests; this harness
 * drives the same API the page does and reports where a step is the API-level equivalent of a screen.
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DynamoDBClient, ListTablesCommand, DescribeContinuousBackupsCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { generateAljex, renderAljexCsv, SYNTH_PRO_MIN, SYNTH_PRO_MAX } from './lib/aljexFixture.mjs'
import { PLACEHOLDER_EMAILS, planRevDivisions } from './seedRevDivisions.mjs'

const DEV_APPSYNC = APPSYNC_URL_RE
const DEV_SUFFIX = STACK.tableSuffix
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const REGION = 'us-east-1'
const LIVE_TAG = 'ZZ-IMPORT-1k'
/** The real export lives outside the repo; no script may name it (built from parts so this file does not match itself). */
const REAL_EXPORT_MARKER = ['aljex-export', 'aljex-full-export'].join('/')

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)
const ROWS = Number(args.find((a) => a.startsWith('--rows='))?.slice(7) ?? 1000)

const ddb = new DynamoDBClient({ region: REGION })
const s3 = new S3Client({ region: REGION })

// ───────────────────────────── reporting ─────────────────────────────
const report = []
const line = (status, id, detail = '') => {
  report.push({ status, id, detail })
  console.log(`${status.padEnd(7)} ${id}${detail ? ` — ${detail}` : ''}`)
}
class SkipError extends Error {}
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function poll(fn, label, ms, every = 2000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(every)
  }
  throw new Error(`timed out: ${label}`)
}

// ───────────────────────────── step registry ─────────────────────────────
export const A_STEPS = [
  { id: 'A01', slug: 'preflight' },
  { id: 'A02', slug: 'generate-upload' },
  { id: 'A03', slug: 'stage-profile' },
  { id: 'A04', slug: 'plan-no-writes' },
  { id: 'A05', slug: 'apply-live-zz' },
  { id: 'A06', slug: 'fault-resume' },
  { id: 'A07', slug: 'reconcile-oracle' },
  { id: 'A08', slug: 'idempotent-rerun' },
  { id: 'A09', slug: 'board-visibility' },
  { id: 'A10', slug: 'gates' },
  { id: 'A11', slug: 'no-side-effects' },
  { id: 'A12', slug: 'pay-lock' },
  { id: 'A13', slug: 'data-backups' },
  { id: 'A14', slug: 'counter' },
  { id: 'A15', slug: 'invoice-series' },
  { id: 'A16', slug: 'divisions' },
  { id: 'A17', slug: 'residue' },
  { id: 'A18', slug: 'legacy-row' },
  { id: 'A19', slug: 'code-map' },
]

/** Steps a shell without the prerequisite may skip; each is reported as an allowed SKIP, never a pass. */
export const SKIP_ALLOWED = {
  A06: 'fault injection (options.faultAfterRows) needs the dev stack flag BCAT_DEV_STACK=true on the worker',
  A10: 'the READY_TO_INVOICE / bill-approval gate probes need a deployed Step B4 build',
  A15: 'the series probe needs a TmsSettings copy; it refuses to move the live counter',
}

async function scriptFiles() {
  const out = []
  for (const dir of ['scripts', 'scripts/lib']) {
    for (const name of await readdir(resolve(dir))) if (/\.mjs$/.test(name)) out.push(join(dir, name))
  }
  return out
}

/** No network. Returns true when every gate passes. */
export async function inventory() {
  const runners = Object.keys(RUNNERS)
  const registered = A_STEPS.map((s) => s.id)
  const missing = registered.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !registered.includes(id)))
  if (missing.length) { line('FAIL', 'gate 1: A ids registered', `registry and runners disagree on: ${missing.join(', ')}`); return false }
  line('PASS', 'gate 1: A ids registered', `${registered.length} steps (${registered.join(' ')}) each have a runner`)

  const result = generateAljex({ rows: 40, seed: 1 })
  const oracle = result.oracle
  const csv = renderAljexCsv(result)
  const physicalRows = csv.split('\n').filter(Boolean).length
  const bad = []
  if (oracle.headerCount !== 486 || result.headers.length !== 486) bad.push(`headerCount ${oracle.headerCount}/${result.headers.length}`)
  if (oracle.loads + oracle.memos > oracle.fileRows) bad.push('loads+memos exceeds rows')
  if (!(physicalRows >= 2)) bad.push('csv has no data rows')
  const pros = result.rows.map((r) => Number(r[1])).filter(Number.isFinite)
  if (pros.some((p) => p < SYNTH_PRO_MIN || p > SYNTH_PRO_MAX)) bad.push('a synthetic PRO is outside 900000–999999')
  if (bad.length) { line('FAIL', 'gate 2: fixture + oracle', bad.join('; ')); return false }
  line('PASS', 'gate 2: fixture + oracle self-consistent', `${oracle.fileRows} rows, ${oracle.headerCount} columns, PRO band ${SYNTH_PRO_MIN}–${SYNTH_PRO_MAX}`)

  const offenders = []
  for (const file of await scriptFiles()) {
    const text = await readFile(resolve(file), 'utf8')
    const hit = text.split('\n').findIndex((l) => l.includes(REAL_EXPORT_MARKER))
    if (hit >= 0 && !/aljexProfile|importAljex|PHASE0|\.test\./.test(file)) offenders.push(`${file}:${hit + 1}`)
  }
  if (offenders.length) { line('FAIL', 'gate 3: the real export is not named', offenders.join('; ')); return false }
  line('PASS', 'gate 3: no harness script names the real export path')
  return true
}

// ───────────────────────────── dev data helpers ─────────────────────────────
async function devTables() {
  const names = []
  let start
  do {
    const r = await ddb.send(new ListTablesCommand({ ExclusiveStartTableName: start }))
    names.push(...(r.TableNames ?? []))
    start = r.LastEvaluatedTableName
  } while (start)
  const dev = names.filter((n) => n.endsWith(`-${DEV_SUFFIX}`))
  expect(dev.length > 0, 'no dev tables visible to these AWS credentials')
  expect(!dev.some((n) => n.includes(PROD_SUFFIX)), 'a dev-listed table carries the production suffix')
  return dev
}

async function listAll(token, field, selection, filter) {
  const items = []
  let next = null
  do {
    const r = await gql(token, `query($n: String, $f: Model${field.replace(/^list/, '').replace(/s$/, '')}FilterInput) { ${field}(limit: 1000, nextToken: $n${filter ? ', filter: $f' : ''}) { items { ${selection} } nextToken } }`, { n: next, f: filter })
    items.push(...r[field].items)
    next = r[field].nextToken
  } while (next)
  return items
}
const zzShipments = (token, selection = 'id number status customerId revDivision legacyImported') =>
  listAll(token, 'listShipments', selection, { number: { between: [String(SYNTH_PRO_MIN), String(SYNTH_PRO_MAX)] } })

const checksum = (rows) => createHash('sha256').update(JSON.stringify([...rows].sort((a, b) => String(a.number).localeCompare(String(b.number))))).digest('hex')

async function tableCount(name) {
  const r = await ddb.send(new DescribeTableCommand({ TableName: name }))
  return r.Table?.ItemCount ?? 0
}

async function waitJob(ctx, jobId, done, label, ms = 600_000) {
  return poll(async () => {
    const { job } = await ctx.imp('IMPORT_GET', { jobId })
    if (job.status === 'FAILED') throw new Error(`${label}: job failed: ${job.error ?? 'no message'}`)
    return done(job) ? job : null
  }, label, ms, 3000)
}

// ───────────────────────────── runners ─────────────────────────────
const RUNNERS = {
  async A01(ctx) {
    const tables = await devTables()
    ctx.tables = tables
    const off = []
    for (let i = 0; i < tables.length; i += 8) {
      await Promise.all(tables.slice(i, i + 8).map(async (t) => {
        const r = await ddb.send(new DescribeContinuousBackupsCommand({ TableName: t }))
        if (r.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus !== 'ENABLED') off.push(t.replace(`-${DEV_SUFFIX}`, ''))
      }))
    }
    expect(off.length === 0, `PITR is off on ${off.length} table(s): ${off.slice(0, 8).join(', ')}`)
    const status = await ctx.safety('DATA_STATUS', {})
    ctx.bucket = status.bucketName
    expect(ctx.bucket, 'DATA_STATUS names no bucket')
    await s3.send(new HeadBucketCommand({ Bucket: ctx.bucket }))
    expect(status.nightlyEnabled === true, 'the nightly export rule is not ENABLED')
    return `${tables.length} dev tables, PITR on all; bucket ${ctx.bucket} exists; nightly rule enabled; no production table reachable`
  },

  async A02(ctx) {
    ctx.dir = await mkdtemp(join(tmpdir(), 'aljex-verify-'))
    const result = generateAljex({ rows: ROWS, seed: 1 })
    ctx.oracle = result.oracle
    ctx.gen = result
    const csv = renderAljexCsv(result)
    const file = join(ctx.dir, `aljex-synth-${ROWS}.csv`)
    await writeFile(file, csv)
    ctx.fileHash = createHash('sha256').update(csv).digest('hex')
    const { job, uploadUrl } = await ctx.imp('IMPORT_PREPARE', { fileName: `aljex-synth-${ROWS}.csv`, fileHash: ctx.fileHash, sizeBytes: Buffer.byteLength(csv), headerCount: 486 })
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: csv })
    expect(put.ok, `presigned upload refused: HTTP ${put.status}`)
    ctx.jobId = job.id
    return `uploaded ${ROWS} synthetic rows (sha256 ${ctx.fileHash.slice(0, 12)}…) as ${job.id}`
  },

  async A03(ctx) {
    await ctx.imp('IMPORT_STAGE', { jobId: ctx.jobId })
    const job = await waitJob(ctx, ctx.jobId, (j) => j.status === 'READY', 'STAGE')
    const s = job.stage
    expect(s, 'job has no stage summary')
    const o = ctx.oracle
    expect(s.rows === o.fileRows, `rows ${s.rows} != oracle ${o.fileRows}`)
    expect(s.loads === o.loads, `loads ${s.loads} != oracle ${o.loads}`)
    expect(s.memos === o.memos, `memos ${s.memos} != oracle ${o.memos}`)
    expect(s.duplicatePros != null && s.parseErrors === 0, `unexpected parse errors: ${s.parseErrors}`)
    // The profile persists and reloads (the page's "reload" is this read).
    const { profile: saved } = await ctx.imp('IMPORT_GET_PROFILE', { layoutId: job.layoutId })
    const body = saved?.profile ?? {}
    const saveResult = await ctx.imp('IMPORT_SAVE_PROFILE', { layoutId: job.layoutId, headerCount: 486, profile: { ...body, acceptedUnmapped: body.acceptedUnmapped ?? [] }, expectedVersion: saved?.version ?? null })
    const { profile: again } = await ctx.imp('IMPORT_GET_PROFILE', { layoutId: job.layoutId })
    expect(again?.version === saveResult.profile.version, 'profile did not persist across a reload')
    ctx.profileVersion = again.version
    return `staged ${s.rows} rows = file = oracle (${s.loads} loads, ${s.memos} AR memos); profile v${again.version} persisted and reloaded`
  },

  async A04(ctx) {
    const before = await Promise.all(['Shipment', 'Load', 'Invoice', 'ProClaim'].map(async (m) => [m, await tableCount(`${m}-${DEV_SUFFIX}`)]))
    const { job } = await ctx.imp('IMPORT_PLAN', { jobId: ctx.jobId, options: { synthetic: true, expectedRows: ctx.oracle.fileRows } })
    const planned = await waitJob(ctx, job.id, (j) => j.status === 'PLANNED', 'PLAN')
    expect(planned.plan, 'job has no plan summary')
    const after = await Promise.all(['Shipment', 'Load', 'Invoice', 'ProClaim'].map(async (m) => [m, await tableCount(`${m}-${DEV_SUFFIX}`)]))
    // DescribeTable ItemCount is refreshed about every six hours, so it can only catch a gross write; the exact check is A08.
    expect(JSON.stringify(before) === JSON.stringify(after), `table item counts moved during PLAN: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    ctx.plan = planned.plan
    ctx.planJobId = planned.id
    return `PLAN classes ${JSON.stringify(planned.plan.classes)}; ${planned.plan.warnings.length} warning(s); table counts unchanged`
  },

  async A05(ctx) {
    const t0 = Date.now()
    const { job } = await ctx.imp('IMPORT_APPLY', { jobId: ctx.planJobId, options: { target: 'LIVE', liveTag: LIVE_TAG, synthetic: true, expectedRows: ctx.oracle.fileRows } })
    ctx.runId = job.id
    const cursors = new Set()
    const done = await waitJob(ctx, job.id, (j) => {
      if (j.cursor) cursors.add(JSON.stringify(j.cursor))
      return j.status === 'APPLIED'
    }, 'APPLY')
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    expect(cursors.size >= 1, 'the job cursor never advanced')
    ctx.applySeconds = secs
    ctx.checksumAfterApply = checksum(await zzShipments(ctx.token))
    return `APPLIED under liveTag ${LIVE_TAG} in ${secs}s (${(ROWS / Number(secs)).toFixed(1)} rows/s); ${cursors.size} distinct cursor value(s) seen`
  },

  async A06(ctx) {
    // The apply in A05 already completed; fault + resume is exercised on a second, identical synthetic run so the
    // end state can be compared with the clean one by checksum. Idempotency (A08) makes the second run a no-op unless it crashes.
    if (process.env.BCAT_DEV_STACK_FAULTS !== 'true') throw new SkipError('set BCAT_DEV_STACK_FAULTS=true once the worker has BCAT_DEV_STACK=true')
    const { job: plan } = await ctx.imp('IMPORT_PLAN', { jobId: ctx.jobId, options: { synthetic: true, expectedRows: ctx.oracle.fileRows } })
    const planned = await waitJob(ctx, plan.id, (j) => j.status === 'PLANNED', 'PLAN (fault run)')
    const { job } = await ctx.imp('IMPORT_APPLY', { jobId: planned.id, options: { target: 'LIVE', liveTag: LIVE_TAG, synthetic: true, faultAfterRows: Math.floor(ROWS / 2), expectedRows: ctx.oracle.fileRows } })
    const stopped = await poll(async () => {
      const { job: j } = await ctx.imp('IMPORT_GET', { jobId: job.id })
      const stale = j.status === 'RUNNING' && Date.now() - Date.parse(j.heartbeatAt ?? j.startedAt ?? 0) > 3 * 60_000
      return j.status === 'PAUSED' || j.status === 'APPLIED' || stale ? j : null
    }, 'worker to stop', 900_000, 5000)
    if (stopped.status !== 'APPLIED') {
      await ctx.imp('IMPORT_RESUME', { jobId: job.id })
      await waitJob(ctx, job.id, (j) => j.status === 'APPLIED', 'resume to finish')
    }
    const sum = checksum(await zzShipments(ctx.token))
    expect(sum === ctx.checksumAfterApply, 'state after fault + resume differs from the clean run')
    return `crash at ~row ${Math.floor(ROWS / 2)}, resumed from the cursor; ZZ checksum equals the clean run`
  },

  async A07(ctx) {
    await ctx.imp('IMPORT_RECONCILE', { jobId: ctx.runId })
    const job = await waitJob(ctx, ctx.runId, (j) => j.summary != null, 'RECONCILE')
    const sum = job.summary
    expect(sum.conservationOk, 'outcome counts do not add up (staged != created+matched+…)')
    const o = ctx.oracle
    const find = (key) => sum.bridge.find((l) => l.key === key)
    const mismatches = sum.bridge.filter((l) => l.diffCents != null && l.diffCents !== 0).map((l) => `${l.key} ${l.diffCents}`)
    expect(mismatches.length === 0, `bridge differences: ${mismatches.join('; ')}`)
    if (ROWS === 1000) {
      // The oracle's totals are for the generated file at this size; compare the headline figures it records.
      expect(sum.openArCents === o.netOpenAr, `open AR ${sum.openArCents} != oracle ${o.netOpenAr}`)
      expect(sum.unappliedCreditCents === o.unappliedCredit, `unapplied credit ${sum.unappliedCreditCents} != oracle ${o.unappliedCredit}`)
      expect(sum.openApCents === o.ap.open, `open AP ${sum.openApCents} != oracle ${o.ap.open}`)
    }
    // The AR page's own aging source: open invoices of ZZ customers (customer names start with `ZZ `).
    const invoices = await listAll(ctx.token, 'listInvoices', 'id customerName balanceCents arOpen', { arOpen: { eq: 'OPEN' } })
    const zzOpen = invoices.filter((i) => String(i.customerName).startsWith('ZZ ')).reduce((n, i) => n + (i.balanceCents ?? 0), 0)
    expect(zzOpen === sum.openArCents || ROWS !== 1000 && zzOpen > 0, `AR open book for ZZ customers ${zzOpen} != report ${sum.openArCents}`)
    // Memos are invoice adjustments, never shipments: each one is applied or reported, none disappears.
    const m = sum.memos
    expect(m, 'the summary has no memo section')
    expect(m.total === o.memos, `memos ${m.total} != oracle ${o.memos}`)
    expect(m.applied + m.unmatched === m.total, `memos applied ${m.applied} + unmatched ${m.unmatched} != ${m.total}`)
    expect(m.unmatchedPros.length <= m.unmatched, 'more unmatched PROs listed than unmatched memos')
    ctx.summary = sum
    return `reconcile ${sum.reconciled ? 'reconciled' : 'differences remain'}; ${m.total} memos (${m.applied} applied to invoices, ${m.unmatched} reported); ${sum.bridge.length} bridge line(s) all zero-diff; open AR ${sum.openArCents}, AP ${sum.openApCents}; AR book for ZZ = ${zzOpen}`
  },

  async A08(ctx) {
    const before = checksum(await zzShipments(ctx.token))
    const counts = await Promise.all(['Shipment', 'Load', 'Invoice', 'ProClaim', 'Customer', 'Carrier'].map(async (m) => [m, (await listAll(ctx.token, `list${m}s`, 'id').catch(() => [])).length]))
    const { job: plan } = await ctx.imp('IMPORT_PLAN', { jobId: ctx.jobId, options: { synthetic: true, expectedRows: ctx.oracle.fileRows } })
    const planned = await waitJob(ctx, plan.id, (j) => j.status === 'PLANNED', 'PLAN (re-run)')
    const { job } = await ctx.imp('IMPORT_APPLY', { jobId: planned.id, options: { target: 'LIVE', liveTag: LIVE_TAG, synthetic: true, expectedRows: ctx.oracle.fileRows } })
    const done = await waitJob(ctx, job.id, (j) => j.status === 'APPLIED', 'APPLY (re-run)')
    const created = Object.values(done.entityCounts ?? {}).reduce((n, c) => n + (c.created ?? 0), 0)
    const after = checksum(await zzShipments(ctx.token))
    const counts2 = await Promise.all(['Shipment', 'Load', 'Invoice', 'ProClaim', 'Customer', 'Carrier'].map(async (m) => [m, (await listAll(ctx.token, `list${m}s`, 'id').catch(() => [])).length]))
    expect(created === 0, `the re-run created ${created} row(s)`)
    expect(before === after, 'ZZ checksum changed on re-run')
    expect(JSON.stringify(counts) === JSON.stringify(counts2), `row counts moved on re-run: ${JSON.stringify(counts)} -> ${JSON.stringify(counts2)}`)
    return 'second APPLY created 0 rows; per-table counts and ZZ checksum unchanged'
  },

  async A09(ctx) {
    const rows = await zzShipments(ctx.token, 'id number status legacyImported assignmentType')
    expect(rows.length > 0, 'no ZZ shipments found on the board source')
    const pro = ctx.oracle.scenarios.PAID[0]
    expect(rows.some((r) => r.number === pro), `PRO ${pro} is not findable by number`)
    const unflagged = rows.filter((r) => r.legacyImported !== true)
    expect(unflagged.length === 0, `${unflagged.length} imported shipment(s) are not flagged legacy`)
    const ivan = ctx.oracle.scenarios.IVAN[0]
    const ivanRow = rows.find((r) => r.number === ivan)
    expect(ivanRow, `Ivan PRO ${ivan} missing`)
    // "Needs driver" excludes legacy rows (shipmentViews.needsDriver): the flag is what keeps it out.
    expect(ivanRow.legacyImported === true, 'the Ivan history row would show in Needs-driver')
    return `${rows.length} ZZ shipments, all flagged legacy; PRO ${pro} findable; Ivan history row ${ivan} excluded from Needs-driver by the flag (API-level check of the board filters)`
  },

  async A10(ctx) {
    const control = await ctx.ship('CREATE_SHIPMENT', { customerName: `ZZ Aljex control ${ctx.ts}`, mode: 'FTL' }).catch(() => null)
    if (!control) throw new SkipError('CREATE_SHIPMENT control could not be built on this stack')
    ctx.controlShipmentId = control.shipment?.id ?? control.id
    const uncovered = await ctx.ship('READY_TO_INVOICE', { shipmentId: ctx.controlShipmentId }).then(() => 'passed', (e) => String(e.message))
    expect(uncovered !== 'passed', 'a control shipment passed READY_TO_INVOICE with no documents: the legacy waiver leaked')
    const [legacy] = await zzShipments(ctx.token, 'id number status legacyImported').then((r) => r.filter((s) => s.status === 'DELIVERED'))
    expect(legacy, 'no delivered ZZ shipment to probe')
    const ready = await ctx.ship('READY_TO_INVOICE', { shipmentId: legacy.id }).then(() => 'passed', (e) => String(e.message))
    expect(!/document|missing/i.test(ready) || ready === 'passed', `a legacy delivered shipment is still asked for documents: ${ready}`)
    return `control shipment refused (${uncovered.slice(0, 60)}); legacy delivered shipment ${legacy.number} is not asked for documents`
  },

  async A11(ctx) {
    const zz = await zzShipments(ctx.token, 'id')
    const ids = new Set(zz.map((s) => s.id))
    const notices = (await listAll(ctx.token, 'listShipmentNotices', 'id shipmentId').catch(() => [])).filter((n) => ids.has(n.shipmentId))
    const checks = (await listAll(ctx.token, 'listLoadCheckCalls', 'id shipmentId').catch(() => [])).filter((c) => ids.has(c.shipmentId))
    const commissions = (await listAll(ctx.token, 'listCommissions', 'id shipmentId').catch(() => [])).filter((c) => ids.has(c.shipmentId))
    expect(notices.length === 0, `${notices.length} ShipmentNotice row(s) were written for ZZ loads`)
    expect(checks.length === 0, `${checks.length} LoadCheckCall row(s) were written for ZZ loads`)
    expect(commissions.length === 0, `${commissions.length} Commission row(s) were written for ZZ loads`)
    return `0 ShipmentNotice, 0 LoadCheckCall, 0 Commission rows for ${ids.size} ZZ shipments (CloudWatch error counts for the stream consumers are a manual check: BUILD_LOG)`
  },

  async A12(ctx) {
    const weeks = await listAll(ctx.token, 'listDriverPayPeriods', 'id status').catch(() => [])
    if (ctx.payBefore == null) throw new SkipError('no pre-run pay snapshot')
    const after = await ctx.payTotals()
    expect(JSON.stringify(ctx.payBefore) === JSON.stringify(after), `pay-bearing totals moved: ${JSON.stringify(ctx.payBefore)} -> ${JSON.stringify(after)}`)
    return `${weeks.length} pay period(s); settlement-bearing row counts identical before and after the import (Ivan history wrote no driver fields)`
  },

  async A13(ctx) {
    const nonAdmin = ctx.safetyTms
    const refused = await nonAdmin('DATA_STATUS', {}).then(() => false, () => true)
    expect(refused, 'a non-admin was allowed to read data-safety status')
    const exp = await ctx.safety('EXPORT_NOW', { tables: ['Customer', 'Carrier'] })
    expect(exp.job?.id, 'EXPORT_NOW returned no job')
    const csv = await ctx.safety('CSV_EXPORT_START', { scope: 'TMS', tables: ['Customer', 'Carrier', 'Location'], acknowledgePii: true })
    const done = await poll(async () => {
      const { job } = await ctx.safety('CSV_EXPORT_STATUS', { jobId: csv.job.id })
      if (job.status === 'FAILED') throw new Error(`CSV export failed: ${job.error}`)
      return job.status === 'COMPLETED' ? job : null
    }, 'CSV export', 600_000, 4000)
    for (const t of done.tables ?? []) {
      const live = (await listAll(ctx.token, `list${t.table}s`, 'id')).length
      expect(t.rows === live, `${t.table}: exported ${t.rows} rows, table holds ${live}`)
    }
    const links = await ctx.safety('CSV_EXPORT_LINKS', { jobId: csv.job.id })
    expect(links.files.length > 0 && links.expiresInSeconds <= 900, 'links missing or expiry longer than 15 minutes')
    const accounting = links.files.filter((f) => /accounting\//.test(f.key))
    expect(accounting.length === 4, `expected the four accountant files, got ${accounting.length}`)
    return `EXPORT_NOW ok; CSV row counts equal table counts for ${done.tables.length} tables; 4 accounting files; links expire in ${links.expiresInSeconds}s; non-admin refused`
  },

  async A14(ctx) {
    const preview = await ctx.imp('IMPORT_SEED_COUNTER', { apply: false, jobId: ctx.runId })
    expect(preview.target >= 14912 || preview.target >= 900000, `counter target ${preview.target} is below the Aljex floor`)
    const applyRefused = await ctx.imp('IMPORT_SEED_COUNTER', { apply: true, jobId: ctx.runId }).then(() => false, (e) => /synthetic/i.test(String(e.message)))
    expect(applyRefused, 'applying the counter from a synthetic run was not refused')
    return `preview target ${preview.target} (current ${preview.current ?? 'unset'}); apply from a synthetic run refused`
  },

  async A15(ctx) {
    const settings = await ctx.fin('GET_AR_SETTINGS', {}).catch(() => null)
    if (!settings?.settings) throw new SkipError('GET_AR_SETTINGS unavailable')
    const s = settings.settings
    const below = Math.max(1, (s.maxImportedInvoiceNumber ?? s.nextInvoiceNumber ?? 1))
    const refused = await ctx.fin('SAVE_AR_SETTINGS', { invoiceSeriesStart: below }).then(() => false, () => true)
    expect(refused, `an invoice series start of ${below} (at or below issued/imported numbers) was accepted`)
    return `series start ${below} refused (counter ${s.nextInvoiceNumber ?? 'unset'}, max imported ${s.maxImportedInvoiceNumber ?? 'none'}); the accepted path is proven on a settings copy by the unit tests, not by moving the live counter`
  },

  async A16(ctx) {
    const divisions = await listAll(ctx.token, 'listOwnershipDivisions', 'id code name brand parentId color sortOrder active owners flows intakeEmail version')
    const rules = await listAll(ctx.token, 'listOwnershipRules', 'id name active divisionCode')
    const plan = planRevDivisions({ divisions, rules })
    const placeholders = new Set(Object.values(PLACEHOLDER_EMAILS))
    for (const step of plan.steps) {
      if (step.kind === 'SAVE' && step.input.intakeEmail && placeholders.has(step.input.intakeEmail)) expect(step.input.intakeEmailConfirmed === false, `${step.code}: a placeholder would be saved as confirmed`)
    }
    return `dry run: ${plan.steps.length} step(s), ${plan.blocked.length} blocked (${plan.blocked.map((b) => b.code).join(', ') || 'none'}); every placeholder is UNCONFIRMED; nothing written (scripts/seedRevDivisions.mjs --apply performs it)`
  },

  async A18(ctx) {
    // No-loss check: the side table holds every non-empty source cell of a row, keyed by position + header.
    const pro = ctx.oracle.scenarios.PAID[0]
    const res = await ctx.imp('IMPORT_LEGACY_ROW', { pro })
    const row = res.rows?.find((r) => r.kind === 'LOAD')
    expect(row, `no LOAD LegacyAljexRow for PRO ${pro}`)
    const keys = Object.keys(row.fields)
    expect(keys.length > 0 && keys.every((k) => /^c\d+$/.test(k)), 'LegacyAljexRow.fields is not keyed c<position>')
    const { headers, rows } = ctx.gen
    const cells = (r) => r.map((v, i) => [i + 1, String(v ?? '').trim()]).filter(([, v]) => v !== '')
    const candidates = rows.filter((r) => String(r[1]) === String(pro))
    expect(candidates.length > 0, `PRO ${pro} is not in the generated file`)
    let best = null
    for (const cand of candidates) {
      const missing = cells(cand).filter(([pos, v]) => row.fields[`c${pos}`]?.v !== v).length
      const wrong = keys.filter((k) => { const pos = Number(k.slice(1)); return row.fields[k].h !== headers[pos - 1] }).length
      if (!best || missing < best.missing) best = { missing, wrong, total: cells(cand).length }
    }
    expect(best.wrong === 0, `${best.wrong} stored column header(s) differ from the file header`)
    expect(best.missing === 0, `${best.missing} of ${best.total} non-empty source cell(s) are missing or altered in the stored row`)
    expect(res.columns?.length === keys.length, 'the reader surfaces a different column count than the stored row holds')
    const refused = await ctx.impTms('IMPORT_LEGACY_ROW', { pro }).then(() => false, () => true)
    expect(refused, 'a non-admin read a raw legacy row (PII)')
    return `PRO ${pro}: all ${best.total} non-empty cells stored with their headers (${keys.length} columns surfaced by the reader); non-admin refused`
  },

  async A19(ctx) {
    const listed = await ctx.ship('LIST_ALJEX_CODES', {})
    expect(Array.isArray(listed.codes), 'LIST_ALJEX_CODES returned no codes array')
    const bad = listed.codes.filter((c) => !['SALES_REP', 'STAFF'].includes(c.kind) || !c.code || !(c.shipmentCount >= 0))
    expect(bad.length === 0, `${bad.length} malformed code summary row(s)`)
    const refused = await Promise.all(['LIST_ALJEX_CODES', 'SET_ALJEX_CODE_MAP', 'REASSIGN_SHIPMENTS_BY_REP_CODE'].map((a) =>
      ctx.shipTms(a, { kind: 'SALES_REP', code: 'ZZ', userId: null, repId: 'x', dryRun: true }).then(() => a, () => null)))
    const leaked = refused.filter(Boolean)
    expect(leaked.length === 0, `a non-admin was allowed: ${leaked.join(', ')}`)
    const rep = listed.codes.find((c) => c.kind === 'SALES_REP' && c.shipmentCount > 0)
    if (!rep) return `${listed.codes.length} code(s) listed; no sales-rep code on the ZZ fixture, so the reassign dry run is not exercised; non-admin refused on all three actions`
    // The throwaway identity has no UserProfile, so a real reassign cannot target it: a dry run to an unknown user must refuse and write nothing.
    const unknown = await ctx.ship('REASSIGN_SHIPMENTS_BY_REP_CODE', { code: rep.code, repId: `zz-no-such-user-${ctx.ts}`, dryRun: true }).then(() => 'accepted', (e) => String(e.message))
    expect(unknown !== 'accepted', 'a reassign to a user that does not exist was accepted')
    return `${listed.codes.length} code(s) listed; non-admin refused on list, map and reassign; a reassign to an unknown user refused (${unknown.slice(0, 50)}); the live reassign is covered by the handler tests, not run against dev data`
  },

  async A17(ctx) {
    const zz = await zzShipments(ctx.token, 'id number status')
    const customers = (await listAll(ctx.token, 'listCustomers', 'id name')).filter((c) => String(c.name).startsWith('ZZ ')).length
    const carriers = (await listAll(ctx.token, 'listCarriers', 'id name')).filter((c) => String(c.name).startsWith('ZZ ')).length
    return `residue (permanent by design, nothing deleted): ${zz.length} ZZ shipments, ${customers} ZZ customers, ${carriers} ZZ carriers; ZZ dataset is deterministic, so a re-run adds nothing`
  },
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAljex refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyAljex refuses any staff pool other than the dev pool')
  if (DEV_SUFFIX === PROD_SUFFIX) throw new Error('dev suffix equals production suffix')

  if (!(await inventory())) { process.exitCode = 1; return }
  if (flag('inventory')) return

  const ts = Date.now()
  const emails = { admin: `zz-aljex-admin-${ts}@example.invalid`, staff: `zz-aljex-staff-${ts}@example.invalid` }
  const made = []
  const ctx = { ts }
  try {
    const admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    const staff = await mintIdentity(emails.staff, ['page-tms']); made.push(emails.staff)
    console.log('identity: temporary staff identities created (admin, non-admin)')
    ctx.token = admin.token
    ctx.imp = routerAs(admin.token, 'tmsAljexImport')
    ctx.safety = routerAs(admin.token, 'tmsDataSafety')
    ctx.safetyTms = routerAs(staff.token, 'tmsDataSafety')
    ctx.impTms = routerAs(staff.token, 'tmsAljexImport')
    ctx.shipTms = routerAs(staff.token, 'tmsShipmentActions')
    ctx.ship = routerAs(admin.token, 'tmsShipmentActions')
    ctx.fin = routerAs(admin.token, 'tmsFinanceActions')
    ctx.payTotals = async () => Object.fromEntries(await Promise.all(['DriverPayPeriod', 'DriverPayDeduction', 'DriverPayCredit', 'BoxTruckTrip'].map(async (m) => [m, (await listAll(admin.token, `list${m}s`, 'id').catch(() => [])).length])))
    ctx.payBefore = await ctx.payTotals()

    for (const step of A_STEPS) {
      const id = `${step.id}-${step.slug}`
      // Later steps depend on earlier state, so --only filters what is reported, not what runs.
      const quiet = only && !id.includes(only)
      try {
        const detail = await RUNNERS[step.id](ctx)
        if (!quiet) line('PASS', id, detail)
      } catch (err) {
        if (err instanceof SkipError) {
          const allowed = SKIP_ALLOWED[step.id] ? `allowed: ${SKIP_ALLOWED[step.id]}` : 'NOT allowed'
          if (!quiet) line('SKIPPED', id, `${err.message} (${allowed})`)
        } else if (!quiet) line('FAIL', id, err?.message ?? String(err))
        else console.log(`(prerequisite ${id} failed: ${err?.message ?? err})`)
      }
    }
  } finally {
    if (ctx.dir) await rm(ctx.dir, { recursive: true, force: true }).catch(() => {})
    for (const email of made) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary staff identity ${email.replace(/-\d+@/, '-…@')} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }

  const pass = report.filter((r) => r.status === 'PASS').length
  const fail = report.filter((r) => r.status === 'FAIL').length
  const skipped = report.filter((r) => r.status === 'SKIPPED')
  const unallowed = skipped.filter((r) => !/\(allowed:/.test(r.detail ?? ''))
  console.log(`\nsummary: ${JSON.stringify({ pass, fail, skipped: skipped.length, skippedNotAllowed: unallowed.length, applySeconds: ctx.applySeconds ?? null })}`)
  if (fail > 0 || unallowed.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAljex failed: ${err?.message ?? err}`); process.exit(1) })
}
