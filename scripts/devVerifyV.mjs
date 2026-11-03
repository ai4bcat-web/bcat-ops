#!/usr/bin/env node
/**
 * Step V verification against the DEV site (or `npm run dev` on localhost): the tracker assignee
 * (inherit / override / bulk), the Tracking table grouped by assignee, tracking automation
 * (RUN_TRACKING_AUTOMATION: off by default, quiet hours, NOT_SENT thread entries, POD once, reply
 * threading, the system-caller door, settings round-trip) and the V UI walk.
 *
 *   node scripts/devVerifyV.mjs [--inventory] [--only=<substring>] [--no-dark]
 *   DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyV.mjs
 *
 *   --inventory  no network, no browser: every V id is registered with a runner, and no script
 *                references an `inbox-*` test id (the Inbox UI is gone).
 *   --only=      run only the steps whose id contains the substring (fixtures are still created).
 *   --no-dark    skip the dark-theme pass.
 *
 * Never run concurrently with devVerifyP: P voids shared demo shipments (BUILD_LOG L261-264).
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool, any origin
 * outside ALLOWED_ORIGINS and any DynamoDB table that does not carry the discovered dev suffix (or that
 * carries the production one). The script touches no S3 bucket. Every identity and record it creates is
 * named zz-v-… / ZZ V …, tracked in sets, and removed or neutralised in `finally`; each removal is
 * re-read:
 *   - the temporary UserProfile rows (and the admin's own profile) are deleted through the guarded SDK;
 *   - customers are archived; shipments are VOIDED (never deleted: the PRO stays taken) with reason
 *     `step V verification fixture`; their ZZ leg / thread rows stay with the voided shipment (history);
 *   - TmsSettings.trackingAutomation / defaultCheckCallPlan are put back exactly as found.
 * The SDK writes (profiles, the carrier leg of a fixture shipment, the load status fallback) go through
 * `owned()`, which refuses any id this run did not create. Passwords and tokens are never printed.
 *
 * Engine note: dev has no Twilio and SES is denied, so every automated send ends NOT_SENT with the
 * provider error and the full body in the shipment thread. Global switches stay OFF on dev: automation
 * is only ever enabled on ZZ customers (and, for one step, a BROKERAGE division override that is put
 * back in `finally`).
 */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk, SHELL_FACTS, TOKEN_PROBE, shellFailures } from './lib/uiWalk.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const DEV_LAMBDA_PREFIX = 'amplify-d3dejqzs77khq6-de'
const SHOTS = resolve('Docs/tms-build/screenshots/V')
const REGION = 'us-east-1'
const VOID_REASON = 'step V verification fixture'
const SIGNATURE = '— BCAT Tracking Assistant'

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  // The dev Google Maps key is neutered, so Maps logs its own Map ID error; Google-owned, not an app defect.
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']
const SKIP_ALLOWED = {
  'V03-demo-rows': 'the demo seed is a shared prerequisite this script does not create (SEED_DEMO_DATA)',
  'V08b-system-caller': 'the tmsTrackingActions function name or lambda:InvokeFunction is not available to this shell',
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: SKIP_ALLOWED, only })
const { line, report, written, skipLine, problemList, audit, waitLoaded, setTheme, matches } = walk

// ───────────────────────────── step registry + completeness gates ─────────────────────────────
/** Every V id, in run order. `ui` steps need the browser; the rest are API-only. */
export const V_STEPS = [
  { id: 'V01', slug: 'inherit', ui: false },
  { id: 'V02', slug: 'override', ui: false },
  { id: 'V03', slug: 'table-grouping', ui: true },
  { id: 'V04', slug: 'automation-off-by-default', ui: false },
  { id: 'V05', slug: 'quiet-hours-defer', ui: false },
  { id: 'V06', slug: 'check-call-not-sent', ui: false },
  { id: 'V07', slug: 'pod-once', ui: false },
  { id: 'V08', slug: 'reply-threads', ui: false },
  { id: 'V09', slug: 'settings-round-trip', ui: false },
  { id: 'V10', slug: 'ui-walk', ui: true },
]

/** The Inbox UI is gone: no script may select one of its test ids. Built from parts so this file does not match itself. */
const INBOX_TESTID = new RegExp(['inbox', '-(?:chat|quick|info|status|driver|thread|conversation|composer|list)[a-z-]*'].join(''))

async function scriptFiles() {
  const out = []
  for (const dir of ['scripts', 'scripts/lib']) {
    for (const name of await readdir(resolve(dir))) if (/\.mjs$/.test(name)) out.push(join(dir, name))
  }
  return out
}

/** Gates 1 + 2 (no network). Returns true when both pass. */
export async function inventory() {
  const runners = Object.keys(RUNNERS)
  const registered = V_STEPS.map((s) => s.id)
  const missing = registered.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !registered.includes(id)))
  if (missing.length) { line('FAIL', 'gate 1: V ids registered', `registry and runners disagree on: ${missing.join(', ')}`); return false }
  line('PASS', 'gate 1: V ids registered', `${registered.length} steps (${registered.join(' ')}) each have a runner; skip-allowed: ${Object.keys(SKIP_ALLOWED).join(', ')}`)
  const offenders = []
  for (const file of await scriptFiles()) {
    const text = await readFile(resolve(file), 'utf8')
    const hit = text.split('\n').findIndex((l) => INBOX_TESTID.test(l))
    if (hit >= 0) offenders.push(`${file}:${hit + 1}`)
  }
  if (offenders.length) { line('FAIL', 'gate 2: no inbox test id in scripts', offenders.join('; ')); return false }
  line('PASS', 'gate 2: no inbox test id in scripts')
  return true
}

// ───────────────────────────── in-page text audit ─────────────────────────────
/** Serialised into the page. Returns failure strings. */
export function vAuditInPage() {
  const out = []
  const roots = [document.querySelector('.tms-main'), ...document.querySelectorAll('[role="dialog"]')].filter(Boolean)
  const BAD = /\b(NaN|Infinity|undefined|\[object Object\])\b/
  const NULL = /(^|[\s$(])null($|[\s).,])/
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim()
      if (!text) continue
      const el = n.parentElement
      if (!el || el.closest('script, style, noscript')) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      if (BAD.test(text) || NULL.test(text)) { out.push(`bad text "${text.slice(0, 60)}" in ${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`); if (out.length >= 3) return out }
    }
  }
  return out
}
const vAudit = async (b) => (await b.evaluate(`(${vAuditInPage})()`)).map((f) => `v: ${f}`)

// ───────────────────────────── browser helpers ─────────────────────────────
const mainText = (b) => b.evaluate(`document.querySelector('.tms-main')?.innerText ?? ''`)
const bodyText = (b) => b.evaluate(`document.body.innerText`)
const dialogCount = (b) => b.evaluate(`document.querySelectorAll('[role="dialog"]').length`)
const pathnameOf = (b) => b.evaluate('location.pathname + location.search')

/** Set a React-controlled input found by `selector`, firing the events React listens to. */
async function setValue(b, selector, value) {
  const hit = await b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no-element';
    if (el.disabled) return 'disabled';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`set ${selector}: ${hit}`)
}

