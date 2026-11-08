#!/usr/bin/env node
/**
 * S3 visual verification against the DEV site (or `npm run dev` on localhost).
 *
 * Proves that no page outside /tms/* renders a legacy token, unstyled kit class, console error or
 * failed request, in light and dark; that legacy routes sit in the same shell as /tms; that the
 * public pages and the driver PWA (logged-out and, with a temp driver, authenticated) render.
 *
 *   node scripts/devVerifyS3.mjs [--only=<substring>] [--no-dark]
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyS3.mjs
 *
 * Dev only: refuses any AppSync endpoint but the dev one and any Cognito pool but the dev staff /
 * driver pools. Temp identities are zz-s3-*@example.invalid and are deleted (and re-read) in `finally`.
 * Passwords and tokens are never printed. No state is mutated except the temp users and Driver rows.
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql } from './lib/devIdentity.mjs'
import { auditInPage, auditFailures, publicAuditInPage } from './devVerifyS2.mjs'
import { createWalk, extraAuditInPage, SHELL_FACTS, TOKEN_PROBE, shellFailures } from './lib/uiWalk.mjs'
import { S4_PATTERNS, S4_REDIRECTS } from './lib/s4Routes.mjs'

const DEV_APPSYNC = APPSYNC_URL_RE
const DRIVER_POOL = STACK.driverPoolId
const DRIVER_CLIENT = STACK.driverClientId
const SHOTS = resolve('Docs/tms-build/screenshots/S3')

/** Console / network problems that are tolerated. Each entry: { pattern: RegExp, reason }. */
const ALLOW_PROBLEMS = [
  // `vite` dev server only: the PWA manifest is generated at build time, so localhost serves index.html for it.
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  // The dev Google Maps key is neutered, so Maps logs its own Map ID error; Google-owned, not an app defect.
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
]

/** Same allow-list as S2: tms-* classes that are hooks only. */
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name']

// ───────────────────────────── route tables ─────────────────────────────
const normalise = (p) => p.replace(/:\w+/g, ':p').replace(/\/+$/, '')

/** Rendered staff routes (ADMIN, shell). wideOk: fill-mode / wide pages (own scroller). */
export const ROUTES = [
  { nn: 'L01', slug: 'dashboard', path: '/dashboard', pattern: '/dashboard', phone: true },
  { nn: 'L02', slug: 'calendar', path: '/calendar', pattern: '/calendar', wideOk: true, fill: true },
  { nn: 'L03', slug: 'dispatch', path: '/dispatch', pattern: '/dispatch', wideOk: true, fill: true, phone: true },
  { nn: 'L04', slug: 'appts', path: '/appts', pattern: '/appts', wideOk: true },
  { nn: 'L05', slug: 'driver-info', path: '/driver-info', pattern: '/driver-info' },
  { nn: 'L06', slug: 'fleet-dashboard', path: '/fleet-dashboard', pattern: '/fleet-dashboard' },
  { nn: 'L07', slug: 'trucks', path: '/trucks', pattern: '/trucks', wideOk: true, phone: true },
  { nn: 'L08', slug: 'truck-docs', path: '/truck-docs', pattern: '/truck-docs' },
  { nn: 'L09', slug: 'maintenance', path: '/maintenance', pattern: '/maintenance' },
  { nn: 'L10', slug: 'fuel', path: '/fuel', pattern: '/fuel' },
  { nn: 'L11', slug: 'insurance', path: '/insurance', pattern: '/insurance' },
  { nn: 'L12', slug: 'hours', path: '/hours', pattern: '/hours' },
  { nn: 'L13', slug: 'schedule', path: '/schedule', pattern: '/schedule' },
  { nn: 'L14', slug: 'time-off', path: '/time-off', pattern: '/time-off' },
  { nn: 'L15', slug: 'tasks', path: '/tasks', pattern: '/tasks' },
  { nn: 'L16', slug: 'intake', path: '/intake', pattern: '/intake' },
  { nn: 'L17', slug: 'vehicle-quote', path: '/vehicle-quote', pattern: '/vehicle-quote' },
  { nn: 'L18', slug: 'vehicle-confirmation', path: '/vehicle-confirmation', pattern: '/vehicle-confirmation' },
  { nn: 'L19', slug: 'reddit-queue', path: '/reddit-queue', pattern: '/reddit-queue' },
  { nn: 'L20', slug: 'pricing-margin', path: '/pricing-margin', pattern: '/pricing-margin' },
  { nn: 'L21', slug: 'finances', path: '/finances', pattern: '/finances' },
  { nn: 'L22', slug: 'finances-review', path: '/finances/review', pattern: '/finances/review' },
  { nn: 'L23', slug: 'cash-checkin', path: '/finance/cash-checkin', pattern: '/finance/cash-checkin' },
  { nn: 'L24', slug: 'invoices', path: '/invoices', pattern: '/invoices' },
  { nn: 'L25', slug: 'driver-pay', path: '/driver-pay', pattern: '/driver-pay', phone: true },
  { nn: 'L26', slug: 'driver-pay-box-trucks', path: '/driver-pay-box-trucks', pattern: '/driver-pay-box-trucks' },
  { nn: 'L27', slug: 'owner-operator-pay', path: '/owner-operator-pay', pattern: '/owner-operator-pay' },
  { nn: 'L28', slug: 'ivan-driver-app', path: '/ivan-driver-app', pattern: '/ivan-driver-app' },
  { nn: 'L29', slug: 'driver-view', path: '/driver-view/{driver}', pattern: '/driver-view/:driverId' },
  { nn: 'L30', slug: 'disputes', path: '/disputes', pattern: '/disputes' },
  { nn: 'L31', slug: 'files', path: '/files', pattern: '/files', phone: true },
  { nn: 'L32', slug: 'pods', path: '/pods', pattern: '/pods' },
]

