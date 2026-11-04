#!/usr/bin/env node
/**
 * Step PERF verification against the DEV site: page budgets, request shape, shell floor, static gaps, money freeze
 * (PERF-plan.md §11). Read-only: no seeds, no writes; a mutation seen in the fetch log is itself a failure (G0).
 *
 *   node scripts/devVerifyPerf.mjs --inventory           no network, no browser: G5 static gaps + G6 money freeze + spec completeness
 *   node scripts/devVerifyPerf.mjs --baseline            pre-change numbers: 12 pages x 3 cold runs -> Docs/tms-build/perf/baseline-<date>.json
 *   node scripts/devVerifyPerf.mjs                       full gate: G0..G8 (browser) + G1/G2/G7 (API, via devVerifyPerfApi.mts)
 *   node scripts/devVerifyPerf.mjs --ratchet             lower every ceiling in perfBudgets.mjs to measured p95 x 1.5 from perf/last-run.json (never raises)
 *   options: --runs=N (default 3)  --pages=/tms/carriers,/schedule  --base=<sha> (G6, default 2364934)  --no-api  --verbose
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool and any origin but DEV_ORIGIN
 * (localhost would talk to the committed production API). The temporary admin identity is deleted in `finally`
 * and proven gone (`identity deleted: true`). Passwords and tokens are never printed.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { launchBrowser, DEV_ORIGIN } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity } from './lib/devIdentity.mjs'
import {
  PAGE_BUDGETS, PAGE_LABELS, PAGE_PATHS, SHELL_FLOOR, SHELL_FLOOR_PATH, MAX_FACTOR, METRICS,
  evaluate, ratchet, checkSpecs, rewriteBudgets, percentile,
} from './lib/perfBudgets.mjs'
import { measurePage, MAX_CHAIN_DEPTH, MAX_REPEATS } from './lib/perfProbe.mjs'
import { perfGaps, moneyFreeze } from './lib/perfGaps.mjs'
import { expectedCounts } from './lib/perfExpected.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const PERF_DIR = resolve('Docs/tms-build/perf')
const DEFAULT_BASE = '2364934' // the AA merge: the last commit before the PERF pass
const LEGACY_LOAD_READ = '\\b(listLoads|listLoadBy[A-Za-z]+|getLoad)\\b'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const RUNS = Number(opt('runs') ?? 3)
const PAGES = opt('pages')?.split(',') ?? null
const BASE = opt('base') ?? process.env.PERF_BASE ?? DEFAULT_BASE
const verbose = flag('verbose')

const results = []
const record = (status, id, detail = '') => {
  results.push({ status, id, detail })
  console.log(`${status.padEnd(4)} ${id}${detail ? `  ${detail}` : ''}`)
}
const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? '—' : n.toFixed(d))

/** Page -> readiness spec, from independent API reads (expected row counts). */
export function pageSpecs(expected) {
  const rowsOr = (n, cap) => (n === 0 ? { minRows: 0, expectEmpty: true } : { minRows: Math.min(n, cap) })
  return {
    '/tms/dashboard': { minRows: 0, minCharts: 4, kpi: true },
    '/tms/tracking': rowsOr(expected.trackingRows, 100),
    '/tms/shipments': rowsOr(expected.activeLowerBound, 50),
    '/tms/shipments?list=all': rowsOr(expected.activeLowerBound, 50),
    '/tms/customers': rowsOr(expected.customers, 50),
    '/tms/brokerage/users': { minRows: 3 },
    '/tms/invoicing': rowsOr(expected.unbilledOrders, 1),
    '/tms/invoicing/payable': rowsOr(expected.openBills, 1),
    '/tms/carriers': rowsOr(expected.carriers, 15),
    '/schedule': { minRows: 0, readyOps: LEGACY_LOAD_READ },
    '/calendar': { minRows: 0, readyOps: LEGACY_LOAD_READ },
    '/dashboard': { minRows: 0, readyOps: LEGACY_LOAD_READ },
  }
}

