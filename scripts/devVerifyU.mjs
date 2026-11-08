#!/usr/bin/env node
/**
 * Step U verification against the DEV site (or `npm run dev` on localhost): Shipments Active/All, the removed
 * views/boards/Academy, the division intake e-mail, the Intake area and review page, Move to active.
 *
 *   node scripts/devVerifyU.mjs [--inventory] [--only=<substring>] [--no-dark]
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyU.mjs
 *   [WORKFLOW_AGENT_URL=…] node scripts/devVerifyU.mjs   (ingest steps: INTAKE_WEBHOOK_SECRET from the env, else dev SSM)
 *
 *   --inventory  no network, no browser: completeness gates 1, 3 and 4 only (App.tsx / nav / src imports).
 *   --only=      run only the steps whose id contains the substring (seeds are still created).
 *   --no-dark    skip the dark-theme pass.
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool, any origin outside
 * ALLOWED_ORIGINS, and any DynamoDB table that does not carry the discovered dev suffix (or that carries the
 * production one). Every identity and record it creates is named zz-u-… / ZZ_U… / ZZ U …, tracked, and removed
 * in `finally`; each removal is re-read. Shipments are voided (never deleted), workflow runs dismissed, the
 * rest deleted through the AWS SDK against the dev tables; residue is a failure. Passwords and tokens are
 * never printed. Steps that need the deployed Step U backend (IntakeLoad, INTAKE_* actions, staging, address
 * validation) report `SKIPPED (allowed: ships with the deploy)` while the backend is absent.
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk, SHELL_FACTS, TOKEN_PROBE, shellFailures } from './lib/uiWalk.mjs'
import {
  U_ROUTES, U_KEPT, U_REDIRECTS, U_GONE, SIDEBAR_BANNED, SIDEBAR_BANNED_HREFS, uNavGaps, uGoneGaps, uViewHookGaps,
} from './lib/uRoutes.mjs'

const DEV_APPSYNC = APPSYNC_URL_RE
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const DEV_LAMBDA_PREFIX = STACK.lambdaPrefix
const SHOTS = resolve('Docs/tms-build/screenshots/U')
const REGION = 'us-east-1'
const BACKEND_ALLOWED = 'ships with the deploy'

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']
const SKIP_ALLOWED = {
  'U01-row-menu': 'the row menu is a Radix portal; its Duplicate action is covered by ShipmentsBoard.test.tsx',
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: SKIP_ALLOWED, only })
const { line, report, written, skipLine, problemList, audit, waitLoaded, setTheme, conclude, matches } = walk

// ───────────────────────────── completeness gates ─────────────────────────────
/** Gates 1, 3, 4 (no network). Returns true when all pass. */
export async function inventory() {
  const gaps = await uNavGaps()
  if (gaps.length) { line('FAIL', 'gate 1: U nav items', gaps.join('; ')); return false }
  line('PASS', 'gate 1: U nav items', `${U_ROUTES.length} U routes: nav entry + <Route> + U_ROUTES row; ${U_REDIRECTS.length} redirects routed`)
  const gone = await uGoneGaps()
  if (gone.length) { line('FAIL', 'gate 3: gone-gate', gone.join('; ')); return false }
  line('PASS', 'gate 3: gone-gate', `${U_GONE.length} removed pages are redirects or absent in the source`)
  const hooks = await uViewHookGaps()
  if (hooks.length) { line('FAIL', 'gate 4: no useShipmentViews importer', hooks.join('; ')); return false }
  line('PASS', 'gate 4: no useShipmentViews importer')
  return true
}

// ───────────────────────────── in-page text audit ─────────────────────────────
/** Serialised into the page. Returns failure strings. */
export function uAuditInPage() {
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
const uAudit = async (b) => (await b.evaluate(`(${uAuditInPage})()`)).map((f) => `u: ${f}`)

// ───────────────────────────── browser helpers ─────────────────────────────
const mainText = (b) => b.evaluate(`document.querySelector('.tms-main')?.innerText ?? ''`)
const sidebarText = (b) => b.evaluate(`document.querySelector('.tms-sidebar')?.innerText ?? ''`)
const dialogText = (b) => b.evaluate(`([...document.querySelectorAll('[role="dialog"]')].pop())?.innerText ?? ''`)
const dialogCount = (b) => b.evaluate(`document.querySelectorAll('[role="dialog"]').length`)
const pathname = (b) => b.evaluate('location.pathname')

/** Set a React-controlled input / select / textarea found by `selector`, firing the events React listens to. */
async function setValue(b, selector, value) {
  const hit = await b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no-element';
    if (el.disabled) return 'disabled';
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`set ${selector}: ${hit}`)
}
const byLabel = (label) => `[aria-label="${label}"]`

