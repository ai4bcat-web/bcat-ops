#!/usr/bin/env node
/**
 * Step AO verification against the DEV site: driver GPS map in the Load Tracking drawer, tap-to-share driver page,
 * shared-pin / text ingest, provider slot (STUB), cached route, customer trail, inline tracking-prefs row (AO-plan §11).
 *
 *   node scripts/devVerifyAO.mjs [--inventory] [--only=<substring>] [--no-dark]
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyAO.mjs
 *   DEV_VERIFY_MAPS=1 node scripts/devVerifyAO.mjs --only=AO14     # someone whose Maps key is valid for the origin
 *
 *   --inventory   no network, no browser: step runners exist, every action the steps call has a handler case, every
 *                 data-testid a step selects exists in source, /track/l and /track/s are registered, the 18 screenshots
 *                 are each produced by a step, the retired popover / detail map are gone and nothing imports them.
 *   --only=       run only the steps whose id contains the substring (fixtures are still created; AO02 pings, the
 *                 provider fixture and the customer links are made on demand by the steps that need them).
 *   --no-dark     skip the dark-theme screenshot.
 *
 * RUNS ONLY AFTER THE DEPLOY. Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool,
 * any origin outside ALLOWED_ORIGINS and any DynamoDB table suffix that is the production one. No SSM, no main /
 * production, no invoice_*.json, no Aljex export. Two throwaway identities (zz-ao-admin-<ts> ADMIN, zz-ao-tms-<ts> with
 * only page-tms) are created and deleted (and proven gone) in `finally`; passwords and tokens are never printed.
 *
 * NO REAL GPS, NO REAL TEXT, NO REAL PROVIDER. Positions come from the dev-only sim doors (TRACKING_SIM_PINGS,
 * TRACKING_SIM_TEXT, TRACKING_SIM_PROVIDER; they refuse outside BCAT_DEV_STACK) and from Chrome's geolocation emulation
 * (Emulation.setGeolocationOverride) on the public /track/l page. Every coordinate is fictional (an I-80 corridor,
 * Joliet IL -> Gary IN -> Toledo OH); Twilio is unset on dev so nothing is texted (links are minted with via COPY).
 *
 * Everything it creates is ZZ AO ...: one customer, five shipments (four brokered legs and one own-asset leg), one truck.
 * In `finally` shipments are VOIDED (PROs are permanent), the customer archived, the SDK legs / truck deleted, the
 * ZZ load-ping rows and the 8 ZZ Motive rows deleted and re-read. Cached `route:` rows carry their own TTL (30 d / 1 d)
 * and are shared by lane, so they are left to expire. Output carries ids, counts and masked tokens, never a driver position.
 *
 * Screenshots: Docs/tms-build/screenshots/ao/<name>.png (drawer 1440x900, driver page 390x844), listed in index.txt.
 */
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DynamoDBClient, DescribeTableCommand, DescribeTimeToLiveCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, PUBLIC_API, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk } from './lib/uiWalk.mjs'
import { AA_HOMES } from './lib/aaRoutes.mjs'
import { ROUTES as S2_ROUTES } from './devVerifyS2.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4'
const SHOTS = resolve('Docs/tms-build/screenshots/ao')
const VOID_REASON = 'AO harness'
const REGION = 'us-east-1'
const MINUTE_MS = 60_000
const DAY_S = 86_400

// Fictional corridor (not any person's position): Joliet IL -> Gary IN -> Toledo OH.
const JOLIET = { lat: 41.525, lng: -88.082 }
const GARY = { lat: 41.593, lng: -87.346 }
const TOLEDO = { lat: 41.653, lng: -83.538 }
const lerp = (a, b, t) => ({ lat: Number((a.lat + (b.lat - a.lat) * t).toFixed(4)), lng: Number((a.lng + (b.lng - a.lng) * t).toFixed(4)) })

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
  { pattern: /Google Maps JavaScript API|gm_authFailure|maps\.googleapis\.com|InvalidKeyMapError|ApiNotActivatedMapError|RefererNotAllowedMapError/i, reason: 'dev Maps key is neutered' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const valueOf = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const only = valueOf('only')

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: {}, only })
const { line, report, written, matches, skipLine, allowedProblem } = walk

/** Every AO id, in run order. AO01-AO09 are API-only (AO03 / AO07 also use the public Lambda); AO10-AO13 drive Chrome; AO14 needs a Maps key. */
export const AO_STEPS = [
  { id: 'AO01', slug: 'schema' },
  { id: 'AO02', slug: 'sim-pings' },
  { id: 'AO03', slug: 'public-ping' },
  { id: 'AO04', slug: 'shared-sms' },
  { id: 'AO05', slug: 'check-call-text' },
  { id: 'AO06', slug: 'own-assets' },
  { id: 'AO07', slug: 'provider' },
  { id: 'AO08', slug: 'route' },
  { id: 'AO09', slug: 'customer-api' },
  { id: 'AO10', slug: 'ui-drawer' },
  { id: 'AO11', slug: 'ui-prefs-row' },
  { id: 'AO12', slug: 'ui-driver-page' },
  { id: 'AO13', slug: 'ui-customer-page' },
  { id: 'AO14', slug: 'google-branch' },
]

/** The 18 screenshots of AO-plan §13. `--inventory` proves every one is produced by a step. */
export const SHOT = {
  drawerExpanded: '01-drawer-map-expanded',
  drawerExpandedDark: '02-drawer-map-expanded-dark',
  drawerCollapsed: '03-drawer-map-collapsed',
  prefsIdle: '04-prefs-row-idle',
  prefsDirty: '05-prefs-row-dirty',
  prefsSaved: '06-prefs-row-saved-no-reflow',
  allSources: '07-map-all-sources',
  approx: '08-map-approx-overlay',
  stale: '09-map-stale',
  noKey: '10-map-no-key-fallback',
  unavailable: '11-map-unavailable',
  providerStub: '12-map-provider-stub',
  trackingTab: '13-tracking-tab-full-page',
  driverConsent: '14-driver-consent',
  driverSharing: '15-driver-sharing',
  driverDone: '16-driver-done',
  customerTrail: '17-customer-trail',
  customerNoPosition: '18-customer-no-position',
}

/** Files the plan creates / changes (AO-plan §12): the inventory fails if one is missing. */
const PLAN_FILES = [
  'src/lib/trackingPings.ts', 'src/lib/locationShare.ts', 'src/lib/polyline.ts', 'src/lib/integrations/trackingProvider.ts',
  'src/hooks/useLoadTracking.ts', 'amplify/functions/_shared/trackingPings.ts',
  'amplify/functions/tms-tracking-actions/route.ts', 'amplify/functions/tms-tracking-actions/shareIngest.ts',
  'amplify/functions/tms-tracking-actions/providers.ts', 'amplify/functions/tracking-api/providerTracking.ts',
  'src/features/shipments/workstations/tracking/TrackingPrefsRow.tsx',
  'src/features/shipments/workstations/tracking/map/TrackingMapPanel.tsx',
  'src/features/shipments/workstations/tracking/map/RouteMapView.tsx',
  'src/features/shipments/workstations/tracking/map/FallbackRouteMap.tsx',
  'src/features/shipments/workstations/tracking/map/TrackingRouteMap.tsx',
  'src/features/shipments/workstations/tracking/map/ProviderMenu.tsx',
  'src/features/shipments/workstations/tracking/map/mapModel.ts',
]
/** Files the plan deletes (clean cutover, D-AO17). */
const GONE_FILES = [
  'src/features/shipments/workstations/tracking/TrackingPrefsPopover.tsx',
  'src/features/shipments/workstations/tracking/TrackingPrefsPopover.test.tsx',
  'src/features/shipments/workstations/tracking/TrackingDetailMap.tsx',
]
const RETIRED_NAMES = ['TrackingPrefsPopover', 'TrackingDetailMap', 'tracking-prefs-button', 'tracking-prefs-panel']

