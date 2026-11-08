#!/usr/bin/env node
/**
 * Step AL verification against the DEV site: the Carrier Sales inbound offers hub on its SIMULATED mailbox and
 * simulated calls (no Google, no Anthropic dependency for the deterministic steps). Runs ONLY after the single AL deploy.
 *
 *   node scripts/devVerifyAL.mjs [--inventory] [--only=<substring>] [--no-ui] [--no-dark]
 *   DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyAL.mjs
 *   CARRIER_CALL_URL=<Function URL of the spot Lambda> node scripts/devVerifyAL.mjs      (enables the real webhook POSTs in AL06)
 *
 *   --inventory  no network, no browser: every AL id has a runner, every CS_* action and router action the harness calls is
 *                in the published contract / has a handler case, every data-testid the walk reads exists in source, the route
 *                is registered (aaRoutes + BrokeragePage), SKIP_ALLOWED names real steps. `node --check` is a separate command.
 *   --only=      run only the steps whose id contains the substring (fixtures are still seeded; cleanup always runs).
 *   --no-ui      skip the browser steps (AL09).
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool, any origin outside ALLOWED_ORIGINS
 * and any DynamoDB table that does not carry the dev suffix. No SSM. The mailbox is READ-ONLY: the harness only reads and
 * deletes ZZ rows. Everything it creates is named ZZ AL … / zz-al-… / ZZAL<n> and removed in `finally`: shipments voided
 * (their PROs are released again by a guarded delete of the ZZAL ProClaim rows this run claimed, so the fixed fixture PROs
 * work on the next run), quotes cancelled then deleted, ZZ messages deleted, the ZZ carrier / legs / postings deleted, the
 * `carrier-sales` config restored, the sim inbox purged, temporary identities deleted. Passwords, tokens, secrets and mail
 * content are never printed.
 *
 * Screenshots: Docs/tms-build/screenshots/al/<name>.png, listed in index.txt.
 *
 * Deviations from AL-plan §10 (recorded): screenshots go to screenshots/al/ (not al-proof/); AL09 runs before AL07 so the
 * offers it clicks are still open; the ZZ vetted carrier and the covered load's leg are seeded straight into the dev tables
 * (carriers become ACTIVE only through MyCarrierPackets, so UPSERT_CARRIER cannot make a bookable one); CS_VOICE_ROTATE_SECRET
 * replaces any dev voice secret that existed (restored config keeps the new hash: a secret cannot be put back).
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DynamoDBClient, DescribeTableCommand, DescribeTimeToLiveCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk } from './lib/uiWalk.mjs'

const DEV_APPSYNC = APPSYNC_URL_RE
const DEV_SUFFIX = STACK.tableSuffix
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const SHOTS = resolve('Docs/tms-build/screenshots/al')
const REGION = 'us-east-1'
const MAILBOX = 'zzal'
const UNMATCHED = 'UNMATCHED'
const AL_TABLES = ['SpotSettings', 'ShipmentMessage', 'ShipmentPosting', 'ProClaim', 'Quote', 'Carrier', 'Load', 'Shipment', 'LoadCarrier', 'Customer']

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /net::ERR_CERT_VERIFIER_CHANGED/, reason: 'headless Chrome re-reads its cert store mid-run; the request is retried by the client' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']
export const SKIP_ALLOWED = {
  'AL02-model': 'no usable Anthropic key (credit exhausted or the CAPACITY agent is off)',
  'AL06-webhook': 'CARRIER_CALL_URL is not set (the Function URL is a deploy output)',
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: SKIP_ALLOWED, only })
const { line, report, written, skipLine, problemList, waitLoaded, matches } = walk

// ───────────────────────────── step registry + static gates ─────────────────────────────
export const AL_STEPS = [
  { id: 'AL00', slug: 'preflight', ui: false },
  { id: 'AL01', slug: 'settings', ui: false },
  { id: 'AL02', slug: 'email-to-offer', ui: false },
  { id: 'AL03', slug: 'funnel-retention', ui: false },
  { id: 'AL04', slug: 'tiers', ui: false },
  { id: 'AL05', slug: 'assign-dismiss', ui: false },
  { id: 'AL06', slug: 'calls', ui: false },
  { id: 'AL07', slug: 'existing-actions', ui: false },
  { id: 'AL08', slug: 'read-only-authority', ui: false },
  { id: 'AL09', slug: 'ui', ui: true },
  { id: 'AL10', slug: 'cleanup', ui: false },
]

/** The data-testids this script reads (a trailing `-` is a prefix completed with an id), and the source file carrying each. */
export const TESTID_SOURCES = {
  'cs-offers-load-input': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offers-postings-list': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offers-load-card': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offers-table': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offer-carrier-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offer-rate-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offer-source-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offer-packet-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offer-risk-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offer-check-mcp-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offer-accept-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offer-counter-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-offer-reject-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-thread': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-thread-item-': 'src/features/tms/carrierSales/OffersHub.tsx',
  'cs-unmatched-table': 'src/features/tms/carrierSales/UnmatchedOffers.tsx',
  'cs-unmatched-row-': 'src/features/tms/carrierSales/UnmatchedOffers.tsx',
  'cs-unmatched-assign-': 'src/features/tms/carrierSales/UnmatchedOffers.tsx',
  'cs-unmatched-dismiss-': 'src/features/tms/carrierSales/UnmatchedOffers.tsx',
  'cs-unmatched-dismiss-confirm': 'src/features/tms/carrierSales/UnmatchedOffers.tsx',
  'cs-settings-page': 'src/features/tms/settings/CarrierSalesSettingsPage.tsx',
  'cs-settings-simulated-badge': 'src/features/tms/settings/CarrierSalesSettingsPage.tsx',
  'cs-settings-mailbox-': 'src/features/tms/settings/CarrierSalesSettingsPage.tsx',
  'cs-settings-voice-rotate': 'src/features/tms/settings/CarrierSalesSettingsPage.tsx',
  'cs-settings-voice-secret': 'src/features/tms/settings/CarrierSalesSettingsPage.tsx',
  'cs-settings-dev-panel': 'src/features/tms/settings/CarrierSalesSettingsPage.tsx',
}

const ROUTE_SOURCES = [
  ['scripts/lib/aaRoutes.mjs', "'/tms/brokerage/carrier-sales'"],
  ['src/features/tms/brokerage/BrokeragePage.tsx', 'path="carrier-sales"'],
]

const read = (file) => readFile(join(process.cwd(), file), 'utf8')

/** Router actions the harness may call, and the handler source that must carry a `case` for each. */
const ROUTER_ACTION_SOURCES = {
  'amplify/functions/tms-shipment-actions/handler.ts': /\b(?:ship|shipRep|shipNone)\(\s*'([A-Z_]+)'/g,
}

async function csContract() {
  const types = await read('src/lib/carrierInbox/types.ts')
  const block = /CS_ACTIONS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(types)?.[1] ?? ''
  return new Set([...block.matchAll(/'(CS_[A-Z_]+)'/g)].map((m) => m[1]))
}

/** Gates 1–5 (no network). Returns true when all pass. */
export async function inventory() {
  const runners = Object.keys(RUNNERS)
  const registered = AL_STEPS.map((s) => s.id)
  const missing = registered.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !registered.includes(id)))
  if (missing.length) { line('FAIL', 'gate 1: AL ids registered', `registry and runners disagree on: ${missing.join(', ')}`); return false }
  const orphanSkips = Object.keys(SKIP_ALLOWED).filter((k) => !registered.includes(k.split('-')[0]))
  if (orphanSkips.length) { line('FAIL', 'gate 1: AL ids registered', `SKIP_ALLOWED names no step: ${orphanSkips.join(', ')}`); return false }
  line('PASS', 'gate 1: AL ids registered', `${registered.length} steps (${registered.join(' ')}) each have a runner; skip-allowed: ${Object.keys(SKIP_ALLOWED).join(', ')}`)

  const self = await read('scripts/devVerifyAL.mjs')
  const called = new Set([...self.matchAll(/\b(?:csCall|csRep|csNone)\(\s*'(CS_[A-Z_]+)'/g)].map((m) => m[1]))
  const known = await csContract()
  const unknown = [...called].filter((a) => !known.has(a))
  if (!known.size || unknown.length) { line('FAIL', 'gate 2: harness calls only published CS_ actions', known.size ? `not in CS_ACTIONS: ${unknown.join(', ')}` : 'could not read CS_ACTIONS'); return false }
  const dispatch = await read('amplify/functions/tms-spot-quoter/carrierInbox/actions.ts')
  const unhandled = [...called].filter((a) => !new RegExp(`\\b${a}:\\s*\\w+`).test(dispatch))
  if (unhandled.length) { line('FAIL', 'gate 2: harness calls only published CS_ actions', `no handler for: ${unhandled.join(', ')}`); return false }
  const routerMissing = []
  let routerCount = 0
  for (const [file, re] of Object.entries(ROUTER_ACTION_SOURCES)) {
    const handler = await read(file)
    const names = new Set([...self.matchAll(re)].map((m) => m[1]))
    routerCount += names.size
    for (const a of names) if (!new RegExp(`case '${a}':`).test(handler)) routerMissing.push(a)
  }
  if (routerMissing.length) { line('FAIL', 'gate 2: harness calls only published CS_ actions', `no handler case for router actions: ${routerMissing.join(', ')}`); return false }
  line('PASS', 'gate 2: harness calls only published CS_ actions', `${called.size} CS_ actions (in CS_ACTIONS, handler present) and ${routerCount} router actions (handler case present)`)

  const gaps = []
  for (const [id, file] of Object.entries(TESTID_SOURCES)) {
    const text = await read(file).catch(() => '')
    if (!text.includes(id)) gaps.push(`${id} missing from ${file}`)
  }
  if (gaps.length) { line('FAIL', 'gate 3: data-testids the walk reads exist in source', gaps.join('; ')); return false }
  line('PASS', 'gate 3: data-testids the walk reads exist in source', `${Object.keys(TESTID_SOURCES).length} ids`)

  const routeGaps = []
  for (const [file, needle] of ROUTE_SOURCES) if (!(await read(file).catch(() => '')).includes(needle)) routeGaps.push(`${needle} missing from ${file}`)
  if (routeGaps.length) { line('FAIL', 'gate 4: the Settings route is registered', routeGaps.join('; ')); return false }
  line('PASS', 'gate 4: the Settings route is registered', '/tms/brokerage/carrier-sales in aaRoutes.mjs and BrokeragePage.tsx')

  const fixtures = await read('src/lib/carrierInbox/fixtures.ts')
  const missingFx = FIXTURE_IDS.filter((id) => !fixtures.includes(`mail('${id.slice(-2)}'`))
  if (missingFx.length) { line('FAIL', 'gate 5: fixtures the harness maps exist', missingFx.join(', ') || 'no fixtures'); return false }
  line('PASS', 'gate 5: fixtures the harness maps exist', `${FIXTURE_IDS.length} mapped fixture ids present in src/lib/carrierInbox/fixtures.ts`)
  return true
}

