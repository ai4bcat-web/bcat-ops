#!/usr/bin/env node
/**
 * Step W verification against the DEV site: an Ivan Cartage (own-fleet) load must carry a driver.
 * Server gates (assign / dispatch / delivered / release), the write-through map, the pay lock, the batch
 * assignment, the backfill script and the W UI walk, light + dark.
 *
 *   node scripts/devVerifyW.mjs [--inventory] [--only=<substring>] [--no-dark]
 *   DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyW.mjs
 *
 *   --inventory  no network, no browser: every W id is registered with a runner, and no script
 *                references the banner text that the `own-asset-no-driver` test id replaces.
 *   --only=      run only the steps whose id contains the substring (fixtures are still created).
 *   --no-dark    skip the dark-theme pass.
 *
 * Never run concurrently with devVerifyP: P voids shared demo shipments (BUILD_LOG L261-264).
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool, any origin outside
 * ALLOWED_ORIGINS and any DynamoDB table that does not carry the dev suffix (or that carries the production one).
 * The script touches no S3 bucket.
 *
 * Never touching real pay data: every write to a pay-bearing table (Driver, DriverPaySetting, BoxTruckTrip) goes
 * through `zzWrite()`, which throws unless the row key starts with `zz-w-`. Before the run the harness records
 * COUNT scans of the NON-ZZ rows of DriverPaySetting, BoxTruckTrip, AmazonTrip, DriverPayPeriod,
 * DriverPayDeduction and DriverPayCredit; after cleanup (W11) all six must be equal. The test drivers carry
 * `payPercent: 0`, so even the ZZ settlement lines are $0 of pay on a $1,500.00 freight line.
 *
 * Everything it creates is named zz-w-… / ZZ W …, tracked in sets, and removed in `finally` (each removal re-read):
 * shipments are VOIDED (never deleted: the PRO stays taken); ZZ drivers, pay settings and box-truck trips are
 * deleted; both temporary staff identities are deleted. Passwords and tokens are never printed.
 *
 * Deviation from W-plan §7 (recorded): the legacy-page fixture is dated TODAY (Chicago) instead of tomorrow so
 * /schedule, /calendar and the owner-operator page open on it without date navigation; the closed-week fixture and
 * the batch fixtures keep the plan's dates.
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk, SHELL_FACTS, TOKEN_PROBE, shellFailures } from './lib/uiWalk.mjs'

const run = promisify(execFile)

const DEV_APPSYNC = APPSYNC_URL_RE
const DEV_SUFFIX = STACK.tableSuffix
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const SHOTS = resolve('Docs/tms-build/screenshots/W')
const REGION = 'us-east-1'
const VOID_REASON = 'step W verification fixture'
const OVERRIDE_REASON = 'ZZ W harness'
const PAY_TABLES = ['DriverPaySetting', 'BoxTruckTrip', 'AmazonTrip', 'DriverPayPeriod', 'DriverPayDeduction', 'DriverPayCredit']

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
  // A refused ASSIGN_ASSET / DISPATCH_LOAD is the thing under test: the app shows the text inline.
  { pattern: /tmsShipmentActions/, reason: 'the W steps drive refused actions on purpose' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']
export const SKIP_ALLOWED = {
  'W03d-dispatch-panel': 'a Dispatch conversation row links a driver to a phone; this harness does not write conversation rows',
  'W04b-driver-app-settlement': 'a driver-app GET /settlement needs a temporary Cognito driver identity this harness does not mint',
  'W05b-calendar-colour': 'the Calendar card colour is drawn from a legacy canvas the harness cannot read back',
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: SKIP_ALLOWED, only })
const { line, report, written, skipLine, problemList, audit, waitLoaded, setTheme, matches } = walk

// ───────────────────────────── step registry + completeness gates ─────────────────────────────
/** Every W id, in run order. `ui` steps need the browser; the rest are API-only. */
export const W_STEPS = [
  { id: 'W01', slug: 'roster-validation', ui: false },
  { id: 'W02', slug: 'write-through', ui: false },
  { id: 'W03', slug: 'legacy-pickup', ui: false },
  { id: 'W04', slug: 'settlement', ui: false },
  { id: 'W05', slug: 'change-driver', ui: false },
  { id: 'W06', slug: 'gates', ui: false },
  { id: 'W07', slug: 'pay-lock', ui: false },
  { id: 'W08', slug: 'batch', ui: false },
  { id: 'W09', slug: 'backfill', ui: false },
  { id: 'W10', slug: 'ui-walk', ui: true },
  { id: 'W11', slug: 'cleanup', ui: false },
]

/** The banner the `own-asset-no-driver` test id replaces. Built from parts so this file does not match itself. */
const BANNER_TEXT = new RegExp(['No driver on this Ivan Cartage', ' load\\. It will not show'].join(''))

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
  const registered = W_STEPS.map((s) => s.id)
  const missing = registered.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !registered.includes(id)))
  if (missing.length) { line('FAIL', 'gate 1: W ids registered', `registry and runners disagree on: ${missing.join(', ')}`); return false }
  line('PASS', 'gate 1: W ids registered', `${registered.length} steps (${registered.join(' ')}) each have a runner; skip-allowed: ${Object.keys(SKIP_ALLOWED).join(', ')}`)
  const offenders = []
  for (const file of await scriptFiles()) {
    const text = await readFile(resolve(file), 'utf8')
    const hit = text.split('\n').findIndex((l) => BANNER_TEXT.test(l))
    if (hit >= 0) offenders.push(`${file}:${hit + 1}`)
  }
  if (offenders.length) { line('FAIL', 'gate 2: no text node a test id replaces', offenders.join('; ')); return false }
  line('PASS', 'gate 2: no script selects banner text that a test id replaces')
  return true
}

// ───────────────────────────── in-page text audit ─────────────────────────────
export function wAuditInPage() {
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
const wAudit = async (b) => (await b.evaluate(`(${wAuditInPage})()`)).map((f) => `w: ${f}`)

// ───────────────────────────── browser helpers ─────────────────────────────
const bodyText = (b) => b.evaluate(`document.body.innerText`)
const byTestId = (id) => `[data-testid="${id}"]`
const hasTestId = (b, id) => b.evaluate(`!!document.querySelector(${JSON.stringify(byTestId(id))})`)
const testIdText = (b, id) => b.evaluate(`document.querySelector(${JSON.stringify(byTestId(id))})?.innerText ?? null`)

/** Set a React-controlled <input>/<textarea>/<select> found by `selector`, firing the events React listens to. */
async function setValue(b, selector, value) {
  const hit = await b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no-element';
    if (el.disabled) return 'disabled';
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
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
    if (!el) return 'no-match among: ' + JSON.stringify([...root.querySelectorAll(spec.selector)].slice(0, 14).map((n) => n.textContent.trim().slice(0, 40)));
    if (el.disabled) return 'disabled';
    el.scrollIntoView({ block: 'center' }); el.click(); return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`click ${scope} ${selector} /${pattern}/: ${hit}`)
}