const tid = (id) => `[data-testid="${id}"]`
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const asJson = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return v } })() : v)
const nowIso = () => new Date().toISOString()
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
const maskToken = (token) => `${String(token).slice(0, 4)}…`
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
  const self = await readFile(resolve('scripts/devVerifyAO.mjs'), 'utf8')
  const runners = Object.keys(RUNNERS)
  const registered = AO_STEPS.map((s) => s.id)
  const disagree = registered.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !registered.includes(id)))
  if (disagree.length) { line('FAIL', 'AO00 gate 1: AO ids registered', `registry and runners disagree on: ${disagree.join(', ')}`); return false }
  line('PASS', 'AO00 gate 1: AO ids registered', `${registered.length} steps each have a runner`)

  // gate 2: files exist / are gone, and nothing imports what was deleted
  const missing = []
  for (const f of PLAN_FILES) if (!(await exists(f))) missing.push(f)
  const lingering = []
  for (const f of GONE_FILES) if (await exists(f)) lingering.push(f)
  const offenders = []
  for (const file of await sourceFiles('src')) {
    const text = await readFile(resolve(file), 'utf8')
    if (RETIRED_NAMES.some((n) => text.includes(n))) offenders.push(file)
  }
  if (missing.length || lingering.length || offenders.length) {
    line('FAIL', 'AO00 gate 2: plan files', [missing.length ? `missing: ${missing.join(', ')}` : '', lingering.length ? `still present: ${lingering.join(', ')}` : '', offenders.length ? `still naming a retired component: ${offenders.join(', ')}` : ''].filter(Boolean).join('; '))
    return false
  }
  line('PASS', 'AO00 gate 2: plan files', `${PLAN_FILES.length} created files exist, ${GONE_FILES.length} retired files are gone, no source names ${RETIRED_NAMES.length} retired identifiers`)

  // gate 3: every action the steps call has a handler case (and the three sim doors are in the Action union)
  const cases = {}
  for (const [key, file] of Object.entries(HANDLERS)) {
    const text = await readFile(resolve(file), 'utf8')
    cases[key] = new Set([...text.matchAll(/case '([A-Z_]+)':/g)].map((m) => m[1]))
  }
  const trackingText = await readFile(resolve(HANDLERS.trk), 'utf8')
  const unionMissing = ['GET_LOAD_ROUTE', 'START_PROVIDER_TRACKING', 'STOP_PROVIDER_TRACKING', 'TRACKING_SIM_PINGS', 'TRACKING_SIM_TEXT', 'TRACKING_SIM_PROVIDER']
    .filter((a) => !new RegExp(`\\|\\s*'${a}'`).test(trackingText))
  const absent = []
  let calls = 0
  for (const m of self.matchAll(/\bctx\.(ship|dir|trk)\('([A-Z_]+)'/g)) {
    calls += 1
    if (!cases[m[1]].has(m[2])) absent.push(`${m[2]} (${HANDLERS[m[1]]})`)
  }
  if (absent.length || unionMissing.length) {
    line('FAIL', 'AO00 gate 3: every action the steps call exists', [absent.length ? `no handler case: ${absent.join('; ')}` : '', unionMissing.length ? `not in the Action union: ${unionMissing.join(', ')}` : ''].filter(Boolean).join('; '))
    return false
  }
  line('PASS', 'AO00 gate 3: every action the steps call exists', `${calls} call sites, all with a handler case; the 6 AO actions are in the Action union`)

  // gate 4: every data-testid a step selects exists in the source
  const sources = [
    ...await sourceFiles('src/features/shipments'),
    ...await sourceFiles('src/features/tracking'),
    ...await sourceFiles('src/features/tms'),
  ]
  const haystack = (await Promise.all(sources.map((f) => readFile(resolve(f), 'utf8')))).join('\n')
  const ids = [...new Set([...self.matchAll(/\btid\('([^'$]+)'\)/g), ...self.matchAll(/data-testid="([A-Za-z0-9-]+)"/g)].map((m) => m[1]))]
  const unresolved = ids.filter((id) => !haystack.includes(`"${id}"`) && !haystack.includes(`'${id}'`))
  if (unresolved.length) { line('FAIL', 'AO00 gate 4: every data-testid a step selects exists', unresolved.join(', ')); return false }
  line('PASS', 'AO00 gate 4: every data-testid a step selects exists', `${ids.length} ids`)

  // gate 5: the public pages are routed and registered (no new route: /track/l and /track/s predate Step AO)
  const app = await readFile(resolve('src/App.tsx'), 'utf8')
  const problems = []
  for (const p of ['/track/l/:token', '/track/s/:token']) {
    if (!app.includes(`path="${p}"`)) problems.push(`App.tsx has no route ${p}`)
    if (!AA_HOMES.some((h) => h.pattern === p && h.kind === 'public')) problems.push(`aaRoutes has no public row for ${p}`)
  }
  if (S2_ROUTES.length === 0) problems.push('devVerifyS2 ROUTES is empty')
  if (!AA_HOMES.some((h) => h.pattern === '/tms/tracking' && h.kind === 'page')) problems.push('aaRoutes has no /tms/tracking page row')
  if (!/path="shipments\/:id"/.test(app)) problems.push('App.tsx has no shipments/:id route (the full-page Tracking tab)')
  if (problems.length) { line('FAIL', 'AO00 gate 5: routes registered', problems.join('; ')); return false }
  line('PASS', 'AO00 gate 5: routes registered', `/track/l/:token and /track/s/:token are routed and public in aaRoutes; devVerifyS2 walks ${S2_ROUTES.length} routes`)

  // gate 6: all 18 screenshots are produced by a step
  const unused = Object.keys(SHOT).filter((k) => !new RegExp(`SHOT\\.${k}\\b`).test(self.replace(/export const SHOT = \{[\s\S]*?\n\}/, '')))
  if (unused.length) { line('FAIL', 'AO00 gate 6: the 18 screenshots', `no step takes: ${unused.join(', ')}`); return false }
  line('PASS', 'AO00 gate 6: the 18 screenshots', `${Object.keys(SHOT).length} names, each taken by a step`)
  return true
}

// ───────────────────────────── dev access: GraphQL + guarded DynamoDB ─────────────────────────────
const ddb = new DynamoDBClient({ region: REGION })
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })

async function discoverDevSuffix() {
  const suffix = process.env.DEV_TABLE_SUFFIX || 'nc3jsnxdmjhkpequimypiatkma-NONE'
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

const STOPS = (day) => [
  { type: 'pickup', name: 'ZZ AO Shipper', city: 'Joliet, IL', address: { city: 'Joliet', state: 'IL', zip: '60435', lat: JOLIET.lat, lng: JOLIET.lng }, appt: `${day}T13:00:00.000Z` },
  { type: 'delivery', name: 'ZZ AO Receiver', city: 'Toledo, OH', address: { city: 'Toledo', state: 'OH', zip: '43604', lat: TOLEDO.lat, lng: TOLEDO.lng }, appt: `${day}T23:00:00.000Z` },
]

async function createCustomer(ctx) {
  const name = `ZZ AO Customer ${ctx.ts}`
  const result = await ctx.dir('UPSERT_CUSTOMER', {
    name, creditLimitCents: 100_000_000, trackingMode: 'AGENT',
    contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ AO Contact', email: `zz-ao-${ctx.ts}@example.invalid`, types: [] }],
    billToParties: [{ id: `zz-ao-bt-${ctx.ts}`, name: 'ZZ AO Bill To', isDefault: false }],
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
  for (const load of bundle.loads ?? []) { ctx.owned.add(load.id); ctx.loadIds.add(load.id) }
  // The fictional facility coordinates must be on the stops (pins, route); patch the Load when the create dropped them.
  const loadId = bundle.loads[0].id
  const stored = (await getRow(ctx.token, 'Load', loadId, 'stops')).stops
  const stops = asJson(stored)
  if (!Array.isArray(stops) || stops.some((s) => typeof s?.address?.lat !== 'number')) {
    await sdkUpdate(ctx, 'Load', loadId, { stops: typeof stored === 'string' ? JSON.stringify(STOPS(today())) : STOPS(today()) })
  }
  return bundle
}

/** An ACTIVE leg dispatched six hours ago (so every sim fix is inside the tracking window). */
async function attachLeg(ctx, bundle, label, extra = {}) {
  const load = bundle.loads[0]
  const id = ctx.owned.add(`lc-zzao-${ctx.ts}-${label}`)
  const at = nowIso()
  await sdkPut(ctx, 'LoadCarrier', {
    id, loadId: load.id, shipmentId: bundle.shipment.id, kind: 'CARRIER', status: 'ACTIVE', sequence: 1,
    carrierName: 'ZZ AO Carrier', dispatcherName: 'ZZ AO Dispatcher', dispatcherEmail: 'zz-ao@example.invalid',
    driverName: 'ZZ AO Driver', driverPhone: '+13125550199',
    dispatchedAt: new Date(Date.now() - 6 * 60 * MINUTE_MS).toISOString(),
    // createdBy/updatedBy are required() in the schema: a row without them nulls the whole listLoadCarriers page.
    rateConStatus: 'SENT', rateConSentAt: at, createdBy: 'zz-ao', updatedBy: 'zz-ao', createdAt: at, updatedAt: at,
    ...extra,
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

async function refused(name, pattern, run) {
  try { await run() } catch (err) {
    if (pattern.test(String(err?.message ?? err))) return String(err.message).slice(0, 120)
    throw new Error(`${name} refused for the wrong reason: ${String(err?.message ?? err).slice(0, 160)}`)
  }
  throw new Error(`${name} was not refused`)
}

/** B: sim pings / customer page / drawer. P: provider + a no-position customer link. D: public ping + driver page. T: texts. Own: Motive rows. */
async function buildFixtures(ctx) {
  const F = ctx.f
  F.cust = await createCustomer(ctx)
  F.sB = await createShipment(ctx, F.cust.id)
  F.sP = await createShipment(ctx, F.cust.id)
  F.sD = await createShipment(ctx, F.cust.id)
  F.sT = await createShipment(ctx, F.cust.id)
  F.sOwn = await createShipment(ctx, F.cust.id)
  F.legB = await attachLeg(ctx, F.sB, 'b')
  F.legP = await attachLeg(ctx, F.sP, 'p')
  F.legD = await attachLeg(ctx, F.sD, 'd')
  F.legT = await attachLeg(ctx, F.sT, 't')
  for (const key of ['sB', 'sP', 'sD', 'sT']) await driveInTransit(ctx, F[key])

  // One ZZ truck for the own-asset leg (AO06): Motive rows are keyed by the Equipment id.
  const n = String(ctx.ts).slice(-6)
  ctx.truckUnit = `ZZAO${n}`
  const truck = await gql(ctx.token, 'mutation($input: CreateEquipmentInput!) { createEquipment(input: $input) { id } }', { input: { type: 'truck', unitNumber: ctx.truckUnit, active: true, ownership: 'owned' } })
  ctx.truckId = ctx.owned.add(truck.createEquipment.id)
  F.legOwn = await attachLeg(ctx, F.sOwn, 'own', { kind: 'OWN_ASSET', carrierName: null, truckId: ctx.truckId, truckNumber: ctx.truckUnit })
  await driveInTransit(ctx, F.sOwn)
  console.log(`fixtures: 1 customer, 5 shipments (4 brokered legs, 1 own-asset leg), truck ${ctx.truckId}`)
}

/** Run `fn` once per run; later callers get the same promise (steps can run alone with --only). */
const once = (ctx, key, fn) => (ctx.memo[key] ??= fn())

// ───────────────────────────── data helpers ─────────────────────────────
const idOfLoad = (ctx, key) => ctx.f[key].loads[0].id

/** Every load-keyed breadcrumb (truckId = load:<id>), oldest first, through the same GSI the drawer reads. */
async function breadcrumbs(ctx, loadId) {
  const r = await gql(ctx.token, `query($t: String!) { listTruckLocationHistoryByTruckIdAndLocatedAt(truckId: $t, locatedAt: { between: ["2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"] }, sortDirection: ASC, limit: 1000) { items { truckId locatedAt source lat lon approx accuracyM ttlEpoch loadId } } }`, { t: `load:${loadId}` })
  return r.listTruckLocationHistoryByTruckIdAndLocatedAt.items
}
const bySource = (rows, source) => rows.filter((r) => r.source === source)
const checkCallsOf = (ctx, loadId) => listAll(ctx.token, 'LoadCheckCall', { loadId: { eq: loadId } }, 'id type source lat lng note createdBy')

async function publicCall(method, path, body) {
  const res = await fetch(`${PUBLIC_API}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, text, body: (() => { try { return JSON.parse(text) } catch { return null } })() }
}
const publicGet = (path) => publicCall('GET', path)
const publicPost = (path, body) => publicCall('POST', path, body)

/** The twelve fixes of AO02: link x6 (Joliet -> Gary), sms-share x2, provider:macropoint x3 (precise), sms-geocode x1 (approximate, newest). */
function simFixes() {
  const link = [300, 270, 240, 210, 180, 150].map((minutesAgo, i) => ({ minutesAgo, source: 'link', accuracyM: 12, ...lerp(JOLIET, GARY, i / 5) }))
  const share = [[120, 0.2], [100, 0.35]].map(([minutesAgo, t]) => ({ minutesAgo, source: 'sms-share', ...lerp(GARY, TOLEDO, t) }))
  const provider = [[45, 0.5], [30, 0.6], [15, 0.7]].map(([minutesAgo, t]) => ({ minutesAgo, source: 'provider:macropoint', accuracyM: 30, ...lerp(GARY, TOLEDO, t) }))
  const approx = [{ minutesAgo: 5, source: 'sms-geocode', approx: true, accuracyM: 8000, place: 'Toledo, OH', ...lerp(GARY, TOLEDO, 0.9) }]
  return [...link, ...share, ...provider, ...approx]
}

const ensureSimPings = (ctx) => once(ctx, 'simPings', async () => {
  const loadId = idOfLoad(ctx, 'sB')
  return ctx.trk('TRACKING_SIM_PINGS', { loadId, fixes: simFixes() })
})

async function mintCustomerLink(ctx, shipmentId) {
  const version = Number((await getRow(ctx.token, 'Shipment', shipmentId, 'version')).version ?? 0)
  const result = await ctx.trk('SEND_CUSTOMER_LINK', { shipmentId, expectedVersion: version, via: 'COPY', to: [] })
  const token = String(result.link.id)
  ctx.owned.add(token)
  return token
}

/** AO07's provider legs: sP gets a PROVIDER_TRACK link (kept ACTIVE for the UI) with five sim fixes behind it. */
const ensureProvider = (ctx) => once(ctx, 'provider', async () => {
  const loadId = idOfLoad(ctx, 'sP')
  const started = await ctx.trk('START_PROVIDER_TRACKING', { loadCarrierId: ctx.f.legP, provider: 'MACROPOINT' })
  const linkId = String(started.link.id)
  ctx.owned.add(linkId)
  const fixes = [50, 40, 30, 20, 10].map((minutesAgo, i) => ({ minutesAgo, accuracyM: 25, speedMph: 55, ...lerp(GARY, TOLEDO, 0.3 + i * 0.1) }))
  const delivered = await ctx.trk('TRACKING_SIM_PROVIDER', { linkId, fixes })
  return { started, linkId, delivered, loadId }
})

const ensureCustomerLinks = (ctx) => once(ctx, 'customerLinks', async () => {
  await ensureSimPings(ctx)
  await ensureProvider(ctx)
  const withPosition = await mintCustomerLink(ctx, ctx.f.sB.shipment.id)
  const hidden = await mintCustomerLink(ctx, ctx.f.sP.shipment.id)
  await sdkUpdate(ctx, 'TrackingLink', hidden, { showPosition: false })
  return { withPosition, hidden }
})

// ───────────────────────────── browser helpers ─────────────────────────────
const has = (b, selector) => b.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
const textOf = (b, selector) => b.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`)

async function shotFile(b, name) {
  const file = join(SHOTS, `${name}.png`)
  await b.screenshot(file)
  written.push(file)
}

/** A crop of one element (header + body of the map panel, the prefs row, ...). */
async function shotClip(b, name, selector, pad = 6) {
  await pause(400)
  const r = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)
  if (!r) throw new Error(`cannot crop ${selector}: no element`)
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 1 }
  const image = await b.command('Page.captureScreenshot', { format: 'png', clip })
  const file = join(SHOTS, `${name}.png`)
  await mkdir(SHOTS, { recursive: true })
  await writeFile(file, Buffer.from(image.data, 'base64'))
  written.push(file)
}

async function clickSel(b, selector) {
  const hit = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'no-element'; if (el.disabled) return 'disabled'; el.scrollIntoView({ block: 'center' }); el.click(); return 'ok' })()`)
  if (hit !== 'ok') throw new Error(`click ${selector}: ${hit}`)
}

/** Set a native <select> the way a user does (React listens for `change`). */
async function setSelect(b, selector, value) {
  const hit = await b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no-element';
    if (![...el.options].some((o) => o.value === ${JSON.stringify(value)})) return 'no-option';
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`select ${selector} = ${value}: ${hit}`)
}

async function openInIdentity(ctx, storage, prefix, fn, viewport = { width: 1440, height: 900, deviceScaleFactor: 1 }) {
  const b = await launchBrowser({ origin: ctx.origin, storage, profilePrefix: prefix, purpose: 'AO verification', viewport })
  try { return await fn(b) } finally { await b.close() }
}

/** The drawer for `shipmentId` on the grid (deep link). */
async function openDrawer(b, shipmentId) {
  await b.navigate(`/tms/tracking?assignee=all&shipment=${encodeURIComponent(shipmentId)}`)
  await b.poll(() => has(b, tid('shipment-tracking-view')), 'tracking drawer body', 60_000)
  await b.poll(() => b.evaluate(`document.querySelector('[data-testid="shipment-tracking-view"]')?.dataset.shipmentId === ${JSON.stringify(shipmentId)}`), 'drawer shows the shipment', 30_000)
  await settleMap(b)
}

/** The map panel mounted and (fallback) the state outlines drawn, or Google/unavailable decided. */
async function settleMap(b) {
  await b.poll(() => has(b, tid('tracking-map-panel')), 'map panel', 60_000)
  const collapsed = await b.evaluate(`document.querySelector('[data-testid="tracking-map-panel"]')?.dataset.collapsed === 'true'`)
  if (!collapsed) {
    await b.poll(() => b.evaluate(`(() => {
      const m = document.querySelector('[data-testid="tracking-map"]');
      if (!m) return false;
      if (m.dataset.mode === 'fallback') return m.querySelectorAll('svg path').length > 40;
      return true;
    })()`), 'map body drawn', 45_000)
  }
  await pause(500)
}

const mapFacts = (b) => b.evaluate(`(() => {
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height } };
  const m = document.querySelector('[data-testid="tracking-map"]');
  const txt = (sel) => document.querySelector(sel)?.innerText?.trim() ?? null;
  return {
    strip: rect('[data-testid="tracking-strip"]'), panel: rect('[data-testid="tracking-map-panel"]'), panes: rect('[data-testid="tracking-panes"]'),
    mode: m?.dataset.mode ?? null, fixes: m ? Number(m.dataset.fixes) : null, breadcrumbs: m ? Number(m.dataset.breadcrumbs) : null, source: m?.dataset.currentSource ?? null,
    head: txt('[data-testid="tracking-map-current"]'), tone: document.querySelector('[data-testid="tracking-map-current"]')?.dataset.tone ?? null,
    caption: txt('[data-testid="tracking-map-caption"]'), mapEta: txt('[data-testid="tracking-map-eta"]'), stripEta: txt('[data-testid="delivery-eta"]'),
    approxMarks: document.querySelectorAll('[data-testid="tracking-map-approx"]').length, dots: document.querySelectorAll('[data-testid="tracking-map-dot"]').length,
    collapsed: document.querySelector('[data-testid="tracking-map-panel"]')?.dataset.collapsed ?? null,
    // The drawer itself is a role=dialog; only a dialog that is not the tracking drawer counts.
    dialogs: [...document.querySelectorAll('[role="dialog"]')].filter((d) => !d.querySelector('[data-testid="tracking-drawer"]') && !d.matches('[data-testid="tracking-drawer"]')).length,
  };
})()`)

const problemsOf = (b) => {
  const p = b.problems()
  return [...p.exceptions.map((x) => `exception: ${x}`), ...p.consoleErrors.map((x) => `console error: ${x}`)].filter((x) => !allowedProblem(x))
}

// ───────────────────────────── steps ─────────────────────────────
const RUNNERS = {
  async AO01(ctx) {
    const r = await gql(ctx.token, `{
      t: __type(name: "TruckLocationHistory") { fields { name } }
      m: __type(name: "Mutation") { fields { name } }
      l: __type(name: "TrackingLink") { fields { name } }
      s: __schema { types { name kind enumValues { name } } }
    }`)
    const names = (x) => new Set((x?.fields ?? []).map((f) => f.name))
    const history = names(r.t)
    const wanted = ['loadId', 'accuracyM', 'approx', 'refId', 'ttlEpoch', 'payload']
    const absent = wanted.filter((n) => !history.has(n))
    expect(absent.length === 0, `TruckLocationHistory lacks ${absent.join(', ')}`)
    const mutations = names(r.m)
    const exposed = ['createTruckLocationHistory', 'updateTruckLocationHistory', 'deleteTruckLocationHistory'].filter((n) => mutations.has(n))
    expect(exposed.length === 0, `TruckLocationHistory is still writable through GraphQL: ${exposed.join(', ')}`)
    const link = names(r.l)
    const linkAbsent = ['consentAt', 'provider', 'providerRef', 'lastPingAt'].filter((n) => !link.has(n))
    expect(linkAbsent.length === 0, `TrackingLink lacks ${linkAbsent.join(', ')}`)
    const kind = r.s.types.find((t) => t.kind === 'ENUM' && t.enumValues?.some((v) => v.name === 'CARRIER_UPLOAD'))
    expect(kind?.enumValues.some((v) => v.name === 'PROVIDER_TRACK'), 'the TrackingLink kind enum does not accept PROVIDER_TRACK')
    // A load-keyed read must work through the same GSI the drawer uses (empty is fine here).
    await breadcrumbs(ctx, `zz-ao-none-${ctx.ts}`)
    const ttl = await ddb.send(new DescribeTimeToLiveCommand({ TableName: devTable('TruckLocationHistory', ctx.suffix) }))
    const spec = ttl.TimeToLiveDescription
    expect(spec?.AttributeName === 'ttlEpoch' && /^ENABL/.test(String(spec.TimeToLiveStatus)), `TruckLocationHistory TTL is ${spec?.AttributeName ?? 'unset'} / ${spec?.TimeToLiveStatus ?? 'DISABLED'}, expected ttlEpoch enabled`)
    return `TruckLocationHistory exposes ${wanted.length} new attributes, create/update/delete mutations are not exposed, TTL on ${spec.AttributeName} is ${spec.TimeToLiveStatus}; TrackingLink kind accepts PROVIDER_TRACK and carries ${['consentAt', 'provider', 'providerRef'].join('/')}`
  },

  async AO02(ctx) {
    const loadId = idOfLoad(ctx, 'sB')
    const result = await ensureSimPings(ctx)
    expect(result.written === 12 && result.duplicates === 0, `TRACKING_SIM_PINGS wrote ${result.written} (+${result.duplicates} duplicates), expected 12`)
    const rows = await breadcrumbs(ctx, loadId)
    expect(rows.length === 12, `listLoadBreadcrumbs-equivalent read returned ${rows.length} rows, expected 12`)
    const counts = Object.fromEntries(['link', 'sms-share', 'sms-geocode', 'provider:macropoint'].map((s) => [s, bySource(rows, s).length]))
    expect(counts.link === 6 && counts['sms-share'] === 2 && counts['sms-geocode'] === 1 && counts['provider:macropoint'] === 3, `sources ${JSON.stringify(counts)}`)
    const ordered = rows.every((r, i) => i === 0 || rows[i - 1].locatedAt < r.locatedAt)
    expect(ordered, 'the read is not oldest-first')
    const approx = rows.filter((r) => r.approx === true)
    expect(approx.length === 1 && approx[0].source === 'sms-geocode' && approx[0].accuracyM === 8000, `approximate rows ${JSON.stringify(approx.map((r) => [r.source, r.accuracyM]))}`)
    const badTtl = rows.filter((r) => typeof r.ttlEpoch !== 'number' || Math.abs(r.ttlEpoch - (Date.parse(r.locatedAt) / 1000 + 90 * DAY_S)) > DAY_S)
    expect(badTtl.length === 0, `${badTtl.length} rows have a ttlEpoch that is not fix time + 90 d`)
    expect(rows.every((r) => r.truckId === `load:${loadId}` && r.loadId === loadId), 'a row is keyed to the wrong load')
    return `12 sim fixes written and read back oldest-first (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}); ttlEpoch = fix + 90 d on all 12; load ${loadId}`
  },

  async AO03(ctx) {
    const loadId = idOfLoad(ctx, 'sD')
    const minted = await ctx.trk('SEND_TRACKING_LINK', { loadCarrierId: ctx.f.legD, via: 'COPY' })
    const token = String(minted.link.id)
    ctx.owned.add(token)
    const view = await publicGet(`/l/${token}`)
    expect(view.status === 200 && view.body?.share, `GET /l/${maskToken(token)} -> ${view.status}`)
    const share = view.body.share
    expect(share.consentRequired === true && share.active === true && share.everyMin === 5, `share ${JSON.stringify({ ...share, consentText: undefined })}`)
    expect(typeof share.consentText === 'string' && share.consentText.length > 80 && /Stop sharing/.test(share.consentText), 'the consent text is missing or does not name Stop sharing')

    const fix = { lat: 41.5251, lng: -88.0817, accuracyM: 12, trigger: 'tap' }
    const noConsent = await publicPost(`/l/${token}/ping`, fix)
    expect(noConsent.status === 403 && noConsent.body?.error === 'consent', `ping without consent -> ${noConsent.status} ${noConsent.text.slice(0, 60)}`)
    expect((await breadcrumbs(ctx, loadId)).length === 0, 'a breadcrumb exists for a link whose driver never agreed')
    expect(Number((await getRow(ctx.token, 'TrackingLink', token, 'pingCount')).pingCount ?? 0) === 0, 'the refused ping moved the link counter')

    const ok = await publicPost(`/l/${token}/ping`, { ...fix, consent: true })
    expect(ok.status === 200 && ok.body?.ok === true, `ping with consent -> ${ok.status} ${ok.text.slice(0, 80)}`)
    const rows = await breadcrumbs(ctx, loadId)
    expect(rows.length === 1 && rows[0].source === 'link', `after the ping: ${rows.length} breadcrumbs (${rows.map((r) => r.source).join(',')})`)
    const link = await getRow(ctx.token, 'TrackingLink', token, 'pingCount consentAt')
    expect(Number(link.pingCount) === 1 && !!link.consentAt, `link after consent: pingCount ${link.pingCount}, consentAt ${link.consentAt ? 'set' : 'missing'}`)
    const calls = (await checkCallsOf(ctx, loadId)).filter((c) => c.type === 'TRACKING_PING')
    expect(calls.length === 1 && /Driver consented/.test(calls[0].note ?? ''), `${calls.length} TRACKING_PING check calls, note ${JSON.stringify(calls[0]?.note ?? null)}`)

    const again = await publicPost(`/l/${token}/ping`, { ...fix, consent: true })
    expect(again.status === 429, `a second ping inside 60 s -> ${again.status}, expected 429`)
    expect((await breadcrumbs(ctx, loadId)).length === 1, 'the refused second ping left a breadcrumb')
    const after = await publicGet(`/l/${token}`)
    expect(after.body?.share?.consentRequired === false && after.body.share.pingCount === 1, 'share.consentRequired did not flip after consent')
    return `link ${maskToken(token)}: consentRequired true -> 403 (no row, counter 0) -> 200 (1 breadcrumb, 1 TRACKING_PING "Driver consented") -> 429 inside 60 s; consentRequired false afterwards`
  },

  async AO04(ctx) {
    const shipmentId = ctx.f.sT.shipment.id
    const loadId = idOfLoad(ctx, 'sT')
    const texts = [
      ['an Apple Maps pin', 'Here is my pin https://maps.apple.com/?ll=41.5251,-88.0817&q=Dropped%20Pin', { lat: 41.5251, lng: -88.0817 }],
      ['a Google Maps long link', 'https://www.google.com/maps/place/ZZ/@41.5934,-87.3465,17z', { lat: 41.5934, lng: -87.3465 }],
      ['raw coordinates', '41.6511, -83.5379', { lat: 41.6511, lng: -83.5379 }],
    ]
    for (const [label, body, want] of texts) {
      const before = bySource(await breadcrumbs(ctx, loadId), 'sms-share').length
      const r = await ctx.trk('TRACKING_SIM_TEXT', { shipmentId, body })
      expect(r.routed === true, `${label}: not routed (${r.reason ?? 'no reason'})`)
      await pause(1100) // distinct locatedAt
      const rows = bySource(await breadcrumbs(ctx, loadId), 'sms-share')
      expect(rows.length === before + 1, `${label}: ${rows.length - before} new sms-share fixes, expected 1`)
      const row = rows[rows.length - 1]
      expect(Math.abs(row.lat - want.lat) < 1e-6 && Math.abs(row.lon - want.lng) < 1e-6 && row.approx !== true, `${label}: stored a different position or marked it approximate`)
    }
    const location = (await checkCallsOf(ctx, loadId)).filter((c) => c.type === 'LOCATION_UPDATE')
    expect(location.length === 3, `${location.length} LOCATION_UPDATE check calls, expected 3`)
    // A link to a host that is not on the allow-list is plain text: a NOTE, no pin, never fetched.
    const before = (await breadcrumbs(ctx, loadId)).length
    const note = await ctx.trk('TRACKING_SIM_TEXT', { shipmentId, body: 'https://share.zz-ao.example.invalid/x7Kq' })
    expect(note.routed === true, 'the non-allow-listed link text was not routed')
    await pause(500)
    expect((await breadcrumbs(ctx, loadId)).length === before, 'a link to a non-allow-listed host produced a breadcrumb')
    return 'Apple Maps URL, Google long URL and raw coordinates each filed one exact sms-share pin (3 LOCATION_UPDATE check calls); a link to a non-allow-listed host filed no pin'
  },

  async AO05(ctx) {
    const shipmentId = ctx.f.sT.shipment.id
    const loadId = idOfLoad(ctx, 'sT')
    const before = (await breadcrumbs(ctx, loadId)).length
    const thanks = await ctx.trk('TRACKING_SIM_TEXT', { shipmentId, body: 'Thanks' })
    expect(thanks.routed === true, '"Thanks" was not routed')
    await pause(500)
    expect((await breadcrumbs(ctx, loadId)).length === before, '"Thanks" produced a fix')
    await pause(1100)
    const placeText = await ctx.trk('TRACKING_SIM_TEXT', { shipmentId, body: 'just passed Gary IN' })
    expect(placeText.routed === true, '"just passed Gary IN" was not routed')
    await pause(800)
    const approx = (await breadcrumbs(ctx, loadId)).filter((r) => r.source === 'sms-geocode')
    if (approx.length === 0) {
      // The dev server Maps key is neutered (AO-plan F13): the geocoder returns nothing, so the reply stays a NOTE.
      return '"Thanks" filed no fix; "just passed Gary IN" filed no fix either — the dev server geocoder is neutered (NOTE only); the approximate path is covered by AO02 / AO10 with a sim sms-geocode fix'
    }
    expect(approx.length === 1 && approx[0].approx === true && (approx[0].accuracyM ?? 0) >= 2000, `geocoded reply: ${approx.length} rows, approx ${approx[0]?.approx}, radius ${approx[0]?.accuracyM}`)
    return `"Thanks" filed no fix; "just passed Gary IN" filed one approximate fix (radius ${approx[0].accuracyM} m)`
  },

  async AO06(ctx) {
    // Eight Motive rows for the ZZ truck, 130-200 minutes ago (older than 61 min: the map must read "stale").
    const table = devTable('TruckLocationHistory', ctx.suffix)
    const now = Date.now()
    for (let i = 0; i < 8; i += 1) {
      const at = new Date(now - (200 - i * 10) * MINUTE_MS).toISOString()
      const p = lerp(JOLIET, GARY, i / 7)
      ctx.owned.assert('Equipment', ctx.truckId)
      await doc.send(new PutCommand({ TableName: table, Item: {
        __typename: 'TruckLocationHistory', truckId: ctx.truckId, locatedAt: at, unitNumber: ctx.truckUnit,
        lat: p.lat, lon: p.lng, bearing: 90, speed: 55, source: 'motive', syncedAt: at,
      } }))
      ctx.motiveRows.push({ truckId: ctx.truckId, locatedAt: at })
    }
    const read = await gql(ctx.token, `query($t: String!) { listTruckLocationHistoryByTruckIdAndLocatedAt(truckId: $t, sortDirection: ASC, limit: 100) { items { locatedAt source } } }`, { t: ctx.truckId })
    const rows = read.listTruckLocationHistoryByTruckIdAndLocatedAt.items
    expect(rows.length === 8 && rows.every((r) => r.source === 'motive'), `the truck read returns ${rows.length} rows (${[...new Set(rows.map((r) => r.source))].join(',')}), expected 8 motive`)
    return `8 Motive rows put for the ZZ truck ${ctx.truckId} (fictional I-80 positions, 130-200 min ago) and read back; the real motive-location-sync was never called; the drawer's merged view is checked in AO10`
  },

  async AO07(ctx) {
    const loadId = idOfLoad(ctx, 'sP')
    const { started, linkId, delivered } = await ensureProvider(ctx)
    expect(started.mode === 'STUB' && /^STUB — /.test(started.message), `start returned mode ${started.mode}, message ${JSON.stringify(String(started.message).slice(0, 50))}`)
    expect(started.link.kind === 'PROVIDER_TRACK' && started.link.status === 'ACTIVE' && /^stub:/.test(String(started.link.providerRef)), `link ${JSON.stringify({ kind: started.link.kind, status: started.link.status })}`)
    expect(delivered.accepted === 5 && delivered.duplicates === 0, `TRACKING_SIM_PROVIDER accepted ${delivered.accepted} (+${delivered.duplicates} dup, ignored ${delivered.ignored})`)
    const rows = bySource(await breadcrumbs(ctx, loadId), 'provider:macropoint')
    expect(rows.length === 5, `${rows.length} provider:macropoint rows, expected 5`)
    expect(Number((await getRow(ctx.token, 'TrackingLink', linkId, 'pingCount')).pingCount) === 5, 'the link counter does not equal 5')

    // A second start on the same leg revokes the first; a delivery for the revoked link writes nothing.
    const second = await ctx.trk('START_PROVIDER_TRACKING', { loadCarrierId: ctx.f.legP, provider: 'MACROPOINT' })
    ctx.owned.add(String(second.link.id))
    expect((await getRow(ctx.token, 'TrackingLink', linkId, 'status')).status === 'REVOKED', 'the first subscription is still ACTIVE after a second start')
    const stale = await ctx.trk('TRACKING_SIM_PROVIDER', { linkId, fixes: [{ minutesAgo: 1, lat: GARY.lat, lng: GARY.lng }] })
    expect(stale.accepted === 0 && stale.ignored === 'link-not-active', `delivery for the revoked link: ${JSON.stringify(stale)}`)
    expect(bySource(await breadcrumbs(ctx, loadId), 'provider:macropoint').length === 5, 'a revoked subscription still wrote a fix')
    const stopped = await ctx.trk('STOP_PROVIDER_TRACKING', { linkId: String(second.link.id) })
    expect(stopped.link.status === 'REVOKED', `stop left the link ${stopped.link.status}`)
    // Leave one ACTIVE subscription for the UI steps.
    const third = await ctx.trk('START_PROVIDER_TRACKING', { loadCarrierId: ctx.f.legP, provider: 'MACROPOINT' })
    ctx.owned.add(String(third.link.id))
    expect(third.link.status === 'ACTIVE', 'the restarted subscription is not ACTIVE')

    await refused('an own-asset leg', /Own trucks track through Motive/i, () => ctx.trk('START_PROVIDER_TRACKING', { loadCarrierId: ctx.f.legOwn, provider: 'MACROPOINT' }))
    await refused('a provider that is not a tracking provider', /not a tracking provider|does not offer/i, () => ctx.trk('START_PROVIDER_TRACKING', { loadCarrierId: ctx.f.legP, provider: 'QUICKBOOKS' }))
    return `STUB start (${String(started.message).slice(0, 40)}…), 5 sim deliveries -> 5 provider:macropoint rows and counter 5; second start revoked the first (its delivery ignored); stop revoked; restarted for the UI; own-asset leg and a non-tracking provider refused; nothing left the Lambda`
  },

  async AO08(ctx) {
    const loadId = idOfLoad(ctx, 'sB')
    const first = await ctx.trk('GET_LOAD_ROUTE', { loadId })
    const second = await ctx.trk('GET_LOAD_ROUTE', { loadId })
    const sources = ['ROUTES_API', 'DIRECTIONS_LEGACY', 'ESTIMATE']
    expect(sources.includes(first.source), `first call source ${first.source} (reason ${first.reason ?? 'none'})`)
    expect(typeof first.encoded === 'string' && first.encoded.length > 0 && Array.isArray(first.waypoints) && first.waypoints.length >= 2, 'the route has no polyline or fewer than two waypoints')
    if (first.source === 'ESTIMATE') expect(typeof first.reason === 'string' && first.reason.length > 0, 'an ESTIMATE route carries no reason')
    expect(second.cached === true && second.encoded === first.encoded, `second call cached ${second.cached}, same polyline ${second.encoded === first.encoded}`)
    return `GET_LOAD_ROUTE twice: first cached ${first.cached}${first.cached ? ' (lane already cached by an earlier run)' : ''}, second cached true with the same polyline; source ${first.source}${first.reason ? ` (reason: ${String(first.reason).slice(0, 70)})` : ''}; ${first.waypoints.length} waypoints; never an error`
  },

  async AO09(ctx) {
    const { withPosition, hidden } = await ensureCustomerLinks(ctx)
    const res = await publicGet(`/s/${withPosition}`)
    expect(res.status === 200 && res.body, `GET /s/${maskToken(withPosition)} -> ${res.status}`)
    const view = res.body
    expect(view.map && Array.isArray(view.map.trail) && view.map.stops?.length >= 2, 'the customer view has no map.trail / map.stops')
    const trail = view.map.trail
    expect(trail.length >= 6 && trail.length <= 96, `trail has ${trail.length} points`)
    const gaps = trail.slice(1).map((p, i) => (Date.parse(p.at) - Date.parse(trail[i].at)) / MINUTE_MS)
    expect(gaps.slice(0, -1).every((g) => g >= 14.9), `trail gaps (min) ${gaps.map((g) => g.toFixed(0)).join(',')}: not thinned to >= 15 minutes`)
    const round3 = (n) => Math.abs(Number(n.toFixed(3)) - n) < 1e-9
    expect(trail.every((p) => round3(p.lat) && round3(p.lng)) && view.map.stops.every((s) => round3(s.lat) && round3(s.lng)), 'a coordinate on the customer page is finer than 3 decimals')
    expect(trail.some((p) => p.approx === true), 'the approximate fix is not flagged approx:true')
    expect(view.position && round3(view.position.lat), 'position missing or not rounded')
    const forbidden = ['"source"', 'accuracyM', '"speed', 'heading', 'refId', 'ZZ AO Carrier', 'ZZ AO Driver'].filter((s) => res.text.includes(s))
    expect(forbidden.length === 0, `the customer body contains ${forbidden.join(', ')}`)
    expect(!('carrier' in view), 'the customer view names the carrier although the link does not show it')
    const hiddenRes = await publicGet(`/s/${hidden}`)
    expect(hiddenRes.status === 200 && hiddenRes.body && !('map' in hiddenRes.body) && !('position' in hiddenRes.body), `the showPosition:false link still carries ${['map', 'position'].filter((k) => hiddenRes.body && k in hiddenRes.body).join(', ') || 'a non-200 status'}`)
    return `customer link ${maskToken(withPosition)}: trail ${trail.length} points, >= 15 min apart, 3 dp, approx flagged, no source / accuracy / speed / heading / refId / carrier anywhere in the body; link ${maskToken(hidden)} (showPosition false) has no map and no position`
  },

  async AO10(ctx) {
    await ensureSimPings(ctx)
    await ensureProvider(ctx)
    const idB = ctx.f.sB.shipment.id
    const notes = []
    await openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-ao-drawer-', async (b) => {
      b.mark()
      await openDrawer(b, idB)
      // The collapsed state is remembered per browser; start from a known (expanded) state.
      await b.evaluate(`localStorage.removeItem('tms.tracking.map.collapsed')`)
      await b.reload()
      await openDrawer(b, idB)
      // The panel paints (stop pins) before the first breadcrumb read returns; wait for the 12 fixes, then judge.
      await b.poll(async () => (await mapFacts(b)).fixes === 12, 'the brokered leg\'s 12 fixes', 45_000).catch(() => {})
      await settleMap(b)
      const f = await mapFacts(b)
      const bad = []
      if (!f.panel || !f.strip || !f.panes) bad.push('strip, map panel or panes is missing')
      else {
        if (f.panel.top < f.strip.bottom - 1) bad.push(`the map starts at ${Math.round(f.panel.top)}px, above the strip end ${Math.round(f.strip.bottom)}px`)
        if (f.panes.top < f.panel.bottom - 1) bad.push(`the panes start at ${Math.round(f.panes.top)}px, above the map end ${Math.round(f.panel.bottom)}px`)
      }
      if (f.mode !== 'fallback' && f.mode !== 'google') bad.push(`data-mode is ${f.mode}; expected google (a working key) or fallback`)
      if (f.fixes !== 12) bad.push(`data-fixes ${f.fixes}, expected 12 (AO02)`)
      if (!(f.breadcrumbs > 0)) bad.push('data-breadcrumbs is 0')
      if (f.source !== 'provider:macropoint') bad.push(`data-current-source ${JSON.stringify(f.source)}, expected provider:macropoint (the newest PRECISE fix; the newer approximate one is only an overlay)`)
      if (!/MacroPoint/.test(f.head ?? '') || !/(\d+\s*(min|h)|just now)/i.test(f.head ?? '')) bad.push(`header text ${JSON.stringify(f.head)} lacks the source label or age`)
      if (f.approxMarks < 1) bad.push('no approximate overlay (tracking-map-approx)')
      if (f.mode === 'fallback' && !/showing outline/i.test(f.caption ?? '')) bad.push(`caption ${JSON.stringify(f.caption)}, expected the no-key outline caption`)
      if (f.mapEta && f.stripEta && f.mapEta.replace(/^ETA\s*/i, '') !== f.stripEta.replace(/^ETA\s*/i, '')) bad.push(`map ETA ${JSON.stringify(f.mapEta)} differs from the strip ${JSON.stringify(f.stripEta)}`)
      if (bad.length) throw new Error(bad.join('; '))
      notes.push(`map between strip and panes, ${f.mode}, ${f.fixes} fixes, current ${f.source}${f.mapEta ? ', ETA matches the strip' : ''}`)

      await walk.setTheme(b, 'light').catch(() => {})
      await pause(300)
      await shotFile(b, SHOT.drawerExpanded)
      await shotClip(b, SHOT.prefsIdle, tid('tracking-strip'))
      await shotClip(b, SHOT.allSources, tid('tracking-map-panel'))
      await shotClip(b, SHOT.approx, tid('tracking-map'))
      await shotClip(b, SHOT.noKey, tid('tracking-map-panel'))
      if (!flag('no-dark')) {
        await walk.setTheme(b, 'dark').catch(() => {})
        await pause(500)
        await shotFile(b, SHOT.drawerExpandedDark)
        await walk.setTheme(b, 'light').catch(() => {})
      }

      // Collapse, reload: it stays collapsed and mounts no map body.
      await clickSel(b, tid('tracking-map-toggle'))
      await b.poll(() => b.evaluate(`document.querySelector('[data-testid="tracking-map-panel"]')?.dataset.collapsed === 'true'`), 'panel collapsed', 10_000)
      await b.reload()
      await openDrawer(b, idB)
      const persisted = await mapFacts(b)
      expect(persisted.collapsed === 'true' && persisted.mode == null, `after a reload collapsed is ${persisted.collapsed}, map body mounted: ${persisted.mode != null}`)
      await shotFile(b, SHOT.drawerCollapsed)
      await clickSel(b, tid('tracking-map-toggle'))
      await settleMap(b)
      notes.push('collapse persists across a reload and mounts no map')

      const problems = problemsOf(b)
      expect(problems.length === 0, `console problems: ${problems.slice(0, 3).join(' | ').slice(0, 300)}`)
      notes.push('no console errors beyond the allow-listed neutered Maps key')

      // Stale tone: the own-asset leg's newest Motive row is 130 min old.
      await openDrawer(b, ctx.f.sOwn.shipment.id)
      // The drawer paints the panel before the Motive read returns (60 s poll hook, first read async): wait for the fixes, then judge.
      await b.poll(async () => (await mapFacts(b)).fixes === 8, 'the own-asset leg\'s 8 Motive fixes', 30_000).catch(() => {})
      const own = await mapFacts(b)
      expect(own.fixes === 8 && own.source === 'motive' && own.tone === 'stale', `own-asset drawer: ${own.fixes} fixes, source ${own.source}, tone ${own.tone}; expected 8 / motive / stale`)
      await shotClip(b, SHOT.stale, tid('tracking-map-panel'))
      notes.push('own-asset leg: 8 Motive fixes merged, tone stale')

      // Provider badge + menu on the provider leg.
      await openDrawer(b, ctx.f.sP.shipment.id)
      await b.poll(() => has(b, tid('tracking-map-provider')), 'provider badge', 20_000)
      expect(/MacroPoint.*STUB/.test(await textOf(b, tid("tracking-map-provider")) ?? ""), 'the provider badge does not read "MacroPoint · STUB"')
      await b.click({ selector: tid('tracking-map-menu'), real: true })
      await b.poll(() => has(b, tid('provider-stop')), 'provider menu offers Stop', 10_000)
      await shotFile(b, SHOT.providerStub)
      await b.press('Escape')
      notes.push('provider leg: "MacroPoint · STUB" badge and a Stop item')

      // The full-page Tracking tab carries the same panel and no longer a detail map.
      await b.navigate(`/tms/shipments/${idB}?tab=tracking`)
      await b.poll(() => has(b, tid('tracking-map-panel')), 'map panel on the Tracking tab', 60_000)
      await settleMap(b)
      expect(!(await has(b, "[data-testid='tracking-detail-map']")), 'the retired detail map still renders on the Tracking tab')
      await shotFile(b, SHOT.trackingTab)
      notes.push('full-page Tracking tab shows the panel, no detail map')
    })

    // SVG outline data blocked: the panel degrades to text and keeps the position readable.
    await openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-ao-blocked-', async (b) => {
      await b.blockUrls(['*states-10m*'])
      await b.navigate(`/tms/tracking?assignee=all&shipment=${encodeURIComponent(idB)}`)
      await b.poll(() => has(b, tid('tracking-map-unavailable')), 'the "Map unavailable" text', 60_000)
      expect(/Map unavailable/.test(await textOf(b, tid('tracking-map-unavailable')) ?? ''), 'the unavailable text is wrong')
      await shotClip(b, SHOT.unavailable, tid('tracking-map-panel'))
      notes.push('blocked outline data -> "Map unavailable" text')
    })
    return notes.join('; ')
  },

  async AO11(ctx) {
    await ensureSimPings(ctx)
    const shipmentId = ctx.f.sB.shipment.id
    await ctx.ship('SET_TRACKING_PREFS', { shipmentId, prefs: null })
    return openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-ao-prefs-', async (b) => {
      await openDrawer(b, shipmentId)
      const row = tid('tracking-prefs-row')
      const top = async () => Number((await mapFacts(b)).panes?.top)
      const idle = await b.evaluate(`(() => { const r = document.querySelector('[data-testid="tracking-prefs-row"]'); if (!r) return null; const save = [...r.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'); return { selects: r.querySelectorAll('select').length, saveDisabled: !!save?.disabled, dot: !!r.querySelector('[data-testid="tracking-prefs-dot"]') } })()`)
      expect(idle && idle.selects === 3 && idle.saveDisabled && !idle.dot, `idle prefs row ${JSON.stringify(idle)}: expected 3 selects visible with no click, Save disabled, no override dot`)
      const top0 = await top()
      expect((await mapFacts(b)).dialogs === 0, 'a dialog is open before any click')

      await setSelect(b, `${row} select[data-field="mode"]`, 'MANUAL')
      await setSelect(b, `${row} select[data-field="method"]`, 'SMS')
      await setSelect(b, `${row} select[data-field="sms"]`, 'WORK_ONLY')
      await b.poll(() => b.evaluate(`![...document.querySelectorAll('[data-testid="tracking-prefs-row"] button')].find((x) => x.textContent.trim() === 'Save')?.disabled`), 'Save enabled once the draft differs', 10_000)
      const topDirty = await top()
      await shotClip(b, SHOT.prefsDirty, tid('tracking-strip'))

      await b.click({ selector: `${row} button`, text: 'Save' })
      await b.poll(() => has(b, tid('tracking-prefs-dot')), 'the customised dot after Save', 30_000)
      await pause(600)
      const topSaved = await top()
      const after = await mapFacts(b)
      expect(Math.abs(topDirty - top0) < 0.5 && Math.abs(topSaved - top0) < 0.5, `the panes moved: top ${top0} -> ${topDirty} (dirty) -> ${topSaved} (saved)`)
      expect(after.dialogs === 0 && !(await has(b, '.tms-prefs-panel')), 'a dialog or the retired .tms-prefs-panel appeared')
      await shotFile(b, SHOT.prefsSaved)
      const stored = await asJson((await getRow(ctx.token, 'Shipment', shipmentId, 'trackingPrefs')).trackingPrefs)
      expect(stored?.mode === 'MANUAL' && stored?.method === 'SMS' && stored?.driverSms === 'WORK_ONLY', `stored override ${JSON.stringify(stored)}`)
      await ctx.ship('SET_TRACKING_PREFS', { shipmentId, prefs: null })
      return `3 selects visible with no click; panes top ${Math.round(top0)} -> ${Math.round(topDirty)} (edited) -> ${Math.round(topSaved)} (saved): delta 0 px; no dialog / .tms-prefs-panel; override stored {MANUAL, SMS, WORK_ONLY} and the dot shows (override then cleared)`
    })
  },

  async AO12(ctx) {
    const loadId = idOfLoad(ctx, 'sD')
    // A fresh link (the previous one belongs to AO03 and has consent): consent must be asked again.
    const minted = await ctx.trk('SEND_TRACKING_LINK', { loadCarrierId: ctx.f.legD, via: 'COPY' })
    const token = String(minted.link.id)
    ctx.owned.add(token)
    const b = await launchBrowser({ origin: ctx.origin, profilePrefix: 'bcat-ao-driver-', purpose: 'AO verification', viewport: { width: 390, height: 844, deviceScaleFactor: 2 } })
    try {
      // Count every geolocation call: none may happen before the tap.
      await b.addInitScript(`(() => { window.__geo = 0; const g = navigator.geolocation; if (!g) return; for (const m of ['getCurrentPosition', 'watchPosition']) { const o = g[m].bind(g); g[m] = (...a) => { window.__geo += 1; return o(...a) } } })()`)
      await b.navigate(`/track/l/${token}`)
      await b.poll(() => has(b, tid('consent-text')), 'the consent text', 45_000)
      const consent = await b.evaluate(`(() => {
        const start = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Start sharing');
        const agree = [...document.querySelectorAll('label')].find((l) => /I agree/.test(l.textContent));
        return { text: document.querySelector('[data-testid="consent-text"]').innerText, startDisabled: !!start?.disabled, hasStart: !!start, hasAgree: !!agree?.querySelector('input[type=checkbox]'), geo: window.__geo };
      })()`)
      expect(consent.hasStart && consent.startDisabled, 'Start sharing is missing or enabled before the box is ticked')
      expect(consent.hasAgree && consent.text.length > 80 && /Stop sharing/.test(consent.text), 'the consent text or the "I agree" box is missing')
      expect(consent.geo === 0, `geolocation was requested ${consent.geo} time(s) before the tap`)
      await shotFile(b, SHOT.driverConsent)

      await b.evaluate(`[...document.querySelectorAll('label')].find((l) => /I agree/.test(l.textContent)).querySelector('input[type=checkbox]').click()`)
      await b.poll(() => b.evaluate(`![...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Start sharing')?.disabled`), 'Start sharing enabled after the tick', 10_000)
      await b.grantGeolocation()
      await b.setGeolocation(41.6, -87.9, 20)
      await b.click({ text: 'Start sharing' })
      await b.poll(() => b.evaluate(`/Sharing · last sent/.test(document.body.innerText)`), 'the "Sharing · last sent" status line', 45_000)
      expect(Number(await b.evaluate('window.__geo')) >= 1, 'no geolocation call after the tap')
      const link = await getRow(ctx.token, 'TrackingLink', token, 'pingCount consentAt')
      expect(Number(link.pingCount) >= 1 && !!link.consentAt, `link after the emulated fix: pingCount ${link.pingCount}, consentAt ${link.consentAt ? 'set' : 'missing'}`)
      await shotFile(b, SHOT.driverSharing)

      await b.click({ text: 'Stop sharing' })
      await b.poll(() => b.evaluate(`!/Sharing · last sent/.test(document.body.innerText) && [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'Start sharing')`), 'Stop sharing returns to the start state', 15_000)

      // Delivery: the server refuses (410, nothing written) and the page shows the done state.
      await sdkUpdate(ctx, 'Load', loadId, { status: 'DELIVERED', deliveredAt: nowIso() })
      const before = (await breadcrumbs(ctx, loadId)).length
      const refusedPing = await publicPost(`/l/${token}/ping`, { lat: 41.6, lng: -87.9, accuracyM: 15, consent: true })
      expect(refusedPing.status === 410 && refusedPing.body?.done === true, `ping on a delivered load -> ${refusedPing.status} ${refusedPing.text.slice(0, 60)}`)
      expect((await breadcrumbs(ctx, loadId)).length === before, 'a ping on a delivered load wrote a breadcrumb')
      await b.navigate(`/track/l/${token}`)
      await b.poll(() => b.evaluate(`/Delivery complete/.test(document.body.innerText)`), 'the done state', 45_000)
      await shotFile(b, SHOT.driverDone)
      return `390x844: consent text + "I agree" shown, Start sharing disabled, 0 geolocation calls before the tap; after the tick + emulated position the first fix posted (link ${maskToken(token)}, consent recorded) and "Sharing · last sent" appeared; Stop sharing works; a delivered load answers 410 (no row) and the page shows "Delivery complete"`
    } finally { await b.close() }
  },

  async AO13(ctx) {
    const { withPosition, hidden } = await ensureCustomerLinks(ctx)
    const b = await launchBrowser({ origin: ctx.origin, profilePrefix: 'bcat-ao-customer-', purpose: 'AO verification', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } })
    try {
      await b.navigate(`/track/s/${withPosition}`)
      await b.poll(() => has(b, tid('tracking-map')), 'the customer map', 60_000)
      await b.poll(() => b.evaluate(`(() => { const m = document.querySelector('[data-testid="tracking-map"]'); return !!m && (m.dataset.mode === 'google' ? m.querySelectorAll('[data-testid="tracking-map-dot"]').length > 0 : m.querySelectorAll('svg path').length > 40) })()`), 'the map drawn', 45_000)
      // data-breadcrumbs is the model's dot count, the same number either renderer draws.
      const facts = await b.evaluate(`(() => { const m = document.querySelector('[data-testid="tracking-map"]'); return { mode: m.dataset.mode, fixes: Number(m.dataset.fixes), dots: Number(m.dataset.breadcrumbs), drawn: m.querySelectorAll('[data-testid="tracking-map-dot"]').length, text: document.body.innerText } })()`)
      expect((facts.mode === 'fallback' || facts.mode === 'google') && facts.fixes >= 6 && facts.dots >= 5 && facts.drawn >= 1, `customer map mode ${facts.mode}, ${facts.fixes} fixes, ${facts.dots} model dots, ${facts.drawn} drawn`)
      expect(!/Motive|sms-share|sms-geocode|provider:|MacroPoint|accuracy|Driver phone/i.test(facts.text), 'the customer page prints a source or accuracy string')
      await shotFile(b, SHOT.customerTrail)

      await b.navigate(`/track/s/${hidden}`)
      await b.poll(() => b.evaluate(`/Shipment ZZ|Shipment \\d|Stops/.test(document.body.innerText)`), 'the no-position page', 45_000)
      await pause(800)
      expect(!(await has(b, tid('tracking-map'))) && !/Last seen/.test(await b.evaluate('document.body.innerText')), 'a showPosition:false link renders a map or a last-seen line')
      await shotFile(b, SHOT.customerNoPosition)
      return `customer page: ${facts.dots} trail dots (data-mode ${facts.mode}, ${facts.fixes} fixes), no source / accuracy text; the showPosition:false link renders no map and no "Last seen"`
    } finally { await b.close() }
  },

  async AO14(ctx) {
    if (process.env.DEV_VERIFY_MAPS !== '1') throw new SkipError('needs DEV_VERIFY_MAPS=1 and a Maps key valid for this origin; the dev key is neutered (AO-plan F13), so the Google branch is covered by the mocked-library unit test and a manual look')
    await ensureSimPings(ctx)
    const idB = ctx.f.sB.shipment.id
    return openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-ao-google-', async (b) => {
      await b.navigate(`/tms/tracking?assignee=all&shipment=${encodeURIComponent(idB)}`)
      await b.poll(() => has(b, tid('tracking-map-panel')), 'map panel', 60_000)
      await b.poll(() => b.evaluate(`document.querySelector('[data-testid="tracking-map"]')?.dataset.mode === 'google'`), 'data-mode google', 45_000)
      await b.poll(() => has(b, tid('tracking-map-google')), 'the Google map container', 30_000)
      const markers = await b.evaluate(`document.querySelectorAll('[data-testid="tracking-map-dot"], [data-testid="tracking-map-current-marker"], [data-testid^="tracking-map-pin-"]').length`)
      expect(markers >= 5, `only ${markers} markers on the Google map`)
      return `data-mode google with ${markers} markers (dots, pins, current)`
    })
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
    const history = devTable('TruckLocationHistory', ctx.suffix)
    // ZZ load pings (truckId load:<our load>) and the Motive rows this run put (keys remembered, never a scan).
    let pings = 0
    for (const loadId of ctx.loadIds) {
      for (const row of await breadcrumbs(ctx, loadId).catch(() => [])) {
        await doc.send(new DeleteCommand({ TableName: history, Key: { truckId: `load:${loadId}`, locatedAt: row.locatedAt } })).catch(() => {})
        pings += 1
      }
      const left = await breadcrumbs(ctx, loadId).catch(() => [])
      if (left.length) say(`${left.length} ping rows remain for load ${loadId}`, false)
    }
    say(`${pings} ZZ load-ping rows deleted`)
    let motive = 0
    for (const key of ctx.motiveRows) {
      await doc.send(new DeleteCommand({ TableName: history, Key: key })).catch(() => {})
      const left = (await doc.send(new GetCommand({ TableName: history, Key: key })).catch(() => ({ Item: {} }))).Item
      if (left) say(`Motive row ${key.locatedAt} NOT removed`, false)
      motive += 1
    }
    say(`${motive} ZZ Motive rows deleted`)
    for (const id of ctx.legIds) {
      await doc.send(new DeleteCommand({ TableName: devTable('LoadCarrier', ctx.suffix), Key: { id } })).catch(() => {})
      const left = (await doc.send(new GetCommand({ TableName: devTable('LoadCarrier', ctx.suffix), Key: { id } })).catch(() => ({ Item: {} }))).Item
      say(`SDK leg ${id} ${left ? 'NOT removed' : 'removed'}`, !left)
    }
  }
  if (ctx.truckId) {
    await gql(ctx.token, 'mutation($input: DeleteEquipmentInput!) { deleteEquipment(input: $input) { id } }', { input: { id: ctx.truckId } }).catch(() => {})
    const left = await getRow(ctx.token, 'Equipment', ctx.truckId, 'id').catch(() => null)
    say(`Equipment ${ctx.truckId} ${left ? 'NOT deleted' : 'deleted and confirmed gone'}`, !left)
  }
  for (const id of ctx.customerIds) {
    const row = await getRow(ctx.token, 'Customer', id, 'id updatedAt').catch(() => null)
    if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`customer ${id} archived`), (err) => say(`customer archive failed: ${short(err).slice(0, 80)}`, false))
  }
}