async function clickIn(b, scope, pattern) {
  const hit = await b.evaluate(`(() => {
    const root = ${JSON.stringify(scope)} === 'dialog' ? [...document.querySelectorAll('[role="dialog"]')].pop() : document.querySelector('.tms-main');
    if (!root) return 'no-scope';
    const re = new RegExp(${JSON.stringify(pattern)}, 'i');
    const el = [...root.querySelectorAll('button')].find((n) => re.test(n.textContent.trim()));
    if (!el) return 'no-match';
    if (el.disabled) return 'disabled';
    el.scrollIntoView({ block: 'center' }); el.click(); return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`click ${scope} /${pattern}/: ${hit}`)
}
const buttonState = (b, pattern) => b.evaluate(`(() => {
  const el = [...document.querySelectorAll('.tms-main button')].find((n) => new RegExp(${JSON.stringify(pattern)}, 'i').test(n.textContent.trim()));
  return el ? (el.disabled ? 'disabled' : 'enabled') : 'absent';
})()`)

async function snap(b, nn, slug, theme) {
  await walk.shot(b, nn, slug, theme, true).catch((e) => line('FAIL', `${nn} ${theme}`, `screenshot failed: ${e.message}`))
}

async function step(id, fn) {
  if (!matches(id)) return
  try {
    const detail = await fn()
    line('PASS', id, typeof detail === 'string' ? detail : undefined)
  } catch (err) {
    line('FAIL', id, String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300))
  }
}
const backendStep = (ctx, id, fn) => (ctx.backend ? step(id, fn) : (matches(id) ? skipLine(id, '', 'Step U backend not deployed', BACKEND_ALLOWED) : undefined))

async function auditRoute(b, route, theme, ref) {
  const id = `${route.nn}-${route.slug}`
  if (!matches(id)) return
  await b.navigate(route.path)
  const failures = []
  try { await waitLoaded(b) } catch (e) { failures.push(e.message) }
  b.mark()
  await pause(700)
  failures.push(...problemList(b).slice(0, 3))
  failures.push(...await audit(b, theme, { wideOk: route.wideOk }))
  const f = await b.evaluate(SHELL_FACTS)
  const t = await b.evaluate(TOKEN_PROBE)
  failures.push(...shellFailures(f, t, ref, { legacyHost: false, scrollOk: true }))
  failures.push(...await uAudit(b))
  await conclude(b, id, theme, route.nn, route.slug, failures)
}

// ───────────────────────────── safety + discovery ─────────────────────────────
const ddb = new DynamoDBClient({ region: REGION })
export const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })

export async function discoverDevSuffix() {
  const suffix = process.env.DEV_TABLE_SUFFIX || STACK.tableSuffix
  if (suffix === PROD_SUFFIX || suffix.includes(PROD_SUFFIX)) throw new Error('refusing the production table suffix')
  await ddb.send(new DescribeTableCommand({ TableName: `Load-${suffix}` })).catch(() => { throw new Error(`no Load-${suffix} table in the account`) })
  return suffix
}
export function devTable(model, suffix) {
  const name = `${model}-${suffix}`
  if (!name.endsWith(`-${suffix}`) || name.includes(PROD_SUFFIX) || suffix === PROD_SUFFIX) throw new Error(`refusing non-dev table ${name}`)
  return name
}

let agentFunction = null
/** The dev workflow-agent Function URL (and its bucket), as devVerifyStepK finds it. */
export async function workflowAgent() {
  if (agentFunction) return agentFunction
  const fromEnv = process.env.WORKFLOW_AGENT_URL ? process.env.WORKFLOW_AGENT_URL.replace(/\/$/, '') : null
  try {
    const { LambdaClient, ListFunctionsCommand, ListFunctionUrlConfigsCommand, GetFunctionConfigurationCommand } = await import('@aws-sdk/client-lambda')
    const lambda = new LambdaClient({ region: REGION })
    let marker
    do {
      const r = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }))
      for (const f of r.Functions ?? []) {
        if (!f.FunctionName?.startsWith(DEV_LAMBDA_PREFIX) || !/workflowagentlambda/.test(f.FunctionName)) continue
        const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: f.FunctionName }))
        const urls = await lambda.send(new ListFunctionUrlConfigsCommand({ FunctionName: f.FunctionName }))
        const url = fromEnv ?? urls.FunctionUrlConfigs?.[0]?.FunctionUrl ?? null
        if (url) { agentFunction = { url: url.replace(/\/$/, ''), bucket: config.Environment?.Variables?.BUCKET_NAME ?? null }; return agentFunction }
      }
      marker = r.NextMarker
    } while (marker)
  } catch (err) {
    if (!fromEnv) throw err
  }
  if (fromEnv) { agentFunction = { url: fromEnv, bucket: null }; return agentFunction }
  throw new Error('no dev workflow-agent Function URL found: set WORKFLOW_AGENT_URL')
}

const sha20 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20)
export const slotFor = (role, messageId) => {
  const prefix = `workflow-inbox/${sha20(messageId)}`
  const sourceKey = `${prefix}/message.json`
  return { prefix, sourceKey, runId: `wf:${role}:${sha20(sourceKey)}` }
}
// The workflow-agent's INBOX_SECRET is the Amplify secret INTAKE_WEBHOOK_SECRET. The harness takes it from the
// environment, else reads it from this app's dev-branch SSM path, else (how the dev branch actually resolves an
// unset branch secret) the app-shared path. Only those two exact names for the dev app are ever read; the value
// is held in this variable and is never printed or written.
const DEV_APP_ID = 'd3dejqzs77khq6'
const SECRET_PATHS = [
  `/amplify/${DEV_APP_ID}/dev/INTAKE_WEBHOOK_SECRET`,
  `/amplify/shared/${DEV_APP_ID}/INTAKE_WEBHOOK_SECRET`,
]
let intakeSecret = null
export async function resolveIntakeSecret() {
  if (intakeSecret) return intakeSecret
  if (process.env.INTAKE_WEBHOOK_SECRET) return (intakeSecret = process.env.INTAKE_WEBHOOK_SECRET)
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm')
  const ssm = new SSMClient({ region: REGION })
  for (const Name of SECRET_PATHS) {
    try {
      const r = await ssm.send(new GetParameterCommand({ Name, WithDecryption: true }))
      if (r.Parameter?.Value) return (intakeSecret = r.Parameter.Value)
    } catch (err) {
      if (err?.name !== 'ParameterNotFound') throw err
    }
  }
  throw new Error(`INTAKE_WEBHOOK_SECRET not in the environment or at ${SECRET_PATHS.join(' / ')}`)
}
export async function postInbox(action, fixture) {
  const { url } = await workflowAgent()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: await resolveIntakeSecret(), action, attachments: [], ...fixture }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
export async function deliver(fixture) {
  const prepared = await postInbox('prepare', fixture)
  if (prepared.status !== 200) throw new Error(`inbox prepare answered ${prepared.status}`)
  const committed = await postInbox('commit', fixture)
  if (committed.status !== 200) throw new Error(`inbox commit answered ${committed.status}`)
  return { committed: committed.body, ...slotFor(fixture.role, fixture.messageId) }
}
export async function deleteInboxPrefix(prefix) {
  const { bucket } = await workflowAgent()
  if (!bucket) return 0
  const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
  const s3 = new S3Client({ region: REGION })
  let token
  let removed = 0
  do {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
    for (const object of listed.Contents ?? []) { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key })).catch(() => {}); removed += 1 }
    token = listed.NextContinuationToken
  } while (token)
  return removed
}

// ───────────────────────────── data reads ─────────────────────────────
export const asJson = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return v } })() : v)

export async function listAllRows(token, field, selection) {
  const items = []
  let next = null
  do {
    const r = await gql(token, `query($n: String) { ${field}(limit: 1000, nextToken: $n) { items { ${selection} } nextToken } }`, { n: next })
    items.push(...r[field].items)
    next = r[field].nextToken
  } while (next)
  return items
}

/** §3's definition, recomputed from GraphQL so the check does not depend on the app's own code. */
async function expectedListCounts(token) {
  const shipments = await listAllRows(token, 'listShipments', 'id status voidedAt deletedAt')
  const orders = await listAllRows(token, 'listOrders', 'shipmentId arStatus readyToInvoiceAt invoiceId')
  const orderBy = new Map()
  for (const o of orders) orderBy.set(o.shipmentId, o)
  let active = 0
  let all = 0
  for (const s of shipments) {
    if (s.voidedAt || s.deletedAt) continue
    all += 1
    const o = orderBy.get(s.id)
    const released = !!o && (o.readyToInvoiceAt != null || o.invoiceId != null || (o.arStatus != null && o.arStatus !== 'DOCS_NEEDED'))
    if (!released && s.status !== 'CANCELED') active += 1
  }
  return { active, all }
}
const footerTotal = (text) => { const m = /Records shown\s+(\d+)\s+of\s+(\d+)/.exec(text); return m ? Number(m[2]) : null }

export const INTAKE_SELECTION = 'id status divisionCode runId subject fields meta confirmed missingFields shipmentId shipmentNumber reviewedBy reviewedAt version'
const intakeRows = (token) => listAllRows(token, 'listIntakeLoads', INTAKE_SELECTION)
export const getRow = async (token, model, id, selection = 'id') => (await gql(token, `query($id: ID!) { get${model}(id: $id) { ${selection} } }`, { id }))[`get${model}`]

// ───────────────────────────── flows ─────────────────────────────
/** U01: the two lists, the removed controls, the kept ones. */
async function shipmentsFlow(b, ctx, theme) {
  const light = theme === 'light'
  for (const list of ['active', 'all']) {
    await step(`U01-${list}-${theme}`, async () => {
      await b.navigate(list === 'all' ? '/tms/shipments?list=all' : '/tms/shipments')
      await waitLoaded(b)
      const expected = (await expectedListCounts(ctx.token))[list]
      // the footer reads "0" until the list query returns (≈1,100 rows), so wait for it to settle on the real count
      await b.poll(async () => footerTotal(await mainText(b)) === expected, `footer total ${expected}`, 60_000).catch(() => {})
      const selected = await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"][aria-selected="true"]')].map((t) => t.textContent.trim()).join('|')`)
      if (!new RegExp(`^${list}`, 'i').test(selected.split('|').find((t) => /^(active|all)/i.test(t)) ?? '')) throw new Error(`selected tabs: ${selected}`)
      const text = await mainText(b)
      const total = footerTotal(text)
      // the board refreshes on a timer; a row created or released mid-run can move the count by the rows that changed
      if (total !== expected) throw new Error(`${list}: footer total ${total}, independent count ${expected}`)
      if (/Save as view/i.test(text) || /\bViews\b/.test(await sidebarText(b))) throw new Error('a saved-view control is still rendered')
      if (await b.evaluate(`!!document.querySelector('.tms-main select[aria-label="View"], .tms-main [aria-label="View"]')`)) throw new Error('the View selector is still rendered')
      if (!/Column Templates/i.test(text)) throw new Error('Column Templates is gone from the filter panel')
      return `${list} total ${total} = independent ${expected}`
    })
  }
  if (!light) return
  await step('U01-all-superset', async () => {
    const { active, all } = await expectedListCounts(ctx.token)
    if (all < active) throw new Error(`ALL ${all} < ACTIVE ${active}`)
    return `all ${all} ≥ active ${active}`
  })
  await step('U01-batch-bar', async () => {
    await b.navigate('/tms/shipments'); await waitLoaded(b)
    await b.poll(() => b.evaluate(`document.querySelectorAll('.tms-main tbody input[type="checkbox"]').length >= 2`), 'selectable rows', 60_000).catch(() => {})
    const boxes = await b.evaluate(`document.querySelectorAll('.tms-main tbody input[type="checkbox"]').length`)
    if (boxes < 2) throw new Error(`only ${boxes} selectable rows`)
    await b.evaluate(`(() => { const c = [...document.querySelectorAll('.tms-main tbody input[type="checkbox"]')].slice(0, 2); c.forEach((x) => x.click()); })()`)
    await b.poll(async () => /Release|Rep/i.test(await mainText(b)), 'batch actions', 10_000)
    return 'two rows selected: batch actions present, not pressed'
  }).catch(() => {})
  if (matches('U01-row-menu')) skipLine('U01-row-menu', '', 'row menu not scripted')
}

