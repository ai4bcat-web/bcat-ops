#!/usr/bin/env node
/**
 * S4 verification against the DEV site (or `npm run dev` on localhost): Compliance → Document overview,
 * the Users overview, Financial operations, Expenses, Platform health and the notifications drawer.
 *
 *   node scripts/devVerifyS4.mjs [--inventory] [--only=<substring>] [--no-dark] [--gate]
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyS4.mjs
 *
 *   --inventory  no network, no browser: completeness gates 1 + 2 only (App.tsx routes vs the S3/S4 registries).
 *   --only=      run only the steps whose id contains the substring (seeds are still created).
 *   --no-dark    skip the dark-theme pass.
 *   --gate       run the real pre-sign-up gate step even on localhost (it needs the S4 backend deploy).
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool, any driver pool but
 * the dev driver pool, any origin outside ALLOWED_ORIGINS, and any DynamoDB table / S3 bucket that does not
 * carry the discovered dev suffix (or that carries the production one). Every identity and record it creates is
 * named zz-s4-… / ZZ S4 …, tracked, and removed in `finally`; each removal is re-read. The app's approve /
 * reject / dismiss mutations only ever touch those temp seeded records. Their `AuditLog` rows cannot be deleted
 * by a client (create/read only), so they are deleted through the AWS SDK against the dev table; residue is a
 * failure. Passwords and tokens are never printed.
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListBucketsCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql } from './lib/devIdentity.mjs'
import { createWalk, SHELL_FACTS, TOKEN_PROBE, shellFailures } from './lib/uiWalk.mjs'
import { S4_ROUTES, S4_REDIRECTS, s4NavGaps } from './lib/s4Routes.mjs'
import { requiredLegacyPatterns, coveredPatterns } from './devVerifyS3.mjs'

const DEV_APPSYNC = APPSYNC_URL_RE
const DRIVER_POOL = STACK.driverPoolId
const DRIVER_CLIENT = STACK.driverClientId
const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
const PROD_BUCKET = 'amplify-d3dejqzs77khq6-ma-bcatrateconfirmsbucketf4-8peppeemuqmg'
const DEV_BUCKET_PREFIX = STACK.lambdaPrefix
const SHOTS = resolve('Docs/tms-build/screenshots/S4')
const REGION = 'us-east-1'

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  // The dev Google Maps key is neutered, so Maps logs its own Map ID error; Google-owned, not an app defect.
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name']
const SKIP_ALLOWED = {}
/** Size class of the default TmsDrawer ('md'): the default width has no rule of its own (kit.css styles base, -lg, -xl). */
const DEFAULT_SIZE_CLASSES = ['tms-drawer-md']

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: [...HOOK_CLASSES, ...DEFAULT_SIZE_CLASSES], skipAllowed: SKIP_ALLOWED, only })
const { line, report, written, skipLine, problemList, audit, waitLoaded, setTheme, conclude, matches } = walk

// ───────────────────────────── completeness gates ─────────────────────────────
/** Gates 1 + 2 (no network). Returns true when both pass. */
export async function inventory() {
  const required = await requiredLegacyPatterns()
  const covered = coveredPatterns()
  const missing = required.filter((p) => !covered.has(p))
  if (missing.length) { line('FAIL', 'gate 1: route inventory', `no coverage for: ${missing.join(', ')}`); return false }
  line('PASS', 'gate 1: route inventory', `${required.length} non-/tms patterns covered (S3 + S4 registries)`)
  const gaps = await s4NavGaps()
  if (gaps.length) { line('FAIL', 'gate 2: S4 nav items', gaps.join('; ')); return false }
  line('PASS', 'gate 2: S4 nav items', `${S4_ROUTES.length} S4 routes: nav entry + <Route> + S4_ROUTES row`)
  return true
}

// ───────────────────────────── in-page S4 audit ─────────────────────────────
/** Serialised into the page. Returns failure strings. */
export function s4AuditInPage() {
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
  for (const svg of document.querySelectorAll('.tms-gauge svg')) {
    const r = svg.getBoundingClientRect()
    const label = svg.getAttribute('aria-label') ?? ''
    const centre = svg.closest('.tms-gauge')?.querySelector('.tms-gauge-label')?.textContent?.trim()
    const noData = /no data|unknown|n\/a|—/i.test(label) || centre === '—'
    if (!(r.width > 0 && r.height > 0)) out.push(`gauge "${label}" has no size (${r.width}x${r.height})`)
    else if (!noData && svg.querySelectorAll('[data-filled="true"]').length < 1) out.push(`gauge "${label}" has no filled tick`)
  }
  for (const bar of document.querySelectorAll('.tms-pillbar')) {
    const rows = bar.querySelectorAll('table tbody tr').length
    const attr = bar.getAttribute('data-points') ?? bar.querySelector('[data-points]')?.getAttribute('data-points')
    const empty = !!bar.querySelector('.tms-pillbar-empty')
    const expected = attr != null ? Number(attr) : empty ? 0 : null
    if (expected !== null && rows !== expected) out.push(`pill chart has ${rows} sr-table rows, expected ${expected}`)
    else if (expected === null && rows < 1) out.push('pill chart has no sr-table rows and no empty state')
  }
  for (const frame of document.querySelectorAll('.tms-docframe')) {
    for (const media of frame.querySelectorAll('.tms-docframe-media')) {
      if (!media.hasAttribute('data-tms-paper')) out.push('.tms-docframe-media without data-tms-paper')
    }
  }
  return out
}

async function s4Audit(b) {
  const found = await b.evaluate(`(${s4AuditInPage})()`)
  return found.map((f) => `s4: ${f}`)
}

// ───────────────────────────── browser helpers ─────────────────────────────
/** Click the first element under `scope` ('main' | 'dialog' | css) whose text matches `pattern`. */
async function clickText(b, scope, selector, pattern, { exact = false } = {}) {
  const spec = { scope, selector, pattern, exact }
  const hit = await b.evaluate(`(() => {
    const spec = ${JSON.stringify(spec)};
    const root = spec.scope === 'dialog' ? [...document.querySelectorAll('[role="dialog"]')].pop()
      : spec.scope === 'main' ? document.querySelector('.tms-main') : document.querySelector(spec.scope);
    if (!root) return 'no-scope';
    const re = new RegExp(spec.pattern, 'i');
    const el = [...root.querySelectorAll(spec.selector)].find((n) => (spec.exact ? n.textContent.trim().match(re)?.[0] === n.textContent.trim() : re.test(n.textContent.trim())));
    if (!el) return 'no-match';
    if (el.disabled) return 'disabled';
    el.scrollIntoView({ block: 'center' }); el.click(); return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`click ${scope} ${selector} /${pattern}/: ${hit}`)
}

/** Click a button inside the approval card whose title matches `titlePattern`. */
async function clickCardButton(b, titlePattern, buttonText) {
  const hit = await b.evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(titlePattern)}, 'i');
    const card = [...document.querySelectorAll('article.tms-approval')].find((a) => re.test(a.querySelector('.tms-approval-title')?.textContent ?? ''));
    if (!card) return 'no-card';
    const btn = [...card.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(buttonText)});
    if (!btn) return 'no-button';
    if (btn.disabled) return 'disabled';
    btn.scrollIntoView({ block: 'center' }); btn.click(); return 'ok';
  })()`)
  if (hit !== 'ok') throw new Error(`card /${titlePattern}/ button ${buttonText}: ${hit}`)
}

const mainText = (b) => b.evaluate(`document.querySelector('.tms-main')?.innerText ?? ''`)
const dialogText = (b) => b.evaluate(`([...document.querySelectorAll('[role="dialog"]')].pop())?.innerText ?? ''`)
const dialogCount = (b) => b.evaluate(`document.querySelectorAll('[role="dialog"]').length`)
const waitDialog = (b, label = 'dialog', ms = 20_000) => b.poll(async () => (await dialogCount(b)) > 0, label, ms)
const waitNoDialog = (b, label = 'dialog closed', ms = 10_000) => b.poll(async () => (await dialogCount(b)) === 0, label, ms)
const waitMain = (b, re, label, ms = 30_000) => b.poll(async () => re.test(await mainText(b)), label, ms)

