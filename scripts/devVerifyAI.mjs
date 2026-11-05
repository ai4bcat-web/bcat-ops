#!/usr/bin/env node
/**
 * Step AI verification against the DEV site: conversational dashboards (claims, scope gate, per-viewer visibility,
 * spec validation, DASH: rows, UI). Runs ONLY after Main's deploy of the AI batch.
 *
 *   node scripts/devVerifyAI.mjs [--inventory] [--only=<substring>] [--no-ui] [--no-dark] [--skip-model]
 *   DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyAI.mjs
 *
 *   --inventory   no network, no browser: files, claim constants, the seven action names (wired in the router and classified
 *                 read/write as the apiClient cache requires), catalog == model-schema enum == prompt text, the data-testids
 *                 and routes the walk uses, the example specs parse. `node --check` is a separate command.
 *   --only=       run only the steps whose id contains the substring (identities + fixtures are still created; cleanup always runs).
 *   --no-ui       skip the browser step (AI12).
 *   --skip-model  make no model call at all (AI04 and AI10 SKIP; the UI walk falls back to an API-saved spec).
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool, any origin outside ALLOWED_ORIGINS and
 * any DynamoDB table that does not carry the dev suffix. No SSM. At most MODEL_CALL_CAP (12) model calls per run: the dev
 * Anthropic key is real and billed; when the provider refuses (credit, 401, 429, abort) the model steps report the provider's
 * message as an allowed SKIP and the deterministic steps still run (the scope gate does not need the model).
 *
 * Everything it creates is `ZZ AI …` / `zz-ai-…`: ten Cognito identities, three UserProfile rows, four customers, five
 * shipments / lane-rate samples / quotes and four open invoices (guarded SDK writes: `sdkPut/sdkDelete` refuse any row this run did
 * not register), saved dashboards (`DASH:` rows in DashboardRollup), and a temporary `ZZAI` team in TmsSettings.teams (the
 * original `teams` snapshot is restored and asserted equal). Passwords and tokens are never printed; no claim of a real user is
 * touched (the claim test runs on its own temporary identity).
 *
 * Screenshots: Docs/tms-build/screenshots/ai/<id>-<slug>-<light|dark>.png, listed in index.txt.
 *
 * Deviations from AI-plan §10 (recorded): 14 steps (AI00-AI14) instead of 10 so every requested proof has its own id; ten identities
 * (adds `tm` = team member, `mgr` = MANAGER without viewAll, `claimee` for the Settings > Users claim test); Dashboard rows are
 * `DASH:` rows of the existing DashboardRollup table (AI2 landed the actions on tmsCrmActions, not a new Lambda); the sweep proof
 * (AI13) waits for one real rollup sweep (every 5 min on dev) and SKIPs honestly when none ran; TS modules (spec parser, catalog)
 * are loaded with tsx (`tsx/esm/api`), which is installed in node_modules but not a declared devDependency.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk } from './lib/uiWalk.mjs'
import { AMOUNTS, SLOTS, AR_SLOTS, VISIBLE, costOf, profitOf, expectedSums, forbiddenSlots, scanForbidden, kpiValue, rowLabels, percentile, canonical, money } from './lib/aiProbe.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const DEV_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const SHOTS = resolve('Docs/tms-build/screenshots/ai')
const REGION = 'us-east-1'
const MODEL_CALL_CAP = 12
const MEMO_MS = 31_000 // the Lambda memoises raw Customer rows and month pages for 30 s
const SCOPE_TEXT = 'Is this dashboard for the whole company, or for specific users/teams?'
const TEAM_KEY = 'ZZAI'
const ROLLUP_TABLE = 'DashboardRollup'

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
  { pattern: /net::ERR_CERT_VERIFIER_CHANGED/, reason: 'headless Chrome re-reads its cert store mid-run; the request is retried by the client' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']
export const SKIP_ALLOWED = {
  'AI04-scope-gate': 'only with --skip-model (no model call was made)',
  'AI10-live-chat': 'MODEL_UNAVAILABLE: the provider refused (credit, key, rate limit or abort) or --skip-model was given',
  'AI12-ui': 'only with --no-ui',
  'AI13-sweep': 'no rollup sweep ran inside the wait window (the sweep rule is every 5 minutes on dev)',
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: SKIP_ALLOWED, only })
const { line, report, written, skipLine, problemList, waitLoaded, matches } = walk

// ───────────────────────────── registry + static gates ─────────────────────────────
export const AI_STEPS = [
  { id: 'AI00', slug: 'setup' },
  { id: 'AI01', slug: 'inventory' },
  { id: 'AI02', slug: 'claims' },
  { id: 'AI03', slug: 'refusals' },
  { id: 'AI04', slug: 'scope-gate' },
  { id: 'AI05', slug: 'visibility-matrix' },
  { id: 'AI06', slug: 'revocation' },
  { id: 'AI07', slug: 'audience' },
  { id: 'AI08', slug: 'validation' },
  { id: 'AI09', slug: 'dash-rows' },
  { id: 'AI10', slug: 'live-chat' },
  { id: 'AI11', slug: 'timing' },
  { id: 'AI12', slug: 'ui' },
  { id: 'AI13', slug: 'sweep' },
  { id: 'AI14', slug: 'cleanup' },
]

const FILES = [
  'src/lib/dashboards/spec.ts', 'src/lib/dashboards/catalog.ts', 'src/lib/dashboards/execute.ts', 'src/lib/dashboards/modelSchema.ts',
  'src/lib/dashboards/chatProtocol.ts', 'src/lib/dashboards/access.ts', 'src/lib/dashboards/visibleReader.ts', 'src/lib/dashboards/builtin.ts',
  'src/lib/dataVisibility.ts', 'amplify/functions/tms-crm-actions/dashboardActions.ts', 'amplify/functions/tms-crm-actions/dashStore.ts',
  'amplify/functions/tms-crm-actions/dashChat.ts', 'amplify/functions/tms-crm-actions/dashSources.ts',
  'src/features/dashboards/viewer/DashboardHome.tsx', 'src/features/dashboards/viewer/DashboardViewPage.tsx',
  'src/features/dashboards/builder/DashboardBuilderPage.tsx', 'src/features/dashboards/builder/ChatPanel.tsx',
]

/** The data-testids this script reads (a trailing `-` is a prefix completed with an id), and the source file carrying each. */
export const TESTID_SOURCES = {
  'dash-new': 'src/features/dashboards/viewer/DashboardHome.tsx',
  'dash-cards': 'src/features/dashboards/viewer/DashboardCards.tsx',
  'dash-card-': 'src/features/dashboards/viewer/DashboardCards.tsx',
  'dash-visibility-banner': 'src/features/dashboards/viewer/VisibilityBanner.tsx',
  'dash-grid': 'src/features/dashboards/viewer/WidgetGrid.tsx',
  'dash-transcript': 'src/features/dashboards/builder/ChatPanel.tsx',
  'dash-scope-question': 'src/features/dashboards/builder/ChatPanel.tsx',
  'dash-model-error': 'src/features/dashboards/builder/ChatPanel.tsx',
  'dash-send': 'src/features/dashboards/builder/ChatPanel.tsx',
  'dash-scope-': 'src/features/dashboards/builder/ScopePicker.tsx',
  'dash-save': 'src/features/dashboards/builder/DashboardBuilderPage.tsx',
  'dash-d1-banner': 'src/features/dashboards/builder/DashboardBuilderPage.tsx',
  'dash-preview': 'src/features/dashboards/builder/DashboardBuilderPage.tsx',
  'dash-save-confirm': 'src/features/dashboards/builder/SaveDashboardDialog.tsx',
  'user-card': 'src/features/users/UsersPage.tsx',
}