/** U02: removed and kept pages. */
async function removalFlow(b) {
  await step('U02-redirects', async () => {
    for (const [, path, expected] of U_REDIRECTS) {
      await b.navigate(path)
      let landed = ''
      await b.poll(async () => { landed = await pathname(b); return landed === expected }, `landing on ${expected}`, 15_000).catch(() => { throw new Error(`${path} landed on ${landed}, expected ${expected}`) })
      if (path.endsWith('all-shipments') && !/list=all/.test(await b.evaluate('location.search'))) throw new Error('all-shipments did not land on ?list=all')
    }
    return `${U_REDIRECTS.length} redirects land on their targets`
  })
  await step('U02-gone', async () => {
    for (const gone of U_GONE) {
      await b.navigate(gone.path)
      await waitLoaded(b).catch(() => {})
      const landed = await pathname(b)
      if (gone.target && landed !== gone.target) throw new Error(`${gone.path} landed on ${landed}, expected ${gone.target}`)
      if (!gone.target && /\/views$/.test(landed)) throw new Error(`${gone.path} still renders at ${landed}`)
      const text = await mainText(b)
      const left = gone.markers.filter((m) => text.includes(m))
      if (left.length) throw new Error(`${gone.path} still renders: ${left.join(', ')}`)
    }
    await b.navigate('/dashboard'); await waitLoaded(b)
    const side = await sidebarText(b)
    const banned = SIDEBAR_BANNED.filter((w) => new RegExp(`\\b${w}\\b`).test(side))
    if (banned.length) throw new Error(`sidebar still names: ${banned.join(', ')}`)
    const hrefs = await b.evaluate(`[...document.querySelectorAll('.tms-sidebar a[href]')].map((a) => new URL(a.href, location.origin).pathname.replace(/\\/$/, ''))`)
    const bannedHrefs = SIDEBAR_BANNED_HREFS.filter((h) => hrefs.includes(h))
    if (bannedHrefs.length) throw new Error(`sidebar still links: ${bannedHrefs.join(', ')}`)
    return `${U_GONE.length} removed pages land elsewhere with no old markers; sidebar clean`
  })
  await step('U02-kept', async () => {
    for (const kept of U_KEPT) {
      await b.navigate(kept.path)
      await waitLoaded(b)
      if ((await mainText(b)).trim().length < 20) throw new Error(`${kept.path} rendered nothing`)
      if ((await pathname(b)) !== kept.path) throw new Error(`${kept.path} redirected to ${await pathname(b)}`)
    }
    return `${U_KEPT.length} kept pages still render`
  })
  await step('U07-dashboard', async () => {
    await b.navigate('/dashboard'); await waitLoaded(b)
    const text = await mainText(b)
    if (/Academy|Workflows/.test(text)) throw new Error('the dashboard still names Academy or Workflows')
    return 'no Academy/Workflows card'
  })
}

