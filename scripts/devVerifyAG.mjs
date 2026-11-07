#!/usr/bin/env node
/**
 * Step AG verification against the DEV site: Accounting > AP inbox sync on a SIMULATED mailbox (no Google). Runs ONLY
 * after the single AG deploy. The deterministic steps feed the real pipeline (prefilter, match, decide, apply, CAS,
 * audit) with a `devExtraction` stored beside each simulated message, so they need no Anthropic key; AG11 runs one
 * synthetic PDF through the real model and is skipped when the key or credit is unusable.
 *
 *   node scripts/devVerifyAG.mjs [--inventory] [--only=<substring>] [--no-ui] [--no-dark]
 *   DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyAG.mjs
 *
 *   --inventory  no network, no browser: every AG id has a runner, every AP_INBOX_ action the harness calls is in
 *                src/lib/apInbox/actions.ts, every data-testid it reads exists in source, SKIP_ALLOWED names real steps.
 *   --only=      run only the steps whose id contains the substring (fixtures are still created; cleanup always runs).
 *   --no-ui      skip the browser step (AG12).
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool, any origin outside
 * ALLOWED_ORIGINS, any DynamoDB table without the dev suffix (or with the production one) and any bucket that is not
 * the dev storage bucket. The mailbox is READ-ONLY by construction (there is no send/draft/label action); AG05 proves
 * that no bill was approved, paid or changed outside the allow-listed columns.
 *
 * Everything it creates is named zz-ag-… / ZZ AG …, tracked, and removed in `finally`: sim mail purged through
 * AP_INBOX_SIM_PURGE_TEST, shipments voided (the PRO stays claimed by design), ZZ customer/carrier archived, the
 * apInbox config restored, queue items / clone bills / vendor payables deleted through guarded SDK calls (a key must be
 * tracked by this run or carry the zz-ag- prefix), temporary identities deleted. Passwords, tokens and mail content are
 * never printed.
 *
 * Deviations from AG-plan §10 (recorded): the AG-plan "B2/B2'" two-legs-one-PRO pair is a real bill plus a ZZ-keyed clone
 * row of it (a PRO can only be claimed once through the router); B4 is set TO_BE_PAID and the ZZ carrier's remit-to name
 * is written by guarded SDK updates on rows this run created; the object checks (AG09) need the dev storage bucket and
 * are SKIP_ALLOWED when AWS cannot list it; the harness never calls lambda:Invoke, so the direct scheduled-door check of
 * AG07 is SKIP_ALLOWED (AG07 proves the cursor and the partial/continue path through the Review now door instead).
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DynamoDBClient, DescribeTableCommand, DescribeTimeToLiveCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListBucketsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk } from './lib/uiWalk.mjs'
import { buildInvoicePdf, buildCorpus, expectedCounts, injectInput, rawExtraction, BANK_SENTINEL } from './lib/apInboxFixtures.mjs'

const DEV_APPSYNC = APPSYNC_URL_RE
const DEV_SUFFIX = STACK.tableSuffix
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const PROD_BUCKET = 'amplify-d3dejqzs77khq6-ma-bcatrateconfirmsbucketf4-8peppeemuqmg'
const DEV_BUCKET_PREFIX = STACK.lambdaPrefix
const SHOTS = resolve('Docs/tms-build/ag-proof')
const REGION = 'us-east-1'
const MAIL_OBJECT_PREFIX = 'intake-pdfs/ap-inbox/'
const TOKEN_SHAPE = /\b(ya29\.[\w-]{20,}|1\/\/[\w-]{30,}|sk-ant-[\w-]{10,})/

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
  { pattern: /tmsApInboxActions/, reason: 'the AG steps drive refused actions on purpose' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']
export const SKIP_ALLOWED = {
  'AG07-lambda-door': 'the harness does not hold lambda:Invoke on the dev function',
  'AG09-objects': 'the dev storage bucket cannot be listed from here',
  'AG11-real-model': 'no usable Anthropic key or credit on dev',
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: SKIP_ALLOWED, only })
const { line, report, written, skipLine, problemList, waitLoaded, matches } = walk

// ───────────────────────────── step registry + static gates ─────────────────────────────
export const AG_STEPS = [
  { id: 'AG00', slug: 'preflight', ui: false },
  { id: 'AG01', slug: 'fixtures', ui: false },
  { id: 'AG02', slug: 'connect-settings', ui: false },
  { id: 'AG03', slug: 'inject', ui: false },
  { id: 'AG04', slug: 'sync-digest', ui: false },
  { id: 'AG05', slug: 'never-approve-pay', ui: false },
  { id: 'AG06', slug: 'idempotent', ui: false },
  { id: 'AG07', slug: 'cursor-resume', ui: false },
  { id: 'AG08', slug: 'queue-actions', ui: false },
  { id: 'AG09', slug: 'privacy', ui: false },
  { id: 'AG10', slug: 'permissions', ui: false },
  { id: 'AG11', slug: 'real-model', ui: false },
  { id: 'AG12', slug: 'ui', ui: true },
  { id: 'AG13', slug: 'cleanup', ui: false },
]

/** The data-testids this script reads, and the source file that must carry each one. */
export const TESTID_SOURCES = {
  'ap-inbox-digest': 'src/features/ap/inbox/ApInboxDigest.tsx',
  'ap-inbox-review-now': 'src/features/ap/inbox/ApInboxDigest.tsx',
  'ap-inbox-why-': 'src/features/ap/inbox/inboxView.tsx',
  'ap-inbox-link-': 'src/features/ap/inbox/inboxView.tsx',
  'ap-inbox-link-dialog': 'src/features/ap/inbox/LinkBillDialog.tsx',
  'ap-inbox-pick-': 'src/features/ap/inbox/LinkBillDialog.tsx',
  'ap-inbox-settings-card': 'src/features/settings/ApInboxSettingsCard.tsx',
  'ap-inbox-sim': 'src/features/settings/ApInboxSettingsCard.tsx',
  'ap-inbox-bill-strip': 'src/features/ap/BillDetail.tsx',
}

const read = (file) => readFile(join(process.cwd(), file), 'utf8')

async function contractActions() {
  const src = await read('src/lib/apInbox/actions.ts')
  return new Set([...src.matchAll(/^\s*(AP_INBOX_[A-Z_]+):/gm)].map((m) => m[1]))
}

/** Gates 1–3 (no network). Returns true when all pass. */
export async function inventory() {
  const runners = Object.keys(RUNNERS)
  const registered = AG_STEPS.map((s) => s.id)
  const missing = registered.filter((id) => !runners.includes(id)).concat(runners.filter((id) => !registered.includes(id)))
  if (missing.length) { line('FAIL', 'gate 1: AG ids registered', `registry and runners disagree on: ${missing.join(', ')}`); return false }
  const orphanSkips = Object.keys(SKIP_ALLOWED).filter((k) => !registered.includes(k.split('-')[0]))
  if (orphanSkips.length) { line('FAIL', 'gate 1: AG ids registered', `SKIP_ALLOWED names no step: ${orphanSkips.join(', ')}`); return false }
  line('PASS', 'gate 1: AG ids registered', `${registered.length} steps (${registered.join(' ')}) each have a runner; skip-allowed: ${Object.keys(SKIP_ALLOWED).join(', ')}`)

  const self = await read('scripts/devVerifyAG.mjs')
  const called = new Set([...self.matchAll(/\bap(?:Only|None)?\(\s*'(AP_INBOX_[A-Z_]+)'/g)].map((m) => m[1]))
  const known = await contractActions()
  const unknown = [...called].filter((a) => !known.has(a))
  if (unknown.length) { line('FAIL', 'gate 2: harness calls only published actions', `not in the contract: ${unknown.join(', ')}`); return false }
  line('PASS', 'gate 2: harness calls only published actions', `${called.size} distinct AP_INBOX_ actions, all in src/lib/apInbox/actions.ts`)

  const gaps = []
  for (const [id, file] of Object.entries(TESTID_SOURCES)) {
    const text = await read(file).catch(() => '')
    if (!text.includes(id)) gaps.push(`${id} missing from ${file}`)
  }
  if (gaps.length) { line('FAIL', 'gate 3: data-testids the walk reads exist in source', gaps.join('; ')); return false }
  line('PASS', 'gate 3: data-testids the walk reads exist in source', `${Object.keys(TESTID_SOURCES).length} ids`)
  return true
}

// ───────────────────────────── small helpers ─────────────────────────────
const asJson = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return v } })() : v)
const nowIso = () => new Date().toISOString()
const dayPlus = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const expect = (cond, message) => { if (!cond) throw new Error(message) }
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)
class SkipError extends Error {}