/** Click the first element matching `selector` under `scope` whose text matches `pattern`. */
async function clickText(b, scope, selector, pattern) {
  const hit = await b.evaluate(`(() => {
    const spec = ${JSON.stringify({ scope, selector, pattern })};
    const root = spec.scope === 'dialog' ? [...document.querySelectorAll('[role="dialog"]')].pop()
      : spec.scope === 'main' ? document.querySelector('.tms-main') : document.querySelector(spec.scope);
    if (!root) return 'no-scope';
    const re = new RegExp(spec.pattern, 'i');
    const el = [...root.querySelectorAll(spec.selector)].find((n) => re.test(n.textContent.trim()));
    if (!el) return 'no-match';
    if (el.disabled) return 'disabled';
    el.scrollIntoView({ block: 'center' }); el.click(); return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`click ${scope} ${selector} /${pattern}/: ${hit}`)
}

async function snap(b, id, slug, theme, clip = true) {
  await walk.shot(b, id, slug, theme, clip).catch((e) => line('FAIL', `${id} ${theme}`, `screenshot failed: ${e.message}`))
}

/** Audit whatever is on screen now: problems, tokens, hook classes, shell parity, bad text. Throws on any failure. */
async function auditNow(b, theme, ref, { wideOk = true } = {}) {
  b.mark()
  await pause(500)
  const failures = [...problemList(b).slice(0, 3), ...await audit(b, theme, { wideOk }), ...await vAudit(b)]
  if (ref) {
    const f = await b.evaluate(SHELL_FACTS)
    const t = await b.evaluate(TOKEN_PROBE)
    failures.push(...shellFailures(f, t, ref, { legacyHost: false, scrollOk: true }))
  }
  if (failures.length) throw new Error(failures.slice(0, 3).join(' | '))
}

async function openPage(b, path, ready) {
  await b.navigate(path)
  await waitLoaded(b)
  if (ready) await b.poll(ready, `${path} ready`, 90_000)
}

// ───────────────────────────── safety + discovery ─────────────────────────────
const ddb = new DynamoDBClient({ region: REGION })
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })

async function discoverDevSuffix() {
  const suffix = process.env.DEV_TABLE_SUFFIX || 'nc3jsnxdmjhkpequimypiatkma-NONE'
  if (suffix === PROD_SUFFIX || suffix.includes(PROD_SUFFIX)) throw new Error('refusing the production table suffix')
  await ddb.send(new DescribeTableCommand({ TableName: `Load-${suffix}` })).catch(() => { throw new Error(`no Load-${suffix} table in the account`) })
  return suffix
}
function devTable(model, suffix) {
  const name = `${model}-${suffix}`
  if (!name.endsWith(`-${suffix}`) || name.includes(PROD_SUFFIX) || suffix === PROD_SUFFIX) throw new Error(`refusing non-dev table ${name}`)
  return name
}

// ───────────────────────────── small pure helpers ─────────────────────────────
const asJson = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return v } })() : v)
const nowIso = () => new Date().toISOString()
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())

/** `renderTemplate` from src/lib/trackingAutomation.ts (TS with extensionless imports cannot be loaded by node); the placeholder allow-list is read from that file so the two cannot drift. */
let placeholders = null
async function renderTemplate(text, vars) {
  if (!placeholders) {
    const src = await readFile(resolve('src/lib/trackingAutomation.ts'), 'utf8')
    const block = /TEMPLATE_PLACEHOLDERS\s*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? ''
    placeholders = new Set(block.match(/'[A-Za-z]+'/g)?.map((s) => s.slice(1, -1)) ?? [])
    if (placeholders.size < 10) throw new Error('could not read TEMPLATE_PLACEHOLDERS from src/lib/trackingAutomation.ts')
  }
  return text.replace(/\{([^{}]*)\}/g, (whole, name) => (placeholders.has(name) ? String(vars[name] ?? '') : whole))
}

/** checkCallAgent.stopPlace: "city, state" of the pickup / delivery stop of a Load's stops JSON. */
function stopPlace(stopsJson, type) {
  let stops = []
  try { stops = Array.isArray(stopsJson) ? stopsJson : JSON.parse(String(stopsJson ?? '[]')) } catch { stops = [] }
  const stop = stops.find((s) => s.type === type) ?? stops[type === 'pickup' ? 0 : stops.length - 1]
  return [stop?.city, stop?.state].filter((v) => typeof v === 'string' && v).join(', ')
}

const threadKeyFor = (shipmentId) => `tracking+${shipmentId}`
const replyAddress = (shipmentId) => `ai4bcat+tracking.${shipmentId}@gmail.com`

async function refused(name, pattern, run) {
  try { await run() } catch (err) {
    if (pattern.test(String(err?.message ?? err))) return String(err.message).slice(0, 120)
    throw new Error(`${name} refused for the wrong reason: ${String(err?.message ?? err).slice(0, 160)}`)
  }
  throw new Error(`${name} was allowed`)
}

const expect = (cond, message) => { if (!cond) throw new Error(message) }

// ───────────────────────────── API + fixtures ─────────────────────────────
const getRow = async (token, model, id, selection = 'id') => (await gql(token, `query($id: ID!) { get${model}(id: $id) { ${selection} } }`, { id }))[`get${model}`]

/** Ids this run created: the only ones the guarded SDK writers will touch. */
function makeOwned(ctx) {
  const ids = new Set()
  return {
    add: (id) => { ids.add(String(id)); return String(id) },
    has: (id) => ids.has(String(id)),
    assert: (model, id) => { if (!ids.has(String(id))) throw new Error(`refusing SDK write to ${model} ${id}: this run did not create it`) },
    ids,
    table: (model) => devTable(model, ctx.suffix),
  }
}

async function sdkPut(ctx, model, item) {
  ctx.owned.assert(model, item.id)
  await doc.send(new PutCommand({ TableName: ctx.owned.table(model), Item: { __typename: model, ...item } }))
}
async function sdkUpdate(ctx, model, id, set, values, names) {
  ctx.owned.assert(model, id)
  await doc.send(new UpdateCommand({
    TableName: ctx.owned.table(model), Key: { id },
    UpdateExpression: `SET ${Object.keys(set).map((k) => `#${k} = :${k}`).join(', ')}, #updatedAt = :updatedAt`,
    ExpressionAttributeNames: { ...Object.fromEntries(Object.keys(set).map((k) => [`#${k}`, k])), '#updatedAt': 'updatedAt', ...names },
    ExpressionAttributeValues: { ...Object.fromEntries(Object.entries(set).map(([k, v]) => [`:${k}`, v])), ':updatedAt': nowIso(), ...values },
  }))
}