async function clickTestId(b, id) {
  const hit = await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(byTestId(id))}); if (!el) return 'no-element'; if (el.disabled) return 'disabled'; el.scrollIntoView({ block: 'center' }); el.click(); return 'ok' })()`)
  if (hit !== 'ok') throw new Error(`click [${id}]: ${hit}`)
}

async function snap(b, id, slug, theme, clip = true) {
  await walk.shot(b, id, slug, theme, clip).catch((e) => line('FAIL', `${id} ${theme}`, `screenshot failed: ${e.message}`))
}

async function pageDiagnostics(b, length = 240) {
  const p = b.problems()
  const text = await b.evaluate(`(document.querySelector('.tms-main')?.innerText ?? document.body.innerText).replace(/\\s+/g, ' ').slice(0, ${length})`).catch(() => '')
  const clip = (list) => list.slice(0, 3).map((x) => String(x).slice(0, 160)).join(' // ')
  return `page: ${JSON.stringify(text)} | console: ${clip(p.consoleErrors) || '-'} | http: ${clip(p.httpErrors) || '-'} | failed: ${clip(p.failedRequests) || '-'} | exceptions: ${clip(p.exceptions) || '-'}`
}

async function openPage(b, path, ready) {
  await b.navigate(path)
  await waitLoaded(b)
  if (ready) await b.poll(ready, `${path} ready`, 90_000).catch(async (err) => { throw new Error(`${err.message} (${await pageDiagnostics(b)})`) })
}

const openShipment = (b, shipmentId, tab, ready) =>
  openPage(b, `/tms/shipments/${shipmentId}${tab ? `?tab=${tab}` : ''}`, ready ?? (() => b.evaluate(`!!document.querySelector('.tms-main h1, .tms-main [role="tablist"]')`)))

/** Audit whatever is on screen now: problems, tokens, hook classes, shell parity, bad text. Throws on any failure. */
async function auditNow(b, theme, ref, { wideOk = true } = {}) {
  b.mark()
  await pause(500)
  const failures = [...problemList(b).slice(0, 3), ...await audit(b, theme, { wideOk }), ...await wAudit(b)]
  if (ref) {
    const f = await b.evaluate(SHELL_FACTS)
    const t = await b.evaluate(TOKEN_PROBE)
    failures.push(...shellFailures(f, t, ref, { legacyHost: false, scrollOk: true }))
  }
  if (failures.length) throw new Error(failures.slice(0, 3).join(' | '))
}

// ───────────────────────────── safety + discovery ─────────────────────────────
const ddb = new DynamoDBClient({ region: REGION })
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })

async function discoverDevSuffix() {
  const suffix = process.env.DEV_TABLE_SUFFIX || DEV_SUFFIX
  if (suffix !== DEV_SUFFIX || suffix.includes(PROD_SUFFIX)) throw new Error(`refusing table suffix ${suffix}: only ${DEV_SUFFIX} is allowed`)
  await ddb.send(new DescribeTableCommand({ TableName: `Load-${suffix}` })).catch(() => { throw new Error(`no Load-${suffix} table in the account`) })
  return suffix
}
function devTable(model, suffix) {
  const name = `${model}-${suffix}`
  if (!name.endsWith(`-${DEV_SUFFIX}`) || name.includes(PROD_SUFFIX)) throw new Error(`refusing non-dev table ${name}`)
  return name
}

// ───────────────────────────── small helpers ─────────────────────────────
const asJson = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return v } })() : v)
const nowIso = () => new Date().toISOString()
const chicagoDay = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() + offsetDays * 86_400_000))
const expect = (cond, message) => { if (!cond) throw new Error(message) }

/** Thrown by a step whose prerequisite the shell cannot provide; reported as an allowed SKIP, never a pass. */
class SkipError extends Error {}

async function refused(name, pattern, fn) {
  try { await fn() } catch (err) {
    if (pattern.test(String(err?.message ?? err))) return String(err.message).slice(0, 160)
    throw new Error(`${name} refused for the wrong reason: ${String(err?.message ?? err).slice(0, 200)}`)
  }
  throw new Error(`${name} was allowed`)
}

const getRow = async (token, model, id, selection = 'id') => (await gql(token, `query($id: ID!) { get${model}(id: $id) { ${selection} } }`, { id }))[`get${model}`]

async function listAll(token, model, filter, selection) {
  const rows = []
  let next = null
  do {
    const r = await gql(token, `query($f: Model${model}FilterInput, $n: String) { list${model}s(filter: $f, limit: 1000, nextToken: $n) { items { ${selection} } nextToken } }`, { f: filter, n: next })
    rows.push(...r[`list${model}s`].items)
    next = r[`list${model}s`].nextToken
  } while (next)
  return rows
}

async function auditRows(token, entityId, action) {
  const rows = await listAll(token, 'AuditLog', { entityId: { eq: entityId }, action: { eq: action } }, 'id entityId action user changes')
  return rows.map((x) => ({ ...x, changes: asJson(asJson(x.changes)) }))
}

// ───────────────────────────── guarded SDK writes ─────────────────────────────
/** Every pay-bearing write: refuses any key that does not start with zz-w-. */
function zzKey(id) {
  if (typeof id !== 'string' || !id.startsWith('zz-w-')) throw new Error(`refusing SDK write to a row whose key is not zz-w-…: ${String(id)}`)
  return id
}
async function zzPut(ctx, model, item) {
  zzKey(item.id)
  await doc.send(new PutCommand({ TableName: devTable(model, ctx.suffix), Item: { __typename: model, createdAt: nowIso(), updatedAt: nowIso(), ...item } }))
}
async function zzDelete(ctx, model, id) {
  zzKey(id)
  await doc.send(new DeleteCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))
  const left = (await doc.send(new GetCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))).Item
  return !left
}
/** A guarded patch on a Load / LoadCarrier this run created (ids tracked in ctx.owned). */
async function ownedUpdate(ctx, model, id, set, remove = []) {
  if (!ctx.owned.has(id)) throw new Error(`refusing SDK write to ${model} ${id}: this run did not create it`)
  if (Object.keys(set).length === 0 && remove.length === 0) return
  const names = {}
  const values = {}
  const sets = Object.entries(set).map(([k, v], i) => { names[`#s${i}`] = k; values[`:s${i}`] = v; return `#s${i} = :s${i}` })
  const rems = remove.map((k, i) => { names[`#r${i}`] = k; return `#r${i}` })
  await doc.send(new UpdateCommand({
    TableName: devTable(model, ctx.suffix), Key: { id },
    UpdateExpression: `${sets.length ? `SET ${sets.join(', ')}` : ''}${rems.length ? ` REMOVE ${rems.join(', ')}` : ''}`.trim(),
    ExpressionAttributeNames: names, ...(sets.length ? { ExpressionAttributeValues: values } : {}),
  }))
}
const getItem = async (ctx, model, id) => (await doc.send(new GetCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))).Item ?? null

/** COUNT of the non-ZZ rows of every pay-bearing table. */
async function payCounts(ctx) {
  const out = {}
  for (const model of PAY_TABLES) {
    let count = 0
    let startKey
    try {
      do {
        const page = await doc.send(new ScanCommand({
          TableName: devTable(model, ctx.suffix), Select: 'COUNT', ExclusiveStartKey: startKey,
          FilterExpression: 'NOT begins_with(#id, :zz)', ExpressionAttributeNames: { '#id': 'id' }, ExpressionAttributeValues: { ':zz': 'zz-w-' },
        }))
        count += page.Count ?? 0
        startKey = page.LastEvaluatedKey
      } while (startKey)
      out[model] = count
    } catch (err) {
      if (err?.name !== 'ResourceNotFoundException') throw err
      out[model] = null
    }
  }
  return out
}

// ───────────────────────────── fixtures ─────────────────────────────
const stopsFor = (pickupDay, deliveryDay) => [
  { type: 'pickup', name: 'ZZ W Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${pickupDay}T15:00:00.000Z` },
  { type: 'delivery', name: 'ZZ W Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${deliveryDay}T18:00:00.000Z` },
]

/** A buildable, submitted shipment (customer record, order form, $1,500.00 customer line) with one load. */
async function makeShipment(ctx, label, pickupDay, deliveryDay) {
  let bundle = await ctx.ship('CREATE_SHIPMENT', { customerId: ctx.customer.id })
  const shipmentId = bundle.shipment.id
  ctx.shipmentIds.add(shipmentId)
  bundle = await ctx.ship('SAVE_ORDER_FORM', {
    shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt,
    order: { mode: 'FTL', equipmentType: 'Dry Van', references: [{ code: 'PO', label: 'Purchase order', value: `ZZW-${ctx.ts}-${label}`, level: 'ORDER', visibility: 'CUSTOMER' }] },
    stops: stopsFor(pickupDay, deliveryDay),
    charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 150000, count: 1 }],
  })
  await ctx.ship('SUBMIT_ORDER', { shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt })
  bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId })
  for (const load of bundle.loads ?? []) ctx.owned.add(load.id)
  ctx.f.labels[shipmentId] = label
  return bundle
}
const reload = (ctx, shipmentId) => ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId })
const trackLegs = (ctx, bundle) => { for (const leg of bundle.loadCarriers ?? []) ctx.owned.add(leg.id) }
const loadOf = (bundle) => bundle.loads[0]
const activeLegOf = (bundle) => (bundle.loadCarriers ?? []).find((c) => c.status === 'ACTIVE') ?? null
const stopsOf = (load) => asJson(load.stops) ?? []

async function assignAs(ctx, who, bundle, input) {
  const fn = who === 'tms' ? ctx.shipTms : ctx.ship
  const out = await fn('ASSIGN_ASSET', { loadId: loadOf(bundle).id, ...input })
  trackLegs(ctx, out)
  return out
}

async function buildFixtures(ctx) {
  const F = ctx.f
  F.labels = {}
  const mkDriver = async (key, name, extra) => {
    const id = `zz-w-drv-${key}-${ctx.ts}`
    await zzPut(ctx, 'Driver', { id, name, phone: '+15555550100', active: true, ...extra })
    ctx.driverIds.add(id)
    return id
  }
  F.drvA = await mkDriver('a', 'ZZ W Driver A', { fleetGroup: 'AMAZON', driverType: 'OWNER_OPERATOR', colorKey: 'driver-3' })
  F.drvB = await mkDriver('b', 'ZZ W Driver B', { fleetGroup: 'AMAZON', driverType: 'OWNER_OPERATOR', colorKey: 'driver-7' })
  F.drvIvan = await mkDriver('ivan', 'ZZ W Driver Ivan', { fleetGroup: 'LOCAL', driverType: 'COMPANY', colorKey: 'driver-5' })
  F.drvOff = await mkDriver('off', 'ZZ W Driver Off', { fleetGroup: 'LOCAL', driverType: 'COMPANY', active: false })
  for (const [key, driverId] of [['a', F.drvA], ['b', F.drvB]]) {
    const id = `zz-w-ps-${key}-${ctx.ts}`
    await zzPut(ctx, 'DriverPaySetting', { id, driverId, payGroup: 'OWNER_OPERATOR', payPercent: 0, expensesBeforePercent: false, active: true })
    ctx.paySettingIds.add(id)
  }
  F.truck = { id: `zz-w-truck-${ctx.ts}`, number: 'ZZW-T1' }
  F.trailer = { id: `zz-w-trl-${ctx.ts}`, number: 'ZZW-TR1' }

  const customer = await ctx.dir('UPSERT_CUSTOMER', {
    name: `ZZ W Customer ${ctx.ts}`, creditLimitCents: 100_000_000,
    contacts: [{ id: `cnt-zz-w-${ctx.ts}`, name: 'ZZ W Contact', email: `zz-w-${ctx.ts}@example.invalid`, types: [] }],
    billToParties: [{ id: `zz-w-bt-${ctx.ts}`, name: 'ZZ W Bill To', isDefault: false }],
  })
  ctx.customer = { id: String(customer.id), name: `ZZ W Customer ${ctx.ts}` }
  ctx.customerIds.add(ctx.customer.id)

  const today = chicagoDay(0)
  const tomorrow = chicagoDay(1)
  const dayAfter = chicagoDay(2)
  F.main = await makeShipment(ctx, 'main', today, today)
  F.ivan = await makeShipment(ctx, 'ivan', today, today)
  F.closed = await makeShipment(ctx, 'closed', '2026-10-13', '2026-10-14')
  F.driverless = await makeShipment(ctx, 'driverless', tomorrow, dayAfter)
  F.carrier = await makeShipment(ctx, 'carrier', tomorrow, dayAfter)
  F.relay = await makeShipment(ctx, 'relay', tomorrow, dayAfter)
  F.backfill = await makeShipment(ctx, 'backfill', tomorrow, dayAfter)
  F.batchOk = await makeShipment(ctx, 'batch-ok', tomorrow, dayAfter)
  F.batchCarrier = await makeShipment(ctx, 'batch-carrier', tomorrow, dayAfter)
  F.batchClosed = await makeShipment(ctx, 'batch-closed', '2026-10-13', '2026-10-14')
  console.log(`seeds: 4 drivers, 2 pay settings, 1 customer, ${ctx.shipmentIds.size} shipments`)
}