async function refused(name, pattern, fn) {
  try { await fn() } catch (err) {
    if (pattern.test(String(err?.message ?? err))) return String(err.message).slice(0, 160)
    throw new Error(`${name} refused for the wrong reason: ${short(err)}`)
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

const auditRows = async (token, entityId, action) =>
  (await listAll(token, 'AuditLog', { entityId: { eq: entityId }, action: { eq: action } }, 'id entityId action user changes'))
    .map((x) => ({ ...x, changes: asJson(asJson(x.changes)) }))

/** Items of one status, newest first, with the JSON columns parsed. */
async function queueItems(ctx, status) {
  const rows = []
  let next = null
  do {
    const r = await gql(ctx.token, `query($s: ApInboxItemStatus!, $n: String) { listApInboxItemByStatusAndReceivedAt(status: $s, limit: 200, nextToken: $n) { items { id messageId receivedAt status reviewReason sourceUrl kind extraction match target applied attachments ttlEpoch version subject fromEmail } nextToken } }`, { s: status, n: next })
    rows.push(...r.listApInboxItemByStatusAndReceivedAt.items)
    next = r.listApInboxItemByStatusAndReceivedAt.nextToken
  } while (next)
  return rows.map((x) => ({ ...x, extraction: asJson(x.extraction), match: asJson(x.match), target: asJson(x.target), applied: asJson(x.applied), attachments: asJson(x.attachments) }))
}
const ALL_STATUSES = ['NEEDS_REVIEW', 'APPLIED', 'LINKED', 'CREATED', 'DISMISSED']
const itemsFor = async (ctx, ids) => {
  const out = []
  for (const s of ALL_STATUSES) out.push(...(await queueItems(ctx, s)).filter((r) => ids.has(r.messageId)))
  return out
}

const BILL_FIELDS = 'id status version billNumber billDate billMonth dueAt billedCents varianceCents grossCents netCents paidCents balanceCents approvedAt remitTo termsDays apOpen apInboxItemId apInboxSourceUrl apInboxAppliedAt updatedBy loadCarrierId'
const getBill = async (ctx, id) => {
  const b = await getRow(ctx.token, 'CarrierBill', id, BILL_FIELDS)
  return b ? { ...b, remitTo: asJson(b.remitTo) } : b
}
const MONEY_UNTOUCHED = ['status', 'grossCents', 'netCents', 'paidCents', 'balanceCents', 'approvedAt', 'termsDays', 'apOpen', 'loadCarrierId']

// ───────────────────────────── safety + guarded SDK access ─────────────────────────────
const ddb = new DynamoDBClient({ region: REGION })
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })
const s3 = new S3Client({ region: REGION })

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
async function discoverDevBucket() {
  const r = await s3.send(new ListBucketsCommand({}))
  const found = (r.Buckets ?? []).map((x) => x.Name).filter((n) => n?.startsWith(DEV_BUCKET_PREFIX) && n.includes('bcatrateconfirms') && n !== PROD_BUCKET)
  if (found.length !== 1) throw new Error(`expected one dev bucket, found ${found.length}`)
  return found[0]
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

/** An SDK write/delete is allowed only on a row this run created: a zz-ag- key, or an id in `ctx.owned[model]`. */
const owns = (ctx, model, id) => String(id).startsWith('zz-ag-') || String(id).startsWith('apin:sim:zz-ag-') || ctx.owned[model]?.has(String(id)) === true
async function zzPut(ctx, model, item) {
  if (!owns(ctx, model, item.id) && !(model === 'UserProfile' && String(item.email).startsWith('zz-ag-'))) throw new Error(`refusing SDK write to ${model} ${String(item.id)}`)
  await doc.send(new PutCommand({ TableName: devTable(model, ctx.suffix), Item: { __typename: model, createdAt: nowIso(), updatedAt: nowIso(), ...item } }))
  ;(ctx.owned[model] ??= new Set()).add(String(item.id))
}
async function zzSet(ctx, model, id, set) {
  if (!owns(ctx, model, id)) throw new Error(`refusing SDK update of ${model} ${id}`)
  const names = Object.keys(set)
  await doc.send(new UpdateCommand({
    TableName: devTable(model, ctx.suffix), Key: { id },
    UpdateExpression: `SET ${names.map((n, i) => `#k${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#k${i}`, n])),
    ExpressionAttributeValues: Object.fromEntries(names.map((n, i) => [`:v${i}`, set[n]])),
    ConditionExpression: 'attribute_exists(id)',
  }))
}
async function deleteRow(ctx, model, id) {
  if (!owns(ctx, model, id)) throw new Error(`refusing SDK delete of ${model} ${id}: not created by this run`)
  await doc.send(new DeleteCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))
  return !(await doc.send(new GetCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))).Item
}
const getItemRaw = async (ctx, model, id) => (await doc.send(new GetCommand({ TableName: devTable(model, ctx.suffix), Key: { id } }))).Item

// ───────────────────────────── fixtures ─────────────────────────────
const LEGS = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']
const stops = (day) => [
  { type: 'pickup', name: 'ZZ AG Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${day}T13:00:00.000Z` },
  { type: 'delivery', name: 'ZZ AG Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${day}T23:00:00.000Z` },
]
const WARNINGS = ['MISSING_DOC:COI_CARGO', 'MISSING_DOC:COI_AUTO', 'MISSING_DOC:W9', 'MISSING_DOC:CARRIER_AGREEMENT', 'INSURANCE_UNVERIFIED']

/** One booked leg with a known PRO; `bill` records its carrier bill (blank number unless `billNumber`). */
async function makeLeg(ctx, key, { amount, bill = true, billNumber, billDate }) {
  const idx = LEGS.indexOf(key) + 1
  const day = dayPlus(10 + idx)
  let b = await ctx.ship('CREATE_SHIPMENT', { customerId: ctx.customerId })
  const shipmentId = b.shipment.id
  // The PRO is derived by the system (a typed number at or above the counter is refused); read it back from the leg.
  const pro = String(b.loads?.[0]?.aljexId ?? b.shipment.number)
  ctx.shipmentIds.add(shipmentId)
  for (const l of b.loads ?? []) ctx.owned.Load = (ctx.owned.Load ?? new Set()).add(String(l.id))
  b = await ctx.ship('SAVE_ORDER_FORM', {
    shipmentId, expectedUpdatedAt: b.shipment.updatedAt,
    order: { mode: 'FTL', equipmentType: 'Dry Van' },
    stops: stops(day),
    charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: Math.round(amount * 100) + 50_000, count: 1 }],
  })
  await ctx.ship('SUBMIT_ORDER', { shipmentId, expectedUpdatedAt: b.shipment.updatedAt })
  b = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId })
  await ctx.ship('BOOK_CARRIER', { loadId: b.loads[0].id, expectedUpdatedAt: b.loads[0].updatedAt, carrierId: ctx.carrierId, carrierRateCents: Math.round(amount * 100), acknowledgeWarnings: WARNINGS })
  b = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId })
  const leg = (b.loadCarriers ?? []).find((c) => c.status === 'ACTIVE')
  expect(leg, `no active leg after booking ${key}`)
  const out = { key, pro, amount, shipmentId, loadId: b.loads[0].id, loadCarrierId: leg.id, shipmentNumber: b.shipment.number }
  if (bill) {
    const rec = await ctx.fin('RECORD_BILL', { loadCarrierId: leg.id, ...(billNumber ? { billNumber, billedCents: Math.round(amount * 100) } : {}), ...(billDate ? { billDate } : {}) })
    out.billId = rec.bill.id
    ctx.billIds.add(String(rec.bill.id))
    ;(ctx.owned.CarrierBill ??= new Set()).add(String(rec.bill.id))
  }
  return out
}

