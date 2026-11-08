#!/usr/bin/env node
/**
 * Step AW stage E: operator CLI for the per-file Aljex imports and the reconciliation, against ONE explicit
 * non-production stack. It drives the deployed tms-aljex-import Lambda through AppSync (the same router actions the
 * Settings > Data > Aljex import wizard calls), so the dry run and the apply are the code the app runs.
 *
 *   BCAT_STACK=rehearsal BCAT_EMAIL=... BCAT_PASSWORD=... node scripts/awImport.mjs <command> --outputs <rehearsal amplify_outputs.json> [options]
 *
 * Commands (each runs the DRY RUN first and prints it; --apply --live-tag <TAG> then applies; both are idempotent):
 *   customers      --file <customers.csv>
 *   carriers       --file <carriers.csv>                 (Fed/SS #, Bank Account, Routing # and Account # are stripped locally first)
 *   ap             --aging-file <ap-aging.csv> [--expected-file <ap-expected.csv>]   (either or both)
 *   ar             --file <ar.csv>
 *   active-check   --file <active-shipments.csv>         (read-only check; --apply only saves the report)
 *   stage-export   --file <aljex-full-export.csv>        (STAGES the big export in the stack's bucket for the SHIPMENTS / AR reconciliation;
 *                                                         it writes no table. The load import itself is scripts/importAljex.mjs)
 *   reconcile      --entity CUSTOMERS|CARRIERS|AR|AP|SHIPMENTS --source-job <jobId> [--customers-job <jobId>]
 * Options: --cutoff YYYY-MM-DD (default: Settings > Data cutoff), --out <dir> (writes the numeric result JSON), --help
 *
 * Target safety: BCAT_STACK=dev|rehearsal must name the stack (scripts/lib/stackConfig.mjs; production is never a value),
 * and --outputs must be that stack's AppSync API (the repo-root amplify_outputs.json is production and is refused).
 * Files stay outside the repo. A file with a Web Password / Fed/SS # / Bank Account / Routing # header is never sent: the
 * CLI removes those columns from the copy it uploads (names and counts only are printed, never a value).
 * Output is counts, dollars and Aljex keys: no names, e-mails or identifiers of people.
 */
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createTmsClient } from './lib/tmsClient.mjs'
import { authenticateTmsUser } from './lib/tmsAuth.mjs'
import { parseArgs } from 'node:util'
import { loadAmplifyOutputs } from './lib/tmsConfig.mjs'
import { PRODUCTION, STACK, STACK_ENV } from './lib/stackConfig.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const USAGE = `Usage: BCAT_STACK=dev|rehearsal node scripts/awImport.mjs <customers|carriers|ap|ar|active-check|stage-export|reconcile> --outputs <amplify_outputs.json> [--file f | --aging-file f --expected-file f] [--cutoff YYYY-MM-DD] [--apply --live-tag TAG] [--out dir]
       node scripts/awImport.mjs reconcile --entity CUSTOMERS|CARRIERS|AR|AP|SHIPMENTS --source-job <jobId> [--customers-job <jobId>]`

/** command -> the uploaded kinds it needs (flag name per kind). */
export const COMMANDS = {
  customers: { kind: 'CUSTOMERS_MASTER', files: [['CUSTOMERS_MASTER', 'file']] },
  carriers: { kind: 'CARRIERS_MASTER', files: [['CARRIERS_MASTER', 'file']] },
  ap: { kind: 'AP_AGING', files: [['AP_AGING', 'aging-file'], ['AP_EXPECTED', 'expected-file']] },
  ar: { kind: 'AR_REPORT', files: [['AR_REPORT', 'file']] },
  'active-check': { kind: 'ACTIVE_SHIPMENTS', files: [['ACTIVE_SHIPMENTS', 'file']] },
}

/** The explicit non-production target: the selected stack's API must be the one the outputs file names. */
export function assertTarget({ env = process.env, stack = STACK, outputs }) {
  if (!env[STACK_ENV]) throw new Error(`Name the target: ${STACK_ENV}=dev|rehearsal`)
  if (JSON.stringify(stack).includes(PRODUCTION.apiId)) throw new Error('Refusing a stack that resolves to production')
  const url = outputs?.data?.url
  if (!url) throw new Error('amplify_outputs.json missing data.url')
  if (url !== stack.apiUrl) throw new Error(`--outputs is not the API of the ${stack.name} stack: refusing`)
}

/**
 * What goes to the bucket: the file with every refused column removed. Pure; `core` is the bundled layout code.
 * @returns {{kind: string, csv: string, dropped: string[]}}
 */
export function prepareUpload(core, expectedKind, text) {
  const rows = core.parseCsvRows(text)
  const headers = rows[0] ?? []
  const kind = core.detectFileKind(headers)
  if (kind !== expectedKind) throw new Error(`The file is not a ${core.FILE_KIND_LABEL[expectedKind]} (its columns match ${kind ? core.FILE_KIND_LABEL[kind] : 'no known layout'})`)
  const stripped = core.stripRefusedColumns(kind, headers, rows.slice(1))
  const q = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const csv = `${[stripped.headers, ...stripped.rows].map((r) => r.map(q).join(',')).join('\n')}\n`
  if (core.refusedHeaders(kind, stripped.headers).length > 0) throw new Error('Sensitive columns survived the strip: refusing')
  return { kind, csv, dropped: stripped.dropped }
}

export async function bundleCore() {
  const entry = join(here, 'lib/awImportEntry.ts')
  const outDir = join(root, 'node_modules/.cache/aw-import')
  mkdirSync(outDir, { recursive: true })
  const stamp = createHash('sha1')
  for (const dir of [join(root, 'src/lib/aljex'), join(root, 'src/lib/aljex/layouts')]) {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f)
      if (statSync(p).isFile()) stamp.update(f).update(readFileSync(p))
    }
  }
  const outfile = join(outDir, `core-${stamp.digest('hex').slice(0, 12)}.mjs`)
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'error' })
  return import(pathToFileURL(outfile).href)
}

const dollars = (cents) => (cents == null ? 'n/a' : `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100).toLocaleString('en-US')}.${String(Math.abs(cents) % 100).padStart(2, '0')}`)

function printResult(label, res) {
  console.log(`\n== ${label} (${res.mode}${res.rerun ? ', again: nothing new to write' : ''}) job ${res.job.id} ${res.job.status}`)
  for (const [entity, c] of Object.entries(res.result.counts ?? {})) {
    console.log(`  ${entity.padEnd(9)} staged ${c.staged}  created ${c.created}  matched ${c.matched}  enriched ${c.enriched}  skipped ${c.skipped}  conflicts ${c.conflicts}  errors ${c.errors}`)
  }
  for (const [k, v] of Object.entries(res.result.summary)) {
    if (typeof v === 'number') console.log(`  ${k}: ${/Cents$/.test(k) ? `$${dollars(v)}` : v}`)
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = Object.entries(v).filter(([, x]) => typeof x === 'number').map(([k2, x]) => `${k2} ${/Cents$/.test(k2) ? `$${dollars(x)}` : x}`)
      if (inner.length) console.log(`  ${k}: ${inner.join(', ')}`)
    }
  }
  for (const b of res.result.reconcile?.bridge ?? []) console.log(`  tie-out ${String(b.key).padEnd(18)} file $${dollars(b.fileCents)}  BCAT $${dollars(b.bcatCents)}  diff $${dollars(b.diffCents)}`)
  if (res.result.reconcile) console.log(`  every row matched: ${res.result.reconcile.allMatched ? 'YES' : 'NO'}`)
  console.log(`  needs a look: ${res.result.reviewTotal} (keys only, in the report files: ${res.reportPrefix})`)
}

export function makeApi(client) {
  const call = async (action, input) => {
    const data = await client.gql('mutation TmsAljexImport($action: String!, $input: AWSJSON!) { tmsAljexImport(action: $action, input: $input) }', { action, input: JSON.stringify(input) })
    const v = data.tmsAljexImport
    return typeof v === 'string' ? JSON.parse(v) : v
  }
  return { call }
}

async function uploadFile(api, core, kind, path) {
  const raw = readFileSync(resolve(process.cwd(), path), 'utf8')
  if (kind === 'CARRIERS_MASTER') {
    // Header-column row counts of the columns about to be dropped (how many rows had a value); no value is ever printed.
    const rows = core.parseCsvRows(raw)
    const n = core.parseCarrierRows(rows[0], rows.slice(1)).counts.sensitiveRows
    console.log(`  rows with a value in the columns that are NOT imported: Fed/SS # ${n.fedSs}, Bank Account ${n.bankAccount}, Routing # ${n.routing}`)
  }
  const { csv, dropped } = prepareUpload(core, kind, raw)
  if (dropped.length) console.log(`  stripped before upload: ${dropped.join(', ')}`)
  const { job, uploadUrl } = await api.call('IMPORT_PREPARE', {
    fileName: path.split('/').pop(), fileHash: createHash('sha256').update(csv).digest('hex'), sizeBytes: Buffer.byteLength(csv), layoutId: core.FILE_KIND_LAYOUT_ID[kind],
  })
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: csv })
  if (!put.ok) throw new Error(`upload failed (${put.status})`)
  const staged = (await api.call('IMPORT_STAGE', { jobId: job.id })).job
  if (staged.status !== 'READY') throw new Error(`the file was refused: ${staged.error ?? staged.status}`)
  console.log(`  uploaded ${kind}: job ${staged.id}, ${staged.rowCount} rows`)
  return staged
}