/** U03: the division dialog (structure) and the real server sequence (backend). */
async function divisionFlow(b, ctx, theme) {
  const light = theme === 'light'
  await step(`U03-division-dialog-${theme}`, async () => {
    await b.navigate('/tms/brokerage/divisions'); await waitLoaded(b)
    await clickIn(b, 'main', 'Add division')
    await b.poll(async () => (await dialogCount(b)) > 0, 'division dialog', 20_000)
    const text = await dialogText(b)
    if (!/Intake e-mail/i.test(text)) throw new Error('the dialog has no Intake e-mail field')
    // Save stays clickable (DivisionsPage.test.tsx pins this): the required-address problem is the answer to the click.
    await clickIn(b, 'dialog', '^Save')
    await b.poll(async () => /needs an intake e-mail address/i.test(await dialogText(b)), 'required-address message', 10_000).catch(() => { throw new Error('Save with no intake e-mail did not say the address is required') })
    if ((await dialogCount(b)) < 1) throw new Error('the dialog closed on Save with no intake e-mail')
    await setValue(b, '[role="dialog"] input[type="email"]', 'not-an-email')
    await pause(300)
    const errors = await b.evaluate(`document.querySelectorAll('[role="dialog"] .tms-field-error').length`)
    if (errors < 1) throw new Error('a malformed address shows no message')
    await snap(b, 'U05', 'division-dialog-error', theme)
    await setValue(b, '[role="dialog"] input[type="email"]', `zz-u-ui-${ctx.ts}@example.invalid`)
    await pause(300)
    await snap(b, 'U05', 'division-dialog-filled', theme)
    await b.press('Escape')
    return 'Intake e-mail is required; a malformed address is refused in the dialog'
  })
  if (!light) return
  await step('U03-legacy-badge', async () => {
    const legacy = ctx.divisionsBefore.filter((d) => d.active && !d.intakeEmail)
    await b.navigate('/tms/brokerage/divisions'); await waitLoaded(b)
    const text = await mainText(b)
    if (legacy.length === 0) return 'no active division lacks an address'
    if (!/No intake e-mail/i.test(text)) throw new Error(`${legacy.length} divisions lack an address but no badge is shown`)
    await snap(b, 'U06', 'divisions-badge', theme)
    return `${legacy.length} legacy divisions flagged`
  })
}

async function refused(name, pattern, run) {
  try { await run() } catch (err) {
    if (pattern.test(String(err?.message ?? err))) return String(err.message).slice(0, 120)
    throw new Error(`${name} refused for the wrong reason: ${String(err?.message ?? err).slice(0, 160)}`)
  }
  throw new Error(`${name} was allowed`)
}