const proOf = (bundle) => String(loadOf(bundle).aljexId ?? loadOf(bundle).tmsId ?? bundle.shipment.number)

// ───────────────────────────── W01 – W09 (API) ─────────────────────────────
const TRUCK_INPUT = (F) => ({ truckId: F.truck.id, truckNumber: F.truck.number, trailerId: F.trailer.id, trailerNumber: F.trailer.number })

async function snapshotRows(ctx, bundle) {
  const load = loadOf(bundle)
  const legs = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: bundle.shipment.id })
  return JSON.stringify({ load: await getItem(ctx, 'Load', load.id), legs: (legs.loadCarriers ?? []).map((l) => l.id).sort() })
}

async function w01Roster(ctx) {
  const F = ctx.f
  const b = F.main
  const before = await snapshotRows(ctx, b)
  const brokerRows = await listAll(ctx.token, 'Driver', { type: { eq: 'broker' } }, 'id name type')
  const broker = brokerRows.find((d) => /BROKER COVERED/i.test(d.name)) ?? brokerRows[0]
  expect(broker, 'no broker placeholder driver on dev to read')
  const cases = [
    ['missing driverId', /driverId/i, {}],
    ['empty driverId', /driverId/i, { driverId: '' }],
    ['unknown driver', /^Driver not found: zz-w-nobody$/, { driverId: 'zz-w-nobody' }],
    ['broker placeholder', new RegExp(`^${broker.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is a placeholder for brokered freight, not one of Ivan Cartage's drivers$`), { driverId: broker.id }],
    ['inactive driver', /^ZZ W Driver Off is inactive\. Reactivate the driver or pick another one\.$/, { driverId: F.drvOff }],
  ]
  for (const [name, pattern, input] of cases) await refused(name, pattern, () => ctx.ship('ASSIGN_ASSET', { loadId: loadOf(b).id, ...input }))
  expect(await snapshotRows(ctx, b) === before, 'a refused ASSIGN_ASSET changed the Load or the leg list')
  const legsAfter = await reload(ctx, b.shipment.id)
  expect((legsAfter.loadCarriers ?? []).length === 0, 'a refused ASSIGN_ASSET wrote a leg')
  const ok = await assignAs(ctx, 'admin', b, { driverId: F.drvA, driverName: 'junk', driverPhone: '000', ...TRUCK_INPUT(F) })
  expect(activeLegOf(ok)?.driverId === F.drvA, 'the roster driver was not booked')
  F.mainAssigned = ok
  return 'missing / empty / unknown / broker / inactive refused with the exact text, nothing written; driver A booked'
}

async function w02WriteThrough(ctx) {
  const F = ctx.f
  const before = F.main
  const bundle = await reload(ctx, before.shipment.id)
  const load = await getItem(ctx, 'Load', loadOf(bundle).id)
  const leg = activeLegOf(bundle)
  const stops = stopsOf(load)
  expect(stops.length >= 2 && stops.every((s) => s.driverId === F.drvA), `C1: stops carry ${JSON.stringify(stops.map((s) => s.driverId))}, expected ${F.drvA} on every stop`)
  expect(stops.every((s) => s.truckId === F.truck.id), 'stops[*].truckId is not the truck')
  expect(load.pickupDriverId === F.drvA, `C2: pickupDriverId ${load.pickupDriverId}`)
  expect(load.deliveryDriverId === F.drvA, `C3: deliveryDriverId ${load.deliveryDriverId}`)
  expect(load.truckId === F.truck.id, `Load.truckId ${load.truckId}`)
  expect(load.trailerNumber === F.trailer.number, `Load.trailerNumber ${load.trailerNumber}`)
  expect(load.assignmentType === 'OWN_ASSET' && load.trackingProvider === 'DRIVER_APP' && !load.carrierName, `assignmentType ${load.assignmentType} / tracking ${load.trackingProvider} / carrierName ${load.carrierName}`)
  expect(load.status === 'BOOKED', `status ${load.status}, expected BOOKED`)
  expect(load.activeLoadCarrierId === leg.id, 'activeLoadCarrierId is not the new leg')
  expect(leg.kind === 'OWN_ASSET' && leg.driverName === 'ZZ W Driver A' && leg.driverPhone === '+15555550100', `leg name/phone ${leg.driverName} / ${leg.driverPhone}: the roster must win over the typed ones`)
  expect(leg.truckNumber === F.truck.number && leg.trailerNumber === F.trailer.number && leg.truckId === F.truck.id && leg.trailerId === F.trailer.id, 'leg truck / trailer fields')
  expect(!leg.apStatus && !leg.apOpen && (leg.carrierRateCents ?? 0) === 0 && (leg.costCents ?? 0) === 0, 'an own-fleet leg entered AP or carries money')
  expect(load.revDivision === 'ASSETS', `revDivision ${load.revDivision}`)
  const was = loadOf(before)
  for (const key of ['rate', 'readyToInvoice', 'aljexId', 'tmsId', 'pickupNumber', 'voidedAt', 'pickupAppt', 'deliveryAppt']) {
    expect(String(load[key] ?? null) === String(was[key] ?? null), `${key} moved: ${was[key]} -> ${load[key]}`)
  }
  const audits = await auditRows(ctx.token, leg.id, 'ASSIGN_ASSET')
  const changes = audits[0]?.changes
  expect(changes && changes.driverId === F.drvA && changes.driverName === 'ZZ W Driver A' && changes.truckNumber === F.truck.number, `ASSIGN_ASSET audit ${JSON.stringify(changes)}`)
  F.mainLoadId = load.id
  return 'C1 stops, C2/C3 mirrors, truck + trailer, OWN_ASSET/DRIVER_APP, roster name/phone over typed junk, no AP, ASSETS, BOOKED; rate/dates/PRO untouched; ASSIGN_ASSET audit'
}

/** The text of a legacy page, once it has settled. */
async function pageText(b, path, pro, ms = 45_000) {
  await openPage(b, path)
  let text = ''
  await b.poll(async () => { text = await bodyText(b); return text.includes(pro) }, `${pro} on ${path}`, ms).catch(() => {})
  return text
}

async function w03Legacy(ctx) {
  const F = ctx.f
  const load = await getItem(ctx, 'Load', F.mainLoadId)
  expect(!load.voidedAt && !load.unscheduled, `C4/C5: voidedAt ${load.voidedAt} unscheduled ${load.unscheduled}`)
  expect(load.pickupAppt && load.deliveryAppt, 'C4: pickupAppt/deliveryAppt blank')
  const ivan = await assignAs(ctx, 'admin', F.ivan, { driverId: F.drvIvan })
  F.ivanAssigned = ivan
  const ivanLoad = await getItem(ctx, 'Load', loadOf(ivan).id)
  expect(ivanLoad.pickupDriverId === F.drvIvan && ivanLoad.deliveryDriverId === F.drvIvan, 'the LOCAL fixture is not on both mirrors')
  ctx.legacyFixtures = { pro: proOf(F.main), ivanPro: proOf(F.ivan) }
  return `data: stops/mirrors set, voidedAt null, unscheduled falsy; PRO ${ctx.legacyFixtures.pro}; the LOCAL fixture assigned (UI pages: W03a-c)`
}