const ROUTE_NEEDLES = ['path="dashboard"', 'path="dashboard/d/:id"', 'path="dashboard/new"', 'path="dashboard/d/:id/edit"']
/** Router actions the harness calls on tmsCrmActions (must be dashboard actions wired in the router). */
const CRM_PATTERN = /(?:\bcrm\.\w+\(\s*|\[\s*)'((?:PREVIEW|LIST|GET|SAVE|ARCHIVE)_DASHBOARD[A-Z_]*)'/g
const NOT_AN_ACTION = new Set(['LIST_DASHBOARDX']) // the deliberate unknown-action probe
const DIR_PATTERN = /\bdir\(\s*'([A-Z_]+)'/g

const read = (file) => readFile(join(process.cwd(), file), 'utf8')
const exists = (file) => read(file).then(() => true, () => false)

let tsLoader = null
async function tsImport(file) {
  if (!tsLoader) {
    try { tsLoader = (await import('tsx/esm/api')).tsImport } catch { throw new Error('tsx is not installed (node_modules/tsx): the harness loads the TypeScript spec modules with it') }
  }
  return tsLoader(pathToFileURL(resolve(file)).href, import.meta.url)
}

/** The reference dashboard every viewer runs (filters.customerIds is the ZZ customers, so viewAll personas see exactly the fixtures). */
export function referenceSpec(scope, customerIds = []) {
  return {
    v: 1,
    title: 'ZZ AI reference dashboard',
    description: 'Dev verification fixture. Safe to archive.',
    scope,
    filters: { window: { preset: 'THIS_MONTH' }, divisions: [], customerIds, repIds: [], modes: [] },
    widgets: [
      { id: 'w1', type: 'KPI', title: 'Revenue', size: 'M', query: { id: 'fin.summary', params: { metrics: ['revenue', 'cost', 'profit', 'count'] } } },
      { id: 'w2', type: 'KPI', title: 'Shipments', size: 'S', query: { id: 'ship.summary', params: { metrics: ['count'] } } },
      { id: 'w3', type: 'KPI', title: 'Open AR', size: 'S', query: { id: 'ar.summary', params: { metrics: ['open', 'count'] } } },
      { id: 'w4', type: 'KPI', title: 'Quotes', size: 'M', query: { id: 'quote.summary', params: { metrics: ['count', 'openValue'] } } },
      { id: 'w5', type: 'BAR', title: 'Revenue by customer', size: 'L', query: { id: 'fin.byGroup', params: { metric: 'revenue', groupBy: 'CUSTOMER', limit: 25 } } },
      { id: 'w6', type: 'TABLE', title: 'Open AR by customer', size: 'L', query: { id: 'ar.byCustomer', params: { limit: 25 } } },
      { id: 'w7', type: 'LIST', title: 'Recent shipments', size: 'F', query: { id: 'ship.recent', params: { limit: 25 } } },
      { id: 'w8', type: 'PIE', title: 'Shipments by status', size: 'M', query: { id: 'ship.byStatus', params: {} } },
    ],
  }
}

/** Gates 1-8 (no network). Returns true when all pass. */
export async function inventory() {
  const ids = AI_STEPS.map((s) => s.id)
  const runnerIds = Object.keys(RUNNERS)
  const missing = ids.filter((id) => !runnerIds.includes(id)).concat(runnerIds.filter((id) => !ids.includes(id)))
  if (missing.length) { line('FAIL', 'gate 1: AI ids registered', `registry and runners disagree on: ${missing.join(', ')}`); return false }
  const orphan = Object.keys(SKIP_ALLOWED).filter((k) => !AI_STEPS.some((s) => `${s.id}-${s.slug}` === k))
  if (orphan.length) { line('FAIL', 'gate 1: AI ids registered', `SKIP_ALLOWED names no step: ${orphan.join(', ')}`); return false }
  line('PASS', 'gate 1: AI ids registered', `${ids.length} steps each have a runner; skip-allowed: ${Object.keys(SKIP_ALLOWED).join(', ')}`)

  const gone = []
  for (const f of FILES) if (!(await exists(f))) gone.push(f)
  if (gone.length) { line('FAIL', 'gate 2: the AI source files exist', gone.join(', ')); return false }
  line('PASS', 'gate 2: the AI source files exist', `${FILES.length} files`)

  const roles = await read('src/lib/roles.ts')
  const claims = ['DASHBOARDS_CREATE', 'DASHBOARDS_PUBLISH_COMPANY', 'VIEW_ALL']
  const claimGaps = claims.filter((c) => (roles.match(new RegExp(`'${c}'`, 'g')) ?? []).length < 2 || !new RegExp(`${c}:\\s*['"]`).test(roles))
  if (claimGaps.length) { line('FAIL', 'gate 3: claim constants', `${claimGaps.join(', ')} not in CLAIMS + ENFORCED_CLAIMS + CLAIM_LABELS of src/lib/roles.ts`); return false }
  line('PASS', 'gate 3: claim constants', `${claims.join(', ')} are in CLAIMS, CLAIM_LABELS and ENFORCED_CLAIMS`)

  const actionsSrc = await read('amplify/functions/tms-crm-actions/dashboardActions.ts')
  const names = [...(/DASHBOARD_ACTION_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(actionsSrc)?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])
  const router = await read('amplify/functions/tms-crm-actions/actions.ts')
  const api = await read('src/lib/apiClient.ts')
  const readRe = /READ_ROUTER_ACTION\s*=\s*\/(.+)\/\s*$/m.exec(api)?.[1]
  if (names.length !== 7 || !readRe) { line('FAIL', 'gate 4: actions wired and classified', `found ${names.length} action names / read regex ${readRe ? 'ok' : 'missing'}`); return false }
  const re = new RegExp(readRe)
  const reads = ['PREVIEW_DASHBOARD_CHAT', 'PREVIEW_DASHBOARD', 'LIST_DASHBOARDS', 'GET_DASHBOARD', 'GET_DASHBOARD_OPTIONS']
  const writes = ['SAVE_DASHBOARD', 'ARCHIVE_DASHBOARD']
  const wiring = names.filter((n) => !new RegExp(`\\b${n}:\\s*dashboardHandler\\(`).test(router))
  const wrongRead = reads.filter((n) => !re.test(n))
  const wrongWrite = writes.filter((n) => re.test(n))
  const unknownRead = [...new Set([...reads, ...writes])].filter((n) => !names.includes(n))
  if (wiring.length || wrongRead.length || wrongWrite.length || unknownRead.length) {
    line('FAIL', 'gate 4: actions wired and classified', `not wired in tmsCrmActions: ${wiring.join(',') || '-'}; should be reads: ${wrongRead.join(',') || '-'}; should be writes: ${wrongWrite.join(',') || '-'}; unknown: ${unknownRead.join(',') || '-'}`)
    return false
  }
  const self = await read('scripts/devVerifyAI.mjs')
  const called = new Set([...self.matchAll(CRM_PATTERN)].map((m) => m[1]))
  const notDash = [...called].filter((a) => !names.includes(a) && !NOT_AN_ACTION.has(a))
  const dirCalled = new Set([...self.matchAll(DIR_PATTERN)].map((m) => m[1]))
  const dirHandler = await read('amplify/functions/tms-directory-actions/handler.ts')
  const dirMissing = [...dirCalled].filter((a) => !new RegExp(`case '${a}':`).test(dirHandler))
  if (notDash.length || dirMissing.length) { line('FAIL', 'gate 4: actions wired and classified', `harness calls unknown crm actions: ${notDash.join(',') || '-'}; directory actions without a case: ${dirMissing.join(',') || '-'}`); return false }
  line('PASS', 'gate 4: actions wired and classified', `7 actions wired in tmsCrmActions; 5 classify as cache-safe reads, SAVE/ARCHIVE as writes (apiClient READ_ROUTER_ACTION); harness calls ${called.size} crm + ${dirCalled.size} directory action(s), all real`)

  const cat = await tsImport('src/lib/dashboards/catalog.ts')
  const ms = await tsImport('src/lib/dashboards/modelSchema.ts')
  const catalogIds = [...cat.QUERY_IDS].sort()
  const findEnum = (node) => {
    if (!node || typeof node !== 'object') return null
    if (node.queryId?.enum) return node.queryId.enum
    for (const v of Object.values(node)) { const r = findEnum(v); if (r) return r }
    return null
  }
  const schemaIds = [...(findEnum(ms.MODEL_OUT_SCHEMA) ?? [])].sort()
  const prompt = cat.catalogPromptText()
  const promptIds = [...prompt.matchAll(/^- ([a-z]+\.[A-Za-z]+) \[/gm)].map((m) => m[1]).sort()
  if (canonical(catalogIds) !== canonical(schemaIds) || canonical(catalogIds) !== canonical(promptIds)) {
    line('FAIL', 'gate 5: catalog == model-schema enum == prompt text', `catalog ${catalogIds.length}, schema enum ${schemaIds.length}, prompt ${promptIds.length}`); return false
  }
  line('PASS', 'gate 5: catalog == model-schema enum == prompt text', `${catalogIds.length} query ids identical in the three places`)

  const spec = await tsImport('src/lib/dashboards/spec.ts')
  const builtin = await tsImport('src/lib/dashboards/builtin.ts')
  const bad = []
  for (const [name, s] of [['reference ME', referenceSpec({ kind: 'ME' })], ['reference COMPANY', referenceSpec({ kind: 'COMPANY' }, ['a', 'b'])], ['reference TEAM', referenceSpec({ kind: 'TEAM', teamKeys: [TEAM_KEY] })], ['OVERVIEW_SPEC', builtin.OVERVIEW_SPEC]]) {
    const r = spec.parseSpec(s)
    if (!r.ok) bad.push(`${name}: ${r.issues.slice(0, 2).join('; ')}`)
  }
  if (bad.length) { line('FAIL', 'gate 6: example specs parse', bad.join(' | ')); return false }
  line('PASS', 'gate 6: example specs parse', 'the reference spec (ME / COMPANY / TEAM) and OVERVIEW_SPEC pass parseSpec')

  const gaps = []
  for (const [id, file] of Object.entries(TESTID_SOURCES)) if (!(await read(file).catch(() => '')).includes(id)) gaps.push(`${id} missing from ${file}`)
  if (gaps.length) { line('FAIL', 'gate 7: data-testids the walk reads exist in source', gaps.join('; ')); return false }
  line('PASS', 'gate 7: data-testids the walk reads exist in source', `${Object.keys(TESTID_SOURCES).length} ids`)

  const app = await read('src/App.tsx')
  const routeGaps = ROUTE_NEEDLES.filter((n) => !app.includes(n))
  if (routeGaps.length) { line('FAIL', 'gate 8: dashboard routes are registered', routeGaps.join('; ')); return false }
  line('PASS', 'gate 8: dashboard routes are registered', '/tms/dashboard, /d/:id, /new, /d/:id/edit in src/App.tsx')
  return true
}

// ───────────────────────────── small helpers ─────────────────────────────
const nowIso = () => new Date().toISOString()
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)
const sha = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16)
class SkipError extends Error {}
const asJson = (v) => { let x = v; for (let i = 0; i < 3 && typeof x === 'string'; i++) { try { x = JSON.parse(x) } catch { return x } } return x }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function refused(name, pattern, fn) {
  try { await fn() } catch (err) {
    if (pattern.test(String(err?.message ?? err))) return String(err.message).slice(0, 160)
    throw new Error(`${name} refused for the wrong reason: ${short(err)}`)
  }
  throw new Error(`${name} was allowed`)
}

const customerOf = (slot) => (slot === 'C3D' ? 'C3' : slot)

// ───────────────────────────── safety + guarded SDK access ─────────────────────────────
const ddb = new DynamoDBClient({ region: REGION })
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })

async function discoverDevSuffix() {
  const suffix = process.env.DEV_TABLE_SUFFIX || DEV_SUFFIX
  if (suffix !== DEV_SUFFIX || suffix.includes(PROD_SUFFIX)) throw new Error(`refusing table suffix ${suffix}: only ${DEV_SUFFIX} is allowed`)
  await ddb.send(new DescribeTableCommand({ TableName: `${ROLLUP_TABLE}-${suffix}` })).catch(() => { throw new Error(`no ${ROLLUP_TABLE}-${suffix} table in the account`) })
  return suffix
}
function devTable(model, suffix) {
  const name = `${model}-${suffix}`
  if (!name.endsWith(`-${DEV_SUFFIX}`) || name.includes(PROD_SUFFIX)) throw new Error(`refusing non-dev table ${name}`)
  return name
}
/** Every SDK write/delete is to a row this run created (registered in ctx.owned) — never to anything else. */
const own = (ctx, model, id) => { ctx.owned.add(`${model}:${id}`); return id }
const owns = (ctx, model, id) => ctx.owned.has(`${model}:${id}`)
async function sdkPut(ctx, model, item) {
  if (!owns(ctx, model, item.id)) throw new Error(`refusing SDK write to ${model} ${String(item.id)}: not registered by this run`)
  await doc.send(new PutCommand({ TableName: devTable(model, ctx.suffix), Item: { __typename: model, createdAt: nowIso(), updatedAt: nowIso(), ...item } }))
}
async function sdkDelete(ctx, model, id) {
  if (!owns(ctx, model, id)) throw new Error(`refusing SDK delete of ${model} ${id}: not created by this run`)
  await doc.send(new DeleteCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))
  return !(await doc.send(new GetCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))).Item
}
const sdkGet = async (ctx, model, id) => (await doc.send(new GetCommand({ TableName: devTable(model, ctx.suffix), Key: { id }, ConsistentRead: true }))).Item

// ───────────────────────────── identities ─────────────────────────────
const IDENTITIES = {
  admin: ['ADMIN', 'page-tms'],
  pub: ['page-tms', 'claim-DASHBOARDS_CREATE', 'claim-DASHBOARDS_PUBLISH_COMPANY'],
  repa: ['page-tms', 'claim-DASHBOARDS_CREATE'],
  repb: ['page-tms', 'claim-DASHBOARDS_CREATE'],
  tm: ['page-tms', 'claim-DASHBOARDS_CREATE'],
  mgr: ['page-tms', 'role-MANAGER', 'claim-DASHBOARDS_CREATE'],
  plain: ['page-tms'],
  nopage: [],
  acct: ['page-tms', 'role-AR_AP'],
  claimee: ['page-tms'],
}
const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))

async function mintAll(ctx, made) {
  for (const [key, groups] of Object.entries(IDENTITIES)) {
    const email = `zz-ai-${key}-${ctx.ts}@example.invalid`
    const ident = await mintIdentity(email, groups)
    made.push(email)
    const p = payloadOf(ident.token)
    ctx.who[key] = { key, email, groups, token: ident.token, storage: ident.storage, id: String(p['cognito:username']) }
    ctx.crm[key] = routerAs(ident.token, 'tmsCrmActions')
  }
  ctx.dir = routerAs(ctx.who.admin.token, 'tmsDirectoryActions')
  ctx.manage = (action, username, input) => gql(ctx.who.admin.token, 'query($a: String!, $u: String, $i: String) { manageUsers(action: $a, username: $u, input: $i) }', { a: action, u: username, i: input ? JSON.stringify(input) : null }).then((d) => asJson(d.manageUsers))
}

