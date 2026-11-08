/**
 * GSI deploy-sequence checker (NB-4). READ-ONLY: synthesizes locally, optionally reads
 * CloudFormation templates; writes only under --out (default /tmp). Never deploys.
 *
 * Amplify Gen2 data tables are `Custom::AmplifyDynamoDBTable` resources owned by the
 * AmplifyTableManager Lambda, NOT `AWS::DynamoDB::Table`. This tool normalizes each model's table
 * (key schema, attributes, GSIs, stream, TTL, PITR, deletion protection) out of a synthesized
 * (or deployed) nested stack template and compares two states.
 *
 *   # 1. normalize a git ref (or a directory) by synthesizing it
 *   node scripts/gsiSequenceCheck.mjs synth --ref dev --out /tmp/gsi/dev.tables.json
 *   node scripts/gsiSequenceCheck.mjs synth --dir /tmp/some/checkout --out /tmp/gsi/x.tables.json
 *
 *   # 2. normalize what is DEPLOYED (CloudFormation read APIs only: describe-stack-resources, get-template)
 *   node scripts/gsiSequenceCheck.mjs prod --stack amplify-<app>-main-branch-<id>-data<hash>-<suffix> --out /tmp/gsi/prod.tables.json
 *
 *   # 3. compare two normalized states
 *   node scripts/gsiSequenceCheck.mjs diff --prev /tmp/gsi/prod.tables.json --next /tmp/gsi/dev.tables.json [--max-gsi-per-table 1]
 *
 *   # 4. synth + diff a whole sequence of refs/dirs (first entry's baseline is --baseline or the first entry)
 *   node scripts/gsiSequenceCheck.mjs sequence --baseline /tmp/gsi/prod.tables.json --steps origin/main,gsi/step1,gsi/step2 --max-gsi-per-table 1
 *
 *   # 5. replay the REAL table-manager handler against a state diff (how many updateTable calls, in order)
 *   node scripts/gsiSequenceCheck.mjs simulate --prev /tmp/gsi/prod.tables.json --next /tmp/gsi/dev.tables.json
 *
 * Exit codes: 0 ok; 1 usage/error; 2 replacement-triggering diff (key schema change, removed table,
 * attribute type change); 3 more than --max-gsi-per-table GSI creates/deletes on one table in one step.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
/** git-archive checkouts go here; remove with `rm -rf .gsiseq-tmp` (untracked, never committed). */
const SCRATCH_ROOT = join(REPO, '.gsiseq-tmp')
const TABLE_TYPE = 'Custom::AmplifyDynamoDBTable'

// ---------------------------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------------------------

const sortBy = (arr, key) => [...(arr ?? [])].sort((a, b) => String(a[key]).localeCompare(String(b[key])))
const j = (v) => JSON.stringify(v ?? null)

/** One `Custom::AmplifyDynamoDBTable` resource -> comparable plain object. */
export function normalizeTable(props) {
  return {
    keySchema: props.keySchema ?? [],
    attributes: Object.fromEntries((props.attributeDefinitions ?? []).map((a) => [a.attributeName, a.attributeType])),
    gsis: Object.fromEntries(
      (props.globalSecondaryIndexes ?? []).map((g) => [
        g.indexName,
        { keySchema: g.keySchema, projection: g.projection },
      ]),
    ),
    // CFN-conditional values are kept verbatim (stringified) so any change shows up.
    billingMode: j(props.billingMode),
    stream: j(props.streamSpecification),
    ttl: j(props.timeToLiveSpecification),
    pitr: j(props.pointInTimeRecoverySpecification),
    deletionProtection: j(props.deletionProtectionEnabled),
    sse: j(props.sseSpecification),
    allowDestructive: j(props.allowDestructiveGraphqlSchemaUpdates),
    replaceTableUponGsiUpdate: j(props.replaceTableUponGsiUpdate),
  }
}

function tablesFromTemplates(entries) {
  const out = {}
  for (const [, template] of entries) {
    for (const [logicalId, res] of Object.entries(template.Resources ?? {})) {
      if (res.Type !== TABLE_TYPE) continue
      out[logicalId.replace(/Table$/, '')] = normalizeTable(res.Properties)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------------------------

function synthDirInChild(dir, outFile, branch) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'synth-child', '--dir', dir, '--out', outFile, '--branch', branch], {
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: REPO,
    env: { ...process.env },
  })
  if (r.status !== 0) throw new Error(`synth of ${dir} failed (exit ${r.status})`)
}

