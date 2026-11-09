#!/usr/bin/env node
/**
 * Post-cutover production smoke test, READ-ONLY (CUTOVER_PLAN NB-7). Steps: scripts/lib/smokeSteps.json (`--list`).
 *
 *   BCAT_PROD_ID_TOKEN=<id> BCAT_PROD_ACCESS_TOKEN=<access> BCAT_PROD_REFRESH_TOKEN=<refresh> \   (the last two: browser steps only)
 *   node scripts/smokeProdReadOnly.mjs --read-only --prod-url=<AppSync URL from the runbook> \
 *        [--origin=<https web origin>] [--expect-pool=<pool id>] [--only=RO-02,RO-03] [--out=<screenshot dir>] [--runs=1]
 *   node scripts/smokeProdReadOnly.mjs --list         print the step table (no network, no token)
 *
 * - The AppSync URL is never defaulted and must be a plain AppSync host. The user is an EXISTING read-only smoke user
 *   whose tokens Ryne supplies by env; nothing here mints, changes or deletes an identity (the Cognito client is blocked).
 * - Node side: every request goes through the guard's fetch wrapper (query documents only; router reads by action verb).
 * - Browser side (RO-03..RO-05, need --origin + the access and refresh tokens): navigation, DOM reads and screenshots only; a CDP
 *   Fetch interceptor blocks and counts any non-GET request that is not a read document to AppSync.
 * - The last line is `READ-ONLY ASSERT mutations=0 ...`; any mutation attempt exits 1.
 * - Screenshots hold production data: they go to the OS temp dir (or --out), never into the repo.
 */
import { readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './lib/cdpBrowser.mjs'
import { createWalk } from './lib/uiWalk.mjs'
import { AA_ROUTES } from './lib/aaRoutes.mjs'
import { ROUTES as S2_ROUTES } from './devVerifyS2.mjs'
import { PAGE_PATHS } from './lib/perfBudgets.mjs'
import { measurePage } from './lib/perfProbe.mjs'
import {
  parseReadOnlyConfig, buildBrowserStorage, createReadOnlyGuard, ReadOnlyViolation, isReadRouted, KNOWN_PAGE_LOAD_WRITES,
} from './lib/readOnlyGuard.mjs'

const STEPS_FILE = resolve('scripts/lib/smokeSteps.json')
/** Routes that exist only to seed or reset data: never opened on prod, even to look. */
const WALK_EXCLUDE = new Set(['/tms/brokerage/demo'])
/** Pages that keep a below-the-fold card on 'Loading…' by design (on-visible lazy load, e.g. users' Aljex code mapping): wait for body text only. */
const LAZY_LOADING = new Set(['/tms/brokerage/users'])
const ERROR_TEXT = /something went wrong|application error|unexpected error|failed to load|not authorized|access denied/i

/** Parameter-free page routes of the AA and S2 walks, /new form routes excluded, deduped by path. */
export function walkRoutes() {
  const seen = new Set()
  const out = []
  for (const r of [...AA_ROUTES, ...S2_ROUTES]) {
    if (r.path.includes('{') || /\/new$/.test(r.path) || WALK_EXCLUDE.has(r.path) || seen.has(r.path)) continue
    seen.add(r.path)
    out.push({ id: `${r.nn}-${r.slug}`, nn: r.nn, slug: r.slug, path: r.path, legacy: !!r.legacy || LAZY_LOADING.has(r.path) })
  }
  return out
}

const FORM_ROUTES = [
  { id: 'form-shipment', path: '/tms/shipments/new', waitSelector: '[data-testid="ship-form"]', submitSelector: '[data-testid="ship-form-create"]' },
  { id: 'form-quote', path: '/tms/rates/new', waitSelector: null, submitSelector: null },
]

// ───────────────────────────── API aggregates ─────────────────────────────
const COUNTED = [
  ['Customer', 'listCustomers', false],
  ['Location', 'listLocations', false],
  ['Division', 'listDivisions', false],
  ['Carrier', 'listCarriers', true],
  ['Shipment', 'listShipments', true],
  ['Invoice', 'listInvoices', true],
  ['CarrierBill', 'listCarrierBills', true],
]

async function apiAggregates(gql, say) {
  for (const [model, field, withStatus] of COUNTED) {
    let count = 0
    const byStatus = {}
    let nextToken = null
    do {
      const data = await gql(`query Count($nextToken: String) { ${field}(limit: 1000, nextToken: $nextToken) { items { id${withStatus ? ' status' : ''} } nextToken } }`, { nextToken })
      const node = data[field]
      for (const item of node.items) {
        count += 1
        if (withStatus) byStatus[item.status ?? '(none)'] = (byStatus[item.status ?? '(none)'] ?? 0) + 1
      }
      nextToken = node.nextToken ?? null
    } while (nextToken)
    say('PASS', `RO-02 ${model}`, `${count}${withStatus ? ` ${JSON.stringify(byStatus)}` : ''}`)
  }
  const settings = (await gql('query S($id: ID!) { getTmsSettings(id: $id) { id } }', { id: 'default' })).getTmsSettings
  say(settings ? 'PASS' : 'FAIL', 'RO-02 TmsSettings default', settings ? 'present' : 'missing')
}

// ───────────────────────────── guard self-test ─────────────────────────────
async function guardSelfTest(say) {
  const probe = createReadOnlyGuard({ appsyncUrl: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaa.appsync-api.us-east-1.amazonaws.com/graphql', log: () => {} })
  const calls = []
  const fakeFetch = async (url, init) => { calls.push(init?.body); return { ok: true } }
  const f = probe.wrapFetch(fakeFetch)
  const post = (query, variables = {}) => f('https://aaaaaaaaaaaaaaaaaaaaaaaaaa.appsync-api.us-east-1.amazonaws.com/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) })
  const mustThrow = async (label, fn) => {
    try { await fn() } catch (err) { if (err instanceof ReadOnlyViolation) return; throw err }
    throw new Error(`${label} was NOT refused`)
  }
  await post('query { listCustomers(limit: 1) { items { id } } }')
  await mustThrow('mutation', () => post('mutation M($i: CreateLoadInput!) { createLoad(input: $i) { id } }', { i: {} }))
  await mustThrow('write router action', () => post('mutation($action:String!,$input:AWSJSON!){ tmsShipmentActions(action:$action,input:$input) }', { action: 'CREATE_SHIPMENT', input: '{}' }))
  await post('mutation($action:String!,$input:AWSJSON!){ tmsShipmentActions(action:$action,input:$input) }', { action: 'GET_SHIPMENT_BUNDLE', input: '{}' })
  const stub = (serviceId) => ({ config: { serviceId }, send: async () => ({}) })
  const cognito = probe.wrapSdkClient(stub('Cognito Identity Provider'))
  const ddb = probe.wrapSdkClient(stub('DynamoDB'))
  await mustThrow('cognito admin call', () => cognito.send({ constructor: { name: 'AdminCreateUserCommand' } }))
  await mustThrow('DynamoDB PutItem', () => ddb.send({ constructor: { name: 'PutItemCommand' } }))
  await ddb.send({ constructor: { name: 'GetItemCommand' } })
  if (calls.length !== 2) throw new Error(`expected exactly 2 requests to reach the network, got ${calls.length}`)
  say('PASS', 'RO-01 guard self-test', 'query + router read pass; mutation, write action, Cognito admin, DynamoDB PutItem refused')
}

// ───────────────────────────── browser steps ─────────────────────────────
async function withBrowser(cfg, origin, guard, outDir, fn) {
  const storage = buildBrowserStorage(cfg)
  const b = await launchBrowser({
    origin, allowedOrigins: [origin], storage, profilePrefix: 'bcat-smoke-prod-', purpose: 'Read-only prod smoke',
    viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
  })
  try {
    await b.intercept((req) => guard.decideBrowserRequest(req))
    // preflight: a rejected or incomplete session renders the login form; stop here instead of failing every route
    await b.navigate('/dashboard')
    await b.poll(() => b.evaluate(`!!document.querySelector('.tms-main, input[type="password"]')`), 'the app shell or the login form', 60_000)
    if (await b.evaluate(`!!document.querySelector('input[type="password"]')`)) throw new Error('the browser session is not signed in: check BCAT_PROD_ID_TOKEN / ACCESS / REFRESH belong to one live session of the smoke user')
    return await fn(b)
  } finally {
    await b.close().catch(() => {})
  }
}

async function routeWalk(b, walk) {
  for (const route of walkRoutes()) {
    if (!walk.matches(route.id)) continue
    await b.navigate(route.path)
    const failures = []
    try { await (route.legacy ? walk.waitBody(b) : walk.waitLoaded(b)) } catch (err) { failures.push(err.message) }
    b.mark()
    await b.pause(500)
    const facts = await b.evaluate(`(() => ({ path: location.pathname, text: document.body.innerText.trim().slice(0, 4000), main: !!document.querySelector('.tms-main, .tms-legacy-host'), loginForm: !!document.querySelector('input[type="password"]') }))()`)
    if (/^\/(login|sign-?in|auth)/i.test(facts.path) || facts.loginForm) failures.push(`not signed in (path ${facts.path}${facts.loginForm ? ', login form rendered' : ''}): token rejected?`)
    if (!facts.main && facts.text.length < 20) failures.push('page rendered no shell and no content')
    const err = facts.text.match(ERROR_TEXT)
    if (err) failures.push(`error text on page: "${err[0]}"`)
    failures.push(...walk.problemList(b))
    await walk.conclude(b, route.id, 'light', route.nn, route.slug, failures)
  }
}

async function pageTiming(b, say, runs) {
  for (const path of PAGE_PATHS) {
    for (let i = 0; i < runs; i += 1) {
      const m = await measurePage(b, path, { minRows: 0 })
      const fmt = (v) => (v == null ? 'n/a' : v.toFixed(1))
      const bad = []
      if (m.timedOut) bad.push('timed out')
      // perfProbe's G0 list predates the CS_/AP_INBOX_ read prefixes; judge the logged `field:action` pairs with the guard's classification
      const writes = m.shape.mutations.filter((x) => !isReadRouted(...x.split(':')) && !KNOWN_PAGE_LOAD_WRITES.has(x))
      if (writes.length) bad.push(`mutations in page fetch log: ${writes.join(', ')}`)
      say(bad.length ? 'FAIL' : 'PASS', `RO-04 ${path} run ${i + 1}/${runs}`, bad.length ? bad.join('; ') : `first ${fmt(m.firstRowsS)} s, settled ${fmt(m.settledS)} s, ${m.requests} req, ${m.mb.toFixed(1)} MB, rows ${m.rows} (report only)`)
    }
  }
}

async function formRender(b, walk, say) {
  for (const form of FORM_ROUTES) {
    await b.navigate(form.path)
    const failures = []
    try {
      if (form.waitSelector) await b.waitFor(form.waitSelector, 60_000)
      else await walk.waitLoaded(b)
    } catch (err) { failures.push(err.message) }
    b.mark()
    await b.pause(500)
    if (form.submitSelector && !(await b.evaluate(`!!document.querySelector(${JSON.stringify(form.submitSelector)})`))) failures.push('submit control not found (not clicked: render check only)')
    failures.push(...walk.problemList(b))
    await walk.conclude(b, form.id, 'light', 'RO05', form.id, failures)
  }
}

// ───────────────────────────── main ─────────────────────────────
function printTable(steps) {
  for (const s of steps.steps) console.log(`${s.id}  ${s.kind.padEnd(7)} ${s.title}: ${s.does}`)
  console.log(`\nNOT read-only (${steps.excluded.length}):`)
  for (const e of steps.excluded) console.log(`  ${e.script}: ${e.why}`)
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const steps = JSON.parse(await readFile(STEPS_FILE, 'utf8'))
  if (argv.includes('--list')) { printTable(steps); return }
  const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const only = opt('only')?.split(',')
  const want = (id) => !only || only.includes(id)

  const cfg = parseReadOnlyConfig(argv, env)
  const guard = createReadOnlyGuard({ appsyncUrl: cfg.url })
  const report = []
  const say = (status, name, detail = '') => { report.push(status); console.log(`${status.padEnd(7)}${name}${detail ? ` — ${detail}` : ''}`) }
  const step = async (id, fn) => {
    if (!want(id)) return
    try { await fn() } catch (err) { say('FAIL', id, String(err?.message ?? err).slice(0, 300)) }
  }

  const fetchGuarded = guard.wrapFetch()
  const gql = async (query, variables) => {
    const res = await fetchGuarded(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: cfg.idToken }, body: JSON.stringify({ query, variables }) })
    const body = await res.json()
    if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; ').slice(0, 300))
    return body.data
  }

  await step('RO-00', async () => {
    const i = cfg.identity
    say('PASS', 'RO-00 config', `pool ${i.pool}, groups [${i.groups.join(', ')}], token valid ${i.expiresInMinutes} min, appsync ${new URL(cfg.url).host.split('.')[0].slice(0, 6)}…`)
  })
  await step('RO-01', () => guardSelfTest(say))
  await step('RO-02', () => apiAggregates(gql, say))

  const browserIds = ['RO-03', 'RO-04', 'RO-05'].filter(want)
  if (browserIds.length) {
    const origin = opt('origin')
    if (!origin) say('FAIL', 'browser steps', '--origin=<https web origin from the runbook> is required (never defaulted); skip them with --only=RO-00,RO-01,RO-02')
    else if (!/^https:\/\/[^/]+$/.test(origin)) say('FAIL', 'browser steps', '--origin must be https://<host> with no path')
    else {
      const outDir = resolve(opt('out') ?? join(tmpdir(), `bcat-smoke-prod-${Date.now()}`))
      await mkdir(outDir, { recursive: true })
      console.log(`screenshots (production data, outside the repo): ${outDir}`)
      // a request the interceptor blocked surfaces as ERR_BLOCKED_BY_CLIENT; the guard's counters (not this list) decide pass/fail for it
      const allowProblems = [{ pattern: /ERR_BLOCKED_BY_CLIENT[^ ]* https:\/\/[a-z0-9]+\.appsync-api\./, reason: 'blocked known page-load write; reported by the guard' }]
      const walk = createWalk({ shots: outDir, allowProblems })
      const runs = Number(opt('runs') ?? 1)
      try {
        await withBrowser(cfg, origin, guard, outDir, async (b) => {
          await b.navigate('about:blank')
          if (want('RO-03')) await routeWalk(b, walk)
          if (want('RO-04')) await pageTiming(b, say, runs)
          if (want('RO-05')) await formRender(b, walk, say)
        })
      } catch (err) { say('FAIL', 'browser steps', String(err?.message ?? err).slice(0, 300)) }
      for (const r of walk.report) report.push(r.status)
    }
  }

  const fails = report.filter((s) => s === 'FAIL').length
  console.log(`\nsummary: pass ${report.filter((s) => s === 'PASS').length}, fail ${fails}`)
  const clean = guard.assertZeroMutations() // RO-99
  if (fails > 0 || !clean) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`smokeProdReadOnly failed: ${err?.message ?? err}`); process.exit(1) })
}

export { main }