const STOPS = (day) => [
  { type: 'pickup', name: 'ZZ V Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${day}T13:00:00.000Z` },
  { type: 'delivery', name: 'ZZ V Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${day}T21:00:00.000Z` },
]

const messagesOf = async (ctx, shipmentId) => (await ctx.trk('LIST_SHIPMENT_THREAD', { shipmentId })).messages ?? []
const outRows = (messages, kind) => messages.filter((m) => m.direction === 'OUT' && (!kind || m.kind === kind))
const automation = (ctx, shipmentId, mode = 'AUTO') => ctx.trk('RUN_TRACKING_AUTOMATION', { mode, shipmentIds: [shipmentId] })

async function createProfile(ctx, key, name, status) {
  const id = ctx.owned.add(`zz-v-trk-${key}-${ctx.ts}`)
  const at = nowIso()
  await sdkPut(ctx, 'UserProfile', {
    id, email: `${id}@example.invalid`, name, role: 'NONE', status, teamKeys: [], divisions: [],
    createdBy: 'zz-v', updatedBy: 'zz-v', version: 1, createdAt: at, updatedAt: at,
  })
  ctx.profileIds.add(id)
  return id
}

async function createCustomer(ctx, key, extra = {}) {
  const customer = await ctx.dir('UPSERT_CUSTOMER', {
    name: `ZZ V Customer ${key} ${ctx.ts}`, creditLimitCents: 100_000_000,
    contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ V Contact', email: `zz-v-${key.toLowerCase()}-${ctx.ts}@example.invalid`, types: [] }],
    billToParties: [{ id: `zz-v-bt-${key}-${ctx.ts}`, name: 'ZZ V Bill To', isDefault: false }],
    ...extra,
  })
  const id = String(customer.id)
  ctx.owned.add(id)
  ctx.customerIds.add(id)
  return { id, name: `ZZ V Customer ${key} ${ctx.ts}` }
}

async function createShipment(ctx, customerId) {
  const bundle = await ctx.ship('CREATE_SHIPMENT', { customerId, load: { stops: STOPS(today()) } })
  ctx.owned.add(bundle.shipment.id)
  ctx.shipmentIds.add(bundle.shipment.id)
  for (const load of bundle.loads ?? []) ctx.owned.add(load.id)
  return bundle
}

/** The ZZ carrier leg: kind CARRIER, ACTIVE, rate con SENT (the full SEND_RATE_CON chain needs a completed MCP packet and is not under test). */
async function attachSentLeg(ctx, bundle, label) {
  const load = bundle.loads[0]
  const id = ctx.owned.add(`lc-zzv-${ctx.ts}-${label}`)
  const at = nowIso()
  await sdkPut(ctx, 'LoadCarrier', {
    id, loadId: load.id, shipmentId: bundle.shipment.id, kind: 'CARRIER', status: 'ACTIVE', sequence: 1,
    carrierName: 'ZZ V Carrier', dispatcherName: 'ZZ V Dispatcher', dispatcherEmail: 'zz-v@example.invalid',
    driverName: 'ZZ V Driver', driverPhone: '+15555550100',
    rateConStatus: 'SENT', rateConSentAt: at, createdAt: at, updatedAt: at,
  })
  return id
}

/** Drive the Load through the app's own SET_LOAD_STATUS; fall back to a guarded SDK write when the app refuses a hop. Returns a note. */
async function driveLoad(ctx, bundle, target) {
  const path = target === 'DELIVERED'
    ? ['DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']
    : ['DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT']
  const loadId = bundle.loads[0].id
  for (const status of path) {
    const load = await getRow(ctx.token, 'Load', loadId, 'id status updatedAt')
    await ctx.ship('SET_LOAD_STATUS', { loadId, status, expectedUpdatedAt: String(load.updatedAt) }).catch(() => {})
  }
  let note = 'SET_LOAD_STATUS'
  const load = await getRow(ctx.token, 'Load', loadId, 'status')
  if (load.status !== target) {
    await sdkUpdate(ctx, 'Load', loadId, { status: target }, {}, {})
    note = `SDK fallback (app left the load at ${load.status})`
  }
  if (target === 'DELIVERED') {
    const shipment = await getRow(ctx.token, 'Shipment', bundle.shipment.id, 'status')
    if (shipment.status !== 'DELIVERED') {
      await sdkUpdate(ctx, 'Shipment', bundle.shipment.id, { status: 'DELIVERED' }, {}, {})
      note += `; shipment status written by SDK (was ${shipment.status})`
    }
  }
  return note
}

const setCustomerAutomation = (ctx, customerId, trackingAutomation) =>
  sdkUpdate(ctx, 'Customer', customerId, { trackingAutomation }, {}, {})

async function buildFixtures(ctx) {
  const F = ctx.f
  F.tA = await createProfile(ctx, 'a', 'ZZ V Tracker A', 'ACTIVE')
  F.tB = await createProfile(ctx, 'b', 'ZZ V Tracker B', 'ACTIVE')
  F.tX = await createProfile(ctx, 'x', 'ZZ V Tracker X', 'INACTIVE')
  // The ZZ admin is assigned a load in V03, and the tracker must be an active user profile.
  ctx.owned.add(ctx.adminUsername)
  const at = nowIso()
  await sdkPut(ctx, 'UserProfile', {
    id: ctx.adminUsername, email: ctx.emails.admin, name: 'ZZ V Admin', role: 'NONE', status: 'ACTIVE', teamKeys: [], divisions: [],
    createdBy: 'zz-v', updatedBy: 'zz-v', version: 1, createdAt: at, updatedAt: at,
  })
  ctx.profileIds.add(ctx.adminUsername)

  const automationA = {
    checkCallsAuto: true, podAuto: true, quietHours: { enabled: false },
    templates: { checkCallSms: 'ZZ {proNumber} {origin}→{destination} ETA? {trackingUrl}', podSms: 'ZZ POD {proNumber}' },
  }
  F.custA = await createCustomer(ctx, 'A', { defaultTrackerId: F.tA, trackingAutomation: automationA })
  F.custB = await createCustomer(ctx, 'B')
  F.custX = await createCustomer(ctx, 'X')
  // A default naming an inactive profile: set below the app (the directory would be free to refuse it).
  await sdkUpdate(ctx, 'Customer', F.custX.id, { defaultTrackerId: F.tX }, {}, {})
  F.custD = await createCustomer(ctx, 'D', { trackingAutomation: { podAuto: true, podChannels: ['EMAIL'], quietHours: { enabled: false } } })

  // Shipments. Sent legs: A (engine), B (off by default / division), M (My loads), P, D (POD). Unsent: U, O, V, X.
  F.sA = await createShipment(ctx, F.custA.id)
  F.sB = await createShipment(ctx, F.custB.id)
  F.sM = await createShipment(ctx, F.custB.id)
  F.sP = await createShipment(ctx, F.custA.id)
  F.sD = await createShipment(ctx, F.custD.id)
  F.sU = await createShipment(ctx, F.custA.id)
  F.sO = await createShipment(ctx, F.custA.id)
  F.sV = await createShipment(ctx, F.custB.id)
  F.sX = await createShipment(ctx, F.custX.id)
  F.legs = {}
  for (const [key, label] of [['sA', 'a'], ['sB', 'b'], ['sM', 'm'], ['sP', 'p'], ['sD', 'd']]) F.legs[key] = await attachSentLeg(ctx, F[key], label)
  F.notes = {}
  for (const key of ['sA', 'sB', 'sM']) F.notes[key] = await driveLoad(ctx, F[key], 'IN_TRANSIT')
  for (const key of ['sP', 'sD']) F.notes[key] = await driveLoad(ctx, F[key], 'DELIVERED')
  await ctx.ship('ASSIGN_TRACKER', { shipmentIds: [F.sM.shipment.id], trackerId: ctx.adminUsername })
  for (const key of ['sA', 'sB', 'sP', 'sD']) await ctx.trk('OPEN_SHIPMENT_THREAD', { shipmentId: F[key].shipment.id })
  console.log(`seeds: 4 profiles, 4 customers, ${ctx.shipmentIds.size} shipments (${Object.entries(F.notes).map(([k, v]) => `${k}: ${v}`).join('; ')})`)
}

const shipmentOf = (ctx, key) => ctx.f[key].shipment.id
const trackerOf = async (ctx, shipmentId) => (await getRow(ctx.token, 'Shipment', shipmentId, 'trackerId')).trackerId ?? null

async function auditChanges(token, entityId, action) {
  let next = null
  do {
    const r = await gql(token, `query($f: ModelAuditLogFilterInput, $n: String) { listAuditLogs(filter: $f, limit: 1000, nextToken: $n) { items { id entityId action user changes } nextToken } }`, { f: { entityId: { eq: entityId }, action: { eq: action } }, n: next })
    const rows = r.listAuditLogs.items
    if (rows.length) return rows.map((x) => ({ ...x, changes: asJson(x.changes) }))
    next = r.listAuditLogs.nextToken
  } while (next)
  return []
}

// ───────────────────────────── V01 – V09 (API) ─────────────────────────────
async function v01Inherit(ctx) {
  const F = ctx.f
  const a = await trackerOf(ctx, shipmentOf(ctx, 'sA'))
  expect(a === F.tA, `Customer A shipment tracker ${a}, expected ${F.tA}`)
  const b = await trackerOf(ctx, shipmentOf(ctx, 'sB'))
  expect(b === null, `Customer B (no default) shipment tracker ${b}, expected null`)
  const x = await trackerOf(ctx, shipmentOf(ctx, 'sX'))
  expect(x === null, `inactive default produced tracker ${x}, expected null`)
  const customerX = await getRow(ctx.token, 'Customer', F.custX.id, 'defaultTrackerId')
  expect(customerX.defaultTrackerId === F.tX, 'fixture error: customer X does not name the inactive default')
  return 'A → its default tracker; B → null; inactive default → null and the create still succeeded'
}

async function v02Override(ctx) {
  const F = ctx.f
  const id = shipmentOf(ctx, 'sO')
  const start = await trackerOf(ctx, id)
  expect(start === F.tA, `fixture O starts with ${start}, expected ${F.tA}`)
  let r = await ctx.ship('ASSIGN_TRACKER', { shipmentIds: [id], trackerId: F.tB })
  expect(r.updated.length === 1 && r.skipped.length === 0, `ASSIGN_TRACKER answered ${JSON.stringify(r)}`)
  expect((await trackerOf(ctx, id)) === F.tB, 'tracker did not become B')
  let audits = []
  await ctx.poll(async () => (audits = await auditChanges(ctx.token, id, 'ASSIGN_TRACKER')).length > 0, 'ASSIGN_TRACKER audit row', 30_000)
  const change = audits.map((x) => x.changes).find((c) => c?.to === F.tB)
  expect(change && change.from === F.tA, `audit row does not read from ${F.tA} to ${F.tB}: ${JSON.stringify(audits.map((x) => x.changes))}`)
  // A customer change must not overwrite a tracker already set (the default only fills a blank).
  await ctx.ship('REPOINT_SHIPMENT_CUSTOMER', { shipmentId: id, customerId: F.custB.id, reason: VOID_REASON, expectedUpdatedAt: String((await getRow(ctx.token, 'Shipment', id, 'updatedAt')).updatedAt) })
  expect((await trackerOf(ctx, id)) === F.tB, 'repointing the customer overwrote the override')
  r = await ctx.ship('ASSIGN_TRACKER', { shipmentIds: [id], trackerId: null })
  expect(r.updated.length === 1 && (await trackerOf(ctx, id)) === null, 'null did not clear the tracker')
  await refused('inactive tracker', /not an active user profile/i, async () => {
    const res = await ctx.ship('ASSIGN_TRACKER', { shipmentIds: [id], trackerId: F.tX })
    if (res.skipped?.[0]?.reason) throw new Error(res.skipped[0].reason)
  })
  // a voided shipment: voided now, so V cleanup has nothing left to do for it
  const v = shipmentOf(ctx, 'sV')
  const row = await getRow(ctx.token, 'Shipment', v, 'updatedAt')
  await ctx.ship('VOID_SHIPMENT', { shipmentId: v, reason: VOID_REASON, expectedUpdatedAt: String(row.updatedAt) })
  r = await ctx.ship('ASSIGN_TRACKER', { shipmentIds: [v], trackerId: F.tA })
  expect(r.updated.length === 0 && /voided/i.test(r.skipped?.[0]?.reason ?? ''), `voided shipment answered ${JSON.stringify(r)}`)
  r = await ctx.ship('ASSIGN_TRACKER', { shipmentIds: [shipmentOf(ctx, 'sO'), shipmentOf(ctx, 'sU'), v], trackerId: F.tB })
  expect(r.updated.length === 2 && r.skipped.length === 1, `bulk of 3 with 1 voided answered updated ${r.updated.length} / skipped ${r.skipped.length}`)
  // settle the tail state the UI steps rely on: U back on A (its customer default)
  await ctx.ship('ASSIGN_TRACKER', { shipmentIds: [shipmentOf(ctx, 'sU'), shipmentOf(ctx, 'sO')], trackerId: F.tA })
  return 'assign + audit {from:a,to:b}; customer change keeps it; null clears; inactive and voided refused with reasons; bulk 3 → updated 2, skipped 1'
}

async function v04OffByDefault(ctx) {
  const id = shipmentOf(ctx, 'sB')
  const before = await messagesOf(ctx, id)
  const r = await automation(ctx, id)
  expect(r.mode === 'AUTO' && r.acted === 0, `AUTO on a customer with no automation acted ${r.acted}`)
  expect(r.errors === 0, `run reported ${r.errors} errors: ${(r.reasons ?? []).join('; ').slice(0, 160)}`)
  const after = await messagesOf(ctx, id)
  expect(after.length === before.length, `${after.length - before.length} new ShipmentMessage rows were written`)
  return `acted 0, ${r.skipped} skipped (${(r.reasons ?? [])[0] ?? 'no reason'}), thread unchanged (${after.length} rows)`
}

async function v05QuietHours(ctx) {
  const F = ctx.f
  const id = shipmentOf(ctx, 'sA')
  const parts = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
    return `${p.hour}:${p.minute}`
  }
  const now = Date.now()
  const quiet = { enabled: true, start: parts(now - 3_600_000), end: parts(now + 3_600_000), timezone: 'America/Chicago', channels: ['SMS', 'EMAIL'] }
  const base = { checkCallsAuto: true, podAuto: true, templates: { checkCallSms: 'ZZ {proNumber} {origin}→{destination} ETA? {trackingUrl}', podSms: 'ZZ POD {proNumber}' } }
  const load = F.sA.loads[0].id
  try {
    await setCustomerAutomation(ctx, F.custA.id, { ...base, quietHours: quiet })
    const loadBefore = await getRow(ctx.token, 'Load', load, 'nextCheckCallAt lastCheckCallAt')
    const before = await messagesOf(ctx, id)
    const r = await automation(ctx, id)
    expect(r.deferred >= 1, `deferred ${r.deferred} inside the quiet window ${quiet.start}-${quiet.end} (acted ${r.acted}, reasons ${(r.reasons ?? []).join('; ').slice(0, 120)})`)
    const after = await messagesOf(ctx, id)
    expect(after.length === before.length, `${after.length - before.length} rows written inside quiet hours`)
    const loadAfter = await getRow(ctx.token, 'Load', load, 'nextCheckCallAt lastCheckCallAt')
    expect(loadAfter.nextCheckCallAt === loadBefore.nextCheckCallAt && loadAfter.lastCheckCallAt === loadBefore.lastCheckCallAt, 'a deferred tick moved nextCheckCallAt / lastCheckCallAt')
    return `window ${quiet.start}–${quiet.end} Chicago: deferred ${r.deferred}, zero rows, nextCheckCallAt unchanged`
  } finally {
    await setCustomerAutomation(ctx, F.custA.id, { ...base, quietHours: { enabled: false } })
  }
}

async function v06CheckCall(ctx) {
  const F = ctx.f
  const id = shipmentOf(ctx, 'sA')
  const before = outRows(await messagesOf(ctx, id), 'CHECK_CALL')
  const r = await automation(ctx, id)
  expect(r.checked >= 1 && r.errors === 0, `run checked ${r.checked}, errors ${r.errors}: ${(r.reasons ?? []).join('; ').slice(0, 160)}`)
  const rows = outRows(await messagesOf(ctx, id), 'CHECK_CALL').filter((m) => !before.some((b) => b.id === m.id))
  const sms = rows.filter((m) => m.channel === 'SMS')
  const email = rows.filter((m) => m.channel === 'EMAIL')
  expect(sms.length === 1 && email.length === 1, `expected one SMS and one EMAIL CHECK_CALL row, got ${sms.length} SMS / ${email.length} EMAIL`)
  const load = await getRow(ctx.token, 'Load', F.sA.loads[0].id, 'stops')
  const shipment = await getRow(ctx.token, 'Shipment', id, 'number')
  const rendered = await renderTemplate('ZZ {proNumber} {origin}→{destination} ETA? {trackingUrl}', {
    proNumber: shipment.number, origin: stopPlace(load.stops, 'pickup'), destination: stopPlace(load.stops, 'delivery'), trackingUrl: '',
  })
  const expected = `${rendered.trim()}\n\n${SIGNATURE}`
  for (const m of [...sms, ...email]) {
    expect(m.status === 'NOT_SENT', `${m.channel} row status ${m.status}, expected NOT_SENT`)
    expect(String(m.error ?? '').trim().length > 0, `${m.channel} row has no provider error`)
    expect(m.threadKey === threadKeyFor(id), `${m.channel} row threadKey ${m.threadKey}`)
    expect(String(m.body ?? '').trim() === expected, `${m.channel} body ${JSON.stringify(String(m.body).slice(0, 90))} != ${JSON.stringify(expected.slice(0, 90))}`)
  }
  expect(sms[0].to === '+15555550100' && email[0].to === 'zz-v@example.invalid', 'rows are not addressed to the leg driver phone / dispatcher e-mail')
  return `SMS + EMAIL rows NOT_SENT with errors, body = template + signature, thread ${threadKeyFor(id)}`
}

/** The plan's V06 contract: an immediate second run adds no row (cadence not due). */
async function v06bSecondRun(ctx) {
  const id = shipmentOf(ctx, 'sA')
  const before = outRows(await messagesOf(ctx, id), 'CHECK_CALL')
  expect(before.length >= 2, 'V06 has not produced the first rows (run V06 first)')
  const r = await automation(ctx, id)
  const after = outRows(await messagesOf(ctx, id), 'CHECK_CALL')
  expect(after.length === before.length, `a second immediate run added ${after.length - before.length} CHECK_CALL rows (reasons: ${(r.reasons ?? []).join('; ').slice(0, 100)}) — a NOT_SENT outcome never advances lastCheckCallAt, so the cadence stays due`)
  return 'cadence not due: no new rows'
}

async function v07Pod(ctx) {
  const F = ctx.f
  const id = shipmentOf(ctx, 'sP')
  const leg = F.legs.sP
  const shipment = await getRow(ctx.token, 'Shipment', id, 'status number')
  expect(shipment.status === 'DELIVERED', `POD fixture is ${shipment.status}, not DELIVERED`)
  await automation(ctx, id)
  const pods = (await messagesOf(ctx, id)).filter((m) => m.kind === 'POD_REQUEST')
  expect(pods.length === 2, `expected two POD_REQUEST rows, got ${pods.length}`)
  expect(pods.map((m) => m.id).sort().join() === [`auto:pod:${leg}:EMAIL`, `auto:pod:${leg}:SMS`].sort().join(), `POD ids ${pods.map((m) => m.id).join(', ')}`)
  for (const m of pods) expect(m.status === 'NOT_SENT', `${m.channel} POD row ${m.status}`)
  const sms = pods.find((m) => m.channel === 'SMS')
  expect(String(sms.body).trim() === `ZZ POD ${shipment.number}\n\n${SIGNATURE}`, `POD SMS body ${JSON.stringify(String(sms.body).slice(0, 80))}`)
  await automation(ctx, id)
  const again = (await messagesOf(ctx, id)).filter((m) => m.kind === 'POD_REQUEST')
  expect(again.length === 2, `a rerun produced ${again.length} POD rows`)
  const lc = await getRow(ctx.token, 'LoadCarrier', leg, 'podRequestedAt')
  expect(Boolean(lc.podRequestedAt), 'LoadCarrier.podRequestedAt was not set')
  // channel override: Customer D asks by e-mail only
  const d = shipmentOf(ctx, 'sD')
  expect((await getRow(ctx.token, 'Shipment', d, 'status')).status === 'DELIVERED', 'POD fixture D is not DELIVERED')
  await automation(ctx, d)
  const dPods = (await messagesOf(ctx, d)).filter((m) => m.kind === 'POD_REQUEST')
  expect(dPods.length === 1 && dPods[0].channel === 'EMAIL' && dPods[0].id === `auto:pod:${F.legs.sD}:EMAIL`, `podChannels ['EMAIL'] produced ${dPods.map((m) => `${m.channel}:${m.id}`).join(', ') || 'no rows'}`)
  return 'two POD rows (SMS + EMAIL) once, template text, podRequestedAt set; EMAIL-only override → one row'
}

async function v08Replies(ctx) {
  const id = shipmentOf(ctx, 'sA')
  const messageId = `<zz-v-reply-${ctx.ts}@example.invalid>`
  const r = await ctx.trk('INGEST_SHIPMENT_MESSAGE', { messageId, channel: 'EMAIL', from: 'zz-v@example.invalid', to: replyAddress(id), subject: 'Re: ZZ V check call', body: 'ZZ V reply, no location' })
  expect(r.routed === true, `reply was not routed: ${r.reason ?? JSON.stringify(r).slice(0, 120)}`)
  const row = (await messagesOf(ctx, id)).find((m) => m.messageId === messageId)
  expect(row && row.direction === 'IN' && row.status === 'RECEIVED' && row.threadKey === threadKeyFor(id), `inbound row ${JSON.stringify(row && { d: row.direction, s: row.status, t: row.threadKey })}`)
  return 'reply to the plus address routed onto the shipment thread (IN / RECEIVED, same threadKey)'
}

let trackingLambda = null
async function trackingFunctionName() {
  if (trackingLambda) return trackingLambda
  const { LambdaClient, ListFunctionsCommand } = await import('@aws-sdk/client-lambda')
  const lambda = new LambdaClient({ region: REGION })
  let marker
  do {
    const r = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }))
    for (const f of r.Functions ?? []) {
      if (f.FunctionName?.startsWith(DEV_LAMBDA_PREFIX) && /tmstrackingactions/i.test(f.FunctionName)) { trackingLambda = { lambda, name: f.FunctionName }; return trackingLambda }
    }
    marker = r.NextMarker
  } while (marker)
  throw new Error('no dev tmsTrackingActions function found')
}

