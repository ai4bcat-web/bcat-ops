#!/usr/bin/env node
/**
 * Step PERF verification against the DEV site: page budgets, request shape, shell floor, static gaps, money freeze
 * (PERF-plan.md §11). Read-only: no seeds, no writes; a mutation seen in the fetch log is itself a failure (G0).
 *
 *   node scripts/devVerifyPerf.mjs --inventory           no network, no browser: G5 static gaps + G6 money freeze + spec completeness
 *   node scripts/devVerifyPerf.mjs --baseline            pre-change numbers: 12 pages x 3 cold runs -> Docs/tms-build/perf/baseline-<date>.json
 *   node scripts/devVerifyPerf.mjs                       full gate: G0..G8 (browser) + G1/G2/G7 (API, via devVerifyPerfApi.mts)
 *   node scripts/devVerifyPerf.mjs --ratchet             lower every ceiling in perfBudgets.mjs to measured p95 x 1.5 from perf/last-run.json (never raises)
 *   options: --runs=N (default 3)  --pages=/tms/carriers,/schedule  --base=<sha> (G6, default a064b26)  --no-api  --verbose
 *            --no-kpi (skip the Step AF cold/warm/spa KPI modes)  --enforce-af (KPI budgets, G11, G12 fail the run; default: WARN until AF_ENFORCED)
 *
 * Step AF: /tms/dashboard and /dashboard are also measured in three modes (cold / warm / spa, 1440x900) until the KPI strip
 * (data-testid="dash-kpis" | "legacy-kpis", data-state="ready", values present) is visible, against KPI_BUDGETS (G3k); the
 * /tms/carriers soak checks the per-operation repeat budget (G12); G11 is static. G9 (rollup parity) lives in devVerifyPerfApi.mts,
 * G10 (on-write latency, the only writer) in devVerifyAF.mjs.
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
  KPI_BUDGETS, KPI_METRICS, AF_ENFORCED, REPEAT_BUDGETS, SOAK_MS,
  evaluate, ratchet, checkSpecs, rewriteBudgets, percentile,
  evaluateKpi, checkKpiSpecs, kpiP95, ratchetKpi, rewriteKpiBudgets,
} from './lib/perfBudgets.mjs'
import { measurePage, measureModes, measureSoak, repeatViolations, KPI_TESTIDS, MAX_CHAIN_DEPTH, MAX_REPEATS } from './lib/perfProbe.mjs'
import { perfGaps, moneyFreeze, afStatic } from './lib/perfGaps.mjs'
import { expectedCounts } from './lib/perfExpected.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const PERF_DIR = resolve('Docs/tms-build/perf')
// Re-baselined 2364934 (the AA merge, before the PERF pass) -> a064b26 (Main, Step AF6 review of `git diff 2364934 HEAD`): the only frozen
// files that moved since are tms-shipment-actions/batch.ts + documents.ts (Step AP: Load Review gating: requirement checks read revenue/
// expense/profit to REFUSE a push or release, nothing is computed into a stored amount; PUSH_TO_LOAD_REVIEW, batch cap) and
// src/lib/carrierEligibility.ts (+test) (Step AM: applyCoverRules, a pure block/warn verdict over MCP status). No amount, rate, margin,
// financials, invoice or bill arithmetic changed. Any later money change is a real diff against this base.
const DEFAULT_BASE = 'a064b26'
const LEGACY_LOAD_READ = '\\b(listLoads|listLoadBy[A-Za-z]+|getLoad)\\b'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const RUNS = Number(opt('runs') ?? 3)
const PAGES = opt('pages')?.split(',') ?? null
const BASE = opt('base') ?? process.env.PERF_BASE ?? DEFAULT_BASE
const verbose = flag('verbose')
const ENFORCE_AF = AF_ENFORCED || flag('enforce-af')
const KPI_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 }

const results = []
const record = (status, id, detail = '') => {
  results.push({ status, id, detail })
  console.log(`${status.padEnd(4)} ${id}${detail ? `  ${detail}` : ''}`)
}
/** A Step AF verdict: FAIL when enforced, WARN (printed, not failing) until the AF deploys land. Returns whether it counts against the run. */
const recordAF = (bad, id, detail) => {
  record(bad ? (ENFORCE_AF ? 'FAIL' : 'WARN') : 'PASS', id, detail)
  return bad && ENFORCE_AF
}
const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? '—' : n.toFixed(d))