// ───────────────────────────── small helpers ─────────────────────────────
const asJson = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return v } })() : v)
const nowIso = () => new Date().toISOString()
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)
const sha1of = (text) => createHash('sha1').update(text).digest('hex').slice(0, 20)
const msgIdOf = (key) => `msg:cs:${sha1of(key)}`
class SkipError extends Error {}

async function refused(name, pattern, fn) {
  try { await fn() } catch (err) {
    if (pattern.test(String(err?.message ?? err))) return String(err.message).slice(0, 160)
    throw new Error(`${name} refused for the wrong reason: ${short(err)}`)
  }
  throw new Error(`${name} was allowed`)
}

const getRow = async (token, model, id, selection = 'id') => (await gql(token, `query($id: ID!) { get${model}(id: $id) { ${selection} } }`, { id }))[`get${model}`]

const MESSAGE_FIELDS = 'id shipmentId loadId kind channel subject from at providerRef ttlEpoch offer'
async function messagesOf(ctx, shipmentId) {
  const rows = []
  let next = null
  do {
    const r = await gql(ctx.token, `query($s: String!, $n: String) { listShipmentMessageByShipmentIdAndAt(shipmentId: $s, limit: 1000, nextToken: $n) { items { ${MESSAGE_FIELDS} } nextToken } }`, { s: shipmentId, n: next })
    rows.push(...r.listShipmentMessageByShipmentIdAndAt.items)
    next = r.listShipmentMessageByShipmentIdAndAt.nextToken
  } while (next)
  return rows.map((m) => ({ ...m, offer: asJson(asJson(m.offer)) }))
}
const messageById = async (ctx, id) => {
  const m = await getRow(ctx.token, 'ShipmentMessage', id, MESSAGE_FIELDS)
  return m ? { ...m, offer: asJson(asJson(m.offer)) } : null
}

// ───────────────────────────── safety + guarded SDK access ─────────────────────────────
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
async function scanAll(ctx, model, extra = {}) {
  const items = []
  let startKey
  do {
    const page = await doc.send(new ScanCommand({ TableName: devTable(model, ctx.suffix), ExclusiveStartKey: startKey, ...extra }))
    items.push(...(page.Items ?? []))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return items
}
/** Every SDK write/delete is to a row this run created (registered in ctx.owned) — never to anything else. */
const own = (ctx, model, id) => { ctx.owned.add(`${model}:${id}`); return id }
const owns = (ctx, model, id) => ctx.owned.has(`${model}:${id}`)
async function sdkPut(ctx, model, item) {
  if (!owns(ctx, model, item.id)) throw new Error(`refusing SDK write to ${model} ${String(item.id)}: not registered by this run`)
  await doc.send(new PutCommand({ TableName: devTable(model, ctx.suffix), Item: { __typename: model, createdAt: nowIso(), updatedAt: nowIso(), ...item } }))
}
async function sdkUpdate(ctx, model, id, patch) {
  if (!owns(ctx, model, id)) throw new Error(`refusing SDK update of ${model} ${id}: not created by this run`)
  const keys = Object.keys(patch)
  await doc.send(new UpdateCommand({
    TableName: devTable(model, ctx.suffix), Key: { id },
    UpdateExpression: `SET ${keys.map((k, i) => `#k${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(keys.map((k, i) => [`#k${i}`, k])),
    ExpressionAttributeValues: Object.fromEntries(keys.map((k, i) => [`:v${i}`, patch[k]])),
  }))
}
async function sdkDelete(ctx, model, id) {
  if (!owns(ctx, model, id)) throw new Error(`refusing SDK delete of ${model} ${id}: not created by this run`)
  await doc.send(new DeleteCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))
  return !(await doc.send(new GetCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))).Item
}

// ───────────────────────────── fixtures ─────────────────────────────
/** Fixture ids the expectations below are mapped for (src/lib/carrierInbox/fixtures.ts is the source of truth for the rest). */
const FIXTURE_IDS = ['zz-al-f01', 'zz-al-f02', 'zz-al-f03', 'zz-al-f04', 'zz-al-f05', 'zz-al-f06', 'zz-al-f07', 'zz-al-f08', 'zz-al-f09', 'zz-al-f10', 'zz-al-f11', 'zz-al-f12', 'zz-al-f13', 'zz-al-f14', 'zz-al-f15']

/** Fixture module (types are erased by the Node loader the other harnesses already rely on), else a hard failure. */
async function loadFixtures() {
  const mod = await import(pathToFileURL(resolve('src/lib/carrierInbox/fixtures.ts')).href)
  const mails = mod.CARRIER_INBOX_MAIL_FIXTURES
  const calls = mod.CARRIER_INBOX_CALL_FIXTURES
  if (!Array.isArray(mails) || !mails.length || !Array.isArray(calls) || !calls.length) throw new Error('src/lib/carrierInbox/fixtures.ts exports no fixtures')
  return { mails, calls, refs: mod.AL_FIXTURE_REFS, address: mod.FIXTURE_DISTRIBUTION_ADDRESS }
}

// Which seeded load each mail fixture is about (the fixture header documents the same mapping).
const FIXTURE_LOAD = {
  'zz-al-f01': 'open', 'zz-al-f10': 'open', 'zz-al-f12': 'open', 'zz-al-f02': 'boardPost', 'zz-al-f14': 'forwarded',
  'zz-al-f05': 'inquiry', 'zz-al-f07': 'inquiry', 'zz-al-f15': 'inquiry', 'zz-al-f06': 'covered', 'zz-al-f03': 'lane',
}

async function inject(ctx, fixtureId, extra = {}) {
  return ctx.csCall('CS_SIM_INJECT_MAIL', { mailboxId: MAILBOX, fixtureId, ...extra })
}
async function injectCustom(ctx, base, id, devExtraction, extra = {}) {
  const message = { ...base.message, id, messageId: `<${id}@carrier.example.invalid>`, ...extra }
  ctx.extraMessageIds.add(msgIdOf(message.messageId))
  return ctx.csCall('CS_SIM_INJECT_MAIL', { mailboxId: MAILBOX, message, ...(devExtraction ? { devExtraction } : {}) })
}

const ZERO = () => ({ listed: 0, wrongMailbox: 0, stage1Rejected: 0, stage2Rejected: 0, modelCalls: 0, notOffer: 0, filed: 0, threadOnly: 0, coveredLate: 0, suggested: 0, unmatched: 0, duplicate: 0, errors: 0, abandoned: 0, held: 0, deferred: 0 })
/** A manual poll stops itself before AppSync's 30 s limit; loop (cap 15) until done and add the counters up. */
async function poll(ctx) {
  const total = ZERO()
  for (let i = 0; i < 15; i++) {
    const r = await ctx.csCall('CS_POLL_NOW', { mailboxId: MAILBOX })
    for (const [k, v] of Object.entries(r.stats ?? {})) if (typeof v === 'number') total[k] = (total[k] ?? 0) + v
    if (r.done) return { ...total, reason: r.reason ?? null }
  }
  return { ...total, reason: 'NOT_DONE' }
}

const csStatus = (ctx) => ctx.csCall('CS_STATUS', {})
async function saveConfig(ctx, patch) {
  const s = await csStatus(ctx)
  const config = { ...s.config, ...patch, voice: { ...s.config.voice, ...(patch.voice ?? {}) } }
  delete config.version
  return ctx.csCall('CS_SAVE_SETTINGS', { config, expectedVersion: s.config.version })
}