/** U03 server sequence: required / format / reserved / duplicate. */
async function divisionServerSequence(ctx) {
  const base = { parentId: null, active: true, brand: null, sortOrder: 900 }
  const A = `ZZ_U_${ctx.ts}`
  const B = `ZZ_U2_${ctx.ts}`
  await step('U03-server-required', () => refused('missing address', /intake e-mail|address/i, () => ctx.dir('SAVE_OWNERSHIP_DIVISION', { ...base, code: A, name: `ZZ U ${ctx.ts}`, intakeEmail: '' })))
  await step('U03-server-format', () => refused('not-an-email', /e-?mail|address|valid/i, () => ctx.dir('SAVE_OWNERSHIP_DIVISION', { ...base, code: A, name: `ZZ U ${ctx.ts}`, intakeEmail: 'not-an-email' })))
  await step('U03-server-reserved', () => refused('reserved', /reserved|already|used|cannot|can't/i, () => ctx.dir('SAVE_OWNERSHIP_DIVISION', { ...base, code: A, name: `ZZ U ${ctx.ts}`, intakeEmail: 'quotes@bcatcorp.com' })))
  await step('U03-server-create', async () => {
    const row = await ctx.dir('SAVE_OWNERSHIP_DIVISION', { ...base, code: A, name: `ZZ U ${ctx.ts}`, intakeEmail: ctx.addressA })
    ctx.divisionIds.add(String(row.id ?? A))
    ctx.divisionA = A
    return `created ${A}`
  })
  await step('U03-server-duplicate', () => refused('duplicate', /already receives|already|used by/i, () => ctx.dir('SAVE_OWNERSHIP_DIVISION', { ...base, code: B, name: `ZZ U2 ${ctx.ts}`, intakeEmail: ctx.addressA })))
  await step('U03-server-second', async () => {
    const row = await ctx.dir('SAVE_OWNERSHIP_DIVISION', { ...base, code: B, name: `ZZ U2 ${ctx.ts}`, intakeEmail: `zz-u2-tenders-${ctx.ts}@example.invalid` })
    ctx.divisionIds.add(String(row.id ?? B))
    ctx.divisionB = B
    return `created ${B}`
  })
}

export const tenderBody = (ref, extra = []) => [
  'Tender for your acceptance.', '', `Reference: ${ref}`, 'Pickup: Dallas TX, 08:00', 'Delivery: Atlanta GA, 14:00 two days later',
  'Equipment: 53ft dry van, 38,000 lbs', ...extra, '', 'ZZ U Sender',
].join('\n')

/** U04: real ingest through prepare/commit on the workflow-agent Function URL. */
async function ingestFlow(ctx) {
  const stamp = ctx.ts
  const fixture = (key, over) => ({
    role: 'TENDER', messageId: `zzu-${key}-${stamp}-${randomUUID()}`, receivedAt: new Date().toISOString(),
    fromName: 'ZZ U Sender', ...over,
  })
  // The deterministic reader (src/lib/intakeTender.ts parseSubject) only takes a 5-12 digit reference after a label
  // (`Tender TMS ID n: CITY, ST to CITY, ST`); M1 uses that shape so the reference is provably PARSER-sourced.
  const m1Ref = String(stamp).slice(-10)
  const m1 = fixture('m1', { subject: `Tender TMS ID ${m1Ref}: Dallas, TX to Atlanta, GA`, fromEmail: ctx.senderEmail, bodyText: tenderBody(m1Ref), toAddresses: [ctx.addressA] })
  const m2 = fixture('m2', { subject: `ZZ U sparse tender ${stamp}`, fromEmail: `zz-u-stranger-${stamp}@example.invalid`, bodyText: 'Can you cover a load for us?', toAddresses: [ctx.addressA] })
  const m3 = fixture('m3', { subject: `ZZ U nowhere tender ${stamp}`, fromEmail: ctx.senderEmail, bodyText: tenderBody(`ZZU-NW-${stamp}`), toAddresses: [`zz-u-nowhere-${stamp}@example.invalid`] })
  const m4 = fixture('m4', { subject: `ZZ U rate request ${stamp}`, fromEmail: ctx.senderEmail, bodyText: `Rate request: Dallas TX to Atlanta GA, dry van. ZZ-U-${stamp}`, toAddresses: [ctx.addressA] })
  ctx.mail = {}
  for (const [key, f] of Object.entries({ m1, m2, m3, m4 })) {
    const sent = await deliver(f)
    ctx.mail[key] = { ...sent, fixture: f }
    ctx.prefixes.add(sent.prefix)
    ctx.runIds.add(sent.runId)
  }
  await step('U04-ingest', async () => {
    const wanted = ['m1', 'm2', 'm3'].map((k) => `il:${ctx.mail[k].runId}`)
    const rows = {}
    await ctx.b0.poll(async () => {
      for (const id of wanted) rows[id] ??= await getRow(ctx.token, 'IntakeLoad', id, INTAKE_SELECTION)
      return wanted.every((id) => rows[id])
    }, 'intake rows for M1..M3', 120_000).catch(() => { throw new Error(`staged within 120 s: ${wanted.filter((id) => rows[id]).length}/3`) })
    for (const id of wanted) ctx.intakeIds.add(id)
    const [r1, r2, r3] = wanted.map((id) => rows[id])
    if (r1.divisionCode !== ctx.divisionA) throw new Error(`M1 division ${r1.divisionCode}`)
    if (r2.divisionCode !== ctx.divisionA) throw new Error(`M2 division ${r2.divisionCode}`)
    if (r3.divisionCode != null) throw new Error(`M3 division ${r3.divisionCode}, expected unrouted`)
    const f1 = asJson(r1.fields); const meta1 = asJson(r1.meta)
    if (f1.customerId !== ctx.customerId) throw new Error('M1 customer was not matched from the sender')
    if (meta1.reference?.source !== 'PARSER') throw new Error(`M1 reference source ${meta1.reference?.source}`)
    if (asJson(r2.fields).customerId) throw new Error('M2 (unknown sender) has a customer')
    ctx.rows = { m1: r1, m2: r2, m3: r3 }
    const replay = await postInbox('commit', ctx.mail.m1.fixture)
    if (!/duplicate/i.test(JSON.stringify(replay.body))) throw new Error(`re-commit of M1 answered ${JSON.stringify(replay.body).slice(0, 100)}`)
    const count = (await intakeRows(ctx.token)).filter((r) => r.runId === ctx.mail.m1.runId).length
    if (count !== 1) throw new Error(`M1 has ${count} intake rows after the duplicate commit`)
    return 'M1/M2 routed to the ZZ division, M3 unrouted, duplicate commit adds nothing'
  })
  // M4 is model-dependent: recorded, not asserted
  const m4Row = await getRow(ctx.token, 'IntakeLoad', `il:${ctx.mail.m4.runId}`).catch(() => null)
  console.log(`info: M4 (quote-style mail to the division address) ${m4Row ? 'was staged' : 'was not staged'} — model-dependent, not asserted`)
  if (m4Row) ctx.intakeIds.add(m4Row.id)
}

async function openInIdentity(ctx, storage, prefix, theme, fn) {
  const b = await launchBrowser({ origin: ctx.origin, storage: { ...storage, ...(theme === 'dark' ? { 'tms-theme': 'dark' } : {}) }, profilePrefix: prefix, purpose: 'U verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
  try {
    await b.navigate('/dashboard')
    await b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell sidebar mounted', 45_000)
    return await fn(b)
  } finally { await b.close() }
}

/** U05: the Intake area. */
async function intakeAreaFlow(b, ctx, theme, { viewer = false } = {}) {
  const id = viewer ? 'U05-intake-viewer' : 'U05-intake-area'
  await backendStep(ctx, `${id}-${theme}`, async () => {
    await b.navigate('/tms/shipments/intake?view=division'); await waitLoaded(b)
    const tabs = await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].map((t) => t.textContent.trim())`)
    const divisions = (await listAllRows(ctx.token, 'listOwnershipDivisions', 'code name active')).filter((d) => d.active)
    for (const d of divisions) if (!tabs.some((t) => t.startsWith(d.name))) throw new Error(`no tab for active division ${d.name}`)
    for (const d of (await listAllRows(ctx.token, 'listOwnershipDivisions', 'code name active')).filter((d) => !d.active)) {
      if (tabs.some((t) => t.startsWith(d.name))) throw new Error(`archived division ${d.name} has a tab`)
    }
    if (!tabs.some((t) => t.startsWith(`ZZ U ${ctx.ts}`))) throw new Error('no ZZ division tab')
    await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(`ZZ U ${ctx.ts}`)}))?.click()`)
    await b.poll(async () => (await mainText(b)).includes(ctx.rows.m1.subject), 'M1 listed', 20_000)
    const text = await mainText(b)
    if (!text.includes(ctx.rows.m2.subject)) throw new Error('M2 is not listed under the ZZ tab')
    if (!/of \d+ required/.test(text)) throw new Error('no completeness text')
    await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].find((t) => /^Unassigned/.test(t.textContent.trim()))?.click()`)
    await b.poll(async () => (await mainText(b)).includes(ctx.rows.m3.subject), 'M3 under Unrouted', 20_000)
    if (!viewer) await snap(b, 'U08', 'intake-unrouted', theme)
    const open = (await intakeRows(ctx.token)).filter((r) => r.status === 'OPEN').length
    const badge = await b.evaluate(`(() => { const el = document.querySelector('[data-testid="lifecycle-badge-build"]'); const m = el && /(\\d+)\\s*$/.exec(el.textContent.trim()); return m ? Number(m[1]) : 0 })()`)
    if (badge !== open) throw new Error(`Build lifecycle tab Intake badge ${badge}, open intake count ${open}`)
    await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(`ZZ U ${ctx.ts}`)}))?.click()`)
    await pause(500)
    await snap(b, 'U07', 'intake-tabs', theme)
    return `${tabs.length} tabs; badge ${badge} = ${open} open`
  })
  if (!viewer) return
  await backendStep(ctx, `U05-viewer-readonly-${theme}`, async () => {
    await b.navigate(`/tms/shipments/intake/${encodeURIComponent(ctx.rows.m2.id)}`); await waitLoaded(b)
    const state = await b.evaluate(`(() => { const inputs = [...document.querySelectorAll('.tms-main input:not([type="checkbox"]), .tms-main select')]; return { enabled: inputs.filter((i) => !i.disabled).length, total: inputs.length } })()`)
    if (state.total === 0) throw new Error('no fields rendered')
    if (state.enabled > 0) throw new Error(`${state.enabled} fields are editable for a view-only user`)
    for (const name of ['Move to active', 'Dismiss', 'Save']) if ((await buttonState(b, `^${name}$`)) !== 'absent') throw new Error(`${name} is shown to a view-only user`)
    return 'M2 opens read-only'
  })
}