/** Check a git ref out to a throwaway directory WITHOUT touching any branch or worktree list. */
export function checkoutRef(ref) {
  // Must live UNDER the repo: Amplify's synth asserts every lambda entry path and node_modules
  // path sits under projectRoot (process.cwd()), and node_modules resolves by walking up.
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  const dir = mkdtempSync(join(SCRATCH_ROOT, 'co-'))
  const tar = execFileSync('git', ['-C', REPO, 'archive', ref], { maxBuffer: 1 << 30 })
  execFileSync('tar', ['-x', '-C', dir], { input: tar })
  return dir
}

/** Runs INSIDE the child: synthesize the checkout's backend and dump normalized tables. */
async function synthChild(dir, outFile, branch) {
  const { MemoryContext, StackSelectionStrategy, Toolkit } = await import('@aws-cdk/toolkit-lib')
  const { CloudAssembly } = await import('aws-cdk-lib/cx-api')
  const { tsImport } = await import('tsx/esm/api')
  const outdir = mkdtempSync(join(tmpdir(), 'bcat-gsisynth-'))
  const backend = resolve(dir, 'amplify/backend.ts')
  const toolkit = new Toolkit({ color: false })
  const cx = await toolkit.fromAssemblyBuilder(
    async () => {
      await tsImport(pathToFileURL(backend).toString(), import.meta.url)
      process.emit('message', 'amplifySynth', undefined)
      return new CloudAssembly(outdir)
    },
    {
      contextStore: new MemoryContext({
        'amplify-backend-namespace': 'd3dejqzs77khq6',
        'amplify-backend-name': branch,
        'amplify-backend-type': 'branch',
      }),
      outdir,
    },
  )
  await toolkit.synth(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS } })
  const entries = readdirSync(outdir)
    .filter((n) => n.endsWith('.nested.template.json'))
    .map((n) => [n, JSON.parse(readFileSync(join(outdir, n), 'utf8'))])
  const tables = tablesFromTemplates(entries)
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, JSON.stringify(tables, null, 1))
  console.log(`synth ${dir}: ${Object.keys(tables).length} tables -> ${outFile} (cdk.out ${outdir})`)
}

async function fromProd(stack, outFile) {
  const aws = (...args) => JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { maxBuffer: 1 << 28 }).toString())
  // list-stack-resources paginates; describe-stack-resources silently caps at 100 resources.
  const res = aws('cloudformation', 'list-stack-resources', '--stack-name', stack)
  const nested = res.StackResourceSummaries.filter((r) => r.ResourceType === 'AWS::CloudFormation::Stack' && /^amplifyData/.test(r.LogicalResourceId))
  const entries = []
  for (const n of nested) {
    const t = aws('cloudformation', 'get-template', '--stack-name', n.PhysicalResourceId, '--query', 'TemplateBody')
    entries.push([n.LogicalResourceId, t])
  }
  const tables = tablesFromTemplates(entries)
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, JSON.stringify(tables, null, 1))
  console.log(`prod ${stack}: ${nested.length} nested stacks, ${Object.keys(tables).length} tables -> ${outFile}`)
}

// ---------------------------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------------------------

/**
 * Diff two normalized states.
 * Returns per-table { addedGsis, removedGsis, changedGsis, keySchemaChanged, attributeTypeChanged,
 * other: {field: [prev, next]}, replacement: string[] , gsiOps }.
 * gsiOps = creates + deletes the table manager must perform (a changed GSI = delete + create).
 */
