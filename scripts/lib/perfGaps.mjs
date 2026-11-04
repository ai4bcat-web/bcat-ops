/**
 * Static gates of devVerifyPerf (no network, no browser): PERF-plan.md §11.2 G5 and G6.
 *
 *  G5  perfGaps(root)      R1 full-table callers outside the allowlist; `useDirectory(` calls that neither pass `locations: false`
 *                          nor sit on the "needs locations" allowlist; poll hooks with a `setInterval` and no `visibilityState`.
 *  G6  moneyFreeze(root, base)  the frozen money files carry no diff against `base`; the pay/metrics hooks only differ on the
 *                          `ensureLoadRange` lines (PF4 contract: useEnsureLoadRange import + call, or the windowed owner-operator fetch).
 *
 * The scanners are pure over a { path: text } map (`scanR1`, `scanDirectory`, `scanPolls`, `payHookViolations`) so the unit
 * test drives them with fixtures; the exported wrappers add the file system and git.
 */
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)

// ───────────────────────────── G5 ─────────────────────────────
export const R1_SYMBOLS = ['listShipments', 'listOrders', 'listLoads', 'listLoadSummaries', 'listLoadCarriers', 'listLoadFinancials']
/** Files allowed to call the full-table lists (R1): the definitions, and boardData's explicit `kind:'all'` export path. */
export const R1_ALLOW = (path) => path === 'src/lib/apiClient.ts' || path === 'src/lib/boardData.ts' || /\.test\.[jt]sx?$/.test(path) || path.startsWith('scripts/')

/** `useDirectory(` call sites that legitimately read locations: file -> how many such calls it may keep. */
export const NEEDS_LOCATIONS = {
  'src/features/loads/LoadDrawer.tsx': 2, // drawer directory + form directory
  'src/features/shipments/components/NewShipmentDialog.tsx': 1,
  'src/features/shipments/ShipmentPage.tsx': 1,
  'src/features/shipments/ShipmentsBoard.tsx': 1,
  'src/features/calendar/SchedulerView.tsx': 1,
  'src/features/factoring/FactoringPage.tsx': 1,
  'src/components/ApptProofPanel.tsx': 1,
  'src/features/directory/DirectoryPages.tsx': 1, // LocationsPage; CustomersPage passes locations:false
}