// ───────────────────────────── seeding (AL00) ─────────────────────────────
const BOOKING_ACKS = [
  'MISSING_DOC:COI_CARGO', 'MISSING_DOC:COI_AUTO', 'MISSING_DOC:W9', 'MISSING_DOC:CARRIER_AGREEMENT', 'INSURANCE_UNVERIFIED',
  'MISSING_REQUIRED_FIELD:COMMODITY', 'MISSING_REQUIRED_FIELD:DESCRIPTION', 'MISSING_REQUIRED_FIELD:VALUE', 'MISSING_REQUIRED_FIELD:WEIGHT',
]

const stopsFor = (label, pickupDate, lane) => ([
  { type: 'pickup', name: `ZZ AL Shipper ${label}`, city: `${lane.o[0]}, ${lane.o[1]}`, address: { city: lane.o[0], state: lane.o[1], zip: lane.o[2] }, appt: `${pickupDate}T13:00:00.000Z` },
  { type: 'delivery', name: `ZZ AL Receiver ${label}`, city: `${lane.d[0]}, ${lane.d[1]}`, address: { city: lane.d[0], state: lane.d[1], zip: lane.d[2] }, appt: `${new Date(Date.parse(`${pickupDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T23:00:00.000Z` },
])
const CHI_DAL = { o: ['Chicago', 'IL', '60601'], d: ['Dallas', 'TX', '75201'] }
const JOLIET_FW = { o: ['Joliet', 'IL', '60435'], d: ['Fort Wayne', 'IN', '46802'] }

async function makeShipment(ctx, key, pro, lane, { post = false, postingRef = null } = {}) {
  let b = await ctx.ship('CREATE_SHIPMENT', { customerId: ctx.customerId, pro })
  const id = b.shipment.id
  ctx.shipmentIds.add(id)
  b = await ctx.ship('SAVE_ORDER_FORM', {
    shipmentId: id, expectedUpdatedAt: b.shipment.updatedAt,
    order: { mode: 'FTL', equipmentType: 'Dry Van' },
    stops: stopsFor(key, ctx.refs.pickupDate, lane),
    charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 }],
    loadFields: { miles: 925, weight: 40000, commodity: 'ZZ AL verification freight' },
  })
  await ctx.ship('SUBMIT_ORDER', { shipmentId: id, expectedUpdatedAt: b.shipment.updatedAt })
  b = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: id })
  const loadId = b.loads[0].id
  const claim = await getRow(ctx.token, 'ProClaim', pro, 'id loadId shipmentId')
  expect(claim?.loadId === loadId, `PRO ${pro} is not claimed by the ZZ load just created (claim: ${claim ? 'other load' : 'none'})`)
  own(ctx, 'ProClaim', pro)
  ctx.seeded[key] = { key, pro, shipmentId: id, loadId }
  if (post) {
    await ctx.ship('POST_LOAD', { shipmentId: id, providers: ['DAT'], rateCents: key === 'lane' ? 170000 : 200000, contactEmail: ctx.address })
    const postingId = `post:${id}:DAT`
    own(ctx, 'ShipmentPosting', postingId)
    const row = await getRow(ctx.token, 'ShipmentPosting', postingId, 'id status boardPostingId offerCount')
    expect(row && row.status === 'POSTED', `POST_LOAD left posting ${postingId} ${row?.status ?? 'missing'}, expected POSTED`)
    if (postingRef) await sdkUpdate(ctx, 'ShipmentPosting', postingId, { boardPostingId: postingRef })
    ctx.seeded[key].postingId = postingId
    ctx.seeded[key].offerCount0 = Number(row.offerCount ?? 0)
  }
  return ctx.seeded[key]
}

async function seedVettedCarrier(ctx) {
  const mc = ctx.refs.vettedMc
  const found = await gql(ctx.token, 'query($f: ModelCarrierFilterInput) { listCarriers(filter: $f, limit: 50) { items { id name status } } }', { f: { mcNumber: { eq: mc } } })
  expect(found.listCarriers.items.length === 0, `a carrier with MC ${mc} already exists (${found.listCarriers.items[0]?.name}); remove the stale ZZ carrier first`)
  const id = own(ctx, 'Carrier', `car-zzal-${ctx.ts}`)
  const at = nowIso()
  const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString()
  await sdkPut(ctx, 'Carrier', {
    id, name: ctx.refs.vettedName, normalizedName: ctx.refs.vettedName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), type: 'TL', status: 'ACTIVE',
    mcNumber: mc, mcpStatus: 'ACCEPTABLE', mcpRiskScore: 12,
    dispatcherEmail: 'dispatch@carrier.example.invalid', accountingEmail: 'dispatch@carrier.example.invalid',
    insurancePolicies: [
      { type: 'AUTO_LIABILITY', company: 'ZZ Mutual', policyNumber: `AL-${ctx.ts}`, limitCents: 100_000_000, expiresAt: nextYear },
      { type: 'CARGO', company: 'ZZ Mutual', policyNumber: `CG-${ctx.ts}`, limitCents: 10_000_000, expiresAt: nextYear },
    ],
    createdBy: 'zz-al', updatedBy: 'zz-al', createdAt: at, updatedAt: at,
  })
  ctx.carrierId = id
  return id
}

/** The covered load: a real LoadCarrier row and the Load/Shipment mirrors, exactly what a booking leaves (devVerifyAM precedent). */
async function seedCoveredLeg(ctx) {
  const s = ctx.seeded.covered
  const lcId = own(ctx, 'LoadCarrier', `lc-zzal-${ctx.ts}`)
  const at = nowIso()
  await sdkPut(ctx, 'LoadCarrier', {
    id: lcId, loadId: s.loadId, shipmentId: s.shipmentId, kind: 'CARRIER', status: 'ACTIVE', sequence: 1,
    carrierId: ctx.carrierId, carrierName: ctx.refs.vettedName, carrierMc: ctx.refs.vettedMc, carrierRateCents: 150_000,
    assignmentStatus: 'ASSIGNED_SETUP_PENDING', createdBy: 'zz-al', updatedBy: 'zz-al', createdAt: at, updatedAt: at,
  })
  own(ctx, 'Load', s.loadId)
  own(ctx, 'Shipment', s.shipmentId)
  await sdkUpdate(ctx, 'Load', s.loadId, { status: 'BOOKED', assignmentType: 'CARRIER', activeLoadCarrierId: lcId, carrierName: ctx.refs.vettedName })
  await sdkUpdate(ctx, 'Shipment', s.shipmentId, { status: 'BOOKED' })
  ctx.legId = lcId
}

// ───────────────────────────── steps ─────────────────────────────
async function al00Preflight(ctx) {
  const status = await csStatus(ctx)
  expect(status.devStack === true, 'CS_STATUS.devStack is not true: this is not the dev stack, refusing')
  ctx.status0 = status
  ctx.config0 = status.config
  const notes = [`Google provider ${status.gmailProvider?.mode} (the SIMULATED mailbox needs no Google)`]
  for (const model of AL_TABLES) await ddb.send(new DescribeTableCommand({ TableName: devTable(model, ctx.suffix) })).catch(() => { throw new Error(`table ${model} is not reachable`) })
  notes.push(`${AL_TABLES.length} tables reachable`)
  const ttl = await ddb.send(new DescribeTimeToLiveCommand({ TableName: devTable('ShipmentMessage', ctx.suffix) }))
  const st = ttl.TimeToLiveDescription?.TimeToLiveStatus
  expect(st === 'ENABLED' || st === 'ENABLING', `ShipmentMessage TTL is ${st}`)
  expect(ttl.TimeToLiveDescription?.AttributeName === 'ttlEpoch', `ShipmentMessage TTL attribute is ${ttl.TimeToLiveDescription?.AttributeName}, expected ttlEpoch`)
  notes.push('ShipmentMessage TTL ENABLED on ttlEpoch')
  const row = await doc.send(new GetCommand({ TableName: devTable('SpotSettings', ctx.suffix), Key: { id: 'default' } }))
  notes.push(`SpotSettings readable (${row.Item ? 'default row present' : 'no default row'})`)

  // Stale ZZAL PRO claims from an aborted earlier run: released only when the shipment behind them is a voided ZZ AL one.
  for (const pro of Object.values(ctx.refs).filter((v) => /^ZZAL\d{4}$/.test(String(v)))) {
    const claim = await doc.send(new GetCommand({ TableName: devTable('ProClaim', ctx.suffix), Key: { id: pro } })).then((r) => r.Item)
    if (!claim) continue
    const ship = claim.shipmentId ? await getRow(ctx.token, 'Shipment', claim.shipmentId, 'id voidedAt customerName') : null
    expect(ship?.voidedAt && /^ZZ AL /.test(String(ship.customerName ?? '')), `PRO ${pro} is claimed by a live or non-ZZ shipment: refusing to touch it`)
    own(ctx, 'ProClaim', pro)
    await sdkDelete(ctx, 'ProClaim', pro)
    ctx.owned.delete(`ProClaim:${pro}`)
  }
  notes.push('ZZAL PROs free')

  const customer = await ctx.dir('UPSERT_CUSTOMER', {
    name: `ZZ AL Customer ${ctx.ts}`, status: 'ACTIVE', mcNumber: `8${String(ctx.ts).slice(-6)}`, billingEmail: 'al-verification@example.invalid',
    creditLimitCents: 500_000_000, paymentTermsDays: 30, notes: 'Dev-only Step AL verification fixture. Safe to delete.',
  }).then((r) => r.customer ?? r)
  ctx.customerId = String(customer.id)
  ctx.customerIds.add(ctx.customerId)

  await seedVettedCarrier(ctx)
  const R = ctx.refs
  await makeShipment(ctx, 'open', R.open, CHI_DAL, { post: true })
  await makeShipment(ctx, 'boardPost', R.boardPost, CHI_DAL, { post: true, postingRef: R.postingRef })
  await makeShipment(ctx, 'lane', R.lane, JOLIET_FW, { post: true })
  await makeShipment(ctx, 'inquiry', R.inquiry, CHI_DAL)
  await makeShipment(ctx, 'covered', R.covered, CHI_DAL)
  await makeShipment(ctx, 'forwarded', R.forwarded, CHI_DAL)
  await seedCoveredLeg(ctx)
  expect(!(await getRow(ctx.token, 'ProClaim', R.missing, 'id')), `PRO ${R.missing} exists but must not (it is the "model invented a PRO" fixture)`)
  notes.push('ZZ fixtures: 3 posted shipments (open, board-posted, lane), inquiry, forwarded, covered (leg seeded), 1 vetted ZZ carrier, a PRO that does not exist')
  return notes.join('; ')
}

async function al01Settings(ctx) {
  const notes = []
  await refused('CS_CONNECT_SIMULATED as a rep', /Forbidden|requires owner or ADMIN/i, () => ctx.csRep('CS_CONNECT_SIMULATED', { mailboxId: MAILBOX }))
  notes.push('simulated connect refused to a non-admin')
  const c = await ctx.csCall('CS_CONNECT_SIMULATED', { mailboxId: MAILBOX })
  expect(c.ok === true, 'CS_CONNECT_SIMULATED did not answer ok')
  ctx.cfgSaved = true
  let s = await csStatus(ctx)
  expect(s.state.mailboxes[MAILBOX]?.status === 'SIMULATED', `mailbox state is ${s.state.mailboxes[MAILBOX]?.status}, expected SIMULATED`)
  expect(s.config.mailboxes.some((m) => m.id === MAILBOX && m.addresses.includes(ctx.address)), `the simulated mailbox does not listen for ${ctx.address}`)
  notes.push('admin connected the simulated mailbox')

  await refused('floor on the auto-file threshold', /Auto-file threshold|between|0\.8/i, () => saveConfig(ctx, { enabled: true, autoFileMinScore: 0.5 }))
  await refused('floor on the retention days', /retention/i, () => saveConfig(ctx, { enabled: true, unmatchedRetentionDays: 1 }))
  notes.push('floors refused (auto-file 0.5, retention 1 day)')
  const stale = s.config.version
  await saveConfig(ctx, { enabled: true })
  await refused('stale CAS version', /changed since you opened|reload/i, () => ctx.csCall('CS_SAVE_SETTINGS', { config: { ...s.config, enabled: true }, expectedVersion: stale }))
  notes.push('CAS refuses a stale version')
  await saveConfig(ctx, { voice: { enabled: true } })

  const rotated = await ctx.csCall('CS_VOICE_ROTATE_SECRET', {})
  expect(typeof rotated.secret === 'string' && rotated.secret.length >= 32, 'CS_VOICE_ROTATE_SECRET returned no secret')
  ctx.voiceSecret = rotated.secret
  s = await csStatus(ctx)
  const blob = JSON.stringify(s)
  expect(!blob.includes(rotated.secret), 'CS_STATUS returned the plaintext voice secret')
  expect(!/secretHash|pendingStateHash|pendingStateExp/.test(blob), 'CS_STATUS leaked secretHash / pendingState fields')
  expect(s.config.voice.hasSecret === true, 'CS_STATUS does not say a secret exists')
  const stored = await doc.send(new GetCommand({ TableName: devTable('SpotSettings', ctx.suffix), Key: { id: 'carrier-sales' } })).then((r) => r.Item)
  expect(!JSON.stringify(stored ?? {}).includes(rotated.secret), 'the plaintext secret is stored in SpotSettings')
  notes.push('the secret is returned once, never in CS_STATUS or at rest (hash only)')
  ctx.cfgSaved = true
  return notes.join('; ')
}

const quotesOf = async (ctx, key) => (await ctx.ship('LIST_CARRIER_OFFERS', { shipmentId: ctx.seeded[key].shipmentId })).offers ?? []
const quoteFor = (offers, msgId) => offers.find((q) => q.offerMessageRef === msgId) ?? null

function expectFiled(ctx, fx, offers, msgs) {
  const mid = msgIdOf(fx.message.messageId)
  const q = quoteFor(offers, mid)
  expect(q, `${fx.id}: no BUY quote points at message ${mid}`)
  expect(q.side === 'BUY' && q.status === 'RECEIVED_REPLY', `${fx.id}: quote is ${q.side}/${q.status}`)
  expect(msgs.some((m) => m.id === mid && m.kind === 'CARRIER_OFFER' && m.offer?.match?.state === 'MATCHED'), `${fx.id}: no MATCHED CARRIER_OFFER message on the load`)
  return q
}

async function al02Email(ctx) {
  const ids = ['zz-al-f01', 'zz-al-f02', 'zz-al-f14']
  for (const id of ids) await inject(ctx, id)
  const stats = await poll(ctx)
  expect(stats.errors === 0, `poll reported ${stats.errors} errors`)
  expect(stats.listed >= 3 && stats.filed === 3, `poll listed ${stats.listed}, filed ${stats.filed}; expected 3 filed`)
  const out = []
  for (const id of ids) {
    const fx = ctx.mailFx(id)
    const key = FIXTURE_LOAD[id]
    const offers = await quotesOf(ctx, key)
    const msgs = await messagesOf(ctx, ctx.seeded[key].shipmentId)
    const q = expectFiled(ctx, fx, offers, msgs)
    const want = id === 'zz-al-f02' ? 'BOARD' : 'EMAIL'
    expect(q.offerSource === want, `${id}: offerSource ${q.offerSource}, expected ${want}`)
    const post = ctx.seeded[key].postingId ? await getRow(ctx.token, 'ShipmentPosting', ctx.seeded[key].postingId, 'offerCount') : null
    if (post) expect(Number(post.offerCount ?? 0) > ctx.seeded[key].offerCount0, `${id}: posting offerCount did not rise (${ctx.seeded[key].offerCount0} -> ${post.offerCount})`)
    out.push(`${id.slice(6)} ${q.offerSource} $${(q.amountCents / 100).toFixed(0)}`)
  }
  const digest = (await csStatus(ctx)).state.runs?.[0]
  expect(digest && digest.stats, 'the run digest has no stats')
  return `filed ${out.join(', ')}; counters listed ${stats.listed} filed ${stats.filed}; digest recorded`
}

async function al02Model(ctx) {
  const base = ctx.mailFx('zz-al-f01')
  await injectCustom(ctx, base, 'zz-al-x4', null)
  const stats = await poll(ctx)
  if (stats.modelCalls === 0 || stats.errors > 0 || stats.deferred > 0) throw new SkipError(`the real model did not answer (modelCalls ${stats.modelCalls}, errors ${stats.errors}, deferred ${stats.deferred})`)
  expect(stats.filed + stats.coveredLate + stats.duplicate + stats.suggested + stats.unmatched + stats.threadOnly + stats.notOffer >= 1, 'the real model answered but the message ended nowhere')
  return `real model: ${stats.modelCalls} call(s); filed ${stats.filed} duplicate ${stats.duplicate} coveredLate ${stats.coveredLate} suggested ${stats.suggested} unmatched ${stats.unmatched}`
}

async function al03Funnel(ctx) {
  for (const id of ['zz-al-f08', 'zz-al-f09', 'zz-al-f10']) await inject(ctx, id)
  const lowValue = ctx.mailFx('zz-al-f01')
  await injectCustom(ctx, lowValue, 'zz-al-x3', null, { subject: 'Thanks and have a great week', body: 'Hello team, thanks for everything. Talk soon.', snippet: 'Hello team' })
  const s1 = await poll(ctx)
  expect(s1.errors === 0, `poll reported ${s1.errors} errors`)
  expect(s1.stage1Rejected >= 1, `stage 1 rejected ${s1.stage1Rejected}, expected the newsletter (F8)`)
  expect(s1.stage2Rejected >= 1, `stage 2 rejected ${s1.stage2Rejected}, expected the price-less mail`)
  expect(s1.notOffer >= 1, `notOffer ${s1.notOffer}, expected the invoice (F9)`)
  for (const key of ['zz-al-f08', 'zz-al-f09']) {
    const mid = msgIdOf(ctx.mailFx(key).message.messageId)
    expect(!(await messageById(ctx, mid)), `${key}: a message row exists for mail that must be dropped`)
  }
  expect(!(await messageById(ctx, msgIdOf('<zz-al-x3@carrier.example.invalid>'))), 'the stage-2 reject was stored')
  const open = ctx.seeded.open
  const offers = await quotesOf(ctx, 'open')
  const q10 = quoteFor(offers, msgIdOf(ctx.mailFx('zz-al-f10').message.messageId))
  expect(q10 && q10.amountCents === 172500, 'F10 did not file its real $1,725 offer')
  expect(offers.every((q) => q.amountCents > 100 && q.status !== 'WON'), 'the prompt-injection mail produced a $1 / WON / accepted effect')
  const msgs = await messagesOf(ctx, open.shipmentId)
  expect(msgs.length === new Set(msgs.map((m) => m.id)).size, 'duplicate message ids on the load')
  const before = offers.length
  await inject(ctx, 'zz-al-f11')
  const s2 = await poll(ctx)
  expect(s2.duplicate >= 1, `re-delivery (F11) counted ${s2.duplicate} duplicates`)
  expect((await quotesOf(ctx, 'open')).length === before, 'the re-delivered mail created another offer')
  const f1 = (await messagesOf(ctx, open.shipmentId)).filter((m) => m.id === msgIdOf(ctx.mailFx('zz-al-f01').message.messageId))
  expect(f1.length === 1, `F1 has ${f1.length} message rows after re-delivery`)
  return `stage1 ${s1.stage1Rejected}, stage2 ${s1.stage2Rejected}, notOffer ${s1.notOffer} dropped with no row; F10 injection filed only its real offer; F11 re-delivery deduped (${s2.duplicate})`
}

async function al04Tiers(ctx) {
  const ids = ['zz-al-f03', 'zz-al-f04', 'zz-al-f13', 'zz-al-f05', 'zz-al-f06', 'zz-al-f07', 'zz-al-f15']
  for (const id of ids) await inject(ctx, id)
  const s = await poll(ctx)
  expect(s.errors === 0, `poll reported ${s.errors} errors`)
  const bucket = await messagesOf(ctx, UNMATCHED)
  const row = (id) => bucket.find((m) => m.id === msgIdOf(ctx.mailFx(id).message.messageId))
  const f3 = row('zz-al-f03')
  expect(f3 && f3.offer.match.state === 'SUGGESTED', `F3 is ${f3?.offer?.match?.state ?? 'absent'} in the bucket, expected SUGGESTED`)
  expect(f3.offer.match.top?.shipmentId === ctx.seeded.lane.shipmentId, 'F3 suggests the wrong load')
  expect(f3.offer.match.score < ctx.status0.config.autoFileMinScore, `F3 scored ${f3.offer.match.score}: lane + date must never reach the auto-file threshold`)
  expect(Number(f3.ttlEpoch) > Date.now() / 1000, 'F3 has no future ttlEpoch')
  for (const id of ['zz-al-f04', 'zz-al-f13']) {
    const r = row(id)
    expect(r && r.offer.match.state === 'UNMATCHED' && !r.offer.match.top, `${id}: ${r?.offer?.match?.state ?? 'absent'} with top ${r?.offer?.match?.top ? 'set' : 'none'}, expected UNMATCHED with no suggestion`)
  }
  expect((await quotesOf(ctx, 'lane')).length === 0, 'F3 (lane + date only) created a Quote')
  const inquiry = await messagesOf(ctx, ctx.seeded.inquiry.shipmentId)
  const inquiryOffers = await quotesOf(ctx, 'inquiry')
  for (const id of ['zz-al-f05', 'zz-al-f07', 'zz-al-f15']) {
    const mid = msgIdOf(ctx.mailFx(id).message.messageId)
    expect(inquiry.some((m) => m.id === mid && m.offer?.match?.state === 'MATCHED'), `${id}: not on the inquiry load's thread`)
    expect(!quoteFor(inquiryOffers, mid), `${id}: a thread-only message created a Quote`)
  }
  const f15 = inquiry.find((m) => m.id === msgIdOf(ctx.mailFx('zz-al-f15').message.messageId))
  expect(f15.offer.extraction.flags.includes('RATE_INVALID') && f15.offer.extraction.kind === 'INTEREST', 'F15 is not RATE_INVALID demoted to INTEREST')
  const covered = await messagesOf(ctx, ctx.seeded.covered.shipmentId)
  const f6 = covered.find((m) => m.id === msgIdOf(ctx.mailFx('zz-al-f06').message.messageId))
  expect(f6 && f6.offer.match.state === 'COVERED_LATE', `F6 is ${f6?.offer?.match?.state ?? 'absent'}, expected COVERED_LATE`)
  expect((await quotesOf(ctx, 'covered')).length === 0, 'the covered load got a Quote from a late offer')
  return `F3 suggested (${f3.offer.match.score}) no quote; F4/F13 unmatched; F5/F7/F15 thread-only (F15 RATE_INVALID); F6 covered-late, no quote; counters suggested ${s.suggested} unmatched ${s.unmatched} threadOnly ${s.threadOnly} coveredLate ${s.coveredLate}`
}

async function al05Assign(ctx) {
  const f13 = msgIdOf(ctx.mailFx('zz-al-f13').message.messageId)
  const before = (await messagesOf(ctx, UNMATCHED)).length
  const target = ctx.seeded.inquiry
  const res = await ctx.shipRep('ASSIGN_INBOUND_OFFER', { messageId: f13, shipmentId: target.shipmentId })
  expect(res.shipmentId === target.shipmentId && res.quoteId, `ASSIGN answered ${JSON.stringify(res).slice(0, 160)}`)
  const row = await messageById(ctx, f13)
  expect(row && row.shipmentId === target.shipmentId, 'the assigned row was not re-parented')
  expect(row.ttlEpoch == null, 'ttlEpoch is still set on an assigned row')
  expect(row.offer.match.state === 'ASSIGNED', `match.state is ${row.offer.match.state}`)
  const q = quoteFor(await quotesOf(ctx, 'inquiry'), f13)
  expect(q && q.side === 'BUY', 'assign created no BUY quote')
  expect((await messagesOf(ctx, UNMATCHED)).length === before - 1, 'the bucket did not shrink by one')
  await refused('a second assign', /UNMATCHED|no longer|already|not found/i, () => ctx.shipRep('ASSIGN_INBOUND_OFFER', { messageId: f13, shipmentId: target.shipmentId }))

  await injectCustom(ctx, ctx.mailFx('zz-al-f04'), 'zz-al-x1', ctx.mailFx('zz-al-f04').devExtraction, { subject: 'Anything out of Chicago? (second ask)' })
  await poll(ctx)
  const x1 = msgIdOf('<zz-al-x1@carrier.example.invalid>')
  expect((await messageById(ctx, x1))?.shipmentId === UNMATCHED, 'the dismiss fixture did not reach the bucket')
  await ctx.ship('DISMISS_INBOUND_OFFER', { messageId: x1, reason: 'step AL verification' })
  expect(!(await messageById(ctx, x1)), 'DISMISS left the row')
  await refused('dismissing a filed (matched) message', /UNMATCHED|not|matched|Unmatched/i, () => ctx.ship('DISMISS_INBOUND_OFFER', { messageId: f13 }))
  return `rep assigned F13 -> ${target.pro} (quote made, ttlEpoch gone, bucket ${before} -> ${before - 1}); second assign refused; dismiss deleted a bucket row and refuses a filed one`
}

async function al06Calls(ctx) {
  const r1 = await ctx.csCall('CS_SIM_INJECT_CALL', { fixtureId: 'zz-al-f16' })
  expect(r1.outcome === 'FILED', `F16 outcome ${r1.outcome}, expected FILED`)
  const callMsg = msgIdOf(ctx.calls[0].call.callSid)
  ctx.extraMessageIds.add(callMsg)
  const row = await messageById(ctx, callMsg)
  expect(row && row.channel === 'VOICE' && row.shipmentId === ctx.seeded.open.shipmentId, `F16 message: ${row ? `${row.channel} on ${row.shipmentId === ctx.seeded.open.shipmentId ? 'the open load' : 'another load'}` : 'absent'}`)
  const q = quoteFor(await quotesOf(ctx, 'open'), callMsg)
  expect(q && q.offerSource === 'PHONE', `the call offer's source is ${q?.offerSource}, expected PHONE`)
  const r2 = await ctx.csCall('CS_SIM_INJECT_CALL', { fixtureId: 'zz-al-f17' })
  expect(r2.outcome === 'DUPLICATE', `F17 replay outcome ${r2.outcome}, expected DUPLICATE`)
  return 'call filed as a PHONE offer + VOICE message; the replay is a duplicate'
}

async function al06Webhook(ctx) {
  const url = process.env.CARRIER_CALL_URL
  if (!url) throw new SkipError('CARRIER_CALL_URL is not set')
  const target = `${url.replace(/\/+$/, '')}/carrier-call`
  expect(/^https:\/\/[a-z0-9-]+\.lambda-url\.us-east-1\.on\.aws$/i.test(url.replace(/\/+$/, '')), 'CARRIER_CALL_URL is not a us-east-1 Lambda Function URL')
  const post = async (secret, extra = {}) => {
    const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, callSid: `CAzzal${ctx.ts}`, transcript: 'hi', outcome: 'ABANDONED', ...extra }) })
    return r.status
  }
  const wrong = await post('not-the-secret')
  expect(wrong === 401, `a wrong secret answered ${wrong}, expected 401`)
  const right = await post(ctx.voiceSecret)
  expect(right === 200, `the right secret (a call too short to classify) answered ${right}, expected 200`)
  await saveConfig(ctx, { voice: { enabled: false } })
  const off = await post(ctx.voiceSecret)
  await saveConfig(ctx, { voice: { enabled: true } })
  expect(off === 503, `voice disabled answered ${off}, expected 503`)
  return '401 on a wrong secret, 200 on the right one, 503 when voice is disabled'
}