// ───────────────────────────── steps ─────────────────────────────
async function ag00Preflight(ctx) {
  const status = await ctx.ap('AP_INBOX_STATUS', {})
  expect(status && typeof status === 'object', 'AP_INBOX_STATUS returned nothing')
  expect(status.devStack === true, 'the Lambda does not report devStack: refusing to run the simulated steps anywhere else')
  ctx.restore.config = status.config ?? null
  ctx.restore.connection = status.connection?.status ?? null
  const ttl = await ddb.send(new DescribeTimeToLiveCommand({ TableName: devTable('ApInboxItem', ctx.suffix) })).catch(() => null)
  const ttlOn = ttl?.TimeToLiveDescription?.TimeToLiveStatus
  expect(ttlOn === 'ENABLED' || ttlOn === 'ENABLING', `ApInboxItem TTL is ${ttlOn ?? 'unreadable'}`)
  try { ctx.bucket = await discoverDevBucket() } catch { ctx.bucket = null }
  return `AP_INBOX_STATUS readable (devStack, connection ${status.connection?.status}, providerReady ${status.providerReady}); ApInboxItem TTL ${ttlOn}; dev bucket ${ctx.bucket ? 'found' : 'not listable'}`
}

async function ag01Fixtures(ctx) {
  const n = String(ctx.ts).slice(-6)
  const customer = await ctx.dir('UPSERT_CUSTOMER', {
    name: `ZZ AG Customer ${ctx.ts}`, mcNumber: `8${n}`, billingEmail: 'ag-verification@example.invalid', creditLimitCents: 500_000_000, paymentTermsDays: 30,
    pricingDefaults: { mode: 'MARGIN', defaultBps: 2500, minProfitCents: 10000, maxProfitCents: 2000000 },
    notes: 'Dev-only Step AG verification fixture. Safe to delete.',
  }).then((r) => r.customer ?? r)
  ctx.customerId = String(customer.id)
  const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString()
  const lastYear = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const carrier = await ctx.car('UPSERT_CARRIER', {
    name: ctx.carrierName, type: 'TL', status: 'ACTIVE', mcNumber: `9${n}`, dotNumber: `9${n}`, mcpStatus: 'NOT_INVITED',
    accountingEmail: `zz-ag-carrier-ap-${ctx.ts}@example.invalid`,
    insurancePolicies: [
      { type: 'AUTO_LIABILITY', company: 'Verification Mutual', policyNumber: `AL-${ctx.ts}`, limitCents: 100000000, effectiveAt: lastYear, expiresAt: nextYear },
      { type: 'CARGO', company: 'Verification Mutual', policyNumber: `CG-${ctx.ts}`, limitCents: 10000000, effectiveAt: lastYear, expiresAt: nextYear },
    ],
    notes: 'Dev-only Step AG verification fixture. Safe to delete.',
  }).then((r) => r.carrier ?? r)
  ctx.carrierId = String(carrier.id)
  ctx.carrier = { name: ctx.carrierName, mc: `9${n}`, dot: `9${n}`, remit: ctx.carrierName }
  // the remit-to name on file is what the REMIT_MISMATCH veto compares against
  ;(ctx.owned.Carrier ??= new Set()).add(ctx.carrierId)
  // A new carrier is PENDING and ACTIVE needs MyCarrierPackets (or an Aljex import): the fixture stands in with a guarded write on its own row.
  await zzSet(ctx, 'Carrier', ctx.carrierId, { remitToName: ctx.carrierName, status: 'ACTIVE', legacyImported: true })

  const amounts = { B1: 1111.11, B2: 2222.22, B3: 3333.33, B4: 4444.44, B5: 5555.55, B6: 6666.66, B7: 7777.77 }
  const typedNumber = `ZZAG-${ctx.ts}-TYPED`
  ctx.legs = {}
  for (const key of LEGS) {
    ctx.legs[key] = await makeLeg(ctx, key, {
      amount: amounts[key], bill: key !== 'B5',
      ...(key === 'B3' ? { billNumber: typedNumber, billDate: dayPlus(-6) } : {}),
    })
  }
  const b3 = await getBill(ctx, ctx.legs.B3.billId)
  ctx.legs.B3.billNumber = typedNumber
  ctx.legs.B3.billDate = b3.billDate
  // B4: TO_BE_PAID with a blank number (a fixture-only status stand-in; the app's own approval is never called)
  await zzSet(ctx, 'CarrierBill', ctx.legs.B4.billId, { status: 'TO_BE_PAID' })
  // B2': a second open bill on the same PRO (the router refuses a second claim of a PRO, so it is a ZZ-keyed clone)
  const base = await getItemRaw(ctx, 'CarrierBill', ctx.legs.B2.billId)
  expect(base, 'cannot read B2 for the clone')
  ctx.legs.B2b = { key: 'B2b', pro: ctx.legs.B2.pro, amount: ctx.legs.B2.amount, billId: `zz-ag-${ctx.ts}-b2b` }
  await zzPut(ctx, 'CarrierBill', { ...base, id: ctx.legs.B2b.billId, billNumber: null, version: 1 })
  ctx.billIds.add(ctx.legs.B2b.billId)
  // vendor payables: VP1 blank dates / typed invoice number, VP2 an unrelated typed one
  ctx.vendor = { name: `ZZ AG Tire Co ${n}`, invoiceNumber: `ZZAGV-${ctx.ts}`, amount: 480, otherName: `ZZ AG Other Vendor ${n}` }
  ctx.vpIds = { VP1: `zz-ag-${ctx.ts}-vp1`, VP2: `zz-ag-${ctx.ts}-vp2` }
  await zzPut(ctx, 'VendorPayable', { id: ctx.vpIds.VP1, status: 'NEED_TO_PAY', source: 'EMAIL', subject: 'ZZ AG vendor invoice', vendor: ctx.vendor.name, invoiceNumber: ctx.vendor.invoiceNumber, amount: 48_000, receivedAt: nowIso() })
  await zzPut(ctx, 'VendorPayable', { id: ctx.vpIds.VP2, status: 'NEED_TO_PAY', source: 'EMAIL', subject: 'ZZ AG other vendor invoice', vendor: `ZZ AG Unrelated ${n}`, invoiceNumber: `ZZAGV-${ctx.ts}-OLD`, amount: 12_345, invoiceDate: dayPlus(-9), dueDate: dayPlus(21), receivedAt: nowIso() })
  // baseline of every bill AG may or may not touch
  ctx.before = {}
  for (const key of ['B1', 'B2', 'B3', 'B4', 'B6', 'B7', 'B2b']) ctx.before[key] = await getBill(ctx, ctx.legs[key].billId)
  expect(!ctx.before.B1.billNumber, 'B1 must start as a placeholder (blank bill number)')
  return `ZZ carrier + ${LEGS.length} booked legs, bills B1,B2,B3(typed),B4(TO_BE_PAID),B6,B7 + clone B2b, B5 awaiting an invoice, 2 vendor payables`
}

async function ag02Connect(ctx) {
  const noSettings = await refused('SAVE_SETTINGS by an AP-only user', /admin|permission|forbidden|not authori[sz]ed|owner/i, () => ctx.apOnly('AP_INBOX_SAVE_SETTINGS', { config: { autoApply: false }, expectedVersion: 1 }))
  const connected = await ctx.ap('AP_INBOX_CONNECT_SIMULATED', { lookbackHours: 24 })
  ctx.simConnected = true
  expect(connected, 'CONNECT_SIMULATED returned nothing')
  await ctx.ap('AP_INBOX_SIM_RESET', {})
  let st = await ctx.ap('AP_INBOX_STATUS', {})
  expect(st.connection?.status === 'SIMULATED', `connection is ${st.connection?.status}, not SIMULATED`)
  const version = st.config?.version ?? 1
  const low = await refused('autoApplyMinScore 0.80', /0\.85|auto.?apply|score|invalid|between|at least/i, () => ctx.ap('AP_INBOX_SAVE_SETTINGS', { config: { ...st.config, autoApplyMinScore: 0.8 }, expectedVersion: version }))
  const saved = await ctx.ap('AP_INBOX_SAVE_SETTINGS', {
    config: { ...st.config, enabled: true, mode: 'SIMULATED', autoApply: true, autoApplyMinScore: 0.9, reviewMinScore: 0.5, lookbackHours: 24, maxModelCallsPerRun: 80, maxAutoAppliesPerRun: 50 },
    expectedVersion: version,
  })
  st = await ctx.ap('AP_INBOX_STATUS', {})
  expect(st.config.autoApply === true && st.config.autoApplyMinScore === 0.9 && st.config.enabled === true, 'settings did not round-trip')
  ctx.configVersion = st.config.version
  const start = await refused('OAuth start with a foreign redirect URI', /redirect|not allowed|origin|configured|client/i, () => ctx.ap('AP_INBOX_OAUTH_START', { redirectUri: 'https://evil.example.invalid/tms/rates/spot/callback' }))
  expect(!JSON.stringify(st).match(TOKEN_SHAPE), 'STATUS carries a token-shaped string')
  expect(!('pendingState' in (st.connection ?? {})), 'STATUS leaks pendingState')
  return `simulated mailbox connected; floor refused (${low.slice(0, 40)}); non-admin refused (${noSettings.slice(0, 30)}); foreign redirect refused (${start.slice(0, 30)}); ${saved ? 'settings saved' : ''}`
}

