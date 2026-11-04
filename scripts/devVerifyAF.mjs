#!/usr/bin/env node
/**
 * Step AF verification against the DEV stack, the ONLY writer of the AF gate (AF-plan §6.4 G10): the on-write latency of the
 * DashboardRollup, plus the one-off backfill after the deploy. `devVerifyPerf` stays read-only (its G0 forbids mutations).
 *
 *   node scripts/devVerifyAF.mjs --inventory   no network: every action the harness calls exists in the handlers, the Lambda and
 *                                              its events exist, the gate wiring in devVerifyPerf / perfBudgets is present
 *   node scripts/devVerifyAF.mjs               G10 (+ backfill) against dev
 *   options: --no-backfill  skip the `{ backfill }` invoke    --only=G10|backfill
 *
 * What a run does (everything it creates is named ZZ AF / zz-af-…, tracked and removed or voided in `finally`):
 *   1. backfill   invokes tms-dashboard-rollup with { backfill: { from: '2024-01', to: <next month> } } once and asserts that every
 *                 month with a non-voided shipment has an M: row (and L:CURRENT exists).
 *   2. G10        creates one ZZ customer and one ZZ shipment through CREATE_SHIPMENT + SAVE_ORDER_FORM in the CURRENT month,
 *                 polls M:<month> until that day's status count rises (<= 60 s), voids the shipment (VOID_SHIPMENT) and polls until
 *                 the count falls again (<= 60 s). Records both latencies. The voided ZZ shipment stays (the AA precedent: a PRO
 *                 number is claimed for good); the ZZ customer is archived.
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool and any Lambda outside the dev stack
 * prefix. Passwords, tokens and row contents are never printed (counts and seconds only). The temporary admin is deleted in
 * `finally` (`identity deleted: true`).
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { LambdaClient, ListFunctionsCommand, InvokeCommand } from '@aws-sdk/client-lambda'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs, region } from './lib/devIdentity.mjs'
import { fullScan } from './lib/perfExpected.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const DEV_PREFIX = 'amplify-d3dejqzs77khq6-de'
const SCHEMA_VERSION = 1
const BACKFILL_FLOOR = '2024-01'
const WRITE_BUDGET_S = 60
/** Plan expectation (10 s batching window + ~3 s recompute); reported, not gated: the gate is WRITE_BUDGET_S. */
const EXPECTED_S = 20

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)
const want = (id) => !only || only === id

export const AF_STEPS = [
  { id: 'backfill', slug: 'lambda-backfill', writes: 'recomputes rollup rows (the Lambda owns the table)' },
  { id: 'G10', slug: 'on-write-latency', writes: 'one ZZ customer, one ZZ shipment (voided), rollup rows' },
]
/** Router actions the harness calls: each must exist in its handler's action union (checked offline by --inventory). */
export const ACTIONS = {
  'amplify/functions/tms-shipment-actions/handler.ts': ['CREATE_SHIPMENT', 'SAVE_ORDER_FORM', 'VOID_SHIPMENT'],
  'amplify/functions/tms-directory-actions/handler.ts': ['UPSERT_CUSTOMER', 'ARCHIVE_CUSTOMER'],
}