async function invokeSystem(systemCaller, action, input) {
  const { InvokeCommand } = await import('@aws-sdk/client-lambda')
  const { lambda, name } = await trackingFunctionName()
  const res = await lambda.send(new InvokeCommand({ FunctionName: name, Payload: Buffer.from(JSON.stringify({ arguments: { action, input: JSON.stringify(input) }, systemCaller })) }))
  const text = Buffer.from(res.Payload ?? []).toString('utf8')
  return { error: res.FunctionError ? text : null, body: res.FunctionError ? null : asJson(asJson(text)) }
}

async function v08bSystemCaller(ctx) {
  const id = shipmentOf(ctx, 'sA')
  const messageId = `<zz-v-system-${ctx.ts}@example.invalid>`
  let ok
  try {
    ok = await invokeSystem('shipment-email-intake', 'INGEST_SHIPMENT_MESSAGE', { messageId, channel: 'EMAIL', from: 'zz-v@example.invalid', to: replyAddress(id), subject: 'Re: ZZ V system', body: 'ZZ V system reply' })
  } catch (err) {
    throw new SkipError(`${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 100)}`)
  }
  expect(!ok.error && ok.body?.routed === true, `system caller ingest answered ${ok.error ?? JSON.stringify(ok.body).slice(0, 120)}`)
  expect((await messagesOf(ctx, id)).some((m) => m.messageId === messageId && m.direction === 'IN'), 'system-caller reply is not on the thread')
  const bad = await invokeSystem('shipment-email-intake', 'RUN_TRACKING_AUTOMATION', { mode: 'AUTO', shipmentIds: [id] })
  expect(bad.error && /unauthorized|identity/i.test(bad.error), `an unlisted action was not refused: ${(bad.error ?? JSON.stringify(bad.body)).slice(0, 140)}`)
  return 'shipment-email-intake may ingest a reply; RUN_TRACKING_AUTOMATION through it is refused'
}