/** Redirect routes: [App.tsx pattern, concrete path, expected landing pathname]. */
export const REDIRECTS = [
  ['/loads', '/loads', '/tms/shipments'],
  ['/shipments', '/shipments', '/tms/shipments'],
  ['/shipments/:id', '/shipments/zz-x', '/tms/shipments/zz-x'],
  ['/check-calls', '/check-calls', '/tms/tracking'],
  ['/documents', '/documents', '/tms/tracking'],
  ['/drivers', '/drivers', '/files'],
  ['/factoring', '/factoring', '/tms/factors'],
  ['/ar', '/ar', '/tms/invoicing'],
  ['/ar/invoices/:id', '/ar/invoices/zz-x', '/tms/invoicing/invoices/zz-x'],
  ['/ap', '/ap', '/tms/invoicing/payable'],
  ['/ap/bills/:id', '/ap/bills/zz-x', '/tms/invoicing/payable/bills/zz-x'],
  ['/vendor-ap', '/vendor-ap', '/tms/vendors'],
  ['/customers', '/customers', '/tms/customers'],
  ['/locations', '/locations', '/tms/locations'],
  ['/carriers', '/carriers', '/tms/carriers'],
  ['/carriers/:id', '/carriers/zz-x', '/tms/carriers/zz-x'],
  ['/settings', '/settings', '/tms/brokerage'],
  ['/settings/integrations', '/settings/integrations', '/tms/brokerage/integrations'],
  ['/settings/integrations/:provider', '/settings/integrations/zz-x', '/tms/brokerage/integrations/zz-x'],
  ['/audit-log', '/audit-log', '/tms/brokerage/audit'],
  ['/users', '/users', '/tms/brokerage/users'],
  ['/compliance/onboarding', '/compliance/onboarding', '/files'],
  ['/compliance/driver/:driverId', '/compliance/driver/zz-x', '/files'],
  ['/compliance/truck/:truckId', '/compliance/truck/zz-x', '/files'],
  ['/quotes', '/quotes', '/tms/rates'],
  ['/quotes/new', '/quotes/new', '/tms/rates/new'],
  ['/quotes/:id', '/quotes/zz-x', '/tms/rates/zz-x'],
  ['/rates', '/rates', '/tms/rates/lanes'],
  ['/commissions', '/commissions', '/tms/brokerage/commissions'],
  ['/reports', '/reports', '/tms/brokerage/reports'],
  ['/grid', '/grid', '/tms/shipments'],
  ['/audit', '/audit', '/tms/brokerage/audit'],
]

/** Public pages (clean browser, no storage): [pattern, slug, path|function(data)]. */
const PUBLIC = [
  { nn: 'P1', slug: 'track-code', pattern: '/track/:code' },
  { nn: 'P2', slug: 'onboard', pattern: '/onboard/:token', path: '/onboard/zz-none' },
  { nn: 'P3', slug: 'amazon-disputes', pattern: '/amazon-disputes', path: '/amazon-disputes' },
  { nn: 'P4', slug: 'rate-con-inactive', pattern: '/sign/rate-con/:token', path: '/sign/rate-con/zz-none' },
  { nn: 'P5', slug: 'quote-inactive', pattern: '/quote/:token', path: '/quote/zz-none' },
  { nn: 'P6', slug: 'track-customer-inactive', pattern: '/track/s/:token', path: '/track/s/zz-none' },
  { nn: 'P7', slug: 'track-carrier-inactive', pattern: '/track/l/:token', path: '/track/l/zz-none' },
  { nn: 'P8', slug: 'track-upload-inactive', pattern: '/track/u/:token', path: '/track/u/zz-none' },
]

/** Routes that need no UI of their own: index/landing + driver sub-tree entry + staff catch-all. */
const NO_UI = ['/*', '/driver/*', '/tms']
/** The driver sub-routes are covered by DRIVER below; the `/driver/*` splat is the entry. */
const DRIVER_PATTERNS = ['/driver/login', '/driver/signup', '/driver/scan', '/driver/loads', '/driver/settlement', '/driver/paperwork', '/driver/timeclock', '/driver/account']