const results = []
const record = (status, id, detail = '') => {
  results.push({ status, id, detail })
  console.log(`${status.padEnd(4)} ${id}${detail ? `  ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 160)

const addMonth = (month, delta) => {
  const [y, m] = month.split('-').map(Number)
  const idx = y * 12 + (m - 1) + delta
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

// ───────────────────────────── static gate ─────────────────────────────
export async function inventory() {
  let ok = true
  const check = (pass, id, detail) => { record(pass ? 'PASS' : 'FAIL', id, detail); if (!pass) ok = false }
  for (const [file, actions] of Object.entries(ACTIONS)) {
    const text = await readFile(file, 'utf8').catch(() => null)
    check(text != null, `AF inventory ${file}`, text == null ? 'handler not found' : 'handler found')
    if (text == null) continue
    const missing = actions.filter((a) => !new RegExp(`['"]${a}['"]`).test(text))
    check(missing.length === 0, `AF inventory actions in ${file.split('/').slice(-2)[0]}`, missing.length ? `missing: ${missing.join(', ')}` : actions.join(', '))
  }
  const handler = await readFile('amplify/functions/tms-dashboard-rollup/handler.ts', 'utf8').catch(() => '')
  check(/isBackfill/.test(handler) && /backfill/.test(handler) && /sweep/.test(handler), 'AF inventory rollup Lambda doors', 'stream, { sweep }, { backfill } present')
  const resource = await readFile('amplify/functions/tms-dashboard-rollup/resource.ts', 'utf8').catch(() => '')
  check(/name:\s*['"]tms-dashboard-rollup['"]/.test(resource), 'AF inventory Lambda name', 'tms-dashboard-rollup')
  const guard = await readFile('amplify/devRuleGuard.ts', 'utf8').catch(() => '')
  check(/DashboardRollupSweepRule/.test(guard), 'AF inventory dev guard keeps the sweep rule enabled', 'DashboardRollupSweepRule in KEEP_ENABLED_ON_DEV')
  const budgets = await import('./lib/perfBudgets.mjs')
  check(budgets.KPI_BUDGETS['/tms/dashboard']?.cold === 3 && budgets.KPI_BUDGETS['/tms/dashboard']?.warm === 1.5 && budgets.KPI_BUDGETS['/tms/dashboard']?.spa === 0.8, 'AF inventory /tms/dashboard KPI budgets', 'cold 3 / warm 1.5 / in-app 0.8')
  check(budgets.KPI_BUDGETS['/dashboard']?.cold === 3 && budgets.KPI_BUDGETS['/dashboard']?.warm === 1.5 && budgets.KPI_BUDGETS['/dashboard']?.spa === 1, 'AF inventory /dashboard KPI budgets', 'cold 3 / warm 1.5 / in-app 1')
  check(budgets.LOADER_BUDGETS.rollup?.seconds === 0.6, 'AF inventory rollup read budget', '0.6 s / 2 trips / 0.3 MB')
  return ok
}

// ───────────────────────────── dev Lambda ─────────────────────────────
async function findRollupFunction(lambda) {
  const found = []
  let marker
  do {
    const r = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }))
    found.push(...(r.Functions ?? []).filter((f) => f.FunctionName?.startsWith(DEV_PREFIX) && /dashboardrollup/i.test(f.FunctionName.replace(/[-_]/g, ''))))
    marker = r.NextMarker
  } while (marker)
  if (found.length !== 1) throw new Error(`expected exactly one dev tms-dashboard-rollup function, found ${found.length}`)
  return found[0].FunctionName
}

async function readRows(token, ids) {
  const q = `query { ${ids.map((id, i) => `r${i}: getDashboardRollup(id: ${JSON.stringify(id)}) { id schemaVersion computedAt payload }`).join(' ')} }`
  const data = await gql(token, q, {})
  return ids.map((_, i) => {
    const row = data[`r${i}`]
    if (!row) return null
    return { ...row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload }
  })
}

/** Non-voided shipments of `day` in an M: payload, summed over every scope and status. */
const dayCount = (row, day) => Object.values(row?.payload?.ship?.[day] ?? {}).reduce((a, scope) => a + Object.values(scope.st ?? {}).reduce((x, n) => x + n, 0), 0)

async function pollCount(token, month, day, ok, seconds) {
  const t0 = Date.now()
  let last = null
  while ((Date.now() - t0) / 1000 < seconds) {
    last = dayCount((await readRows(token, [`M:${month}`]))[0], day)
    if (ok(last)) return { seconds: (Date.now() - t0) / 1000, count: last }
    await sleep(2000)
  }
  return { seconds: null, count: last }
}

// ───────────────────────────── steps ─────────────────────────────
async function backfill(token, lambda) {
  const name = await findRollupFunction(lambda)
  const to = addMonth(chicagoToday().slice(0, 7), 1)
  const res = await lambda.send(new InvokeCommand({ FunctionName: name, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({ backfill: { from: BACKFILL_FLOOR, to } })) }))
  const body = JSON.parse(Buffer.from(res.Payload).toString() || '{}')
  if (res.FunctionError || body.errorMessage) throw new Error(`backfill invoke failed: ${short(body.errorMessage ?? res.FunctionError)}`)
  record('PASS', 'backfill invoke', `${BACKFILL_FLOOR}..${to} (summary keys: ${Object.keys(body).join(', ') || 'none'})`)

  const scan = await fullScan(token)
  const months = [...new Set(scan.shipments.filter((s) => !s.voidedAt && s.pickupMonth && s.pickupMonth >= BACKFILL_FLOOR).map((s) => s.pickupMonth))].sort()
  const ids = [...months.map((m) => `M:${m}`), 'L:CURRENT']
  const rows = []
  for (let i = 0; i < ids.length; i += 40) rows.push(...await readRows(token, ids.slice(i, i + 40)))
  const missing = ids.filter((_, i) => !rows[i])
  const stale = rows.filter((r) => r && r.schemaVersion !== SCHEMA_VERSION).length
  record(missing.length === 0 && stale === 0 ? 'PASS' : 'FAIL', 'backfill coverage', missing.length || stale ? `missing ${missing.join(', ') || 'none'}; wrong schemaVersion ${stale}` : `${months.length} month rows + L:CURRENT present at v${SCHEMA_VERSION}`)
}