// ───────────────────────────── teams (TmsSettings, restored in AI14) ─────────────────────────────
async function readTeams(ctx) {
  const row = (await gql(ctx.who.admin.token, 'query { getTmsSettings(id: "default") { id teams updatedAt } }')).getTmsSettings
  expect(row, 'TmsSettings default row does not exist on dev')
  const teams = asJson(row.teams)
  return { teams: Array.isArray(teams) ? teams : [], raw: teams ?? null, updatedAt: row.updatedAt }
}
async function writeTeams(ctx, teams) {
  const cur = await readTeams(ctx)
  await ctx.dir('SAVE_SETTINGS', { teams, expectedUpdatedAt: cur.updatedAt })
}
const zzTeam = (memberIds) => ({ key: TEAM_KEY, name: 'ZZ AI Team', memberIds, active: true })

// ───────────────────────────── fixtures (AI00) ─────────────────────────────
const SHIP_STATUS = { C1: 'IN_TRANSIT', C2: 'DELIVERED', C3: 'OPEN', C4: 'DELIVERED', C3D: 'BOOKED' }

async function seed(ctx) {
  const { who, ts } = ctx
  const month = nowIso().slice(0, 7)
  const day1 = `${month}-01`
  ctx.month = month
  ctx.names = {
    C1: `ZZ AI Own C1 ${ts}`, C2: `ZZ AI Team C2 ${ts}`, C3: `ZZ AI Hidden C3 ${ts}`, C4: `ZZ AI Orphan C4 ${ts}`,
  }
  ctx.ids = {}
  const owners = { C1: [who.repa.email], C2: [], C3: ['someone-else@example.invalid'], C4: [] }
  for (const c of ['C1', 'C2', 'C3', 'C4']) {
    const id = own(ctx, 'Customer', `zzai-cust-${c}-${ts}`)
    ctx.ids[c] = id
    await sdkPut(ctx, 'Customer', {
      id, name: ctx.names[c], status: 'ACTIVE', active: true, accountOwnerIds: owners[c], ...(c === 'C2' ? { teamKey: TEAM_KEY } : {}),
      notes: 'Dev-only Step AI verification fixture. Safe to delete.', createdBy: 'zz-ai', updatedBy: 'zz-ai',
    })
  }
  ctx.shipIds = {}
  for (const s of SLOTS) {
    const c = customerOf(s)
    const id = own(ctx, 'Shipment', `zzai-ship-${s}-${ts}`)
    ctx.shipIds[s] = id
    await sdkPut(ctx, 'Shipment', {
      id, number: `ZZAI-${s}-${String(ts).slice(-6)}`, status: SHIP_STATUS[s], pickupAppt: `${day1}T15:00:00.000Z`, pickupMonth: month,
      customerId: ctx.ids[c], customerName: ctx.names[c], mode: 'FTL', ...(s === 'C3D' ? { salesRepId: who.repb.email } : {}),
      createdBy: 'zz-ai', updatedBy: 'zz-ai', version: 1,
    })
    const smp = own(ctx, 'LaneRateSample', `zzai-smp-${s}-${ts}`)
    await sdkPut(ctx, 'LaneRateSample', {
      id: smp, laneKey: 'ZZAI|IL>ZZAI|IL', date: day1, sampleMonth: month, loadId: `zzai-load-${s}-${ts}`, shipmentId: id,
      customerId: ctx.ids[c], customerName: ctx.names[c], revenueCents: AMOUNTS[s], costCents: costOf(AMOUNTS[s]), profitCents: profitOf(AMOUNTS[s]),
      mode: 'FTL', excluded: false, source: 'LOAD', sampledAt: nowIso(), version: 1, ...(s === 'C3D' ? { salesRepId: who.repb.email } : {}),
    })
    const q = own(ctx, 'Quote', `zzai-q-${s}-${ts}`)
    await sdkPut(ctx, 'Quote', {
      id: q, side: 'SELL', status: 'QUOTED', quoteDate: day1, quoteMonth: month, customerId: ctx.ids[c], customerName: ctx.names[c],
      amountCents: AMOUNTS[s], rounds: 0, mode: 'FTL', createdBy: 'zz-ai', updatedBy: 'zz-ai', version: 1, ...(s === 'C3D' ? { customerRepId: who.repb.email } : {}),
    })
  }
  for (const s of AR_SLOTS) {
    const inv = own(ctx, 'Invoice', `ZZAI-INV-${s}-${ts}`)
    await sdkPut(ctx, 'Invoice', {
      id: inv, number: inv, orderId: `zzai-order-${s}-${ts}`, shipmentId: s === 'C3' ? ctx.shipIds.C3D : ctx.shipIds[s], customerId: ctx.ids[s], customerName: ctx.names[s],
      status: 'ISSUED', invoiceDate: day1, issuedAt: nowIso(), issuedBy: 'zz-ai', dueAt: day1, termsDays: 30, invoiceMonth: month,
      subtotalCents: AMOUNTS[s], totalCents: AMOUNTS[s], paidCents: 0, writtenOffCents: 0, balanceCents: AMOUNTS[s], arOpen: 'OPEN',
      createdBy: 'zz-ai', updatedBy: 'zz-ai', version: 1,
    })
  }
  for (const k of ['repa', 'repb', 'tm']) {
    const w = who[k]
    own(ctx, 'UserProfile', w.id)
    await sdkPut(ctx, 'UserProfile', { id: w.id, email: w.email, name: `ZZ AI ${k}`, role: 'CUSTOMER_REP', status: 'ACTIVE', claims: ['DASHBOARDS_CREATE'], createdBy: 'zz-ai', updatedBy: 'zz-ai', version: 1 })
  }
  // The browser sends the Cognito ACCESS token, which has no e-mail claim: the router resolves the caller's e-mail from their
  // UserProfile (every real user has one). A browser identity without a profile gets "Unauthorized: could not resolve caller email".
  for (const k of ['admin', 'plain', 'acct']) {
    const w = who[k]
    own(ctx, 'UserProfile', w.id)
    await sdkPut(ctx, 'UserProfile', { id: w.id, email: w.email, name: `ZZ AI ${k}`, role: k === 'acct' ? 'AR_AP' : 'NONE', status: 'ACTIVE', createdBy: 'zz-ai', updatedBy: 'zz-ai', version: 1 })
  }
  ctx.teams0 = await readTeams(ctx)
  await writeTeams(ctx, [...ctx.teams0.teams.filter((t) => t.key !== TEAM_KEY), zzTeam([who.tm.id])])
  ctx.seededAt = Date.now()
}

/** The Lambda memoises raw Customer rows and month pages for 30 s: wait it out once after seeding. */
async function settle(ctx) {
  const wait = ctx.seededAt + MEMO_MS - Date.now()
  if (wait > 0) await sleep(wait)
}

// ───────────────────────────── model calls (capped, honest) ─────────────────────────────
async function chat(ctx, who, input) {
  if (flag('skip-model')) throw new SkipError('--skip-model')
  expect(ctx.model.calls < MODEL_CALL_CAP, `model call cap ${MODEL_CALL_CAP} reached`)
  ctx.model.calls += 1
  const t0 = Date.now()
  const res = await ctx.crm[who]('PREVIEW_DASHBOARD_CHAT', input)
  const ms = Date.now() - t0
  if (!res.modelError) ctx.model.ms.push(ms)
  return { res, ms }
}
const userMsg = (text) => ({ role: 'user', text })

// ───────────────────────────── steps ─────────────────────────────
async function ai00Setup(ctx) {
  expect(ctx.suffix, 'no dev table suffix')
  await seed(ctx)
  const before = await sdkGet(ctx, ROLLUP_TABLE, 'L:CURRENT')
  ctx.sweep0 = before?.computedAt ?? null
  ctx.setupOk = true
  return `${Object.keys(ctx.who).length} identities, 4 customers, 5 shipments/samples/quotes, 4 open invoices, 3 profiles, team ${TEAM_KEY} (original teams snapshotted: ${ctx.teams0.teams.length} team(s))`
}

async function ai01Inventory() { return 'offline gates 1-8 passed above (they run first, before any network)' }

async function ai02Claims(ctx) {
  const notes = []
  const c = ctx.who.claimee
  await refused('setClaims as a non-admin', /Forbidden|not an admin|admin/i, () => gql(ctx.who.plain.token, 'query($u: String, $i: String) { manageUsers(action: "setClaims", username: $u, input: $i) }', { u: c.id, i: JSON.stringify({ claims: ['VIEW_ALL'] }) }))
  notes.push('a non-admin cannot set claims')
  const granted = await ctx.manage('setClaims', c.id, { claims: ['DASHBOARDS_CREATE', 'DASHBOARDS_PUBLISH_COMPANY', 'VIEW_ALL'] })
  expect(granted?.success === true, 'setClaims did not answer success')
  own(ctx, 'UserProfile', c.id)
  const groups = await ctx.manage('getGroups', c.id)
  for (const g of ['claim-DASHBOARDS_CREATE', 'claim-DASHBOARDS_PUBLISH_COMPANY', 'claim-VIEW_ALL']) expect(groups.includes(g), `group ${g} was not minted by setClaims (groups: ${groups.join(',')})`)
  expect(groups.includes('page-tms'), 'setClaims removed the page-tms group')
  notes.push('ticking the three claims mints claim-DASHBOARDS_CREATE, claim-DASHBOARDS_PUBLISH_COMPANY, claim-VIEW_ALL and keeps page grants')
  await refused('an unknown claim', /claim must be one of/i, () => ctx.manage('setClaims', c.id, { claims: ['DASHBOARDS_NOPE'] }))
  const cleared = await ctx.manage('setClaims', c.id, { claims: [] })
  expect(cleared?.success === true, 'clearing claims did not answer success')
  const after = await ctx.manage('getGroups', c.id)
  expect(!after.some((g) => g.startsWith('claim-')), `claim groups remained after clearing: ${after.join(',')}`)
  notes.push('unticking removes them; an unknown claim is refused')
  return notes.join('; ')
}

const dashSpecFor = (ctx, scope, ids = Object.values(ctx.ids)) => referenceSpec(scope, ids)