async function readSettings(ctx) {
  const r = await doc.send(new GetCommand({ TableName: ctx.owned.table('TmsSettings'), Key: { id: 'default' } }))
  return r.Item ?? null
}

async function restoreSettings(ctx) {
  const original = ctx.settingsBefore
  if (!original) return
  const names = { '#a': 'trackingAutomation', '#p': 'defaultCheckCallPlan', '#u': 'updatedAt' }
  const sets = []
  const removes = []
  const values = { ':u': original.updatedAt }
  if (original.trackingAutomation === undefined) removes.push('#a'); else { sets.push('#a = :a'); values[':a'] = original.trackingAutomation }
  if (original.defaultCheckCallPlan === undefined) removes.push('#p'); else { sets.push('#p = :p'); values[':p'] = original.defaultCheckCallPlan }
  sets.push('#u = :u')
  const expression = `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`
  await doc.send(new UpdateCommand({ TableName: ctx.owned.table('TmsSettings'), Key: { id: 'default' }, UpdateExpression: expression, ExpressionAttributeNames: names, ExpressionAttributeValues: values }))
  const back = await readSettings(ctx)
  const same = JSON.stringify(back?.trackingAutomation ?? null) === JSON.stringify(original.trackingAutomation ?? null)
    && JSON.stringify(back?.defaultCheckCallPlan ?? null) === JSON.stringify(original.defaultCheckCallPlan ?? null)
  console.log(`cleanup: TmsSettings trackingAutomation / defaultCheckCallPlan ${same ? 'restored and confirmed' : 'NOT confirmed restored'}`)
  if (!same) process.exitCode = 1
}