const offerRows = async (ctx, key) => (await quotesOf(ctx, key)).filter((q) => q.side === 'BUY')
const mid = (ctx, id) => msgIdOf(ctx.mailFx(id).message.messageId)

async function al07Actions(ctx) {
  // F12 (MC belongs to another carrier than the stated name) is the offer the vetted carrier is accepted through.
  await inject(ctx, 'zz-al-f12')
  const s12 = await poll(ctx)
  expect(s12.errors === 0 && s12.filed >= 1, `F12 poll filed ${s12.filed}, errors ${s12.errors}`)
  const open = await offerRows(ctx, 'open')
  const q1 = quoteFor(open, mid(ctx, 'zz-al-f01'))
  const q10 = quoteFor(open, mid(ctx, 'zz-al-f10'))
  const q12 = quoteFor(open, mid(ctx, 'zz-al-f12'))
  expect(q1 && q10 && q12, 'the F1 / F10 / F12 offers are not all on the open load')
  const notes = []

  await ctx.ship('COUNTER_OFFER', { quoteId: q1.id, amountCents: 175000, via: 'EMAIL', message: 'We can do 1750 on this one.' })
  const countered = await getRow(ctx.token, 'Quote', q1.id, 'id status rounds counterCents')
  expect(countered.status === 'SENT_COUNTER' && countered.rounds >= 1 && countered.counterCents === 175000, `COUNTER_OFFER left ${countered.status} rounds ${countered.rounds}`)
  notes.push('COUNTER_OFFER -> SENT_COUNTER (lands NOT_SENT on dev), rounds+1')

  const board = quoteFor(await offerRows(ctx, 'boardPost'), mid(ctx, 'zz-al-f02'))
  expect(board, 'the board offer (F2) is missing')
  await ctx.ship('REJECT_OFFER', { quoteId: board.id, reason: 'TOO_HIGH', note: 'step AL verification' })
  const rejected = await getRow(ctx.token, 'Quote', board.id, 'id status lostReason')
  expect(rejected.status === 'LOST', `REJECT_OFFER left ${rejected.status}`)
  notes.push('REJECT_OFFER -> LOST')

  const bundle0 = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: ctx.seeded.open.shipmentId })
  const load0 = bundle0.loads[0]
  await refused('ACCEPT_OFFER for the unknown-MC offer', /not attached to a load and a carrier|not in the carrier directory|cannot be booked|not.*bookable|MC/i, () =>
    ctx.ship('ACCEPT_OFFER', { quoteId: q10.id, expectedUpdatedAt: load0.updatedAt, acknowledgeWarnings: BOOKING_ACKS }))
  notes.push('ACCEPT_OFFER refused for the unknown MC')

  // The vetted ZZ carrier already covers the F6 load (same pickup day): the product's DOUBLE_BOOKED warning must be acknowledged by key.
  await refused('ACCEPT_OFFER without acknowledging the warnings', /Acknowledge these before booking/i, () =>
    ctx.ship('ACCEPT_OFFER', { quoteId: q12.id, expectedUpdatedAt: load0.updatedAt }))
  const acks = [...BOOKING_ACKS, `DOUBLE_BOOKED:${ctx.seeded.covered.loadId}`]
  const won = await ctx.ship('ACCEPT_OFFER', { quoteId: q12.id, expectedUpdatedAt: load0.updatedAt, acknowledgeWarnings: acks })
  void won
  const after = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: ctx.seeded.open.shipmentId })
  expect(after.loads[0].activeLoadCarrierId, 'ACCEPT_OFFER did not cover the load')
  for (const l of after.loadCarriers ?? []) if (l.id) own(ctx, 'LoadCarrier', l.id)
  const q12after = await getRow(ctx.token, 'Quote', q12.id, 'id status')
  expect(q12after.status === 'WON', `the accepted offer is ${q12after.status}`)
  for (const q of [q1, q10]) {
    const now = await getRow(ctx.token, 'Quote', q.id, 'id status quoteOpen')
    expect(!now.quoteOpen, `sibling offer ${q.id} is still open after the booking (${now.status})`)
  }
  notes.push('ACCEPT_OFFER booked the vetted carrier (WON) and closed the sibling offers')

  const count = (await offerRows(ctx, 'open')).length
  await injectCustom(ctx, ctx.mailFx('zz-al-f01'), 'zz-al-x2', ctx.mailFx('zz-al-f01').devExtraction, { subject: 'Load ZZAL1001 - still available', body: ctx.mailFx('zz-al-f01').message.body.replace('1,850', '1,700') })
  const stats = await poll(ctx)
  expect(stats.coveredLate >= 1, `the late offer counted coveredLate ${stats.coveredLate}`)
  expect((await offerRows(ctx, 'open')).length === count, 'a late offer on a covered load created a Quote')
  const late = (await messagesOf(ctx, ctx.seeded.open.shipmentId)).find((m) => m.id === msgIdOf('<zz-al-x2@carrier.example.invalid>'))
  expect(late && late.offer.match.state === 'COVERED_LATE', 'the late offer is not a COVERED_LATE message on the thread')
  notes.push('a later offer on the now-covered load is COVERED_LATE with no Quote')
  return notes.join('; ')
}