async function w03UiPages(b, ctx, theme, ref) {
  const F = ctx.f
  const pro = ctx.legacyFixtures.pro
  await step(`W03a-schedule-${theme}`, async () => {
    const text = await pageText(b, '/schedule', pro)
    expect(text.includes(pro), `/schedule does not list ${pro}`)
    const a = text.indexOf('ZZ W Driver A')
    expect(a >= 0, '/schedule has no section for ZZ W Driver A')
    expect(!new RegExp(`ZZ W Driver B[\\s\\S]{0,200}?${pro}`).test(text), 'driver B section lists the ZZ PRO')
    if (theme === 'light') await snap(b, 'W03', 'schedule-zz-driver', theme, false)
    return `/schedule lists ${pro} under ZZ W Driver A`
  })
  await step(`W03b-calendar-${theme}`, async () => {
    const text = await pageText(b, '/calendar', pro)
    expect(text.includes(pro) || text.includes('ZZ W Driver A'), '/calendar shows neither the PRO nor driver A')
    if (theme === 'light') await snap(b, 'W03', 'calendar-zz-driver', theme, false)
    return '/calendar shows a card for the ZZ load'
  })
  await step(`W03c-ivan-app-${theme}`, async () => {
    // The page shows one driver's week at a time (the first chip by name is selected), so pick the fixture driver's chip.
    await openPage(b, '/ivan-driver-app')
    await b.poll(() => b.evaluate(`!!document.querySelector('button[title="ZZ W Driver Ivan"]')`), 'the ZZ W Driver Ivan chip', 45_000)
    await b.click({ selector: 'button[title="ZZ W Driver Ivan"]', real: true })
    let text = ''
    await b.poll(async () => { text = await bodyText(b); return text.includes(ctx.legacyFixtures.ivanPro) }, `${ctx.legacyFixtures.ivanPro} on /ivan-driver-app`, 45_000).catch(() => {})
    expect(text.includes(ctx.legacyFixtures.ivanPro), '/ivan-driver-app does not list the LOCAL fixture PRO')
    return `/ivan-driver-app lists ${ctx.legacyFixtures.ivanPro}`
  })
  await step(`W04a-owner-op-${theme}`, async () => {
    await openPage(b, '/owner-operator-pay')
    await b.evaluate(`(() => { const el = [...document.querySelectorAll('button, [role="tab"], a, li, tr')].find((n) => n.textContent.includes('ZZ W Driver A')); if (el) el.click() })()`)
    let text = ''
    await b.poll(async () => { text = await bodyText(b); return text.includes(pro) }, `${pro} on the owner-operator page`, 45_000)
    expect(/1,500\.00/.test(text), '$1,500.00 freight line is not on the page')
    if (theme === 'light') await snap(b, 'W04', 'owner-op-pay-zz-driver', theme, false)
    return 'driver A has the line with the PRO and $1,500.00'
  })
}

async function w04Settlement(ctx) {
  const F = ctx.f
  const load = await getItem(ctx, 'Load', F.mainLoadId)
  expect(load.deliveryDriverId === F.drvA && typeof load.rate === 'number' && load.deliveryAppt, `pay inputs: deliveryDriverId ${load.deliveryDriverId} rate ${load.rate} deliveryAppt ${load.deliveryAppt}`)
  expect(load.rate === 150000, `Load.rate ${load.rate}, expected 150000 cents`)
  // The LOCAL fixture is on no settlement: no DriverPaySetting, no DriverPayPeriod row.
  const ps = await listAll(ctx.token, 'DriverPaySetting', { driverId: { eq: F.drvIvan } }, 'id')
  expect(ps.length === 0, 'the LOCAL fixture has a DriverPaySetting')
  const periods = await listAll(ctx.token, 'DriverPayPeriod', { driverId: { eq: F.drvIvan } }, 'id')
  expect(periods.length === 0, 'a DriverPayPeriod row exists for the LOCAL fixture')
  // box-truck candidate predicate (useBoxTruckPay): deliveryDriverId === driver && deliveryAppt inside the 14-day Wed-Tue window.
  const anchor = Date.parse('2026-06-10T00:00:00Z')
  const day = Math.floor((Date.parse(`${String(load.deliveryAppt).slice(0, 10)}T00:00:00Z`) - anchor) / 86_400_000)
  const start = anchor + Math.floor(day / 14) * 14 * 86_400_000
  const windowStart = new Date(start).toISOString().slice(0, 10)
  const windowEnd = new Date(start + 13 * 86_400_000).toISOString().slice(0, 10)
  const d = String(load.deliveryAppt).slice(0, 10)
  expect(d >= windowStart && d <= windowEnd, `delivery ${d} is outside its box-truck window ${windowStart}..${windowEnd}`)
  return `Load.deliveryDriverId=A, rate 150000, delivery ${d} in box-truck window ${windowStart}..${windowEnd} (predicate only, never pulled); LOCAL fixture has no pay setting / period`
}

async function w04bDriverApp() {
  throw new SkipError('a temporary driver Cognito identity is not minted by this harness')
}

async function tripsOfDriver(ctx, token, driverId) {
  return listAll(token, 'BoxTruckTrip', { driverId: { eq: driverId } }, 'id driverId loadId')
}

async function w05Change(ctx) {
  const F = ctx.f
  const loadId = F.mainLoadId
  const legBefore = activeLegOf(await reload(ctx, F.main.shipment.id))
  // Other-week trips and totals for A and B are untouched by the change (they read stored rows / other weeks).
  const tripsBefore = [...await tripsOfDriver(ctx, ctx.token, F.drvA), ...await tripsOfDriver(ctx, ctx.token, F.drvB)].map((t) => t.id).sort()
  const out = await assignAs(ctx, 'admin', F.main, { driverId: F.drvB, flattenSplit: true, ...TRUCK_INPUT(F) })
  const load = await getItem(ctx, 'Load', loadId)
  const stops = stopsOf(load)
  expect(stops.every((s) => s.driverId === F.drvB) && load.pickupDriverId === F.drvB && load.deliveryDriverId === F.drvB, 'the load did not move to B on stops and mirrors')
  const legs = out.loadCarriers ?? []
  const old = legs.find((l) => l.id === legBefore.id)
  expect(old?.status === 'BOUNCED' && old?.removalReason === 'REASSIGNED', `old leg ${old?.status}/${old?.removalReason}`)
  expect(activeLegOf(out)?.driverId === F.drvB, 'the new leg is not B')
  let audits = []
  await ctx.poll(async () => (audits = await auditRows(ctx.token, loadId, 'CHANGE_ASSET_DRIVER')).length > 0, 'CHANGE_ASSET_DRIVER audit row', 30_000)
  const c = audits[0].changes
  expect(c.driver?.from?.includes(F.drvA) && c.driver?.to?.includes(F.drvB), `audit driver ${JSON.stringify(c.driver)}`)
  expect(c.payLock?.state === 'OPEN', `payLock ${JSON.stringify(c.payLock)}`)
  expect(load.colorKey == null && stops.every((s) => s.colorKey == null), `colour not reset: Load.colorKey ${load.colorKey}`)
  // same driver again: no-op
  const legsBeforeRepeat = (await reload(ctx, F.main.shipment.id)).loadCarriers.length
  await assignAs(ctx, 'admin', F.main, { driverId: F.drvB, ...TRUCK_INPUT(F) })
  const legsAfterRepeat = (await reload(ctx, F.main.shipment.id)).loadCarriers.length
  expect(legsAfterRepeat === legsBeforeRepeat, `a same-driver repeat added ${legsAfterRepeat - legsBeforeRepeat} legs`)
  const tripsAfter = [...await tripsOfDriver(ctx, ctx.token, F.drvA), ...await tripsOfDriver(ctx, ctx.token, F.drvB)].map((t) => t.id).sort()
  expect(JSON.stringify(tripsAfter) === JSON.stringify(tripsBefore), 'stored box-truck trips changed')
  ctx.legacyFixtures.changedTo = F.drvB
  return 'stops/mirrors/leg moved to B, old leg BOUNCED/REASSIGNED, CHANGE_ASSET_DRIVER {from,to} with payLock OPEN, colour reset, repeat is a no-op, stored trips untouched'
}

async function w05UiMoved(b, ctx, theme) {
  const pro = ctx.legacyFixtures.pro
  await step(`W05a-moved-${theme}`, async () => {
    const text = await pageText(b, '/schedule', pro)
    const a = text.indexOf('ZZ W Driver A')
    const bi = text.indexOf('ZZ W Driver B')
    expect(bi >= 0 && text.includes(pro), '/schedule: driver B has no section with the ZZ PRO')
    expect(a < 0 || !text.slice(a, bi > a ? bi : undefined).includes(pro), '/schedule still lists the PRO under driver A')
    return 'Schedule: B present, A gone'
  })
  await step(`W05c-history-${theme}`, async () => {
    await openShipment(b, ctx.f.main.shipment.id, 'history')
    await b.poll(async () => /Change[_ ]asset[_ ]driver/i.test(await bodyText(b)), 'CHANGE_ASSET_DRIVER on the History tab', 45_000)
    return 'the History tab shows CHANGE_ASSET_DRIVER'
  })
}

async function w05bColour(ctx) {
  const load = await getItem(ctx, 'Load', ctx.f.mainLoadId)
  expect(load.colorKey == null, 'Load.colorKey still set after a driver change')
  throw new SkipError('Calendar card colour cannot be read back from the legacy canvas; the data fallback (Load/stops colorKey null → driver colour) is asserted in W05')
}