/** The dense grid (Step AC) mounts only the rows in view plus overscan (~31 at 900 px, ~43 at 1000 px), so "first rows" is reached at a window's worth, not at 50/100 rows. */
const DENSE_ROWS_CAP = 20

/** Page -> readiness spec, from independent API reads (expected row counts). */
export function pageSpecs(expected) {
  const rowsOr = (n, cap) => (n === 0 ? { minRows: 0, expectEmpty: true } : { minRows: Math.min(n, cap) })
  return {
    '/tms/dashboard': { minRows: 0, minCharts: 4, kpi: true, kpiTestId: KPI_TESTIDS['/tms/dashboard'] },
    '/tms/tracking': rowsOr(expected.trackingRows, DENSE_ROWS_CAP),
    '/tms/shipments': rowsOr(expected.activeLowerBound, DENSE_ROWS_CAP),
    '/tms/shipments?list=all': rowsOr(expected.activeLowerBound, DENSE_ROWS_CAP),
    '/tms/customers': rowsOr(expected.customers, 50),
    '/tms/brokerage/users': { minRows: 3 },
    '/tms/invoicing': rowsOr(expected.unbilledOrders, 1),
    '/tms/invoicing/payable': rowsOr(expected.openBills, 1),
    '/tms/carriers': rowsOr(expected.carriers, 15),
    '/schedule': { minRows: 0, readyOps: LEGACY_LOAD_READ },
    '/calendar': { minRows: 0, readyOps: LEGACY_LOAD_READ },
    '/dashboard': { minRows: 0, readyOps: LEGACY_LOAD_READ, kpiTestId: KPI_TESTIDS['/dashboard'] },
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

  const af = await afStatic()
  const showAf = (list, f) => list.slice(0, 10).map(f).join('; ')
  const afBad = (list) => list.length > 0
  const at = (h) => `${h.path}:${h.line}`
  if (recordAF(afBad(af.workingSet), 'G11 company dashboard has no working-set read', af.workingSet.length ? showAf(af.workingSet, at) : "no kind: 'working' under src/features/tms/dashboard")) ok = false
  if (recordAF(afBad(af.financials), 'G11 company dashboard imports no loadFinancials', af.financials.length ? showAf(af.financials, (h) => `${at(h)} ${h.symbol}`) : 'none')) ok = false
  if (recordAF(afBad(af.widgets), 'G11 legacy widgets mount only through LazyWidget', af.widgets.length ? showAf(af.widgets, (h) => `${at(h)} ${h.widget}`) : 'none bare')) ok = false
  if (recordAF(afBad(af.metricsHook), 'G11 no useDashboardMetrics', af.metricsHook.length ? showAf(af.metricsHook, at) : 'none')) ok = false
  const kpiMissing = checkKpiSpecs(PAGE_PATHS.filter((p) => KPI_TESTIDS[p]), KPI_BUDGETS)
  const kpiNoId = Object.keys(KPI_BUDGETS).filter((p) => !KPI_TESTIDS[p] || !PAGE_BUDGETS[p])
  if (kpiMissing.length || kpiNoId.length) { record('FAIL', 'KPI spec completeness', JSON.stringify({ kpiMissing, kpiNoId })); ok = false } else record('PASS', 'KPI spec completeness', `${Object.keys(KPI_BUDGETS).length} KPI pages, testids ${Object.values(KPI_TESTIDS).join(', ')}`)

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
      if (verbose) console.log(`       MB per op (sum ${(Object.values(m.shape.bytesByOp).reduce((a, b) => a + b, 0) / 1e6).toFixed(1)}) ${JSON.stringify(Object.fromEntries(Object.entries(m.shape.bytesByOp).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, Number((v / 1e6).toFixed(2))])))}`)
      if (verbose) console.log(`       requests per op ${JSON.stringify(Object.fromEntries(Object.entries(m.shape.requestsByOp).sort((a, b) => b[1] - a[1])))}`)
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
    const launch = () => launchBrowser({ origin, storage: admin.storage, profilePrefix: 'bcat-perf-kpi-', purpose: 'Perf verification (KPI modes)', viewport: KPI_VIEWPORT })
    return await fn({ b, expected, token: admin.token, launch })
  } finally {
    await b?.close().catch(() => {})
    if (made) console.log(`identity deleted: ${await deleteIdentity(email)}`)
  }
}

