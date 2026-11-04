#!/usr/bin/env node
/**
 * Refresh the DEV stack's operational data from PRODUCTION, safely (Ryne, 2026-11-03: nothing
 * ever goes to production; production is only READ, by `devStack.mjs copy-data|copy-files`).
 *
 *   node scripts/refreshDevFromProd.mjs                        # dry run: plan + before counts (default)
 *   node scripts/refreshDevFromProd.mjs --devstack-dry-run     # + `devStack copy-data --dry-run` (reads prod only)
 *   node scripts/refreshDevFromProd.mjs --apply                # back up, copy-data, copy-files, after counts
 *   node scripts/refreshDevFromProd.mjs --apply --backfills    # ... then the ordered backfills + duplicate check
 *   node scripts/refreshDevFromProd.mjs --backfills-only       # just the backfills + duplicate check
 *
 * Flags: --skip-files (no S3 sync), --tables A,B (a subset of the INCLUDE list), --to <dev suffix>
 * (must be the dev suffix), --summary /tmp/<file>.json. Backfills need BCAT_EMAIL / BCAT_PASSWORD
 * (an ADMIN on the dev pool); the password is never printed.
 *
 * What it will NOT do: write the production suffix anywhere, target any suffix but dev, run while
 * an Amplify job is RUNNING on the dev branch, run with a production table that is neither on the
 * INCLUDE nor the EXCLUDE list (review it first), delete a backup, or write a DynamoDB row itself
 * (the only writes are CreateBackup, devStack's PutRequests into dev tables, and the S3 sync).
 *
 * copy-data semantics (devStack.mjs): Scan prod, BatchWrite PUT into the dev table BY KEY. It
 * deletes nothing, but a PUT REPLACES THE WHOLE ITEM: any dev-only attribute on a row prod also
 * has is lost. Docs/ and the decision table in this file's INCLUDE/EXCLUDE comments record why
 * each table is or is not copied.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { DynamoDBClient, ListTablesCommand, ScanCommand } from '@aws-sdk/client-dynamodb'

const REGION = 'us-east-1'
const APP_ID = 'd3dejqzs77khq6'
const BRANCH = 'dev'
export const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
export const DEV_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'

/**
 * Prod tables that are safe to copy: PUT-by-key either rewrites an identical row, adds a row
 * dev has not seen, or replaces dev state that prod is the truth for. Evidence: scan of both
 * stacks on 2026-11-03 (rows, common ids, attributes only dev has, value diffs).
 *
 * Load is deliberate and the one that needs follow-up: all 891 shared loads lose their dev-only
 * Step B/R link fields (shipmentId orderId leg loadNumber status statusChangedAt/By statusSource
 * assignmentType activeLoadCarrierId pickupMonth revDivision revSubdivision revRuleId revTagSource
 * customerId, and `stops` on 53 loads) and take prod's stops/appts/drivers. BACKFILLS below puts
 * the links back; nothing else on a refreshed load was dev-written for these ids.
 */
export const INCLUDE = [
  'AmazonDispute', 'AmazonPayMaster', 'AmazonTrip', 'BoxTruckTrip',
  'CashCheckIn', 'CashFlowInputs', 'CashFlowWeekLog', 'CashSettings',
  'ComplianceAlert', 'ComplianceDocument', 'ComplianceSettings',
  'Customer', // 116 shared rows carry no dev-only attribute (TMS fields live on the 252 dev-only rows, which stay)
  'DispatchConversation', 'DispatchMessage', 'DocumentSignatureRequest',
  'Driver', 'DriverApplication', 'DriverAvailability', 'DriverLoadTime', 'DriverPayCredit',
  'DriverPayDeduction', 'DriverPayPeriod', 'DriverPaySetting', 'DriverSubmission', 'DriverSubmissionDoc',
  'Equipment', 'EscalationEmailLog', 'EscalationRule', 'ExpenseRecord', 'ExpenseType',
  'FactoringItem', 'FuelTransaction', 'InsuranceLineItem', 'InsurancePeriod', 'IntakeItem',
  'Load', 'Location', 'MaintenanceInvoice', 'MaintenanceTask',
  'OnboardingInvite', 'OnboardingTask', 'OnboardingTemplateConfig',
  'PodDocument', 'PodSenderMapping', 'RecurringExpense', 'TimeClockEntry',
  'TruckConfig', 'TruckExpenseAllocation', 'VendorPayable',
]