async function al08ReadOnly(ctx) {
  const notes = []
  const dir = 'amplify/functions/tms-spot-quoter/carrierInbox'
  const files = (await readdir(join(process.cwd(), dir))).filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f) && f !== 'testkit.ts')
  const banned = /\b(?:messages\.(?:send|modify|trash|untrash|insert|import|batchModify|delete)|drafts\.(?:create|update|send|delete)|gmail\.(?:send|modify|compose|insert)|sendMail|SendEmailCommand|SendRawEmailCommand)\b/
  for (const f of files) expect(!banned.test(await read(`${dir}/${f}`)), `${dir}/${f} references a send/draft/modify symbol`)
  const port = await read('src/lib/spot/port.ts')
  const iface = /export interface GmailPort \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? ''
  expect(iface && !/\b(send|draft|modify|insert|trash|delete|label)\w*\s*\(/i.test(iface), 'GmailPort exposes a write method')
  notes.push(`static: ${files.length} listener files and GmailPort carry no send/draft/modify symbol`)
  await refused('a human calling FILE_INBOUND_OFFER', /Forbidden/i, () => ctx.ship('FILE_INBOUND_OFFER', { source: 'EMAIL', sourceKey: 'zzalnotacaller000001', body: 'x' }))
  await refused('CS_POLL_NOW without a desk grant', /Forbidden/i, () => ctx.csNone('CS_POLL_NOW', {}))
  await refused('CS_SAVE_SETTINGS as a desk rep', /Forbidden/i, () => ctx.csRep('CS_SAVE_SETTINGS', { config: {}, expectedVersion: 1 }))
  await refused('CS_VOICE_ROTATE_SECRET as a desk rep', /Forbidden/i, () => ctx.csRep('CS_VOICE_ROTATE_SECRET', {}))
  const ok = await ctx.csRep('CS_STATUS', {})
  expect(ok.config && !JSON.stringify(ok).includes('secretHash'), 'a desk rep cannot read CS_STATUS or it leaks secretHash')
  notes.push('live: FILE_INBOUND_OFFER is Forbidden to a human; a grant-less user cannot poll; a desk rep cannot save settings or rotate the secret but can read status')
  return notes.join('; ')
}