async function v09Settings(ctx) {
  const F = ctx.f
  const id = shipmentOf(ctx, 'sB')
  const current = (await getRow(ctx.token, 'TmsSettings', 'default', 'updatedAt')) ?? {}
  const blob = {
    global: { podChannels: ['SMS', 'EMAIL'] },
    divisions: { BROKERAGE: { policy: { checkCallsAuto: true, quietHours: { enabled: false }, templates: { checkCallSms: 'ZZ DIV {proNumber}' } } } },
  }
  await refused('unknown placeholder', /unknown placeholder/i, () => ctx.trk('SAVE_TRACKING_AUTOMATION', { trackingAutomation: { global: { templates: { checkCallSms: 'ZZ {nope}' } }, divisions: {} } }))
  await ctx.trk('SAVE_TRACKING_AUTOMATION', { trackingAutomation: blob, expectedUpdatedAt: current.updatedAt })
  const stored = asJson((await getRow(ctx.token, 'TmsSettings', 'default', 'trackingAutomation')).trackingAutomation)
  expect(stored?.divisions?.BROKERAGE?.policy?.checkCallsAuto === true && stored.divisions.BROKERAGE.policy.templates?.checkCallSms === 'ZZ DIV {proNumber}', `GET does not return the division override: ${JSON.stringify(stored).slice(0, 160)}`)
  expect(JSON.stringify(stored.global?.podChannels) === JSON.stringify(['SMS', 'EMAIL']), 'GET does not return the global patch')
  // a shipment hand-tagged BROKERAGE, no customer override, resolves the division value
  await ctx.ship('SET_REV_TAG', { shipmentId: id, divisionCode: 'BROKERAGE' })
  const tagged = await getRow(ctx.token, 'Shipment', id, 'revDivision number')
  expect(tagged.revDivision === 'BROKERAGE', `shipment tagged ${tagged.revDivision}`)
  const before = outRows(await messagesOf(ctx, id), 'CHECK_CALL')
  const r = await automation(ctx, id)
  expect(r.errors === 0, `division run errored: ${(r.reasons ?? []).join('; ').slice(0, 140)}`)
  const rows = outRows(await messagesOf(ctx, id), 'CHECK_CALL').filter((m) => !before.some((b) => b.id === m.id) && m.channel === 'SMS')
  expect(rows.length >= 1, `the BROKERAGE division policy produced no SMS row (acted ${r.acted}, skipped ${r.skipped}: ${(r.reasons ?? []).join('; ').slice(0, 100)})`)
  expect(String(rows[0].body).trim().startsWith(`ZZ DIV ${tagged.number}`), `division template not used: ${JSON.stringify(String(rows[0].body).slice(0, 80))}`)
  return 'unknown placeholder refused; division + global stored and returned; BROKERAGE-tagged shipment sends the division template'
}

// ───────────────────────────── V03 / V10 (browser) ─────────────────────────────
const trackingSnapshot = (b) => b.evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[data-testid="tracking-assignee-tabs"] [role="tab"]')].map((t) => ({
    label: [...t.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(),
    count: Number(t.querySelector('.tms-seg-count')?.textContent ?? NaN), selected: t.getAttribute('aria-selected') === 'true' }));
  const more = [...document.querySelectorAll('select[aria-label="More assignees"] option')].map((o) => o.textContent.trim());
  const groups = [...document.querySelectorAll('[data-testid="tracking-group"]')].map((g) => ({ key: g.dataset.groupKey, label: g.getAttribute('aria-label') ?? '' }));
  const rows = [...document.querySelectorAll('[data-testid="tracking-row"]')].map((r) => ({ id: r.dataset.shipmentId, tracker: r.dataset.trackerId ?? '' }));
  return { tabs, more, groups, rows, empty: !!document.querySelector('[data-testid="tracking-empty"]') };
})()`)
const groupCount = (g) => Number(/—\s*(\d+)\s+shipment/.exec(g.label)?.[1] ?? NaN)

async function waitTracking(b, ids) {
  await b.poll(async () => {
    const s = await trackingSnapshot(b)
    return ids.every((id) => s.rows.some((r) => r.id === id))
  }, `tracking rows ${ids.length}`, 120_000)
}

async function v03Table(b, ctx, theme, ref) {
  const F = ctx.f
  const sent = ['sA', 'sB', 'sM'].map((k) => shipmentOf(ctx, k))
  const hidden = { unsent: ['sU', 'sO', 'sX'].map((k) => shipmentOf(ctx, k)), closedLifecycle: ['sP', 'sD'].map((k) => shipmentOf(ctx, k)) }
  const light = theme === 'light'
  await step(`V03-all-${theme}`, async () => {
    await openPage(b, '/tms/tracking?assignee=all')
    await waitTracking(b, sent)
    const s = await trackingSnapshot(b)
    for (const id of [...hidden.unsent, ...hidden.closedLifecycle]) expect(!s.rows.some((r) => r.id === id), `shipment ${id} is listed but is not an active rate-con-sent row`)
    expect(!s.empty, 'the empty state is shown next to rows')
    const all = s.tabs.find((t) => t.label === 'All')
    const unassigned = s.tabs.find((t) => /^Unassigned/.test(t.label))
    expect(all && unassigned, `tab strip lacks All / Unassigned: ${JSON.stringify(s.tabs.map((t) => t.label))}`)
    expect(unassigned.count >= 1, 'Unassigned tab counts 0 although fixture B has no tracker')
    const sum = s.groups.reduce((n, g) => n + groupCount(g), 0)
    expect(sum === all.count, `sections add up to ${sum}, All tab says ${all.count}`)
    expect(s.groups[0]?.key === 'unassigned', `first section is ${s.groups[0]?.key}, expected unassigned`)
    expect(s.tabs.some((t) => t.label === 'My loads' && t.count === 1), `My loads tab ${JSON.stringify(s.tabs.find((t) => t.label === 'My loads'))}`)
    const trackerA = s.groups.find((g) => g.key === F.tA)
    expect(trackerA && /ZZ V Tracker A/.test(trackerA.label) && groupCount(trackerA) === 1, `tracker A section ${JSON.stringify(trackerA)}`)
    expect(s.rows.find((r) => r.id === shipmentOf(ctx, 'sA'))?.tracker === F.tA, 'row data-tracker-id is not tracker A')
    await auditNow(b, theme, ref)
    await snap(b, 'V03', 'tracking-by-assignee-all', theme)
    return `${sent.length} ZZ rows listed; unsent / closed ZZ shipments absent; sections sum to All (${all.count})`
  })
  await step(`V03-assignee-link-${theme}`, async () => {
    await openPage(b, `/tms/tracking?assignee=${encodeURIComponent(F.tA)}`)
    await waitTracking(b, [shipmentOf(ctx, 'sA')])
    const s = await trackingSnapshot(b)
    expect(s.groups.length === 1 && s.groups[0].key === F.tA, `deep link shows sections ${JSON.stringify(s.groups.map((g) => g.key))}`)
    expect(s.rows.every((r) => r.tracker === F.tA), 'deep link lists a row of another tracker')
    expect(s.tabs.some((t) => t.selected && /ZZ V Tracker A/.test(t.label)) || s.more.some((o) => /ZZ V Tracker A/.test(o)), 'tracker A has neither a tab nor an overflow entry')
    return '?assignee=<id> lands on that tracker only'
  })
  await step(`V03-my-loads-${theme}`, async () => {
    await openPage(b, '/tms/tracking')
    await waitTracking(b, [shipmentOf(ctx, 'sM')])
    const s = await trackingSnapshot(b)
    expect(s.tabs.some((t) => t.label === 'My loads' && t.selected), `default tab is not My loads: ${JSON.stringify(s.tabs.filter((t) => t.selected))}`)
    expect(s.rows.length === 1 && s.rows[0].id === shipmentOf(ctx, 'sM'), `My loads lists ${s.rows.length} rows`)
    await snap(b, 'V03', 'tracking-my-loads', theme)
    return 'the assigned ZZ admin lands on My loads with exactly their load'
  })
  if (!light) return
  await step('V03-row-menu', async () => {
    await openPage(b, '/tms/tracking?assignee=all')
    await waitTracking(b, [shipmentOf(ctx, 'sM')])
    const rect = await b.evaluate(`(() => { const row = document.querySelector('[data-testid="tracking-row"][data-shipment-id="${shipmentOf(ctx, 'sM')}"]'); const btn = row?.querySelector('button[aria-label="Row actions"]'); if (!btn) return null; btn.scrollIntoView({ block: 'center' }); const r = btn.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    expect(rect, 'the row has no Row actions button')
    await b.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
    await pause(400)
    const text = await b.evaluate(`(() => { const m = document.querySelector('[data-testid="tracking-row"][data-shipment-id="${shipmentOf(ctx, 'sM')}"] .tms-tracking-rowmenu-menu'); return m && getComputedStyle(m).display !== 'none' ? m.innerText : null })()`)
    expect(text, 'the row menu does not open on hover')
    for (const label of ['Request check call', 'Request POD', 'Assign tracker']) expect(text.includes(label), `row menu lacks "${label}"`)
    await snap(b, 'V03', 'tracking-row-menu', theme, false)
    return 'Request check call / Request POD / Assign tracker present'
  })
  await step('V03-legacy-inbox-link', async () => {
    await b.navigate(`/tms/tracking?tab=inbox&shipment=${shipmentOf(ctx, 'sA')}`)
    let landed = ''
    await b.poll(async () => { landed = await pathnameOf(b); return landed.startsWith(`/tms/shipments/${shipmentOf(ctx, 'sA')}`) }, 'redirect to the shipment', 30_000).catch(() => { throw new Error(`landed on ${landed}`) })
    expect(/tab=tracking/.test(landed), `landed on ${landed} without tab=tracking`)
    return `→ ${landed}`
  })
  await step('V03-demo-rows', async () => {
    const state = await ctx.ship('GET_DEMO_STATE', {}).catch(() => null)
    if (!state?.seedVersion) { skipLine('V03-demo-rows', '', 'demo seed absent'); return undefined }
    await openPage(b, '/tms/tracking?assignee=all')
    await b.poll(async () => (await trackingSnapshot(b)).rows.length > 0, 'tracking rows', 90_000)
    const s = await trackingSnapshot(b)
    const demo = s.rows.filter((r) => !ctx.shipmentIds.has(r.id))
    expect(demo.length >= 1, 'the demo seed is present but no non-ZZ rate-con-sent row is listed')
    return `${demo.length} demo rows listed beside the ZZ rows`
  })
}