/** Prod tables that exist but are NOT copied, with the reason. */
export const EXCLUDE = {
  AuditLog: 'dev audit trail (migration/backfill/verify rows); ~18k prod vs ~35k dev rows, no dedupe value, large',
  TruckLocationHistory: 'Motive telemetry, ~65k rows; dev schedules are disabled so it is not live data; large',
  TruckLocation: 'ids are not stable across stacks (1 of 16 shared): copy would ADD duplicate rows beside dev\'s own',
  TruckMileage: 'ids are not stable across stacks (1 of ~2.3k shared): copy would duplicate telemetry',
  TruckOdometerDay: 'ids are not stable across stacks (1 of ~300 shared): copy would duplicate telemetry',
  TruckFaultCode: 'ids are not stable across stacks (1 of 22 shared): copy would duplicate fault rows',
  TmsSettings: 'dev config (proScheme, invoiceSeriesStart, trackingAutomation, defaultCheckCallPlan...); prod table is empty',
  Division: 'TMS division config; empty in prod, dev is authoritative',
  DirectoryMergeJob: 'job state, empty in prod',
  DispatchSettings: 'dev-neutered config: forwardTo differs on purpose (dev must not forward to prod numbers)',
}

/**
 * Dev-only models (no prod table exists, so devStack cannot touch them). Listed so a future prod
 * table with one of these names is refused rather than silently overwriting dev TMS state.
 */
export const DEV_ONLY_PROTECTED = [
  'AljexImportJob', 'AljexMappingProfile', 'ApPayment', 'ArPayment', 'Carrier', 'CarrierBill',
  'CarrierContact', 'CarrierDocument', 'CarrierPaymentMethod', 'Commission', 'CommissionPayPeriod',
  'CompanyPhone', 'DataExportJob', 'DemoRecord', 'ImportJob', 'IntakeLoad', 'Integration', 'Invoice',
  'LaneRateSample', 'LegacyAljexRow', 'LoadCarrier', 'LoadCharge', 'LoadCheckCall', 'LoadFinancials',
  'Order', 'OwnershipDivision', 'OwnershipRule', 'ProClaim', 'Quote', 'Shipment', 'ShipmentColumnTemplate',
  'ShipmentDocument', 'ShipmentMessage', 'ShipmentNotice', 'ShipmentPosting', 'ShipmentView',
  'TrackingLink', 'UserProfile', 'WorkflowRun',
]

/**
 * Backfills to run after the Load refresh, in this order (each depends on the last):
 *  1 proClaims   claim the PROs of loads prod added (41 on 2026-11-03); lists collisions BEFORE a shipment takes the number
 *  2 customers   re-link Load.customerId (lost on every refreshed load); --link-only creates no customer
 *  3 locations   re-link stops[].locationId (lost with the refreshed `stops` JSON)
 *  4 shipments   BACKFILL_SHIPMENT: relink shipmentId/orderId/leg/loadNumber/status/assignmentType/
 *                activeLoadCarrierId/pickupMonth onto the surviving Shipment (voided ones are refused), and
 *                create shipments for loads prod added; re-tags revenue division on each
 *  5 revDivision seed (no-op), retag, sales rep, legacy voids and the void MIRROR onto loads
 *  6 ownAsset    own-fleet loads whose active leg is missing
 *  7 legacyAr    Orders of BACKFILL shipments -> LEGACY AR rung, stamp arStatusChangedAt
 *  8 apOpen      apOpen index key on carrier legs, drop AP rung from own-asset legs
 * `auth` steps sign in with BCAT_EMAIL/BCAT_PASSWORD against the dev pool; `appsync` ones also need --env on apply.
 */