async function runFiles(api, core, name, v) {
  const spec = COMMANDS[name]
  const jobs = {}
  for (const [kind, flag] of spec.files) {
    if (v[flag]) jobs[kind] = await uploadFile(api, core, kind, v[flag])
  }
  if (Object.keys(jobs).length === 0) throw new Error(`${name} needs ${spec.files.map(([, f]) => `--${f}`).join(' and/or ')}`)
  const ids = name === 'ap' ? { agingJobId: jobs.AP_AGING?.id, expectedJobId: jobs.AP_EXPECTED?.id } : { jobId: Object.values(jobs)[0].id }
  const input = { ...ids, ...(v.cutoff ? { cutoffDate: v.cutoff } : {}) }
  const action = core.FILE_KIND_ACTION[spec.kind]
  const plan = await api.call(action, { ...input, mode: 'PLAN' })
  printResult(`${name} dry run`, plan)
  let last = plan
  if (v.apply) {
    if (!v['live-tag']) throw new Error('--apply needs --live-tag <TAG> (typed confirmation, recorded in the audit log)')
    last = await api.call(action, { ...input, mode: 'APPLY', options: { liveTag: v['live-tag'] } })
    printResult(`${name} apply`, last)
  } else console.log('\nDry run only: nothing was written. Add --apply --live-tag <TAG> to apply.')
  return last
}

