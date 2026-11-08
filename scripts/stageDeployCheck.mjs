/**
 * Proves the staged schema deploy (amplify/data/stages.ts) before anyone runs it.
 *
 * For stage k = 0..final it synthesizes the app exactly like scripts/measureDataTemplate.mjs
 * --prod-shape (a child process with BCAT_SCHEMA_STAGE=k; the final stage runs with it unset),
 * then checks, against the previous stage (stage 0 against the production baseline):
 *   - the GraphQL schema is a strict superset (models, fields and their types, @index, enums)
 *   - created + updated + deleted CloudFormation resources <= 1,500 (the cap is 2,500 per operation)
 *   - nothing is deleted, and in particular no stage ever deletes a DynamoDB table
 *     (Custom::AmplifyDynamoDBTable / AWS::DynamoDB::Table): that is data loss
 *   - no existing table gains more than one GSI
 *   - an existing DynamoDB table changes only in the TTL stage, and the TTL stage changes nothing
 *     but TruckLocationHistory (point-in-time recovery is not a stage: see pitrEnabled in stages.ts)
 *   - the staged-out sentinel never reaches a template
 * and that stage 0 has exactly the baseline's models and indexes (fields may only be added).
 *
 *   node scripts/stageDeployCheck.mjs [--baseline-ref origin/main] [--baseline-outdir DIR]
 *                                     [--stages 0,1,...] [--jobs 1] [--keep]
 *
 * The baseline is a synth of production: by default `git archive <ref>` into a temp dir (with a
 * copy-on-write copy of node_modules) synthesized the same way. Until the GSI prep slice is on
 * main pass `--baseline-ref feat/gsi-prep` (main plus the Load/AuditLog indexes). Nothing touches AWS.
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { tsImport } from 'tsx/esm/api'

import {
  diffTemplates,
  TABLE_TYPES,
  gsiAdditions,
  indexNames,
  parseSchema,
  readModelSchema,
  readTemplates,
  schemaAdditions,
  sentinelLeaks,
  supersetViolations,
} from './stageDelta.mjs'

/**
 * Resources the merge deliberately removes from production at stage 0 (the only deletions allowed):
 * the Load delete mutation and subscription (a PRO is permanent), and the client create/update/delete
 * mutations on TruckLocationHistory (written by Lambdas only). All are API resolvers; no table or data.
 * (The old vendor-ap-extract Lambda is deleted later, at VENDOR_AP_EXTRACT_RETIRED_STAGE.)
 */
const KNOWN_STAGE0_REMOVALS = [
  /(Mutation|Subscription)(delete|Delete|onDelete|OnDelete)Load/,
  /^(Create|Update|Delete)Load$/,
  /(Mutation)(create|update|delete|Create|Update|Delete)TruckLocationHistory/,
  /^(Create|Update|Delete)TruckLocationHistoryResolver$/,
  /^(Delete|OnDelete)LoadResolver$/i,
  /^SubscriptiononDeleteLoadResolver$/,
]
const DELTA_LIMIT = 1500
const SENTINEL = '__BCAT_TABLE_NOT_IN_STAGE__'

const { values } = parseArgs({
  options: {
    'baseline-ref': { type: 'string', default: 'origin/main' },
    'baseline-outdir': { type: 'string' },
    stages: { type: 'string' },
    jobs: { type: 'string', default: '1' },
    keep: { type: 'boolean', default: false },
  },
})

const root = process.cwd()
const stages = await tsImport(pathToFileURL(resolve(root, 'amplify/data/stages.ts')).toString(), import.meta.url)
const { FINAL_STAGE, TTL_STAGE, STAGE_ENV, VENDOR_AP_EXTRACT_RETIRED_STAGE } = stages
const wanted = values.stages ? values.stages.split(',').map(Number) : Array.from({ length: FINAL_STAGE + 1 }, (_, k) => k)

function synth(cwd, stage) {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env }
    delete env[STAGE_ENV]
    if (stage !== null && stage < FINAL_STAGE) env[STAGE_ENV] = String(stage)
    const child = spawn('node', ['scripts/measureDataTemplate.mjs', '--prod-shape'], { cwd, env })
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    child.on('close', () => {
      const outdir = /^outdir:\s+(.+)$/m.exec(text)?.[1]
      if (!outdir) reject(new Error(`synth failed (stage ${stage} in ${cwd}):\n${text.split('\n').slice(-25).join('\n')}`))
      else resolveRun({ outdir, resources: /^resources:\s+(\d+)/m.exec(text)?.[1], bytes: /^data stack: (\d+)/m.exec(text)?.[1] })
    })
  })
}