/** Routes/states that may legitimately be SKIPPED. */
const SKIP_ALLOWED = {}

// ───────────────────────────── completeness gate ─────────────────────────────
export async function requiredLegacyPatterns(root = process.cwd()) {
  const app = await readFile(join(root, 'src/App.tsx'), 'utf8')
  const tmsStart = app.indexOf('<Route path="/tms"')
  if (tmsStart < 0) throw new Error('src/App.tsx has no <Route path="/tms"> block')
  const tmsEnd = app.indexOf('</Route>', tmsStart)
  const body = app.slice(0, tmsStart) + app.slice(tmsEnd)
  const found = new Set()
  for (const m of body.matchAll(/<Route\s+(?:index\s|[^>]*?path="([^"]+)")/g)) {
    if (m[1]) found.add(normalise(m[1]))
  }
  // multi-line `<Route\n path="/driver/*"`
  for (const m of body.matchAll(/<Route\s*\n\s*path="([^"]+)"/g)) found.add(normalise(m[1]))
  return [...found].sort()
}

export function coveredPatterns() {
  return new Set([
    ...ROUTES.map((r) => normalise(r.pattern)),
    ...REDIRECTS.map((r) => normalise(r[0])),
    // S4 pages and the one S4 redirect row (rendered/asserted by devVerifyS4.mjs)
    ...S4_PATTERNS.map(normalise),
    ...S4_REDIRECTS.map((r) => normalise(r[0])),
    ...PUBLIC.map((p) => normalise(p.pattern)),
    ...DRIVER_PATTERNS.map(normalise),
    ...NO_UI.map(normalise),
  ])
}

// ───────────────────────────── runner state ─────────────────────────────
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)
const matches = (id) => !only || id.includes(only)


const { line, report, written, skipLine, allowedProblem, hookJson, problemList, audit, waitLoaded, waitBody, setTheme, shot, conclude } = createWalk({
  shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: SKIP_ALLOWED, only,
})


// ───────────────────────────── staff routes ─────────────────────────────
async function runRoute(b, route, data, theme, ref) {
  const id = `${route.nn}-${route.slug}`
  if (!matches(id)) return
  let url = route.path
  const m = /\{(\w+)\}/.exec(url)
  if (m) {
    if (!data[m[1]]) { skipLine(id, theme, `no ${m[1]} discovered`, route.slug === 'driver-view' ? 'temp driver could not be created' : undefined); return }
    url = url.replace(m[0], data[m[1]])
  }
  await b.navigate(url)
  const failures = []
  try { await waitLoaded(b) } catch (e) { failures.push(e.message) }
  b.mark()
  await pause(500)
  failures.push(...problemList(b).slice(0, 3))
  failures.push(...await audit(b, theme, { wideOk: route.wideOk }))
  // shell parity + layout + tokens
  const f = await b.evaluate(SHELL_FACTS)
  const t = await b.evaluate(TOKEN_PROBE)
  failures.push(...shellFailures(f, t, ref))
  await conclude(b, id, theme, route.nn, route.slug, failures)
}

async function redirects(b) {
  for (const [pattern, path, expected] of REDIRECTS) {
    const id = `R ${path}`
    if (!matches('redirect') && !matches(id)) continue
    await b.navigate(path)
    let landed = ''
    try {
      await b.poll(async () => { landed = await b.evaluate('location.pathname'); return landed === expected }, `landing on ${expected}`, 12_000)
      line('PASS', id, `→ ${expected}`)
    } catch {
      line('FAIL', id, `landed on ${landed}, expected ${expected}`)
    }
    void pattern
  }
}