async function ai03Refusals(ctx) {
  const notes = []
  const spec = dashSpecFor(ctx, { kind: 'ME' })
  const chatIn = { messages: [userMsg('hello')], scope: null, draft: null }
  // plain: page-tms but no Create dashboards
  await refused('chat without create', /Forbidden/i, () => ctx.crm.plain('PREVIEW_DASHBOARD_CHAT', chatIn))
  await refused('save without create', /Forbidden/i, () => ctx.crm.plain('SAVE_DASHBOARD', { spec }))
  await refused('an unsaved spec run without create', /Forbidden/i, () => ctx.crm.plain('PREVIEW_DASHBOARD', { spec }))
  const optsPlain = await ctx.crm.plain('GET_DASHBOARD_OPTIONS', {})
  expect(optsPlain.access.create === false && optsPlain.access.publishCompany === false && optsPlain.access.viewAll === false, `plain access ${JSON.stringify(optsPlain.access)}`)
  const listPlain = await ctx.crm.plain('LIST_DASHBOARDS', {})
  expect(Array.isArray(listPlain.company) && Array.isArray(listPlain.mine), 'plain cannot list dashboards')
  notes.push('without dashboards.create: chat, save and an unsaved-spec run are Forbidden; options/list still work with access all false')
  // nopage: the door
  for (const [action, input] of [['LIST_DASHBOARDS', {}], ['GET_DASHBOARD_OPTIONS', {}], ['PREVIEW_DASHBOARD', { builtin: 'OVERVIEW' }], ['PREVIEW_DASHBOARD_CHAT', chatIn], ['SAVE_DASHBOARD', { spec }]]) {
    await refused(`${action} without page-tms`, /Forbidden/i, () => ctx.crm.nopage(action, input))
  }
  notes.push('without page-tms every action is Forbidden')
  // publishCompany
  const comp = referenceSpec({ kind: 'COMPANY' })
  await refused('COMPANY save without publishCompany', /Forbidden.*(Publish|company)/i, () => ctx.crm.repa('SAVE_DASHBOARD', { spec: comp }))
  await refused('COMPANY chat without publishCompany', /Forbidden.*(Publish|company)/i, () => ctx.crm.repa('PREVIEW_DASHBOARD_CHAT', { messages: [userMsg('x')], scope: { kind: 'COMPANY' }, draft: null }))
  notes.push('create without publishCompany: COMPANY save and COMPANY chat are Forbidden (the chat refusal happens before any model call)')
  const optsPub = await ctx.crm.pub('GET_DASHBOARD_OPTIONS', {})
  expect(optsPub.access.create && optsPub.access.publishCompany && !optsPub.access.viewAll, `pub access ${JSON.stringify(optsPub.access)}`)
  const optsAcct = await ctx.crm.acct('GET_DASHBOARD_OPTIONS', {})
  expect(optsAcct.access.viewAll === true && optsAcct.access.create === false, `acct (role AR_AP) access ${JSON.stringify(optsAcct.access)}`)
  const optsAdmin = await ctx.crm.admin('GET_DASHBOARD_OPTIONS', {})
  expect(optsAdmin.access.create && optsAdmin.access.publishCompany && optsAdmin.access.viewAll, `admin access ${JSON.stringify(optsAdmin.access)}`)
  const optsMgr = await ctx.crm.mgr('GET_DASHBOARD_OPTIONS', {})
  expect(optsMgr.access.viewAll === false, 'role MANAGER must not be viewAll (D2)')
  expect(optsAdmin.limits.maxWidgets === 12, `maxWidgets ${optsAdmin.limits.maxWidgets}`)
  notes.push('access: pub = create+publish, acct (AR_AP) = viewAll only, ADMIN = all three, MANAGER = not viewAll')
  await refused('an unknown action', /Unknown action/i, () => ctx.crm.admin('LIST_DASHBOARDX', {}))
  return notes.join('; ')
}

async function ai04ScopeGate(ctx) {
  const notes = []
  const first = await chat(ctx, 'repa', { messages: [userMsg('revenue by customer this month, with open AR')], scope: null, draft: null })
  const r = first.res
  ctx.chat1 = first
  expect(r.spec === null, 'chat with scope:null returned a spec')
  const q = (r.questions ?? []).find((x) => x.id === 'scope')
  expect(q && q.kind === 'SCOPE' && q.text === SCOPE_TEXT, `the SCOPE question is missing or reworded (questions: ${JSON.stringify((r.questions ?? []).map((x) => x.id))})`)
  ctx.modelDown = typeof r.modelError === 'string' && r.modelError.length > 0
  ctx.modelDownMessage = ctx.modelDown ? r.modelError : null
  notes.push(ctx.modelDown ? `model UNAVAILABLE (${String(r.modelError).slice(0, 80)}): scope question still present, spec null, modelError set` : `scope question present on the first turn, spec null (${first.ms} ms)`)
  // a typed "company-wide" must not set the scope
  const typed = await chat(ctx, 'repa', { messages: [userMsg('revenue by customer'), { role: 'assistant', text: r.reply || 'Who is it for?' }, userMsg('company-wide please')], scope: null, draft: null })
  expect(typed.res.spec === null, 'a typed "company-wide" produced a spec')
  expect((typed.res.questions ?? []).some((x) => x.id === 'scope'), 'the scope question disappeared after a typed answer')
  notes.push('a typed "company-wide" does not set the scope: the question stays and no spec is built')
  return notes.join('; ')
}

// ── the visibility matrix ──
const NONE = ['plain', 'mgr', 'pub']
function checkRun(ctx, persona, expectKey, run, tag) {
  const e = expectedSums(expectKey)
  const results = run.results
  const bad = results.filter((x) => !x.ok).map((x) => `${x.widgetId}: ${x.error}`)
  expect(!bad.length, `${tag}: widgets failed: ${bad.join('; ')}`)
  const eq = (name, got, want) => expect(got === want, `${tag}: ${name} is ${got}, expected ${want}`)
  eq('Revenue', kpiValue(results, 'w1', 'Revenue'), e.revenue)
  eq('Cost', kpiValue(results, 'w1', 'Cost'), e.cost)
  eq('Profit', kpiValue(results, 'w1', 'Profit'), e.profit)
  eq('priced shipments', kpiValue(results, 'w1', 'Shipments'), e.samples)
  eq('Shipments', kpiValue(results, 'w2', 'Shipments'), e.shipments)
  eq('Open AR', kpiValue(results, 'w3', 'Open AR'), e.arOpen)
  eq('Open invoices', kpiValue(results, 'w3', 'Open invoices'), e.arCount)
  eq('Quotes', kpiValue(results, 'w4', 'Quotes'), e.quotes)
  eq('Open value', kpiValue(results, 'w4', 'Open value'), e.quoteOpenValue)
  const v = VISIBLE[expectKey]
  const nameSet = (slots) => [...new Set(slots.map((s) => ctx.names[customerOf(s)]))].sort()
  const ZZ = (labels) => (labels ?? []).filter((l) => l.startsWith('ZZ AI ')).sort()
  expect(canonical(ZZ(rowLabels(results, 'w5'))) === canonical(nameSet(v.sample)), `${tag}: revenue-by-customer labels ${JSON.stringify(ZZ(rowLabels(results, 'w5')))}`)
  expect(canonical(ZZ(rowLabels(results, 'w6'))) === canonical(nameSet(v.ar)), `${tag}: AR-by-customer labels ${JSON.stringify(ZZ(rowLabels(results, 'w6')))}`)
  const w7 = JSON.stringify(results.find((x) => x.widgetId === 'w7'))
  for (const s of SLOTS) {
    const has = w7.includes(`ZZAI-${s}-`)
    expect(has === v.ship.includes(s), `${tag}: recent shipments ${has ? 'shows' : 'lacks'} ${s}`)
  }
  const forbidden = forbiddenSlots(expectKey)
  const hiddenCustomers = ['C1', 'C2', 'C3', 'C4'].filter((c) => !SLOTS.filter((s) => customerOf(s) === c).some((s) => !forbidden.includes(s)))
  const hits = scanForbidden(run, {
    names: hiddenCustomers.map((c) => ctx.names[c]), ids: hiddenCustomers.map((c) => ctx.ids[c]), cents: forbidden.map((s) => AMOUNTS[s]),
  })
  expect(!hits.length, `${tag}: hidden values leaked into the result: ${hits.join(', ')}`)
  expect(run.visibility.viewAll === (expectKey === 'all'), `${tag}: visibility.viewAll ${run.visibility.viewAll}`)
  expect(!/hidden|other customers|more rows/i.test(JSON.stringify(results.map((x) => (x.ok ? x.series.note : x.error)))), `${tag}: a note mentions hidden rows`)
}
const PERSONA_KEY = { repa: 'repa', repb: 'repb', tm: 'tm', plain: 'none', mgr: 'none', pub: 'none', acct: 'all', admin: 'all' }

async function ai05Matrix(ctx) {
  await settle(ctx)
  const notes = []
  // pub (publishCompany, NOT viewAll) saves the COMPANY dashboard; ownerId must be the caller, never the input.
  const spec = dashSpecFor(ctx, { kind: 'COMPANY' })
  const saved = await ctx.crm.pub('SAVE_DASHBOARD', { spec, ownerId: 'someone-else', sharedWith: { userIds: [ctx.who.plain.id], teamKeys: [] } })
  ctx.dashIds.add(saved.id)
  expect(saved.ownerId === ctx.who.pub.id && saved.scope === 'COMPANY' && saved.version === 1 && saved.widgetCount === 8, `saved record ${JSON.stringify({ o: saved.ownerId === ctx.who.pub.id, s: saved.scope, v: saved.version, w: saved.widgetCount })}`)
  expect(saved.sharedWith.userIds.length === 0, 'a COMPANY dashboard kept a sharedWith list')
  ctx.dashCompany = saved.id
  notes.push('pub saved a COMPANY dashboard (owner forced to the caller)')
  const runs = {}
  for (const persona of Object.keys(PERSONA_KEY)) {
    const run = await ctx.crm[persona]('PREVIEW_DASHBOARD', { id: saved.id })
    runs[persona] = run
    checkRun(ctx, persona, PERSONA_KEY[persona], run, persona)
    const listed = await ctx.crm[persona]('LIST_DASHBOARDS', {})
    expect(listed.company.some((d) => d.id === saved.id), `${persona}: the COMPANY dashboard is not in Company dashboards`)
  }
  notes.push('the SAME COMPANY dashboard run by 8 viewers: repa sees only C1 (1,000), tm only the team customer C2, repb only the direct-rep C3 shipment/sample/quote and the C3 invoice joined to it, plain/mgr/pub see nothing, acct (AR_AP) and admin see all four customers; every total equals the fixture arithmetic and no hidden name, id or amount appears anywhere in the serialised result')
  expect(runs.repa.visibility.ownedCustomers === 1 && runs.tm.visibility.ownedCustomers === 1 && runs.repb.visibility.ownedCustomers === 0 && runs.tm.visibility.teamKeys.includes(TEAM_KEY), `visibility counts repa ${runs.repa.visibility.ownedCustomers} tm ${runs.tm.visibility.ownedCustomers} repb ${runs.repb.visibility.ownedCustomers}`)
  expect(runs.plain.visibility.ownedCustomers === 0 && runs.mgr.visibility.ownedCustomers === 0, 'plain/mgr own customers')
  notes.push('visibility counts: repa 1, tm 1 (team), repb 0, plain/mgr 0')
  // the viewer's filter is applied after the filter on the spec: a hand-typed customer the viewer cannot see
  const probe = (cid) => ctx.crm.repa('PREVIEW_DASHBOARD', { spec: referenceSpec({ kind: 'ME' }, [cid]) })
  const hiddenRun = await probe(ctx.ids.C3)
  const ghostRun = await probe(`zzai-ghost-${ctx.ts}`)
  const strip = (r) => canonical(r.results)
  expect(strip(hiddenRun) === strip(ghostRun), 'a hidden customer id and a non-existent id produce different results (an existence probe)')
  expect(kpiValue(hiddenRun.results, 'w1', 'Revenue') === null && kpiValue(hiddenRun.results, 'w2', 'Shipments') === 0, 'repa typing customerIds:[C3] got data')
  expect(!JSON.stringify(hiddenRun).includes(ctx.names.C3), 'the hidden customer name came back')
  notes.push('repa typing the hidden customer\'s id gets exactly what a non-existent id gets (empty, identical text)')
  // OVERVIEW built-in: a non-viewAll viewer gets only their own, through the same reader
  const ov = await ctx.crm.repa('PREVIEW_DASHBOARD', { builtin: 'OVERVIEW' })
  expect(ov.visibility.viewAll === false && !JSON.stringify(ov).includes(ctx.names.C3), 'the built-in Overview leaked a hidden customer to repa')
  const ovAll = await ctx.crm.acct('PREVIEW_DASHBOARD', { builtin: 'OVERVIEW' })
  expect(ovAll.visibility.viewAll === true, 'the built-in Overview did not report viewAll for acct')
  notes.push('the built-in Overview is filtered for repa and reports viewAll for acct')
  return notes.join('; ')
}