/** V10 pages: each opens a page, asserts its hooks, audits and screenshots it. */
async function v10Walk(b, ctx, theme, ref) {
  const F = ctx.f
  await step(`V10-tracker-card-${theme}`, async () => {
    await openPage(b, `/tms/shipments/${shipmentOf(ctx, 'sA')}`, () => b.evaluate(`!!document.querySelector('[data-testid="tracker-card"]')`))
    const inherited = await b.evaluate(`document.querySelector('[data-testid="tracker-inherited"]')?.innerText ?? null`)
    expect(inherited && inherited.includes(F.custA.name), `tracker card says ${JSON.stringify(inherited)}, expected "Inherited from ${F.custA.name}"`)
    await auditNow(b, theme, ref)
    await snap(b, 'V10', 'shipment-tracker-card', theme)
    return 'Tracker card shows "Inherited from <customer>"'
  })
  await step(`V10-customer-default-${theme}`, async () => {
    await openPage(b, '/tms/customers')
    await setValue(b, 'input[placeholder="Search customers"]', F.custA.name)
    await b.poll(() => b.evaluate(`[...document.querySelectorAll('.tms-main tbody tr')].some((r) => r.textContent.includes(${JSON.stringify(F.custA.name)}))`), 'customer row', 30_000)
    await b.evaluate(`[...document.querySelectorAll('.tms-main tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(F.custA.name)})).click()`)
    await b.poll(() => b.evaluate(`[...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent.trim() === 'Settings')`), 'profile tabs', 30_000)
    await clickText(b, 'body', '[role="tab"]', '^Settings$')
    await b.poll(async () => /Default tracker/.test(await bodyText(b)), 'Default tracker field', 20_000)
    expect(await b.evaluate(`!!document.querySelector('[data-testid="automation-editor-customer"]')`), 'the customer automation editor is not rendered')
    await auditNow(b, theme, null)
    await snap(b, 'V10', 'customer-default-tracker', theme)
    return 'profile Settings tab: Default tracker + the customer automation editor'
  })
  for (const [tab, label] of [['defaults', 'Defaults'], ['divisions', 'Divisions'], ['customers', 'Customers']]) {
    await step(`V10-settings-${tab}-${theme}`, async () => {
      await openPage(b, '/tms/brokerage', () => b.evaluate(`!!document.querySelector('[aria-label="Tracking automation sections"]')`))
      await b.evaluate(`document.querySelector('[aria-label="Tracking automation sections"]').scrollIntoView({ block: 'start' })`)
      await clickText(b, 'body', '[aria-label="Tracking automation sections"] [role="tab"]', `^${label}$`)
      await pause(500)
      if (tab === 'defaults') {
        expect(await b.evaluate(`document.querySelectorAll('[data-testid^="automation-editor-"]').length >= 1`), 'no automation editor on Defaults')
        expect(await b.evaluate(`document.querySelectorAll('[data-testid^="template-"]').length >= 6 && document.querySelectorAll('[data-testid^="preview-"]').length >= 6`), 'Defaults lacks six templates with a live preview')
        expect(/Nothing is delivered from here/.test(await bodyText(b)), 'the dev NOT_SENT notice is missing')
      } else if (tab === 'divisions') {
        expect(await b.evaluate(`document.querySelectorAll('[data-testid^="division-row-"]').length >= 1`), 'no division rows')
      } else {
        await b.poll(() => b.evaluate(`!!document.querySelector('[data-testid="customer-override-${F.custA.id}"]')`), 'customer A override row', 30_000)
        expect(await b.evaluate(`!document.querySelector('[data-testid="customer-override-${F.custB.id}"]')`), 'customer B (no override) is listed as overridden')
      }
      await auditNow(b, theme, ref)
      await snap(b, 'V10', `settings-automation-${tab}`, theme)
      return `${label} sub-tab renders`
    })
  }
  await step(`V10-thread-automation-${theme}`, async () => {
    await openPage(b, `/tms/shipments/${shipmentOf(ctx, 'sA')}?tab=tracking`, () => b.evaluate(`!!document.querySelector('[data-testid="tracking-thread"]')`))
    await b.poll(() => b.evaluate(`document.querySelectorAll('[data-testid="not-sent-body"]').length >= 1`), 'automated NOT_SENT entries', 60_000)
    const text = await b.evaluate(`document.querySelector('[data-testid="tracking-thread"]').innerText`)
    expect(/not sent/i.test(text) && /Would have sent/i.test(text), 'the thread does not show the NOT_SENT badge / would-have-sent text')
    expect(/ZZ /.test(text), 'the automated template text is not in the thread')
    await auditNow(b, theme, null)
    await snap(b, 'V10', 'shipment-thread-automation', theme)
    return 'automated check-call rows show NOT_SENT with the would-have-sent body'
  })
}