/** U06: review as the reviewer, then Move to active. */
async function reviewFlow(b, ctx, theme) {
  await backendStep(ctx, `U06-review-${theme}`, async () => {
    await b.navigate(`/tms/shipments/intake/${encodeURIComponent(ctx.rows.m1.id)}`); await waitLoaded(b)
    const text = await mainText(b)
    if (!/Auto-filled/.test(text)) throw new Error('no Auto-filled chip on M1')
    if (!text.includes(ctx.rows.m1.subject)) throw new Error('the source e-mail card does not show the subject')
    const href = await b.evaluate(`document.querySelector('.tms-main a[href^="/tms/workflows/runs/"]')?.getAttribute('href') ?? null`)
    if (href !== `/tms/workflows/runs/${ctx.mail.m1.runId}`) throw new Error(`run link ${href}`)
    if ((await buttonState(b, '^Move to active$')) !== 'disabled') throw new Error('Move to active is not disabled while fields are missing')
    if (!/Needs:/.test(text)) throw new Error('no Needs: list')
    await snap(b, 'U09', 'review-chips', theme)
    await snap(b, 'U10', 'review-needs', theme)
    return 'chips, source card, run link and the Needs: list render'
  })
  if (theme !== 'light') return
  await backendStep(ctx, 'U06-move', async () => {
    // fill what the Needs: list names, then confirm every LOW field
    const bill = await b.evaluate(`(() => { const s = document.querySelector('[aria-label="Bill to"]'); return s && !s.disabled ? [...s.options].map((o) => o.value).filter(Boolean)[0] ?? null : null })()`)
    if (bill) await setValue(b, byLabel('Bill to'), bill)
    await b.evaluate(`[...document.querySelectorAll('.tms-main input[type="checkbox"][aria-label^="Confirm "]')].forEach((c) => c.click())`)
    await pause(500)
    // Step AA gate: a complete load still cannot move until the reviewer presses Mark reviewed.
    if ((await buttonState(b, '^Save')) === 'enabled') { await clickIn(b, 'main', '^Save'); await pause(800) }
    if ((await buttonState(b, '^Mark reviewed$')) !== 'enabled') throw new Error(`Mark reviewed is not available on a complete load: ${((await mainText(b)).match(/Needs:[^\n]*/) ?? ['(no Needs line)'])[0]}`)
    if ((await buttonState(b, '^Move to active$')) !== 'disabled') throw new Error('Move to active is enabled before the load is reviewed')
    await clickIn(b, 'main', '^Mark reviewed$')
    try {
      await b.poll(async () => (await buttonState(b, '^Move to active$')) === 'enabled', 'Move to active after Mark reviewed', 30_000)
    } catch {
      throw new Error(`Move still disabled after Mark reviewed: ${((await mainText(b)).match(/Needs:[^\n]*/) ?? ['(no Needs line)'])[0]}`)
    }
    await clickIn(b, 'main', '^Move to active$')
    await b.poll(async () => /^\/tms\/shipments\/shp-/.test(await pathname(b)), 'navigation to the new shipment', 60_000)
    const shipmentId = (await pathname(b)).split('/').pop()
    ctx.shipmentIds.add(shipmentId)
    const s = await getRow(ctx.token, 'Shipment', shipmentId, 'id number status source revDivision intakeLoadId intakeReviewedBy')
    if (s.status !== 'TENDER_PENDING') throw new Error(`shipment status ${s.status}`)
    if (s.source !== 'TENDER') throw new Error(`shipment source ${s.source}`)
    if (s.revDivision !== ctx.divisionA) throw new Error(`revDivision ${s.revDivision}`)
    if (String(s.intakeReviewedBy).toLowerCase() !== ctx.emails.rev.toLowerCase()) throw new Error(`intakeReviewedBy ${s.intakeReviewedBy}`)
    const intake = await getRow(ctx.token, 'IntakeLoad', ctx.rows.m1.id, INTAKE_SELECTION)
    if (intake.status !== 'MOVED' || intake.shipmentId !== shipmentId) throw new Error(`intake ${intake.status} / ${intake.shipmentId}`)
    const audits = await listAllRows(ctx.token, 'listAuditLogs', 'id entityId entityType action user')
    if (!audits.some((a) => a.action === 'INTAKE_MOVE_TO_ACTIVE' && String(a.user).toLowerCase() === ctx.emails.rev.toLowerCase())) throw new Error('no INTAKE_MOVE_TO_ACTIVE audit row names the reviewer')
    await b.navigate(`/tms/shipments?q=${encodeURIComponent(s.number)}`); await waitLoaded(b)
    await b.poll(async () => (await mainText(b)).includes(s.number), 'the new shipment in Active', 30_000)
    await snap(b, 'U11', 'active-after-move', theme)
    return `moved to ${s.number}: TENDER_PENDING, hand-tagged ${s.revDivision}, audited`
  })
  await backendStep(ctx, 'U06-half-edit', async () => {
    await b.navigate(`/tms/shipments/intake/${encodeURIComponent(ctx.rows.m2.id)}`); await waitLoaded(b)
    await setValue(b, byLabel('Commodity'), 'ZZ U paper')
    await pause(400)
    if ((await buttonState(b, '^Move to active$')) !== 'disabled') throw new Error('M2 can move after editing one field')
    return 'Move stays disabled on M2'
  })
  await backendStep(ctx, 'U06-dismiss', async () => {
    await b.navigate(`/tms/shipments/intake/${encodeURIComponent(ctx.rows.m3.id)}`); await waitLoaded(b)
    await clickIn(b, 'main', '^Dismiss$')
    await b.poll(async () => (await dialogCount(b)) > 0, 'dismiss dialog', 10_000)
    await setValue(b, '[role="dialog"] textarea', 'step U verification fixture')
    await clickIn(b, 'dialog', '^Dismiss$')
    await b.poll(async () => (await getRow(ctx.token, 'IntakeLoad', ctx.rows.m3.id, 'status')).status === 'DISMISSED', 'M3 dismissed', 30_000)
    return 'M3 dismissed with a reason'
  })
}

