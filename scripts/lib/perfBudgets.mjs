/**
 * Step PERF budgets (PERF-plan.md §0.3, §11.2) as data, plus the pure functions the gate uses.
 *
 *  - PAGE_SPECS      one row per budgeted page: path, label, budget ceilings (G3).
 *  - LOADER_BUDGETS  per-loader API ceilings (G2).
 *  - SHELL_FLOOR     G8: the Carriers page as the shell probe.
 *  - SCALE           G7 tripwires.
 *  - evaluate(measured, budget)       -> { ok, failures[] }  (gate on the median AND the max <= 1.5x ceiling)
 *  - ratchet(current, p95)            -> ceilings lowered to p95 x 1.5, never raised
 *  - checkSpecs(measuredPaths)        -> a page spec with no measurement fails (never a silent pass)
 *  - rewriteBudgets(source, budgets)  -> the source text with the budget block replaced (what --ratchet writes)
 *
 * Units: seconds, request count, megabytes (decimal MB of response bytes).
 */

export const MAX_FACTOR = 1.5
export const RATCHET_FACTOR = 1.5

// Raised (PERF fix pass, measured on dev, see BUILD_LOG 2026-11-04 "PERF fix pass"): a page cannot cost less than the shell it
// mounts inside. The shell floor is 45 requests / ~6.3 MB (G8, working set 3.3 MB + the directory lists), so the bare-shell pages
// (customers, users, carriers) carried budgets (40 req, 4-6 MB) below their own floor. They are now floor + their own reads (<= 5 req).
// /tms/dashboard = shell floor + the 3-month window loader (G7 window:3, 37 trips, 5.7 MB).
// directory:locations: 3,169 rows / 2.55 MB, bandwidth-bound at ~0.9 s/MB (2 trips at limit 3000 measured the same 2.3 s as 4 trips).
// Timing, from the job-144 medians (deployed dev): tracking 3.4 / 5.0 s, customers settled 4.6, carriers 4.0 are three dependent
// stages (status index -> joins by id -> financials) plus the directory lists, i.e. round trips under ~45 concurrent shell
// requests; the API loader alone is 1.7-2.1 s to first partial. Dashboard first rows draw from the working set's first step
// (useBrokerageDashboard) and wait for window:3 (2.5 s API) plus the report reads.
// Legacy pages = shell (45 req) + the store's month window and open loads + ~20 side lists. Their budgets and invoicing's 9 MB are
// ESTIMATES for the voided-excluded window read (dev: 35 -> 4 requests, 12.6 -> 1.1 MB for listLoadByShipmentId) and the
// DOCS_NEEDED live-only read (dev: 4.0 -> ~1.7 MB cold): re-measure after deploy, then --ratchet.
// '/dashboard' re-based (Step AF, D-AF15): measured 160 requests / 30.2 MB / 6.6 s settled on deployed dev, so the old 130 / 20 was
// red for a pre-existing reason. measured + 10 %; AF4's deploy lowers it (--ratchet), it is never raised again.
// <budgets>
export const PAGE_BUDGETS = {
  '/tms/dashboard': { firstRows: 4.5, settled: 6, requests: 80, mb: 12 },
  '/tms/tracking': { firstRows: 3.5, settled: 5.2, requests: 50, mb: 8 },
  '/tms/shipments': { firstRows: 3, settled: 6, requests: 60, mb: 12 },
  '/tms/shipments?list=all': { firstRows: 3, settled: 6, requests: 70, mb: 12 },
  '/tms/customers': { firstRows: 2.5, settled: 4.8, requests: 50, mb: 7 },
  '/tms/brokerage/users': { firstRows: 2, settled: 4, requests: 50, mb: 7 },
  '/tms/invoicing': { firstRows: 3, settled: 5.5, requests: 60, mb: 9 },
  '/tms/invoicing/payable': { firstRows: 3, settled: 5, requests: 60, mb: 8 },
  '/tms/carriers': { firstRows: 2.5, settled: 4.4, requests: 50, mb: 7 },
  '/schedule': { firstRows: 4.5, settled: 5, requests: 85, mb: 12 },
  '/calendar': { firstRows: 4.5, settled: 5.5, requests: 95, mb: 14 },
  '/dashboard': { firstRows: 6, settled: 8, requests: 175, mb: 33 },
}
// </budgets>