async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

function buildBaselineTree(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'bcat-baseline-'))
  execFileSync('sh', ['-c', `git archive ${JSON.stringify(ref)} | tar -x -C ${JSON.stringify(dir)}`], { cwd: root })
  // The assembly's root check wants node_modules inside the project, so a symlink will not do.
  execFileSync('cp', [process.platform === 'darwin' ? '-Rc' : '-R', join(root, 'node_modules'), join(dir, 'node_modules')])
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true })
  for (const f of ['measureDataTemplate.mjs', 'checkLambdaEnvSize.mjs']) cpSync(join(root, 'scripts', f), join(dir, 'scripts', f))
  for (const f of ['prodBuildEnv.json', 'prodSecretNames.json']) cpSync(join(root, 'scripts/lib', f), join(dir, 'scripts/lib', f))
  return dir
}

const failures = []
const fail = (msg) => failures.push(msg)

let baselineDir = null
let baselineOutdir = values['baseline-outdir']
const jobs = []
if (!baselineOutdir) {
  console.log(`baseline: synthesizing ${values['baseline-ref']} ...`)
  baselineDir = buildBaselineTree(values['baseline-ref'])
  jobs.push({ label: 'baseline', cwd: baselineDir, stage: null })
}
for (const k of wanted) jobs.push({ label: `stage ${k}`, cwd: root, stage: k })

const results = await pool(jobs, Number(values.jobs), async (job) => {
  const r = await synth(job.cwd, job.stage)
  console.log(`synthesized ${job.label}: data stack ${r.bytes} B, ${r.resources} resources`)
  return { ...job, ...r }
})
if (!baselineOutdir) baselineOutdir = results.find((r) => r.label === 'baseline').outdir
const byStage = new Map(results.filter((r) => r.stage !== null).map((r) => [r.stage, r]))

const baseTemplates = readTemplates(baselineOutdir)
const baseSchema = parseSchema(readModelSchema(baselineOutdir))
const rows = []