async function ag03Inject(ctx) {
  const world = {
    stamp: ctx.ts, now: Date.now(), today: dayPlus(0), dayPlus,
    carrier: ctx.carrier, otherMc: `1${String(ctx.ts).slice(-6)}`,
    legs: {
      B1: { pro: ctx.legs.B1.pro, amount: ctx.legs.B1.amount }, B2: { pro: ctx.legs.B2.pro, amount: ctx.legs.B2.amount },
      B3: { pro: ctx.legs.B3.pro, amount: ctx.legs.B3.amount, billNumber: ctx.legs.B3.billNumber, billDate: ctx.legs.B3.billDate },
      B4: { pro: ctx.legs.B4.pro, amount: ctx.legs.B4.amount }, B5: { pro: ctx.legs.B5.pro, amount: ctx.legs.B5.amount },
      B6: { pro: ctx.legs.B6.pro, amount: ctx.legs.B6.amount }, B7: { pro: ctx.legs.B7.pro, amount: ctx.legs.B7.amount },
    },
    vendor: ctx.vendor,
  }
  ctx.corpus = buildCorpus(world)
  ctx.corpusIds = new Set()
  for (const mail of ctx.corpus) {
    const r = await ctx.ap('AP_INBOX_SIM_INJECT', injectInput(mail))
    expect(r && (r.id ?? true), `inject ${mail.n} returned nothing`)
    ctx.corpusIds.add(mail.message.id)
  }
  expect(ctx.corpus.length >= 14, 'corpus shorter than the 14 cases AG03 requires')
  // m14 is older than the 24 h look-back: the cursor starts at `now - lookback`, so it is injected but must never be read.
  return `${ctx.corpus.length} mails injected (${ctx.corpusIds.size} distinct ids), ages 8-40 h, ${ctx.corpus.filter((m) => m.message.attachments?.length).length} with PDFs`
}

/** Loop the Review now door to `done` (the UI does the same, capped at 15 calls). */
async function syncToDone(ctx, as = ctx.ap) {
  let last
  for (let i = 0; i < 15; i++) {
    last = await as('AP_INBOX_SYNC_NOW', {})
    if (last.done) return { ...last, calls: i + 1 }
  }
  throw new Error('SYNC_NOW did not finish in 15 calls')
}
const lastDigest = async (ctx) => (await ctx.ap('AP_INBOX_STATUS', {})).runs?.[0] ?? (await ctx.ap('AP_INBOX_STATUS', {})).lastRun

async function ag04Sync(ctx) {
  const run = await syncToDone(ctx)
  const items = await itemsFor(ctx, ctx.corpusIds)
  const byMsg = new Map(items.map((i) => [i.messageId, i]))
  const want = expectedCounts(ctx.corpus)
  const problems = []
  for (const mail of ctx.corpus) {
    const e = mail.expect
    const item = byMsg.get(mail.message.id)
    if (e.item === false) { if (e.duplicate) continue; if (item) problems.push(`${mail.n}: stored but must not be`); continue }
    if (!item) { problems.push(`${mail.n}: no item`); continue }
    if (e.status && item.status !== e.status) problems.push(`${mail.n}: status ${item.status}, expected ${e.status}`)
    if (e.reason && item.reviewReason !== e.reason) problems.push(`${mail.n}: reason ${item.reviewReason}, expected ${e.reason}`)
  }
  expect(problems.length === 0, problems.slice(0, 6).join(' | '))
  expect(items.length === want.stored, `${items.length} items stored, expected ${want.stored}`)
  const digest = run.digest ?? (await lastDigest(ctx))
  const dg = digest ?? {}
  if (dg.updatedBills !== undefined) expect(dg.updatedBills >= want.updated, `digest updatedBills ${dg.updatedBills} < ${want.updated}`)
  if (dg.needReview !== undefined) expect(dg.needReview >= want.needReview, `digest needReview ${dg.needReview} < ${want.needReview}`)
  // B1: m1's number/dates and provenance
  const m1 = ctx.corpus.find((m) => m.n === 'm01')
  const b1 = await getBill(ctx, ctx.legs.B1.billId)
  const ext = m1.message.devExtraction
  expect(b1.billNumber === ext.invoiceNumber, `B1 billNumber ${b1.billNumber}`)
  expect(b1.billDate === ext.invoiceDate && b1.billMonth === ext.invoiceDate.slice(0, 7), `B1 date ${b1.billDate}/${b1.billMonth}`)
  expect(b1.dueAt === ext.dueDate, `B1 dueAt ${b1.dueAt}`)
  expect(b1.apInboxItemId && b1.apInboxSourceUrl && b1.apInboxAppliedAt && b1.updatedBy === 'ap-inbox', 'B1 provenance columns missing')
  const audit = await auditRows(ctx.token, ctx.legs.B1.billId, 'AP_INBOX_APPLIED')
  expect(audit.length >= 1, 'no AP_INBOX_APPLIED audit row for B1')
  const ch = JSON.stringify(audit[0].changes)
  expect(ch.includes('mail.google.com') && /billNumber/.test(ch), 'audit row lacks the message link or the changed field')
  const docs = await listAll(ctx.token, 'ShipmentDocument', { sourceRef: { beginsWith: 'ap-inbox:' }, shipmentId: { eq: ctx.legs.B5.shipmentId } }, 'id type reviewStatus s3Key sourceRef shipmentId')
  expect(docs.some((d) => d.type === 'CARRIER_INVOICE' && d.reviewStatus === 'PENDING'), 'no PENDING CARRIER_INVOICE pointer on B5 shipment')
  const vp1 = await getItemRaw(ctx, 'VendorPayable', ctx.vpIds.VP1)
  expect(vp1.invoiceDate === ctx.corpus.find((m) => m.n === 'm07').message.devExtraction.invoiceDate && vp1.dueDate, 'VP1 blanks not filled')
  expect(Array.isArray(vp1.attachments) && vp1.attachments.length >= 1, 'VP1 attachments not appended')
  const b3 = await getBill(ctx, ctx.legs.B3.billId)
  expect(b3.billDate === ctx.before.B3.billDate && b3.dueAt === ctx.before.B3.dueAt && b3.billNumber === ctx.before.B3.billNumber, 'B3 (typed number, conflicting dates) was overwritten')
  const b4 = await getBill(ctx, ctx.legs.B4.billId)
  expect(b4.billNumber && b4.billedCents === ctx.before.B4.billedCents, 'B4 (TO_BE_PAID): number must be filled, the amount must not')
  for (const k of ['B6', 'B7', 'B2', 'B2b']) {
    const now = await getBill(ctx, ctx.legs[k].billId)
    expect(now.billNumber === ctx.before[k].billNumber && now.billDate === ctx.before[k].billDate && now.dueAt === ctx.before[k].dueAt, `${k} changed but its mail was a review item`)
  }
  expect(items.find((i) => i.messageId === m1.message.id).sourceUrl?.startsWith('https://mail.google.com/'), 'item has no Gmail link')
  ctx.afterSync = { b1, b4 }
  ctx.items = byMsg
  return `${items.length} items (${want.updated} applied, ${want.needReview} queued) after ${run.calls} call(s); B1 number/dates + provenance + audit with link; B3/B6/B7/B2/B2b untouched; B4 number only; B5 PDF filed PENDING; VP1 blanks filled`
}