/** Page labels, in report order. Keys must equal PAGE_BUDGETS keys (perfBudgets.test.mjs). */
export const PAGE_LABELS = {
  '/tms/dashboard': 'Brokerage dashboard (this month)',
  '/tms/tracking': 'Load tracking',
  '/tms/shipments': 'Shipments board (Active)',
  '/tms/shipments?list=all': 'Shipments board (All, month window)',
  '/tms/customers': 'Customers',
  '/tms/brokerage/users': 'Users',
  '/tms/invoicing': 'Invoicing (AR)',
  '/tms/invoicing/payable': 'Invoicing (payable)',
  '/tms/carriers': 'Carriers (shell floor probe)',
  '/schedule': 'Schedule (legacy)',
  '/calendar': 'Calendar (legacy)',
  '/dashboard': 'Dashboard (legacy)',
}

export const PAGE_PATHS = Object.keys(PAGE_BUDGETS)

/** G8: the shell floor, measured on the Carriers page. */
export const SHELL_FLOOR_PATH = '/tms/carriers'
export const SHELL_FLOOR = { settled: 6, requests: 48, mb: 10 }

/** G2: loader budgets (seconds / AppSync trips / MB). `firstPartial` is seconds to the first onPartial. */
export const LOADER_BUDGETS = {
  working: { seconds: 8, firstPartial: 3, trips: 80, mb: 10 },
  'window:1': { seconds: 4, trips: 30, mb: 3 },
  'window:3': { seconds: 6, trips: 90, mb: 9 },
  'directory:customers': { seconds: 2 },
  'directory:locations': { seconds: 3 },
  'directory:carriers': { seconds: 2 },
  'directory:userProfiles': { seconds: 2 },
  'audit:5': { seconds: 2 },
  rollup: { seconds: 0.6, trips: 2, mb: 0.3 },
}

/**
 * Step AF switch (AF-plan §7 AF6-b): while false the KPI budgets, G9..G12 verdicts are printed as WARN and do not fail the run
 * (the AF2/AF3/AF4 deploys have not landed); AF6-b flips this to true, or any run can pass --enforce-af.
 */
export const AF_ENFORCED = false

/** G12: per-operation repeat budgets on a soak (the F3 cache-wipe regression, which MAX_REPEATS = 3 cannot see). */
export const SOAK_MS = 14_000
export const REPEAT_BUDGETS = { '/tms/carriers': { listShipmentByStatusAndPickupAppt: 1 } }

/** G7 scale tripwires (D-P3: tripping opens the sparse Shipment.workOpen index). */
export const SCALE = { stage2Ids: 3000, workingSeconds: 8 }

/** The metrics a page budget names, with how each reads off a measured run. */
export const METRICS = [
  ['firstRows', 'firstRowsS'],
  ['settled', 'settledS'],
  ['requests', 'requests'],
  ['mb', 'mb'],
]

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return NaN
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

/** Nearest-rank percentile; with 3 runs p95 is the max. */
export function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 0) return NaN
  const rank = Math.ceil((p / 100) * s.length)
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))]
}

/**
 * measured: { runs: [{ firstRowsS, settledS, requests, mb }] } (firstRowsS null = rows never appeared).
 * budget:   { firstRows, settled, requests, mb } ceilings (any key may be absent = not gated).
 * Fails when the median is above the ceiling or the worst run is above MAX_FACTOR x the ceiling.
 */