async function ai06Revocation(ctx) {
  const run = () => ctx.crm.tm('PREVIEW_DASHBOARD', { id: ctx.dashCompany })
  const before = await run()
  expect(kpiValue(before.results, 'w1', 'Revenue') === AMOUNTS.C2, `tm sees ${kpiValue(before.results, 'w1', 'Revenue')} before revocation, expected ${AMOUNTS.C2}`)
  const cur = (await readTeams(ctx)).teams
  await writeTeams(ctx, cur.map((t) => (t.key === TEAM_KEY ? { ...t, memberIds: [`zz-ai-other-${ctx.ts}`] } : t)))
  const during = await run()
  expect(kpiValue(during.results, 'w1', 'Revenue') === null && during.visibility.teamKeys.length === 0 && !JSON.stringify(during).includes(ctx.names.C2), 'the revoked member still sees the team customer on the very next run')
  await writeTeams(ctx, (await readTeams(ctx)).teams.map((t) => (t.key === TEAM_KEY ? { ...t, memberIds: [ctx.who.tm.id] } : t)))
  const back = await run()
  expect(kpiValue(back.results, 'w1', 'Revenue') === AMOUNTS.C2, 'the restored member does not see the team customer again')
  // an inactive team grants nothing
  await writeTeams(ctx, (await readTeams(ctx)).teams.map((t) => (t.key === TEAM_KEY ? { ...t, active: false } : t)))
  const inactive = await run()
  expect(kpiValue(inactive.results, 'w1', 'Revenue') === null, 'an inactive team still grants visibility')
  await writeTeams(ctx, (await readTeams(ctx)).teams.map((t) => (t.key === TEAM_KEY ? { ...t, active: true } : t)))
  return 'removing tm from team ZZAI (another member stays: a team cannot be emptied) drops the team customer on the NEXT run (no cache serves it); restoring brings it back; an inactive team grants nothing'
}

async function ai07Audience(ctx) {
  const notes = []
  // repa: USERS dashboard shared with repb
  const usersSpec = dashSpecFor(ctx, { kind: 'USERS', userIds: [ctx.who.repb.id] })
  const du = await ctx.crm.repa('SAVE_DASHBOARD', { spec: usersSpec })
  ctx.dashIds.add(du.id)
  expect(du.scope === 'USERS' && du.sharedWith.userIds.includes(ctx.who.repb.id), 'USERS dashboard saved without its audience')
  const listB = await ctx.crm.repb('LIST_DASHBOARDS', {})
  expect(listB.mine.some((d) => d.id === du.id), 'repb does not see the dashboard shared with them')
  expect(!(await ctx.crm.tm('LIST_DASHBOARDS', {})).mine.some((d) => d.id === du.id), 'tm sees a dashboard that was not shared with them')
  const runB = await ctx.crm.repb('PREVIEW_DASHBOARD', { id: du.id })
  checkRun(ctx, 'repb', 'repb', runB, 'repb (shared with USERS)')
  const runA = await ctx.crm.repa('PREVIEW_DASHBOARD', { id: du.id })
  checkRun(ctx, 'repa', 'repa', runA, 'repa (owner)')
  notes.push('a USERS dashboard shared with repb: it lists for repb only, and each runs it on their OWN data (sharing never widens data)')
  // not in the audience = not found, same text as a missing id
  const msgOutside = await refused('opening outside the audience', /Dashboard not found/i, () => ctx.crm.tm('PREVIEW_DASHBOARD', { id: du.id }))
  const msgMissing = await refused('opening a missing id', /Dashboard not found/i, () => ctx.crm.tm('PREVIEW_DASHBOARD', { id: `zzai-missing-${ctx.ts}` }))
  expect(msgOutside === msgMissing, 'outside-audience and missing ids answer differently (an existence probe)')
  await refused('GET outside the audience', /Dashboard not found/i, () => ctx.crm.tm('GET_DASHBOARD', { id: du.id }))
  notes.push('outside the audience answers exactly like a missing id')
  // TEAM dashboard
  const teamSpec = dashSpecFor(ctx, { kind: 'TEAM', teamKeys: [TEAM_KEY] })
  const dt = await ctx.crm.repa('SAVE_DASHBOARD', { spec: teamSpec })
  ctx.dashIds.add(dt.id)
  expect((await ctx.crm.tm('LIST_DASHBOARDS', {})).mine.some((d) => d.id === dt.id), 'the team member does not see the TEAM dashboard')
  expect(!(await ctx.crm.repb('LIST_DASHBOARDS', {})).mine.some((d) => d.id === dt.id), 'a non-member sees the TEAM dashboard')
  checkRun(ctx, 'tm', 'tm', await ctx.crm.tm('PREVIEW_DASHBOARD', { id: dt.id }), 'tm (TEAM share)')
  await refused('a bad team key', /not an active team/i, () => ctx.crm.repa('SAVE_DASHBOARD', { spec: dashSpecFor(ctx, { kind: 'TEAM', teamKeys: ['ZZNOSUCH'] }) }))
  await refused('an unknown user', /not an active user/i, () => ctx.crm.repa('SAVE_DASHBOARD', { spec: dashSpecFor(ctx, { kind: 'USERS', userIds: [`zz-ai-nobody-${ctx.ts}`] }) }))
  notes.push('a TEAM dashboard lists for team members only; unknown teams and users are refused')
  // edit rights, CAS, archive
  const canEditOwner = (await ctx.crm.repa('GET_DASHBOARD', { id: du.id })).canEdit
  const canEditShared = (await ctx.crm.repb('GET_DASHBOARD', { id: du.id })).canEdit
  expect(canEditOwner === true && canEditShared === false, `canEdit owner ${canEditOwner} shared ${canEditShared}`)
  await refused('a non-owner SAVE', /Forbidden/i, () => ctx.crm.repb('SAVE_DASHBOARD', { id: du.id, spec: usersSpec, expectedVersion: du.version }))
  await refused('a non-owner ARCHIVE', /Forbidden/i, () => ctx.crm.repb('ARCHIVE_DASHBOARD', { id: du.id, expectedVersion: du.version }))
  const edited = await ctx.crm.repa('SAVE_DASHBOARD', { id: du.id, spec: { ...usersSpec, title: 'ZZ AI reference dashboard (edited)' }, expectedVersion: du.version })
  expect(edited.version === du.version + 1 && edited.title.endsWith('(edited)'), 'owner edit did not bump the version')
  await refused('a stale expectedVersion', /Conflict/i, () => ctx.crm.repa('SAVE_DASHBOARD', { id: du.id, spec: usersSpec, expectedVersion: du.version }))
  notes.push('non-owner save/archive refused, owner edit bumps version, a stale version is a Conflict')
  // ADMIN may archive anybody's; archived rows vanish from lists and open
  const archived = await ctx.crm.admin('ARCHIVE_DASHBOARD', { id: dt.id, expectedVersion: dt.version })
  expect(archived.id === dt.id && archived.archivedAt, 'ADMIN archive failed')
  expect(!(await ctx.crm.tm('LIST_DASHBOARDS', {})).mine.some((d) => d.id === dt.id), 'an archived dashboard is still listed')
  await refused('opening an archived dashboard', /Dashboard not found/i, () => ctx.crm.tm('PREVIEW_DASHBOARD', { id: dt.id }))
  ctx.dashUsers = du.id
  return notes.join('; ') + '; ADMIN archives anyone\'s dashboard and it disappears from lists'
}

async function ai08Validation(ctx) {
  const notes = []
  const base = (over = {}) => ({ ...referenceSpec({ kind: 'ME' }, [ctx.ids.C1]), ...over })
  const widget = (query, type = 'KPI') => ({ id: 'w1', type, title: 'x', size: 'M', query })
  const withWidgets = (widgets) => base({ widgets })
  const cases = [
    ['an unknown query id', withWidgets([widget({ id: 'fin.dropTable', params: {} })])],
    ['an extra param key', withWidgets([widget({ id: 'fin.summary', params: { metrics: ['revenue'], sql: 'select 1' } })])],
    ['a param outside the catalog enum', withWidgets([widget({ id: 'fin.summary', params: { metrics: ['everything'] } })])],
    ['a limit over 25', withWidgets([widget({ id: 'ship.recent', params: { limit: 500 } }, 'LIST')])],
    ['a widget type the query does not allow', withWidgets([widget({ id: 'fin.summary', params: { metrics: ['revenue'] } }, 'PIE')])],
    ['13 widgets', withWidgets(Array.from({ length: 13 }, (_, i) => ({ ...widget({ id: 'ship.summary', params: { metrics: ['count'] } }), id: `w${i + 1}` })))],
    ['duplicate widget ids', withWidgets([widget({ id: 'ship.summary', params: { metrics: ['count'] } }), widget({ id: 'ship.summary', params: { metrics: ['count'] } })])],
    ['an extra top-level key', base({ sql: 'select 1' })],
    ['a title over 80 characters', base({ title: 'x'.repeat(81) })],
    ['a CUSTOM window over 400 days', base({ filters: { window: { preset: 'CUSTOM', from: '2024-01-01', to: '2025-12-31' }, divisions: [], customerIds: [], repIds: [], modes: [] } })],
    ['an empty USERS scope', base({ scope: { kind: 'USERS', userIds: [] } })],
    ['a bad scope kind', base({ scope: { kind: 'EVERYONE' } })],
    ['more than 25 customer ids', base({ filters: { window: { preset: 'THIS_MONTH' }, divisions: [], customerIds: Array.from({ length: 26 }, (_, i) => `c${i}`), repIds: [], modes: [] } })],
    ['a control character in a title', base({ title: 'bad\u0007title' })],
  ]
  const listBefore = (await ctx.crm.admin('LIST_DASHBOARDS', {})).company.length
  for (const [name, spec] of cases) {
    await refused(`${name} (run)`, /Invalid dashboard/i, () => ctx.crm.admin('PREVIEW_DASHBOARD', { spec }))
    await refused(`${name} (save)`, /Invalid dashboard/i, () => ctx.crm.admin('SAVE_DASHBOARD', { spec }))
  }
  expect((await ctx.crm.admin('LIST_DASHBOARDS', {})).company.length === listBefore, 'a refused save changed the dashboard list')
  notes.push(`${cases.length} invalid specs are refused by both the run and the save with "Invalid dashboard" (unknown query id, extra param, enum, limit, widget type, >12 widgets, duplicate ids, extra key, title length, CUSTOM >400 d, empty USERS, bad scope, >25 customers, control character; the 32,000 B cap is unreachable through the shape caps, so it is covered by the unit tests only) and nothing was saved`)
  // The window/maxMonths rule is part of validation: a year-to-date window on a 4-month query is refused up front.
  if (Number(nowIso().slice(5, 7)) > 4) {
    const wide = base({ filters: { window: { preset: 'YEAR_TO_DATE' }, divisions: [], customerIds: [ctx.ids.C1], repIds: [], modes: [] }, widgets: [widget({ id: 'ship.summary', params: { metrics: ['count'] } })] })
    await refused('a window over the query maxMonths (run)', /at most \d+ months/i, () => ctx.crm.admin('PREVIEW_DASHBOARD', { spec: wide }))
    await refused('a window over the query maxMonths (save)', /at most \d+ months/i, () => ctx.crm.admin('SAVE_DASHBOARD', { spec: wide }))
    notes.push('a window longer than the query\'s maxMonths is refused at validation ("can cover at most 4 months"), not truncated')
  } else notes.push('maxMonths check skipped: year-to-date is within 4 months right now')
  const control = await ctx.crm.admin('PREVIEW_DASHBOARD', { spec: base() })
  expect(control.results.every((r) => r.ok), 'the valid control spec did not run')
  return notes.join('; ')
}

