#!/usr/bin/env node
/**
 * Steps AJ + AK verification against the DEV site: Load Tracking simplification (one nav row, redirects, Focus grid,
 * tracking drawer, customer / shipment tracking preferences) and per-truck driver work phones (AJK-plan §9).
 *
 *   node scripts/devVerifyAJ.mjs [--inventory] [--only=<substring>] [--no-dark] [--expect-last4=<nnnn>]
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyAJ.mjs
 *
 *   --inventory      no network, no browser: nav shape, redirect table, route registries (aaRoutes, devVerifyS2, uRoutes),
 *                    every file the plan creates, every action / data-testid the steps use, no source file outside the
 *                    redirect table naming a retired path.
 *   --only=          run only the steps whose id contains the substring (fixtures are still created).
 *   --no-dark        skip the dark-theme screenshots.
 *   --expect-last4=  the last four digits Main expects on John Brittich's seeded truck phone (step AJ12); without it
 *                    AJ12 only proves a valid phone exists, or SKIPS when the seed has not run yet.
 *
 * RUNS ONLY AFTER THE DEPLOY (the steps use the AJ/AK backend fields and actions). Dev only: refuses any AppSync
 * endpoint but the dev one, any staff pool but the dev pool, any origin outside ALLOWED_ORIGINS and any DynamoDB table
 * suffix that is the production one. No SSM, no main / production, no invoice_*.json, no Aljex export. Two throwaway
 * identities (zz-aj-admin-<ts> ADMIN, zz-aj-tms-<ts> with only page-tms) are created and deleted (and proven gone) in
 * `finally`; passwords and tokens are never printed. Nothing is ever sent: Twilio is unset on dev, every text lands NOT_SENT.
 *
 * Everything it creates is ZZ AJ …: customers, shipments, one driver, two trucks and their TruckConfig rows, fictional
 * +1312555 01xx numbers. In `finally` shipments are VOIDED (PROs are permanent), customers archived, the ZZ driver / trucks /
 * TruckConfig rows deleted and re-read, SDK-written legs deleted. John Brittich's truck is only READ (step AJ12).
 * Output carries ids, counts and masked numbers only.
 *
 * Screenshots: Docs/tms-build/screenshots/aj/<name>.png, 1440×900, listed in index.txt.
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk } from './lib/uiWalk.mjs'
import { AA_HOMES, CHECK_CALLS_LANDING, DOCS_LANDING, aaLifecycleTabs } from './lib/aaRoutes.mjs'
import { U_KEPT, U_REDIRECTS } from './lib/uRoutes.mjs'
import { ROUTES as S2_ROUTES } from './devVerifyS2.mjs'

const DEV_APPSYNC = APPSYNC_URL_RE
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4'
const SHOTS = resolve('Docs/tms-build/screenshots/aj')
const VOID_REASON = 'AJ harness'
const REGION = 'us-east-1'
const WORK_PHONE = '+13125550102'       // fictional: the truck's work phone
const PERSONAL_PHONE = '+13125550101'   // fictional: the driver's own phone
const RETIRED_PATHS = ['/tms/check-calls', '/tms/documents/review']

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const valueOf = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const only = valueOf('only')
const expectLast4 = valueOf('expect-last4')

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: {}, only })
const { line, report, written, waitLoaded, matches, skipLine } = walk

/** Every AJ id, in run order. AJ01-AJ06 are API-only; AJ07-AJ11 need the browser; AJ12 is read-only; AJ13 cannot be automated. */
export const AJ_STEPS = [
  { id: 'AJ01', slug: 'schema' },
  { id: 'AJ02', slug: 'override' },
  { id: 'AJ03', slug: 'manual-gate' },
  { id: 'AJ04', slug: 'method' },
  { id: 'AJ05', slug: 'truck-phone' },
  { id: 'AJ06', slug: 'reply' },
  { id: 'AJ07', slug: 'ui-nav' },
  { id: 'AJ08', slug: 'ui-grid' },
  { id: 'AJ09', slug: 'ui-drawer' },
  { id: 'AJ10', slug: 'ui-customer' },
  { id: 'AJ11', slug: 'ui-trucks' },
  { id: 'AJ12', slug: 'john' },
  { id: 'AJ13', slug: 'driver-app' },
]

/** Files the plan creates (AJK-plan §5): the inventory fails if one is missing. */
const PLAN_FILES = [
  'src/lib/trackingPrefs.ts', 'src/lib/workPhone.ts', 'src/hooks/useTruckConfigs.ts', 'src/components/DriverPhones.tsx',
  'amplify/functions/tms-tracking-actions/driverPhone.ts',
  'src/features/shipments/workstations/tracking/legacyRoutes.ts',
  'src/features/shipments/workstations/tracking/ShipmentTrackingView.tsx',
  'src/features/shipments/workstations/tracking/TrackingSummaryStrip.tsx',
  'src/features/shipments/workstations/tracking/trackingSummary.ts',
  'src/features/shipments/workstations/tracking/RecentCheckCalls.tsx',
  'src/features/shipments/workstations/tracking/TrackingPrefsRow.tsx',
  'src/features/shipments/workstations/tracking/TrackingDrawer.tsx',
  'src/features/documents/DocumentReviewPanel.tsx', 'src/features/documents/DocumentReviewDialog.tsx',
  'src/features/directory/components/TrackingPrefsFields.tsx',
  'src/features/trucks/TruckPhoneEditor.tsx', 'src/features/settings/TruckPhonesCard.tsx',
  'scripts/seedTruckPhone.mjs', 'scripts/seedTruckPhone.test.mjs',
]
/** Files the plan deletes. */
const GONE_FILES = ['src/features/tracking/CheckCallsPage.tsx', 'src/features/documents/DocumentReviewPage.tsx']

const tid = (id) => `[data-testid="${id}"]`
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const asJson = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return v } })() : v)
const nowIso = () => new Date().toISOString()
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
const last4 = (number) => String(number ?? '').replace(/\D/g, '').slice(-4)
const mask = (number) => (number ? `***-***-${last4(number)}` : '(none)')
class SkipError extends Error {}

// ───────────────────────────── inventory (no network, no browser) ─────────────────────────────
const HANDLERS = {
  ship: 'amplify/functions/tms-shipment-actions/handler.ts',
  dir: 'amplify/functions/tms-directory-actions/handler.ts',
  trk: 'amplify/functions/tms-tracking-actions/handler.ts',
}

async function sourceFiles(dir) {
  const out = []
  for (const entry of await readdir(resolve(dir), { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await sourceFiles(full))
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full)
  }
  return out
}

const exists = (file) => access(resolve(file)).then(() => true, () => false)