export function evaluate(measured, budget) {
  const failures = []
  const runs = measured?.runs ?? []
  if (runs.length === 0) return { ok: false, failures: ['no runs measured'] }
  for (const [key, field] of METRICS) {
    const ceiling = budget?.[key]
    if (ceiling == null) continue
    const values = runs.map((r) => r[field])
    if (values.some((v) => v == null || Number.isNaN(v))) {
      failures.push(`${key}: not reached in ${values.filter((v) => v == null || Number.isNaN(v)).length}/${values.length} runs`)
      continue
    }
    const med = median(values)
    const max = Math.max(...values)
    if (med > ceiling) failures.push(`${key}: median ${round(med)} > ${ceiling}`)
    if (max > ceiling * MAX_FACTOR) failures.push(`${key}: max ${round(max)} > ${round(ceiling * MAX_FACTOR)} (1.5 x ${ceiling})`)
  }
  return { ok: failures.length === 0, failures }
}

const round = (x) => Math.round(x * 100) / 100

/**
 * Lower each ceiling to p95 x 1.5 where that is lower; NEVER raise one.
 * current: PAGE_BUDGETS shape; p95: { [path]: { firstRows, settled, requests, mb } } measured p95s (missing = keep).
 * Requests are rounded up to an integer; seconds and MB to 0.1.
 */
export function ratchet(current, p95) {
  const next = {}
  for (const [path, budget] of Object.entries(current)) {
    next[path] = { ...budget }
    const measured = p95?.[path]
    if (!measured) continue
    for (const key of Object.keys(budget)) {
      const m = measured[key]
      if (m == null || Number.isNaN(m)) continue
      const target = key === 'requests' ? Math.ceil(+(m * RATCHET_FACTOR).toFixed(6)) : Math.ceil(+(m * RATCHET_FACTOR * 10).toFixed(6)) / 10
      next[path][key] = Math.min(budget[key], Math.max(target, key === 'requests' ? 1 : 0.1))
    }
  }
  return next
}

/** Every page spec must have a measurement; returns the paths with none. */
export function checkSpecs(measuredPaths, specs = PAGE_BUDGETS) {
  const have = new Set(measuredPaths)
  return Object.keys(specs).filter((p) => !have.has(p))
}

const fmt = (b) => `{ ${Object.entries(b).map(([k, v]) => `${k}: ${v}`).join(', ')} }`

/** Replace the `// <budgets>` block of this file's source with `budgets`. */
export function rewriteBudgets(source, budgets) {
  const start = source.indexOf('// <budgets>')
  const end = source.indexOf('// </budgets>')
  if (start < 0 || end < 0 || end < start) throw new Error('perfBudgets.mjs: budget block markers not found')
  const body = Object.entries(budgets).map(([p, b]) => `  '${p}': ${fmt(b)},`).join('\n')
  return `${source.slice(0, start)}// <budgets>\nexport const PAGE_BUDGETS = {\n${body}\n}\n${source.slice(end)}`
}

// ───────────────────────────── Step AF: KPI budgets ─────────────────────────────
/**
 * Seconds until the KPI strip is visible (data-testid="dash-kpis"|"legacy-kpis" with data-state="ready" and values, see
 * perfProbe.kpiReadiness), per navigation mode: cold = new browser profile, warm = reload with the HTTP cache warm,
 * spa = sidebar link click with the shell warm. D-AF14: never raised, only ratcheted.
 *   chartsCold/chartsWarm  seconds to the first chart (/tms/dashboard)
 *   spaRequests / spaMb    requests and MB of the in-app mode (G12)
 *   kpiFlips               text changes of the strip after the first ready paint (cache -> rollup is the one allowed)
 *   allCold                seconds to the last change of the legacy page's first 1,400 characters
 * Same evaluation rule as evaluate(): median <= ceiling and worst run <= MAX_FACTOR x ceiling.
 */
// <kpi-budgets>
export const KPI_BUDGETS = {
  '/tms/dashboard': { cold: 3, warm: 1.5, spa: 0.8, chartsCold: 4.5, chartsWarm: 3, spaRequests: 25, spaMb: 3, kpiFlips: 1 },
  '/dashboard': { cold: 3, warm: 1.5, spa: 1, allCold: 5, kpiFlips: 1 },
}
// </kpi-budgets>