/** Uploads the big export untouched (it carries none of the refused columns; STAGE refuses it otherwise) and waits for READY. */
async function stageExport(api, path) {
  const body = readFileSync(resolve(process.cwd(), path))
  const { job, uploadUrl } = await api.call('IMPORT_PREPARE', { fileName: path.split('/').pop(), fileHash: createHash('sha256').update(body).digest('hex'), sizeBytes: body.length })
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body })
  if (!put.ok) throw new Error(`upload failed (${put.status})`)
  await api.call('IMPORT_STAGE', { jobId: job.id })
  for (let i = 0; i < 300; i++) {
    const cur = (await api.call('IMPORT_GET', { jobId: job.id })).job
    if (cur.status === 'FAILED') throw new Error(`staging failed: ${cur.error}`)
    if (cur.status === 'READY') {
      console.log(`\n== big export staged: job ${cur.id}, ${cur.rowCount} rows, stage hash ${String(cur.stageHash).slice(0, 12)} (no table was written)`)
      return cur
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error('staging did not finish in 15 minutes')
}

async function runReconcile(api, v) {
  if (!v.entity || !v['source-job']) throw new Error('reconcile needs --entity and --source-job')
  const started = await api.call('IMPORT_RECONCILE_ENTITY', { entity: v.entity, sourceJobId: v['source-job'], ...(v['customers-job'] ? { customersJobId: v['customers-job'] } : {}), ...(v.cutoff ? { cutoffDate: v.cutoff } : {}) })
  const id = started.job.id
  for (let i = 0; i < 200; i++) {
    const page = await api.call('IMPORT_RECONCILE_GET', { jobId: id, limit: 1 })
    if (page.job.status === 'FAILED') throw new Error(`reconciliation failed: ${page.job.error}`)
    if (page.job.status === 'APPLIED') {
      const c = page.report.counts
      console.log(`\n== reconcile ${v.entity} job ${id}\n  Aljex rows ${c.aljexRows}  BCAT rows ${c.bcatRows}  matched ${c.matched}  Aljex-only ${c.aljexOnly}  BCAT-only ${c.bcatOnly}  mismatched ${c.mismatched}  differences ${c.diffs}`)
      if (page.report.money) console.log(`  money: Aljex $${dollars(page.report.money.aljexCents)}  BCAT $${dollars(page.report.money.bcatCents)}  diff $${dollars(page.report.money.diffCents)}`)
      console.log('  Jenny decides each difference and signs off in Settings > Data > Aljex reconciliation.')
      return page
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error('the reconciliation did not finish in 10 minutes')
}

async function main() {
  const name = process.argv[2]
  const args = parseArgs({
    args: name && !name.startsWith('-') ? process.argv.slice(3) : process.argv.slice(2),
    options: {
    help: { type: 'boolean', short: 'h' }, outputs: { type: 'string' }, apply: { type: 'boolean' }, out: { type: 'string' },
    file: { type: 'string' }, 'aging-file': { type: 'string' }, 'expected-file': { type: 'string' }, cutoff: { type: 'string' }, 'live-tag': { type: 'string' },
    entity: { type: 'string' }, 'source-job': { type: 'string' }, 'customers-job': { type: 'string' },
    },
  })
  const v = args.values
  if (v.help || !name || name.startsWith('-')) return console.log(USAGE)
  if (name !== 'reconcile' && name !== 'stage-export' && !COMMANDS[name]) throw new Error(`unknown command "${name}"\n${USAGE}`)
  const outputs = loadAmplifyOutputs(v.outputs)
  assertTarget({ outputs })
  const auth = await authenticateTmsUser(outputs)
  const api = makeApi(createTmsClient({ endpoint: auth.endpoint, token: auth.token }))
  console.log(`Target: ${STACK.name} (${STACK.tableSuffix}); ${v.apply ? 'APPLY after the dry run' : 'DRY RUN (nothing written)'}`)
  const result = name === 'stage-export' ? await stageExport(api, v.file) : name === 'reconcile' ? await runReconcile(api, v) : await runFiles(api, await bundleCore(), name, v)
  if (v.out) {
    mkdirSync(resolve(process.cwd(), v.out), { recursive: true })
    writeFileSync(resolve(process.cwd(), v.out, `${name}-result.json`), JSON.stringify(name === 'reconcile' ? { report: result.report } : name === 'stage-export' ? { jobId: result.id, rows: result.rowCount } : { mode: result.mode, result: result.result }, null, 2))
  }
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