/** Hooks that poll: each `setInterval` must be gated on `document.visibilityState` (R7). */
export const POLL_HOOKS = ['src/hooks/useReviewQueue.ts', 'src/hooks/useIntakeItems.ts', 'src/hooks/useDispatchUnread.ts']

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** R1 hits: [{ path, line, symbol }]. Calls only (`name(`), definitions and imports are not hits. */
export function scanR1(files) {
  const hits = []
  for (const [path, raw] of Object.entries(files)) {
    if (R1_ALLOW(path)) continue
    const text = stripComments(raw)
    for (const symbol of R1_SYMBOLS) {
      for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9_.])${symbol}\\s*\\(`, 'g'))) {
        if (/\b(function|const|async)\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue
        hits.push({ path, line: lineOf(text, m.index), symbol })
      }
    }
    for (const m of text.matchAll(/(?<![A-Za-z0-9_.])listAuditLogs\s*\(\s*\)/g)) hits.push({ path, line: lineOf(text, m.index), symbol: 'listAuditLogs()' })
  }
  return hits
}

/** The text of a call's argument list starting at the `(` at `open`. */
function callArgs(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return text.slice(open + 1, i) }
  }
  return text.slice(open + 1)
}

/** `useDirectory(` hits: [{ path, line }] for calls with no `locations:` option (or `locations: true`) beyond the file's allowance. */
export function scanDirectory(files) {
  const hits = []
  for (const [path, raw] of Object.entries(files)) {
    if (path === 'src/hooks/useDirectory.ts' || /\.test\.[jt]sx?$/.test(path)) continue
    const text = stripComments(raw)
    const bare = []
    for (const m of text.matchAll(/(?<![A-Za-z0-9_.])useDirectory\s*\(/g)) {
      const args = callArgs(text, m.index + m[0].length - 1)
      if (!/locations\s*:(?!\s*true\b)/.test(args)) bare.push(lineOf(text, m.index))
    }
    const allowed = NEEDS_LOCATIONS[path] ?? 0
    for (const line of bare.slice(allowed)) hits.push({ path, line })
  }
  return hits
}

/** Poll hooks with `setInterval` and no `visibilityState`: [{ path }]. `files` need only hold the POLL_HOOKS that exist. */
export function scanPolls(files) {
  const hits = []
  for (const [path, raw] of Object.entries(files)) {
    const text = stripComments(raw)
    if (/\bsetInterval\s*\(/.test(text) && !/visibilityState/.test(text)) hits.push({ path })
  }
  return hits
}

async function readTree(root, paths) {
  const out = {}
  for (const path of paths) out[path] = await readFile(join(root, path), 'utf8').catch(() => null)
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null))
}

async function gitFiles(root, pattern) {
  const { stdout } = await run('git', ['ls-files', '--', pattern], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  return stdout.split('\n').filter(Boolean)
}

/** G5 against the working tree: returns { r1, directory, polls } hit lists (all empty = pass). */
export async function perfGaps(root = process.cwd()) {
  const paths = [...await gitFiles(root, 'src/*.ts'), ...await gitFiles(root, 'src/*.tsx')]
  const files = await readTree(root, paths)
  const polls = await readTree(root, POLL_HOOKS)
  return { r1: scanR1(files), directory: scanDirectory(files), polls: scanPolls(polls) }
}

// ───────────────────────────── G11 (Step AF) ─────────────────────────────
/** The six legacy-dashboard widgets that must mount only behind KPI-ready + visible (AF-plan §4.3). */
export const LEGACY_WIDGETS = ['YearProfitWidget', 'PerMileKpis', 'DriverLeaderboardWidget', 'DieselPriceWidget', 'ComplianceAlertsWidget', 'RepairInvoicesWidget']
const isTest = (path) => /\.test\.[jt]sx?$/.test(path)

/**
 * G11 static gaps over { path: text } (comments stripped):
 *   workingSet     src/features/tms/dashboard/** (non-test) carries `kind: 'working'`: the working-set read is gone from the dashboard
 *   financials     the same files import loadFinancials / getLoadFinancials / listLoadFinancials
 *   widgets        src/features/dashboard/DashboardPage.tsx mounts a legacy widget (`<Widget`) outside a <LazyWidget> element
 *   metricsHook    anything under src/ (tests included) still names useDashboardMetrics (deleted by AF4)
 * Each list holds { path, line, ... }.
 */
export function scanAF(files) {
  const out = { workingSet: [], financials: [], widgets: [], metricsHook: [] }
  for (const [path, raw] of Object.entries(files)) {
    const text = stripComments(raw)
    const inCompany = path.startsWith('src/features/tms/dashboard/') && !isTest(path)
    if (inCompany) {
      for (const m of text.matchAll(/kind\s*:\s*['"]working['"]/g)) out.workingSet.push({ path, line: lineOf(text, m.index) })
      for (const m of text.matchAll(/import\s+(?:type\s+)?[^'"]*?\b(loadFinancials|getLoadFinancials|listLoadFinancials)\b[^'"]*?from\s+['"]/g)) out.financials.push({ path, line: lineOf(text, m.index), symbol: m[1] })
    }
    if (path === 'src/features/dashboard/DashboardPage.tsx') {
      const blocks = []
      for (const m of text.matchAll(/<LazyWidget\b/g)) {
        const close = text.indexOf('</LazyWidget>', m.index)
        const next = text.indexOf('<LazyWidget', m.index + 1)
        blocks.push([m.index, close >= 0 && (next < 0 || close < next || next < close) ? close : m.index + 600])
      }
      for (const w of LEGACY_WIDGETS) {
        for (const m of text.matchAll(new RegExp(`<${w}\\b`, 'g'))) {
          if (!blocks.some(([a, b]) => m.index > a && m.index < b)) out.widgets.push({ path, line: lineOf(text, m.index), widget: w })
        }
      }
    }
    if (path.startsWith('src/') && /\buseDashboardMetrics\b/.test(text)) out.metricsHook.push({ path, line: lineOf(text, text.search(/\buseDashboardMetrics\b/)) })
  }
  return out
}

/** G11 against the working tree. */
export async function afStatic(root = process.cwd()) {
  const paths = [...await gitFiles(root, 'src/*.ts'), ...await gitFiles(root, 'src/*.tsx')]
  return scanAF(await readTree(root, paths)) // readTree drops files deleted in the working tree
}

// ───────────────────────────── G6 ─────────────────────────────
/** Pay/metrics hooks Step AF deletes deliberately: a missing file is not a G6 violation (G11 checks nothing still imports it). */
export const REMOVED_BY_AF = ['useDashboardMetrics']
const LIB = ['driverPay', 'commission', 'invoiceBuild', 'quickPay', 'profitReview', 'otrInvoice', 'otrInvoiceStatus', 'factoringTotals', 'payPeriod', 'payPeriods', 'carrierBill', 'customerCredit', 'arAging', 'releaseGate', 'carrierEligibility']
/** No diff at all. */
export const FROZEN_PATHS = [
  ...LIB.flatMap((n) => [`src/lib/${n}.ts`, `src/lib/${n}.test.ts`]),
  'amplify/functions/tms-shipment-actions/releaseGate.ts',
  'amplify/functions/tms-shipment-actions/documents.ts',
  'amplify/functions/tms-shipment-actions/batch.ts',
]
export const FROZEN_DIRS = ['amplify/functions/tms-finance-actions/', 'amplify/functions/driver-pay-emailer/', 'amplify/functions/paychex-pay-sync/', 'amplify/functions/otr-actions/']
/** Pay/metrics hooks: only the windowing lines may differ (matched by basename). */
export const PAY_HOOKS = ['useBoxTruckPay', 'useProfitReview', 'useFleetProfitability', 'useDeadhead', 'useTruckOdometer', 'useOwnerOperatorPay', 'useOwnerOperatorProfitability', 'useMonthlyMetrics', 'useDashboardMetrics']
/**
 * Pay-hook allowlist (PF4 contract). A changed line in a pay/metrics hook is accepted ONLY for one of these reasons:
 *  1. it names a windowing symbol (WINDOW_SYMBOLS): the store call that loads the rows the hook already filtered to;
 *  2. it carries the `ready` flag `useEnsureLoadRange` returns (`loading || !ready`): the hook must not compute on a partial window (K6);
 *  3. it is the old/new form of a line that differs only by those tokens (an import list gaining `useEnsureLoadRange`, a `loading`
 *     expression gaining `|| !ready`, an import dropping `listLoads` / the `Load` type);
 *  4. a bare import-list identifier (`addDays,`) that a windowing line uses (useTruckOdometer's week end);
 *  5. only in a file that REPLACES its own `listLoads()` fetch with the windowed store read (the two owner-operator hooks):
 *     the fetch plumbing (FETCH_SWAP) and the `today` range end (TODAY_RANGE) feeding `useEnsureLoadRange`.
 * Nothing else: any math, filter or output-shape change is a G6 failure. Reading the full Load table is R1's job (G5).
 */
const WINDOW_SYMBOLS = ['useEnsureLoadRange', 'ensureLoadRange', 'listLoadsByShipmentIds', 'listShipmentIdsByMonths', 'monthsCovering', 'OWNER_OP_FIRST_PERIOD']
export const PAY_HOOK_ALLOWED = new RegExp(`${WINDOW_SYMBOLS.join('|')}|\\bready\\b`)
/** Reason 5a: the fetch plumbing the swap removes/adds. */
const FETCH_SWAP = /useLoads|setLoads|\bLoad\b|\.then\(\(\[|^\s*listLoads,?\s*$/
/** Reason 5b: the range end the owner-operator hooks hand to useEnsureLoadRange (comment + lazy `today` state). */
const TODAY_RANGE = /\btoday\b/

const normalize = (line) => line
  .replace(/listLoads\(\)\s*,?/g, '')
  .replace(new RegExp(`${WINDOW_SYMBOLS.join('|')}|listLoads|\\bLoad\\b`, 'g'), '')
  .replace(/\|\|\s*!ready/g, '')
  .replace(/(\w+)\s*:\s*\1\b/g, '$1')
  .replace(/[\s,;]/g, '')

/**
 * Reason 6: per-file exceptions ordered by Main. `useDashboardMetrics`' needs-invoice KPI must stay exact over ALL history, so
 * the all-time backlog (src/hooks/useNeedsInvoiceBacklog.ts) is merged into the windowed loads before the UNCHANGED predicate runs.
 * Matched on trimmed text so indentation changes do not matter; the predicate lines (deliveryApptType / deliveryAppt / readyToInvoice) are NOT listed.
 */
export const PAY_HOOK_EXTRA = {
  'useDashboardMetrics.ts': [
    /useNeedsInvoiceBacklog/,
    /^const held = new Set\(allLoads\.map\(\(l\) => l\.id\)\)$/,
    /^const needsInvoice = \(backlog\.length > 0 \? \[\.\.\.loads, \.\.\.backlog\.filter\(\(l\) => !held\.has\(l\.id\)\)\] : loads\)\.filter\($/,
    /^const needsInvoice = loads\.filter\($/,
    /^\}, \[loads, allLoads, backlog, drivers, rangeKey\]\)$/,
    /^\}, \[loads, drivers, rangeKey\]\)$/,
  ],
}

/** Lines of a `git diff -U0` for one pay hook that are NOT allowlisted windowing changes (see the reasons above). `path` selects PAY_HOOK_EXTRA. */
export function payHookViolations(diffText, path = '') {
  const extra = PAY_HOOK_EXTRA[path.split('/').pop()] ?? []
  const listed = (l) => extra.some((re) => re.test(l.trim()))
  const added = []
  const removed = []
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added.push(line.slice(1))
    else if (line.startsWith('-')) removed.push(line.slice(1))
  }
  const windowed = added.filter((l) => PAY_HOOK_ALLOWED.test(l))
  const swap = removed.some((l) => /\blistLoads\b/.test(l)) && windowed.length > 0
  const normAdded = new Set(added.map(normalize))
  const normRemoved = new Set(removed.filter((l) => l.trim() !== '').map(normalize))
  const used = (id) => windowed.some((l) => new RegExp(`\\b${id}\\b`).test(l))
  const bad = []
  for (const l of added) {
    if (PAY_HOOK_ALLOWED.test(l) || listed(l)) continue
    const ident = /^\s*(\w+),\s*$/.exec(l)?.[1]
    if (ident && used(ident)) continue
    if (swap && (FETCH_SWAP.test(l) || TODAY_RANGE.test(l))) continue
    if (normRemoved.has(normalize(l))) continue
    bad.push(`+${l}`)
  }
  for (const l of removed) {
    if (l.trim() === '' || listed(l)) continue
    if (normAdded.has(normalize(l)) || (swap && (FETCH_SWAP.test(l) || /\blistLoads\b/.test(l)))) continue
    bad.push(`-${l}`)
  }
  return bad
}

/** G6: { frozen: [paths changed], payHooks: [{ path, lines }] } relative to `base` (working tree included). */
export async function moneyFreeze(root = process.cwd(), base = 'HEAD') {
  const diffNames = async (paths) => {
    if (paths.length === 0) return []
    const { stdout } = await run('git', ['diff', '--name-only', base, '--', ...paths], { cwd: root })
    return stdout.split('\n').filter(Boolean)
  }
  const frozen = [...await diffNames(FROZEN_PATHS), ...await diffNames(FROZEN_DIRS)]
  const payPaths = []
  for (const name of PAY_HOOKS) payPaths.push(...await gitFiles(root, `src/**/${name}.ts`), ...await gitFiles(root, `src/**/${name}.tsx`))
  const payHooks = []
  for (const path of payPaths) {
    if (REMOVED_BY_AF.includes(path.split('/').pop().replace(/\.tsx?$/, '')) && !(await readFile(join(root, path), 'utf8').catch(() => null))) continue // Step AF4 deletes it on purpose (G11 enforces that nothing names it)
    const { stdout } = await run('git', ['diff', '-U0', base, '--', path], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    const lines = payHookViolations(stdout, path)
    if (lines.length > 0) payHooks.push({ path, lines })
  }
  return { frozen, payHooks }
}