/** Server probes: M2 cannot move; a viewer and a group-less user are forbidden. */
async function probeFlow(ctx) {
  await backendStep(ctx, 'U06-server-probe', async () => {
    const version = Number((await getRow(ctx.token, 'IntakeLoad', ctx.rows.m2.id, 'version')).version)
    const input = { intakeId: ctx.rows.m2.id, expectedVersion: version }
    await refused('M2 move as admin', /Not ready to move to active/, () => ctx.shipAs.admin('INTAKE_MOVE_TO_ACTIVE', input))
    await refused('move as view-only', /Forbidden/, () => ctx.shipAs.view('INTAKE_MOVE_TO_ACTIVE', input))
    await refused('move as no-group', /Forbidden/, () => ctx.shipAs.none('INTAKE_MOVE_TO_ACTIVE', input))
    return 'invalid M2 refused with "Not ready to move to active"; page-tms and group-less callers Forbidden'
  })
}

async function phonePass(b, ctx) {
  await b.command('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await b.setViewport(390, 844, 2)
  const targets = [...U_ROUTES.filter((r) => r.path === '/tms/shipments' || r.phone).map((r) => ({ id: `${r.nn}-${r.slug}`, path: r.path, nn: r.nn, slug: r.slug }))]
  if (ctx.rows?.m2) targets.push({ id: 'U09-review', path: `/tms/shipments/intake/${encodeURIComponent(ctx.rows.m2.id)}`, nn: 'U09', slug: 'review' })
  for (const t of targets) {
    await step(`${t.id}-phone`, async () => {
      await b.navigate(t.path); await waitLoaded(b).catch(() => {})
      b.mark(); await pause(700)
      const failures = [...problemList(b).slice(0, 3), ...await audit(b, 'light', { wideOk: true }), ...await uAudit(b)]
      const overflow = await b.evaluate('document.documentElement.scrollWidth - window.innerWidth')
      if (overflow > 1) failures.push(`horizontal overflow ${overflow}px`)
      if (failures.length) throw new Error(failures.slice(0, 3).join(' | '))
      await walk.shot(b, t.nn, t.slug, 'M', false).catch(() => {})
      return 'no overflow'
    })
  }
  await b.setViewport(1600, 1000, 1)
}

// ───────────────────────────── cleanup ─────────────────────────────
export async function scanIds(table, ids) {
  const hits = []
  let startKey
  do {
    const page = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: startKey }))
    for (const item of page.Items ?? []) if (ids.has(item.id)) hits.push(item)
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return hits
}
export async function scanAudit(table, runStart, isOurs) {
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
        if (!row?.voidedAt) await ctx.shipAs.admin('VOID_SHIPMENT', { shipmentId: id, reason: 'step U verification fixture', expectedUpdatedAt: String(row?.updatedAt ?? '') })
        const after = await getRow(token, 'Shipment', id, 'voidedAt')
        say(`shipment ${id} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt)
      } catch (err) { say(`shipment ${id} void failed: ${String(err?.message ?? err).slice(0, 100)}`, false) }
    }
    // workflow runs are dismissed (undeletable)
    for (const runId of ctx.runIds) {
      try {
        const run = await ctx.wf('GET_RUN', { id: runId })
        if (run && !['DISMISSED', 'APPLIED'].includes(String(run.outcome))) await ctx.wf('DISMISS_RUN', { id: runId, reason: 'step U verification fixture', expectedVersion: Number(run.version ?? 0) })
        say(`workflow run ${runId.slice(0, 18)}… dismissed`)
      } catch (err) { say(`workflow run ${runId.slice(0, 18)}… could not be dismissed: ${String(err?.message ?? err).slice(0, 80)}`, false) }
    }
    for (const id of ctx.divisionIds) {
      await ctx.dir('ARCHIVE_OWNERSHIP_DIVISION', { id }).catch(() => {})
    }
    if (ctx.customerId) {
      const row = await getRow(token, 'Customer', ctx.customerId, 'id updatedAt').catch(() => null)
      if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id: ctx.customerId, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`customer ${ctx.customerId} archived`), (err) => say(`customer archive failed: ${String(err?.message ?? err).slice(0, 80)}`, false))
    }
  }
  for (const prefix of ctx.prefixes) {
    const removed = await deleteInboxPrefix(prefix).catch(() => -1)
    say(`inbox objects ${prefix}: ${removed < 0 ? 'NOT deleted (no bucket access)' : `${removed} deleted`}`, removed >= 0)
  }
  if (!ctx.suffix) {
    console.log(`residue ids (no AWS credentials, NOT deleted): intake ${[...ctx.intakeIds].join(', ') || '-'}; divisions ${[...ctx.divisionIds].join(', ') || '-'}`)
    process.exitCode = 1
    return
  }
  const intakeT = devTable('IntakeLoad', ctx.suffix)
  const divisionT = devTable('OwnershipDivision', ctx.suffix)
  const auditT = devTable('AuditLog', ctx.suffix)
  const tracked = new Set([...ctx.intakeIds, ...ctx.divisionIds, ...ctx.shipmentIds, ...ctx.runIds])
  const isOurs = (r) => tracked.has(r.entityId) || ctx.trackedEmails.has(String(r.user ?? '').toLowerCase()) || ctx.trackedEmails.has(String(r.entityId ?? '').toLowerCase())
  for (const [table, ids] of [[intakeT, ctx.intakeIds], [divisionT, ctx.divisionIds]]) {
    for (const row of await scanIds(table, ids)) await doc.send(new DeleteCommand({ TableName: table, Key: { id: row.id } }))
    const left = await scanIds(table, ids)
    say(`${table.split('-')[0]} rows removed; re-scan finds ${left.length}`, left.length === 0)
  }
  for (const row of await scanAudit(auditT, ctx.runStart, isOurs)) await doc.send(new DeleteCommand({ TableName: auditT, Key: { id: row.id } }))
  const leftAudit = await scanAudit(auditT, ctx.runStart, isOurs)
  say(`AuditLog rows removed; re-scan finds ${leftAudit.length}`, leftAudit.length === 0)
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyU refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyU refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyU only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  if (!(await inventory())) { process.exitCode = 1; return }
  if (flag('inventory')) return

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const emails = {
    admin: `zz-u-admin-${ts}@example.invalid`, rev: `zz-u-rev-${ts}@example.invalid`,
    view: `zz-u-view-${ts}@example.invalid`, none: `zz-u-none-${ts}@example.invalid`,
  }
  const made = []
  const ctx = {
    ts, origin, emails, runStart: new Date().toISOString(), suffix: null, backend: false,
    trackedEmails: new Set(Object.values(emails)), senderEmail: `zz-u-sender-${ts}@example.invalid`,
    addressA: `zz-u-tenders-${ts}@example.invalid`,
    divisionIds: new Set(), intakeIds: new Set(), shipmentIds: new Set(), runIds: new Set(), prefixes: new Set(),
    divisionsBefore: [], customerId: null,
  }
  ctx.trackedEmails.add(ctx.senderEmail).add(ctx.addressA)

  try {
    try { ctx.suffix = await discoverDevSuffix(); console.log('dev table suffix discovered (ok)') } catch (err) { console.log(`dev DynamoDB unavailable: ${String(err?.message ?? err).slice(0, 160)}`) }

    // mint before calling: groups come from the token
    const admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    const rev = await mintIdentity(emails.rev, ['page-intakeReview', 'page-tms']); made.push(emails.rev)
    const view = await mintIdentity(emails.view, ['page-tms']); made.push(emails.view)
    const none = await mintIdentity(emails.none, []); made.push(emails.none)
    console.log('identity: temporary staff identities created (admin, reviewer, view-only, group-less)')
    ctx.token = admin.token
    ctx.dir = routerAs(admin.token, 'tmsDirectoryActions')
    ctx.wf = routerAs(admin.token, 'tmsWorkflowActions')
    ctx.shipAs = {
      admin: routerAs(admin.token, 'tmsShipmentActions'), view: routerAs(view.token, 'tmsShipmentActions'), none: routerAs(none.token, 'tmsShipmentActions'),
    }
    const adminUsername = Object.entries(admin.storage).find(([k]) => k.endsWith('.LastAuthUser'))?.[1]

    ctx.divisionsBefore = await listAllRows(admin.token, 'listOwnershipDivisions', 'code name active intakeEmail').catch(() => listAllRows(admin.token, 'listOwnershipDivisions', 'code name active'))
    try { await gql(admin.token, 'query { listIntakeLoads(limit: 1) { items { id } } }', {}); ctx.backend = true } catch { ctx.backend = false }
    console.log(`backend: Step U ${ctx.backend ? 'deployed' : 'NOT deployed — backend-dependent steps will be SKIPPED (allowed)'}`)

    if (ctx.backend) await resolveIntakeSecret()
    ctx.b0 = { poll: async (fn, label, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await pause(3000) } throw new Error(`timed out: ${label}`) } }

    if (ctx.backend) {
      await divisionServerSequence(ctx)
      const customer = await ctx.dir('UPSERT_CUSTOMER', {
        name: `ZZ U Customer ${ts}`, creditLimitCents: 100_000_000, defaultSalesRepId: adminUsername ?? null,
        contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ U Sender', email: ctx.senderEmail, types: [] }],
        billToParties: [{ id: `zz-u-bt-${ts}`, name: 'ZZ U Bill To', isDefault: false }],
      })
      ctx.customerId = String(customer.id)
      await ingestFlow(ctx)
    }

    const b = await launchBrowser({ origin, storage: admin.storage, profilePrefix: 'bcat-u-', purpose: 'U verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
    try {
      await b.navigate('/dashboard'); await waitLoaded(b).catch(() => {})
      await b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell sidebar mounted', 45_000)
      const refs = {}
      for (const theme of ['light', 'dark']) { await setTheme(b, theme); refs[theme] = await b.evaluate(SHELL_FACTS) }
      await setTheme(b, 'light')

      await removalFlow(b)
      for (const theme of flag('no-dark') ? ['light'] : ['light', 'dark']) {
        await b.navigate('/dashboard'); await waitLoaded(b).catch(() => {})
        await setTheme(b, theme).catch(() => {})
        for (const route of U_ROUTES) await auditRoute(b, route, theme, refs[theme])
        await shipmentsFlow(b, ctx, theme)
        await divisionFlow(b, ctx, theme)
        await intakeAreaFlow(b, ctx, theme)
      }
      await b.navigate('/dashboard'); await waitLoaded(b).catch(() => {})
      await setTheme(b, 'light').catch(() => {})
      await probeFlow(ctx)
      await phonePass(b, ctx)
    } finally { await b.close() }

    // The light reviewer pass MOVES M1 and DISMISSES M3, so every read of those rows (both viewer passes, the dark
    // reviewer pass) has to happen first: viewers, then the reviewer dark (read-only) and finally light (mutating).
    const themes = flag('no-dark') ? ['light'] : ['light', 'dark']
    for (const theme of themes) {
      await openInIdentity(ctx, view.storage, 'bcat-u-view-', theme, (vb) => intakeAreaFlow(vb, ctx, theme, { viewer: true })).catch((err) => line('FAIL', `U05-viewer-${theme}`, String(err?.message ?? err).slice(0, 200)))
    }
    for (const theme of [...themes].reverse()) {
      await openInIdentity(ctx, rev.storage, 'bcat-u-rev-', theme, (rb) => reviewFlow(rb, ctx, theme)).catch((err) => line('FAIL', `U06-reviewer-${theme}`, String(err?.message ?? err).slice(0, 200)))
    }
  } finally {
    await cleanup(ctx).catch((err) => { console.log(`cleanup: failed (${String(err?.message ?? err).slice(0, 120)})`); process.exitCode = 1 })
    for (const email of [emails.none, emails.view, emails.rev, emails.admin].filter((e) => made.includes(e))) {
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
  main().catch((err) => { console.error(`devVerifyU failed: ${err?.message ?? err}`); process.exit(1) })
}