async function phonePass(b, data) {
  // headless Chrome flips the page to visibilityState=hidden after synthetic key input, which freezes CSS transitions
  await b.command('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  const front = () => b.command('Page.bringToFront').catch(() => {})
  const routes = ROUTES.filter((r) => r.phone)
  await b.setViewport(390, 844, 2)
  for (const theme of ['light', 'dark']) {
    for (const route of routes) {
      const id = `PH-${route.nn}-${route.slug}`
      if (!matches(id) && !matches('phone')) continue
      await b.navigate(route.path)
      await front()
      const failures = []
      await waitLoaded(b).catch((e) => failures.push(e.message))
      await setTheme(b, theme).catch((e) => failures.push(`theme: ${e.message}`))
      b.mark()
      await pause(500)
      failures.push(...problemList(b).slice(0, 3))
      const f = await b.evaluate(SHELL_FACTS)
      if (f.docW > f.winW + 2) failures.push(`page overflows horizontally on phone (${f.docW} > ${f.winW})`)
      const hamburger = await b.evaluate(`(() => { const e = document.querySelector('[aria-label="Open menu"]'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`)
      if (!hamburger) { failures.push('hamburger [aria-label="Open menu"] not visible') } else {
        const off = await b.evaluate(`(() => { const r = document.querySelector('.tms-sidebar').getBoundingClientRect(); return r.right <= 1 || r.left >= window.innerWidth })()`)
        if (!off) failures.push('sidebar is on screen with the drawer closed')
        await shot(b, route.nn, `${route.slug}-phone`, theme, false).catch(() => {})
        await front()
        await pause(2500) // let route/session effects settle: a late route change closes the drawer
        await b.click({ selector: '[aria-label="Open menu"]' }).catch((e) => failures.push(e.message))
        await pause(1200)
        const open = await b.evaluate(`(() => { const r = document.querySelector('.tms-sidebar').getBoundingClientRect(); return !!document.querySelector('.tms-shell.tms-nav-open') && r.left >= -1 && r.right > 100 && r.left < window.innerWidth })()`)
        if (!open) failures.push(`drawer did not open: ${await b.evaluate(`JSON.stringify([location.pathname, innerWidth, document.querySelector('.tms-shell')?.className, document.querySelector('.tms-sidebar')?.getBoundingClientRect().left, document.querySelectorAll('[aria-label="Open menu"]').length])`)}`)
        else {
          await shot(b, route.nn, `${route.slug}-phone-drawer`, theme, false).catch(() => {})
          await b.press('Escape')
          await front()
          await pause(1200)
          const closed = await b.evaluate(`(() => { const r = document.querySelector('.tms-sidebar').getBoundingClientRect(); return r.right <= 1 || r.left >= window.innerWidth })()`)
          if (!closed) failures.push('Escape did not close the drawer')
          if (route.nn === 'L01') {
            // nav link closes the drawer and changes the URL
            await front()
            await b.click({ selector: '[aria-label="Open menu"]' }).catch(() => {})
            await pause(800)
            const before = await b.evaluate('location.pathname')
            const clicked = await b.evaluate(`(() => { const a = [...document.querySelectorAll('.tms-sidebar a[href]')].find((x) => x.getAttribute('href') !== location.pathname && x.getAttribute('href').startsWith('/')); if (!a) return false; a.click(); return true })()`)
            if (!clicked) failures.push('no nav link to click in the drawer')
            else {
              await front()
              await pause(1200)
              const after = await b.evaluate('location.pathname')
              const closed2 = await b.evaluate(`(() => { const r = document.querySelector('.tms-sidebar').getBoundingClientRect(); return r.right <= 1 || r.left >= window.innerWidth })()`)
              if (after === before) failures.push('nav link did not change the URL')
              if (!closed2) failures.push('nav link did not close the drawer')
            }
          }
        }
      }
      failures.push(...await audit(b, theme, { wideOk: true }))
      await conclude(b, id, theme, `${route.nn}p`, route.slug, failures, false)
    }
  }
  await setTheme(b, 'light').catch(() => {})
  await b.setViewport(1600, 1000, 1)
  void data
}

async function themeToggleReload(b) {
  const id = 'SH3-theme-reload'
  if (!matches(id) && !matches('SH3')) return
  await b.navigate('/trucks')
  await waitLoaded(b).catch(() => {})
  await setTheme(b, 'light').catch(() => {})
  await b.addInitScript('window.__s3Theme=null;new MutationObserver(function(_,o){var v=document.documentElement.getAttribute("data-tms-theme");if(v&&!window.__s3Theme){window.__s3Theme={first:v,state:document.readyState};o.disconnect()}}).observe(document,{attributes:true,subtree:true,attributeFilter:["data-tms-theme"]});')
  await setTheme(b, 'dark')
  await b.reload()
  await waitLoaded(b).catch(() => {})
  const first = await b.evaluate('window.__s3Theme')
  const now = await b.evaluate(`document.documentElement.getAttribute('data-tms-theme')`)
  await setTheme(b, 'light').catch(() => {})
  if (first?.first === 'dark' && first.state === 'loading' && now === 'dark') line('PASS', id, `attribute present at first script execution (document ${first.state})`)
  else line('FAIL', id, `first=${JSON.stringify(first)} now=${now}`)
}

// ───────────────────────────── no-shell pages ─────────────────────────────
async function publicPage(b, p, path, tag) {
  const id = `${p.nn}-${p.slug}`
  await b.navigate(path)
  await b.poll(() => b.evaluate(`!!document.querySelector('.tms-public')`), '.tms-public', 20_000).catch(() => {})
  await pause(1500)
  b.mark()
  await pause(300)
  const res = await b.evaluate(`((auditInPage) => (${publicAuditInPage})(${JSON.stringify({ wideOk: true, hookClasses: HOOK_CLASSES })}, auditInPage))(${auditInPage})`)
  const extra = await b.evaluate(`(${extraAuditInPage})(${hookJson})`)
  const fails = []
  if (!res.publicRoot) fails.push('root .tms-public missing')
  if (res.signIn) fails.push('redirected to sign-in')
  if (res.rootBg !== res.tokenBg) fails.push(`.tms-public background ${res.rootBg} != --tms-bg ${res.tokenBg}`)
  fails.push(...auditFailures(res).filter((f) => !f.startsWith('layout')))
  fails.push(...extra.map((x) => `legacy token: ${x}`))
  const problems = b.problems()
  // inactive-link pages legitimately answer 4xx from the public Lambda
  fails.push(...[
    ...problems.exceptions, ...problems.consoleErrors.map((x) => `console: ${x}`),
    ...problems.failedRequests.map((x) => `request failed: ${x}`),
    ...(/zz-none/.test(path) ? [] : problems.httpErrors.map((x) => `HTTP ${x}`)),
  ].filter((x) => !allowedProblem(x)))
  const horiz = await b.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth + 2')
  if (horiz) fails.push('page overflows horizontally')
  await conclude(b, id, tag, p.nn, p.slug, fails)
}

async function publicPages(origin, data) {
  const b = await launchBrowser({ origin, profilePrefix: 'bcat-s3-pub-', purpose: 'S3 verification' })
  try {
    for (const p of PUBLIC) {
      const id = `${p.nn}-${p.slug}`
      if (!matches(id)) continue
      const path = p.path ?? (data.trackCode ? `/track/${data.trackCode}` : '/track/zz-none')
      for (const mobile of [false, true]) {
        if (mobile) await b.setViewport(390, 844, 2); else await b.setViewport(1600, 1000, 1)
        await publicPage(b, p, path, mobile ? 'mobile' : 'light')
      }
    }
  } finally { await b.close() }
}

/** Sign-in surface (logged out) and Cognito-less pages with the staff shell tokens. */
async function loginPages(origin) {
  for (const [nn, slug, theme, mobile] of [['A1', 'login', 'light', false], ['A1', 'login', 'light', true], ['A2', 'login-dark', 'dark', false], ['A2', 'login-dark', 'dark', true]]) {
    const id = `${nn}-${slug}`
    if (!matches(id)) continue
    const b = await launchBrowser({
      origin, profilePrefix: 'bcat-s3-login-', purpose: 'S3 verification',
      storage: theme === 'dark' ? { 'tms-theme': 'dark' } : undefined,
      viewport: mobile ? { width: 390, height: 844, deviceScaleFactor: 2 } : { width: 1600, height: 1000, deviceScaleFactor: 1 },
    })
    try {
      await b.navigate('/dashboard')
      await b.poll(() => b.evaluate(`!!document.querySelector('input[type="password"], input[type="email"], input[name="username"]')`), 'login form', 20_000).catch(() => {})
      await pause(1200)
      b.mark(); await pause(300)
      const fails = [...problemList(b).slice(0, 3)]
      const root = await b.evaluate(`(() => ({ portal: !!document.querySelector('.tms-portal'), password: !!document.querySelector('input[type="password"]'), attr: document.documentElement.getAttribute('data-tms-theme') }))()`)
      if (!root.password) fails.push('sign-in form not rendered')
      if (!root.portal) fails.push('.tms-portal root missing on LoginPage')
      if (theme === 'dark' && root.attr !== 'dark') fails.push(`dark preference not honoured (data-tms-theme=${root.attr})`)
      fails.push(...await audit(b, theme, { wideOk: true, shell: false }))
      await conclude(b, id, `${theme}${mobile ? '-mobile' : ''}`, nn, `${slug}${mobile ? '-mobile' : ''}`, fails)
    } finally { await b.close() }
  }
}

// ───────────────────────────── driver PWA ─────────────────────────────
const driverCognito = new CognitoIdentityProviderClient({ region: 'us-east-1' })

async function mintDriverTokens(email) {
  const password = `Aa1!${randomBytes(18).toString('base64url')}`
  await driverCognito.send(new AdminCreateUserCommand({
    UserPoolId: DRIVER_POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }))
  await driverCognito.send(new AdminSetUserPasswordCommand({ UserPoolId: DRIVER_POOL, Username: email, Password: password, Permanent: true }))
  const res = await driverCognito.send(new InitiateAuthCommand({
    ClientId: DRIVER_CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }))
  const r = res.AuthenticationResult
  if (!r?.IdToken || !r.RefreshToken) throw new Error('driver sign-in returned no tokens')
  return JSON.stringify({ idToken: r.IdToken, accessToken: r.AccessToken, refreshToken: r.RefreshToken, expiresAt: Date.now() + (r.ExpiresIn ?? 3600) * 1000 })
}

async function deleteDriverUser(email) {
  await driverCognito.send(new AdminDeleteUserCommand({ UserPoolId: DRIVER_POOL, Username: email })).catch(() => {})
  try {
    await driverCognito.send(new AdminGetUserCommand({ UserPoolId: DRIVER_POOL, Username: email }))
    return false
  } catch (err) { return err?.name === 'UserNotFoundException' }
}

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2 }