// ───────────────────────────── browser walk (AL09) ─────────────────────────────
const byTestId = (id) => `[data-testid="${id}"]`
const hasTestId = (b, id) => b.evaluate(`!!document.querySelector(${JSON.stringify(byTestId(id))})`)
const textOf = (b, id) => b.evaluate(`document.querySelector(${JSON.stringify(byTestId(id))})?.innerText ?? ''`)

async function openPage(b, path, ready) {
  b.mark()
  await b.navigate(path)
  await waitLoaded(b)
  if (ready) await b.poll(ready, `${path} ready`, 60_000)
  await pause(600)
}

async function al09Ui(b, ctx, theme) {
  const tag = theme === 'dark' ? 'D' : 'L'
  const light = theme === 'light'
  const snap = (id, slug) => walk.shot(b, id, slug, tag, true).catch((e) => line('FAIL', `${id} ${theme}`, `screenshot failed: ${e.message}`))
  const shotStep = async (id, fn) => {
    if (!matches(id)) return
    try {
      const detail = await fn()
      const problems = problemList(b).slice(0, 3)
      if (problems.length) throw new Error(problems.join(' | '))
      line('PASS', `${id} ${theme}`, detail)
    } catch (err) {
      const page = await b.evaluate(`(document.querySelector('.tms-main')?.innerText ?? document.body.innerText).replace(/\\s+/g, ' ').slice(0, 220)`).catch(() => '')
      line('FAIL', `${id} ${theme}`, `${short(err)} | page: ${page}`)
      await snap(`${id}-FAIL`, 'failure')
    }
  }
  const idsWith = (prefix) => b.evaluate(`[...document.querySelectorAll('[data-testid^="${prefix}"]')].map((n) => n.getAttribute('data-testid').slice(${prefix.length}))`)
  const open = ctx.seeded.open

  await shotStep('AL09-offers-hub', async () => {
    await openPage(b, `/tms/carrier-sales?tab=offers&load=${encodeURIComponent(open.pro)}`, () => hasTestId(b, 'cs-offers-table'))
    await b.poll(() => b.evaluate(`document.querySelectorAll('[data-testid^="cs-offer-carrier-"]').length >= 2`), 'offer rows', 30_000)
    expect(await hasTestId(b, 'cs-offers-load-card') && await hasTestId(b, 'cs-offers-postings-list') && await hasTestId(b, 'cs-offers-load-input'), 'the hub is missing its load card / picker')
    const rows = await idsWith('cs-offer-carrier-')
    expect(rows.length >= 2, `only ${rows.length} offer rows`)
    for (const q of rows) {
      for (const col of ['rate', 'source', 'packet', 'risk']) expect(await hasTestId(b, `cs-offer-${col}-${q}`), `offer ${q} has no ${col} cell`)
    }
    const text = await b.evaluate(`document.querySelector('.tms-main')?.innerText ?? ''`)
    for (const h of ['CARRIER', 'OFFERED RATE', 'SOURCE', 'RECEIVED', 'PACKET', 'RISK']) expect(text.includes(h), `the offers table has no ${h} column`)
    const sources = (await Promise.all(rows.map((q) => textOf(b, `cs-offer-source-${q}`)))).join(' ')
    expect(/E-mail/.test(sources) && /Phone/.test(sources), 'the source column does not show both an e-mail and a phone offer')
    await b.poll(() => b.evaluate(`document.querySelectorAll('[data-testid^="cs-thread-item-"]').length >= 2`), 'thread items', 30_000).catch(() => {})
    const items = await idsWith('cs-thread-item-')
    expect(items.length >= 2 && await hasTestId(b, 'cs-thread'), `the thread shows ${items.length} items; thread text: ${(await textOf(b, 'cs-thread')).replace(/\s+/g, ' ').slice(0, 160)}`)
    expect(await b.evaluate(`!!document.querySelector('[data-testid="cs-thread"] [aria-label="Phone call"]') && !!document.querySelector('[data-testid="cs-thread"] [aria-label="E-mail"]')`), 'the thread does not carry both a mail and a call item')
    await snap('AL09a', 'offers-hub')
    return `${rows.length} offer rows with carrier/rate/source/packet/risk cells, ${items.length} thread items (mail + call)`
  })

  await shotStep('AL09-offer-actions', async () => {
    const rows = await idsWith('cs-offer-carrier-')
    const detail = []
    // Accept / Counter open the existing dialogs (never confirmed here), on the vetted carrier's row.
    const vetted = []
    for (const q of rows) if (/MC 9900001/.test(await textOf(b, `cs-offer-carrier-${q}`))) vetted.push(q)
    expect(vetted.length >= 1, 'no visible offer row for the vetted ZZ carrier')
    await b.click({ selector: byTestId(`cs-offer-accept-${vetted[0]}`) })
    await b.poll(() => b.evaluate(`!!document.querySelector('[role="dialog"]')`), 'accept dialog', 15_000)
    await snap('AL09b', 'accept-dialog')
    await b.press('Escape'); await pause(500)
    detail.push('Accept opens the dialog')
    await b.click({ selector: byTestId(`cs-offer-counter-${vetted[0]}`) })
    await b.poll(() => b.evaluate(`!!document.querySelector('[role="dialog"]')`), 'counter dialog', 15_000)
    await b.press('Escape'); await pause(500)
    detail.push('Counter opens the dialog')
    // Unknown MC: Accept is off, Check MCP answers (STUB badge when no MyCarrierPackets call was made).
    const unknown = []
    for (const q of rows) if (await hasTestId(b, `cs-offer-check-mcp-${q}`)) unknown.push(q)
    expect(unknown.length >= 1, 'no Check MCP button on an unknown-MC offer')
    expect(await b.evaluate(`document.querySelector(${JSON.stringify(byTestId(`cs-offer-accept-${unknown[0]}`))}).disabled`), 'Accept is enabled for an unknown-MC offer')
    await b.click({ selector: byTestId(`cs-offer-check-mcp-${unknown[0]}`) })
    await b.poll(() => b.evaluate(`/pts|No score|STUB|\\w/.test(document.querySelector(${JSON.stringify(byTestId(`cs-offer-risk-${unknown[0]}`))})?.innerText.replace('Check MCP','').trim() ?? '')`), 'risk answer', 30_000)
    const risk = await textOf(b, `cs-offer-risk-${unknown[0]}`)
    detail.push(`Check MCP -> "${risk.replace(/\s+/g, ' ').trim().slice(0, 40)}"`)
    if (light) {
      // Reject the phone offer (a real action, light pass only): it must leave the open set.
      const phone = []
      for (const q of rows) if (/Phone/.test(await textOf(b, `cs-offer-source-${q}`))) phone.push(q)
      expect(phone.length >= 1, 'no phone offer row to reject')
      await b.click({ selector: byTestId(`cs-offer-reject-${phone[0]}`) })
      await b.poll(async () => (await ctx.ship('LIST_CARRIER_OFFERS', { shipmentId: open.shipmentId })).offers.some((o) => o.id === phone[0] && o.status === 'LOST'), 'reject applied', 30_000)
      detail.push('Reject closed the phone offer (LOST)')
    }
    await snap('AL09c', 'offers-after-actions')
    return detail.join('; ')
  })

  await shotStep('AL09-unmatched', async () => {
    await openPage(b, '/tms/carrier-sales?tab=unmatched', () => hasTestId(b, 'cs-unmatched-table'))
    const f3 = msgIdOf(ctx.mailFx('zz-al-f03').message.messageId)
    const f4 = msgIdOf(ctx.mailFx('zz-al-f04').message.messageId)
    if (!light) {
      await snap('AL09d', 'unmatched')
      return 'unmatched tab renders (rows were acted on in the light pass)'
    }
    await b.poll(() => hasTestId(b, `cs-unmatched-row-${f3}`), 'the suggested row', 30_000)
    expect(await hasTestId(b, `cs-unmatched-assign-${f3}`) && await hasTestId(b, `cs-unmatched-assign-${f4}`), 'Assign is missing on a bucket row')
    await snap('AL09d', 'unmatched')
    await b.click({ selector: byTestId(`cs-unmatched-assign-${f3}`) })
    await b.poll(async () => (await messageById(ctx, f3))?.shipmentId === ctx.seeded.lane.shipmentId, 'F3 assigned to the suggested load', 30_000)
    await b.click({ selector: byTestId(`cs-unmatched-dismiss-${f4}`) })
    await b.poll(() => hasTestId(b, 'cs-unmatched-dismiss-confirm'), 'dismiss confirm', 15_000)
    await b.click({ selector: byTestId('cs-unmatched-dismiss-confirm') })
    await b.poll(async () => !(await messageById(ctx, f4)), 'F4 dismissed', 30_000)
    await pause(800)
    await snap('AL09e', 'unmatched-after')
    return 'one-click Assign filed F3 on its suggested load; Dismiss (confirmed) deleted F4'
  })

  await shotStep('AL09-settings', async () => {
    await openPage(b, '/tms/brokerage/carrier-sales', () => hasTestId(b, 'cs-settings-page'))
    expect(await hasTestId(b, 'cs-settings-simulated-badge'), 'no SIMULATED INBOX badge on the dev stack')
    expect(await hasTestId(b, `cs-settings-mailbox-${MAILBOX}`), 'the simulated mailbox row is missing')
    expect(await hasTestId(b, 'cs-settings-dev-panel'), 'the dev panel is missing on the dev stack')
    let detail = 'SIMULATED badge, mailbox row, dev panel'
    if (light) {
      await b.click({ selector: byTestId('cs-settings-voice-rotate') })
      await b.poll(() => hasTestId(b, 'cs-settings-voice-secret'), 'rotated secret shown', 30_000)
      const secret = (await textOf(b, 'cs-settings-voice-secret')).split('\n')[0].trim()
      expect(secret.length >= 32, 'the rotated secret is not shown')
      ctx.voiceSecret = secret
      await snap('AL09f', 'settings-secret')
      await b.click({ selector: '[data-testid="cs-settings-voice-secret"] button', pattern: '^Done$' })
      await pause(400)
      expect(!(await hasTestId(b, 'cs-settings-voice-secret')), 'the secret is still shown after Done')
      detail += '; Rotate shows the secret once'
    }
    await snap('AL09g', 'settings')
    return detail
  })
}