async function ai09DashRows(ctx) {
  const notes = []
  const index = await sdkGet(ctx, ROLLUP_TABLE, 'DASH:INDEX')
  expect(index && index.kind === 'DASH', `DASH:INDEX is ${index ? `kind ${index.kind}` : 'missing'}`)
  const items = (asJson(index.payload)?.items ?? [])
  const mine = [...ctx.dashIds]
  const rowsOk = []
  for (const id of mine) {
    const row = await sdkGet(ctx, ROLLUP_TABLE, `DASH:${id}`)
    expect(row, `DASH:${id} row is missing`)
    expect(row.kind === 'DASH' && row.periodKey === id && typeof row.version === 'number', `DASH:${id} is not shaped as a DASH row (kind ${row.kind})`)
    const body = asJson(row.payload)
    expect(body && body.spec && !JSON.stringify(body).includes(ctx.names.C1), 'a DASH row carries data (a customer name), not just a spec')
    own(ctx, ROLLUP_TABLE, `DASH:${id}`)
    rowsOk.push(id)
    if (!row.archivedAt && !body.archivedAt) expect(items.some((s) => s.id === id), `active dashboard ${id} is not in DASH:INDEX`)
  }
  notes.push(`DASH:INDEX + ${rowsOk.length} DASH:<uuid> rows live in the existing DashboardRollup table with kind 'DASH' (no M:/LG: kind), carrying specs only; every active one is in the index`)
  const archivedIds = mine.filter((id) => !items.some((s) => s.id === id))
  notes.push(`${archivedIds.length} archived dashboard(s) are absent from the index`)
  // the classic rollup rows are untouched in shape: the month row is not a DASH row and does not mention one
  const monthRow = await sdkGet(ctx, ROLLUP_TABLE, `M:${ctx.month}`)
  if (monthRow) expect(monthRow.kind !== 'DASH' && !JSON.stringify(asJson(monthRow.payload) ?? {}).includes('DASH:'), 'the month rollup row mentions DASH rows')
  notes.push(monthRow ? `M:${ctx.month} is a normal rollup row (kind ${monthRow.kind})` : `M:${ctx.month} does not exist on dev (nothing to compare)`)
  // D1 evidence: any signed-in user can read the DASH rows (specs, no data) straight from AppSync
  const viaApi = await gql(ctx.who.plain.token, 'query { getDashboardRollup(id: "DASH:INDEX") { id kind } }').then((d) => d.getDashboardRollup, () => null)
  notes.push(`D1: a signed-in user with no dashboard rights ${viaApi ? 'CAN' : 'cannot'} read DASH:INDEX through AppSync (specs/titles only, never row data)`)
  return notes.join('; ')
}

async function ai10LiveChat(ctx) {
  if (flag('skip-model')) throw new SkipError('MODEL_UNAVAILABLE: --skip-model')
  if (ctx.modelDown) throw new SkipError(`MODEL_UNAVAILABLE: ${ctx.modelDownMessage}`)
  const spec = await tsImport('src/lib/dashboards/spec.ts')
  const cat = await tsImport('src/lib/dashboards/catalog.ts')
  const notes = []
  const m1 = userMsg('revenue by customer this month with open AR and a shipments by status chart')
  const t1 = ctx.chat1 ?? { res: { reply: '' } }
  const a1 = { role: 'assistant', text: t1.res.reply || 'Who is this for?' }
  const t2 = await chat(ctx, 'repa', { messages: [m1, a1, userMsg('Just me. Build it now and do not ask me anything else: use sensible defaults.')], scope: { kind: 'ME' }, draft: null })
  if (t2.res.modelError) throw new SkipError(`MODEL_UNAVAILABLE: ${t2.res.modelError}`)
  expect(t2.res.spec, `with the scope chosen no spec came back (issues: ${JSON.stringify(t2.res.issues)}; questions: ${JSON.stringify((t2.res.questions ?? []).map((q) => q.text.slice(0, 60)))})`)
  const parsed = spec.parseSpec(t2.res.spec)
  expect(parsed.ok, `the generated spec fails parseSpec: ${(parsed.issues ?? []).join('; ')}`)
  expect(t2.res.spec.widgets.every((w) => cat.QUERY_IDS.includes(w.query.id)), 'a generated widget names a query outside the catalog')
  expect(t2.res.spec.scope.kind === 'ME', `scope came back as ${t2.res.spec.scope.kind}`)
  const run = await ctx.crm.repa('PREVIEW_DASHBOARD', { spec: t2.res.spec })
  expect(run.results.every((r) => r.ok), 'the generated spec has a failing widget')
  expect(!JSON.stringify(run).includes(ctx.names.C3), 'the generated dashboard run leaked a hidden customer')
  notes.push(`scope chosen -> a valid spec (${t2.res.spec.widgets.length} widgets, all whitelisted) in ${t2.ms} ms; it runs for repa without leaking`)
  // iterate: monthly
  const draft = t2.res.spec
  const m2 = userMsg('make the chart monthly')
  const t3 = await chat(ctx, 'repa', { messages: [m1, a1, userMsg('Just me. Build it now and do not ask me anything else: use sensible defaults.'), { role: 'assistant', text: t2.res.reply || 'Built.' }, m2], scope: { kind: 'ME' }, draft })
  if (t3.res.modelError) throw new SkipError(`MODEL_UNAVAILABLE: ${t3.res.modelError}`)
  expect(t3.res.spec && spec.parseSpec(t3.res.spec).ok, 'the monthly revision is not a valid spec')
  const chartTypes = new Set(['BAR', 'LINE', 'PIE'])
  const byId = (s) => new Map(s.widgets.map((w) => [w.id, w]))
  const prev = byId(draft)
  const changedCharts = t3.res.spec.widgets.filter((w) => chartTypes.has(w.type) && canonical(prev.get(w.id) ?? null) !== canonical(w))
  const changedOthers = t3.res.spec.widgets.filter((w) => !chartTypes.has(w.type) && prev.has(w.id) && canonical(prev.get(w.id)) !== canonical(w))
  expect(canonical(t3.res.spec) !== canonical(draft), 'make the chart monthly changed nothing')
  expect(changedCharts.length >= 1 || /MONTH/.test(JSON.stringify(t3.res.spec)), 'no chart widget changed and nothing is monthly')
  expect(changedOthers.length === 0, `non-chart widgets were changed by "make the chart monthly": ${changedOthers.map((w) => w.id).join(',')}`)
  notes.push(`"make the chart monthly" revised ${changedCharts.length} chart widget(s) and left the others alone (${t3.ms} ms)`)
  // add margin
  const t4 = await chat(ctx, 'repa', { messages: [m1, a1, userMsg('Just me. Build it now and do not ask me anything else: use sensible defaults.'), { role: 'assistant', text: t2.res.reply || 'Built.' }, m2, { role: 'assistant', text: t3.res.reply || 'Done.' }, userMsg('add margin')], scope: { kind: 'ME' }, draft: t3.res.spec })
  if (t4.res.modelError) throw new SkipError(`MODEL_UNAVAILABLE: ${t4.res.modelError}`)
  expect(t4.res.spec && spec.parseSpec(t4.res.spec).ok, 'the "add margin" revision is not a valid spec')
  const margins = (s) => (JSON.stringify(s).match(/margin/g) ?? []).length
  expect(margins(t4.res.spec) > margins(t3.res.spec), 'add margin did not add a margin metric')
  notes.push(`"add margin" added a margin metric (${t4.ms} ms)`)
  const saved = await ctx.crm.repa('SAVE_DASHBOARD', { spec: t4.res.spec })
  ctx.dashIds.add(saved.id)
  expect((await ctx.crm.repa('LIST_DASHBOARDS', {})).mine.some((d) => d.id === saved.id), 'the saved chat dashboard is not in My dashboards')
  notes.push('saved: it appears in My dashboards')
  // not-found vs not-visible customer: same text (E4)
  const ask = async (name) => (await chat(ctx, 'repa', { messages: [userMsg(`Show revenue for the customer named "${name}" this month`)], scope: { kind: 'ME' }, draft: null })).res
  const hidden = await ask(ctx.names.C3)
  const ghost = await ask(`ZZ AI Nonexistent Customer ${ctx.ts}`)
  expect(!hidden.modelError && !ghost.modelError, 'the model failed on the name-resolution pair')
  expect(!JSON.stringify(hidden).includes(ctx.ids.C3) && !(hidden.resolved?.customers ?? []).length, 'a hidden customer was resolved for a rep who cannot see it')
  const norm = (r, name) => canonical({ issues: (r.issues ?? []).map((s) => s.split(name).join('<NAME>')), customers: r.resolved?.customers ?? [], unresolved: (r.resolved?.unresolved ?? []).map((s) => s.split(name).join('<NAME>')) })
  expect(norm(hidden, ctx.names.C3) === norm(ghost, `ZZ AI Nonexistent Customer ${ctx.ts}`), 'not-visible and not-found customers are answered differently')
  notes.push('a customer the rep cannot see is answered exactly like one that does not exist')
  return notes.join('; ')
}

async function ai11Timing(ctx) {
  const notes = []
  const spec = dashSpecFor(ctx, { kind: 'ME' })
  const walls = []
  const serverMs = []
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now()
    const r = await ctx.crm.admin('PREVIEW_DASHBOARD', { spec })
    walls.push(Date.now() - t0)
    serverMs.push(r.ms)
  }
  const cold = walls[0]
  const warm = walls.slice(1)
  const p50 = percentile(warm, 50)
  const p95 = percentile(warm, 95)
  ctx.timing = { coldMs: cold, warmP50: p50, warmP95: p95, serverP50: percentile(serverMs.slice(1), 50) }
  expect(p95 <= 4000, `PREVIEW_DASHBOARD warm p95 ${p95} ms exceeds the 4,000 ms budget (p50 ${p50}, cold ${cold})`)
  notes.push(`PREVIEW_DASHBOARD reference spec (8 widgets, viewAll): cold ${cold} ms, warm p50 ${p50} ms, p95 ${p95} ms of 5 runs (budget p95 <= 4,000 ms); server-side p50 ${ctx.timing.serverP50} ms`)
  if (ctx.model.ms.length) {
    const c50 = percentile(ctx.model.ms, 50), c95 = percentile(ctx.model.ms, 95)
    ctx.timing.chatP50 = c50; ctx.timing.chatP95 = c95
    expect(c95 < 22_000, `chat turn p95 ${c95} ms is over the 22 s abort mark`)
    notes.push(`chat turns (${ctx.model.ms.length} answered by the real model): p50 ${c50} ms, p95 ${c95} ms (budget < 22,000 ms)`)
  } else notes.push('chat timing: no turn was answered by the model (unavailable), nothing to record')
  notes.push(`model calls used: ${ctx.model.calls} of ${MODEL_CALL_CAP}`)
  return notes.join('; ')
}