export const BACKFILLS = [
  { name: 'proClaims', script: 'backfillProClaims.mjs', auth: true, args: [], applyArgs: [] },
  { name: 'customers', script: 'backfillCustomers.mjs', auth: true, args: ['--link-only'], applyArgs: ['--env', 'sandbox'] },
  { name: 'locations', script: 'backfillLocations.mjs', auth: true, args: [], applyArgs: ['--env', 'sandbox'] },
  { name: 'shipments', script: 'backfillShipments.mjs', auth: true, args: [], applyArgs: ['--env', 'sandbox'] },
  { name: 'revDivision', script: 'backfillRevDivision.mjs', auth: true, args: [], applyArgs: [] },
  { name: 'ownAssetDrivers', script: 'backfillOwnAssetDrivers.mjs', auth: false, args: [], applyArgs: [] },
  { name: 'legacyAr', script: 'backfillLegacyAr.mjs', auth: false, args: [], applyArgs: [] },
  { name: 'apOpen', script: 'backfillApOpen.mjs', auth: false, args: [], applyArgs: [] },
]

// ── pure parts ───────────────────────────────────────────────────────────────

/**
 * Classify every table that exists in prod and decide what copy-data may touch.
 * @param {{ prodModels: string[], devModels: string[], only?: string[] }} input
 * @returns {{ copy: string[], excluded: {model: string, reason: string}[], unclassified: string[],
 *             missingInDev: string[], notOnIncludeList: string[], protectedHit: string[] }}
 */
export function resolveTables({ prodModels, devModels, only }) {
  const prod = new Set(prodModels)
  const dev = new Set(devModels)
  const include = new Set(INCLUDE)
  const protectedSet = new Set(DEV_ONLY_PROTECTED)
  const notOnIncludeList = (only ?? []).filter((m) => !include.has(m))
  const wanted = only ? only.filter((m) => include.has(m)) : INCLUDE
  const protectedHit = prodModels.filter((m) => protectedSet.has(m)).sort()
  const excluded = prodModels
    .filter((m) => Object.hasOwn(EXCLUDE, m))
    .sort()
    .map((model) => ({ model, reason: EXCLUDE[model] }))
  const unclassified = prodModels
    .filter((m) => !include.has(m) && !Object.hasOwn(EXCLUDE, m))
    .sort()
  const copyable = wanted.filter((m) => prod.has(m) && !protectedSet.has(m))
  return {
    copy: copyable.filter((m) => dev.has(m)),
    excluded,
    unclassified,
    missingInDev: copyable.filter((m) => !dev.has(m)),
    notOnIncludeList,
    protectedHit,
  }
}

/**
 * Hard stops that apply before ANY AWS call that could write.
 * @param {{ to?: string, devSuffixOnAccount?: string[] }} input
 * @returns {string} the dev suffix to use
 */
export function assertDevTarget({ to }) {
  const target = to ?? DEV_SUFFIX
  if (target.includes(PROD_SUFFIX)) throw new Error('refusing to target the production suffix')
  if (target !== DEV_SUFFIX) throw new Error(`refusing target ${target}: only ${DEV_SUFFIX} may be refreshed`)
  return target
}

/** A table about to be backed up or written must be a dev table, never a prod one. */
export function assertWritableTable(table) {
  if (table.endsWith(`-${PROD_SUFFIX}`) || table.includes(PROD_SUFFIX)) throw new Error(`refusing to write production table ${table}`)
  if (!table.endsWith(`-${DEV_SUFFIX}`)) throw new Error(`refusing to write non-dev table ${table}`)
  return table
}

const BUSY_JOB_STATUSES = new Set(['RUNNING', 'PENDING', 'PROVISIONING', 'CANCELLING'])