async function snap(b, id, slug, theme, clip = true) {
  await walk.shot(b, id, slug, theme, clip).catch((e) => line('FAIL', `${id} ${theme}`, `screenshot failed: ${e.message}`))
}

/** Screenshot of one element's box (S14: top bar with the bell). */
async function clipShot(b, id, slug, theme, selector) {
  const rect = await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  if (!rect) { line('FAIL', `${id} ${theme}`, `${selector} not found for the clip`); return }
  const file = join(SHOTS, `${id}-${slug}-${theme}.png`)
  const image = await b.command('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } })
  await mkdir(SHOTS, { recursive: true })
  await writeFile(file, Buffer.from(image.data, 'base64'))
  written.push(file)
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
  failures.push(...shellFailures(f, t, ref, { legacyHost: !route.tms, scrollOk: !!route.tms }))
  failures.push(...await s4Audit(b))
  await conclude(b, id, theme, route.nn, route.slug, failures)
}

/** Audit whatever is on screen now (after an interaction); reports one line. */
async function auditNow(b, id, theme, { wideOk = true, shell = true } = {}) {
  const failures = [...problemList(b).slice(0, 3), ...await audit(b, theme, { wideOk, shell }), ...await s4Audit(b)]
  if (failures.length) line('FAIL', `${id} ${theme}`, failures.slice(0, 3).join(' | '))
  else line('PASS', `${id} ${theme}`)
}

// ───────────────────────────── safety + discovery ─────────────────────────────
const ddb = new DynamoDBClient({ region: REGION })
const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } })
const s3 = new S3Client({ region: REGION })
const driverCognito = new CognitoIdentityProviderClient({ region: REGION })

/**
 * The dev stack's table suffix. Other non-production stacks can exist in the account, so the
 * suffix is pinned to the stack the dev AppSync API (DEV_API) belongs to, overridable with
 * DEV_TABLE_SUFFIX; the production suffix is always refused. The table must actually exist.
 */
async function discoverDevSuffix() {
  const suffix = process.env.DEV_TABLE_SUFFIX || STACK.tableSuffix
  if (suffix === PROD_SUFFIX || suffix.includes(PROD_SUFFIX)) throw new Error('refusing the production table suffix')
  await ddb.send(new DescribeTableCommand({ TableName: `Load-${suffix}` })).catch(() => { throw new Error(`no Load-${suffix} table in the account`) })
  return suffix
}

function devTable(model, suffix) {
  const name = `${model}-${suffix}`
  if (!name.endsWith(`-${suffix}`) || name.includes(PROD_SUFFIX) || suffix === PROD_SUFFIX) throw new Error(`refusing non-dev table ${name}`)
  return name
}

async function discoverDevBucket() {
  const r = await s3.send(new ListBucketsCommand({}))
  const found = (r.Buckets ?? []).map((x) => x.Name).filter((n) => n?.startsWith(DEV_BUCKET_PREFIX) && n.includes('bcatrateconfirms') && n !== PROD_BUCKET)
  if (found.length !== 1) throw new Error(`expected one dev bucket, found: ${found.join(', ') || 'none'}`)
  return found[0]
}

// ───────────────────────────── seeds ─────────────────────────────
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const mutate = async (token, name, type, input) => (await gql(token, `mutation($input: ${type}!) { ${name}(input: $input) { id } }`, { input }))[name].id

/** Three-plus distinct, non-private, file-backed driver document types read from the live catalogue. */
async function driverDocTypes() {
  const { DRIVER_REQUIREMENTS } = await import('../src/lib/complianceRequirements.ts')
  const skip = new Set(['cdl_copy', 'medical_card', 'employment_agreement', 'lease_agreement'])
  const picked = DRIVER_REQUIREMENTS.filter((r) => r.requiresDocument && !skip.has(r.key))
  if (picked.length < 4) throw new Error(`DRIVER_REQUIREMENTS has only ${picked.length} usable document types (need 4)`)
  return picked.slice(0, 4).map((r) => ({ key: r.key, label: r.label }))
}

// ───────────────────────────── flows ─────────────────────────────
const rowWith = (...needles) => `(() => {
  const needles = ${JSON.stringify(needles)};
  const rows = [...document.querySelectorAll('.tms-main tr')];
  const row = rows.find((r) => needles.every((n) => r.textContent.includes(n)));
  return row ? row.innerText.replace(/\\s+/g, ' ') : null;
})()`