export async function inventory() {
  const self = await readFile(resolve('scripts/devVerifyAJ.mjs'), 'utf8')
  const runners = Object.keys(RUNNERS)
  const registered = AJ_STEPS.map((s) => s.id)
  const disagree = registered.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !registered.includes(id)))
  if (disagree.length) { line('FAIL', 'AJ00 gate 1: AJ ids registered', `registry and runners disagree on: ${disagree.join(', ')}`); return false }
  line('PASS', 'AJ00 gate 1: AJ ids registered', `${registered.length} steps each have a runner`)

  // gate 2: Load Tracking is the Track lifecycle tab (Step AV), not a sidebar row
  const GATE2 = 'AJ00 gate 2: Load Tracking is a lifecycle tab, not a sidebar row'
  const nav = await readFile(resolve('src/lib/navSections.ts'), 'utf8')
  const pinned = nav.slice(nav.indexOf('export const PINNED_ITEMS'), nav.indexOf('export function flatNavDefs'))
  const rows = ['/tms/tracking', '/tms/check-calls', '/tms/documents/review'].filter((p) => pinned.includes(`to: '${p}'`) || pinned.includes(`to: "${p}"`))
  if (rows.length || /label: 'Load Tracking'/.test(pinned)) { line('FAIL', GATE2, `PINNED_ITEMS still has a Load Tracking row or links ${rows.join(', ') || '(label only)'}`); return false }
  const tabs = await aaLifecycleTabs()
  const track = tabs.find((t) => t.key === 'track')
  if (!track || track.to !== '/tms/tracking') { line('FAIL', GATE2, `LIFECYCLE_TABS has no Track tab linking /tms/tracking (got ${track?.to ?? 'none'})`); return false }
  if (!track.matches.includes('/tms/tracking') || !track.matches.includes('/tms/tracking/*')) { line('FAIL', GATE2, `the Track tab does not light on /tms/tracking and /tms/tracking/links (matches ${track.matches.join(', ')})`); return false }
  const home = AA_HOMES.find((h) => h.pattern === '/tms/tracking')
  if (home?.kind !== 'lifecycle' || home.tab !== 'track') { line('FAIL', GATE2, `aaRoutes homes /tms/tracking as ${home?.kind}/${home?.tab}, expected lifecycle/track`); return false }
  line('PASS', GATE2, 'no Load Tracking row in the pinned sidebar block; the Track tab links /tms/tracking and lights on /tms/tracking/*; aaRoutes homes it as lifecycle/track')

  // gate 3: the redirect table and the registries agree
  const legacy = await readFile(resolve('src/features/shipments/workstations/tracking/legacyRoutes.ts'), 'utf8')
  const constant = (name) => new RegExp(`export const ${name} = '([^']+)'`).exec(legacy)?.[1]
  const problems = []
  if (constant('CHECK_CALLS_LANDING') !== CHECK_CALLS_LANDING) problems.push(`CHECK_CALLS_LANDING differs (${constant('CHECK_CALLS_LANDING')} vs ${CHECK_CALLS_LANDING})`)
  if (constant('DOCS_LANDING') !== DOCS_LANDING) problems.push(`DOCS_LANDING differs (${constant('DOCS_LANDING')} vs ${DOCS_LANDING})`)
  const pages = (rows) => rows.filter((r) => RETIRED_PATHS.includes(r.pattern) || RETIRED_PATHS.includes(r.path))
  const asPage = AA_HOMES.filter((h) => h.kind === 'page' && RETIRED_PATHS.includes(h.pattern))
  if (asPage.length) problems.push(`aaRoutes still has page rows for ${asPage.map((h) => h.pattern).join(', ')}`)
  if (pages(S2_ROUTES).length) problems.push('devVerifyS2 ROUTES still walks a retired path')
  if (U_KEPT.some((k) => RETIRED_PATHS.includes(k.path))) problems.push('uRoutes U_KEPT still lists a retired path')
  if (U_REDIRECTS.some((r) => r[2] !== '/tms/tracking' && /documents/.test(r[0]))) problems.push('uRoutes documents redirects do not land on /tms/tracking')
  if (!AA_HOMES.some((h) => h.pattern === '/tms/tracking/links' && h.kind === 'offnav')) problems.push('aaRoutes lacks the off-nav /tms/tracking/links row')
  const app = await readFile(resolve('src/App.tsx'), 'utf8')
  if (!/path="tracking\/links"/.test(app)) problems.push('App.tsx dropped the /tms/tracking/links route')
  for (const needle of ['CHECK_CALLS_LANDING', 'DOCS_LANDING']) if (!app.includes(needle)) problems.push(`App.tsx does not use ${needle}`)
  if (problems.length) { line('FAIL', 'AJ00 gate 3: redirect table and registries agree', problems.join('; ')); return false }
  line('PASS', 'AJ00 gate 3: redirect table and registries agree', 'landings match legacyRoutes.ts; no page row for a retired path in aaRoutes / devVerifyS2 / uRoutes; /tms/tracking/links stays off-nav')

  // gate 4: files exist / are gone
  const missing = []
  for (const f of PLAN_FILES) if (!(await exists(f))) missing.push(f)
  const lingering = []
  for (const f of GONE_FILES) if (await exists(f)) lingering.push(f)
  if (missing.length || lingering.length) {
    line('FAIL', 'AJ00 gate 4: plan files', [missing.length ? `missing: ${missing.join(', ')}` : '', lingering.length ? `still present: ${lingering.join(', ')}` : ''].filter(Boolean).join('; '))
    return false
  }
  line('PASS', 'AJ00 gate 4: plan files', `${PLAN_FILES.length} created files exist, ${GONE_FILES.length} retired pages are gone`)

  // gate 5: every action the steps call has a handler case
  const cases = {}
  for (const [key, file] of Object.entries(HANDLERS)) {
    const text = await readFile(resolve(file), 'utf8')
    cases[key] = new Set([...text.matchAll(/case '([A-Z_]+)':/g)].map((m) => m[1]))
  }
  const absent = []
  let calls = 0
  for (const m of self.matchAll(/\bctx\.(ship|dir|trk)\('([A-Z_]+)'/g)) {
    calls += 1
    if (!cases[m[1]].has(m[2])) absent.push(`${m[2]} (${HANDLERS[m[1]]})`)
  }
  if (absent.length) { line('FAIL', 'AJ00 gate 5: every action the steps call exists', absent.join('; ')); return false }
  line('PASS', 'AJ00 gate 5: every action the steps call exists', `${calls} call sites, all with a handler case`)

  // gate 6: every data-testid a step selects exists in the source
  const sources = [
    ...await sourceFiles('src/features/shipments/workstations'),
    ...await sourceFiles('src/features/shipments/components'),
    ...await sourceFiles('src/features/tms'),
  ]
  const haystack = (await Promise.all(sources.map((f) => readFile(resolve(f), 'utf8')))).join('\n')
  const ids = [...new Set([...self.matchAll(/\btid\('([^'$]+)'\)/g), ...self.matchAll(/data-testid="([A-Za-z0-9-]+)"/g)].map((m) => m[1]))]
  // `lifecycle-tab-<key>` is a template in LifecycleTabs.tsx (`lifecycle-tab-${tab.key}`): resolved by the key being a LIFECYCLE_TABS tab.
  const templated = (id) => /^lifecycle-tab-(\w+)$/.exec(id) && haystack.includes('lifecycle-tab-${tab.key}') && tabs.some((t) => `lifecycle-tab-${t.key}` === id)
  const unresolved = ids.filter((id) => !templated(id) && !haystack.includes(`"${id}"`) && !haystack.includes(`'${id}'`))
  if (unresolved.length) { line('FAIL', 'AJ00 gate 6: every data-testid a step selects exists', unresolved.join(', ')); return false }
  line('PASS', 'AJ00 gate 6: every data-testid a step selects exists', `${ids.length} ids`)

  // gate 7: no source file outside the redirect table names a retired path
  const offenders = []
  for (const file of await sourceFiles('src')) {
    if (file.endsWith('legacyRoutes.ts')) continue
    const text = await readFile(resolve(file), 'utf8')
    if (RETIRED_PATHS.some((p) => text.includes(p))) offenders.push(file)
  }
  if (offenders.length) { line('FAIL', 'AJ00 gate 7: retired paths only in the redirect table', offenders.join(', ')); return false }
  line('PASS', 'AJ00 gate 7: retired paths only in the redirect table', 'no source file outside legacyRoutes.ts names them')
  return true
}

// ───────────────────────────── dev access: GraphQL + guarded DynamoDB ─────────────────────────────
const ddb = new DynamoDBClient({ region: REGION })
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })

async function discoverDevSuffix() {
  const suffix = process.env.DEV_TABLE_SUFFIX || STACK.tableSuffix
  if (suffix.includes(PROD_SUFFIX)) throw new Error('refusing the production table suffix')
  await ddb.send(new DescribeTableCommand({ TableName: `Load-${suffix}` })).catch(() => { throw new Error(`no Load-${suffix} table in the account`) })
  return suffix
}
function devTable(model, suffix) {
  const name = `${model}-${suffix}`
  if (name.includes(PROD_SUFFIX)) throw new Error(`refusing non-dev table ${name}`)
  return name
}

const getRow = async (token, model, id, selection = 'id') => (await gql(token, `query($id: ID!) { get${model}(id: $id) { ${selection} } }`, { id }))[`get${model}`]
/** TruckConfig is keyed by truckId, not id. */
const getTruckConfig = async (token, truckId, selection = 'truckId') => (await gql(token, `query($truckId: String!) { getTruckConfig(truckId: $truckId) { ${selection} } }`, { truckId })).getTruckConfig
async function listAll(token, model, filter, selection) {
  const rows = []
  let next = null
  do {
    const r = await gql(token, `query($f: Model${model}FilterInput, $n: String) { list${model}s(filter: $f, limit: 1000, nextToken: $n) { items { ${selection} } nextToken } }`, { f: filter ?? null, n: next })
    rows.push(...r[`list${model}s`].items)
    next = r[`list${model}s`].nextToken
  } while (next)
  return rows
}

/** Ids this run created: the only ones the guarded SDK writers will touch. */
function makeOwned() {
  const ids = new Set()
  return { add: (id) => { ids.add(String(id)); return String(id) }, has: (id) => ids.has(String(id)), assert: (model, id) => { if (!ids.has(String(id))) throw new Error(`refusing SDK write to ${model} ${id}: this run did not create it`) } }
}
async function sdkPut(ctx, model, item) {
  ctx.owned.assert(model, item.id)
  await doc.send(new PutCommand({ TableName: devTable(model, ctx.suffix), Item: { __typename: model, ...item } }))
}
async function sdkUpdate(ctx, model, id, set) {
  ctx.owned.assert(model, id)
  const keys = Object.keys(set)
  await doc.send(new UpdateCommand({
    TableName: devTable(model, ctx.suffix), Key: { id },
    UpdateExpression: `SET ${keys.map((k) => `#${k} = :${k}`).join(', ')}, #updatedAt = :updatedAt`,
    ExpressionAttributeNames: { ...Object.fromEntries(keys.map((k) => [`#${k}`, k])), '#updatedAt': 'updatedAt' },
    ExpressionAttributeValues: { ...Object.fromEntries(Object.entries(set).map(([k, v]) => [`:${k}`, v])), ':updatedAt': nowIso() },
  }))
}

const AUTOMATION = { checkCallsAuto: true, podAuto: true, quietHours: { enabled: false }, templates: { checkCallSms: 'ZZ AJ {proNumber} ETA? {trackingUrl}', podSms: 'ZZ AJ POD {proNumber}' } }
const STOPS = (day) => [
  { type: 'pickup', name: 'ZZ AJ Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${day}T13:00:00.000Z` },
  { type: 'delivery', name: 'ZZ AJ Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${day}T21:00:00.000Z` },
]

async function createCustomer(ctx, key, extra = {}) {
  const name = `ZZ AJ Customer ${key} ${ctx.ts}`
  const result = await ctx.dir('UPSERT_CUSTOMER', {
    name, creditLimitCents: 100_000_000,
    contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ AJ Contact', email: `zz-aj-${key.toLowerCase()}-${ctx.ts}@example.invalid`, types: [] }],
    billToParties: [{ id: `zz-aj-bt-${key}-${ctx.ts}`, name: 'ZZ AJ Bill To', isDefault: false }],
    ...extra,
  })
  const id = String((result.customer ?? result).id)
  ctx.owned.add(id)
  ctx.customerIds.add(id)
  return { id, name }
}

async function createShipment(ctx, customerId) {
  const bundle = await ctx.ship('CREATE_SHIPMENT', { customerId, load: { stops: STOPS(today()) } })
  ctx.shipmentIds.add(bundle.shipment.id)
  ctx.owned.add(bundle.shipment.id)
  for (const load of bundle.loads ?? []) ctx.owned.add(load.id)
  return bundle
}

/** A brokered ZZ leg: kind CARRIER, ACTIVE, rate con SENT (what the automatic sweep acts on). */
async function attachSentLeg(ctx, bundle, label) {
  const load = bundle.loads[0]
  const id = ctx.owned.add(`lc-zzaj-${ctx.ts}-${label}`)
  const at = nowIso()
  await sdkPut(ctx, 'LoadCarrier', {
    id, loadId: load.id, shipmentId: bundle.shipment.id, kind: 'CARRIER', status: 'ACTIVE', sequence: 1,
    carrierName: 'ZZ AJ Carrier', dispatcherName: 'ZZ AJ Dispatcher', dispatcherEmail: 'zz-aj@example.invalid',
    driverName: 'ZZ AJ Driver', driverPhone: '+13125550199',
    // createdBy/updatedBy are required() in the schema: a row without them nulls the whole listLoadCarriers page.
    rateConStatus: 'SENT', rateConSentAt: at, createdBy: 'zz-aj', updatedBy: 'zz-aj', createdAt: at, updatedAt: at,
  })
  ctx.legIds.add(id)
  return id
}

/** Drive the load to IN_TRANSIT through the app's own SET_LOAD_STATUS; fall back to a guarded SDK write when a hop is refused. */
async function driveInTransit(ctx, bundle) {
  const loadId = bundle.loads[0].id
  for (const status of ['DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT']) {
    const load = await getRow(ctx.token, 'Load', loadId, 'id status updatedAt')
    await ctx.ship('SET_LOAD_STATUS', { loadId, status, expectedUpdatedAt: String(load.updatedAt) }).catch(() => {})
  }
  const load = await getRow(ctx.token, 'Load', loadId, 'status')
  if (load.status !== 'IN_TRANSIT') await sdkUpdate(ctx, 'Load', loadId, { status: 'IN_TRANSIT' })
  const shipment = await getRow(ctx.token, 'Shipment', bundle.shipment.id, 'status')
  if (shipment.status === 'DRAFT') await sdkUpdate(ctx, 'Shipment', bundle.shipment.id, { status: 'IN_TRANSIT' })
}

const messagesOf = async (ctx, shipmentId) => (await ctx.trk('LIST_SHIPMENT_THREAD', { shipmentId })).messages ?? []
const outRows = (messages, kind) => messages.filter((m) => m.direction === 'OUT' && (!kind || m.kind === kind))
const freshRows = (after, before) => after.filter((m) => !before.some((b) => b.id === m.id))
const customerUpdatedAt = async (ctx, id) => String((await getRow(ctx.token, 'Customer', id, 'updatedAt')).updatedAt)
const setCustomer = async (ctx, customer, patch) => ctx.dir('UPSERT_CUSTOMER', { id: customer.id, name: customer.name, expectedUpdatedAt: await customerUpdatedAt(ctx, customer.id), ...patch })
const gqlWrite = (ctx, query, input) => gql(ctx.token, query, { input })

async function refused(name, pattern, run) {
  try { await run() } catch (err) {
    if (pattern.test(String(err?.message ?? err))) return String(err.message).slice(0, 120)
    throw new Error(`${name} refused for the wrong reason: ${String(err?.message ?? err).slice(0, 160)}`)
  }
  throw new Error(`${name} was not refused`)
}

async function buildFixtures(ctx) {
  const F = ctx.f
  F.custM = await createCustomer(ctx, 'M', { trackingMode: 'MANUAL', trackingMethod: 'SMS', trackingAutomation: AUTOMATION })
  F.custA = await createCustomer(ctx, 'A', { trackingMode: 'AGENT', trackingAutomation: AUTOMATION })
  F.sM = await createShipment(ctx, F.custM.id)   // AJ03: manual customer, brokered sent leg
  F.sA = await createShipment(ctx, F.custA.id)   // AJ04: agent customer, method flips
  F.sOv = await createShipment(ctx, F.custA.id)  // AJ02: per-shipment override
  F.sO = await createShipment(ctx, F.custA.id)   // AJ05/06/09: own-fleet leg with the ZZ driver and truck
  await attachSentLeg(ctx, F.sM, 'm')
  await attachSentLeg(ctx, F.sA, 'a')
  await driveInTransit(ctx, F.sM)
  await driveInTransit(ctx, F.sA)
  for (const key of ['sM', 'sA', 'sO']) await ctx.trk('OPEN_SHIPMENT_THREAD', { shipmentId: F[key].shipment.id })

  // The ZZ driver, two ZZ trucks (A has a work phone, B has none) and their TruckConfig rows.
  const n = String(ctx.ts).slice(-6)
  ctx.truckUnit = `ZZAJ${n}`
  ctx.truckBUnit = `ZZAJB${n}`
  const driver = await gqlWrite(ctx, 'mutation($input: CreateDriverInput!) { createDriver(input: $input) { id } }', {
    name: `ZZ AJ Driver ${n}`, phone: PERSONAL_PHONE, active: true, type: 'driver', fleetGroup: 'LOCAL',
  })
  ctx.driverId = driver.createDriver.id
  for (const [key, unit] of [['truckId', ctx.truckUnit], ['truckBId', ctx.truckBUnit]]) {
    const r = await gqlWrite(ctx, 'mutation($input: CreateEquipmentInput!) { createEquipment(input: $input) { id } }', { type: 'truck', unitNumber: unit, active: true, ownership: 'owned' })
    ctx[key] = r.createEquipment.id
  }
  await gqlWrite(ctx, 'mutation($input: CreateTruckConfigInput!) { createTruckConfig(input: $input) { truckId } }', {
    truckId: ctx.truckId, unitNumber: ctx.truckUnit, phone: WORK_PHONE, phoneLabel: 'ZZ AJ cab phone',
  })
  console.log(`fixtures: 2 customers, 4 shipments, driver ${ctx.driverId}, trucks ${ctx.truckId} (work phone ${mask(WORK_PHONE)}) and ${ctx.truckBId} (none)`)
}

const setTruckPhone = (ctx, phone) => gqlWrite(ctx, 'mutation($input: UpdateTruckConfigInput!) { updateTruckConfig(input: $input) { truckId } }', {
  truckId: ctx.truckId, phone, phoneLabel: phone ? 'ZZ AJ cab phone' : null,
})
const trackingPrefsOf = async (ctx, shipmentId) => asJson((await getRow(ctx.token, 'Shipment', shipmentId, 'trackingPrefs')).trackingPrefs)

// ───────────────────────────── browser helpers ─────────────────────────────
const pathOf = (b) => b.evaluate('location.pathname')
const searchOf = (b) => b.evaluate('location.search')
const has = (b, selector) => b.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
const waitShell = (b) => b.poll(() => has(b, '.tms-sidebar'), 'shell sidebar mounted', 45_000)

const SIDEBAR_JS = `(() => {
  const nav = document.querySelector('nav[aria-label="TMS sections"]') ?? document.querySelector('.tms-sidebar');
  if (!nav) return [];
  const rows = [];
  const text = (el) => (el?.textContent ?? '').trim();
  for (const el of nav.querySelectorAll('.tms-nav-rowwrap')) {
    const row = el.querySelector(':scope > .tms-nav-row');
    const caret = el.querySelector(':scope > .tms-nav-caret');
    if (row) rows.push({ depth: 0, label: text(row.querySelector('.tms-nav-label')), href: row.getAttribute('href'), badge: text(row.querySelector('.tms-nav-badge')), caret: !!caret });
    for (const child of el.querySelectorAll('.tms-nav-child')) rows.push({ depth: 1, label: text(child.querySelector('.tms-nav-child-label')), href: child.getAttribute('href'), caret: false });
  }
  return rows;
})()`

async function shotFile(b, name) {
  const file = join(SHOTS, `${name}.png`)
  await b.screenshot(file)
  written.push(file)
}

async function clickSel(b, selector) {
  const hit = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'no-element'; if (el.disabled) return 'disabled'; el.scrollIntoView({ block: 'center' }); el.click(); return 'ok' })()`)
  if (hit !== 'ok') throw new Error(`click ${selector}: ${hit}`)
}

async function setValue(b, selector, value) {
  const hit = await b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no-element';
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`set ${selector}: ${hit}`)
}

/** Click the first button whose text matches `pattern` (a RegExp source) inside `scope`. */
async function clickText(b, scope, pattern) {
  const hit = await b.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)}) ?? document.body;
    const el = [...root.querySelectorAll('button, [role="tab"]')].find((x) => new RegExp(${JSON.stringify(pattern)}, 'i').test(x.textContent.trim()));
    if (!el) return 'no-element';
    el.click();
    return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`click /${pattern}/ in ${scope}: ${hit}`)
}

async function openInIdentity(ctx, storage, prefix, fn, viewport = { width: 1440, height: 900, deviceScaleFactor: 1 }) {
  const b = await launchBrowser({ origin: ctx.origin, storage, profilePrefix: prefix, purpose: 'AJ verification', viewport })
  try { return await fn(b) } finally { await b.close() }
}

const themes = (b) => (flag('no-dark') ? ['light'] : ['light', 'dark']).map((theme) => ({ theme, tag: theme === 'dark' ? 'D' : 'L', apply: () => walk.setTheme(b, theme).catch(() => {}) }))

/** The drawer for `shipmentId` on the grid (deep link). */
async function openDrawer(b, shipmentId) {
  await b.navigate(`/tms/tracking?assignee=all&shipment=${encodeURIComponent(shipmentId)}`)
  await b.poll(() => has(b, tid('shipment-tracking-view')), 'tracking drawer body', 60_000)
  await b.poll(() => b.evaluate(`document.querySelector('[data-testid="shipment-tracking-view"]')?.dataset.shipmentId === ${JSON.stringify(shipmentId)}`), 'drawer shows the shipment', 30_000)
  await pause(600)
}

// ───────────────────────────── steps ─────────────────────────────
const RUNNERS = {
  async AJ01(ctx) {
    const { custM } = ctx.f
    const read = async () => getRow(ctx.token, 'Customer', custM.id, 'trackingMode trackingMethod driverSmsTarget')
    let row = await read()
    expect(row.trackingMode === 'MANUAL' && row.trackingMethod === 'SMS', `persisted ${row.trackingMode}/${row.trackingMethod}, expected MANUAL/SMS`)
    // A save of only the name (profile edit of another field) must keep the stored preferences.
    await setCustomer(ctx, custM, {})
    row = await read()
    expect(row.trackingMode === 'MANUAL' && row.trackingMethod === 'SMS', `an UPSERT_CUSTOMER without the keys wiped them: ${row.trackingMode}/${row.trackingMethod}`)
    await refused('a bad trackingMode', /trackingMode/i, () => setCustomer(ctx, custM, { trackingMode: 'ROBOT' }))
    return 'MANUAL / SMS persisted; a name-only save kept both; a bad enum refused'
  },

  async AJ02(ctx) {
    const { sOv, custA } = ctx.f
    const id = sOv.shipment.id
    expect((await trackingPrefsOf(ctx, id)) == null, 'a fresh shipment already carries trackingPrefs')
    await ctx.ship('SET_TRACKING_PREFS', { shipmentId: id, prefs: { mode: 'AGENT' } })
    const stored = await trackingPrefsOf(ctx, id)
    expect(stored?.mode === 'AGENT' && Object.keys(stored).length === 1, `trackingPrefs ${JSON.stringify(stored)}, expected {"mode":"AGENT"}`)
    const customer = await getRow(ctx.token, 'Customer', custA.id, 'trackingMode')
    expect(customer.trackingMode === 'AGENT', 'setting the shipment override changed the customer')
    await refused('an unknown preference value', /driverSms|enum|invalid|one of/i, () => ctx.ship('SET_TRACKING_PREFS', { shipmentId: id, prefs: { driverSms: 'EVERYONE' } }))
    await ctx.ship('SET_TRACKING_PREFS', { shipmentId: id, prefs: null })
    expect((await trackingPrefsOf(ctx, id)) == null, 'prefs: null did not clear the override')
    return 'override {mode:AGENT} stored alone, customer untouched, bad value refused, null clears'
  },

  async AJ03(ctx) {
    const { sM, custM } = ctx.f
    const id = sM.shipment.id
    const before = await messagesOf(ctx, id)
    const run = () => ctx.trk('RUN_TRACKING_AUTOMATION', { mode: 'AUTO', shipmentIds: [id] })
    const blocked = await run()
    const after = await messagesOf(ctx, id)
    expect(after.length === before.length, `${after.length - before.length} thread rows written for a MANUAL customer`)
    expect(/customer tracking is manual|tracking mode not confirmed/i.test(JSON.stringify(blocked)), `the sweep did not say why: ${JSON.stringify(blocked).slice(0, 400)}`)
    await setCustomer(ctx, custM, { trackingMode: 'AGENT' })
    await ctx.ship('SET_TRACKING_PREFS', { shipmentId: id, prefs: { confirmed: true } })   // feedback 9: a new load's mode must be confirmed before automation runs
    await run()
    const fresh = freshRows(outRows(await messagesOf(ctx, id), 'CHECK_CALL'), outRows(before, 'CHECK_CALL'))
    expect(fresh.length >= 1, 'flipping the customer to AGENT produced no check-call row from the sweep')
    await setCustomer(ctx, custM, { trackingMode: 'MANUAL' })
    return `MANUAL: 0 rows and "Customer tracking is manual"; AGENT: ${fresh.length} row(s)`
  },

  async AJ04(ctx) {
    const { sA, custA } = ctx.f
    const id = sA.shipment.id
    const run = async (method) => {
      await setCustomer(ctx, custA, { trackingMethod: method })
      const before = await messagesOf(ctx, id)
      await ctx.trk('RUN_CHECK_CALL_PLAN', { shipmentId: id })
      return freshRows(outRows(await messagesOf(ctx, id)), outRows(before))
    }
    const email = await run('EMAIL')
    expect(email.length >= 1 && email.every((m) => m.channel === 'EMAIL'), `method EMAIL wrote ${email.map((m) => m.channel).join(', ') || 'no rows'}`)
    const sms = await run('SMS')
    expect(sms.length >= 1 && sms.every((m) => m.channel === 'SMS'), `method SMS wrote ${sms.map((m) => m.channel).join(', ') || 'no rows'}`)
    await setCustomer(ctx, custA, { trackingMethod: 'BOTH' })
    return `EMAIL → ${email.length} EMAIL row(s) only; SMS → ${sms.length} SMS row(s) only (a person's manual run, same filter)`
  },

  async AJ05(ctx) {
    const { sO } = ctx.f
    const shipmentId = sO.shipment.id
    const loadId = sO.loads[0].id
    await ctx.ship('ASSIGN_ASSET', { loadId, driverId: ctx.driverId, truckId: ctx.truckId, truckNumber: ctx.truckUnit })
    const bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId })
    const leg = (bundle.loadCarriers ?? []).find((c) => c.kind === 'OWN_ASSET' && c.status === 'ACTIVE')
    expect(leg, 'ASSIGN_ASSET produced no active own-fleet leg')
    ctx.legOwnId = leg.id
    const send = async (label) => {
      const before = await messagesOf(ctx, shipmentId)
      await ctx.trk('SEND_SHIPMENT_MESSAGE', { shipmentId, channel: 'SMS', party: 'DRIVER', loadCarrierId: leg.id, body: `ZZ AJ routing ${label}` })
      const row = freshRows(outRows(await messagesOf(ctx, shipmentId)), outRows(before)).find((m) => m.channel === 'SMS')
      expect(row, `${label}: no SMS row was written`)
      return row
    }
    const work = await send('work')
    expect(work.to === WORK_PHONE, `truck with a phone: SMS to ${mask(work.to)}, expected the truck phone ${mask(WORK_PHONE)}`)
    await setTruckPhone(ctx, null)
    const fallback = await send('fallback')
    expect(fallback.to === PERSONAL_PHONE, `truck without a phone: SMS to ${mask(fallback.to)}, expected the personal number ${mask(PERSONAL_PHONE)}`)
    await setTruckPhone(ctx, WORK_PHONE)
    await ctx.ship('SET_TRACKING_PREFS', { shipmentId, prefs: { driverSms: 'PERSONAL' } })
    const personal = await send('personal')
    expect(personal.to === PERSONAL_PHONE, `driverSms PERSONAL: SMS to ${mask(personal.to)} although the truck has a phone`)
    await ctx.ship('SET_TRACKING_PREFS', { shipmentId, prefs: { driverSms: 'WORK_ONLY' } })
    await setTruckPhone(ctx, null)
    const text = await ctx.trk('TEXT_DRIVER', { loadCarrierId: leg.id, body: 'ZZ AJ work only' })
    expect(typeof text.smsError === 'string' && text.smsError.includes(ctx.truckUnit), `WORK_ONLY + no truck phone: smsError ${JSON.stringify(text.smsError)} does not name truck ${ctx.truckUnit}`)
    await refused('WORK_ONLY composer send', /work phone/i, () => ctx.trk('SEND_SHIPMENT_MESSAGE', { shipmentId, channel: 'SMS', party: 'DRIVER', loadCarrierId: leg.id, body: 'ZZ AJ refused' }))
    await ctx.ship('SET_TRACKING_PREFS', { shipmentId, prefs: null })
    await setTruckPhone(ctx, WORK_PHONE)
    return `truck phone ${mask(WORK_PHONE)} first; personal ${mask(PERSONAL_PHONE)} when the truck has none or driverSms=PERSONAL; WORK_ONLY refuses naming truck ${ctx.truckUnit}; nothing was sent (NOT_SENT rows)`
  },

  async AJ06(ctx) {
    const { sO } = ctx.f
    const shipmentId = sO.shipment.id
    const loadId = sO.loads[0].id
    if (!ctx.suffix) throw new SkipError('no DynamoDB access to arm checkCallAwaitingSince')
    await sdkUpdate(ctx, 'Load', loadId, { checkCallAwaitingSince: nowIso() })
    const messageId = `sms:zz-aj-${ctx.ts}`
    const envelope = { shipmentId, loadId, channel: 'SMS', party: 'DRIVER', from: PERSONAL_PHONE, to: '+13125550100', body: 'ZZ AJ reply', messageId }
    const before = (await messagesOf(ctx, shipmentId)).length
    const first = await ctx.trk('INGEST_SHIPMENT_MESSAGE', envelope)
    expect(first.routed === true, `the reply was not routed: ${first.reason ?? JSON.stringify(first).slice(0, 120)}`)
    const rows = await messagesOf(ctx, shipmentId)
    const stored = rows.find((m) => m.messageId === messageId)
    expect(stored && stored.direction === 'IN' && stored.channel === 'SMS' && stored.status === 'RECEIVED', `stored row ${JSON.stringify(stored && { d: stored.direction, c: stored.channel, s: stored.status })}`)
    const load = await getRow(ctx.token, 'Load', loadId, 'checkCallAwaitingSince')
    expect(load.checkCallAwaitingSince == null, 'the reply did not clear checkCallAwaitingSince')
    const again = await ctx.trk('INGEST_SHIPMENT_MESSAGE', envelope)
    expect(again.duplicate === true && (await messagesOf(ctx, shipmentId)).length === before + 1, 'a repeat with the same messageId added a row')
    return 'one RECEIVED SMS row, awaiting-reply cleared, Twilio-retry style repeat adds nothing (the webhook-side match and bridge are Lambda unit tests)'
  },

  async AJ07(ctx) {
    // Every role: the page-tms grant first, then the admin, each with its own session.
    const adminNote = await openInIdentity(ctx, ctx.ids.admin.storage, 'bcat-aj-nav-admin-', async (b) => {
      await b.navigate('/tms/dashboard'); await waitShell(b); await waitLoaded(b).catch(() => {})
      const rows = await b.evaluate(SIDEBAR_JS)
      expect(rows.filter((r) => r.label === 'Load Tracking').length === 0, 'admin: Load Tracking is still a sidebar row (it is the Track lifecycle tab)')
      expect(rows.filter((r) => /tracking|check-calls|documents/.test(String(r.href))).length === 0, 'admin: a tracking, check-calls or documents link is in the rail')
      const tab = await b.evaluate(`[...document.querySelectorAll('[data-testid="lifecycle-tab-track"]')].map((a) => a.getAttribute('href'))`)
      expect(tab.length === 1 && tab[0] === '/tms/tracking', `admin: the Track lifecycle tab count ${tab.length}, href ${JSON.stringify(tab)}`)
      await b.navigate('/tms/tracking?assignee=all'); await waitLoaded(b)
      await b.poll(() => has(b, tid('tracking-focus-tabs')), 'admin Focus control', 45_000)
      const lit = await b.evaluate(`document.querySelector('[data-testid="lifecycle-tab-track"]')?.classList.contains('tms-active') ?? false`)
      expect(lit, 'admin: the Track tab is not lit on /tms/tracking')
      const collapsed = await b.evaluate(SIDEBAR_JS)
      expect(collapsed.filter((r) => r.label === 'Load Tracking' || /\/tms\/tracking/.test(String(r.href))).length === 0, 'admin: the rail lists a tracking row')
      return 'admin: Track tab, no row'
    })
    return openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-aj-nav-', async (b) => {
      const note = [adminNote]
      for (const t of themes(b)) {
        await b.navigate('/tms/dashboard'); await waitShell(b); await waitLoaded(b).catch(() => {})
        await t.apply()
        const rows = await b.evaluate(SIDEBAR_JS)
        expect(rows.filter((r) => r.label === 'Load Tracking' || /^\/(tms\/)?(tracking|check-calls|documents)/.test(String(r.href))).length === 0, 'the sidebar still has a Load Tracking row or a tracking, check-calls or documents link')
        const track = await b.evaluate(`[...document.querySelectorAll('[data-testid="lifecycle-tab-track"]')].map((a) => a.getAttribute('href'))`)
        expect(track.length === 1 && track[0] === '/tms/tracking', `the Track lifecycle tab count ${track.length}, href ${JSON.stringify(track)}`)
        expect(!(await has(b, '.tms-nav-live')), 'the live-loads list is still rendered')
        expect(!(await has(b, '.tms-nav-rowwrap > .tms-nav-caret[aria-controls*="tracking"]')), 'a caret controls Load Tracking')
        await shotFile(b, `AJ01-nav-collapsed-${t.tag}`)
        note.push(t.theme)
      }
      const olds = [
        ['/tms/check-calls', CHECK_CALLS_LANDING], ['/check-calls', CHECK_CALLS_LANDING],
        ['/tms/documents/review', DOCS_LANDING], ['/documents', DOCS_LANDING], ['/tms/documents/view/zz-x', DOCS_LANDING],
      ]
      for (const [old, landing] of olds) {
        const want = new URL(landing, 'http://x')
        await b.navigate(old)
        await b.poll(async () => (await pathOf(b)) === want.pathname && (await searchOf(b)) === want.search, `${old} → ${landing}`, 30_000)
          .catch(async () => { throw new Error(`${old} landed on ${await pathOf(b)}${await searchOf(b)}, expected ${landing}`) })
        await b.poll(() => has(b, tid('tracking-focus-tabs')), `${old}: the grid rendered`, 45_000)
      }
      await b.navigate('/tms/tracking/links')
      await b.poll(() => has(b, tid('customer-links-page')), '/tms/tracking/links page', 45_000)
      return `Load Tracking is the Track lifecycle tab (not a sidebar row; no caret, no live list) (${note.join(' + ')}); ${olds.length} old URLs land on the grid focus views; /tms/tracking/links still renders`
    })
  },

  async AJ08(ctx) {
    const { sO } = ctx.f
    const id = sO.shipment.id
    return openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-aj-grid-', async (b) => {
      await b.navigate('/tms/tracking?assignee=all'); await waitLoaded(b)
      await b.poll(() => has(b, tid('tracking-focus-tabs')), 'Focus control', 45_000)
      await shotFile(b, 'AJ02-grid-default-L')
      const chips = await b.evaluate(`[...document.querySelectorAll('[data-testid="tracking-focus-tabs"] button, [data-testid="tracking-focus-tabs"] [role="tab"]')].map((x) => x.textContent.trim())`)
      expect(chips.length >= 4, `Focus control shows ${chips.length} options: ${chips.join(' | ')}`)
      const countOf = (re) => Number(chips.find((c) => re.test(c))?.match(/(\d+)$/)?.[1] ?? NaN)
      for (const [slug, re, landing] of [['checkcalls', /check calls/i, 'AJ03-grid-focus-checkcalls-L'], ['docs', /docs to review/i, 'AJ04-grid-focus-docs-L']]) {
        const n = countOf(re)
        expect(Number.isFinite(n), `the ${slug} chip carries no count: ${chips.join(' | ')}`)
        await clickText(b, tid('tracking-focus-tabs'), re.source)
        await b.poll(async () => (await searchOf(b)).includes(`focus=${slug}`), `?focus=${slug}`, 15_000)
        await pause(500)
        const shown = await b.evaluate(`document.querySelectorAll('[data-testid="tracking-row"]').length`)
        expect(shown === n, `${slug} chip says ${n}, the grid lists ${shown}`)
        await shotFile(b, landing)
      }
      await b.navigate('/tms/tracking?assignee=all'); await waitLoaded(b)
      const rowSel = `[data-testid="tracking-row"][data-shipment-id="${id}"]`
      // An own-fleet leg has no TMS rate con, and the desk lists rate-con-sent loads only (by design)
      // until "Include loads without a TMS rate con" is on.
      await b.poll(() => b.evaluate(`(() => { const t = [...document.querySelectorAll('button')].find((x) => /Include loads without a TMS rate con/.test(x.textContent)); if (!t) return false; if (t.getAttribute('aria-pressed') !== 'true') t.click(); return true })()`), 'the include-unsent toggle', 30_000)
      // The grid is virtualised and grouped by tracker: with a busy dev set the fixture row is not mounted
      // until it is searched for. Search its number so exactly that row is rendered.
      const number = sO.shipment.number
      await b.poll(() => b.evaluate(`(() => { const i = document.querySelector('input[aria-label="Search shipments"]'); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(String(number))}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`), 'the grid search box', 30_000)
      await b.poll(() => has(b, rowSel), 'the own-fleet fixture row on the grid', 45_000)
      await b.evaluate(`document.querySelector(${JSON.stringify(rowSel)}).click()`)
      await b.poll(async () => (await searchOf(b)).includes(`shipment=${id}`), 'row click adds ?shipment=', 15_000)
      await b.poll(() => has(b, tid('tracking-drawer')), 'the drawer', 30_000)
      expect((await pathOf(b)) === '/tms/tracking', 'a row click left the grid')
      await b.navigate(`/tms/tracking?assignee=all&shipment=${encodeURIComponent(id)}`)
      await b.poll(() => has(b, tid('tracking-drawer')), 'the drawer survives a reload', 45_000)
      await b.press('Escape')
      await b.poll(async () => !(await searchOf(b)).includes('shipment='), 'Esc closes the drawer', 15_000)
      return `${chips.length} Focus options with counts that match the listed rows; row click → ?shipment= → drawer, reload keeps it, Esc closes`
    })
  },

  async AJ09(ctx) {
    const { sO } = ctx.f
    const id = sO.shipment.id
    const loadId = sO.loads[0].id
    // 40 inbound texts so the SMS stream has to scroll (8 at a time).
    const ids = Array.from({ length: 40 }, (_, i) => `sms:zz-aj-fill-${ctx.ts}-${i}`)
    for (let i = 0; i < ids.length; i += 8) {
      await Promise.all(ids.slice(i, i + 8).map((messageId, j) => ctx.trk('INGEST_SHIPMENT_MESSAGE', {
        shipmentId: id, loadId, channel: 'SMS', party: 'DRIVER', from: PERSONAL_PHONE, to: '+13125550100', body: `ZZ AJ filler ${i + j}`, messageId,
      })))
    }
    return openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-aj-drawer-', async (b) => {
      const note = []
      for (const t of themes(b)) {
        await openDrawer(b, id)
        await t.apply()
        await pause(400)
        const facts = await b.evaluate(`(() => {
          const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { bottom: Math.round(r.bottom), top: Math.round(r.top), w: Math.round(r.width) } };
          const sms = document.querySelector('[data-testid="pane-sms"] [data-testid="convo-stream"]');
          const email = document.querySelector('[data-testid="pane-email"] [data-testid="convo-stream"]');
          const before = email ? email.scrollTop : null;
          if (sms) sms.scrollTop = sms.scrollHeight;
          return {
            h: innerHeight,
            strip: rect('[data-testid="tracking-strip"]'), smsPane: rect('[data-testid="pane-sms"]'), emailPane: rect('[data-testid="pane-email"]'),
            composer: rect('[data-testid="pane-sms"] [data-testid="thread-composer"]'), recent: rect('[data-testid="recent-check-calls"]'),
            smsScrolls: sms ? sms.scrollHeight > sms.clientHeight : null, smsMoved: sms ? sms.scrollTop > 0 : null,
            emailStill: email ? email.scrollTop === before : null,
            wouldHaveSent: /would have sent/i.test(document.querySelector('[data-testid="pane-sms"]')?.innerText ?? ''),
            target: document.querySelector('[data-testid="sms-target"]')?.innerText ?? '',
            head: rect('.tms-tracking-drawer .tms-drawer-head'),
            map: rect('.tms-map-body'),
            clipped: ['strip-driver', 'strip-phones', 'last-known', 'delivery-eta', 'strip-pod'].filter((id) => { const el = document.querySelector('[data-testid="' + id + '"]'); return el && el.scrollWidth > el.clientWidth + 1 }),
            fontPx: Math.round(parseFloat(getComputedStyle(document.querySelector('[data-testid="tracking-strip"]')).fontSize)),
          };
        })()`)
        const bad = []
        for (const key of ['strip', 'smsPane', 'emailPane', 'composer', 'recent']) {
          if (!facts[key]) bad.push(`${key} is missing`)
          else if (facts[key].bottom > facts.h) bad.push(`${key} ends at ${facts[key].bottom}px, below the ${facts.h}px fold`)
        }
        if (facts.head && facts.head.bottom - facts.head.top > 56) bad.push(`the drawer header is ${facts.head.bottom - facts.head.top}px tall (one row expected)`)
        if (facts.map && (facts.map.bottom - facts.map.top < 150 || facts.map.bottom - facts.map.top > 260)) bad.push(`the map body is ${facts.map.bottom - facts.map.top}px (150-260 expected)`)
        if (facts.clipped.length) bad.push(`strip segments are clipped: ${facts.clipped.join(', ')}`)
        if (facts.fontPx < 12 || facts.fontPx > 13) bad.push(`strip font is ${facts.fontPx}px (12-13 expected)`)
        if (facts.smsScrolls !== true) bad.push('the SMS stream does not scroll with 40+ rows')
        if (facts.emailStill === false) bad.push('scrolling the SMS stream moved the e-mail stream')
        if (!facts.wouldHaveSent) bad.push('no "Would have sent" text in the SMS pane')
        if (bad.length) throw new Error(`${t.theme}: ${bad.join('; ')}`)
        if (t.theme === 'light') {
          expect(/work phone/i.test(facts.target) && facts.target.includes('(312) 555-0102'), `SMS target reads ${JSON.stringify(facts.target)}, expected the truck work phone`)
          await shotFile(b, 'AJ07-drawer-notsent-L')
          // Step AO: the prefs control is an always-visible row inside the strip (no button, no popover, no dialog).
          const prefsRow = await b.evaluate(`(() => { const r = document.querySelector('[data-testid="tracking-prefs-row"]'); return r ? { selects: r.querySelectorAll('select').length, dialogs: [...document.querySelectorAll('[role="dialog"]')].filter((d) => !d.querySelector('[data-testid="tracking-drawer"]')).length, inStrip: !!r.closest('[data-testid="tracking-strip"]'), effective: r.querySelector('[data-testid="tracking-prefs-effective"]')?.innerText ?? '' } : null })()`)
          expect(prefsRow != null, 'the inline tracking-prefs row is missing from the drawer')
          expect(prefsRow.selects === 3 && prefsRow.inStrip && prefsRow.dialogs === 0, `prefs row has ${prefsRow.selects} selects, inside strip: ${prefsRow.inStrip}, dialogs open: ${prefsRow.dialogs}`)
          expect(/In force:/.test(prefsRow.effective), `the prefs row read-out says ${JSON.stringify(prefsRow.effective)}`)
          await shotFile(b, 'AJ08-drawer-prefs-row-L')
        }
        await shotFile(b, `AJ06-drawer-${t.tag}`)
        note.push(t.theme)
      }
      return `summary strip, both panes, composer and recent check calls end above ${900}px (${note.join(' + ')}); SMS stream scrolls alone; "Would have sent" visible; SMS target = truck work phone`
    })
  },

  async AJ10(ctx) {
    const name = `ZZ AJ UI Customer ${ctx.ts}`
    return openInIdentity(ctx, ctx.ids.admin.storage, 'bcat-aj-cust-', async (b) => {
      await b.navigate('/tms/customers'); await waitLoaded(b)
      await b.click({ pattern: '^(\\+\\s*)?(Add |New )?Customer$' })
      await b.poll(() => b.evaluate(`/Tracking mode/.test(document.body.innerText)`), 'the Tracking group on the create dialog', 20_000)
      const checked = await b.evaluate(`[...document.querySelectorAll('input[type="radio"]:checked')].map((r) => r.closest('label')?.innerText.trim() ?? '')`)
      expect(checked.some((c) => /agent/i.test(c)) && checked.some((c) => /both/i.test(c)), `create dialog preselects ${JSON.stringify(checked)}, expected the AI agent and Both choices`)
      await shotFile(b, 'AJ09-customer-create-tracking-L')
      const nameField = await b.evaluate(`(() => { const el = [...document.querySelectorAll('[role="dialog"] input')].find((i) => /name/i.test(i.getAttribute('aria-label') ?? '') || /name/i.test(i.closest('label, [class*="field"]')?.innerText ?? '')); return el ? (el.setAttribute('data-aj-name', '1'), true) : false })()`)
      expect(nameField, 'could not find the customer name field')
      await setValue(b, '[data-aj-name="1"]', name)
      await b.click({ pattern: '^(Create|Save)( customer)?$' })
      let saved = []
      await b.poll(async () => (saved = await listAll(ctx.token, 'Customer', { name: { eq: name } }, 'id name trackingMode trackingMethod driverSmsTarget')).length > 0, 'the saved customer', 30_000)
      ctx.customerIds.add(saved[0].id)
      expect(saved[0].trackingMode === 'AGENT' && saved[0].trackingMethod === 'BOTH', `saved ${saved[0].trackingMode}/${saved[0].trackingMethod}, expected AGENT/BOTH`)
      return `create dialog shows the Tracking group on its first tab, AGENT/BOTH preselected and stored (customer ${saved[0].id})`
    })
  },

  async AJ11(ctx) {
    return openInIdentity(ctx, ctx.ids.admin.storage, 'bcat-aj-trucks-', async (b) => {
      /** The "(n)" in a heading, or 0 when the page says every truck has a phone. */
      const countOn = async (path, re, allClear) => {
        await b.navigate(path); await waitLoaded(b)
        await b.poll(() => b.evaluate(`${re}.test(document.body.innerText) || ${allClear}.test(document.body.innerText)`), `${path} shows ${re}`, 45_000)
        return Number(await b.evaluate(`(document.body.innerText.match(${re}) ?? [])[1] ?? 0`))
      }
      const fleet = await countOn('/trucks', '/No phone \\((\\d+)\\)/', '/^$/')
      await shotFile(b, 'AK01-fleet-phone-column-L')
      const cardRe = '/Trucks without a phone \\((\\d+)\\)/'
      const card = await countOn('/tms/brokerage', cardRe, '/All trucks have a work phone/')
      await shotFile(b, 'AK03-settings-truck-phones-report-L')
      expect(fleet === card, `Fleet says ${fleet} trucks without a phone, the Settings card ${card}`)
      expect(await b.evaluate(`document.body.innerText.includes(${JSON.stringify(ctx.truckBUnit)})`), `the ZZ truck ${ctx.truckBUnit} (no phone) is not listed on the card`)
      // Give the ZZ truck a phone (through the same record the editor writes), then the card must lose it.
      await gqlWrite(ctx, 'mutation($input: CreateTruckConfigInput!) { createTruckConfig(input: $input) { truckId } }', { truckId: ctx.truckBId, unitNumber: ctx.truckBUnit, phone: '+13125550103', phoneLabel: 'ZZ AJ B' })
      const after = await countOn('/tms/brokerage', cardRe, '/All trucks have a work phone/')
      expect(after === card - 1, `after giving ${ctx.truckBUnit} a phone the card says ${after}, expected ${card - 1}`)
      expect(!(await b.evaluate(`document.body.innerText.includes(${JSON.stringify(ctx.truckBUnit)})`)), `${ctx.truckBUnit} is still listed after getting a phone`)
      return `Fleet "No phone (${fleet})" equals the Settings card (${card}); giving a ZZ truck a phone removes its row (${after} left)`
    })
  },

  async AJ12(ctx) {
    const drivers = await listAll(ctx.token, 'Driver', { name: { eq: 'John Brittich' } }, 'id name assignedTruckId')
    if (drivers.length !== 1) throw new SkipError(`${drivers.length} drivers named John Brittich on dev (allowed: exactly one is needed)`)
    const truckId = drivers[0].assignedTruckId
    if (!truckId) throw new SkipError('John Brittich has no assigned truck yet (allowed: not seeded yet)')
    const config = await getTruckConfig(ctx.token, truckId, 'truckId unitNumber phone phoneLabel').catch(() => null)
    if (!config?.phone) throw new SkipError('his truck has no work phone yet (allowed: not seeded yet — run scripts/seedTruckPhone.mjs --apply)')
    expect(/^\+1\d{10}$/.test(config.phone), `his truck phone ${mask(config.phone)} is not a valid US E.164 number`)
    if (expectLast4) expect(last4(config.phone) === expectLast4, `his truck phone ends ${last4(config.phone)}, expected ${expectLast4}`)
    return `driver ${drivers[0].id} → truck ${config.unitNumber} (${truckId}) has work phone ${mask(config.phone)}${expectLast4 ? ' (last four match)' : ''}; nothing sent`
  },

  async AJ13() {
    throw new SkipError('the driver app signs in through the driver pool, which this harness never touches; header line and tel link are covered by DispatchBar.test.tsx, and the 10-minute phone pass is in the report')
  },
}