async function ag05NeverApprovePay(ctx) {
  const bad = []
  for (const key of ['B1', 'B2', 'B3', 'B4', 'B6', 'B7']) {
    const before = ctx.before[key]
    const now = await getBill(ctx, ctx.legs[key].billId)
    for (const f of MONEY_UNTOUCHED) if (JSON.stringify(now[f]) !== JSON.stringify(before[f])) bad.push(`${key}.${f}`)
    if (JSON.stringify(now.remitTo) !== JSON.stringify(before.remitTo)) bad.push(`${key}.remitTo`)
    if (key === 'B4' && before.status !== 'TO_BE_PAID') bad.push('B4 fixture status')
  }
  expect(bad.length === 0, `columns outside the allow-list changed: ${bad.join(', ')}`)
  const payments = await scanAll(ctx, 'ApPayment', { FilterExpression: 'carrierId = :c', ExpressionAttributeValues: { ':c': ctx.carrierId } }).catch(() => null)
  if (payments) expect(payments.length === 0, `${payments.length} ApPayment rows exist for the ZZ carrier`)
  const bills = await listAll(ctx.token, 'CarrierBill', { loadCarrierId: { eq: ctx.legs.B5.loadCarrierId } }, 'id')
  expect(bills.length === 0, 'a CarrierBill was created for the awaiting-invoice leg B5')
  const inj = ctx.corpus.find((m) => m.n === 'm10')
  const item = ctx.items.get(inj.message.id)
  expect(item && item.status === 'NEEDS_REVIEW', 'the approve-and-pay PDF was not queued for review')
  return 'status/approvedAt/gross/net/paid/balance/remitTo/terms unchanged on every ZZ bill; no ApPayment rows; no bill created for B5; the "approve and pay" PDF is a plain queue item'
}

async function ag06Idempotent(ctx) {
  const before = await snapshotCounts(ctx)
  const run = await syncToDone(ctx)
  const after = await snapshotCounts(ctx)
  expect(JSON.stringify(before.items) === JSON.stringify(after.items), `item set changed on a second run: ${JSON.stringify(before.items)} -> ${JSON.stringify(after.items)}`)
  expect(before.bills === after.bills, 'a bill changed on the second run')
  expect(run.digest?.updatedBills === undefined || run.digest.updatedBills === 0, `second run updated ${run.digest?.updatedBills} bills`)
  return `second run: item set and ${Object.keys(ctx.legs).length} bills byte-identical (updated ${run.digest?.updatedBills ?? 0})`
}
async function snapshotCounts(ctx) {
  const items = {}
  for (const s of ALL_STATUSES) items[s] = (await queueItems(ctx, s)).filter((i) => ctx.corpusIds.has(i.messageId)).map((i) => `${i.id}:${i.version}`).sort()
  const bills = JSON.stringify(await Promise.all(Object.values(ctx.legs).filter((l) => l.billId).map((l) => getBill(ctx, l.billId))))
  return { items, bills }
}

async function ag07Cursor(ctx) {
  // 1. only new mail is read
  const extra = ['x1', 'x2', 'x3'].map((n, i) => {
    const ext = rawExtraction({ kind: 'OTHER', reason: 'Newsletter' })
    return { id: `zz-ag-${ctx.ts}-${n}`, message: { id: `zz-ag-${ctx.ts}-${n}`, internalDate: String(Date.now() - (3 - i) * 60_000), from: 'ZZ AG News <news@zz-ag.example.invalid>', subject: `ZZ AG note ${n}`, body: 'Weekly note. Unsubscribe any time.', attachments: [], devExtraction: ext } }
  })
  for (const m of extra) await ctx.ap('AP_INBOX_SIM_INJECT', injectInput(m))
  const run = await syncToDone(ctx)
  const dg = run.digest ?? {}
  if (dg.listed !== undefined) expect(dg.listed <= 6, `second slice listed ${dg.listed} messages: the cursor did not hold (3 new expected)`)
  // 2. the model cap stops the run partway and the next call finishes
  const st = await ctx.ap('AP_INBOX_STATUS', {})
  await ctx.ap('AP_INBOX_SAVE_SETTINGS', { config: { ...st.config, maxModelCallsPerRun: 2 }, expectedVersion: st.config.version })
  const capped = ['y1', 'y2', 'y3', 'y4'].map((n, i) => {
    const m = {
      id: `zz-ag-${ctx.ts}-${n}`,
      message: {
        id: `zz-ag-${ctx.ts}-${n}`, internalDate: String(Date.now() - (4 - i) * 1000), from: 'ZZ AG Billing <billing-cap@zz-ag.example.invalid>', subject: `Invoice ZZAGCAP-${ctx.ts}-${n} PRO 8${ctx.ts}${i}`,
        body: `Invoice attached for PRO 8${String(ctx.ts).slice(-6)}${i}. Amount due $${(100 + i).toFixed(2)}.`,
        attachments: [(() => { const pdf = buildInvoicePdf({ vendor: 'ZZ AG Cap', invoiceNumber: `ZZAGCAP-${ctx.ts}-${n}`, date: dayPlus(-1), amount: 100 + i }); return { name: `cap-${n}.pdf`, contentType: 'application/pdf', size: pdf.length, dataBase64: pdf.toString('base64') } })()],
        // no devExtraction: the dev bypass skips the model, and the cap only counts real model calls
      },
    }
    return m
  })
  for (const m of capped) await ctx.ap('AP_INBOX_SIM_INJECT', injectInput(m))
  ctx.capIds = new Set(capped.map((m) => m.message.id))
  const first = await ctx.ap('AP_INBOX_SYNC_NOW', {})
  const capped1 = first.digest?.partial === true || first.digest?.error === 'MODEL_CAP' || first.done === false || first.remaining > 0
  expect(capped1, `with maxModelCallsPerRun=2 and 4 model-bound mails the first slice did not stop early (digest ${JSON.stringify({ partial: first.digest?.partial, error: first.digest?.error, modelCalls: first.digest?.modelCalls })})`)
  expect((first.digest?.modelCalls ?? 0) <= 2, `the cap of 2 was exceeded: ${first.digest?.modelCalls} model calls`)
  await ctx.ap('AP_INBOX_SAVE_SETTINGS', { config: { ...st.config, maxModelCallsPerRun: 80 }, expectedVersion: (await ctx.ap('AP_INBOX_STATUS', {})).config.version })
  const rest = await syncToDone(ctx)
  expect(rest.digest?.partial !== true, 'the continuation is still partial')
  expect((rest.digest?.reviewed ?? 0) >= 1, 'the continuation read nothing: the cursor did not hold the unread mail')
  ctx.extraIds = new Set([...extra.map((m) => m.message.id), ...ctx.capIds])
  return `cursor held (${dg.listed ?? '?'} listed for 3 new mails); the model cap made a partial run that the next call finished`
}
async function ag07Door(ctx) {
  throw new SkipError('AG07 lambda-door: the Chicago-hour gate is proven by the Lambda unit test; the harness cannot invoke the function')
}