/** S01 + S02..S05 screenshots: list, review tab, drawer, reject dialog, expiring tab. */
async function complianceFlow(b, ctx, theme) {
  const { A, B, C, E, token, adminEmail } = ctx
  const light = theme === 'light'
  // list, queue and KPI strip were audited by auditRoute; seeded rows first
  await step(`S01a-compliance-seeded-${theme}`, async () => {
    await b.navigate('/compliance?tab=review')
    await waitLoaded(b)
    await b.poll(async () => (await b.evaluate(rowWith('ZZ S4 Driver', E.label))) !== null, 'seeded rows in Needs review', 40_000)
    for (const d of light ? [A, B, E] : [E]) if (!(await b.evaluate(rowWith('ZZ S4 Driver', d.label)))) throw new Error(`${d.label} missing from Needs review`)
    await snap(b, 'S02', 'compliance-review', theme)
    return 'A, B, E listed under Needs review'
  })
  await step(`S03a-compliance-drawer-${theme}`, async () => {
    const target = light ? A : E
    await b.navigate(`/compliance?doc=${encodeURIComponent(`cd:${target.id}`)}`)
    await waitLoaded(b)
    await waitDialog(b, 'document drawer')
    await pause(600)
    const text = await dialogText(b)
    if (!/Approve/.test(text) || !/Reject/.test(text)) throw new Error('drawer lacks Approve / Reject for a pending document')
    if (!/no file attached/i.test(text)) throw new Error('drawer does not show the "no file attached" frame')
    await auditNow(b, `S03b-drawer-audit`, theme)
    await snap(b, 'S03', 'document-drawer', theme)
    return 'Approve + Reject + "no file attached" frame'
  })
  if (!light) return
  await step('S01b-approve-A', async () => {
    await clickText(b, 'dialog', 'button', '^Approve$')
    await b.poll(async () => (await gql(token, `query($id: ID!) { getComplianceDocument(id: $id) { status verifiedBy } }`, { id: A.id })).getComplianceDocument?.status === 'VALID', 'A = VALID', 30_000)
    const stored = (await gql(token, `query($id: ID!) { getComplianceDocument(id: $id) { status verifiedBy } }`, { id: A.id })).getComplianceDocument
    // The injected session has no signInDetails, so AuthContext falls back to the Cognito username (a uuid) as the e-mail.
    const approvers = [adminEmail, ctx.adminUsername].filter(Boolean).map((v) => String(v).toLowerCase())
    if (!approvers.includes(String(stored.verifiedBy).toLowerCase())) throw new Error(`verifiedBy ${stored.verifiedBy} is not the approving admin`)
    await b.poll(async () => /Valid/.test((await b.evaluate(rowWith('ZZ S4 Driver', A.label))) ?? ''), 'row badge flips to Valid without reload', 20_000)
    return 'status VALID, verifiedBy = admin, row badge Valid'
  })
  await step('S01c-reject-B', async () => {
    await b.navigate(`/compliance?doc=${encodeURIComponent(`cd:${B.id}`)}`)
    await waitLoaded(b)
    await waitDialog(b, 'drawer B')
    await clickText(b, 'dialog', 'button', '^Reject$')
    await b.poll(async () => /Reject .*/.test(await dialogText(b)) && (await b.evaluate(`!!document.querySelector('[role="dialog"] textarea')`)), 'reject dialog', 15_000)
    const disabled = await b.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].filter((x) => /^Reject document$/.test(x.textContent.trim())).every((x) => x.disabled)`)
    if (!disabled) throw new Error('Reject document is enabled with an empty reason')
    const reason = 'zz-s4 wrong page'
    await b.evaluate(`(() => { const t = [...document.querySelectorAll('[role="dialog"] textarea')].pop(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(reason)}); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await b.poll(() => b.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].some((x) => /^Reject document$/.test(x.textContent.trim()) && !x.disabled)`), 'Reject enabled once a reason is typed', 10_000)
    await snap(b, 'S04', 'reject-dialog', theme, false)
    await clickText(b, 'dialog', 'button', '^Reject document$')
    await b.poll(async () => (await gql(token, `query($id: ID!) { getComplianceDocument(id: $id) { status rejectionReason } }`, { id: B.id })).getComplianceDocument?.status === 'REJECTED', 'B = REJECTED', 30_000)
    const stored = (await gql(token, `query($id: ID!) { getComplianceDocument(id: $id) { rejectionReason } }`, { id: B.id })).getComplianceDocument
    if (stored.rejectionReason !== reason) throw new Error(`stored rejectionReason "${stored.rejectionReason}" != typed text`)
    return 'button disabled while empty; REJECTED with the typed reason'
  })
  await step('S01d-expiring-and-deeplink', async () => {
    await b.navigate('/compliance?tab=expiring')
    await waitLoaded(b)
    await b.poll(async () => (await b.evaluate(rowWith('ZZ S4 Driver', C.label))) !== null, 'C in the Expiring tab', 40_000)
    const row = await b.evaluate(rowWith('ZZ S4 Driver', C.label))
    if (!/in 5 d/.test(row)) throw new Error(`C row does not read "in 5 d": ${row}`)
    const queue = await mainText(b)
    if (!/Expiring soon[\s\S]*in 5 d/i.test(queue)) throw new Error('queue card does not show C "in 5 d"')
    await snap(b, 'S05', 'compliance-expiring', theme)
    await b.navigate(`/compliance?doc=${encodeURIComponent(`cd:${C.id}`)}`)
    await waitDialog(b, 'deep-linked drawer')
    return 'C in Expiring tab + queue ("in 5 d"); deep link opens the drawer'
  })
}

/** S01p: a page-compliance-only identity and a no-access identity. */
async function permissionFlow(origin, ctx, theme) {
  const mk = (storage, prefix) => launchBrowser({ origin, storage: { ...storage, ...(theme === 'dark' ? { 'tms-theme': 'dark' } : {}) }, profilePrefix: prefix, purpose: 'S4 verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
  await step(`S01p-compliance-identity-${theme}`, async () => {
    const b = await mk(ctx.comp.storage, 'bcat-s4-comp-')
    try {
      await b.navigate(`/compliance?doc=${encodeURIComponent(`cd:${ctx.E.id}`)}`)
      await b.poll(async () => (await dialogCount(b)) > 0, 'drawer for a page-compliance identity', 45_000)
      const text = await dialogText(b)
      if (!/Approve/.test(text)) throw new Error('page-compliance identity does not see Approve on a pending document (D-S4-9)')
      const fails = []
      for (const [path, marker] of [['/platform-health', /Integrations connected/i], ['/financial-operations', /Revenue by division/i]]) {
        await b.navigate(path)
        await pause(4000)
        if (marker.test(await b.evaluate('document.body.innerText'))) fails.push(`${path} rendered for a page-compliance identity`)
      }
      if (fails.length) throw new Error(fails.join('; '))
      return 'compliance renders with Approve; /platform-health and /financial-operations do not render'
    } finally { await b.close() }
  })
  await step(`S01p-no-access-${theme}`, async () => {
    const b = await mk(ctx.none.storage, 'bcat-s4-none-')
    try {
      await b.navigate('/compliance')
      await pause(5000)
      const text = await b.evaluate('document.body.innerText')
      // The topbar prints the route title ("Compliance / Document overview") even on the NoAccess screen, so
      // the NoAccess panel itself is the proof.
      if (!/no page access/i.test(text)) throw new Error(`no NoAccess screen: ${text.replace(/\s+/g, ' ').slice(0, 80)}`)
      return 'NoAccess screen'
    } finally { await b.close() }
  })
}

async function usersFlow(b, ctx, theme) {
  const { token } = ctx
  const light = theme === 'light'
  await step(`S02a-users-overview-${theme}`, async () => {
    await b.navigate('/tms/brokerage/users')
    await waitLoaded(b)
    await b.poll(async () => /New registrations|No registrations waiting/i.test(await b.evaluate('document.body.innerText')), 'registration cards', 40_000)
    const text = await mainText(b)
    for (const label of ['Total users', 'Verified drivers', 'Active staff', 'Pending registrations']) {
      if (!new RegExp(`${label}\\s*\\n?\\s*(\\d+|—)`, 'i').test(text)) throw new Error(`KPI "${label}" is not numeric: ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
    const roleRows = await b.evaluate(`(() => { const card = [...document.querySelectorAll('.tms-main .tms-card')].find((c) => /^\\s*Roles/i.test(c.innerText)); return card ? [...card.querySelectorAll('tbody tr')].map((r) => Number(r.children[2]?.textContent.trim())) : null })()`)
    if (!roleRows) throw new Error('Roles table not found')
    if (roleRows.length !== ctx.roleCount) throw new Error(`roles table has ${roleRows.length} rows, ROLES has ${ctx.roleCount}`)
    const sum = roleRows.reduce((a, c) => a + c, 0)
    const staff = Number(/(\d+) staff/.exec(text)?.[1])
    if (!Number.isFinite(staff)) throw new Error('"N staff" caption not found on the Total users KPI')
    if (sum !== staff) throw new Error(`role counts sum to ${sum}, the page lists ${staff} staff`)
    await snap(b, 'S06', 'users-overview', theme)
    if (light) await snap(b, 'S16', 'users-non-owner-admin', theme)
    return `KPIs numeric; ${roleRows.length} role rows summing to ${sum}`
  })
  if (!light) return
  await step('S02b-approve-application', async () => {
    try {
      await b.poll(() => b.evaluate(`[...document.querySelectorAll('article.tms-approval')].some((a) => new RegExp(${JSON.stringify(`ZZ S4 Applicant|${ctx.applicantId}`)}, 'i').test(a.textContent))`), 'application card', 30_000)
    } catch (err) {
      throw new Error(`${err.message}; cards: ${await b.evaluate(`JSON.stringify([...document.querySelectorAll('article.tms-approval .tms-approval-title')].map((t) => t.textContent.trim().slice(0, 40)))`)}`)
    }
    // REAL-DEFECT probe, kept as its own line: the card title should be the driver's name, not the driver id.
    const named = await b.evaluate(`[...document.querySelectorAll('article.tms-approval .tms-approval-title')].some((t) => /ZZ S4 Applicant/i.test(t.textContent))`)
    if (!named) line('FAIL', `S02b-card-names-driver ${theme}`, 'registration card for the applicant is titled with the driver uuid, not the name (app store drivers not hydrated on /tms/brokerage/users?)')
    await snap(b, 'S07', 'registration-cards', theme)
    await clickCardButton(b, `ZZ S4 Applicant|${ctx.applicantId}`, 'Approve')
    await b.poll(async () => (await gql(token, `query($id: ID!) { getDriverApplication(id: $id) { status } }`, { id: ctx.applicationId })).getDriverApplication?.status === 'APPROVED', 'application APPROVED', 30_000)
    return 'DriverApplication.status = APPROVED'
  })
  await step('S02c-dismiss-blocked-signup', async () => {
    const { blockedA, blockedB } = ctx
    await b.navigate('/tms/brokerage/users')
    await waitLoaded(b)
    await b.poll(() => b.evaluate(`[...document.querySelectorAll('article.tms-approval')].some((a) => a.textContent.includes(${JSON.stringify(blockedA)}))`), 'blocked sign-up cards', 40_000)
    if (!(await b.evaluate(`[...document.querySelectorAll('article.tms-approval')].some((a) => a.textContent.includes(${JSON.stringify(blockedB)}))`))) throw new Error('card b missing')
    await clickCardButton(b, blockedA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'Dismiss')
    await b.poll(async () => {
      return (await auditRows(token, { entityId: { eq: blockedA }, action: { eq: 'driver_signup_dismissed' } })) > 0
    }, 'driver_signup_dismissed row for a', 30_000)
    await b.navigate('/tms/brokerage/users')
    await waitLoaded(b)
    await b.poll(() => b.evaluate(`[...document.querySelectorAll('article.tms-approval')].some((a) => a.textContent.includes(${JSON.stringify(blockedB)}))`), 'card b after reload', 40_000)
    if (await b.evaluate(`[...document.querySelectorAll('article.tms-approval')].some((a) => a.textContent.includes(${JSON.stringify(blockedA)}))`)) throw new Error('dismissed card a is still shown after reload')
    return 'dismissal row written; a gone, b remains after reload'
  })
  if (ctx.gate.email) {
    await step('S02d-real-gate-card', async () => {
      await b.poll(() => b.evaluate(`[...document.querySelectorAll('article.tms-approval')].some((a) => a.textContent.includes(${JSON.stringify(ctx.gate.email)}))`), 'real-gate refusal card', 40_000)
      return 'the real refusal appears as a Blocked sign-up card'
    })
  }
}