// ───────────────────────────── static gates ─────────────────────────────
export async function inventory() {
  let ok = true
  const missing = checkSpecs(PAGE_PATHS)
  const unlabeled = PAGE_PATHS.filter((p) => !PAGE_LABELS[p])
  if (missing.length || unlabeled.length) { record('FAIL', 'spec completeness', JSON.stringify({ missing, unlabeled })); ok = false } else record('PASS', 'spec completeness', `${PAGE_PATHS.length} pages budgeted`)

  const gaps = await perfGaps()
  const show = (list, f) => list.slice(0, 15).map(f).join('; ')
  if (gaps.r1.length) { record('FAIL', 'G5 R1 full-table callers', show(gaps.r1, (h) => `${h.path}:${h.line} ${h.symbol}`)); ok = false } else record('PASS', 'G5 R1 full-table callers', 'none outside the allowlist')
  if (gaps.directory.length) { record('FAIL', 'G5 useDirectory locations', show(gaps.directory, (h) => `${h.path}:${h.line}`)); ok = false } else record('PASS', 'G5 useDirectory locations', 'every call passes locations:false or is allowlisted')
  if (gaps.polls.length) { record('FAIL', 'G5 poll visibility gate', show(gaps.polls, (h) => h.path)); ok = false } else record('PASS', 'G5 poll visibility gate', 'every poll hook checks visibilityState')

  const freeze = await moneyFreeze(process.cwd(), BASE)
  if (freeze.frozen.length) { record('FAIL', `G6 frozen money files vs ${BASE}`, freeze.frozen.join(', ')); ok = false } else record('PASS', `G6 frozen money files vs ${BASE}`, 'no diff')
  if (freeze.payHooks.length) { record('FAIL', `G6 pay hooks vs ${BASE}`, freeze.payHooks.map((h) => `${h.path}: ${h.lines.slice(0, 3).join(' | ')}`).join('; ')); ok = false } else record('PASS', `G6 pay hooks vs ${BASE}`, 'only windowing lines differ')
  return ok
}

// ───────────────────────────── measurement ─────────────────────────────
async function measureAll(b, specs, paths) {
  const out = {}
  for (const path of paths) {
    const runs = []
    for (let i = 0; i < RUNS; i += 1) {
      const m = await measurePage(b, path, specs[path])
      runs.push(m)
      console.log(`     ${path} run ${i + 1}/${RUNS}: first ${fmt(m.firstRowsS)} s, settled ${fmt(m.settledS)} s, ${m.requests} req, ${fmt(m.mb)} MB, rows ${m.rows}${m.charts ? ` charts ${m.charts}` : ''}${m.timedOut ? ' TIMEOUT' : ''}`)
      if (verbose) console.log(`       ops ${JSON.stringify(m.shape.counts)}`)
    }
    out[path] = { label: PAGE_LABELS[path], spec: specs[path], runs }
  }
  return out
}

const med = (xs) => { const s = [...xs].sort((a, c) => a - c); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2 }

function summarize(measured) {
  const rows = {}
  for (const [path, m] of Object.entries(measured)) {
    const pick = (field) => m.runs.map((r) => r[field]).filter((v) => v != null)
    rows[path] = {
      label: m.label,
      firstRowsS: pick('firstRowsS').length ? med(pick('firstRowsS')) : null,
      settledS: med(pick('settledS')),
      requests: med(pick('requests')),
      mb: med(pick('mb')),
      p95: { firstRows: percentile(pick('firstRowsS'), 95), settled: percentile(pick('settledS'), 95), requests: percentile(pick('requests'), 95), mb: percentile(pick('mb'), 95) },
      rowsAtEnd: m.runs.map((r) => r.rows),
      fullTableOps: [...new Set(m.runs.flatMap((r) => r.shape.fullTable))],
      mutations: [...new Set(m.runs.flatMap((r) => r.shape.mutations))],
      maxChainDepth: Math.max(...m.runs.map((r) => r.shape.maxDepth)),
      repeated: m.runs.flatMap((r) => r.shape.repeated),
      problems: m.runs.flatMap((r) => Object.entries(r.problems).flatMap(([k, v]) => v.map((x) => `${k}: ${x}`))).slice(0, 10),
      dashboardKpi: m.runs.map((r) => r.kpiSub).filter(Boolean),
    }
  }
  return rows
}