async function phonePass(b, ctx) {
  await b.command('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await b.setViewport(390, 844, 2)
  await step('V10-mobile-tracking', async () => {
    await openPage(b, '/tms/tracking?assignee=all')
    await waitTracking(b, [shipmentOf(ctx, 'sA')])
    b.mark(); await pause(700)
    const failures = [...problemList(b).slice(0, 3), ...await audit(b, 'light', { wideOk: true }), ...await vAudit(b)]
    const overflow = await b.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    if (overflow > 1) failures.push(`horizontal overflow ${overflow}px`)
    if (failures.length) throw new Error(failures.slice(0, 3).join(' | '))
    await walk.shot(b, 'V10', 'mobile-tracking', 'M', false)
    return 'no horizontal overflow at 390×844'
  })
  await b.setViewport(1600, 1000, 1)
}

// ───────────────────────────── runners ─────────────────────────────
const RUNNERS = {
  V01: v01Inherit,
  V02: v02Override,
  V03: v03Table,
  V04: v04OffByDefault,
  V05: v05QuietHours,
  V06: v06CheckCall,
  V07: v07Pod,
  V08: v08Replies,
  V09: v09Settings,
  V10: v10Walk,
}

/** Thrown by a step whose prerequisite the shell cannot provide; reported as an allowed SKIP, never a pass. */
class SkipError extends Error {}

async function step(id, fn) {
  if (!matches(id)) return undefined
  try {
    const detail = await fn()
    if (detail !== undefined) line('PASS', id, typeof detail === 'string' ? detail : undefined)
    return detail
  } catch (err) {
    if (err instanceof SkipError) { skipLine(id, '', err.message); return undefined }
    line('FAIL', id, String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300))
    return undefined
  }
}

async function apiSteps(ctx) {
  for (const { id, slug, ui } of V_STEPS) {
    if (ui) continue
    await step(`${id}-${slug}`, () => RUNNERS[id](ctx))
    if (id === 'V06') await step('V06b-second-run-adds-no-row', () => v06bSecondRun(ctx))
    if (id === 'V08') await step('V08b-system-caller', () => v08bSystemCaller(ctx))
  }
}

// ───────────────────────────── cleanup ─────────────────────────────
async function scanAudit(table, runStart, isOurs) {
  const hits = []
  let startKey
  do {
    const page = await doc.send(new ScanCommand({ TableName: table, FilterExpression: 'createdAt >= :s', ExpressionAttributeValues: { ':s': runStart }, ExclusiveStartKey: startKey }))
    for (const item of page.Items ?? []) if (isOurs(item)) hits.push(item)
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return hits
}

async function cleanup(ctx) {
  const say = (msg, ok = true) => { console.log(`cleanup: ${msg}`); if (!ok) process.exitCode = 1 }
  const token = ctx.token
  if (token) {
    // shipments are voided, never deleted
    for (const id of ctx.shipmentIds) {
      try {
        const row = await getRow(token, 'Shipment', id, 'id updatedAt voidedAt')
        if (!row?.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: id, reason: VOID_REASON, expectedUpdatedAt: String(row?.updatedAt ?? '') })
        const after = await getRow(token, 'Shipment', id, 'voidedAt')
        say(`shipment ${id} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt)
      } catch (err) { say(`shipment ${id} void failed: ${String(err?.message ?? err).slice(0, 100)}`, false) }
    }
    for (const id of ctx.customerIds) {
      try {
        const row = await getRow(token, 'Customer', id, 'id updatedAt active')
        if (row && row.active !== false) await ctx.dir('ARCHIVE_CUSTOMER', { id, expectedUpdatedAt: String(row.updatedAt) })
        const after = await getRow(token, 'Customer', id, 'active')
        say(`customer ${id} ${after?.active === false ? 'archived and confirmed' : 'NOT confirmed archived'}`, after?.active === false)
      } catch (err) { say(`customer ${id} archive failed: ${String(err?.message ?? err).slice(0, 100)}`, false) }
    }
  }
  if (!ctx.suffix) {
    console.log(`residue ids (no AWS credentials, NOT deleted): profiles ${[...ctx.profileIds].join(', ') || '-'}`)
    process.exitCode = 1
    return
  }
  await restoreSettings(ctx).catch((err) => say(`TmsSettings restore failed: ${String(err?.message ?? err).slice(0, 100)}`, false))
  const profileT = devTable('UserProfile', ctx.suffix)
  for (const id of ctx.profileIds) {
    await doc.send(new DeleteCommand({ TableName: profileT, Key: { id } })).catch(() => {})
    const left = (await doc.send(new GetCommand({ TableName: profileT, Key: { id } })).catch(() => ({ Item: {} }))).Item
    say(`UserProfile ${id} ${left ? 'NOT confirmed deleted' : 'deleted and confirmed gone'}`, !left)
  }
  // Settings / customer / profile audit rows are ours alone; shipment audit rows stay with their voided shipment.
  const auditT = devTable('AuditLog', ctx.suffix)
  const isOurs = (r) => !ctx.shipmentIds.has(r.entityId)
    && (ctx.owned.has(r.entityId) || (r.entityId === 'default' && ctx.trackedEmails.has(String(r.user ?? '').toLowerCase())))
  for (const row of await scanAudit(auditT, ctx.runStart, isOurs)) await doc.send(new DeleteCommand({ TableName: auditT, Key: { id: row.id } }))
  const leftAudit = await scanAudit(auditT, ctx.runStart, isOurs)
  say(`AuditLog (settings / customers / profiles) removed; re-scan finds ${leftAudit.length}`, leftAudit.length === 0)
  // residue: no unvoided ZZ V shipment, no ZZ profile
  let active = 0
  for (const id of ctx.shipmentIds) if (!(await getRow(token, 'Shipment', id, 'voidedAt').catch(() => null))?.voidedAt) active += 1
  say(`residue: ${active} unvoided ZZ V shipments, ${[...ctx.profileIds].length} profiles removed`, active === 0)
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyV refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyV refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyV only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  if (!(await inventory())) { process.exitCode = 1; return }
  if (flag('inventory')) return

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const emails = { admin: `zz-v-admin-${ts}@example.invalid` }
  const made = []
  const ctx = {
    ts, origin, emails, runStart: nowIso(), suffix: null, f: {},
    shipmentIds: new Set(), customerIds: new Set(), profileIds: new Set(), trackedEmails: new Set(Object.values(emails)),
    settingsBefore: null,
  }
  ctx.owned = makeOwned(ctx)
  ctx.poll = async (fn, label, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await pause(1500) } throw new Error(`timed out: ${label}`) }

  try {
    ctx.suffix = await discoverDevSuffix()
    console.log('dev table suffix discovered (ok)')

    const admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    console.log('identity: temporary staff identity created (admin)')
    ctx.token = admin.token
    ctx.adminUsername = Object.entries(admin.storage).find(([k]) => k.endsWith('.LastAuthUser'))?.[1]
    if (!ctx.adminUsername) throw new Error('could not read the temporary admin username from its session')
    ctx.ship = routerAs(admin.token, 'tmsShipmentActions')
    ctx.dir = routerAs(admin.token, 'tmsDirectoryActions')
    ctx.trk = routerAs(admin.token, 'tmsTrackingActions')

    ctx.settingsBefore = await readSettings(ctx)
    await buildFixtures(ctx)

    await apiSteps(ctx)

    const b = await launchBrowser({ origin, storage: admin.storage, profilePrefix: 'bcat-v-', purpose: 'V verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
    try {
      await b.navigate('/tms/dashboard')
      await waitLoaded(b).catch(() => {})
      await b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell sidebar mounted', 45_000)
      const refs = {}
      for (const theme of ['light', 'dark']) { await setTheme(b, theme); refs[theme] = await b.evaluate(SHELL_FACTS) }
      await setTheme(b, 'light')
      for (const theme of flag('no-dark') ? ['light'] : ['light', 'dark']) {
        await b.navigate('/tms/dashboard'); await waitLoaded(b).catch(() => {})
        await setTheme(b, theme).catch(() => {})
        await v03Table(b, ctx, theme, refs[theme])
        await v10Walk(b, ctx, theme, refs[theme])
      }
      await b.navigate('/tms/dashboard'); await waitLoaded(b).catch(() => {})
      await setTheme(b, 'light').catch(() => {})
      await phonePass(b, ctx)
    } finally { await b.close() }
  } finally {
    await cleanup(ctx).catch((err) => { console.log(`cleanup: failed (${String(err?.message ?? err).slice(0, 120)})`); process.exitCode = 1 })
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
  console.log(`\nsummary: ${JSON.stringify({ pass, fail, skipped: skipped.length, skippedNotAllowed: unallowed.length })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (fail > 0 || unallowed.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyV failed: ${err?.message ?? err}`); process.exit(1) })
}