async function financialFlow(b, theme) {
  const light = theme === 'light'
  const windowText = async () => (/\d{4}-\d{2}-\d{2}\s*→\s*\d{4}-\d{2}-\d{2}/.exec(await b.evaluate('document.body.innerText')) ?? [])[0] ?? null
  await step(`S03a-financial-periods-${theme}`, async () => {
    await b.navigate('/financial-operations')
    await waitLoaded(b)
    await b.poll(windowText, 'window subtitle', 40_000)
    await pause(1500)
    const seen = []
    const periods = light ? ['This month', 'Last month', 'Last 3 months'] : ['This month']
    for (const label of periods) {
      if (label !== 'This month') {
        await clickText(b, '[aria-label="Window"]', 'button', `^${label}$`)
        await b.poll(async () => { const w = await windowText(); return w && !seen.includes(w) }, `window to change for ${label}`, 30_000)
        await waitLoaded(b)
        await pause(1500)
      }
      seen.push(await windowText())
      const fails = [...await s4Audit(b), ...problemList(b).slice(0, 2)]
      const margin = await b.evaluate(`(() => { const t = document.querySelector('.tms-main')?.innerText ?? ''; const m = /Avg margin per shipment\\s*\\n?\\s*([^\\n]+)/i.exec(t); return m ? m[1].trim() : null })()`)
      if (margin === null) fails.push('Avg margin KPI not found')
      else if (/^\$0\.00$/.test(margin)) fails.push('Avg margin KPI shows $0.00 (no data must read —)')
      if (label === 'Last 3 months' && light) await snap(b, 'S09', 'financial-operations-3mo', theme)
      if (fails.length) throw new Error(`${label}: ${fails.slice(0, 3).join(' | ')}`)
    }
    if (new Set(seen).size !== seen.length) throw new Error(`period tabs did not re-window: ${seen.join(' / ')}`)
    if (light) await clickText(b, '[aria-label="Window"]', 'button', '^This month$')
    return light ? `windows: ${seen.join(' | ')}` : undefined
  })
  if (light) {
    await step('S03b-financial-csv', async () => {
      await waitLoaded(b)
      // the button reads "Download" and stays disabled until the weekly series has loaded
      await b.poll(() => b.evaluate(`[...document.querySelectorAll('.tms-main button')].some((x) => /download|csv|export/i.test(x.textContent + (x.getAttribute('aria-label') ?? '')) && !x.disabled)`), 'enabled Download button', 30_000)
      return 'CSV button enabled'
    })
  }
  await snap(b, 'S08', 'financial-operations', theme)
}

const periodGroups = (b) => b.evaluate(`[...document.querySelectorAll('.tms-main [role="group"][aria-label$="period"]')].map((g) => [...g.querySelectorAll('button')].find((x) => x.getAttribute('aria-pressed') === 'true')?.textContent.trim() ?? null)`)