export function diffStates(prev, next) {
  const report = { newTables: [], removedTables: [], tables: {} }
  for (const m of Object.keys(next)) if (!(m in prev)) report.newTables.push(m)
  for (const m of Object.keys(prev)) if (!(m in next)) report.removedTables.push(m)
  for (const m of Object.keys(next)) {
    if (!(m in prev)) continue
    const a = prev[m]
    const b = next[m]
    const t = { addedGsis: [], removedGsis: [], changedGsis: [], keySchemaChanged: false, attributeTypeChanged: [], other: {}, replacement: [], gsiOps: 0 }
    t.keySchemaChanged = j(a.keySchema) !== j(b.keySchema)
    if (t.keySchemaChanged) t.replacement.push(`key schema ${j(a.keySchema)} -> ${j(b.keySchema)} (table manager replaceTable: DELETE + CREATE, all data lost)`)
    for (const [attr, type] of Object.entries(b.attributes)) {
      if (attr in a.attributes && a.attributes[attr] !== type) {
        t.attributeTypeChanged.push(`${attr}: ${a.attributes[attr]} -> ${type}`)
      }
    }
    for (const g of Object.keys(b.gsis)) {
      if (!(g in a.gsis)) t.addedGsis.push(g)
      else if (j(a.gsis[g]) !== j(b.gsis[g])) t.changedGsis.push(g)
    }
    for (const g of Object.keys(a.gsis)) if (!(g in b.gsis)) t.removedGsis.push(g)
    t.gsiOps = t.addedGsis.length + t.removedGsis.length + 2 * t.changedGsis.length
    if (t.attributeTypeChanged.length) t.replacement.push(`attribute type change ${t.attributeTypeChanged.join(', ')} (any GSI keyed on it is deleted and recreated)`)
    for (const f of ['billingMode', 'stream', 'ttl', 'pitr', 'deletionProtection', 'sse', 'allowDestructive', 'replaceTableUponGsiUpdate']) {
      if (a[f] !== b[f]) t.other[f] = [a[f], b[f]]
    }
    if (a.replaceTableUponGsiUpdate !== b.replaceTableUponGsiUpdate || b.replaceTableUponGsiUpdate === 'true') {
      if (b.replaceTableUponGsiUpdate === 'true' && t.gsiOps > 0) t.replacement.push('replaceTableUponGsiUpdate=true: any GSI change REPLACES the table')
    }
    const changed = t.addedGsis.length || t.removedGsis.length || t.changedGsis.length || t.keySchemaChanged || t.attributeTypeChanged.length || Object.keys(t.other).length
    if (changed) report.tables[m] = t
  }
  return report
}

function printReport(rep, label, maxGsi) {
  console.log(`\n=== ${label} ===`)
  let code = 0
  if (rep.newTables.length) console.log(`new tables (${rep.newTables.length}): ${rep.newTables.join(', ')}`)
  if (rep.removedTables.length) {
    console.log(`REMOVED tables (${rep.removedTables.length}): ${rep.removedTables.join(', ')}  <- DeletionPolicy Delete: data destroyed`)
    code = 2
  }
  for (const [m, t] of Object.entries(rep.tables)) {
    const bits = []
    if (t.addedGsis.length) bits.push(`+GSI ${t.addedGsis.join(', ')}`)
    if (t.removedGsis.length) bits.push(`-GSI ${t.removedGsis.join(', ')}`)
    if (t.changedGsis.length) bits.push(`~GSI(delete+create) ${t.changedGsis.join(', ')}`)
    for (const [f, [x, y]] of Object.entries(t.other)) bits.push(`${f}: ${x} -> ${y}`)
    console.log(`${m}: ${bits.join(' | ')}  [gsiOps=${t.gsiOps}]`)
    for (const r of t.replacement) {
      console.log(`  REPLACEMENT RISK: ${r}`)
      code = Math.max(code, 2)
    }
    if (maxGsi != null && t.gsiOps > maxGsi) {
      console.log(`  TOO MANY GSI OPS: ${t.gsiOps} > ${maxGsi} in one step`)
      if (code < 2) code = 3
    }
  }
  if (!Object.keys(rep.tables).length && !rep.newTables.length && !rep.removedTables.length) console.log('no table-level differences')
  return code
}

// ---------------------------------------------------------------------------------------------
// simulate with the real table-manager handler
// ---------------------------------------------------------------------------------------------

async function loadHandler() {
  const p = join(REPO, 'node_modules/@aws-amplify/data-construct/node_modules/@aws-amplify/graphql-model-transformer/lib/resources/amplify-dynamodb-table/amplify-table-manager-lambda/amplify-table-manager-handler.js')
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)(p)
}

/** DescribeTable-shaped state from a normalized table. */
function describeShape(name, t) {
  return {
    TableName: name,
    TableStatus: 'ACTIVE',
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    AttributeDefinitions: Object.entries(t.attributes).map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })),
    KeySchema: t.keySchema.map((k) => ({ AttributeName: k.attributeName, KeyType: k.keyType })),
    GlobalSecondaryIndexes: Object.entries(t.gsis).map(([IndexName, g]) => ({
      IndexName,
      IndexStatus: 'ACTIVE',
      KeySchema: g.keySchema.map((k) => ({ AttributeName: k.attributeName, KeyType: k.keyType })),
      Projection: { ProjectionType: g.projection.projectionType, NonKeyAttributes: g.projection.nonKeyAttributes },
    })),
  }
}