for (const k of wanted) {
  const run = byStage.get(k)
  const tpl = readTemplates(run.outdir)
  const schema = parseSchema(readModelSchema(run.outdir))
  const prevK = k - 1
  const prev = k === wanted[0] ? { tpl: baseTemplates, schema: baseSchema, name: 'baseline' } : (() => {
    const p = byStage.get(prevK)
    return { tpl: readTemplates(p.outdir), schema: parseSchema(readModelSchema(p.outdir)), name: `stage ${prevK}` }
  })()
  const tag = `stage ${k} vs ${prev.name}: `

  const delta = diffTemplates(prev.tpl, tpl)
  const added = schemaAdditions(prev.schema, schema)
  rows.push({ k, delta, added, vs: prev.name })

  for (const v of supersetViolations(prev.schema, schema, tag)) fail(v)
  if (delta.total > DELTA_LIMIT) fail(`${tag}${delta.total} resources > ${DELTA_LIMIT}`)
  const tableDeletes = delta.changed.filter((c) => c.kind === 'deleted' && TABLE_TYPES.has(c.type))
  if (tableDeletes.length > 0) fail(`${tag}${tableDeletes.length} DynamoDB table(s) deleted (data loss): ${tableDeletes.slice(0, 5).map((c) => `${c.file}#${c.id}`).join(', ')}`)
  const unexpected = delta.changed.filter((c) => c.kind === 'deleted'
    && !(k === wanted[0] && prev.name === 'baseline' && KNOWN_STAGE0_REMOVALS.some((re) => re.test(c.id)))
    && !(k === VENDOR_AP_EXTRACT_RETIRED_STAGE && prev.name === `stage ${k - 1}` && /^vendorapextractlambda/.test(c.id)))
  if (unexpected.length > 0) fail(`${tag}${unexpected.length} resources deleted: ${unexpected.slice(0, 5).map((c) => c.id).join(', ')}`)
  for (const g of gsiAdditions(prev.tpl, tpl)) if (g.added.length > 1) fail(`${tag}${g.table} gains ${g.added.length} GSIs: ${g.added.join(', ')}`)

  const nonStack = delta.changed.filter((c) => c.type !== 'AWS::CloudFormation::Stack')
  const existingTableChanges = delta.changed.filter((c) => c.kind === 'updated' && TABLE_TYPES.has(c.type))
  if (k === TTL_STAGE) {
    // The TTL stage changes TruckLocationHistory and nothing else (plus the stack resource that points at it).
    const extra = nonStack.filter((c) => !(TABLE_TYPES.has(c.type) && /TruckLocationHistory/.test(c.file)))
    if (extra.length > 0 || existingTableChanges.length !== 1) {
      fail(`${tag}TTL stage must change only the TruckLocationHistory table; changed: ${JSON.stringify(delta.byType)}`)
    }
  } else if (existingTableChanges.length > 0) {
    fail(`${tag}${existingTableChanges.length} existing table(s) changed outside the TTL stage (e.g. ${existingTableChanges[0].file}#${existingTableChanges[0].id})`)
  }

  const leaks = sentinelLeaks(run.outdir, SENTINEL)
  if (leaks.length > 0) fail(`stage ${k}: staged-out sentinel leaked into ${leaks.join(', ')}`)
}

// Stage 0 == baseline model and index set; the merge may only ADD fields to existing models.
{
  const first = byStage.get(wanted[0])
  if (wanted[0] === 0) {
    const s0 = parseSchema(readModelSchema(first.outdir))
    const extraModels = [...s0.models.keys()].filter((m) => !baseSchema.models.has(m))
    if (extraModels.length > 0) fail(`stage 0 has models production does not: ${extraModels.join(', ')}`)
    const gain = (m) => [...(s0.models.get(m)?.keys() ?? [])].filter((f) => !baseSchema.models.get(m)?.has(f))
    for (const m of baseSchema.models.keys()) {
      for (const f of gain(m)) {
        if (s0.models.get(m).get(f).includes('@index')) fail(`stage 0 adds an index on existing model ${m}.${f}`)
      }
    }
    // The TaxVault stack's CarrierTaxVault table is created WITH its byFingerprint GSI in one operation (nothing
    // existing gains an index), so it is outside this rule, which exists for GSI additions to live tables.
    const allIdx = (tpl) => new Set([...tpl].filter(([name]) => !/TaxVault/.test(name)).flatMap(([, r]) => Object.values(r)).filter((r) => TABLE_TYPES.has(r.Type)).flatMap(indexNames))
    const idx0 = allIdx(readTemplates(first.outdir))
    const idxB = allIdx(baseTemplates)
    const gsiNew = [...idx0].filter((n) => !idxB.has(n))
    if (gsiNew.length > 0) fail(`stage 0 adds GSIs production lacks: ${gsiNew.join(', ')}`)
  }
}

console.log('')
console.log('stage | models +  fields + | created updated deleted | TOTAL  | vs')
for (const { k, delta, added, vs } of rows) {
  console.log(`${String(k).padStart(5)} | ${String(added.models.length).padStart(8)} ${String(added.fields).padStart(8)} | ${String(delta.created).padStart(7)} ${String(delta.updated).padStart(7)} ${String(delta.deleted).padStart(7)} | ${String(delta.total).padStart(6)} | ${vs}`)
}
console.log('')
for (const { k, delta, added } of rows) {
  console.log(`stage ${k}: ${JSON.stringify(delta.byType)}`)
  if (added.models.length > 0) console.log(`         models: ${added.models.join(' ')}`)
  const pm = Object.entries(added.perModel)
  if (pm.length > 0) console.log(`         fields added to existing models: ${pm.map(([m, n]) => `${m} +${n}`).join(', ')}`)
}

if (!values.keep) {
  for (const r of results) rmSync(r.outdir, { recursive: true, force: true })
  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true })
} else {
  console.log(`\nkept: ${results.map((r) => `${r.label}=${r.outdir}`).join(' ')}${baselineDir ? ` tree=${baselineDir}` : ''}`)
}

console.log('')
if (failures.length > 0) {
  console.log(`FAILED (${failures.length}):`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(`OK: ${wanted.length} stage(s), every delta <= ${DELTA_LIMIT}, each schema a strict superset of the one before`)