async function expensesFlow(b, ctx, theme) {
  const light = theme === 'light'
  await step(`S04a-expenses-scopes-${theme}`, async () => {
    await b.navigate('/expenses')
    await waitLoaded(b)
    await b.poll(async () => (await periodGroups(b)).length >= 3, 'three period toggles', 40_000)
    await pause(1500)
    for (const scope of light ? ['Box trucks', 'Amazon', 'Local'] : []) {
      await clickText(b, '[aria-label="Fleet"]', 'button', `^${scope}$`)
      await pause(1200)
      const fails = [...await s4Audit(b), ...problemList(b).slice(0, 2)]
      if ((await periodGroups(b)).length < 3) fails.push(`${scope}: fewer than three period toggles`)
      if (fails.length) throw new Error(`${scope}: ${fails.slice(0, 3).join(' | ')}`)
    }
    await snap(b, 'S10', 'expenses', theme)
    return 'Local / Box trucks / Amazon render'
  })
  await step(`S04b-expenses-period-${theme}`, async () => {
    const order = light ? ['D', 'W', 'M'] : ['M']
    for (const p of order) {
      await clickText(b, '.tms-main [role="group"][aria-label$="period"]', 'button', `^${p}$`, { exact: true })
      await pause(900)
      const pressed = await periodGroups(b)
      if (pressed.length < 3 || pressed.some((v) => v !== p)) throw new Error(`after ${p}: toggles read ${JSON.stringify(pressed)}`)
      if (p === 'W' && light) await snap(b, 'S11', 'expenses-week', theme)
    }
    return light ? 'D / W / M move all three cards' : undefined
  })
  await step(`S04c-expenses-hours-${theme}`, async () => {
    await b.poll(async () => (await b.evaluate(`!!document.querySelector('.tms-main table.sr-only, .tms-main table.tms-sr-only')`)), 'hours sr-table', 40_000)
    const cell = await b.evaluate(`(() => { for (const t of document.querySelectorAll('.tms-main table.sr-only, .tms-main table.tms-sr-only')) { if (!/hours worked per driver/i.test(t.querySelector('caption')?.textContent ?? '')) continue; const r = [...t.querySelectorAll('tbody tr')].find((x) => x.textContent.includes('ZZ S4 Driver')); if (r) return r.children[1]?.textContent.trim() } return null })()`)
    if (cell !== ctx.expectedHours) throw new Error(`hours for ZZ S4 Driver = ${cell}, expected ${ctx.expectedHours}`)
    return `ZZ S4 Driver ${cell}`
  })
  if (ctx.truckId) {
    await step(`S04d-receipt-modals-${theme}`, async () => {
      await b.navigate('/expenses')
      await waitLoaded(b)
      await b.poll(async () => (await b.evaluate(rowWith('ZZ S4 Vendor', '$123.45'))) !== null, 'seeded receipts', 45_000)
      const open = async (amount) => {
        await b.evaluate(`(() => { const r = [...document.querySelectorAll('.tms-main tr')].find((x) => x.textContent.includes('ZZ S4 Vendor') && x.textContent.includes(${JSON.stringify(amount)})); r.querySelector('button').click() })()`)
        await waitDialog(b, `receipt ${amount}`)
        await pause(900)
      }
      await open('$123.45')
      let text = await dialogText(b)
      if (!/Pending/i.test(text)) throw new Error('receipt 1 is not PENDING')
      const red = await b.evaluate(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].pop(); const p = document.createElement('i'); p.style.color = 'var(--tms-badge-red)'; d.appendChild(p); const want = getComputedStyle(p).color; p.remove(); const el = [...d.querySelectorAll('*')].find((n) => n.children.length === 0 && n.textContent.trim() === '$123.45'); return el ? { want, got: getComputedStyle(el).color } : null })()`)
      if (!red) throw new Error('amount element not found in the receipt dialog')
      if (red.want !== red.got) throw new Error(`amount colour ${red.got} != --tms-badge-red ${red.want}`)
      if (ctx.payableAttached) {
        await b.poll(() => b.evaluate(`!!document.querySelector('[role="dialog"] img[data-tms-paper]')`), 'receipt image', 20_000)
        const ok = await b.evaluate(`(() => { const i = document.querySelector('[role="dialog"] img[data-tms-paper]'); return i.complete && i.naturalWidth > 0 })()`)
        if (!ok) throw new Error('receipt image did not decode')
      }
      await auditNow(b, 'S04e-receipt-audit', theme)
      if (light) {
        await b.setViewport(1600, 1000, 2)
        await snap(b, 'S12', 'receipt-pending', theme, false)
        await b.setViewport(1600, 1000, 1)
      } else await snap(b, 'S12', 'receipt-pending', theme, false)
      await b.press('Escape')
      await waitNoDialog(b, 'Esc closes the receipt dialog')
      await open('$67.89')
      text = await dialogText(b)
      if (!/Paid/i.test(text)) throw new Error('receipt 2 is not PAID')
      if (!/No image on file/i.test(text)) throw new Error('receipt 2 should show "No image on file"')
      if (light) await snap(b, 'S12', 'receipt-paid', theme, false)
      await b.press('Escape')
      await waitNoDialog(b)
      return ctx.payableAttached ? 'PENDING (red amount, image) and PAID (no image)' : 'PENDING (red amount) and PAID'
    })
  } else if (light) skipLine('S04d-receipt-modals', theme, 'no LOCAL truck to attach seeded invoices to', 'no LOCAL-group truck Equipment on the dev stack')
}

async function healthFlow(b, ctx, theme) {
  await step(`S05a-platform-health-${theme}`, async () => {
    await b.navigate('/platform-health')
    await waitLoaded(b)
    await b.poll(async () => /Integrations connected\s*\n?\s*\d+ of \d+/i.test(await mainText(b)), 'integration KPIs', 45_000)
    await pause(1500)
    const text = await mainText(b)
    const connected = /Integrations connected\s*\n?\s*(\d+) of (\d+)/i.exec(text)
    const attention = /Needs attention\s*\n?\s*(\d+)/i.exec(text)
    const neutered = /(\d+) neutered on dev/i.exec(text)
    if (!connected || !attention) throw new Error('KPIs are not numeric')
    const dom = await b.evaluate(`(() => { const labels = [...document.querySelectorAll('.tms-main .tms-badge')].map((x) => x.textContent.trim()); return { bad: labels.filter((l) => l === 'Invalid credentials' || l === 'Unable to verify').length, neutered: labels.filter((l) => /neutered on dev/i.test(l)).length } })()`)
    if (dom.bad !== Number(attention[1])) throw new Error(`Needs attention ${attention[1]} != ${dom.bad} failing rows in the table`)
    if (neutered && dom.neutered !== Number(neutered[1])) throw new Error(`neutered tally ${neutered[1]} != ${dom.neutered} neutered rows`)
    const rows = await b.evaluate(`(() => { const card = [...document.querySelectorAll('.tms-main .tms-card')].find((c) => /^\\s*Integrations/i.test(c.innerText)); return card ? card.querySelectorAll('tbody tr').length : 0 })()`)
    if (rows < Number(connected[2])) throw new Error(`integrations table has ${rows} rows, fewer than ${connected[2]} applicable providers`)
    if (ctx.integrationAttention !== null && ctx.integrationAttention !== Number(attention[1])) {
      throw new Error(`Needs attention ${attention[1]} != ${ctx.integrationAttention} recomputed from the GraphQL list excluding NEUTERED_ON_DEV`)
    }
    const deployed = ctx.origin === DEV_ORIGIN
    if (deployed && !/Dev stack/i.test(text)) throw new Error('dev banner missing on the deployed dev site')
    if (!deployed && !/Dev stack|local build/i.test(text)) throw new Error('neither the dev banner nor "local build" is shown on localhost')
    await snap(b, 'S13', 'platform-health', theme)
    return `${connected[1]} of ${connected[2]} connected; ${attention[1]} need attention; ${rows} rows`
  })
}

const bellCount = (b) => b.evaluate(`(() => { const x = document.querySelector('button.tms-bell, button[aria-label^="Notifications"]'); if (!x) return null; const m = /^Notifications(?:: (\\d+))?$/.exec(x.getAttribute('aria-label') ?? ''); return m ? Number(m[1] ?? 0) : -1 })()`)
const drawerTabs = (b) => b.evaluate(`[...document.querySelectorAll('[role="dialog"] [aria-label="Notification kinds"] button')].map((x) => ({ label: x.childNodes[0]?.textContent.trim() ?? x.textContent.trim(), count: Number(x.querySelector('.tms-seg-count')?.textContent.trim() ?? NaN) }))`)

async function bellFlow(b, ctx, theme) {
  const light = theme === 'light'
  await step(`S06a-bell-drawer-${theme}`, async () => {
    await b.navigate('/dashboard')
    await waitLoaded(b)
    await b.poll(async () => (await bellCount(b)) !== null, 'bell button', 30_000)
    await pause(3500)
    const n = await bellCount(b)
    if (n === -1) throw new Error('bell aria-label is not "Notifications: N"')
    await clipShot(b, 'S14', 'topbar-bell', theme, '.tms-topbar')
    await b.click('button.tms-bell, button[aria-label^="Notifications"]')
    await waitDialog(b, 'notifications drawer')
    await pause(900)
    const tabs = await drawerTabs(b)
    if (n === 0) {
      if (!/all caught up/i.test(await dialogText(b))) throw new Error('count 0 but the drawer is not "all caught up"')
      return 'bell 0 / all caught up'
    }
    const all = tabs.find((t) => t.label === 'All')
    const kinds = tabs.filter((t) => t.label !== 'All')
    const sum = kinds.reduce((a, t) => a + t.count, 0)
    if (!all || all.count !== n) throw new Error(`bell ${n} != All tab ${all?.count}`)
    if (sum !== n) throw new Error(`bell ${n} != sum of tab counts ${sum} (${JSON.stringify(kinds)})`)
    await auditNow(b, 'S06b-drawer-audit', theme)
    await snap(b, 'S15', 'notifications-all', theme, false)
    ctx.bellKinds = kinds
    return `bell ${n} = Σ tabs (${kinds.map((t) => `${t.label} ${t.count}`).join(', ')})`
  })
  await step(`S06c-bell-documents-${theme}`, async () => {
    if (!(await dialogCount(b))) throw new Error('drawer closed')
    // Driver document rows reach the bell only once the app store has loaded the drivers, so re-read the tab for a while.
    const readDocs = async () => {
      const docs = (await drawerTabs(b)).find((t) => /Documents expiring/i.test(t.label))
      if (!docs) return { docs: null, hrefs: [] }
      await clickText(b, 'dialog', '[aria-label="Notification kinds"] button', '^Documents expiring')
      await pause(500)
      return { docs, hrefs: await b.evaluate(`[...document.querySelectorAll('[role="dialog"] a.tms-notification-row')].map((a) => a.getAttribute('href'))`) }
    }
    let { docs, hrefs } = await readDocs()
    const endAt = Date.now() + 30_000
    while (!(docs && hrefs.some((h) => decodeURIComponent(h).includes(`doc=cd:${ctx.C.id}`))) && Date.now() < endAt) {
      await pause(2000)
      ;({ docs, hrefs } = await readDocs())
    }
    if (!docs) throw new Error('no Documents expiring group although C expires in 5 d')
    const want = `doc=${encodeURIComponent(`cd:${ctx.C.id}`)}`
    if (light) await snap(b, 'S15', 'notifications-documents', theme, false)
    const link = hrefs.find((h) => decodeURIComponent(h).includes(`doc=cd:${ctx.C.id}`))
    if (!link) {
      if (docs.count > hrefs.length) { line('SKIPPED', `S06c-bell-C-${theme}`, `(allowed: the drawer lists ${hrefs.length} of ${docs.count} document items; C is beyond the cap)`); return 'C beyond the drawer cap' }
      throw new Error(`seeded C is not under Documents expiring (tab count ${docs.count}; ${hrefs.length} rows: ${hrefs.map((h) => decodeURIComponent(h).slice(0, 44)).join(' ')}; want cd:${ctx.C.id})`)
    }
    if (!light) return 'C listed'
    await b.evaluate(`[...document.querySelectorAll('[role="dialog"] a.tms-notification-row')].find((a) => decodeURIComponent(a.getAttribute('href')).includes(${JSON.stringify(decodeURIComponent(want))})).click()`)
    await b.poll(async () => (await b.evaluate('location.pathname')) === '/compliance' && (await b.evaluate('decodeURIComponent(location.search)')).includes(`doc=cd:${ctx.C.id}`), 'navigate to /compliance?doc=cd:C', 20_000)
    await waitDialog(b, 'compliance drawer opened by the bell link')
    return 'C under Documents expiring; click opens /compliance with the drawer'
  })
  if (light) {
    await step('S06d-bell-links-resolve', async () => {
      await b.navigate('/dashboard')
      await waitLoaded(b)
      await pause(3000)
      await b.click('button.tms-bell, button[aria-label^="Notifications"]')
      await waitDialog(b, 'drawer')
      await pause(600)
      const kinds = (await drawerTabs(b)).filter((t) => t.label !== 'All')
      const targets = []
      for (const k of kinds) {
        await clickText(b, 'dialog', '[aria-label="Notification kinds"] button', `^${k.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
        await pause(300)
        const href = await b.evaluate(`document.querySelector('[role="dialog"] a.tms-notification-row')?.getAttribute('href') ?? null`)
        if (href) targets.push([k.label, href])
      }
      const bad = []
      for (const [label, href] of targets) {
        await b.navigate(href)
        b.mark()
        await pause(3500)
        const text = await b.evaluate('document.body.innerText')
        if (/no page access|not found|permission/i.test(text) && !/Notifications/.test(label)) bad.push(`${label} → ${href} shows an access/not-found screen`)
        const p = problemList(b)
        if (p.length) bad.push(`${label} → ${href}: ${p[0].slice(0, 80)}`)
      }
      if (bad.length) throw new Error(bad.join('; '))
      return `${targets.length} group(s) visited: ${targets.map(([l]) => l).join(', ')}`
    })
    await step('S06e-bell-escape', async () => {
      await b.navigate('/dashboard')
      await waitLoaded(b)
      await b.poll(async () => (await bellCount(b)) !== null, 'bell', 20_000)
      await b.click('button.tms-bell, button[aria-label^="Notifications"]')
      await waitDialog(b, 'drawer')
      await b.press('Escape')
      await waitNoDialog(b, 'Esc closes the drawer')
    })
  }
}