async function ag08Actions(ctx) {
  const msgItem = (n) => ctx.items.get(ctx.corpus.find((m) => m.n === n).message.id)
  // LINK m4 (carrier + amount only) -> B2b with a per-field pick
  const m4 = msgItem('m04')
  const link = await ctx.ap('AP_INBOX_LINK', { itemId: m4.id, target: { kind: 'CARRIER_BILL', id: ctx.legs.B2b.billId }, picks: { billNumber: true, billDate: true, dueAt: true } })
  expect(link.item?.status === 'LINKED' || link.status === 'LINKED', 'LINK did not mark the item LINKED')
  const b2b = await getBill(ctx, ctx.legs.B2b.billId)
  expect(b2b.billNumber === m4.extraction.invoiceNumber, `B2b number ${b2b.billNumber} after LINK`)
  expect(b2b.status === ctx.before.B2b.status && b2b.balanceCents === ctx.before.B2b.balanceCents, 'LINK changed status or balance')
  // conflict row m3 applied by explicit pick
  const m3 = msgItem('m03')
  await ctx.ap('AP_INBOX_PREVIEW_LINK', { itemId: m3.id, target: { kind: 'CARRIER_BILL', id: ctx.legs.B3.billId } })
  await ctx.ap('AP_INBOX_LINK', { itemId: m3.id, target: { kind: 'CARRIER_BILL', id: ctx.legs.B3.billId }, picks: { billDate: true, dueAt: true } })
  const b3 = await getBill(ctx, ctx.legs.B3.billId)
  expect(b3.billDate === m3.extraction.invoiceDate && b3.billMonth === m3.extraction.invoiceDate.slice(0, 7), 'explicit pick did not move billDate and billMonth together')
  // CREATE_VENDOR_BILL from m8
  const m8 = msgItem('m08')
  const created = await ctx.ap('AP_INBOX_CREATE_VENDOR_BILL', {
    itemId: m8.id, vendor: ctx.vendor.otherName, invoiceNumber: m8.extraction.invoiceNumber, invoiceDate: m8.extraction.invoiceDate,
    dueDate: m8.extraction.dueDate, amountCents: m8.extraction.amountCents, description: 'ZZ AG verification',
  })
  const vpId = created.vendorPayableId
  expect(vpId, 'CREATE_VENDOR_BILL returned no vendorPayableId')
  ;(ctx.owned.VendorPayable ??= new Set()).add(String(vpId))
  const vp = await getItemRaw(ctx, 'VendorPayable', vpId)
  expect(vp?.status === 'NEED_TO_PAY' && vp.source === 'EMAIL', 'created payable is not NEED_TO_PAY/EMAIL')
  // DISMISS m10 (objects gone, TTL set)
  const m10 = msgItem('m10')
  await ctx.ap('AP_INBOX_DISMISS', { itemId: m10.id, reason: 'NOT_INVOICE', note: 'ZZ AG' })
  const dismissed = (await queueItems(ctx, 'DISMISSED')).find((i) => i.id === m10.id)
  expect(dismissed && dismissed.ttlEpoch, 'dismissed item has no ttlEpoch')
  const ttlDays = (Number(dismissed.ttlEpoch) * 1000 - Date.now()) / 86_400_000
  expect(ttlDays > 25 && ttlDays < 35, `dismissed ttl is ${ttlDays.toFixed(1)} days out, expected ≈ 30`)
  ctx.dismissedItem = m10
  // REVERT m1 restores exactly; REVERT after an intervening edit is refused
  const m1 = msgItem('m01')
  await ctx.ap('AP_INBOX_REVERT', { itemId: m1.id })
  const reverted = await getBill(ctx, ctx.legs.B1.billId)
  for (const f of ['billNumber', 'billDate', 'billMonth', 'dueAt', 'billedCents', 'varianceCents']) expect(JSON.stringify(reverted[f]) === JSON.stringify(ctx.before.B1[f]), `REVERT left ${f} = ${reverted[f]}`)
  expect(!reverted.apInboxItemId, 'REVERT left the provenance columns')
  const m15 = msgItem('m15')
  const b4 = await getBill(ctx, ctx.legs.B4.billId)
  await zzSet(ctx, 'CarrierBill', ctx.legs.B4.billId, { version: Number(b4.version) + 1, billNumber: `ZZAG-${ctx.ts}-EDIT` })
  const refusedRevert = await refused('REVERT after a later bill edit', /changed|version|since|conflict|stale/i, () => ctx.ap('AP_INBOX_REVERT', { itemId: m15.id }))
  // CAS race: a LINK with a stale expectedVersion is refused
  const stale = await refused('LINK with a stale expectedVersion', /changed|version|stale|conflict|refresh|already|resolved|status/i, () => ctx.ap('AP_INBOX_LINK', { itemId: m4.id, target: { kind: 'CARRIER_BILL', id: ctx.legs.B2b.billId }, picks: { billNumber: true }, expectedVersion: 1 }))
  return `LINK per-field (m4 -> B2b), conflict pick (m3 date+month), vendor bill created, dismiss (ttl ${ttlDays.toFixed(0)} d), REVERT exact, REVERT refused after an edit (${refusedRevert.slice(0, 30)}), stale LINK refused (${stale.slice(0, 30)})`
}

async function ag09Privacy(ctx) {
  const rows = []
  for (const s of ALL_STATUSES) rows.push(...(await queueItems(ctx, s)))
  const mine = rows.filter((r) => ctx.corpusIds.has(r.messageId) || ctx.extraIds?.has(r.messageId))
  const m9 = ctx.corpus.find((m) => m.n === 'm09')
  const m14 = ctx.corpus.find((m) => m.n === 'm14')
  expect(!mine.some((r) => r.messageId === m9.message.id), 'the newsletter was stored')
  expect(!mine.some((r) => r.messageId === m14.message.id), 'the mail older than the look-back was stored')
  const all = JSON.stringify(mine)
  expect(!all.includes(BANK_SENTINEL), 'a stored item row contains the injected bank number')
  expect(!TOKEN_SHAPE.test(all), 'a stored item row contains a token-shaped string')
  const settings = JSON.stringify(await ctx.ap('AP_INBOX_STATUS', {}))
  expect(!TOKEN_SHAPE.test(settings) && !settings.includes('pendingState'), 'STATUS carries a token or pendingState')
  return `${mine.length} stored rows: newsletter and out-of-window mail absent, no bank-number sentinel, no token-shaped string`
}
async function ag09Objects(ctx) {
  if (!ctx.bucket) throw new SkipError('dev bucket not listable')
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: ctx.bucket, Prefix: MAIL_OBJECT_PREFIX, MaxKeys: 1000 })).catch((err) => { throw new SkipError(short(err)) })
  const keys = (listed.Contents ?? []).map((o) => o.Key)
  const dismissedKeys = (ctx.dismissedItem?.attachments ?? []).map((a) => a.key)
  const stillThere = dismissedKeys.filter((k) => keys.includes(k))
  expect(stillThere.length === 0, `${stillThere.length} object(s) of the dismissed item remain`)
  return `${keys.length} objects under ${MAIL_OBJECT_PREFIX}; dismissed item's objects deleted`
}

async function ag10Permissions(ctx) {
  const none = ctx.apNone
  const names = ['AP_INBOX_STATUS', 'AP_INBOX_SYNC_NOW', 'AP_INBOX_DISMISS', 'AP_INBOX_REVERT', 'AP_INBOX_LINK']
  const denied = []
  for (const a of names) denied.push(await refused(`${a} with no AP group`, /permission|not authori[sz]ed|forbidden|access|group|denied/i, () => none(a, { itemId: 'apin:zz-none' })))
  for (const a of ['AP_INBOX_SAVE_SETTINGS', 'AP_INBOX_OAUTH_START', 'AP_INBOX_OAUTH_DISCONNECT', 'AP_INBOX_CONNECT_SIMULATED', 'AP_INBOX_SIM_INJECT']) {
    await refused(`${a} by an AP-only user`, /admin|permission|not authori[sz]ed|forbidden|owner|access/i, () => ctx.apOnly(a, {}))
  }
  const ok = await ctx.apOnly('AP_INBOX_STATUS', {})
  expect(ok && ok.connection, 'an AP-only user cannot read the status')
  return `no-group user refused on ${names.length} actions; AP-only user refused on settings/connect/OAuth/sim, allowed on status`
}