function printTable(summary) {
  console.log('\n page'.padEnd(34) + 'first s'.padStart(9) + 'settled s'.padStart(11) + 'req'.padStart(6) + 'MB'.padStart(8) + '  rows')
  for (const [path, r] of Object.entries(summary)) {
    console.log(` ${path}`.padEnd(33) + fmt(r.firstRowsS).padStart(9) + fmt(r.settledS).padStart(11) + String(r.requests).padStart(6) + fmt(r.mb).padStart(8) + `  ${r.rowsAtEnd.join('/')}`)
  }
}

async function withBrowser(fn) {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyPerf refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyPerf refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (origin !== DEV_ORIGIN) throw new Error(`devVerifyPerf only measures ${DEV_ORIGIN} (got ${origin}): localhost talks to the production API`)
  const email = `zz-perf-${Date.now()}@example.invalid`
  let made = false
  let b = null
  try {
    const admin = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    console.log('identity: temporary admin created')
    const expected = await expectedCounts(admin.token)
    console.log(`expected (independent API reads): ${JSON.stringify(expected)}`)
    b = await launchBrowser({ origin, storage: admin.storage, profilePrefix: 'bcat-perf-', purpose: 'Perf verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
    return await fn({ b, expected, token: admin.token })
  } finally {
    await b?.close().catch(() => {})
    if (made) console.log(`identity deleted: ${await deleteIdentity(email)}`)
  }
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())

async function baseline() {
  const paths = PAGES ?? PAGE_PATHS
  const startedAt = new Date().toISOString()
  const { measured, expected } = await withBrowser(async ({ b, expected }) => ({ measured: await measureAll(b, pageSpecs(expected), paths), expected }))
  const summary = summarize(measured)
  printTable(summary)
  const file = resolve(PERF_DIR, `baseline-${today()}.json`)
  await mkdir(PERF_DIR, { recursive: true })
  const body = { kind: 'pre-change baseline (PERF-plan §11.4)', startedAt, origin: DEV_ORIGIN, runs: RUNS, expected, summary, raw: Object.fromEntries(Object.entries(measured).map(([p, m]) => [p, m.runs.map((r) => ({ firstRowsS: r.firstRowsS, settledS: r.settledS, requests: r.requests, mb: r.mb, rows: r.rows, charts: r.charts, timedOut: r.timedOut, ops: r.shape.counts }))])) }
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`)
  console.log(`baseline written: ${file}`)
}

// ───────────────────────────── full gate ─────────────────────────────
function runApiGates() {
  return new Promise((done) => {
    const child = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.app.json', 'scripts/devVerifyPerfApi.mts'], { stdio: 'inherit' })
    child.on('exit', (code) => done(code === 0))
    child.on('error', () => done(false))
  })
}

async function fullGate() {
  let ok = await inventory()
  const paths = PAGES ?? PAGE_PATHS
  const { measured } = await withBrowser(async ({ b, expected }) => ({ measured: await measureAll(b, pageSpecs(expected), paths) }))
  const summary = summarize(measured)
  printTable(summary)
  await mkdir(PERF_DIR, { recursive: true })
  await writeFile(resolve(PERF_DIR, 'last-run.json'), `${JSON.stringify({ at: new Date().toISOString(), summary }, null, 2)}\n`)

  const missing = checkSpecs(Object.keys(measured), Object.fromEntries(paths.map((p) => [p, PAGE_BUDGETS[p]])))
  if (missing.length) { record('FAIL', 'G3 page coverage', `no measurement for ${missing.join(', ')}`); ok = false }
  for (const path of paths) {
    const m = measured[path]
    const g3 = evaluate({ runs: m.runs }, PAGE_BUDGETS[path])
    record(g3.ok ? 'PASS' : 'FAIL', `G3 ${path}`, g3.ok ? `${fmt(summary[path].settledS)} s settled, ${summary[path].requests} req, ${fmt(summary[path].mb)} MB` : g3.failures.join('; '))
    if (!g3.ok) ok = false
    const s = summary[path]
    const g4 = []
    if (s.fullTableOps.length) g4.push(`full-table ops: ${s.fullTableOps.join(', ')}`)
    if (s.maxChainDepth > MAX_CHAIN_DEPTH) g4.push(`nextToken chain depth ${s.maxChainDepth} > ${MAX_CHAIN_DEPTH}`)
    if (s.repeated.length) g4.push(`issued > ${MAX_REPEATS}x: ${s.repeated.map((r) => `${r.op} x${r.times}`).join(', ')}`)
    record(g4.length ? 'FAIL' : 'PASS', `G4 ${path}`, g4.join('; '))
    if (g4.length) ok = false
    const g0 = []
    if (s.mutations.length) g0.push(`mutations seen: ${s.mutations.join(', ')}`)
    if (s.problems.length) g0.push(`browser problems: ${s.problems.slice(0, 3).join(' | ')}`)
    if (g0.length) { record('FAIL', `G0 ${path}`, g0.join('; ')); ok = false }
  }
  if (measured[SHELL_FLOOR_PATH]) {
    const f = summary[SHELL_FLOOR_PATH]
    const bad = []
    if (f.settledS > SHELL_FLOOR.settled) bad.push(`settled ${fmt(f.settledS)} > ${SHELL_FLOOR.settled}`)
    if (f.requests > SHELL_FLOOR.requests) bad.push(`requests ${f.requests} > ${SHELL_FLOOR.requests}`)
    if (f.mb > SHELL_FLOOR.mb) bad.push(`MB ${fmt(f.mb)} > ${SHELL_FLOOR.mb}`)
    record(bad.length ? 'FAIL' : 'PASS', 'G8 shell floor', bad.join('; '))
    if (bad.length) ok = false
  }
  if (!flag('no-api')) {
    const apiOk = await runApiGates()
    record(apiOk ? 'PASS' : 'FAIL', 'G1/G2/G7 API gates (devVerifyPerfApi.mts)')
    if (!apiOk) ok = false
  }
  return ok
}

async function ratchetBudgets() {
  const last = JSON.parse(await readFile(resolve(PERF_DIR, 'last-run.json'), 'utf8'))
  const p95 = Object.fromEntries(Object.entries(last.summary).map(([p, r]) => [p, r.p95]))
  const next = ratchet(PAGE_BUDGETS, p95)
  let changed = 0
  for (const path of Object.keys(next)) {
    for (const [key] of METRICS) {
      if (next[path][key] !== PAGE_BUDGETS[path][key]) { changed += 1; console.log(`  ${path} ${key}: ${PAGE_BUDGETS[path][key]} -> ${next[path][key]}`) }
    }
  }
  const file = resolve('scripts/lib/perfBudgets.mjs')
  await writeFile(file, rewriteBudgets(await readFile(file, 'utf8'), next))
  console.log(`ratchet: ${changed} ceiling(s) lowered (never raised) in ${file}; max-run factor stays ${MAX_FACTOR}x`)
}

async function main() {
  if (flag('inventory')) { if (!(await inventory())) process.exitCode = 1; return }
  if (flag('ratchet')) { await ratchetBudgets(); return }
  if (flag('baseline')) { await baseline(); return }
  const ok = await fullGate()
  const failed = results.filter((r) => r.status === 'FAIL')
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  if (!ok || failed.length) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyPerf failed: ${err?.message ?? err}`); process.exit(1) })
}