async function phonePass(b, ctx) {
  await b.command('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await b.setViewport(390, 844, 2)
  for (const route of S4_ROUTES.filter((r) => r.phone)) {
    const id = `PH-${route.nn}-${route.slug}`
    if (!matches(id) && !matches('phone')) continue
    await b.navigate(route.path)
    await b.command('Page.bringToFront').catch(() => {})
    const failures = []
    await waitLoaded(b).catch((e) => failures.push(e.message))
    await setTheme(b, 'light').catch(() => {})
    b.mark()
    await pause(1500)
    failures.push(...problemList(b).slice(0, 3))
    const f = await b.evaluate(SHELL_FACTS)
    if (f.docW > f.winW + 2) failures.push(`page overflows horizontally on phone (${f.docW} > ${f.winW})`)
    failures.push(...await audit(b, 'light', { wideOk: true }), ...await s4Audit(b))
    await conclude(b, id, 'light', `${route.nn}p`, `${route.slug}-phone`, failures, false)
  }
  const id = 'PH-S06-bell-drawer'
  if (matches(id) || matches('phone')) {
    const failures = []
    await b.navigate('/dashboard')
    await waitLoaded(b).catch((e) => failures.push(e.message))
    await pause(3500)
    b.mark()
    try {
      const visible = await b.evaluate(`(() => { const x = document.querySelector('button.tms-bell, button[aria-label^="Notifications"]'); if (!x) return false; const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right <= innerWidth })()`)
      if (!visible) failures.push('bell is not visible on the phone top bar')
      else {
        await b.click('button.tms-bell, button[aria-label^="Notifications"]')
        await waitDialog(b, 'drawer on phone')
        await pause(900)
        const f = await b.evaluate(SHELL_FACTS)
        if (f.docW > f.winW + 2) failures.push(`drawer overflows horizontally on phone (${f.docW} > ${f.winW})`)
        const fits = await b.evaluate(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].pop(); const r = d.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 })()`)
        if (!fits) failures.push('drawer is wider than the phone viewport')
        failures.push(...await audit(b, 'light', { wideOk: true }), ...await s4Audit(b), ...problemList(b).slice(0, 2))
        await conclude(b, id, 'light', 'S15p', 'notifications-phone', failures, false)
        await b.press('Escape')
      }
    } catch (e) { failures.push(e.message) }
    if (failures.length && !written.some((w) => w.includes('S15p'))) line('FAIL', `${id} light`, failures.slice(0, 3).join(' | '))
  }
  await b.setViewport(1600, 1000, 1)
  void ctx
}

/** Gate 3: the legacy review URL lands on the new page. */
async function redirectStep(b) {
  for (const [, path, expected] of S4_REDIRECTS) {
    await step(`R ${path}`, async () => {
      await b.navigate(path)
      let landed = ''
      await b.poll(async () => { landed = await b.evaluate('location.pathname'); return landed === expected }, `landing on ${expected}`, 15_000).catch(() => { throw new Error(`landed on ${landed}, expected ${expected}`) })
      return `→ ${expected}`
    })
  }
}

// ───────────────────────────── real pre-sign-up gate ─────────────────────────────
/**
 * Count AuditLog rows matching a filter. AppSync applies `filter` AFTER scanning `limit` items, so a
 * single page misses rows on a table with history: follow nextToken to the end.
 */
async function auditRows(token, filter) {
  let n = null
  let count = 0
  do {
    const r = await gql(token, `query($f: ModelAuditLogFilterInput, $n: String) { listAuditLogs(filter: $f, limit: 1000, nextToken: $n) { items { id } nextToken } }`, { f: filter, n })
    count += r.listAuditLogs.items.length
    n = r.listAuditLogs.nextToken
  } while (n && count === 0)
  return count
}

async function realGate(token, origin, ctx) {
  const id = 'G1-real-signup-gate'
  if (!matches(id) && !matches('gate')) return
  if (origin !== DEV_ORIGIN && !flag('gate')) {
    skipLine(id, 'light', '', 'gate logging ships with the deploy')
    return
  }
  const email = `zz-s4-unknown-${ctx.ts}@example.invalid`
  ctx.trackedEmails.add(email)
  const password = `Aa1!${randomBytes(18).toString('base64url')}`
  let message = null
  let created = false
  try {
    try {
      await driverCognito.send(new SignUpCommand({ ClientId: DRIVER_CLIENT, Username: email, Password: password, UserAttributes: [{ Name: 'email', Value: email }] }))
      created = true
    } catch (err) {
      message = String(err?.message ?? err)
    }
    if (created) throw new Error('SignUp for an unknown e-mail SUCCEEDED (the gate did not refuse)')
    if (!/No driver record matches this email/.test(message ?? '')) throw new Error(`unexpected refusal text: ${String(message).slice(0, 120)}`)
    await b0Poll(async () => {
      return (await auditRows(token, { entityId: { eq: email }, action: { eq: 'refused' } })) > 0
    }, 15_000)
    ctx.gate.email = email
    line('PASS', id, 'refused with the roster message; refusal row logged')
  } catch (err) {
    line('FAIL', id, String(err?.message ?? err).slice(0, 240))
  } finally {
    try {
      await driverCognito.send(new AdminGetUserCommand({ UserPoolId: DRIVER_POOL, Username: email }))
      await driverCognito.send(new AdminDeleteUserCommand({ UserPoolId: DRIVER_POOL, Username: email })).catch(() => {})
      line('FAIL', `${id} cleanup`, 'a driver-pool user was created for the unknown e-mail and has been deleted')
    } catch (err) {
      if (err?.name !== 'UserNotFoundException') line('FAIL', `${id} cleanup`, `could not confirm no user was created: ${err?.name ?? err}`)
    }
  }
}

async function b0Poll(fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await pause(1000)
  }
  throw new Error('timed out waiting for the refusal AuditLog row')
}

// ───────────────────────────── cleanup ─────────────────────────────
async function reread(token, getter, id) {
  try {
    const r = await gql(token, `query($id: ID!) { ${getter}(id: $id) { id } }`, { id })
    return !r[getter]
  } catch { return false }
}

async function removeSeed(token, label, model, id) {
  let gone = false
  try {
    await gql(token, `mutation($input: Delete${model}Input!) { delete${model}(input: $input) { id } }`, { input: { id } })
    gone = await reread(token, `get${model}`, id)
  } catch { gone = false }
  console.log(`cleanup: ${label} ${id} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
  if (!gone) process.exitCode = 1
}

async function scanAuditResidue(table, runStart, matchRow) {
  const hits = []
  let startKey
  do {
    const page = await doc.send(new ScanCommand({ TableName: table, FilterExpression: 'createdAt >= :s', ExpressionAttributeValues: { ':s': runStart }, ExclusiveStartKey: startKey }))
    for (const item of page.Items ?? []) if (matchRow(item)) hits.push(item)
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return hits
}

async function cleanAuditResidue(ctx, token) {
  const rowIsOurs = (r) => ctx.trackedIds.has(r.entityId) || ctx.trackedEmails.has(String(r.entityId).toLowerCase())
    || ctx.trackedEmails.has(String(r.user ?? '').toLowerCase()) || r.user === 'zz-s4'
  if (!ctx.suffix) {
    // No AWS access: list what the client can read, report, fail.
    const found = []
    try {
      let nextToken
      do {
        const r = await gql(token, `query($f: ModelAuditLogFilterInput, $n: String) { listAuditLogs(filter: $f, limit: 1000, nextToken: $n) { items { id entityId user } nextToken } }`, { f: { createdAt: { ge: ctx.runStart } }, n: nextToken })
        found.push(...r.listAuditLogs.items.filter(rowIsOurs))
        nextToken = r.listAuditLogs.nextToken
      } while (nextToken)
    } catch { /* reported below */ }
    console.log(`AuditLog residue: ${found.length} rows (ids ${found.map((f) => f.id).join(', ') || 'unknown: could not list'}) NOT deleted — no AWS credentials for the dev DynamoDB table`)
    process.exitCode = 1
    return
  }
  const table = devTable('AuditLog', ctx.suffix)
  const rows = await scanAuditResidue(table, ctx.runStart, rowIsOurs)
  for (const r of rows) await doc.send(new DeleteCommand({ TableName: table, Key: { id: r.id } }))
  const left = await scanAuditResidue(table, ctx.runStart, rowIsOurs)
  console.log(`cleanup: AuditLog ${rows.length} row(s) deleted; re-scan finds ${left.length}`)
  if (left.length) { console.log(`AuditLog residue: ${left.length} rows (ids ${left.map((l) => l.id).join(', ')}) NOT deleted`); process.exitCode = 1 }
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyS4 refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyS4 refuses any staff pool other than the dev pool')
  if (DRIVER_POOL !== STACK.driverPoolId) throw new Error('devVerifyS4 refuses any driver pool other than the dev driver pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyS4 only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  if (!(await inventory())) { process.exitCode = 1; return }
  if (flag('inventory')) return

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const runStart = new Date().toISOString()
  const emails = { admin: `zz-s4-admin-${ts}@example.invalid`, comp: `zz-s4-comp-${ts}@example.invalid`, none: `zz-s4-none-${ts}@example.invalid` }
  const made = []
  const created = { documents: [], drivers: [], applications: [], entries: [], invoices: [], payables: [] }
  const trackedIds = new Set()
  const trackedEmails = new Set(Object.values(emails))
  const ctx = {
    ts, runStart, origin, trackedIds, trackedEmails, suffix: null, gate: { email: null },
    blockedA: `zz-s4-blocked-a-${ts}@example.invalid`, blockedB: `zz-s4-blocked-b-${ts}@example.invalid`,
    expectedHours: '3h 40m', payableAttached: false, truckId: null, integrationAttention: null, roleCount: 0, profileTotal: null,
  }
  trackedEmails.add(ctx.blockedA).add(ctx.blockedB)
  let adminToken
  let bucket = null
  let imageKey = null

  try {
    // AWS discovery first: without it the AuditLog residue cannot be removed, which the run reports as a failure.
    try { ctx.suffix = await discoverDevSuffix(); console.log(`dev table suffix discovered (${ctx.suffix === PROD_SUFFIX ? 'REFUSED' : 'ok'})`) } catch (err) { console.log(`dev DynamoDB unavailable: ${String(err?.message ?? err).slice(0, 160)}`) }

    const admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    adminToken = admin.token
    const comp = await mintIdentity(emails.comp, ['page-compliance']); made.push(emails.comp)
    const none = await mintIdentity(emails.none, []); made.push(emails.none)
    ctx.adminUsername = Object.entries(admin.storage).find(([k]) => k.endsWith('.LastAuthUser'))?.[1]; ctx.comp = comp; ctx.none = none; ctx.token = adminToken; ctx.adminEmail = emails.admin
    console.log('identity: temporary staff identities created (admin, page-compliance, group-less)')
    const track = (id) => { trackedIds.add(id); return id }

    // ── seeds ──
    const today = chicagoToday()
    const types = await driverDocTypes()
    const driverEmail = `zz-s4-driver-${ts}@example.invalid`
    const applicantEmail = `zz-s4-applicant-${ts}@example.invalid`
    trackedEmails.add(driverEmail).add(applicantEmail)
    const mkDriver = async (name, email, extra) => {
      const id = track(await mutate(adminToken, 'createDriver', 'CreateDriverInput', { name, phone: '+15555550100', active: true, email, fleetGroup: 'LOCAL', ...extra }))
      created.drivers.push(id); return id
    }
    const driverId = await mkDriver('ZZ S4 Driver', driverEmail, { timeClock: true })
    const applicantId = await mkDriver('ZZ S4 Applicant', applicantEmail, {})
    const mkDoc = async (type, status, extra = {}) => {
      const id = track(await mutate(adminToken, 'createComplianceDocument', 'CreateComplianceDocumentInput', { entityType: 'DRIVER', entityId: driverId, documentType: type.key, title: type.label, status, uploadedBy: 'INTERNAL', ...extra }))
      created.documents.push(id); return { id, label: type.label }
    }
    ctx.A = await mkDoc(types[0], 'PENDING_REVIEW')
    ctx.B = await mkDoc(types[1], 'PENDING_REVIEW')
    ctx.C = await mkDoc(types[2], 'VALID', { expirationDate: addDays(today, 5) })
    ctx.E = await mkDoc(types[3], 'PENDING_REVIEW')
    ctx.applicantId = applicantId
    ctx.applicationId = track(await mutate(adminToken, 'createDriverApplication', 'CreateDriverApplicationInput', { driverId: applicantId, legalName: 'ZZ S4 Applicant', status: 'SUBMITTED', signatureName: 'ZZ S4 Applicant', signedAt: new Date().toISOString() }))
    created.applications.push(ctx.applicationId)
    for (const entityId of [ctx.blockedA, ctx.blockedB]) {
      await mutate(adminToken, 'createAuditLog', 'CreateAuditLogInput', { entityType: 'DRIVER_SIGNUP', entityId, action: 'refused', user: 'zz-s4', changes: JSON.stringify({ reason: 'NO_DRIVER_RECORD', at: new Date().toISOString() }) })
    }
    for (const minutes of [125, 95]) {
      const id = track(await mutate(adminToken, 'createTimeClockEntry', 'CreateTimeClockEntryInput', { driverId, workDate: today, kind: 'WORK', minutes, source: 'STAFF', note: 'zz-s4' }))
      created.entries.push(id)
    }
    const trucks = (await gql(adminToken, 'query { listEquipment(limit: 1000) { items { id type fleetGroup active } } }', {})).listEquipment.items
    ctx.truckId = trucks.find((t) => t.type === 'truck' && t.fleetGroup === 'LOCAL')?.id ?? null
    if (ctx.truckId) {
      const mkInvoice = async (n, amount, extra) => {
        const id = track(await mutate(adminToken, 'createMaintenanceInvoice', 'CreateMaintenanceInvoiceInput', { equipmentId: ctx.truckId, date: today, vendor: 'ZZ S4 Vendor', description: `zz-s4 receipt ${n}`, amount, invoiceNumber: `ZZ-S4-${n}-${ts}`, source: 'MANUAL', status: 'POSTED', ...extra }))
        created.invoices.push(id); return id
      }
      const inv1 = await mkInvoice(1, 12345, {})
      await mkInvoice(2, 6789, { paymentDate: today, paymentMethod: 'CHECK' })
      // optional image: payable via the app's own action, attachment + object written straight to the dev stack
      try {
        if (!ctx.suffix) throw new Error('no dev DynamoDB access')
        bucket = await discoverDevBucket()
        const raw = await gql(adminToken, `mutation($action: String!, $maintenanceInvoiceId: ID, $input: AWSJSON) { manageVendorPayable(action: $action, maintenanceInvoiceId: $maintenanceInvoiceId, input: $input) }`, { action: 'SEND_MAINTENANCE', maintenanceInvoiceId: inv1, input: '{}' })
        const parsed = typeof raw.manageVendorPayable === 'string' ? JSON.parse(raw.manageVendorPayable) : raw.manageVendorPayable
        const payableId = track(parsed.item.id)
        created.payables.push(payableId)
        imageKey = `intake-pdfs/vendor-ap/zz-s4-${ts}.png`
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: imageKey, Body: png, ContentType: 'image/png' }))
        await doc.send(new UpdateCommand({ TableName: devTable('VendorPayable', ctx.suffix), Key: { id: payableId }, UpdateExpression: 'SET attachments = :a', ExpressionAttributeValues: { ':a': [{ key: imageKey, name: 'zz-s4.png' }] } }))
        ctx.payableAttached = true
      } catch (err) {
        console.log(`image branch skipped: ${String(err?.message ?? err).slice(0, 160)}`)
        if (matches('S04') || !only) skipLine('S04-receipt-image', 'light', '', 'no dev-bucket write')
      }
    }
    // reference data for the cross-checks
    try { ctx.profileTotal = (await gql(adminToken, 'query { listUserProfiles(limit: 1000) { items { id } } }', {})).listUserProfiles.items.length } catch { ctx.profileTotal = null }
    ctx.roleCount = (/export const ROLES[^=]*=\s*\[([^\]]*)\]/.exec(await (await import('node:fs/promises')).readFile('src/lib/roles.ts', 'utf8'))?.[1].match(/'[A-Z_]+'/g) ?? []).length
    try {
      const rows = (await gql(adminToken, 'query { listIntegrations(limit: 1000) { items { provider kind status health healthReason } } }', {})).listIntegrations.items
      ctx.integrationAttention = rows.filter((r) => r.kind === 'PROVIDER' && r.status !== 'DISCONNECTED' && (r.health === 'INVALID_CREDENTIALS'
        || (r.health === 'UNABLE_TO_VERIFY' && r.healthReason !== 'NEUTERED_ON_DEV' && r.healthReason !== 'NOT_APPLICABLE'))).length
    } catch { ctx.integrationAttention = null }
    console.log('seeds: drivers, documents, application, sign-up refusals, hours, receipts created')

    await realGate(adminToken, origin, ctx)

    const b = await launchBrowser({ origin, storage: admin.storage, profilePrefix: 'bcat-s4-', purpose: 'S4 verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
    try {
      await b.navigate('/dashboard')
      await waitLoaded(b).catch(() => {})
      // the deployed site restores the session asynchronously; waitLoaded can return before the shell mounts
      await b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell sidebar mounted', 45_000).catch(() => {})
      const sidebarOk = await b.evaluate(`(() => { const e = document.querySelector('.tms-sidebar'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`)
      if (!sidebarOk) throw new Error(`.tms-sidebar not visible on /tms/dashboard: ${await b.evaluate(`JSON.stringify([location.href, document.body.innerText.slice(0, 120)])`)}`)
      const refs = {}
      for (const theme of ['light', 'dark']) { await setTheme(b, theme); refs[theme] = await b.evaluate(SHELL_FACTS) }
      await setTheme(b, 'light')

      await redirectStep(b)
      for (const theme of flag('no-dark') ? ['light'] : ['light', 'dark']) {
        await b.navigate('/dashboard'); await waitLoaded(b).catch(() => {})
        await setTheme(b, theme).catch(() => {})
        const ref = refs[theme]
        for (const route of S4_ROUTES) await auditRoute(b, route, theme, ref)
        await complianceFlow(b, ctx, theme)
        await usersFlow(b, ctx, theme)
        await financialFlow(b, theme)
        await expensesFlow(b, ctx, theme)
        await healthFlow(b, ctx, theme)
        await bellFlow(b, ctx, theme)
      }
      await b.navigate('/dashboard'); await waitLoaded(b).catch(() => {})
      await setTheme(b, 'light').catch(() => {})
      await phonePass(b, ctx)
    } finally { await b.close() }

    for (const theme of flag('no-dark') ? ['light'] : ['light', 'dark']) await permissionFlow(origin, ctx, theme)
  } finally {
    // cleanup, reverse order; each removal is re-read
    if (adminToken) {
      for (const id of created.payables) await removeSeed(adminToken, 'VendorPayable', 'VendorPayable', id)
      for (const id of created.invoices) await removeSeed(adminToken, 'MaintenanceInvoice', 'MaintenanceInvoice', id)
      for (const id of created.entries) await removeSeed(adminToken, 'TimeClockEntry', 'TimeClockEntry', id)
      for (const id of created.applications) await removeSeed(adminToken, 'DriverApplication', 'DriverApplication', id)
      for (const id of created.documents) await removeSeed(adminToken, 'ComplianceDocument', 'ComplianceDocument', id)
      for (const id of created.drivers) await removeSeed(adminToken, 'Driver', 'Driver', id)
    }
    if (bucket && imageKey) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: imageKey })).catch(() => {})
      const gone = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: imageKey })).then(() => false, () => true)
      console.log(`cleanup: S3 object zz-s4-…png ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
    if (adminToken) await cleanAuditResidue(ctx, adminToken).catch((err) => { console.log(`AuditLog residue: unknown (${String(err?.message ?? err).slice(0, 120)}) NOT deleted`); process.exitCode = 1 })
    for (const email of [emails.none, emails.comp, emails.admin].filter((e) => made.includes(e))) {
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
  main().catch((err) => { console.error(`devVerifyS4 failed: ${err?.message ?? err}`); process.exit(1) })
}