async function driverPass(origin, d, { nn, slug, path, theme, tokens, viewport = PHONE, prep, extraChecks, profileError = false }) {
  const id = `${nn}-${slug}`
  if (!matches(id)) return
  const storage = { ...(tokens ? { 'bcat:driver:tokens': tokens } : {}), ...(theme === 'dark' ? { 'tms-theme': 'dark' } : {}) }
  const b = await launchBrowser({ origin, profilePrefix: 'bcat-s3-drv-', purpose: 'S3 verification', storage, viewport })
  try {
    await b.navigate(path)
    await waitBody(b)
    const fails = []
    if (prep) await prep(b, fails)
    if (profileError) await b.poll(() => b.evaluate(`/Driver not found|couldn.t load your profile|could not load your profile|unable to load/i.test(document.body.innerText)`), 'profile-error text', 25_000).catch(() => {})
    b.mark(); await pause(500)
    fails.push(...problemList(b).slice(0, 3))
    const url = await b.evaluate('location.pathname')
    if (tokens && /\/driver\/login/.test(url)) fails.push(`redirected to /driver/login (session not accepted)`)
    fails.push(...await audit(b, theme, { wideOk: true, shell: false }))
    const horiz = await b.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth + 2')
    if (horiz) fails.push('page overflows horizontally')
    const body = await b.evaluate('document.body.innerText.slice(0, 400)')
    const errShown = /Driver not found|couldn.t load your profile|could not load your profile|unable to load/i.test(body)
    if (tokens && !profileError && errShown) fails.push(`profile error shown: ${body.replace(/\s+/g, ' ').slice(0, 100)}`)
    if (tokens && profileError && !errShown) fails.push(`profile-error screen not shown: ${body.replace(/\s+/g, ' ').slice(0, 100)}`)
    if (extraChecks) fails.push(...await extraChecks(b))
    await conclude(b, id, `${theme}${viewport.width < 600 ? '-phone' : ''}`, nn, slug, fails)
  } catch (e) {
    line('FAIL', `${id} ${theme}`, `harness: ${e.message}`)
  } finally { await b.close() }
}