function endShape(t) {
  return {
    billingMode: 'PAY_PER_REQUEST',
    attributeDefinitions: Object.entries(t.attributes).map(([attributeName, attributeType]) => ({ attributeName, attributeType })),
    keySchema: t.keySchema,
    globalSecondaryIndexes: Object.entries(t.gsis).map(([indexName, g]) => ({ indexName, keySchema: g.keySchema, projection: g.projection })),
  }
}

async function simulate(prev, next) {
  const { getNextAtomicUpdate } = await loadHandler()
  const rep = diffStates(prev, next)
  let bad = 0
  for (const m of Object.keys(rep.tables)) {
    if (!rep.tables[m].gsiOps) continue
    let cur = describeShape(m, prev[m])
    const end = endShape(next[m])
    const steps = []
    for (let i = 0; i < 20; i++) {
      const upd = getNextAtomicUpdate(cur, end)
      if (!upd) break
      const op = upd.GlobalSecondaryIndexUpdates?.[0]
      if (!op) {
        steps.push(`non-GSI update ${Object.keys(upd).join(',')}`)
        break
      }
      steps.push(op.Create ? `Create ${op.Create.IndexName}` : op.Delete ? `Delete ${op.Delete.IndexName}` : `Update ${op.Update.IndexName}`)
      cur = structuredClone(cur)
      cur.GlobalSecondaryIndexes ??= []
      if (op.Create) {
        cur.GlobalSecondaryIndexes.push({ IndexName: op.Create.IndexName, IndexStatus: 'ACTIVE', KeySchema: op.Create.KeySchema, Projection: { ProjectionType: op.Create.Projection.ProjectionType, NonKeyAttributes: op.Create.Projection.NonKeyAttributes } })
      } else if (op.Delete) cur.GlobalSecondaryIndexes = cur.GlobalSecondaryIndexes.filter((g) => g.IndexName !== op.Delete.IndexName)
      else break
    }
    const converged = !getNextAtomicUpdate(cur, end)
    console.log(`${m}: ${steps.length} updateTable call(s) in ${steps.length} isComplete cycles: ${steps.join(' -> ')}${converged ? '' : '  (DID NOT CONVERGE)'}`)
    if (!converged) bad = 1
  }
  return bad
}

// ---------------------------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------------------------

const load = (f) => JSON.parse(readFileSync(f, 'utf8'))

async function toTables(spec, branch, scratch) {
  if (existsSync(spec) && spec.endsWith('.json')) return load(spec)
  const dir = existsSync(spec) ? resolve(spec) : checkoutRef(spec)
  const out = join(scratch, `${spec.replace(/[^A-Za-z0-9]+/g, '_')}.tables.json`)
  synthDirInChild(dir, out, branch)
  return load(out)
}

async function main() {
  const cmd = process.argv[2]
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      ref: { type: 'string' },
      dir: { type: 'string' },
      out: { type: 'string' },
      stack: { type: 'string' },
      prev: { type: 'string' },
      next: { type: 'string' },
      baseline: { type: 'string' },
      steps: { type: 'string' },
      branch: { type: 'string', default: 'dev' },
      'max-gsi-per-table': { type: 'string' },
    },
  })
  const maxGsi = values['max-gsi-per-table'] != null ? Number(values['max-gsi-per-table']) : null
  if (cmd === 'synth-child') return synthChild(values.dir, values.out, values.branch)
  if (cmd === 'synth') {
    const dir = values.dir ? resolve(values.dir) : checkoutRef(values.ref)
    return synthDirInChild(dir, values.out, values.branch)
  }
  if (cmd === 'prod') return fromProd(values.stack, values.out)
  if (cmd === 'diff') {
    const code = printReport(diffStates(load(values.prev), load(values.next)), `${values.prev} -> ${values.next}`, maxGsi)
    process.exit(code)
  }
  if (cmd === 'simulate') process.exit(await simulate(load(values.prev), load(values.next)))
  if (cmd === 'sequence') {
    const scratch = mkdtempSync(join(tmpdir(), 'gsiseq-out-'))
    const steps = values.steps.split(',').map((s) => s.trim()).filter(Boolean)
    let prev = values.baseline ? await toTables(values.baseline, values.branch, scratch) : null
    let worst = 0
    let label = values.baseline ?? null
    for (const step of steps) {
      const cur = await toTables(step, values.branch, scratch)
      if (prev) worst = Math.max(worst, printReport(diffStates(prev, cur), `${label} -> ${step}`, maxGsi))
      prev = cur
      label = step
    }
    process.exit(worst)
  }
  console.error('usage: gsiSequenceCheck.mjs synth|prod|diff|simulate|sequence (see file header)')
  process.exit(1)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