const KPI_RUNS = () => ({ cold: RUNS, warm: RUNS, spa: RUNS })

/** Step AF modes for every KPI page in `paths`: { [path]: { cold, warm, spa } }. */
async function measureKpiAll(launch, paths) {
  const out = {}
  for (const path of paths.filter((p) => KPI_TESTIDS[p] && KPI_BUDGETS[p])) {
    out[path] = await measureModes(launch, path, { kpiTestId: KPI_TESTIDS[path] }, KPI_RUNS())
    for (const mode of ['cold', 'warm', 'spa']) {
      out[path][mode].forEach((r, i) => console.log(`     ${path} ${mode} ${i + 1}/${RUNS}: KPIs ${fmt(r.kpiS, 2)} s (${r.kpiSource ?? 'never'}${r.kpiAsOf ? ` as of ${r.kpiAsOf}` : ''}), chart ${fmt(r.chartS, 2)} s, last change ${fmt(r.lastChangeS, 2)} s, ${r.requests} req, ${fmt(r.mb)} MB, KPI flips ${r.kpiFlips ?? '—'}, before KPIs ${r.kpiRequests ?? '—'} req / ${fmt(r.kpiMb)} MB${r.timedOut ? ' TIMEOUT' : ''}`))
    }
  }
  return out
}

const KPI_KEYS = ['cold', 'warm', 'spa', 'chartsCold', 'chartsWarm', 'allCold', 'spaRequests', 'spaMb', 'kpiFlips']
function summarizeKpi(kpi) {
  return Object.fromEntries(Object.entries(kpi).map(([path, m]) => [path, {
    medians: Object.fromEntries(KPI_METRICS.map(([key, mode, field]) => {
      const runs = mode === '*' ? ['cold', 'warm', 'spa'].flatMap((x) => m[x]) : m[mode]
      const vals = runs.map((r) => r[field]).filter((v) => v != null)
      return [key, vals.length ? med(vals) : null]
    })),
    p95: Object.fromEntries(KPI_KEYS.map((key) => [key, kpiP95(m, key)])),
    sources: Object.fromEntries(['cold', 'warm', 'spa'].map((mode) => [mode, m[mode].map((r) => r.kpiSource)])),
    mutations: [...new Set(['cold', 'warm', 'spa'].flatMap((mode) => m[mode].flatMap((r) => r.shape.mutations)))],
  }]))
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())