// ───────────────────────────── cleanup ─────────────────────────────
async function al10Cleanup(ctx) {
  let allOk = true
  const say = (msg, ok) => { line(ok ? 'PASS' : 'FAIL', 'AL10-cleanup', msg); return ok }
  const attempt = async (label, fn) => { try { return await fn() } catch (err) { allOk = say(`${label} failed: ${short(err).slice(0, 140)}`, false) && allOk; return null } }

  // 1. offers closed, then the ZZ quotes deleted (every row is keyed to a shipment this run made).
  let quotes = 0
  for (const sid of ctx.shipmentIds) {
    await attempt(`cancel quotes of ${sid}`, async () => {
      const offers = (await ctx.ship('LIST_CARRIER_OFFERS', { shipmentId: sid })).offers ?? []
      for (const q of offers) {
        if (q.quoteOpen && !['WON', 'CANCELLED', 'LOST', 'EXPIRED'].includes(q.status)) await ctx.ship('CANCEL_QUOTE', { quoteId: q.id, reason: 'step AL verification fixture' }).catch(() => {})
        own(ctx, 'Quote', q.id)
        if (await sdkDelete(ctx, 'Quote', q.id)) quotes += 1
      }
    })
  }
  // 2. messages: every row on a ZZ shipment, plus the bucket rows whose id this run derived.
  let messages = 0
  await attempt('delete ZZ messages', async () => {
    const ids = new Set(ctx.extraMessageIds)
    for (const fx of ctx.mails) ids.add(msgIdOf(fx.message.messageId))
    for (const c of ctx.calls) ids.add(msgIdOf(c.call.callSid))
    for (const sid of ctx.shipmentIds) for (const m of await messagesOf(ctx, sid)) ids.add(m.id)
    for (const m of await messagesOf(ctx, UNMATCHED)) if (ids.has(m.id)) ids.add(m.id)
    for (const id of ids) {
      const row = await messageById(ctx, id)
      if (!row) continue
      if (row.shipmentId !== UNMATCHED && !ctx.shipmentIds.has(row.shipmentId)) continue
      own(ctx, 'ShipmentMessage', id)
      if (await sdkDelete(ctx, 'ShipmentMessage', id)) messages += 1
    }
  })
  // 3. shipments voided, then their postings / legs / PRO claims / the carrier removed.
  for (const id of ctx.shipmentIds) {
    await attempt(`void shipment ${id}`, async () => {
      const cur = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: id })
      if (!cur.shipment.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: id, expectedUpdatedAt: cur.shipment.updatedAt, reason: 'Dev verification fixture' })
    })
  }
  let active = 0
  for (const id of ctx.shipmentIds) if (!(await getRow(ctx.token, 'Shipment', id, 'voidedAt').catch(() => null))?.voidedAt) active += 1
  allOk = say(`residue: ${active} unvoided ZZ AL shipments`, active === 0) && allOk

  let removed = 0
  await attempt('delete postings, legs, claims, carrier', async () => {
    for (const key of Object.keys(ctx.seeded)) {
      const s = ctx.seeded[key]
      if (s.postingId && owns(ctx, 'ShipmentPosting', s.postingId)) removed += (await sdkDelete(ctx, 'ShipmentPosting', s.postingId)) ? 1 : 0
    }
    for (const lc of await scanAll(ctx, 'LoadCarrier', { FilterExpression: 'attribute_exists(shipmentId)' })) {
      if (ctx.shipmentIds.has(lc.shipmentId)) { own(ctx, 'LoadCarrier', lc.id); removed += (await sdkDelete(ctx, 'LoadCarrier', lc.id)) ? 1 : 0 }
    }
    for (const key of Object.keys(ctx.seeded)) {
      const s = ctx.seeded[key]
      const claim = await doc.send(new GetCommand({ TableName: devTable('ProClaim', ctx.suffix), Key: { id: s.pro } })).then((r) => r.Item)
      if (claim && claim.shipmentId === s.shipmentId) removed += (await sdkDelete(ctx, 'ProClaim', s.pro)) ? 1 : 0
    }
    if (ctx.carrierId) removed += (await sdkDelete(ctx, 'Carrier', ctx.carrierId)) ? 1 : 0
  })
  // 4. mailbox + config restored, sim inbox purged.
  if (ctx.cfgSaved) {
    await attempt('purge the sim inbox', () => ctx.csCall('CS_SIM_PURGE_TEST', { mailboxId: MAILBOX }))
    await attempt('restore the carrier-sales config', async () => {
      const s = await csStatus(ctx)
      const prior = ctx.config0
      const config = { ...prior, mailboxes: prior.mailboxes.filter((m) => m.id !== MAILBOX), enabled: prior.enabled && prior.mailboxes.some((m) => m.id !== MAILBOX), voice: { ...prior.voice } }
      delete config.version
      await ctx.csCall('CS_SAVE_SETTINGS', { config, expectedVersion: s.config.version })
      const after = await csStatus(ctx)
      allOk = say(`config restored (mailbox ${after.config.mailboxes.some((m) => m.id === MAILBOX) ? 'STILL PRESENT' : 'removed'}, enabled ${after.config.enabled})`, !after.config.mailboxes.some((m) => m.id === MAILBOX)) && allOk
    })
  }
  for (const id of ctx.customerIds) {
    await attempt(`archive customer ${id}`, async () => {
      const row = await getRow(ctx.token, 'Customer', id, 'id updatedAt active')
      if (row && row.active !== false) await ctx.dir('ARCHIVE_CUSTOMER', { id, expectedUpdatedAt: String(row.updatedAt) })
      const after = await getRow(ctx.token, 'Customer', id, 'active')
      allOk = say(`customer ${id} ${after?.active === false ? 'archived and confirmed' : 'NOT confirmed archived'}`, after?.active === false) && allOk
    })
  }
  // 5. residue check: no ZZ AL row left where the product reads.
  await attempt('residue check', async () => {
    const bucket = (await messagesOf(ctx, UNMATCHED)).filter((m) => ctx.extraMessageIds.has(m.id) || ctx.mails.some((fx) => msgIdOf(fx.message.messageId) === m.id) || ctx.calls.some((c) => msgIdOf(c.call.callSid) === m.id))
    allOk = say(`residue: ${bucket.length} ZZ rows left in the Unmatched bucket`, bucket.length === 0) && allOk
  })
  line('PASS', 'AL10-cleanup', `ledger: ${quotes} quotes deleted, ${messages} messages deleted, ${ctx.shipmentIds.size} shipments voided, ${removed} postings/legs/claims/carrier rows deleted`)
  expect(allOk, 'cleanup left residue (see the cleanup lines above)')
  return 'ZZ quotes, messages, postings, legs, claims and carrier removed; shipments voided; customer archived; config restored; sim inbox purged'
}