async function main() {
  if (flag('inventory')) { if (!(await inventory())) process.exitCode = 1; return }
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAO refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyAO refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAO only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)
  if (!(await inventory())) { process.exitCode = 1; return }

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const emails = { admin: `zz-ao-admin-${ts}@example.invalid`, tms: `zz-ao-tms-${ts}@example.invalid` }
  const made = []
  const ctx = {
    ts, origin, ids: {}, f: {}, memo: {}, owned: makeOwned(), shipmentIds: new Set(), customerIds: new Set(), legIds: new Set(),
    loadIds: new Set(), motiveRows: [], suffix: null,
  }
  try {
    ctx.suffix = await discoverDevSuffix().catch((err) => { console.log(`dev table suffix: ${short(err).slice(0, 100)}`); return null })
    ctx.ids.admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    ctx.ids.tms = await mintIdentity(emails.tms, ['page-tms']); made.push(emails.tms)
    console.log('identity: temporary staff identities created (admin, page-tms only)')
    ctx.token = ctx.ids.admin.token
    ctx.dir = routerAs(ctx.token, 'tmsDirectoryActions')
    ctx.ship = routerAs(ctx.token, 'tmsShipmentActions')
    ctx.trk = routerAs(ctx.token, 'tmsTrackingActions')
    if (!ctx.suffix) throw new Error('DynamoDB access is required for the leg fixtures (set AWS credentials)')
    await buildFixtures(ctx)
    for (const step of AO_STEPS) await runStep(ctx, step)
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
  main().catch((err) => { console.error(`devVerifyAO failed: ${err?.message ?? err}`); process.exit(1) })
}