// ───────────────────────────── browser walk (AI12) ─────────────────────────────
const byTestId = (id) => `[data-testid="${id}"]`
const hasTestId = (b, id) => b.evaluate(`!!document.querySelector(${JSON.stringify(byTestId(id))})`)
const bodyText = (b) => b.evaluate(`document.querySelector('.tms-main')?.innerText ?? document.body.innerText`)

async function openPage(b, path, ready) {
  b.mark()
  await b.navigate(path)
  await waitLoaded(b)
  if (ready) await b.poll(ready, `${path} ready`, 60_000)
  await pause(600)
}

async function withBrowser(ctx, who, fn) {
  const w = ctx.who[who]
  const b = await launchBrowser({ origin: ctx.origin, storage: w.storage, profilePrefix: `bcat-ai-${who}-`, purpose: 'AI verification', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } })
  try {
    await b.navigate('/tms/dashboard')
    await b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell sidebar mounted', 60_000)
    return await fn(b)
  } finally { await b.close().catch(() => {}) }
}

async function typeInto(b, selector, text) {
  await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); })()`)
  await b.command('Input.insertText', { text })
}

async function uiStep(b, id, fn) {
  if (!matches(id)) return
  try {
    b.mark()
    const detail = await fn()
    const problems = problemList(b).slice(0, 3)
    if (problems.length) throw new Error(problems.join(' | '))
    line('PASS', id, detail)
  } catch (err) { line('FAIL', id, short(err)) }
}

async function ai12Ui(ctx) {
  if (flag('no-ui')) throw new SkipError('--no-ui')
  const light = (b, nn, slug) => walk.shot(b, nn, slug, 'light', true)
  const dual = async (b, nn, slug) => {
    await light(b, nn, slug)
    if (flag('no-dark')) return
    await walk.setTheme(b, 'dark')
    await pause(400)
    await walk.shot(b, nn, slug, 'dark', true)
    await walk.setTheme(b, 'light')
  }
  const notes = []
  const dashNames = [ctx.names.C1, ctx.names.C2, ctx.names.C3, ctx.names.C4]

  // admin: tabs, the classic page for viewAll, Settings > Users claims
  await withBrowser(ctx, 'admin', async (b) => {
    await uiStep(b, 'AI12-tabs', async () => {
      await openPage(b, '/tms/dashboard', () => hasTestId(b, 'dash-new'))
      const text = await bodyText(b)
      for (const t of ['Overview', 'Company dashboards', 'My dashboards']) expect(text.includes(t), `the tab strip has no "${t}"`)
      await b.poll(() => b.evaluate(`!!document.querySelector('.tms-dash-kpis')`), 'the classic KPI strip for a viewAll viewer', 60_000)
      expect(!(await hasTestId(b, 'dash-visibility-banner')), 'a viewAll viewer sees the "only your customers" banner')
      await dual(b, 'AI01', 'dashboard-tabs')
      await openPage(b, '/tms/dashboard?tab=company', () => b.evaluate(`!!document.querySelector('[data-testid^="dash-card-"]')`))
      expect(await hasTestId(b, `dash-card-${ctx.dashCompany}`), 'the COMPANY dashboard has no card under Company dashboards')
      notes.push('admin: tabs + New dashboard + classic KPI strip; the COMPANY dashboard card is listed')
      return 'tabs Overview / Company dashboards / My dashboards, New dashboard button, classic page for viewAll'
    })
    await uiStep(b, 'AI12-users-claims', async () => {
      // Not openPage/waitLoaded: another card on this page ("Aljex code mapping") can sit on "Loading codes…" for a long time.
      b.mark()
      await b.navigate('/tms/brokerage/users')
      await b.poll(() => b.evaluate(`!!document.querySelector('[data-testid="user-card"]')`), 'user cards', 60_000)
      await pause(600)
      const email = ctx.who.claimee.email
      const opened = await b.evaluate(`(() => {
        const card = [...document.querySelectorAll('[data-testid="user-card"]')].find((c) => c.innerText.includes(${JSON.stringify(email)}));
        if (!card) return 'no card';
        const btn = card.querySelector('[aria-label="Toggle permissions"]');
        if (!btn) return 'no toggle';
        card.scrollIntoView({ block: 'start' });
        btn.click();
        return 'ok';
      })()`)
      expect(opened === 'ok', `could not open the permissions of the claim-test user (${opened})`)
      await pause(600)
      const text = await b.evaluate(`[...document.querySelectorAll('[data-testid="user-card"]')].find((c) => c.innerText.includes(${JSON.stringify(email)})).innerText`)
      for (const label of ['Create dashboards', 'Publish company dashboards', "See all customers' data"]) expect(text.includes(label), `Settings > Users has no "${label}" permission`)
      expect((text.match(/enforced/gi) ?? []).length >= 3, 'the three permissions are not tagged enforced')
      await walk.shot(b, 'AI13', 'settings-users-permissions', 'light', false)
      return 'the three new permissions render with the enforced tag'
    })
  })

  // plain: no create -> no button, builder bounces
  await withBrowser(ctx, 'plain', async (b) => {
    await uiStep(b, 'AI12-no-create', async () => {
      await openPage(b, '/tms/dashboard', () => b.evaluate(`document.querySelector('[role="tablist"], .tms-tabs') !== null || document.body.innerText.includes('Overview')`))
      expect(!(await hasTestId(b, 'dash-new')), 'a user without dashboards.create sees the New dashboard button')
      await b.poll(() => hasTestId(b, 'dash-visibility-banner'), 'the scoped Overview banner', 60_000)
      expect(!(await b.evaluate(`!!document.querySelector('.tms-dash-kpis')`)), 'the classic dashboard mounted for a non-viewAll user')
      await walk.shot(b, 'AI02', 'no-permission-no-button', 'light', true)
      await b.navigate('/tms/dashboard/new')
      await b.poll(() => b.evaluate(`location.pathname === '/tms/dashboard'`), '/tms/dashboard/new bouncing', 20_000)
      return 'no New dashboard button; /tms/dashboard/new redirects to /tms/dashboard; scoped Overview with the banner; classic KPI strip not mounted'
    })
  })

  // repa: overview, builder (chat), save, cards, the company dashboard
  const keepDash = async (b) => {
    await uiStep(b, 'AI12-overview', async () => {
      await openPage(b, '/tms/dashboard', () => hasTestId(b, 'dash-visibility-banner'))
      expect(!(await b.evaluate(`!!document.querySelector('.tms-dash-kpis')`)), 'the classic dashboard mounted for repa')
      await b.poll(async () => (await bodyText(b)).includes(ctx.names.C1), 'repa\'s own customer in the Overview', 60_000).catch(() => {})
      const text = await bodyText(b)
      for (const n of [ctx.names.C2, ctx.names.C3, ctx.names.C4]) expect(!text.includes(n), 'the Overview shows a customer repa cannot see')
      await walk.shot(b, 'AI12', 'overview-non-viewall', 'light', true)
      return 'scoped Overview with the banner; only repa\'s customer appears'
    })
  }
  const state = { saved: null, chatSpec: false }
  await withBrowser(ctx, 'repa', async (b) => {
    await keepDash(b)
    await uiStep(b, 'AI12-builder', async () => {
      await openPage(b, '/tms/dashboard', () => hasTestId(b, 'dash-new'))
      await b.click({ selector: byTestId('dash-new') })
      await b.poll(() => hasTestId(b, 'dash-transcript'), 'the builder', 30_000)
      expect(await hasTestId(b, 'dash-d1-banner'), 'the builder does not print the D1 notice')
      if (flag('skip-model')) { state.chatSpec = false; return 'builder opens with the D1 notice (no message sent: --skip-model)' }
      expect(ctx.model.calls < MODEL_CALL_CAP, 'model call cap reached before the UI chat')
      ctx.model.calls += 1
      await typeInto(b, 'textarea[aria-label="Message"]', 'revenue by customer this month with open AR')
      await b.click({ selector: byTestId('dash-send') })
      await b.poll(() => b.evaluate(`!document.querySelector('.dbb-thinking') && (!!document.querySelector('[data-testid="dash-scope-question"]') || !!document.querySelector('[data-testid="dash-model-error"]'))`), 'the first assistant turn', 60_000)
      expect(await hasTestId(b, 'dash-scope-question'), 'the assistant did not ask who the dashboard is for')
      expect(await b.evaluate(`document.querySelectorAll('[data-testid^="dash-scope-"][role="radio"]').length === 4`), 'the scope picker does not show the four options')
      const modelError = await hasTestId(b, 'dash-model-error')
      await dual(b, 'AI03', 'chat-first-turn')
      if (modelError) await light(b, 'AI14', 'model-unavailable')
      const disabled = await b.evaluate(`document.querySelector('[data-testid="dash-scope-COMPANY"]').disabled`)
      expect(disabled, 'Whole company is enabled for a user without publishCompany')
      await light(b, 'AI04', 'scope-company-disabled')
      if (modelError || ctx.modelDown || flag('skip-model')) { state.chatSpec = false; return `scope question + four options + D1 notice; Whole company disabled; model ${modelError ? 'UNAVAILABLE (Retry state shown)' : 'not used'}` }
      expect(ctx.model.calls < MODEL_CALL_CAP, 'model call cap reached before the scope turn')
      ctx.model.calls += 1
      await b.click({ selector: byTestId('dash-scope-ME') })
      await light(b, 'AI05', 'scope-picked-generating')
      await b.poll(() => b.evaluate(`!document.querySelector('.dbb-thinking') && (!!document.querySelector('[data-testid="dash-grid"]') || !!document.querySelector('[data-testid="dash-model-error"]'))`), 'the generated dashboard', 90_000)
      if (await hasTestId(b, 'dash-grid')) {
        await b.poll(() => b.evaluate(`!document.querySelector('[data-testid="dash-grid"]')?.getAttribute('aria-busy')?.includes('true')`), 'the preview run', 60_000)
        await dual(b, 'AI06', 'generated-dashboard')
        state.chatSpec = true
        expect(ctx.model.calls < MODEL_CALL_CAP, 'model call cap reached before the iteration turn')
        ctx.model.calls += 1
        await typeInto(b, 'textarea[aria-label="Message"]', 'make the chart monthly')
        await b.click({ selector: byTestId('dash-send') })
        await b.poll(() => b.evaluate(`!document.querySelector('.dbb-thinking')`), 'the iteration turn', 90_000)
        await pause(1500)
        await light(b, 'AI07', 'iterate-monthly')
        await b.click({ selector: byTestId('dash-save') })
        await b.poll(() => hasTestId(b, 'dash-save-confirm'), 'the save dialog', 15_000)
        await light(b, 'AI08', 'save-dialog')
        await b.click({ selector: byTestId('dash-save-confirm') })
        await b.poll(() => b.evaluate(`/\\/tms\\/dashboard\\/d\\//.test(location.pathname)`), 'the saved dashboard page', 30_000)
        const id = await b.evaluate(`location.pathname.split('/').pop()`)
        state.saved = id
        ctx.dashIds.add(id)
        return 'chat -> scope chip -> generated dashboard -> "make the chart monthly" -> save dialog -> saved'
      }
      return 'scope chosen but the model did not return a spec (provider refused on the second turn); API-saved spec used for the later shots'
    })
    if (!state.saved) {
      // Model unavailable: the dashboard shots come from an API-saved spec (the BUILD_LOG records that).
      const apiSaved = await ctx.crm.repa('SAVE_DASHBOARD', { spec: { ...dashSpecFor(ctx, { kind: 'ME' }, []), title: 'ZZ AI generated (API-saved)' } })
      ctx.dashIds.add(apiSaved.id)
      state.saved = apiSaved.id
      state.fromApi = true
      await uiStep(b, 'AI12-viewer', async () => {
        await openPage(b, `/tms/dashboard/d/${apiSaved.id}`, () => hasTestId(b, 'dash-grid'))
        await b.poll(async () => (await bodyText(b)).includes(ctx.names.C1), 'repa\'s own customer in the dashboard', 60_000)
        await dual(b, 'AI06', 'generated-dashboard')
        return 'API-saved spec rendered (model unavailable): KPI, bar, table and list widgets'
      })
      await uiStep(b, 'AI12-edit', async () => {
        await openPage(b, `/tms/dashboard/d/${apiSaved.id}/edit`, () => hasTestId(b, 'dash-preview'))
        await pause(1500)
        await light(b, 'AI07', 'iterate-monthly')
        await b.click({ selector: byTestId('dash-save') })
        await b.poll(() => hasTestId(b, 'dash-save-confirm'), 'the save dialog', 15_000)
        await light(b, 'AI08', 'save-dialog')
        await b.press('Escape')
        return 'builder opened on the API-saved spec with the live preview; save dialog shown (AI07 is the builder view, not a chat iteration)'
      })
    }
    await uiStep(b, 'AI12-my-dashboards', async () => {
      await openPage(b, '/tms/dashboard?tab=mine', () => hasTestId(b, 'dash-cards'))
      expect(await hasTestId(b, `dash-card-${state.saved}`), 'the saved dashboard has no card under My dashboards')
      expect(await hasTestId(b, 'dash-new'), 'the creator has no New dashboard button')
      await walk.shot(b, 'AI09', 'my-dashboards-cards', 'light', true)
      return 'the saved dashboard is a card under My dashboards'
    })
    await uiStep(b, 'AI12-company-as-repa', async () => {
      await openPage(b, `/tms/dashboard/d/${ctx.dashCompany}`, () => hasTestId(b, 'dash-grid'))
      await b.poll(async () => (await bodyText(b)).includes(ctx.names.C1), 'repa\'s own customer in the company dashboard', 60_000)
      const text = await bodyText(b)
      for (const n of [ctx.names.C2, ctx.names.C3, ctx.names.C4]) expect(!text.includes(n), 'the company dashboard shows repa a customer they cannot see')
      expect(await hasTestId(b, 'dash-visibility-banner'), 'no "only your customers" banner on the company dashboard for repa')
      expect(!text.includes(money(AMOUNTS.C3)) && !text.includes(money(AMOUNTS.C4)), 'a hidden amount is on the page')
      await walk.shot(b, 'AI10', 'company-dashboard-as-repa', 'light', true)
      return 'the COMPANY dashboard shows repa only their customer and the banner'
    })
  })

  await withBrowser(ctx, 'acct', async (b) => {
    await uiStep(b, 'AI12-company-as-acct', async () => {
      await openPage(b, `/tms/dashboard/d/${ctx.dashCompany}`, () => hasTestId(b, 'dash-grid'))
      await b.poll(async () => (await bodyText(b)).includes(ctx.names.C4), 'all four customers for a viewAll viewer', 60_000)
      const text = await bodyText(b)
      for (const n of dashNames) expect(text.includes(n), `the viewAll viewer's dashboard lacks ${n}`)
      expect(!(await hasTestId(b, 'dash-visibility-banner')), 'a viewAll viewer sees the banner')
      await walk.shot(b, 'AI11', 'company-dashboard-as-acct', 'light', true)
      return 'the same COMPANY dashboard shows the viewAll accountant all four customers, no banner'
    })
  })
  return notes.length ? 'browser walk finished (see the AI12 lines above)' : 'browser walk finished'
}