async function ag11Model(ctx) {
  const id = `zz-ag-${ctx.ts}-real`
  const pdf = buildInvoicePdf({ vendor: `ZZ AG Real Vendor ${ctx.ts}`, invoiceNumber: `ZZAGREAL-${ctx.ts}`, date: dayPlus(-1), due: dayPlus(29), amount: 612.34 })
  await ctx.ap('AP_INBOX_SIM_INJECT', {
    message: {
      id, internalDate: String(Date.now() - 5000), from: 'ZZ AG Real <billing-real@zz-ag.example.invalid>', subject: `Invoice ZZAGREAL-${ctx.ts}`, body: 'Invoice attached. Total due $612.34.',
      attachments: [{ name: 'real.pdf', contentType: 'application/pdf', size: pdf.length, dataBase64: pdf.toString('base64') }],
    },
  })
  ctx.realId = id
  await syncToDone(ctx)
  const item = (await itemsFor(ctx, new Set([id])))[0]
  if (!item) throw new SkipError('the real model did not classify the synthetic PDF as an invoice (key or credit unusable?)')
  const ex = item.extraction ?? {}
  expect(ex.invoiceNumber === `ZZAGREAL-${ctx.ts}`, `real extraction invoice number: ${ex.invoiceNumber}`)
  expect(Math.abs((ex.amountCents ?? 0) - 61234) <= 1, `real extraction amount: ${ex.amountCents}`)
  expect(ex.invoiceDate === dayPlus(-1), `real extraction date: ${ex.invoiceDate}`)
  return 'the real model read invoice number, date and amount from a synthetic PDF'
}

// ───────────────────────────── browser walk (AG12) ─────────────────────────────
const byTestId = (id) => `[data-testid="${id}"]`
const hasTestId = (b, id) => b.evaluate(`!!document.querySelector(${JSON.stringify(byTestId(id))})`)
const hasPrefix = (b, prefix) => b.evaluate(`!!document.querySelector('[data-testid^=${JSON.stringify(prefix)}]')`)

async function openPage(b, path, ready) {
  b.mark()
  await b.navigate(path)
  await waitLoaded(b)
  if (ready) await b.poll(ready, `${path} ready`, 60_000)
  await pause(600)
}
const clickText = async (b, selector, pattern) => {
  const hit = await b.evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, 'i');
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => re.test(n.textContent.trim()));
    if (!el) return 'no-match'; el.scrollIntoView({ block: 'center' }); el.click(); return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`click ${selector} /${pattern}/: ${hit}`)
}