async function w06Gates(ctx) {
  const F = ctx.f
  const b = F.driverless
  // Make the state the old duplicate/backfill paths produced: OWN_ASSET, no active leg, no driver anywhere.
  const loadId = loadOf(b).id
  const stops = stopsOf(await getItem(ctx, 'Load', loadId)).map((s) => ({ ...s, driverId: null }))
  await ownedUpdate(ctx, 'Load', loadId, { assignmentType: 'OWN_ASSET', stops: JSON.stringify(stops), pickupDriverId: null, deliveryDriverId: null, status: 'BOOKED' }, ['activeLoadCarrierId'])
  const dispatchedAt = nowIso()
  const fresh = () => getItem(ctx, 'Load', loadId)
  await refused('DISPATCH_LOAD', /^Ivan Cartage load: pick the driver before dispatching \(Carrier\/Driver tab → Assign driver\)\.$/, () => ctx.ship('DISPATCH_LOAD', { loadId, dispatchedAt }))
  await refused('SET_LOAD_STATUS DELIVERED', /^Ivan Cartage load: pick the driver before marking it delivered/, async () => {
    // Walk the ladder the way the app does; the gate only fires on DELIVERED.
    for (const status of ['DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING']) await ownedUpdate(ctx, 'Load', loadId, { status })
    await ctx.ship('SET_LOAD_STATUS', { loadId, status: 'DELIVERED' })
  })
  await ownedUpdate(ctx, 'Load', loadId, { status: 'BOOKED' })
  // departing the last delivery must be refused and write no tracking row
  const checkCallsBefore = (await listAll(ctx.token, 'LoadCheckCall', { loadId: { eq: loadId } }, 'id')).length
  const row = await fresh()
  const last = [...stopsOf(row)].reverse().find((s) => s.type === 'delivery')
  await refused('UPDATE_STOP SET_TIMES', /^Ivan Cartage load: pick the driver before marking it delivered/, () =>
    ctx.ship('UPDATE_STOP', { loadId, expectedUpdatedAt: String(row.updatedAt), op: 'SET_TIMES', stopId: last.id, patch: { arrivedAt: nowIso(), departedAt: nowIso() } }))
  const checkCallsAfter = (await listAll(ctx.token, 'LoadCheckCall', { loadId: { eq: loadId } }, 'id')).length
  expect(checkCallsAfter === checkCallsBefore, `UPDATE_STOP wrote ${checkCallsAfter - checkCallsBefore} LoadCheckCall rows before refusing`)
  const orderId = b.orders[0].id
  const releaseMsg = /^Not ready for accounting: .*Missing driver/
  const orderRow = await getRow(ctx.token, 'Order', orderId, 'updatedAt')
  await refused('READY_TO_INVOICE', /Missing driver|Finish building/, () => ctx.ship('READY_TO_INVOICE', { orderId, expectedUpdatedAt: String(orderRow.updatedAt) }))
  await refused('SET_AR_STATUS UNBILLED', releaseMsg, () => ctx.ship('SET_AR_STATUS', { orderId, status: 'UNBILLED' }))

  // after assigning A: dispatch succeeds
  await assignAs(ctx, 'admin', b, { driverId: F.drvA, ...TRUCK_INPUT(F) })
  await ctx.ship('DISPATCH_LOAD', { loadId, dispatchedAt, driverName: 'typed junk', driverPhone: '000' })
  const afterDispatch = await reload(ctx, b.shipment.id)
  expect(activeLegOf(afterDispatch)?.driverName === 'ZZ W Driver A', 'a typed name overwrote the own-asset leg name on dispatch')
  // inactive driver: dispatch refused, DELIVERED allowed. (Re-booked load goes back to BOOKED first.)
  await ownedUpdate(ctx, 'Load', loadId, { status: 'BOOKED' })
  await doc.send(new UpdateCommand({ TableName: devTable('Driver', ctx.suffix), Key: { id: zzKey(F.drvA) }, UpdateExpression: 'SET active = :f', ExpressionAttributeValues: { ':f': false } }))
  try {
    await refused('DISPATCH_LOAD inactive driver', /^ZZ W Driver A is inactive: pick an active driver before dispatching\.$/, () => ctx.ship('DISPATCH_LOAD', { loadId, dispatchedAt }))
    for (const status of ['DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING']) await ownedUpdate(ctx, 'Load', loadId, { status })
    await ctx.ship('SET_LOAD_STATUS', { loadId, status: 'DELIVERED' })
    expect((await fresh()).status === 'DELIVERED', 'DELIVERED was refused for an inactive driver')
  } finally {
    await doc.send(new UpdateCommand({ TableName: devTable('Driver', ctx.suffix), Key: { id: zzKey(F.drvA) }, UpdateExpression: 'SET active = :t', ExpressionAttributeValues: { ':t': true } }))
  }

  // regression: an outside carrier dispatches and delivers exactly as before
  const c = F.carrier
  const carrierOut = await ctx.ship('ASSIGN_CARRIER', { loadId: loadOf(c).id, carrierName: 'ZZ W Carrier' })
  trackLegs(ctx, carrierOut)
  await ctx.ship('DISPATCH_LOAD', { loadId: loadOf(c).id, dispatchedAt })
  for (const status of ['LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) await ctx.ship('SET_LOAD_STATUS', { loadId: loadOf(c).id, status })
  expect((await getItem(ctx, 'Load', loadOf(c).id)).status === 'DELIVERED', 'the outside-carrier load did not deliver')
  await refused('ASSIGN_CARRIER "Ivan Cartage"', /^Ivan Cartage is our own fleet\. Use "Book Ivan Cartage \(own fleet\)" and pick the driver\.$/, () => ctx.ship('ASSIGN_CARRIER', { loadId: loadOf(F.relay).id, carrierName: 'Ivan Cartage LLC' }))
  return 'driverless own-asset load: dispatch / delivered / stop times (no check call) / READY_TO_INVOICE / SET_AR_STATUS refused with the exact text; after A: dispatch ok (typed name ignored); inactive: dispatch refused, DELIVERED allowed; ASSIGN_CARRIER regression + the typed-name trap'
}

async function w07PayLock(ctx) {
  const F = ctx.f
  const b = F.closed
  const loadId = loadOf(b).id
  const closedText = /^Delivered 2026-10-14: that pay week has closed\. Changing the driver would move this load between .+'s and ZZ W Driver A's settlements\. An owner or ADMIN can do it with a reason\.$/
  const before = await snapshotRows(ctx, b)
  await refused('non-admin closed-week assign', closedText, () => assignAs(ctx, 'tms', b, { driverId: F.drvA }))
  await refused('admin without a reason', /^Give a reason \(at least 10 characters\) to change the driver on a load in a closed pay week\.$/, () => assignAs(ctx, 'admin', b, { driverId: F.drvA }))
  expect(await snapshotRows(ctx, b) === before, 'a refused closed-week attempt changed the Load or the leg list')
  const out = await assignAs(ctx, 'admin', b, { driverId: F.drvA, payOverrideReason: OVERRIDE_REASON })
  const leg = activeLegOf(out)
  expect(leg?.driverId === F.drvA, 'the admin override did not book A')
  // The closed fixture had no previous driver, so there is no CHANGE_ASSET_DRIVER row: the override is on the ASSIGN_ASSET row.
  const lockOf = async () => [...await auditRows(ctx.token, leg.id, 'ASSIGN_ASSET'), ...await auditRows(ctx.token, loadId, 'CHANGE_ASSET_DRIVER')]
    .map((r) => r.changes?.payLock).find(Boolean)
  await ctx.poll(async () => Boolean(await lockOf()), 'closed-week payLock audit', 20_000).catch(() => false)
  const lock = await lockOf()
  expect(lock?.state === 'CLOSED_WEEK_OVERRIDE' && String(lock.reason ?? '').includes(OVERRIDE_REASON), `audit payLock ${JSON.stringify(lock)}`)
  // a stored box-truck trip for the load refuses even the admin
  const tripId = `zz-w-trip-${ctx.ts}`
  await zzPut(ctx, 'BoxTruckTrip', { id: tripId, driverId: F.drvA, periodStart: '2026-10-07', loadId, date: '2026-10-14', grossProfit: 0, status: 'Delivered' })
  ctx.tripIds.add(tripId)
  await refused('box-truck trip lock', /^This load is already on .+'s box-truck settlement \(period starting 2026-10-07\)\. Remove it from that settlement first, then change the driver\.$/, () =>
    assignAs(ctx, 'admin', b, { driverId: F.drvB, payOverrideReason: OVERRIDE_REASON }))
  expect(await zzDelete(ctx, 'BoxTruckTrip', tripId), 'the ZZ BoxTruckTrip was not removed')
  ctx.tripIds.delete(tripId)
  const allowed = await assignAs(ctx, 'admin', b, { driverId: F.drvB, payOverrideReason: OVERRIDE_REASON })
  expect(activeLegOf(allowed)?.driverId === F.drvB, 'removing the trip did not unlock the change')
  // current-week load is open for any TMS user
  await assignAs(ctx, 'tms', F.ivan, { driverId: F.drvIvan })
  return 'closed week: non-admin refused, admin needs a reason, override audited (CLOSED_WEEK_OVERRIDE) and a refusal writes nothing; a box-truck trip refuses the admin too and removing it unlocks; current-week open'
}

async function w08Batch(ctx) {
  const F = ctx.f
  const outside = await ctx.ship('ASSIGN_CARRIER', { loadId: loadOf(F.batchCarrier).id, carrierName: 'ZZ W Carrier' })
  trackLegs(ctx, outside)
  const ids = [F.batchOk, F.batchCarrier, F.batchClosed].map((s) => s.shipment.id)
  const auditBefore = (await listAll(ctx.token, 'AuditLog', { entityId: { eq: 'BATCH' }, action: { eq: 'BATCH_SHIPMENT_TASK' } }, 'id changes')).length
  const r = await ctx.ship('BATCH_SHIPMENT_TASK', { task: 'ASSIGN_DRIVER', shipmentIds: ids, params: { driverId: F.drvA } })
  const results = r.results
  expect(results.map((x) => x.shipmentId).join() === ids.join(), `results order ${results.map((x) => x.shipmentId).join()}`)
  expect(results[0].ok === true, `clean row: ${results[0].message}`)
  expect(results[1].ok === false && /covered by ZZ W Carrier/.test(results[1].message ?? ''), `outside-carrier row: ${JSON.stringify(results[1])}`)
  // The batch caller is an ADMIN and a batch never carries a pay-lock reason, so the row comes back with the
  // admin's "give a reason" refusal (a non-admin would get the "pay week has closed" sentence).
  expect(results[2].ok === false && /pay week has closed|Give a reason \(at least 10 characters\)/.test(results[2].message ?? ''), `closed-week row: ${JSON.stringify(results[2])}`)
  const reread = await reload(ctx, F.batchOk.shipment.id)
  trackLegs(ctx, reread)
  expect(activeLegOf(reread)?.driverId === F.drvA, 'the clean batch row did not book A')
  await ctx.poll(async () => (await listAll(ctx.token, 'AuditLog', { entityId: { eq: 'BATCH' }, action: { eq: 'BATCH_SHIPMENT_TASK' } }, 'id changes')).length === auditBefore + 1, 'one BATCH_SHIPMENT_TASK audit row', 30_000)
  return 'ok / refused (covered by ZZ W Carrier) / refused (closed pay week); results in request order; one BATCH_SHIPMENT_TASK audit row'
}

/** Run a script of ours as a child process. Dev tables only: the script itself refuses production. */
async function runScript(file, argv) {
  const { stdout } = await run(process.execPath, [file, ...argv], { env: { ...process.env, TABLE_SUFFIX: DEV_SUFFIX }, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 })
  return stdout
}

async function w09Backfill(ctx) {
  const F = ctx.f
  const b = F.backfill
  const loadId = loadOf(b).id
  const out = await assignAs(ctx, 'admin', b, { driverId: F.drvA, ...TRUCK_INPUT(F) })
  const leg = activeLegOf(out)
  // The leg-less state the old duplicate / backfill paths left behind: OWN_ASSET load with a driver and no ACTIVE leg.
  await ownedUpdate(ctx, 'LoadCarrier', leg.id, { status: 'BOUNCED' })
  await ownedUpdate(ctx, 'Load', loadId, {}, ['activeLoadCarrierId'])
  const dir = join(tmpdir(), `zz-w-backfill-${ctx.ts}`)
  await mkdir(dir, { recursive: true })
  const planPath = join(dir, 'scoped.json')
  const script = 'scripts/backfillOwnAssetDrivers.mjs'
  const scoped = ['--only-load', loadId, '--suffix', DEV_SUFFIX]
  await runScript(script, [...scoped, '--plan', planPath])
  let plan = JSON.parse(await readFile(planPath, 'utf8'))
  expect(plan.actions.length === 1 && plan.actions[0].action === 'CREATE_LEG' && plan.actions[0].item.driverId === F.drvA, `scoped dry-run planned ${JSON.stringify(plan.actions.map((a) => a.action))}, expected one CREATE_LEG for A`)
  expect(plan.summary.LEG_MISSING === 1, `LEG_MISSING ${plan.summary.LEG_MISSING}`)
  const loadBefore = await getItem(ctx, 'Load', loadId)
  expect(!loadBefore.activeLoadCarrierId, 'the dry run changed the Load')
  await runScript(script, ['--apply', '--plan', planPath, ...scoped])
  const loadAfter = await getItem(ctx, 'Load', loadId)
  const newLegId = plan.actions[0].id
  ctx.owned.add(newLegId)
  expect(loadAfter.activeLoadCarrierId === newLegId, 'activeLoadCarrierId is not the created leg')
  const keys = new Set([...Object.keys(loadBefore), ...Object.keys(loadAfter)])
  const moved = [...keys].filter((k) => !['activeLoadCarrierId', 'updatedAt'].includes(k) && JSON.stringify(loadBefore[k] ?? null) !== JSON.stringify(loadAfter[k] ?? null))
  expect(moved.length === 0, `the apply changed other Load fields: ${moved.join(', ')}`)
  const created = await getItem(ctx, 'LoadCarrier', newLegId)
  expect(created?.kind === 'OWN_ASSET' && created.status === 'ACTIVE' && created.driverId === F.drvA && created.driverName === 'ZZ W Driver A', `created leg ${JSON.stringify(created)}`)
  await runScript(script, [...scoped, '--plan', join(dir, 'second.json')])
  plan = JSON.parse(await readFile(join(dir, 'second.json'), 'utf8'))
  expect(plan.actions.length === 0, `a second plan has ${plan.actions.length} actions`)
  // The unscoped dry-run: reads everything, writes nothing, exits 0.
  const unscopedPath = join(dir, 'unscoped.json')
  const stdout = await runScript(script, ['--suffix', DEV_SUFFIX, '--plan', unscopedPath])
  const all = JSON.parse(await readFile(unscopedPath, 'utf8'))
  expect(all.summary.VOIDED_OR_CANCELED > 0, `VOIDED_OR_CANCELED ${all.summary.VOIDED_OR_CANCELED}, expected > 0`)
  const foreign = (all.summary.report ?? []).filter((r) => r.class === 'NO_DRIVER_ANYWHERE' && !ctx.owned.has(r.loadId))
  expect(foreign.length === 0, `${foreign.length} live non-ZZ own-fleet loads have no driver anywhere`)
  expect(/Dry run|Plan written/.test(stdout), 'the unscoped run did not finish as a dry run')
  return `scoped: CREATE_LEG planned, applied (Load identical except activeLoadCarrierId/updatedAt), re-plan 0 actions; unscoped dry-run: VOIDED_OR_CANCELED ${all.summary.VOIDED_OR_CANCELED}, live driverless non-ZZ 0`
}

// ───────────────────────────── W10: UI walk ─────────────────────────────
/** The Load actions menu is a Radix dropdown: it opens on pointerdown, which a synthetic el.click() never fires. */
async function openLoadActions(b) {
  await b.poll(() => b.evaluate(`!!document.querySelector('.tms-main button[aria-label="Load actions"]')`), 'the Load actions button', 30_000)
  await b.click({ selector: '.tms-main button[aria-label="Load actions"]', real: true })
  await b.poll(() => b.evaluate(`!!document.querySelector('[role="menu"]')`), 'the Load actions menu', 10_000)
}

async function openAssignDialog(b) {
  await openLoadActions(b)
  await clickText(b, 'body', '[role="menuitem"]', 'Book Ivan Cartage|Change driver')
  await b.poll(() => hasTestId(b, 'assign-driver-select'), 'assign-driver-select', 20_000)
}

async function closeDialogs(b) {
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => {})
  await pause(300)
}

async function w10Walk(b, ctx, theme, ref) {
  const F = ctx.f
  const light = theme === 'light'
  await step(`W10-cover-dialog-${theme}`, async () => {
    await openShipment(b, F.batchOk.shipment.id)
    await clearAssignment(ctx, F.batchOk)
    await openShipment(b, F.batchOk.shipment.id)
    await openAssignDialog(b)
    const options = await b.evaluate(`[...document.querySelectorAll('${byTestId('assign-driver-select')} option')].map((o) => o.textContent.trim())`)
    expect(options.some((o) => /ZZ W Driver A/.test(o)) && !options.some((o) => /BROKER/i.test(o)), `roster options ${JSON.stringify(options.slice(0, 6))}`)
    expect(!options.some((o) => /ZZ W Driver Off/.test(o)), 'an inactive driver is in the roster dropdown')
    await setValue(b, byTestId('assign-driver-select'), F.drvA)
    await pause(400)
    await auditNow(b, theme, null)
    await snap(b, 'W10', 'cover-dialog-driver-picker', theme)
    return 'dialog lists the active non-broker roster; picking a driver fills the dialog'
  })
  await step(`W10-cover-dialog-relay-and-lock-${theme}`, async () => {
    await closeDialogs(b)
    await openShipment(b, F.relay.shipment.id)
    await openAssignDialog(b)
    await setValue(b, byTestId('assign-driver-select'), F.drvA)
    await pause(300)
    await auditNow(b, theme, null)
    await snap(b, 'W10', 'cover-dialog-relay-and-lock', theme)
    return 'cover dialog on the relay fixture'
  })
  await step(`W10-pay-lock-refusal-${theme}`, async () => {
    await closeDialogs(b)
    await openShipment(b, F.closed.shipment.id)
    await openAssignDialog(b)
    await setValue(b, byTestId('assign-driver-select'), F.drvA)
    await pause(300)
    expect(/pay week has closed|Give a reason/i.test(await bodyText(b)), 'the closed-week sentence / reason field is not shown')
    await snap(b, 'W10', 'pay-lock-refusal', theme)
    return 'closed-week dialog shows the §2.5 sentence / reason field'
  })
  await step(`W10-carrier-tab-own-asset-${theme}`, async () => {
    await closeDialogs(b)
    await openShipment(b, F.ivan.shipment.id, 'carrier')
    const text = await bodyText(b)
    expect(text.includes('ZZ W Driver Ivan'), 'Carrier tab does not show the driver name')
    expect(/Change driver/i.test(text), 'Carrier tab has no Change driver button')
    await auditNow(b, theme, ref)
    await snap(b, 'W10', 'carrier-tab-own-asset', theme)
    return 'Carrier tab: driver name + Change driver'
  })
  await step(`W10-carrier-tab-no-driver-${theme}`, async () => {
    await openShipment(b, F.driverlessUi.shipment.id, 'carrier', () => hasTestId(b, 'own-asset-no-driver'))
    await auditNow(b, theme, ref)
    await snap(b, 'W10', 'carrier-tab-no-driver', theme)
    return 'the no-driver banner (own-asset-no-driver) with Assign driver'
  })
  await step(`W10-inline-error-dispatch-${theme}`, async () => {
    await openShipment(b, F.driverlessUi.shipment.id, 'carrier', () => hasTestId(b, 'own-asset-no-driver'))
    await clickText(b, 'main', 'button', '^Dispatch').catch(() => {})
    const shown = await b.poll(() => hasTestId(b, 'dispatch-error'), 'dispatch-error', 15_000).catch(() => false)
    const disabled = await b.evaluate(`[...document.querySelectorAll('.tms-main button')].some((n) => /^Dispatch/.test(n.textContent.trim()) && n.disabled)`)
    expect(shown || disabled, 'neither an inline dispatch error nor a disabled Dispatch button with a reason')
    await snap(b, 'W10', 'inline-error-dispatch', theme)
    await closeDialogs(b)
    return shown ? 'inline dispatch-error shown' : 'Dispatch is disabled while no driver is booked'
  })
  await step(`W10-inline-error-delivered-${theme}`, async () => {
    // "Delivered" is only offered from Unloading; put the fixture there for this step and back to Booked after.
    const uiLoad = loadOf(F.driverlessUi).id
    await ownedUpdate(ctx, 'Load', uiLoad, { status: 'UNLOADING' })
    try {
      await openShipment(b, F.driverlessUi.shipment.id)
      await openLoadActions(b)
      await clickText(b, 'body', '[role="menuitem"]', '^(Delivered|DEL)$')
      await b.poll(() => hasTestId(b, 'load-action-error'), 'load-action-error', 20_000)
    } finally {
      await ownedUpdate(ctx, 'Load', uiLoad, { status: 'BOOKED' })
    }
    const t = await testIdText(b, 'load-action-error')
    expect(/pick the driver before marking it delivered/.test(t), `load-action-error says ${JSON.stringify(t)}`)
    await snap(b, 'W10', 'inline-error-delivered', theme)
    return 'the refused Delivered move shows the server text in load-action-error'
  })
  await step(`W10-inline-error-release-${theme}`, async () => {
    // The release card only runs the gate once the shipment is delivered, so the fixture is shown as delivered here.
    const shipmentId = F.driverlessUi.shipment.id
    ctx.owned.add(shipmentId)
    await ownedUpdate(ctx, 'Shipment', shipmentId, { status: 'DELIVERED' })
    try {
      await openShipment(b, shipmentId, 'invoicing')
      await b.poll(async () => /Missing driver/.test(await bodyText(b)), 'the release gate list with Missing driver', 45_000)
        .catch(async (err) => { throw new Error(`${err.message} (${await pageDiagnostics(b, 900)})`) })
      await snap(b, 'W10', 'inline-error-release', theme)
    } finally {
      await ownedUpdate(ctx, 'Shipment', shipmentId, { status: 'OPEN' })
    }
    return 'Invoicing tab lists "Missing driver" in the release gate'
  })
  await step(`W10-board-needs-driver-${theme}`, async () => {
    await openPage(b, '/tms/shipments')
    await boardSearch(b, F.driverlessUi.shipment.number)
    await b.poll(async () => /Own fleet · no driver/.test(await bodyText(b)), 'the "Own fleet · no driver" label', 60_000)
      .catch(async (err) => { throw new Error(`${err.message} (${await pageDiagnostics(b, 900)})`) })
    await auditNow(b, theme, ref)
    await snap(b, 'W10', 'board-needs-driver', theme)
    return 'board shows Own fleet · no driver'
  })
  if (!light) return
  await step('W10-batch-assign-driver', async () => {
    await openPage(b, '/tms/shipments')
    await boardSearch(b, F.driverlessUi.shipment.number)
    const box = `input[aria-label="Select row ${F.driverlessUi.shipment.id}"]`
    await b.poll(() => b.evaluate(`!!document.querySelector(${JSON.stringify(box)})`), 'the fixture row on the board', 60_000)
    await b.click({ selector: box, real: true })
    await b.click({ selector: 'button[aria-label="Batch task"]', real: true })
    await b.poll(() => b.evaluate(`!![...document.querySelectorAll('[role="dialog"] option')].find((n) => /Assign driver \\(Ivan Cartage\\)/.test(n.textContent))`), 'the "Assign driver (Ivan Cartage)" choice in the Batch task dialog', 20_000)
      .catch(async (err) => {
        const facts = await b.evaluate(`JSON.stringify({ dialogs: document.querySelectorAll('[role="dialog"]').length, options: [...document.querySelectorAll('[role="dialog"] option')].map((o) => o.textContent.trim()).map((t) => t.slice(0, 50)).slice(0, 14), title: document.querySelector('[role="dialog"]')?.innerText.slice(0, 120), checked: document.querySelector(${JSON.stringify(box)})?.checked, batchDisabled: document.querySelector('button[aria-label="Batch task"]')?.disabled })`)
        throw new Error(`${err.message} (${facts})`)
      })
    await snap(b, 'W10', 'batch-assign-driver', theme)
    await closeDialogs(b)
    return 'batch task dialog offers Assign driver (Ivan Cartage)'
  })
  await step('W10-draft-driver-row', async () => {
    const draft = await ctx.ship('CREATE_SHIPMENT', { customerId: ctx.customer.id })
    ctx.shipmentIds.add(draft.shipment.id)
    for (const load of draft.loads ?? []) ctx.owned.add(load.id)
    await openShipment(b, draft.shipment.id, null, () => hasTestId(b, 'draft-driver-row'))
    return 'the draft editor shows draft-driver-row'
  })
}

/** Narrow the Shipments board to one shipment by typing its number into the search box. */
async function boardSearch(b, text) {
  await b.poll(() => b.evaluate(`!!document.querySelector('.tms-main input[placeholder="Search"]')`), 'the board search box', 60_000)
  await setValue(b, '.tms-main input[placeholder="Search"]', text)
  await pause(800)
}

/** Put a one-driver fixture back to "no active leg" so the cover dialog opens on the first-assignment title. */
async function clearAssignment(ctx, bundle) {
  const fresh = await reload(ctx, bundle.shipment.id)
  const leg = activeLegOf(fresh)
  if (!leg || !ctx.owned.has(leg.id)) return
  await ctx.ship('REMOVE_LOAD_CARRIER', { loadCarrierId: leg.id, reason: 'OTHER', note: 'ZZ W harness' }).catch(() => {})
}

async function phonePass(b, ctx) {
  await b.command('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await b.setViewport(390, 844, 2)
  await step('W10-mobile-assign-driver', async () => {
    await openShipment(b, ctx.f.relay.shipment.id, 'carrier')
    b.mark(); await pause(700)
    const failures = [...problemList(b).slice(0, 3), ...await audit(b, 'light', { wideOk: true }), ...await wAudit(b)]
    const overflow = await b.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    if (overflow > 1) failures.push(`horizontal overflow ${overflow}px`)
    await openAssignDialog(b).catch(() => {})
    const dialogOverflow = await b.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    if (dialogOverflow > 1) failures.push(`dialog horizontal overflow ${dialogOverflow}px`)
    if (failures.length) throw new Error(failures.slice(0, 3).join(' | '))
    await walk.shot(b, 'W10', 'mobile-assign-driver', 'M', false)
    return 'no horizontal overflow at 390×844 on the Carrier tab and the dialog'
  })
  await b.setViewport(1600, 1000, 1)
}

// ───────────────────────────── W11: cleanup ─────────────────────────────
async function w11Cleanup(ctx) {
  const say = (msg, ok = true) => { console.log(`cleanup: ${msg}`); if (!ok) process.exitCode = 1; return ok }
  let allOk = true
  const token = ctx.token
  for (const id of ctx.shipmentIds) {
    try {
      const row = await getRow(token, 'Shipment', id, 'id updatedAt voidedAt')
      if (!row?.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: id, reason: VOID_REASON, expectedUpdatedAt: String(row?.updatedAt ?? '') })
      const after = await getRow(token, 'Shipment', id, 'voidedAt')
      allOk = say(`shipment ${id} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt) && allOk
    } catch (err) { allOk = say(`shipment ${id} void failed: ${String(err?.message ?? err).slice(0, 100)}`, false) && allOk }
  }
  // The void clears the driver mirrors: the ZZ loads leave Schedule / Calendar / pay.
  const stillOnDrivers = []
  for (const shipmentId of ctx.shipmentIds) {
    const bundle = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId }).catch(() => null)
    for (const load of bundle?.loads ?? []) {
      const item = await getItem(ctx, 'Load', load.id)
      if (item?.pickupDriverId || item?.deliveryDriverId) stillOnDrivers.push(load.id)
    }
  }
  allOk = say(`voided ZZ loads still carrying a driver mirror: ${stillOnDrivers.length}`, stillOnDrivers.length === 0) && allOk
  for (const id of ctx.tripIds) allOk = say(`BoxTruckTrip ${id} ${(await zzDelete(ctx, 'BoxTruckTrip', id)) ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`) && allOk
  // Legs this run's assignments created (tracked in ctx.owned): only ever on a Load this run created. A leg left behind on a
  // voided ZZ shipment is harmless, but one without createdBy/updatedBy once blanked every board, so none are kept.
  for (const id of [...ctx.owned].filter((x) => x.startsWith('lcr-'))) {
    const leg = await getItem(ctx, 'LoadCarrier', id)
    if (!leg) continue
    if (!ctx.owned.has(String(leg.loadId))) { allOk = say(`LoadCarrier ${id} is on a Load this run did not create: left alone`, false) && allOk; continue }
    await doc.send(new DeleteCommand({ TableName: devTable('LoadCarrier', ctx.suffix), Key: { id } }))
    allOk = say(`LoadCarrier ${id} ${(await getItem(ctx, 'LoadCarrier', id)) ? 'NOT confirmed deleted' : 'deleted and confirmed gone'}`, !(await getItem(ctx, 'LoadCarrier', id))) && allOk
  }
  for (const id of ctx.legIds) allOk = say(`LoadCarrier ${id} ${(await zzDelete(ctx, 'LoadCarrier', id)) ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`) && allOk
  for (const id of ctx.paySettingIds) {
    const gone = await zzDelete(ctx, 'DriverPaySetting', id)
    allOk = say(`DriverPaySetting ${id} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`, gone) && allOk
  }
  for (const id of ctx.driverIds) {
    const gone = await zzDelete(ctx, 'Driver', id)
    allOk = say(`Driver ${id} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`, gone) && allOk
  }
  for (const id of ctx.customerIds) {
    try {
      const row = await getRow(token, 'Customer', id, 'id updatedAt active')
      if (row && row.active !== false) await ctx.dir('ARCHIVE_CUSTOMER', { id, expectedUpdatedAt: String(row.updatedAt) })
      const after = await getRow(token, 'Customer', id, 'active')
      allOk = say(`customer ${id} ${after?.active === false ? 'archived and confirmed' : 'NOT confirmed archived'}`, after?.active === false) && allOk
    } catch (err) { allOk = say(`customer ${id} archive failed: ${String(err?.message ?? err).slice(0, 100)}`, false) && allOk }
  }
  const after = await payCounts(ctx)
  const diff = PAY_TABLES.filter((m) => after[m] !== ctx.payBefore[m])
  allOk = say(`real pay-table counts ${diff.length === 0 ? 'identical before and after' : `CHANGED: ${diff.map((m) => `${m} ${ctx.payBefore[m]} -> ${after[m]}`).join(', ')}`}`, diff.length === 0) && allOk
  let active = 0
  for (const id of ctx.shipmentIds) if (!(await getRow(token, 'Shipment', id, 'voidedAt').catch(() => null))?.voidedAt) active += 1
  allOk = say(`residue: ${active} unvoided ZZ W shipments`, active === 0) && allOk
  expect(allOk, 'cleanup left residue (see the cleanup lines above)')
  return `shipments voided, ZZ drivers / pay settings / trips removed, customer archived, six pay tables equal (${PAY_TABLES.map((m) => `${m} ${after[m]}`).join(', ')})`
}

// ───────────────────────────── runners ─────────────────────────────
const RUNNERS = {
  W01: w01Roster,
  W02: w02WriteThrough,
  W03: w03Legacy,
  W04: w04Settlement,
  W05: w05Change,
  W06: w06Gates,
  W07: w07PayLock,
  W08: w08Batch,
  W09: w09Backfill,
  W10: w10Walk,
  W11: w11Cleanup,
}

async function step(id, fn) {
  // Cleanup is never filtered out by --only: the fixtures are created whatever is run.
  if (!matches(id) && !id.startsWith('W11-')) return undefined
  try {
    const detail = await fn()
    if (detail !== undefined) line('PASS', id, typeof detail === 'string' ? detail : undefined)
    return detail
  } catch (err) {
    if (err instanceof SkipError) { skipLine(id, '', err.message); return undefined }
    line('FAIL', id, String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 1800))
    return undefined
  }
}

/** API steps in order; the UI-page steps that depend on a fixture state run in the walk between them. */
async function apiSteps(ctx, runUi) {
  const api = (id) => W_STEPS.find((s) => s.id === id)
  await step(`W01-${api('W01').slug}`, () => RUNNERS.W01(ctx))
  await step(`W02-${api('W02').slug}`, () => RUNNERS.W02(ctx))
  await step(`W03-${api('W03').slug}`, () => RUNNERS.W03(ctx))
  if (runUi) await runUi('legacy-before')
  await step(`W04-${api('W04').slug}`, () => RUNNERS.W04(ctx))
  await step('W04b-driver-app-settlement', () => w04bDriverApp())
  await step(`W05-${api('W05').slug}`, () => RUNNERS.W05(ctx))
  if (runUi) await runUi('legacy-after')
  await step('W05b-calendar-colour', () => w05bColour(ctx))
  await step('W03d-dispatch-panel', async () => { throw new SkipError('the harness does not write Dispatch conversation rows') })
  await step(`W06-${api('W06').slug}`, () => RUNNERS.W06(ctx))
  await step(`W07-${api('W07').slug}`, () => RUNNERS.W07(ctx))
  await step(`W08-${api('W08').slug}`, () => RUNNERS.W08(ctx))
  await step(`W09-${api('W09').slug}`, () => RUNNERS.W09(ctx))
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyW refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyW refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyW only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  if (!(await inventory())) { process.exitCode = 1; return }
  if (flag('inventory')) return

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const emails = { admin: `zz-w-admin-${ts}@example.invalid`, tms: `zz-w-tms-${ts}@example.invalid` }
  const made = []
  const ctx = {
    ts, origin, emails, suffix: null, f: {},
    owned: new Set(), shipmentIds: new Set(), driverIds: new Set(), paySettingIds: new Set(), tripIds: new Set(), legIds: new Set(), customerIds: new Set(),
    payBefore: null, legacyFixtures: null,
  }
  ctx.owned.add = ((orig) => function add(id) { orig.call(this, String(id)); return String(id) })(Set.prototype.add)
  ctx.poll = async (fn, label, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await pause(1500) } throw new Error(`timed out: ${label}`) }

  let b = null
  try {
    ctx.suffix = await discoverDevSuffix()
    console.log('dev table suffix discovered (ok)')
    ctx.payBefore = await payCounts(ctx)
    console.log(`pay tables (non-ZZ rows): ${JSON.stringify(ctx.payBefore)}`)

    const admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    const tms = await mintIdentity(emails.tms, ['page-tms']); made.push(emails.tms)
    console.log('identity: temporary staff identities created (admin, non-admin)')
    ctx.token = admin.token
    ctx.ship = routerAs(admin.token, 'tmsShipmentActions')
    ctx.shipTms = routerAs(tms.token, 'tmsShipmentActions')
    ctx.dir = routerAs(admin.token, 'tmsDirectoryActions')

    await buildFixtures(ctx)
    // A driverless own-asset fixture the UI walk can open (the API one is spent by W06).
    ctx.f.driverlessUi = await makeShipment(ctx, 'driverless-ui', chicagoDay(1), chicagoDay(2))
    const uiLoad = loadOf(ctx.f.driverlessUi).id
    // The state the old duplicate / backfill paths left: OWN_ASSET with an ACTIVE leg and nobody on it. (A load with no
    // leg at all has no Dispatch button; the leg is what the Dispatch gate, the release gate and the board flag read.)
    const uiLegId = `zz-w-lcr-ui-${ctx.ts}`
    await zzPut(ctx, 'LoadCarrier', {
      id: uiLegId, loadId: uiLoad, shipmentId: ctx.f.driverlessUi.shipment.id, kind: 'OWN_ASSET', status: 'ACTIVE', sequence: 1,
      carrierRateCents: 0, costCents: 0, createdBy: 'zz-w-harness', updatedBy: 'zz-w-harness',
    })
    ctx.legIds.add(uiLegId)
    await ownedUpdate(ctx, 'Load', uiLoad, { assignmentType: 'OWN_ASSET', status: 'BOOKED', activeLoadCarrierId: uiLegId })

    const needsBrowser = !only || /W03|W04|W05|W10/.test(only)
    if (needsBrowser) {
      b = await launchBrowser({ origin, storage: admin.storage, profilePrefix: 'bcat-w-', purpose: 'W verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
      await b.navigate('/dashboard')
      await waitLoaded(b).catch(() => {})
      await b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell sidebar mounted', 45_000)
    }
    const refs = {}
    const themes = flag('no-dark') ? ['light'] : ['light', 'dark']
    if (b) {
      for (const theme of ['light', 'dark']) { await setTheme(b, theme); refs[theme] = await b.evaluate(SHELL_FACTS) }
      await setTheme(b, 'light')
    }
    const runUi = async (phase) => {
      // The legacy-page steps read what W03 / W05 recorded; a filtered run that skipped them has nothing to walk.
      if (!b || !ctx.legacyFixtures || (phase !== 'legacy-before' && !ctx.legacyFixtures.changedTo)) return
      for (const theme of themes) {
        await setTheme(b, theme).catch(() => {})
        if (phase === 'legacy-before') await w03UiPages(b, ctx, theme, refs[theme])
        else await w05UiMoved(b, ctx, theme)
      }
      await setTheme(b, 'light').catch(() => {})
    }
    await apiSteps(ctx, runUi)

    if (b) {
      for (const theme of themes) {
        await setTheme(b, theme).catch(() => {})
        await w10Walk(b, ctx, theme, refs[theme])
      }
      await setTheme(b, 'light').catch(() => {})
      await phonePass(b, ctx)
    }
  } finally {
    if (b) await b.close().catch(() => {})
    if (ctx.token) await step('W11-cleanup', () => RUNNERS.W11(ctx)).catch(() => {})
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
  main().catch((err) => { console.error(`devVerifyW failed: ${err?.message ?? err}`); process.exit(1) })
}