// ───────────────────────────── run / cleanup ─────────────────────────────
async function runStep(ctx, step) {
  if (!matches(step.id)) return
  try {
    const detail = await RUNNERS[step.id](ctx)
    line('PASS', `${step.id} ${step.slug}`, typeof detail === 'string' ? detail : undefined)
  } catch (err) {
    if (err instanceof SkipError) { skipLine(`${step.id} ${step.slug}`, '', err.message, 'dev cannot provide this prerequisite'); return }
    line('FAIL', `${step.id} ${step.slug}`, short(err).slice(0, 600))
  }
}

async function cleanup(ctx) {
  const say = (msg, ok = true) => { console.log(`cleanup: ${msg}`); if (!ok) process.exitCode = 1 }
  if (!ctx.token) return
  const ids = new Set(ctx.shipmentIds)
  for (const customerId of ctx.customerIds) {
    for (const r of await listAll(ctx.token, 'Shipment', { customerId: { eq: customerId } }, 'id').catch(() => [])) ids.add(r.id)
  }
  for (const id of ids) {
    try {
      const row = await getRow(ctx.token, 'Shipment', id, 'id updatedAt voidedAt')
      if (!row?.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: id, reason: VOID_REASON, expectedUpdatedAt: String(row?.updatedAt ?? '') })
      const after = await getRow(ctx.token, 'Shipment', id, 'voidedAt')
      say(`shipment ${id} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt)
    } catch (err) { say(`shipment ${id} void failed: ${short(err).slice(0, 100)}`, false) }
  }
  if (ctx.suffix) {
    for (const id of ctx.legIds) {
      await doc.send(new DeleteCommand({ TableName: devTable('LoadCarrier', ctx.suffix), Key: { id } })).catch(() => {})
      const left = (await doc.send(new GetCommand({ TableName: devTable('LoadCarrier', ctx.suffix), Key: { id } })).catch(() => ({ Item: {} }))).Item
      say(`SDK leg ${id} ${left ? 'NOT removed' : 'removed'}`, !left)
    }
  }
  const drop = async (model, idField, id, selection) => {
    if (!id) return
    await gql(ctx.token, `mutation($input: Delete${model}Input!) { delete${model}(input: $input) { ${selection} } }`, { input: { [idField]: id } }).catch(() => {})
    const left = await (model === 'TruckConfig' ? getTruckConfig(ctx.token, id, selection) : getRow(ctx.token, model, id, selection)).catch(() => null)
    say(`${model} ${id} ${left ? 'NOT deleted' : 'deleted and confirmed gone'}`, !left)
  }
  // TruckConfig is keyed by truckId, so its "as found" state for a ZZ truck is: gone.
  await drop('TruckConfig', 'truckId', ctx.truckId, 'truckId')
  await drop('TruckConfig', 'truckId', ctx.truckBId, 'truckId')
  await drop('Equipment', 'id', ctx.truckId, 'id')
  await drop('Equipment', 'id', ctx.truckBId, 'id')
  await drop('Driver', 'id', ctx.driverId, 'id')
  for (const name of [`ZZ AJ UI Customer ${ctx.ts}`]) {
    for (const r of await listAll(ctx.token, 'Customer', { name: { eq: name } }, 'id').catch(() => [])) ctx.customerIds.add(r.id)
  }
  for (const id of ctx.customerIds) {
    const row = await getRow(ctx.token, 'Customer', id, 'id updatedAt').catch(() => null)
    if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`customer ${id} archived`), (err) => say(`customer archive failed: ${short(err).slice(0, 80)}`, false))
  }
}

async function main() {
  if (flag('inventory')) { if (!(await inventory())) process.exitCode = 1; return }
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAJ refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyAJ refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAJ only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)
  if (!(await inventory())) { process.exitCode = 1; return }

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const emails = { admin: `zz-aj-admin-${ts}@example.invalid`, tms: `zz-aj-tms-${ts}@example.invalid` }
  const made = []
  const ctx = { ts, origin, ids: {}, f: {}, owned: makeOwned(), shipmentIds: new Set(), customerIds: new Set(), legIds: new Set(), suffix: null }
  try {
    ctx.suffix = await discoverDevSuffix().catch((err) => { console.log(`dev table suffix: ${short(err).slice(0, 100)} (SDK-backed steps will skip)`); return null })
    ctx.ids.admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    ctx.ids.tms = await mintIdentity(emails.tms, ['page-tms']); made.push(emails.tms)
    console.log('identity: temporary staff identities created (admin, page-tms only)')
    ctx.token = ctx.ids.admin.token
    ctx.dir = routerAs(ctx.token, 'tmsDirectoryActions')
    ctx.ship = routerAs(ctx.token, 'tmsShipmentActions')
    ctx.trk = routerAs(ctx.token, 'tmsTrackingActions')
    if (!ctx.suffix) throw new Error('DynamoDB access is required for the brokered-leg fixtures (set AWS credentials)')
    await buildFixtures(ctx)
    for (const step of AJ_STEPS) await runStep(ctx, step)
  } finally {
    await cleanup(ctx).catch((err) => { console.log(`cleanup: failed (${short(err).slice(0, 120)})`); process.exitCode = 1 })
    for (const email of made.slice().reverse()) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary staff identity ${email.replace(/-\d+@/, '-…@')} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }

  const pass = report.filter((r) => r.status === 'PASS').length
  const failed = report.filter((r) => r.status === 'FAIL').length
  const skipped = report.filter((r) => r.status === 'SKIPPED').length
  console.log(`\nsummary: ${JSON.stringify({ pass, fail: failed, skipped })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAJ failed: ${err?.message ?? err}`); process.exit(1) })
}