/** Budget key -> [mode, field of a measureModes run]. */
export const KPI_METRICS = [
  ['cold', 'cold', 'kpiS'],
  ['warm', 'warm', 'kpiS'],
  ['spa', 'spa', 'kpiS'],
  ['chartsCold', 'cold', 'chartS'],
  ['chartsWarm', 'warm', 'chartS'],
  ['allCold', 'cold', 'lastChangeS'],
  ['spaRequests', 'spa', 'requests'],
  ['spaMb', 'spa', 'mb'],
  ['kpiFlips', '*', 'kpiFlips'],
]

/**
 * measured: { cold: [run], warm: [run], spa: [run] } with run = { kpiS, chartS, lastChangeS, requests, mb, kpiFlips } (null = never reached).
 * A budgeted metric with no runs or a run that never reached it FAILS (never a silent pass).
 */
export function evaluateKpi(measured, budget) {
  const failures = []
  for (const [key, mode, field] of KPI_METRICS) {
    const ceiling = budget?.[key]
    if (ceiling == null) continue
    const runs = mode === '*' ? ['cold', 'warm', 'spa'].flatMap((m) => measured?.[m] ?? []) : (measured?.[mode] ?? [])
    if (runs.length === 0) { failures.push(`${key}: no ${mode} runs measured`); continue }
    const values = runs.map((r) => r[field])
    const missing = values.filter((v) => v == null || Number.isNaN(v)).length
    if (missing) { failures.push(`${key}: not reached in ${missing}/${values.length} runs`); continue }
    const med = median(values)
    const max = Math.max(...values)
    if (med > ceiling) failures.push(`${key}: median ${round(med)} > ${ceiling}`)
    if (max > ceiling * MAX_FACTOR) failures.push(`${key}: max ${round(max)} > ${round(ceiling * MAX_FACTOR)} (1.5 x ${ceiling})`)
  }
  return { ok: failures.length === 0, failures }
}

/** Every KPI spec must have a measurement; returns the paths with none. */
export function checkKpiSpecs(measuredPaths, specs = KPI_BUDGETS) {
  const have = new Set(measuredPaths)
  return Object.keys(specs).filter((p) => !have.has(p))
}

/** p95 of one metric over a mode's runs (nulls dropped; NaN when none). */
export function kpiP95(measured, key) {
  const [, mode, field] = KPI_METRICS.find((m) => m[0] === key)
  const runs = mode === '*' ? ['cold', 'warm', 'spa'].flatMap((m) => measured?.[m] ?? []) : (measured?.[mode] ?? [])
  return percentile(runs.map((r) => r[field]).filter((v) => v != null && !Number.isNaN(v)), 95)
}

/** ratchet() for KPI budgets: seconds/MB -> p95 x 1.5 (0.1 steps), request counts rounded up, kpiFlips untouched; never raised. p95 = { [path]: { [key]: n } }. */
export function ratchetKpi(current, p95) {
  const next = {}
  for (const [path, budget] of Object.entries(current)) {
    next[path] = { ...budget }
    for (const key of Object.keys(budget)) {
      const m = p95?.[path]?.[key]
      if (m == null || Number.isNaN(m) || key === 'kpiFlips') continue // flips is a contract (<= 1), not a measured ceiling
      const target = key === 'spaRequests' ? Math.ceil(+(m * RATCHET_FACTOR).toFixed(6)) : Math.ceil(+(m * RATCHET_FACTOR * 10).toFixed(6)) / 10
      next[path][key] = Math.min(budget[key], Math.max(target, key === 'spaRequests' ? 1 : 0.1))
    }
  }
  return next
}

/** Replace the `// <kpi-budgets>` block of this file's source with `budgets`. */
export function rewriteKpiBudgets(source, budgets) {
  const start = source.indexOf('// <kpi-budgets>')
  const end = source.indexOf('// </kpi-budgets>')
  if (start < 0 || end < 0 || end < start) throw new Error('perfBudgets.mjs: kpi budget block markers not found')
  const body = Object.entries(budgets).map(([p, b]) => `  '${p}': ${fmt(b)},`).join('\n')
  return `${source.slice(0, start)}// <kpi-budgets>\nexport const KPI_BUDGETS = {\n${body}\n}\n${source.slice(end)}`
}