// ───────────────────────────── sweep (AI13) + cleanup (AI14) ─────────────────────────────
async function dashSnapshot(ctx) {
  const snap = {}
  for (const id of ['DASH:INDEX', ...[...ctx.dashIds].map((i) => `DASH:${i}`)]) {
    const row = await sdkGet(ctx, ROLLUP_TABLE, id)
    snap[id] = row ? { version: row.version, updatedAt: row.updatedAt, payload: sha(typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload)) } : null
  }
  return snap
}

async function ai13Sweep(ctx) {
  const before = await dashSnapshot(ctx)
  const l0 = (await sdkGet(ctx, ROLLUP_TABLE, 'L:CURRENT'))?.computedAt ?? ctx.sweep0
  const deadline = Date.now() + 330_000
  let advanced = false
  while (Date.now() < deadline) {
    const now = (await sdkGet(ctx, ROLLUP_TABLE, 'L:CURRENT'))?.computedAt ?? null
    if (now && now !== l0) { advanced = true; break }
    await sleep(15_000)
  }
  if (!advanced) throw new SkipError(`L:CURRENT was not recomputed within 330 s (computedAt ${l0 ?? 'absent'}): no sweep observed`)
  const after = await dashSnapshot(ctx)
  const changed = Object.keys(before).filter((k) => canonical(before[k]) !== canonical(after[k]))
  expect(!changed.length, `a rollup sweep touched DASH rows: ${changed.join(', ')}`)
  return `a real sweep ran (L:CURRENT recomputed); ${Object.keys(before).length} DASH rows (index + ${Object.keys(before).length - 1} dashboards) have the same version, updatedAt and payload hash before and after`
}

async function ai14Cleanup(ctx) {
  let ok = true
  const say = (msg, good) => { line(good ? 'PASS' : 'FAIL', 'AI14-cleanup', msg); if (!good) ok = false }
  const attempt = async (label, fn) => { try { return await fn() } catch (err) { say(`${label} failed: ${short(err).slice(0, 140)}`, false); return null } }
  let archived = 0
  let rows = 0
  if (ctx.who?.admin) {
    for (const id of ctx.dashIds) {
      await attempt(`archive dashboard ${id}`, async () => {
        const got = await ctx.crm.admin('GET_DASHBOARD', { id }).catch(() => null)
        if (got) { await ctx.crm.admin('ARCHIVE_DASHBOARD', { id, expectedVersion: got.dashboard.version }); archived += 1 }
      })
      await attempt(`delete DASH row ${id}`, async () => {
        own(ctx, ROLLUP_TABLE, `DASH:${id}`)
        if (await sdkDelete(ctx, ROLLUP_TABLE, `DASH:${id}`)) rows += 1
      })
    }
    // the shared team list goes back byte-for-byte (canonical JSON)
    if (ctx.teams0) {
      await attempt('restore TmsSettings.teams', async () => {
        await writeTeams(ctx, ctx.teams0.teams)
        const after = await readTeams(ctx)
        say(`TmsSettings.teams restored (${after.teams.length} team(s)); equal to the snapshot: ${canonical(after.teams) === canonical(ctx.teams0.teams)}`, canonical(after.teams) === canonical(ctx.teams0.teams))
      })
    }
  }
  let removed = 0
  const kinds = ['Quote', 'Invoice', 'LaneRateSample', 'Shipment', 'Customer', 'UserProfile']
  for (const key of [...ctx.owned].filter((k) => kinds.includes(k.split(':')[0]))) {
    const [model, ...rest] = key.split(':')
    const id = rest.join(':')
    await attempt(`delete ${model} ${id}`, async () => { if (await sdkDelete(ctx, model, id)) removed += 1 })
  }
  await attempt('residue check', async () => {
    let left = 0
    for (const key of ctx.owned) {
      const [model, ...rest] = key.split(':')
      if (await sdkGet(ctx, model, rest.join(':'))) left += 1
    }
    const index = await sdkGet(ctx, ROLLUP_TABLE, 'DASH:INDEX')
    const inIndex = (asJson(index?.payload)?.items ?? []).filter((s) => ctx.dashIds.has(s.id)).length
    say(`residue: ${left} registered rows left, ${inIndex} dashboards left in DASH:INDEX`, left === 0 && inIndex === 0)
  })
  line('PASS', 'AI14-cleanup', `ledger: ${archived} dashboards archived, ${rows} DASH rows deleted, ${removed} ZZ fixture rows deleted`)
  expect(ok, 'cleanup left residue (see the lines above)')
  return 'dashboards archived and their DASH rows deleted; ZZ customers, shipments, samples, quotes, invoices and profiles deleted; teams restored; no residue'
}

// ───────────────────────────── runners + main ─────────────────────────────
const RUNNERS = {
  AI00: ai00Setup, AI01: ai01Inventory, AI02: ai02Claims, AI03: ai03Refusals, AI04: ai04ScopeGate, AI05: ai05Matrix, AI06: ai06Revocation,
  AI07: ai07Audience, AI08: ai08Validation, AI09: ai09DashRows, AI10: ai10LiveChat, AI11: ai11Timing, AI12: ai12Ui, AI13: ai13Sweep, AI14: ai14Cleanup,
}

async function step(id, fn) {
  const cleanup = id.startsWith('AI14')
  if (!matches(id) && !cleanup && !id.startsWith('AI00')) return undefined
  try {
    const detail = await fn()
    if (detail !== undefined) line('PASS', id, typeof detail === 'string' ? detail : undefined)
    return detail
  } catch (err) {
    if (err instanceof SkipError) { skipLine(id, '', err.message); return undefined }
    line('FAIL', id, short(err).slice(0, 1800))
    return undefined
  }
}

async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAI refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyAI refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAI only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  if (!(await inventory())) { process.exitCode = 1; return }
  if (flag('inventory')) return

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const made = []
  const ctx = {
    ts, origin, suffix: null, who: {}, crm: {}, owned: new Set(), dashIds: new Set(), model: { calls: 0, ms: [] },
    modelDown: false, modelDownMessage: null, dashCompany: null, month: null, names: {}, ids: {}, shipIds: {},
  }
  try {
    ctx.suffix = await discoverDevSuffix()
    console.log('dev table suffix discovered (ok)')
    await mintAll(ctx, made)
    console.log(`identity: ${made.length} temporary staff identities created`)
    await step('AI00-setup', () => RUNNERS.AI00(ctx))
    if (!ctx.setupOk) throw new Error('setup did not finish (see the AI00 line): nothing else can run')
    await step('AI01-inventory', () => RUNNERS.AI01(ctx))
    for (const id of ['AI02', 'AI03', 'AI04', 'AI05', 'AI06', 'AI07', 'AI08', 'AI09', 'AI10', 'AI11', 'AI12', 'AI13']) {
      await step(`${id}-${AI_STEPS.find((s) => s.id === id).slug}`, () => RUNNERS[id](ctx))
    }
  } finally {
    if (ctx.suffix && ctx.who.admin) await step('AI14-cleanup', () => RUNNERS.AI14(ctx)).catch(() => {})
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
  console.log(`\nmodel calls: ${ctx.model.calls} of ${MODEL_CALL_CAP}; timing: ${JSON.stringify(ctx.timing ?? {})}`)
  console.log(`summary: ${JSON.stringify({ pass, fail, skipped: skipped.length, skippedNotAllowed: unallowed.length })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (fail > 0 || unallowed.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAI failed: ${err?.message ?? err}`); process.exit(1) })
}