async function baseline() {
  const paths = PAGES ?? PAGE_PATHS
  const startedAt = new Date().toISOString()
  const { measured, expected, kpi } = await withBrowser(async ({ b, expected, launch }) => ({
    measured: await measureAll(b, pageSpecs(expected), paths), expected, kpi: flag('no-kpi') ? {} : await measureKpiAll(launch, paths),
  }))
  const summary = summarize(measured)
  printTable(summary)
  const file = resolve(PERF_DIR, `baseline-${today()}.json`)
  await mkdir(PERF_DIR, { recursive: true })
  const body = { kind: 'pre-change baseline (PERF-plan §11.4)', startedAt, origin: DEV_ORIGIN, runs: RUNS, expected, summary, raw: Object.fromEntries(Object.entries(measured).map(([p, m]) => [p, m.runs.map((r) => ({ firstRowsS: r.firstRowsS, settledS: r.settledS, requests: r.requests, mb: r.mb, rows: r.rows, charts: r.charts, timedOut: r.timedOut, ops: r.shape.counts }))])),
    kpi: Object.fromEntries(Object.entries(kpi).map(([p, m]) => [p, Object.fromEntries(Object.entries(m).map(([mode, runs]) => [mode, runs.map((r) => ({ kpiS: r.kpiS, chartS: r.chartS, lastChangeS: r.lastChangeS, kpiSource: r.kpiSource, kpiRequests: r.kpiRequests, kpiMb: r.kpiMb, kpiFlips: r.kpiFlips, requests: r.requests, mb: r.mb }))]))])) }
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`)
  console.log(`baseline written: ${file}`)
}

// ───────────────────────────── full gate ─────────────────────────────
function runApiGates() {
  return new Promise((done) => {
    const child = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.app.json', 'scripts/devVerifyPerfApi.mts', ...(flag('enforce-af') ? ['--enforce-af'] : [])], { stdio: 'inherit' })
    child.on('exit', (code) => done(code === 0))
    child.on('error', () => done(false))
  })
}

async function fullGate() {
  let ok = await inventory()
  const paths = PAGES ?? PAGE_PATHS
  const { measured, kpi, soak } = await withBrowser(async ({ b, expected, launch }) => {
    const measured = await measureAll(b, pageSpecs(expected), paths)
    const kpi = flag('no-kpi') ? {} : await measureKpiAll(launch, paths)
    const soakPaths = Object.keys(REPEAT_BUDGETS).filter((p) => paths.includes(p))
    const soak = {}
    for (const p of soakPaths) soak[p] = await measureSoak(b, p, {}, SOAK_MS)
    return { measured, kpi, soak }
  })
  const summary = summarize(measured)
  printTable(summary)
  const kpiSummary = summarizeKpi(kpi)
  await mkdir(PERF_DIR, { recursive: true })
  await writeFile(resolve(PERF_DIR, 'last-run.json'), `${JSON.stringify({ at: new Date().toISOString(), summary, kpi: kpiSummary }, null, 2)}\n`)

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
  // G3k: KPI visible budgets (Step AF). A KPI page that was requested but not measured fails like any spec.
  const kpiWanted = paths.filter((p) => KPI_BUDGETS[p] && !flag('no-kpi'))
  for (const path of kpiWanted) {
    if (!kpi[path]) { if (recordAF(true, `G3k ${path}`, 'no KPI measurement')) ok = false; continue }
    const r = evaluateKpi(kpi[path], KPI_BUDGETS[path])
    const m = kpiSummary[path].medians
    if (recordAF(!r.ok, `G3k ${path}`, r.ok ? `KPIs cold ${fmt(m.cold, 2)} / warm ${fmt(m.warm, 2)} / in-app ${fmt(m.spa, 2)} s, flips <= ${KPI_BUDGETS[path].kpiFlips}` : r.failures.join('; '))) ok = false
    if (kpiSummary[path].mutations.length) { record('FAIL', `G0 ${path} (KPI modes)`, `mutations seen: ${kpiSummary[path].mutations.join(', ')}`); ok = false }
  }
  for (const [path, log] of Object.entries(soak)) {
    const bad = repeatViolations(log, REPEAT_BUDGETS[path])
    if (recordAF(bad.length > 0, `G12 ${path} soak ${SOAK_MS / 1000} s repeats`, bad.length ? bad.map((b2) => `${b2.op} started ${b2.times}x (max ${b2.max})`).join('; ') : 'within the per-operation budget')) ok = false
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
  const nextKpi = ratchetKpi(KPI_BUDGETS, Object.fromEntries(Object.entries(last.kpi ?? {}).map(([p, r]) => [p, r.p95])))
  for (const path of Object.keys(nextKpi)) {
    for (const key of Object.keys(nextKpi[path])) {
      if (nextKpi[path][key] !== KPI_BUDGETS[path][key]) { changed += 1; console.log(`  KPI ${path} ${key}: ${KPI_BUDGETS[path][key]} -> ${nextKpi[path][key]}`) }
    }
  }
  const file = resolve('scripts/lib/perfBudgets.mjs')
  await writeFile(file, rewriteKpiBudgets(rewriteBudgets(await readFile(file, 'utf8'), next), nextKpi))
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