/**
 * @param {{ jobSummaries?: { jobId?: string, status?: string }[] }} listJobs  `aws amplify list-jobs` JSON
 * @returns {string | null} the reason to refuse, or null when the branch is idle
 */
export function amplifyBusyReason(listJobs) {
  const busy = (listJobs?.jobSummaries ?? []).filter((j) => BUSY_JOB_STATUSES.has(String(j.status)))
  if (!busy.length) return null
  return `Amplify job ${busy.map((j) => `${j.jobId}:${j.status}`).join(', ')} is active on branch ${BRANCH}`
}

/**
 * Before/after/prod counts per table, with the invariants a no-delete PUT copy must satisfy.
 * @param {{ prod: Record<string, number>, devBefore: Record<string, number>, devAfter?: Record<string, number> }} input
 * @returns {{ model: string, prod: number, devBefore: number, devAfter: number | null, delta: number | null, flags: string[] }[]}
 */
export function diffCounts({ prod, devBefore, devAfter }) {
  return Object.keys(devBefore).sort().map((model) => {
    const before = devBefore[model]
    const after = devAfter ? devAfter[model] ?? 0 : null
    const flags = []
    if (after != null) {
      if (after < before) flags.push('SHRANK')
      if (after < (prod[model] ?? 0)) flags.push('SHORT_OF_PROD')
    }
    return { model, prod: prod[model] ?? 0, devBefore: before, devAfter: after, delta: after == null ? null : after - before, flags }
  })
}

/** The first reason a dry-run plan must stop the chain, or null. */
export function planBlocker(name, plan) {
  const collisions = plan?.summary?.collisions
  if (name === 'proClaims' && Number(collisions) > 0) return `${collisions} PRO collision(s) need a person before shipments are backfilled`
  return null
}

export function summaryPathOk(p) {
  return typeof p === 'string' && p.startsWith('/tmp/') && !p.includes('..') && p.endsWith('.json')
}