async function driverPasses(origin, d, identities) {
  const themes = flag('no-dark') ? ['light'] : ['light', 'dark']
  for (const theme of themes) {
    // logged-out screens: phone and desktop
    await driverPass(origin, d, { nn: 'D01', slug: 'driver-login', path: '/driver/login', theme })
    await driverPass(origin, d, { nn: 'D01', slug: 'driver-login-desktop', path: '/driver/login', theme, viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
    await driverPass(origin, d, {
      nn: 'D02', slug: 'driver-login-forgot', path: '/driver/login', theme,
      prep: async (b, fails) => { await b.click({ pattern: '^forgot', selector: 'button, a' }).catch(() => fails.push('forgot-password trigger not found')); await pause(600) },
    })
    await driverPass(origin, d, { nn: 'D03', slug: 'driver-signup', path: '/driver/signup', theme })
    await driverPass(origin, d, { nn: 'D03', slug: 'driver-signup-desktop', path: '/driver/signup', theme, viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
  }
  if (!identities) {
    skipLine('D04-D13', 'light', 'no temp driver identity', 'authenticated driver screens need a temp driver; creation failed (see log)')
    return
  }
  const screens = [
    ['D04', 'profile-error', '/driver/settlement', identities.orphanTokens, true],
    ['D05', 'settlement', '/driver/settlement', identities.settleTokens],
    ['D06', 'paperwork', '/driver/paperwork', identities.paperTokens],
    ['D07', 'timeclock', '/driver/timeclock', identities.paperTokens],
    ['D08', 'loads', '/driver/loads', identities.settleTokens],
    ['D09', 'scan', '/driver/scan', identities.settleTokens],
    ['D10', 'account', '/driver/account', identities.settleTokens],
  ]
  for (const theme of themes) {
    for (const [nn, slug, path, tokens, orphan] of screens) {
      await driverPass(origin, d, { nn, slug: `driver-${slug}`, path, theme, tokens, profileError: !!orphan })
    }
    // D13: Hours tab visible for the paperwork driver, hidden for the settlement driver
    if (theme === 'light') {
      for (const [who, tokens, expect] of [['paperwork', identities.paperTokens, true], ['settlement', identities.settleTokens, false]]) {
        if (!matches('D13')) continue
        const b = await launchBrowser({ origin, profilePrefix: 'bcat-s3-drv-', purpose: 'S3 verification', storage: { 'bcat:driver:tokens': tokens }, viewport: PHONE })
        try {
          await b.navigate(who === 'paperwork' ? '/driver/paperwork' : '/driver/settlement')
          await waitBody(b)
          // The Hours tab renders only once the driver profile has loaded (timeClock is false until then): wait for the nav, then poll for the expected state.
          const hoursProbe = `[...document.querySelectorAll('a, button')].some((e) => /^\\s*Hours\\s*$/i.test(e.textContent))`
          await b.poll(async () => b.evaluate(`!!document.querySelector('nav a[href="/driver/account"]')`), 'driver tab bar', 20_000).catch(() => {})
          let has = await b.evaluate(hoursProbe)
          for (let i = 0; i < 20 && has !== expect; i += 1) { await pause(1000); has = await b.evaluate(hoursProbe) }
          if (has === expect) line('PASS', `D13-hours-tab-${who}`, expect ? 'visible' : 'hidden')
          else line('FAIL', `D13-hours-tab-${who}`, `Hours tab ${has ? 'visible' : 'hidden'}, expected ${expect ? 'visible' : 'hidden'}`)
        } finally { await b.close() }
      }
    }
  }
}

// ───────────────────────────── main ─────────────────────────────
async function equipmentCode(token) {
  try {
    const data = await gql(token, 'query { listEquipment(limit: 1000) { items { trackingCode } } }', {})
    return data.listEquipment.items.find((e) => e.trackingCode)?.trackingCode ?? null
  } catch { return null }
}

async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyS3 refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyS3 refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyS3 only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  // 1. completeness gate
  const required = await requiredLegacyPatterns()
  const covered = coveredPatterns()
  const missing = required.filter((p) => !covered.has(p))
  if (missing.length) {
    line('FAIL', 'route inventory', `no coverage for: ${missing.join(', ')}`)
    process.exitCode = 1
    return
  }
  line('PASS', 'route inventory', `${required.length} non-/tms patterns covered`)
  if (flag('inventory')) return

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const adminEmail = `zz-s3-admin-${ts}@example.invalid`
  const noAccessEmail = `zz-s3-noaccess-${ts}@example.invalid`
  const driverEmails = {
    settle: `zz-s3-driver-settle-${ts}@example.invalid`,
    paper: `zz-s3-driver-paper-${ts}@example.invalid`,
    orphan: `zz-s3-driver-orphan-${ts}@example.invalid`,
  }
  const createdDriverIds = []
  const createdPayIds = []
  const createdDriverUsers = []
  let staffMade = false
  let noAccessMade = false
  let adminToken

  try {
    const identity = await mintIdentity(adminEmail, ['ADMIN', 'page-tms'])
    staffMade = true
    adminToken = identity.token
    console.log(`identity: temporary admin ${adminEmail} created`)

    // driver identities (best effort; failure => allowed skip with reason)
    let identities = null
    let driverSkipReason = null
    const data = {}
    try {
      const mk = async (name, email, extra) => {
        const res = await gql(adminToken, `mutation($input: CreateDriverInput!) { createDriver(input: $input) { id } }`, {
          input: { name, phone: '+15555550100', active: true, email, ...extra },
        })
        createdDriverIds.push(res.createDriver.id)
        return res.createDriver.id
      }
      const settleId = await mk('ZZ S3 Settlement', driverEmails.settle, { fleetGroup: 'AMAZON', timeClock: false })
      await mk('ZZ S3 Paperwork', driverEmails.paper, { fleetGroup: 'LOCAL', ivanApp: true, timeClock: true })
      data.driver = settleId
      const ps = await gql(adminToken, `mutation($input: CreateDriverPaySettingInput!) { createDriverPaySetting(input: $input) { id } }`, {
        input: { driverId: settleId, payGroup: 'AMAZON', payPercent: 0.88, expensesBeforePercent: false, email: driverEmails.settle, active: true },
      })
      createdPayIds.push(ps.createDriverPaySetting.id)
      createdDriverUsers.push(driverEmails.settle)
      const settleTokens = await mintDriverTokens(driverEmails.settle)
      createdDriverUsers.push(driverEmails.paper)
      const paperTokens = await mintDriverTokens(driverEmails.paper)
      // The PreSignUp gate refuses a user with no Driver row, so the "profile error" user is a Driver that
      // is deactivated after sign-in: the API then answers "Driver not found" for a valid session.
      const orphanId = await mk('ZZ S3 Orphan', driverEmails.orphan, { fleetGroup: 'AMAZON' })
      const ops = await gql(adminToken, `mutation($input: CreateDriverPaySettingInput!) { createDriverPaySetting(input: $input) { id } }`, {
        input: { driverId: orphanId, payGroup: 'AMAZON', payPercent: 0.88, expensesBeforePercent: false, email: driverEmails.orphan, active: true },
      })
      createdPayIds.push(ops.createDriverPaySetting.id)
      createdDriverUsers.push(driverEmails.orphan)
      const orphanTokens = await mintDriverTokens(driverEmails.orphan)
      await gql(adminToken, `mutation($input: UpdateDriverInput!) { updateDriver(input: $input) { id } }`, { input: { id: orphanId, active: false } })
      identities = { settleTokens, paperTokens, orphanTokens }
      console.log('identity: temporary driver identities created')
    } catch (err) {
      driverSkipReason = String(err?.message ?? err).slice(0, 200)
      console.log(`driver identity unavailable: ${driverSkipReason}`)
    }

    data.trackCode = await equipmentCode(adminToken)

    const b = await launchBrowser({ origin, storage: identity.storage, profilePrefix: 'bcat-s3-', purpose: 'S3 verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
    try {
      // reference shell geometry on /tms/dashboard
      await b.navigate('/tms/dashboard')
      await waitLoaded(b).catch(() => {})
      const sidebarOk = await b.evaluate(`(() => { const e = document.querySelector('.tms-sidebar'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`)
      if (!sidebarOk) throw new Error('.tms-sidebar not visible on /tms/dashboard: the dev identity is not signed in (wrong origin/pool?)')
      const refs = {}
      for (const theme of ['light', 'dark']) {
        await setTheme(b, theme)
        refs[theme] = await b.evaluate(SHELL_FACTS)
      }
      await setTheme(b, 'light')

      await redirects(b)
      for (const theme of flag('no-dark') ? ['light'] : ['light', 'dark']) {
        await b.navigate('/tms/dashboard'); await waitLoaded(b).catch(() => {})
        await setTheme(b, theme).catch(() => {})
        for (const route of ROUTES) await runRoute(b, route, data, theme, refs[theme])
      }
      await b.navigate('/tms/dashboard'); await waitLoaded(b).catch(() => {})
      await setTheme(b, 'light').catch(() => {})
      await phonePass(b, data)
      await themeToggleReload(b)
    } finally { await b.close() }

    // A3 no-access identity
    if (matches('A3')) {
      try {
        const na = await mintIdentity(noAccessEmail, [])
        noAccessMade = true
        for (const theme of flag('no-dark') ? ['light'] : ['light', 'dark']) {
          const nb = await launchBrowser({ origin, storage: { ...na.storage, ...(theme === 'dark' ? { 'tms-theme': 'dark' } : {}) }, profilePrefix: 'bcat-s3-na-', purpose: 'S3 verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
          try {
            await nb.navigate('/dashboard')
            await nb.poll(() => nb.evaluate(`/no page access|no access|permission/i.test(document.body.innerText)`), 'NoAccess screen', 45_000).catch(() => {})
            await pause(1000)
            nb.mark(); await pause(300)
            const fails = [...problemList(nb).slice(0, 3)]
            const text = await nb.evaluate('document.body.innerText.slice(0, 200)')
            if (!/no page access|no access|permission/i.test(text)) fails.push(`NoAccess screen not shown: ${text.replace(/\s+/g, ' ').slice(0, 80)}`)
            fails.push(...await audit(nb, theme, { wideOk: true, shell: false }))
            await conclude(nb, 'A3-no-access', theme, 'A3', 'no-access', fails)
          } finally { await nb.close() }
        }
      } catch (err) {
        skipLine('A3-no-access', 'light', String(err?.message ?? err).slice(0, 120), 'could not mint a group-less staff identity')
      }
    }

    await loginPages(origin)
    await publicPages(origin, data)
    if (driverSkipReason) skipLine('D04-D13', 'light', driverSkipReason, `no driver-pool access / Driver create failed: ${driverSkipReason}`)
    await driverPasses(origin, data, identities)
  } finally {
    // cleanup: every identity and Driver row, each re-read to prove it is gone
    for (const email of createdDriverUsers) {
      const gone = await deleteDriverUser(email)
      console.log(`cleanup: driver-pool user ${email.replace(/-\d+@/, '-…@')} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
    for (const id of createdPayIds) {
      let gone = false
      try {
        await gql(adminToken, `mutation($input: DeleteDriverPaySettingInput!) { deleteDriverPaySetting(input: $input) { id } }`, { input: { id } })
        const back = await gql(adminToken, `query($id: ID!) { getDriverPaySetting(id: $id) { id } }`, { id })
        gone = !back.getDriverPaySetting
      } catch { gone = false }
      console.log(`cleanup: DriverPaySetting row ${id} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
    for (const id of createdDriverIds) {
      let gone = false
      try {
        await gql(adminToken, `mutation($input: DeleteDriverInput!) { deleteDriver(input: $input) { id } }`, { input: { id } })
        const back = await gql(adminToken, `query($id: ID!) { getDriver(id: $id) { id } }`, { id })
        gone = !back.getDriver
      } catch { gone = false }
      console.log(`cleanup: Driver row ${id} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
    for (const email of [noAccessEmail, adminEmail]) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary staff identity ${email.replace(/-\d+@/, '-…@')} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }

  // report
  const pass = report.filter((r) => r.status === 'PASS').length
  const fail = report.filter((r) => r.status === 'FAIL').length
  const skipped = report.filter((r) => r.status === 'SKIPPED')
  const unallowed = skipped.filter((r) => !/\(allowed:/.test(r.detail ?? ''))
  console.log(`\nsummary: ${JSON.stringify({ pass, fail, skipped: skipped.length, skippedNotAllowed: unallowed.length })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (fail > 0 || unallowed.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyS3 failed: ${err?.message ?? err}`); process.exit(1) })
}