async function onWriteLatency(ctx) {
  const month = chicagoToday().slice(0, 7)
  const day = chicagoToday()
  const ship = routerAs(ctx.token, 'tmsShipmentActions')
  const dir = routerAs(ctx.token, 'tmsDirectoryActions')
  const ts = Date.now()
  const base = dayCount((await readRows(ctx.token, [`M:${month}`]))[0], day)
  const customer = await dir('UPSERT_CUSTOMER', {
    name: `ZZ AF Customer ${ts}`, creditLimitCents: 100_000_000,
    contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ AF Contact', email: `zz-af-${ts}@example.invalid`, types: [] }],
    billToParties: [{ id: `bt-${randomUUID()}`, name: 'ZZ AF Bill To', isDefault: true }],
  })
  ctx.customerId = String((customer.customer ?? customer).id)
  let bundle = await ship('CREATE_SHIPMENT', { customerId: ctx.customerId })
  const shipmentId = bundle.shipment.id
  ctx.shipmentIds.add(shipmentId)
  bundle = await ship('SAVE_ORDER_FORM', {
    shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt,
    order: { mode: 'FTL', equipmentType: 'Dry Van' },
    stops: [
      { type: 'pickup', name: 'ZZ AF Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${day}T13:00:00.000Z` },
      { type: 'delivery', name: 'ZZ AF Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${day}T23:00:00.000Z` },
    ],
    charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 }],
  })
  const up = await pollCount(ctx.token, month, day, (n) => n >= base + 1, WRITE_BUDGET_S)
  const upS = up.seconds // measured from the moment SAVE_ORDER_FORM returned
  record(upS != null ? 'PASS' : 'FAIL', 'G10 create -> M:<month> count increments', upS != null ? `${upS.toFixed(1)} s (<= ${WRITE_BUDGET_S}; plan expects ~${EXPECTED_S}); day count ${base} -> ${up.count}` : `no increment within ${WRITE_BUDGET_S} s (day count stayed ${up.count}, was ${base})`)
  if (upS == null) return
  const row = await ctx.get(shipmentId)
  await ship('VOID_SHIPMENT', { shipmentId, reason: 'step AF on-write latency fixture', expectedUpdatedAt: String(row?.updatedAt ?? bundle.shipment.updatedAt) })
  ctx.voided.add(shipmentId)
  const down = await pollCount(ctx.token, month, day, (n) => n <= up.count - 1, WRITE_BUDGET_S)
  record(down.seconds != null ? 'PASS' : 'FAIL', 'G10 void -> M:<month> count decrements', down.seconds != null ? `${down.seconds.toFixed(1)} s (<= ${WRITE_BUDGET_S}); day count ${up.count} -> ${down.count}` : `no decrement within ${WRITE_BUDGET_S} s (day count stayed ${down.count})`)
}

async function main() {
  if (flag('inventory')) { if (!(await inventory())) process.exitCode = 1; return }
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAF refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyAF refuses any staff pool other than the dev pool')
  const email = `zz-af-${Date.now()}@example.invalid`
  let made = false
  const ctx = { token: '', customerId: null, shipmentIds: new Set(), voided: new Set(), get: async () => null }
  try {
    const admin = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    console.log('identity: temporary admin created')
    ctx.token = admin.token
    ctx.get = (id) => gql(ctx.token, `query { getShipment(id: ${JSON.stringify(id)}) { id updatedAt voidedAt } }`, {}).then((d) => d.getShipment).catch(() => null)
    const lambda = new LambdaClient({ region })
    if (want('backfill') && !flag('no-backfill')) await backfill(ctx.token, lambda).catch((err) => record('FAIL', 'backfill', short(err)))
    if (want('G10')) await onWriteLatency(ctx).catch((err) => record('FAIL', 'G10', short(err)))
  } finally {
    if (ctx.token) {
      for (const id of ctx.shipmentIds) {
        if (ctx.voided.has(id)) continue
        try {
          const row = await ctx.get(id)
          if (row && !row.voidedAt) await routerAs(ctx.token, 'tmsShipmentActions')('VOID_SHIPMENT', { shipmentId: id, reason: 'step AF on-write latency fixture', expectedUpdatedAt: String(row.updatedAt) })
          console.log(`cleanup: shipment ${id} voided`)
        } catch (err) { console.log(`cleanup: shipment ${id} void failed: ${short(err)}`); process.exitCode = 1 }
      }
      if (ctx.customerId) {
        try {
          const row = (await gql(ctx.token, `query { getCustomer(id: ${JSON.stringify(ctx.customerId)}) { id updatedAt } }`, {})).getCustomer
          if (row) await routerAs(ctx.token, 'tmsDirectoryActions')('ARCHIVE_CUSTOMER', { id: ctx.customerId, expectedUpdatedAt: String(row.updatedAt) })
          console.log('cleanup: ZZ customer archived')
        } catch (err) { console.log(`cleanup: ZZ customer archive failed: ${short(err)}`); process.exitCode = 1 }
      }
    }
    if (made) console.log(`identity deleted: ${await deleteIdentity(email)}`)
  }
  const failed = results.filter((r) => r.status === 'FAIL')
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  if (failed.length) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAF failed: ${short(err)}`); process.exit(1) })
}