export function parseArgv(argv) {
  const o = { apply: false, backfills: false, backfillsOnly: false, skipFiles: false, devstackDryRun: false, tables: undefined, to: undefined, summary: undefined, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') o.apply = true
    else if (a === '--backfills') o.backfills = true
    else if (a === '--backfills-only') { o.backfillsOnly = true; o.backfills = true; o.apply = true }
    else if (a === '--skip-files') o.skipFiles = true
    else if (a === '--devstack-dry-run') o.devstackDryRun = true
    else if (a === '--tables') o.tables = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--to') o.to = argv[++i]
    else if (a === '--summary') o.summary = argv[++i]
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (o.backfills && !o.apply) throw new Error('--backfills only runs after --apply (or use --backfills-only)')
  if (o.summary && !summaryPathOk(o.summary)) throw new Error('--summary must be a .json path under /tmp')
  return o
}

/** The exact commands Main runs by hand, in order. */
export function backfillCommands({ outputsPath, planDir }) {
  const lines = []
  for (const b of BACKFILLS) {
    const base = ['node', `scripts/${b.script}`, ...(b.auth ? ['--outputs', outputsPath] : []), ...b.args, '--plan', `${planDir}/${b.name}.json`]
    lines.push({ name: b.name, dryRun: base.join(' '), apply: [...base, '--apply', ...b.applyArgs].join(' ') })
  }
  return lines
}

// ── AWS (impure) ─────────────────────────────────────────────────────────────

const ddb = () => new DynamoDBClient({ region: REGION })

async function listAllTables(client) {
  const names = []
  let last
  do {
    const r = await client.send(new ListTablesCommand({ ExclusiveStartTableName: last, Limit: 100 }))
    names.push(...(r.TableNames ?? []))
    last = r.LastEvaluatedTableName
  } while (last)
  return names
}

/** Read-only: Scan with Select COUNT. The only call made against production tables here. */
async function countTable(client, table) {
  let n = 0
  let key
  do {
    const r = await client.send(new ScanCommand({ TableName: table, Select: 'COUNT', ExclusiveStartKey: key }))
    n += r.Count ?? 0
    key = r.LastEvaluatedKey
  } while (key)
  return n
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

async function countAll(client, models, suffix) {
  const counts = {}
  await mapPool(models, 6, async (m) => { counts[m] = await countTable(client, `${m}-${suffix}`) })
  return counts
}

function aws(args) {
  const r = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`aws ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`)
  return r.stdout
}

function amplifyJobs() {
  return JSON.parse(aws(['amplify', 'list-jobs', '--app-id', APP_ID, '--branch-name', BRANCH, '--max-results', '10', '--region', REGION, '--output', 'json']))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function backupTable(model, stamp) {
  const table = assertWritableTable(`${model}-${DEV_SUFFIX}`)
  for (let attempt = 0; ; attempt++) {
    try {
      const out = JSON.parse(aws(['dynamodb', 'create-backup', '--table-name', table, '--backup-name', `prerefresh-${stamp}-${model}`.slice(0, 200), '--region', REGION, '--output', 'json']))
      return out.BackupDetails.BackupArn
    } catch (e) {
      if (attempt < 6 && /LimitExceeded|Throttl|ResourceInUse/i.test(String(e.message))) { await sleep(5000 * (attempt + 1)); continue }
      throw e
    }
  }
}

async function waitBackup(arn, timeoutMs = 30 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const status = JSON.parse(aws(['dynamodb', 'describe-backup', '--backup-arn', arn, '--region', REGION, '--output', 'json'])).BackupDescription.BackupDetails.BackupStatus
    if (status === 'AVAILABLE') return
    if (status === 'DELETED') throw new Error(`backup ${arn} was deleted`)
    if (Date.now() - t0 > timeoutMs) throw new Error(`backup ${arn} not AVAILABLE after ${timeoutMs / 60000} min (status ${status})`)
    await sleep(10_000)
  }
}

function run(label, command, args, opts = {}) {
  console.log(`\n$ ${label}`)
  const r = spawnSync(command, args, { stdio: 'inherit', ...opts })
  return r.status ?? 1
}

const pad = (v, n) => String(v).padEnd(n)
const num = (v, n) => String(v ?? '-').padStart(n)

function printTable(rows) {
  console.log(`${pad('table', 28)} ${num('prod', 7)} ${num('devBefore', 9)} ${num('devAfter', 9)} ${num('delta', 7)}  flags`)
  for (const r of rows) console.log(`${pad(r.model, 28)} ${num(r.prod, 7)} ${num(r.devBefore, 9)} ${num(r.devAfter, 9)} ${num(r.delta, 7)}  ${r.flags.join(',')}`)
}

function writeSummary(path, summary) {
  writeFileSync(path, JSON.stringify(summary, null, 2))
  console.log(`\nsummary (counts only): ${path}`)
}

const HELP = `usage: node scripts/refreshDevFromProd.mjs [--apply] [--backfills | --backfills-only] [--skip-files] [--tables A,B] [--to ${DEV_SUFFIX}] [--devstack-dry-run] [--summary /tmp/x.json]
Dry run by default. See the header of this file.`

async function main() {
  const opts = parseArgv(process.argv.slice(2))
  if (opts.help) { console.log(HELP); return }
  const devSuffix = assertDevTarget({ to: opts.to })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const workDir = `/tmp/refreshDevFromProd-${stamp}`
  mkdirSync(workDir, { recursive: true })
  const summaryPath = opts.summary ?? `${workDir}/summary.json`
  // The dev pool/AppSync ids (public, not secrets) in the shape the backfill scripts' --outputs expect.
  writeFileSync(`${workDir}/dev-outputs.json`, JSON.stringify((await import('./lib/devIdentity.mjs')).outputs, null, 2))
  const mode = opts.backfillsOnly ? 'backfills-only' : opts.apply ? 'apply' : 'dry-run'
  const summary = { startedAt: new Date().toISOString(), mode, prodSuffix: PROD_SUFFIX, devSuffix, tables: [], backups: [], copyData: null, copyFiles: null, backfills: [], duplicateCheck: null, errors: [] }
  const client = ddb()

  console.log(`refreshDevFromProd  mode=${mode}  prod(read-only)=${PROD_SUFFIX}  dev=${devSuffix}`)

  // Amplify guard: a deploy mid-copy would race the schema and the Lambdas.
  const busy = amplifyBusyReason(amplifyJobs())
  if (busy) {
    console.log(`Amplify: ${busy}`)
    if (opts.apply) { summary.errors.push(busy); writeSummary(summaryPath, summary); throw new Error(`refusing: ${busy}`) }
  } else console.log(`Amplify: no active job on ${BRANCH}`)

  const all = await listAllTables(client)
  const prodModels = all.filter((t) => t.endsWith(`-${PROD_SUFFIX}`)).map((t) => t.slice(0, -(PROD_SUFFIX.length + 1)))
  const devModels = all.filter((t) => t.endsWith(`-${devSuffix}`)).map((t) => t.slice(0, -(devSuffix.length + 1)))
  const plan = resolveTables({ prodModels, devModels, only: opts.tables })

  console.log(`\nINCLUDE (${plan.copy.length}): ${plan.copy.join(' ')}`)
  console.log(`\nEXCLUDE (${plan.excluded.length}):`)
  for (const e of plan.excluded) console.log(`  ${pad(e.model, 24)} ${e.reason}`)
  const problems = []
  if (plan.unclassified.length) problems.push(`prod tables on neither list (classify them first): ${plan.unclassified.join(', ')}`)
  if (plan.notOnIncludeList.length) problems.push(`--tables names not on the INCLUDE list: ${plan.notOnIncludeList.join(', ')}`)
  if (plan.protectedHit.length) problems.push(`prod now has dev-only models (would overwrite TMS state): ${plan.protectedHit.join(', ')}`)
  if (plan.missingInDev.length) problems.push(`INCLUDE tables with no dev table yet: ${plan.missingInDev.join(', ')}`)
  for (const p of problems) console.log(`PROBLEM: ${p}`)
  summary.problems = problems

  if (!opts.backfillsOnly) {
    const mustStop = problems.length > 0 && opts.apply
    const [prod, devBefore] = await Promise.all([countAll(client, plan.copy, PROD_SUFFIX), countAll(client, plan.copy, devSuffix)])
    let rows = diffCounts({ prod, devBefore })
    console.log('\nBEFORE counts (rows):'); printTable(rows)
    summary.tables = rows
    if (mustStop) { summary.errors.push(...problems); writeSummary(summaryPath, summary); throw new Error('refusing to apply with unresolved PROBLEM lines above') }

    const toStack = ['--tables', plan.copy.join(','), '--to', devSuffix]
    if (!opts.apply) {
      if (opts.devstackDryRun) summary.copyData = { dryRunExit: run('devStack copy-data --dry-run', 'node', ['scripts/devStack.mjs', 'copy-data', ...toStack, '--dry-run']) }
      console.log(`\nDRY RUN. To apply (back up ${plan.copy.length} dev tables first, then copy):\n  node scripts/refreshDevFromProd.mjs --apply${opts.skipFiles ? ' --skip-files' : ''}`)
      console.log('Backfills that follow (dry-run first, then --apply of the same plan):')
      for (const c of backfillCommands({ outputsPath: `${workDir}/dev-outputs.json`, planDir: workDir })) console.log(`  ${c.name}\n    ${c.dryRun}\n    ${c.apply}`)
      writeSummary(summaryPath, summary)
      return
    }

    // 1. backups of every dev table that holds rows the copy could replace
    const backupModels = plan.copy.filter((m) => devBefore[m] > 0)
    console.log(`\nBacking up ${backupModels.length} non-empty dev tables (on-demand; never deleted by this script)...`)
    const arns = await mapPool(backupModels, 4, async (m) => ({ model: m, arn: await backupTable(m, stamp) }))
    await mapPool(arns, 8, async ({ arn }) => waitBackup(arn))
    for (const b of arns) console.log(`  AVAILABLE ${pad(b.model, 26)} ${b.arn}`)
    summary.backups = arns

    // 2. the copy (prod is only read; devStack pins the prod suffix and refuses --to prod)
    const copyExit = run('devStack copy-data', 'node', ['scripts/devStack.mjs', 'copy-data', ...toStack])
    summary.copyData = { exit: copyExit }
    if (copyExit !== 0) { summary.errors.push(`copy-data exit ${copyExit}`); writeSummary(summaryPath, summary); throw new Error(`copy-data failed (exit ${copyExit}); backups listed above are intact`) }
    if (!opts.skipFiles) {
      const filesExit = run('devStack copy-files', 'node', ['scripts/devStack.mjs', 'copy-files'])
      summary.copyFiles = { exit: filesExit }
      if (filesExit !== 0) summary.errors.push(`copy-files exit ${filesExit}`)
    }

    // 3. after
    const devAfter = await countAll(client, plan.copy, devSuffix)
    rows = diffCounts({ prod, devBefore, devAfter })
    console.log('\nAFTER counts (rows):'); printTable(rows)
    summary.tables = rows
    const bad = rows.filter((r) => r.flags.length)
    if (bad.length) summary.errors.push(`count invariants violated: ${bad.map((r) => `${r.model}[${r.flags.join(',')}]`).join(' ')}`)
  }

  // 4. backfills
  const outputsPath = `${workDir}/dev-outputs.json`
  const commands = backfillCommands({ outputsPath, planDir: workDir })
  if (!opts.backfills) {
    console.log('\nNEXT (run in this order; dry-run first, apply the same plan):')
    for (const c of commands) console.log(`  ${c.name}\n    ${c.dryRun}\n    ${c.apply}`)
    console.log(`\nthen: node scripts/checkDevDuplicates.mjs`)
  } else {
    if (!process.env.BCAT_EMAIL || !process.env.BCAT_PASSWORD) throw new Error('--backfills needs BCAT_EMAIL and BCAT_PASSWORD (ADMIN on the dev pool)')
    for (const [i, b] of BACKFILLS.entries()) {
      const parts = commands[i]
      const [dryCmd, ...dryArgs] = parts.dryRun.split(' ')
      const dryExit = run(`${b.name} dry-run`, dryCmd, dryArgs)
      const entry = { name: b.name, dryRunExit: dryExit, applyExit: null }
      summary.backfills.push(entry)
      if (dryExit !== 0) { summary.errors.push(`${b.name} dry-run exit ${dryExit}`); break }
      let planJson = null
      try { planJson = JSON.parse(readFileSync(`${workDir}/${b.name}.json`, 'utf8')) } catch { /* script without a JSON plan summary */ }
      const block = planBlocker(b.name, planJson)
      if (block) { entry.blocked = block; summary.errors.push(`${b.name}: ${block}`); console.log(`STOP: ${block}`); break }
      const [applyCmd, ...applyArgs] = parts.apply.split(' ')
      entry.applyExit = run(`${b.name} --apply`, applyCmd, applyArgs)
      if (entry.applyExit !== 0) { summary.errors.push(`${b.name} apply exit ${entry.applyExit}`); break }
    }
    const dupExit = run('checkDevDuplicates', 'node', ['scripts/checkDevDuplicates.mjs', '--json', `${workDir}/duplicates.json`])
    summary.duplicateCheck = { exit: dupExit }
    if (dupExit !== 0) summary.errors.push(`duplicate check exit ${dupExit}`)
  }
  summary.finishedAt = new Date().toISOString()
  writeSummary(summaryPath, summary)
  if (summary.errors.length) { console.error(`\n${summary.errors.length} problem(s): ${summary.errors.join(' ; ')}`); process.exitCode = 1 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`\nERROR: ${e?.message ?? e}`); process.exit(1) })
}