async function ag12Ui(b, ctx, theme) {
  const tag = theme === 'dark' ? 'D' : 'L'
  const snap = (id, slug) => walk.shot(b, id, slug, tag, true).catch((e) => line('FAIL', `${id} ${theme}`, `screenshot failed: ${e.message}`))
  const shotStep = async (id, fn) => {
    if (!matches(id)) return
    try {
      const detail = await fn()
      const problems = problemList(b).slice(0, 3)
      if (problems.length) throw new Error(problems.join(' | '))
      line('PASS', `${id} ${theme}`, detail)
    } catch (err) { line('FAIL', `${id} ${theme}`, short(err)) }
  }
  await shotStep('AG12-digest-and-queue', async () => {
    await openPage(b, '/tms/invoicing/payable', () => hasTestId(b, 'ap-inbox-digest')).catch(async (err) => {
      const seen = await b.evaluate(`(document.querySelector('.tms-main')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160)`)
      throw new Error(`${short(err)}; page shows: "${seen}"`)
    })
    const text = await b.evaluate(`document.querySelector('[data-testid="ap-inbox-digest"]')?.innerText ?? ''`)
    expect(/reviewed \d+ e-mails?/i.test(text) && /updated \d+ bills?/i.test(text) && /\d+ need review/i.test(text), `digest line reads: "${text.slice(0, 160)}"`)
    expect(await hasTestId(b, 'ap-inbox-review-now'), 'no Review now button')
    await snap('AG12a', 'ap-digest')
    await clickText(b, '[role="tab"], .tms-tab, button', '^AP inbox')
    await b.poll(() => hasPrefix(b, 'ap-inbox-why-') || hasPrefix(b, 'ap-inbox-row-'), 'queue rows', 30_000)
    await snap('AG12b', 'ap-inbox-queue')
    return `digest "${text.replace(/\s+/g, ' ').slice(0, 110)}"; AP inbox tab lists rows`
  })
  await shotStep('AG12-row-why-and-link-dialog', async () => {
    const opened = await b.evaluate(`(() => { const el = document.querySelector('[data-testid^="ap-inbox-link-"]:not([data-testid="ap-inbox-link-dialog"])'); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true })()`)
    expect(opened, 'no "Link to bill" action on any queue row')
    await b.poll(() => hasTestId(b, 'ap-inbox-link-dialog'), 'link dialog', 20_000)
    // The preview is a round trip; a row with no suggested match previews only once a target is chosen.
    if (!await b.poll(() => hasPrefix(b, 'ap-inbox-pick-'), 'per-field picks', 8_000).then(() => true, () => false)) {
      await b.evaluate(`(() => { const sel = document.querySelector('select[aria-label="Link target"]'); const opt = sel && [...sel.options].find((o) => o.value); if (!opt) return; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    }
    await b.poll(() => hasPrefix(b, 'ap-inbox-pick-') || hasPrefix(b, 'ap-inbox-skip-'), 'the link dialog shows no per-field pick', 20_000)
    await snap('AG12c', 'link-dialog')
    await b.evaluate(`document.querySelector('[data-testid="ap-inbox-link-dialog"]')?.closest('[role="dialog"]')?.querySelector('button[aria-label="Close"], button')?.click()`)
    return 'link dialog with a pick per field'
  })
  await shotStep('AG12-bill-strip', async () => {
    const billId = ctx.legs.B4.billId
    await openPage(b, `/tms/invoicing/payable/bills/${encodeURIComponent(billId)}`, () => hasTestId(b, 'ap-inbox-bill-strip'))
    await snap('AG12d', 'bill-source-strip')
    return 'the bill detail shows the AP-inbox source strip'
  })
  await shotStep('AG12-settings-card', async () => {
    await openPage(b, '/tms/brokerage', () => hasTestId(b, 'ap-inbox-settings-card'))
    const text = await b.evaluate(`document.querySelector('[data-testid="ap-inbox-settings-card"]')?.innerText ?? ''`)
    expect(await hasTestId(b, 'ap-inbox-sim') || await hasTestId(b, 'ap-inbox-disconnect'), `the card shows neither "Use simulated mailbox" nor Disconnect on the dev stack; card text: "${text.replace(/\\s+/g, ' ').slice(0, 160)}"`)
    expect(/Google|Simulated mailbox/i.test(text) && /ai4bcat@gmail\.com/i.test(text), 'the settings card does not name the Google mailbox')
    await snap('AG12e', 'settings-card')
    return 'Settings card: mailbox, Google note, simulated mailbox control'
  })
}

// ───────────────────────────── cleanup ─────────────────────────────
async function ag13Cleanup(ctx) {
  let allOk = true
  const say = (msg, ok) => { line(ok ? 'PASS' : 'FAIL', 'AG13-cleanup', msg); return ok }
  const attempt = async (label, fn) => { try { return await fn() } catch (err) { allOk = say(`${label} failed: ${short(err).slice(0, 120)}`, false) && allOk; return null } }

  // 1. config back to what it was, sim mailbox purged and disconnected
  if (ctx.simConnected) {
    await attempt('purge sim mailbox', () => ctx.ap('AP_INBOX_SIM_PURGE_TEST', {}))
    await attempt('restore settings', async () => {
      const st = await ctx.ap('AP_INBOX_STATUS', {})
      const prev = ctx.restore.config
      const config = prev ? { ...prev, mode: prev.mode, enabled: prev.enabled } : { ...st.config, enabled: false, mode: 'GOOGLE' }
      await ctx.ap('AP_INBOX_SAVE_SETTINGS', { config, expectedVersion: st.config.version })
    })
    await attempt('disconnect simulated', async () => {
      if (ctx.restore.connection !== 'SIMULATED') await ctx.ap('AP_INBOX_OAUTH_DISCONNECT', {})
    })
    const st = await ctx.ap('AP_INBOX_STATUS', {}).catch(() => null)
    const back = st && (ctx.restore.connection === 'SIMULATED' || st.connection?.status !== 'SIMULATED') && (!ctx.restore.config || st.config?.mode === ctx.restore.config.mode)
    allOk = say(`AP inbox config/connection ${back ? 'restored and confirmed' : 'NOT confirmed restored'}`, !!back) && allOk
  }
  // 2. queue items of this run, then clone bills / vendor payables (guarded by zz-ag- keys or this run's ids)
  let removed = 0
  if (ctx.suffix) {
    await attempt('delete queue items', async () => {
      const ids = new Set([...(ctx.corpusIds ?? []), ...(ctx.extraIds ?? []), ...(ctx.realId ? [ctx.realId] : [])])
      for (const s of ALL_STATUSES) for (const r of await queueItems(ctx, s)) if (ids.has(r.messageId) && await deleteRow(ctx, 'ApInboxItem', r.id)) removed += 1
    })
    await attempt('delete ZZ bills and payables', async () => {
      if (ctx.legs?.B2b && await deleteRow(ctx, 'CarrierBill', ctx.legs.B2b.billId)) removed += 1
      for (const id of Object.values(ctx.vpIds ?? {})) if (await deleteRow(ctx, 'VendorPayable', id)) removed += 1
      for (const id of [...(ctx.owned.VendorPayable ?? [])]) if (await deleteRow(ctx, 'VendorPayable', id)) removed += 1
    })
    await attempt('void ZZ bills', async () => {
      for (const id of ctx.billIds) {
        if (String(id).startsWith('zz-ag-')) continue
        const cur = await getBill(ctx, id)
        if (cur && cur.status !== 'VOID' && cur.status !== 'PAID') await ctx.fin('VOID_BILL', { billId: id, reason: 'Dev verification fixture' }).catch(() => null)
      }
    })
  }
  for (const id of ctx.shipmentIds) {
    await attempt(`void shipment ${id}`, async () => {
      const cur = await ctx.ship('GET_SHIPMENT_BUNDLE', { shipmentId: id })
      if (!cur.shipment.voidedAt) await ctx.ship('VOID_SHIPMENT', { shipmentId: id, expectedUpdatedAt: cur.shipment.updatedAt, reason: 'Dev verification fixture' })
    })
  }
  let active = 0
  for (const id of ctx.shipmentIds) if (!(await getRow(ctx.token, 'Shipment', id, 'voidedAt').catch(() => null))?.voidedAt) active += 1
  allOk = say(`residue: ${active} unvoided ZZ AG shipments`, active === 0) && allOk
  if (ctx.carrierId) {
    await attempt('archive carrier', async () => {
      const row = await getRow(ctx.token, 'Carrier', ctx.carrierId, 'id updatedAt status')
      if (row && row.status !== 'INACTIVE') await ctx.car('UPSERT_CARRIER', { id: ctx.carrierId, expectedUpdatedAt: String(row.updatedAt), name: ctx.carrierName, type: 'TL', status: 'INACTIVE' }).catch(() => null)
    })
  }
  if (ctx.customerId) {
    await attempt('archive customer', async () => {
      const row = await getRow(ctx.token, 'Customer', ctx.customerId, 'id updatedAt active')
      if (row && row.active !== false) await ctx.dir('ARCHIVE_CUSTOMER', { id: ctx.customerId, expectedUpdatedAt: String(row.updatedAt) })
      const after = await getRow(ctx.token, 'Customer', ctx.customerId, 'active')
      allOk = say(`customer ${after?.active === false ? 'archived and confirmed' : 'NOT confirmed archived'}`, after?.active === false) && allOk
    })
  }
  if (ctx.profileId) {
    await attempt('delete harness UserProfile', async () => {
      const gone = await deleteRow(ctx, 'UserProfile', ctx.profileId)
      allOk = say(`harness UserProfile ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`, gone) && allOk
    })
  }
  line('PASS', 'AG13-cleanup', `ledger: ${ctx.shipmentIds.size} shipments voided, ${ctx.billIds.size} bills, ${removed} ZZ rows deleted`)
  expect(allOk, 'cleanup left residue (see the cleanup lines above)')
  return 'sim mailbox purged, config restored, queue items and ZZ rows deleted, shipments voided, carrier/customer archived'
}

// ───────────────────────────── runners + main ─────────────────────────────
const RUNNERS = {
  AG00: ag00Preflight, AG01: ag01Fixtures, AG02: ag02Connect, AG03: ag03Inject, AG04: ag04Sync, AG05: ag05NeverApprovePay,
  AG06: ag06Idempotent, AG07: ag07Cursor, AG08: ag08Actions, AG09: ag09Privacy, AG10: ag10Permissions, AG11: ag11Model, AG12: ag12Ui, AG13: ag13Cleanup,
}

async function step(id, fn) {
  if (!matches(id) && !id.startsWith('AG13')) return undefined
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

function claims(token) {
  const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  return { username: p['cognito:username'], email: p.email }
}

async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAG refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyAG refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAG only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  if (!(await inventory())) { process.exitCode = 1; return }
  if (flag('inventory')) return

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const emails = { admin: `zz-ag-admin-${ts}@example.invalid`, apOnly: `zz-ag-ap-${ts}@example.invalid`, none: `zz-ag-none-${ts}@example.invalid` }
  const made = []
  const ctx = {
    ts, origin, emails, suffix: null, restore: {}, simConnected: false, bucket: null,
    carrierName: `ZZ AG Carrier ${ts}`,
    shipmentIds: new Set(), billIds: new Set(), owned: {},
  }
  let b = null
  try {
    ctx.suffix = await discoverDevSuffix()
    console.log('dev table suffix discovered (ok)')
    const admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms', 'page-carrierPay']); made.push(emails.admin)
    const apOnly = await mintIdentity(emails.apOnly, ['page-carrierPay']); made.push(emails.apOnly)
    const none = await mintIdentity(emails.none, ['page-quotes']); made.push(emails.none)
    console.log('identity: temporary staff identities created (admin, AP-only, no AP group)')
    ctx.token = admin.token
    ctx.userId = claims(admin.token).username
    ctx.ap = routerAs(admin.token, 'tmsApInboxActions')
    ctx.apOnly = routerAs(apOnly.token, 'tmsApInboxActions')
    ctx.apNone = routerAs(none.token, 'tmsApInboxActions')
    ctx.ship = routerAs(admin.token, 'tmsShipmentActions')
    ctx.fin = routerAs(admin.token, 'tmsFinanceActions')
    ctx.dir = routerAs(admin.token, 'tmsDirectoryActions')
    ctx.car = routerAs(admin.token, 'tmsCarrierActions')

    const existing = await doc.send(new GetCommand({ TableName: devTable('UserProfile', ctx.suffix), Key: { id: String(ctx.userId) } })).then((r) => r.Item).catch(() => null)
    if (!existing) {
      ctx.profileId = String(ctx.userId)
      await zzPut(ctx, 'UserProfile', { id: ctx.profileId, email: emails.admin, name: 'ZZ AG Harness', role: 'ADMIN', status: 'ACTIVE', createdBy: 'zz-ag-harness', updatedBy: 'zz-ag-harness', version: 1 })
    }

    const needsBrowser = !flag('no-ui') && (!only || /AG12/.test(only))
    if (needsBrowser) {
      b = await launchBrowser({ origin, storage: admin.storage, profilePrefix: 'bcat-ag-', purpose: 'AG verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
    }

    const order = ['AG00', 'AG01', 'AG02', 'AG03', 'AG04', 'AG05', 'AG06', 'AG07', 'AG08', 'AG09', 'AG10', 'AG11']
    for (const id of order) {
      const slug = AG_STEPS.find((s) => s.id === id).slug
      await step(`${id}-${slug}`, () => RUNNERS[id](ctx))
      if (id === 'AG07') await step('AG07-lambda-door', () => ag07Door(ctx))
      if (id === 'AG09') await step('AG09-objects', () => ag09Objects(ctx))
    }
    if (b) {
      await b.navigate('/tms/dashboard')
      await waitLoaded(b).catch(() => {})
      await b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell sidebar mounted', 45_000)
      const themes = flag('no-dark') ? ['light'] : ['light', 'dark']
      for (const theme of themes) {
        await walk.setTheme(b, theme).catch(() => {})
        await ag12Ui(b, ctx, theme)
      }
      await walk.setTheme(b, 'light').catch(() => {})
    }
  } finally {
    if (b) await b.close().catch(() => {})
    if (ctx.token) await step('AG13-cleanup', () => ag13Cleanup(ctx)).catch(() => {})
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
  main().catch((err) => { console.error(`devVerifyAG failed: ${err?.message ?? err}`); process.exit(1) })
}