// ───────────────────────────── runners + main ─────────────────────────────
const RUNNERS = {
  AL00: al00Preflight, AL01: al01Settings, AL02: al02Email, AL03: al03Funnel, AL04: al04Tiers, AL05: al05Assign,
  AL06: al06Calls, AL07: al07Actions, AL08: al08ReadOnly, AL09: al09Ui, AL10: al10Cleanup,
}

async function step(id, fn) {
  if (!matches(id) && !id.startsWith('AL10')) return undefined
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
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAL refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyAL refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAL only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  if (!(await inventory())) { process.exitCode = 1; return }
  if (flag('inventory')) return

  await mkdir(SHOTS, { recursive: true })
  const fx = await loadFixtures()
  const ts = Date.now()
  const emails = { admin: `zz-al-admin-${ts}@example.invalid`, rep: `zz-al-rep-${ts}@example.invalid`, none: `zz-al-none-${ts}@example.invalid` }
  const made = []
  const ctx = {
    ts, origin, emails, suffix: null, seeded: {}, refs: fx.refs, address: fx.address, mails: fx.mails, calls: fx.calls,
    mailFx: (id) => { const f = fx.mails.find((m) => m.id === id); if (!f) throw new Error(`unknown fixture ${id}`); return f },
    owned: new Set(), shipmentIds: new Set(), customerIds: new Set(), extraMessageIds: new Set(), cfgSaved: false, carrierId: null,
  }

  let b = null
  try {
    ctx.suffix = await discoverDevSuffix()
    console.log('dev table suffix discovered (ok)')
    const admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms', 'page-quotes', 'page-loads']); made.push(emails.admin)
    const rep = await mintIdentity(emails.rep, ['page-tms', 'page-quotes', 'role-CUSTOMER_REP']); made.push(emails.rep)
    const none = await mintIdentity(emails.none, []); made.push(emails.none)
    console.log('identity: temporary staff identities created (admin, desk rep, no grants)')
    ctx.token = admin.token
    ctx.csCall = routerAs(admin.token, 'tmsSpotActions')
    ctx.csRep = routerAs(rep.token, 'tmsSpotActions')
    ctx.csNone = routerAs(none.token, 'tmsSpotActions')
    ctx.ship = routerAs(admin.token, 'tmsShipmentActions')
    ctx.shipRep = routerAs(rep.token, 'tmsShipmentActions')
    ctx.dir = routerAs(admin.token, 'tmsDirectoryActions')

    const needsBrowser = !flag('no-ui') && (!only || /AL09/.test(only))
    if (needsBrowser) b = await launchBrowser({ origin, storage: admin.storage, profilePrefix: 'bcat-al-', purpose: 'AL verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })

    const seq = ['AL00', 'AL01', 'AL02', 'AL03', 'AL04', 'AL05', 'AL06']
    for (const id of seq) {
      const slug = AL_STEPS.find((s) => s.id === id).slug
      await step(`${id}-${slug}`, () => RUNNERS[id](ctx))
      if (id === 'AL06') await step('AL06-webhook', () => al06Webhook(ctx))
    }
    // AL09 runs before AL07 so the offers it clicks are still open (recorded deviation).
    if (b && ctx.seeded.open) {
      await b.navigate('/dashboard')
      await waitLoaded(b).catch(() => {})
      await b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell sidebar mounted', 45_000)
      for (const theme of flag('no-dark') ? ['light'] : ['light', 'dark']) {
        await walk.setTheme(b, theme).catch(() => {})
        await al09Ui(b, ctx, theme)
      }
      await walk.setTheme(b, 'light').catch(() => {})
    }
    await step('AL07-existing-actions', () => RUNNERS.AL07(ctx))
    await step('AL08-read-only-authority', () => RUNNERS.AL08(ctx))
    await step('AL02-model', () => al02Model(ctx))
  } finally {
    if (b) await b.close().catch(() => {})
    if (ctx.token) await step('AL10-cleanup', () => al10Cleanup(ctx)).catch(() => {})
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
  main().catch((err) => { console.error(`devVerifyAL failed: ${err?.message ?? err}`); process.exit(1) })
}
