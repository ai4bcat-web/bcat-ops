#!/usr/bin/env node
/**
 * Step AA verification against the DEV site (or `npm run dev` on localhost): the reorganised sidebar and its route
 * homes, the old URLs, the three single-grant personas, the Load Review queue on dev data, the intake review gate,
 * the Wednesday payroll label and the pay-history guard.
 *
 *   node scripts/devVerifyAA.mjs [--inventory [--markdown]] [--pay-guard] [--only=<substring>] [--no-dark] [--base=<sha>]
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyAA.mjs
 *
 *   --inventory  no network, no browser: gate 1 (every route has one home), gate 2 static (every page home is a sidebar
 *                row, no orphan row), gate 3 static (old-URL registry), the S2/S3/S4/U registries, gate 7 static.
 *   --markdown   with --inventory: print the route-inventory block for BUILD_LOG / AA_ROUTE_INVENTORY.md and exit.
 *   --pay-guard  gate 8 only: pay history is byte-identical (git diff against --base / AA_BASE / HEAD).
 *   --only=      run only the steps whose id contains the substring (fixtures are still created).
 *   --no-dark    skip the dark-theme pass.
 *
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool, any origin outside
 * ALLOWED_ORIGINS, and any DynamoDB table that does not carry the discovered dev suffix. Every identity and record it
 * creates is named zz-aa-… / ZZ_AA_… / ZZ AA …, tracked, and removed in `finally`; shipments are voided (never
 * deleted), workflow runs dismissed, the rest deleted through the AWS SDK against the dev tables; residue is a failure.
 * The demo seed is restored with RESET_DEMO_DATA (dev-only flag on the Lambda). Passwords and tokens are never printed.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { createWalk, SHELL_FACTS, TOKEN_PROBE, shellFailures } from './lib/uiWalk.mjs'
import {
  AA_HOMES, AA_OLD_URLS, AA_SIDEBAR, AA_SIDEBAR_SECTIONS, AA_SIDEBAR_PARENTS, AA_ADMIN_ONLY_HREFS, AA_PERSONAS, AA_ROUTES,
  aaInventoryGaps, aaLifecycleTabs, aaMarkdown, matchesPattern,
} from './lib/aaRoutes.mjs'
import { requiredPatterns, missingFromRoutes } from './devVerifyS2.mjs'
import { requiredLegacyPatterns, coveredPatterns } from './devVerifyS3.mjs'
import { s4NavGaps } from './lib/s4Routes.mjs'
import { uNavGaps, uGoneGaps, SIDEBAR_BANNED_HREFS } from './lib/uRoutes.mjs'
import {
  uAuditInPage, listAllRows, getRow, asJson, deliver, deleteInboxPrefix, discoverDevSuffix, devTable, doc, scanIds, scanAudit,
  resolveIntakeSecret, tenderBody, INTAKE_SELECTION,
} from './devVerifyU.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const SHOTS = resolve('Docs/tms-build/screenshots/AA')
const BACKEND_ALLOWED = 'ships with the deploy'

const ALLOW_PROBLEMS = [
  { pattern: /Manifest: Line: 1, column: 1, Syntax error\. http:\/\/(127\.0\.0\.1|localhost):5173\/manifest\.webmanifest$/, reason: 'vite dev server has no built manifest' },
  { pattern: /The map is initialized without a valid Map ID/, reason: 'dev Maps key is neutered' },
  // The legacy /tasks page reads the external Group Command Center (VITE_COMMAND_CENTER_API_URL, localhost:4501 when unset); dev has no such service and Step AA did not touch the page.
  { pattern: /\[TasksPage\] listTasks failed|localhost:4501\//, reason: 'Command Center API is not part of the dev stack' },
]
const HOOK_CLASSES = ['tms-overdue', 'tms-due', 'tms-theme-toggle', 'tms-dash', 'tms-probe-field', 'tms-public-head', 'tms-public-brand-name', 'tms-drawer-md']
const SKIP_ALLOWED = {}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)
const baseArg = args.find((a) => a.startsWith('--base='))?.slice(7)

const walk = createWalk({ shots: SHOTS, allowProblems: ALLOW_PROBLEMS, hookClasses: HOOK_CLASSES, skipAllowed: SKIP_ALLOWED, only })
const { line, report, written, skipLine, problemList, audit, waitLoaded, waitBody, setTheme, conclude, matches } = walk

const read = (file) => readFile(join(process.cwd(), file), 'utf8')
const fail = (msg) => { throw new Error(msg) }
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)

// ───────────────────────────── static gates ─────────────────────────────
/** Gate 7, static: the source carries the whole review gate end to end. */
export async function intakeGateGaps() {
  const gaps = []
  const [intake, handler, api, lib, page] = await Promise.all([
    read('amplify/functions/tms-shipment-actions/intake.ts'),
    read('amplify/functions/tms-shipment-actions/handler.ts'),
    read('src/lib/apiClient.ts'),
    read('src/lib/intakeLoad.ts'),
    read('src/features/shipments/intake/IntakeReviewPage.tsx'),
  ])
  if (!/INTAKE_ACTIONS\s*=\s*\[[^\]]*'INTAKE_MARK_REVIEWED'/.test(intake)) gaps.push("intake.ts INTAKE_ACTIONS has no 'INTAKE_MARK_REVIEWED'")
  if (!/export async function intakeMarkReviewed/.test(intake)) gaps.push('intake.ts has no intakeMarkReviewed')
  if (!/Cannot mark reviewed/.test(intake)) gaps.push('intakeMarkReviewed does not refuse an incomplete load ("Cannot mark reviewed")')
  if (!/press Mark reviewed/.test(intake)) gaps.push('intakeMoveToActive does not refuse an unreviewed load with the "press Mark reviewed" reason')
  if (!/reviewedBy:\s*null,\s*reviewedAt:\s*null/.test(intake)) gaps.push('intakeSaveDraft does not clear the review on an edit')
  if ((handler.match(/INTAKE_MARK_REVIEWED/g) ?? []).length < 2) gaps.push("handler.ts needs 'INTAKE_MARK_REVIEWED' in the Action union and the intake case list")
  if (!/export async function markIntakeReviewed/.test(api)) gaps.push('apiClient.ts has no markIntakeReviewed')
  if (!/export function canMarkReviewed/.test(lib) || !/needsReview/.test(lib)) gaps.push('intakeLoad.ts has no canMarkReviewed / needsReview')
  if (!/Mark reviewed/.test(page)) gaps.push('IntakeReviewPage.tsx has no Mark reviewed control')
  return gaps
}

/** Gate 3, static: the old-URL registry matches the routes and covers every redirect and fixed-path page. */
export function oldUrlGaps() {
  const gaps = []
  const seen = new Set()
  for (const [url] of AA_OLD_URLS) {
    if (seen.has(url)) gaps.push(`${url}: listed twice`)
    seen.add(url)
    if (!AA_HOMES.some((h) => matchesPattern(url.split('?')[0], h.pattern))) gaps.push(`${url}: matches no AA_HOMES pattern`)
  }
  // Rows that legitimately have no pre-AA URL of their own: new routes, params of an already-listed route, the splats.
  const NO_OLD = new Set([
    '/tms/load-review', '/tms/carrier-sales', '/tms/rates/spot', '/tms/rates/spot/callback',
    '/tms/brokerage/spot-quoter', '/tms/shipments/intake/:intakeId', '/tms/shipments/new', '/tms/shipments/:id/edit', '/tms/workflows/runs/:id', '/driver-view/:driverId',
    '/tms/brokerage/integrations/:provider',
  ])
  for (const h of AA_HOMES) {
    if (['public', 'splat'].includes(h.kind) || NO_OLD.has(h.pattern)) continue
    if (!AA_OLD_URLS.some(([url]) => matchesPattern(url.split('?')[0], h.pattern))) gaps.push(`${h.pattern}: no AA_OLD_URLS row`)
  }
  const dispatch = AA_OLD_URLS.find(([url]) => url === '/tms/dispatch')
  if (dispatch?.[1] !== '/tms/carrier-sales') gaps.push('/tms/dispatch must land on /tms/carrier-sales')
  return gaps
}

/** Gates 1, 2, 3 (static), the older registries, and gate 7 (static). Returns true when all pass. */
export async function inventory() {
  const { gaps, counts } = await aaInventoryGaps()
  const homes = gaps.filter((g) => /AA_HOMES|routes with no|home "|navPath|redirect names|hidden is reserved|duplicate/.test(g) && !/nav rows no|`to:/.test(g))
  const navGaps = gaps.filter((g) => !homes.includes(g))
  if (homes.length) { line('FAIL', 'gate 1: every route has one home', homes.join('; ')); return false }
  line('PASS', 'gate 1: every route has one home', `pages ${counts.page} · lifecycle ${counts.lifecycle} · redirects ${counts.redirect} · hidden ${counts.hidden} · off-nav ${counts.offnav} · public ${counts.public} · splat ${counts.splat} · unhomed ${counts.unhomed} · duplicate ${counts.duplicate}`)
  if (navGaps.length) { line('FAIL', 'gate 2: every page home is a sidebar row or a lifecycle tab (static)', navGaps.join('; ')); return false }
  line('PASS', 'gate 2: every page home is a sidebar row or a lifecycle tab (static)', `orphan nav rows ${counts.orphan}; ${counts.lifecycle} lifecycle homes each lit by a LIFECYCLE_TABS tab`)
  const old = oldUrlGaps()
  if (old.length) { line('FAIL', 'gate 3: old-URL registry (static)', old.join('; ')); return false }
  line('PASS', 'gate 3: old-URL registry (static)', `${AA_OLD_URLS.length} old URLs, each served by a route; every redirect and fixed page covered`)

  // The older registries must still be complete against the new App.tsx (S2 ROUTES, S3/S4 coverage, U redirects).
  const s2 = missingFromRoutes(await requiredPatterns())
  if (s2.length) { line('FAIL', 'registries: S2 route inventory', `no ROUTES entry for: ${s2.join(', ')}`); return false }
  const s3 = (await requiredLegacyPatterns()).filter((p) => !coveredPatterns().has(p))
  if (s3.length) { line('FAIL', 'registries: S3/S4 route inventory', `no coverage for: ${s3.join(', ')}`); return false }
  const s4 = await s4NavGaps()
  const u = [...await uNavGaps(), ...await uGoneGaps()]
  if (s4.length || u.length) { line('FAIL', 'registries: S4 nav + U gone gates', [...s4, ...u].join('; ')); return false }
  line('PASS', 'registries: S2, S3, S4 and U inventories still complete')

  const intake = await intakeGateGaps()
  if (intake.length) { line('FAIL', 'gate 7: intake review gate (static)', intake.join('; ')); return false }
  line('PASS', 'gate 7: intake review gate (static)', 'action, handler cases, client wrapper, pure lib and the page control are all present')
  return true
}

/** Gate 8: pay history is byte-identical; the only change allowed under the pay paths is the banner mount. */
const PAY_PATHS = [
  'src/lib/driverPay*', 'src/lib/ownerOperatorTrips.ts', 'src/lib/payPdf*', 'src/lib/mileagePeriods.ts', 'src/lib/fleetProfitability.ts',
  'src/lib/biweekly.ts', 'src/lib/payPeriods.ts', 'src/lib/settlement.ts', 'src/features/driver-pay/week.ts',
  'src/features/driver-pay-box-trucks', 'src/features/owner-operator-pay', 'amplify/functions/driver-app-api',
]
const BANNER_PAGES = [
  'src/features/driver-pay/DriverPayPage.tsx', 'src/features/driver-pay-box-trucks/BoxTruckPayPage.tsx',
  'src/features/owner-operator-pay/OwnerOperatorPayPage.tsx',
]
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

export function payGuardGaps(base = baseArg ?? process.env.AA_BASE ?? 'HEAD') {
  const gaps = []
  // working tree vs BASE: nothing is committed during the step, so BASE..HEAD would hide every change
  const numstat = git('diff', '--numstat', base, '--', ...PAY_PATHS).split('\n').filter(Boolean)
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', ...PAY_PATHS).split('\n').filter(Boolean)
  for (const f of untracked) gaps.push(`${f}: new untracked file under a pay path`)
  for (const row of numstat) {
    const [added, removed, file] = row.split('\t')
    if (BANNER_PAGES.includes(file)) {
      if (Number(removed) !== 0) { gaps.push(`${file}: ${removed} line(s) removed (the banner mount only adds)`); continue }
      if (Number(added) > 3) { gaps.push(`${file}: ${added} lines added (limit 3: one import, one JSX line)`); continue }
      const patch = git('diff', '-U0', base, '--', file).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter(Boolean)
      const stray = patch.filter((l) => !/PayrollCadenceBanner/.test(l))
      if (stray.length) gaps.push(`${file}: added lines that are not the banner mount: ${stray.slice(0, 2).join(' | ')}`)
    } else if (/\.test\.(ts|tsx)$/.test(file) && BANNER_PAGES.some((p) => file.startsWith(p.replace(/\.tsx$/, '')))) {
      if (Number(removed) !== 0) gaps.push(`${file}: test lines removed`)
    } else {
      gaps.push(`${file}: +${added} -${removed} under a pay path`)
    }
  }
  return gaps
}

function payGuard() {
  const base = baseArg ?? process.env.AA_BASE ?? 'HEAD'
  const gaps = payGuardGaps(base)
  if (gaps.length) { line('FAIL', 'gate 8: pay history byte-identical', gaps.join('; ')); return false }
  line('PASS', 'gate 8: pay history byte-identical', `only the PayrollCadenceBanner mount differs from ${base} under ${PAY_PATHS.length} pay paths`)
  return true
}

// ───────────────────────────── browser helpers ─────────────────────────────
const mainText = (b) => b.evaluate(`document.querySelector('.tms-main')?.innerText ?? ''`)
const bodyText = (b) => b.evaluate(`document.body.innerText`)
const pathname = (b) => b.evaluate('location.pathname')
const search = (b) => b.evaluate('location.search')
const drawerText = (b) => b.evaluate(`([...document.querySelectorAll('.tms-drawer, [role="dialog"]')].pop())?.innerText ?? ''`)
const uAudit = async (b) => (await b.evaluate(`(${uAuditInPage})()`)).map((f) => `u: ${f}`)
const themeTag = (theme) => (theme === 'dark' ? 'D' : 'L')

async function step(id, fn) {
  if (!matches(id)) return
  try {
    const detail = await fn()
    line('PASS', id, typeof detail === 'string' ? detail : undefined)
  } catch (err) {
    line('FAIL', id, short(err))
  }
}
const backendStep = (ctx, id, fn) => (ctx.backend ? step(id, fn) : (matches(id) ? skipLine(id, '', 'Step AA backend not deployed', BACKEND_ALLOWED) : undefined))

async function clickByText(b, scope, selector, pattern) {
  const hit = await b.evaluate(`(() => {
    const root = ${JSON.stringify(scope)} === 'drawer' ? [...document.querySelectorAll('.tms-drawer, [role="dialog"]')].pop() : document.querySelector('.tms-main');
    if (!root) return 'no-scope';
    const re = new RegExp(${JSON.stringify(pattern)}, 'i');
    const el = [...root.querySelectorAll(${JSON.stringify(selector)})].find((n) => re.test(n.textContent.trim()));
    if (!el) return 'no-match';
    if (el.disabled) return 'disabled';
    el.scrollIntoView({ block: 'center' }); el.click(); return 'ok';
  })()`)
  if (hit !== 'ok') fail(`click ${scope} ${selector} /${pattern}/: ${hit}`)
}
const buttonState = (b, pattern) => b.evaluate(`(() => {
  const el = [...document.querySelectorAll('.tms-main button')].find((n) => new RegExp(${JSON.stringify(pattern)}, 'i').test(n.textContent.trim()));
  return el ? (el.disabled ? 'disabled' : 'enabled') : 'absent';
})()`)

async function waitShell(b) {
  await b.poll(() => b.evaluate(`!!document.querySelector('.tms-sidebar')`), 'shell sidebar mounted', 45_000)
}

/** The lifecycle strip's tabs as rendered (Step AV): [{ key, href, active }] in DOM order; waits for the strip to mount. */
const lifecycleStrip = async (b) => {
  await b.poll(() => b.evaluate(`!!document.querySelector('[data-testid^="lifecycle-tab-"]')`), 'lifecycle strip mounted', 30_000)
  return b.evaluate(`[...document.querySelectorAll('[data-testid^="lifecycle-tab-"]')].map((a) => ({ key: a.getAttribute('data-testid').slice('lifecycle-tab-'.length), href: a.getAttribute('href'), active: a.classList.contains('tms-active') }))`)
}

// ── sidebar facts: the DOM is `.tms-nav-rowwrap` (row + children) and `.tms-section-head` markers, in order ──
const SIDEBAR_JS = `(() => {
  const nav = document.querySelector('nav[aria-label="TMS sections"]') ?? document.querySelector('.tms-sidebar');
  if (!nav) return [];
  const rows = [];
  let section = null;
  const text = (el) => (el?.textContent ?? '').trim();
  for (const el of nav.querySelectorAll('.tms-section-head, .tms-nav-rowwrap')) {
    if (el.classList.contains('tms-section-head')) { section = text(el).replace(/\\s*\\[.*\\]\\s*$/, ''); continue; }
    const row = el.querySelector(':scope > .tms-nav-row');
    const caret = el.querySelector(':scope > .tms-nav-caret');
    if (row) rows.push({ section, depth: 0, label: text(row.querySelector('.tms-nav-label')), href: row.getAttribute('href'), badge: text(row.querySelector('.tms-nav-badge')), expanded: caret ? caret.getAttribute('aria-expanded') === 'true' : null, visible: row.getBoundingClientRect().width > 0 });
    for (const child of el.querySelectorAll('.tms-nav-child')) {
      rows.push({ section, depth: 1, label: text(child.querySelector('.tms-nav-child-label')), href: child.getAttribute('href'), badge: text(child.querySelector('.tms-nav-child-badge')), expanded: null, visible: child.getBoundingClientRect().width > 0 });
    }
  }
  return rows;
})()`
const sidebarRows = (b) => b.evaluate(SIDEBAR_JS)
const pathOf = (href) => String(href ?? '').split('?')[0]

/** Click every collapsed caret that belongs to a top-level row until none is left collapsed. */
async function openAllGroups(b) {
  for (let i = 0; i < 12; i += 1) {
    const clicked = await b.evaluate(`(() => {
      const c = [...document.querySelectorAll('.tms-nav-rowwrap > .tms-nav-caret[aria-expanded="false"]')];
      if (!c.length) return 0;
      c[0].click();
      return c.length;
    })()`)
    if (!clicked) return
    await pause(150)
  }
}

/** Gate 4 (+ gate 2 in the browser): the ADMIN sidebar is exactly §2.1. */
async function sidebarGate(b, ctx, theme) {
  await step(`AA01-sidebar-tree-${theme}`, async () => {
    await b.navigate('/tms/dashboard'); await waitShell(b); await waitLoaded(b).catch(() => {})
    await openAllGroups(b)
    const rows = await sidebarRows(b)
    const pinned = rows.filter((r) => r.section === null)
    const got = pinned.map((r) => `${r.depth}|${r.label}|${r.href}`)
    const want = AA_SIDEBAR.map(([label, href, depth]) => `${depth}|${label}|${href}`)
    // the live-loads list under Tracking is gone with the row; everything else must match in order
    const missing = want.filter((w) => !got.includes(w))
    if (missing.length) fail(`sidebar lacks: ${missing.slice(0, 4).join(' ; ')}`)
    const extra = got.filter((g) => !want.includes(g))
    if (extra.length) fail(`sidebar has rows outside §2.1: ${extra.slice(0, 4).join(' ; ')}`)
    if (got.join('\n') !== want.join('\n')) fail(`sidebar order differs from §2.1: got ${got.slice(0, 6).join(' ; ')}…`)
    const heads = [...new Set(rows.filter((r) => r.section !== null).map((r) => r.section))]
    const sections = AA_SIDEBAR_SECTIONS.filter((s) => !heads.some((h) => h.toUpperCase().startsWith(s)))
    if (sections.length) fail(`no section header for: ${sections.join(', ')}`)
    if (heads.some((h) => /^BROKERAGE/i.test(h))) fail('a BROKERAGE section header is still rendered')
    const banned = rows.filter((r) => SIDEBAR_BANNED_HREFS.includes(pathOf(r.href)))
    if (banned.length) fail(`sidebar links ${banned.map((r) => r.href).join(', ')}`)
    // orphan rows: every rendered href is served by a registry row
    const orphans = rows.filter((r) => !AA_HOMES.some((h) => h.navPath === pathOf(r.href) || (h.kind !== 'redirect' && h.kind !== 'splat' && matchesPattern(pathOf(r.href), h.pattern))))
    if (orphans.length) fail(`orphan sidebar rows: ${orphans.slice(0, 4).map((r) => `${r.label} ${r.href}`).join(', ')}`)
    // gate 2 (browser): every page-kind home with a navPath is a rendered row for ADMIN
    const rendered = new Set(rows.map((r) => pathOf(r.href)))
    // a division section's own Intake row (`/tms/shipments/intake?division=CODE`, navSections) is not the brokerage Intake page row
    const plainRendered = new Set(rows.filter((r) => !String(r.href).includes('?')).map((r) => pathOf(r.href)))
    const absent = [...new Set(AA_HOMES.filter((h) => h.kind === 'page').map((h) => h.navPath))].filter((p) => !rendered.has(p))
    if (absent.length) fail(`page homes not rendered as sidebar rows: ${absent.join(', ')}`)
    // ...and every lifecycle-kind home is NOT a sidebar row of its own: the strip carries it (View's route doubles as the Active shipments row)
    const tabs = await aaLifecycleTabs()
    const doubled = tabs.filter((t) => t.key !== 'view' && plainRendered.has(t.to)).map((t) => t.to)
    if (doubled.length) fail(`lifecycle pages are still sidebar rows: ${doubled.join(', ')}`)
    const strip = await lifecycleStrip(b)
    const wantStrip = tabs.map((t) => `${t.key}|${t.to}`)
    const gotStrip = strip.map((t) => `${t.key}|${pathOf(t.href)}`)
    if (gotStrip.join('\n') !== wantStrip.join('\n')) fail(`the lifecycle strip is [${gotStrip.join(', ')}], expected [${wantStrip.join(', ')}]`)
    // group headers point at their first visible child
    for (const [label, href] of [['Accounting', '/tms/invoicing'], ['Settings', '/tms/brokerage']]) {
      const head = pinned.find((r) => r.depth === 0 && r.label === label)
      if (head?.href !== href) fail(`${label} header href ${head?.href}, expected ${href}`)
    }
    await walk.shot(b, 'AA01', 'sidebar', themeTag(theme), false).catch(() => {})
    return `${pinned.length} pinned rows in §2.1 order; ${rows.length - pinned.length} section rows; ${rendered.size} distinct hrefs, no orphan`
  })
  await step(`AA01-groups-follow-path-${theme}`, async () => {
    for (const parent of AA_SIDEBAR_PARENTS) {
      await b.navigate(parent.open); await waitShell(b); await waitLoaded(b).catch(() => {}); await pause(300)
      const rows = (await sidebarRows(b)).filter((r) => r.section === null)
      const mine = rows.find((r) => r.depth === 0 && r.label === parent.label)
      if (!mine?.expanded) fail(`${parent.label} is not expanded on ${parent.open}`)
      const others = rows.filter((r) => r.depth === 0 && r.expanded === true && r.label !== parent.label)
      if (others.length) fail(`on ${parent.open} other groups are expanded: ${others.map((r) => r.label).join(', ')}`)
    }
    return `${AA_SIDEBAR_PARENTS.length} parents each open on their own path and only there`
  })
  await step(`AA01-active-row-${theme}`, async () => {
    const lit = async (path, label) => {
      await b.navigate(path); await waitShell(b); await waitLoaded(b).catch(() => {}); await pause(300)
      const names = await b.evaluate(`[...document.querySelectorAll('.tms-nav-row.tms-active .tms-nav-label, .tms-nav-child.tms-active .tms-nav-child-label')].map((n) => n.textContent.trim())`)
      if (!names.includes(label)) fail(`${path}: "${label}" is not lit (lit: ${names.join(', ') || 'none'})`)
      return names
    }
    const litTab = async (path, key) => {
      await b.navigate(path); await waitShell(b); await waitLoaded(b).catch(() => {}); await pause(300)
      const active = (await lifecycleStrip(b)).filter((t) => t.active).map((t) => t.key)
      if (active.join() !== key) fail(`${path}: lifecycle tab "${key}" is not the lit one (lit: ${active.join(', ') || 'none'})`)
    }
    await lit('/tms/shipments', 'Active shipments')
    await lit('/tms/carriers', 'Carriers')
    await lit('/tms/carriers/find', 'Carriers')
    await litTab('/tms/shipments', 'view')
    await litTab('/tms/shipments?list=all', 'view')
    await litTab('/tms/rates/spot', 'quote')
    await litTab('/tms/carrier-sales', 'book')
    await litTab('/tms/tracking', 'track')
    await litTab('/tms/load-review', 'review')
    await litTab('/tms/shipments/intake', 'build')
    await lit('/tms/vendors', 'Accounting')
    await lit('/tms/vendors', 'Vendors')
    await lit('/tms/invoicing/payable', 'Accounts Payable')
    const ar = await b.evaluate(`[...document.querySelectorAll('.tms-nav-child.tms-active .tms-nav-child-label')].map((n) => n.textContent.trim())`)
    if (ar.includes('Accounts Receivable')) fail('Accounts Receivable is lit on /tms/invoicing/payable')
    await lit('/compliance', 'Compliance')
    await lit('/compliance', 'Settings')
    return 'Active shipments row + the lifecycle tab for each page, AR/AP, Accounting parent, Settings › Compliance light exactly their own rows'
  })
  if (theme !== 'light') return
  await step('AA01-collapsed-rail', async () => {
    await b.evaluate(`localStorage.setItem('tms-sidebar-collapsed', '1')`)
    await b.navigate('/tms/dashboard'); await waitShell(b); await pause(500)
    try {
      const facts = await b.evaluate(`(() => ({
        collapsed: !!document.querySelector('.tms-shell.tms-is-collapsed'),
        rows: [...document.querySelectorAll('.tms-nav-rowwrap > .tms-nav-row')].map((r) => ({ title: r.getAttribute('title'), w: r.getBoundingClientRect().width, icon: !!r.querySelector('svg') })),
      }))()`)
      if (!facts.collapsed) fail('the rail did not collapse')
      const pinnedTop = AA_SIDEBAR.filter((r) => r[2] === 0).map((r) => r[0])
      for (const label of pinnedTop) {
        const row = facts.rows.find((r) => r.title === label)
        if (!row || !(row.w > 0)) fail(`collapsed rail has no visible row for ${label}`)
        if (!row.icon) fail(`collapsed rail row ${label} has no icon`)
      }
      await walk.shot(b, 'AA01', 'sidebar-collapsed', 'L', false).catch(() => {})
      return `${pinnedTop.length} top-level rows render as icons with titles`
    } finally {
      await b.evaluate(`localStorage.setItem('tms-sidebar-collapsed', '0')`)
    }
  })
}

/** Gate 3: every old URL still lands where §3 says, inside the shell, with content and no console error. */
async function oldUrlsGate(b) {
  await step('AA03-old-urls', async () => {
    const failures = []
    // One URL, one verdict. The shell (a legacy page's shell mounts after its first paint) is polled for, not sampled once.
    const check = async (url, landing, wantSearch) => {
      b.mark()
      await b.navigate(url)
      let landed = ''
      try {
        await b.poll(async () => { landed = await pathname(b); return landed === landing }, `landing on ${landing}`, 15_000)
      } catch { return `${url} landed on ${landed}, expected ${landing}` }
      await waitBody(b, 20_000)
      if (wantSearch && (await search(b)) !== wantSearch) return `${url}: search "${await search(b)}", expected "${wantSearch}"`
      const read = () => b.evaluate(`(() => ({
        shell: !!document.querySelector('.tms-sidebar'),
        main: (document.querySelector('.tms-main')?.innerText ?? '').trim().length,
        noAccess: /no page access/i.test(document.body.innerText),
      }))()`)
      let facts = await read()
      for (let i = 0; i < 20 && (!facts.shell || !facts.main); i += 1) { await pause(1000); facts = await read() }
      if (!facts.shell) return `${url}: no shell`
      if (!facts.main) return `${url}: .tms-main is empty`
      if (facts.noAccess) return `${url}: "No page access" panel for ADMIN`
      // an id that does not exist may legitimately fail its own read; every other URL must be clean
      if (!url.includes('zz-x')) {
        const problems = problemList(b).slice(0, 2)
        if (problems.length) return `${url}: ${problems.join(' | ')}`
      }
      return null
    }
    for (const [url, landing, wantSearch] of AA_OLD_URLS) {
      // a dropped request (a "Failed to fetch" while the dev API is busy) is not a routing defect: look once more
      const verdict = (await check(url, landing, wantSearch)) && (await check(url, landing, wantSearch))
      if (verdict) failures.push(verdict)
    }
    if (failures.length) fail(`${failures.length}/${AA_OLD_URLS.length} old URLs wrong: ${failures.slice(0, 4).join(' ;; ')}`)
    return `${AA_OLD_URLS.length} old URLs land in the shell with content (incl. /tms/dispatch → /tms/carrier-sales)`
  })
}

// ───────────────────────────── per-route audit ─────────────────────────────
function resolvePath(route, ctx) {
  if (!route.path.includes('{')) return route.path
  const intake = ctx.rows?.a?.id
  if (route.path.includes('{intake}') && intake) return route.path.replace('{intake}', encodeURIComponent(intake))
  return null
}

async function auditRoute(b, route, theme, ref) {
  const id = `${route.nn}-${route.slug}`
  if (!matches(id) || route.nn === 'AA01') return
  const path = resolvePath(route, b.ctx)
  if (!path) { skipLine(id, theme, 'fixture not created', 'needs the intake fixture, which needs the Step U ingest path'); return }
  b.mark()
  await b.navigate(path)
  const failures = []
  try { await waitLoaded(b) } catch (e) { if (!route.legacy) failures.push(e.message); else await waitBody(b) }
  await pause(700)
  failures.push(...problemList(b).slice(0, 3))
  failures.push(...await audit(b, theme, { wideOk: route.wideOk }))
  const f = await b.evaluate(SHELL_FACTS)
  const t = await b.evaluate(TOKEN_PROBE)
  failures.push(...shellFailures(f, t, ref, { legacyHost: !!route.legacy, scrollOk: !route.legacy }))
  failures.push(...await uAudit(b))
  await conclude(b, id, theme, route.nn, route.slug, failures, !route.legacy)
}

/** Per-page facts that are the point of each AA row (titles, labels, mounted banner). */
async function pageFacts(b, ctx, theme) {
  const read = async (path) => { await b.navigate(path); await waitLoaded(b).catch(() => waitBody(b)); await pause(400); return mainText(b) }
  await step(`AA05-quotes-labels-${theme}`, async () => {
    const text = await read('/tms/rates')
    if (!/^\s*Quote · Spot quotes\b/m.test(text.split('\n').slice(0, 6).join('\n'))) fail('the page title is not "Quote · Spot quotes"')
    if (/^\s*Rates\s*$/m.test(text.split('\n').slice(0, 6).join('\n'))) fail('the page title still reads "Rates"')
    const lit = (await lifecycleStrip(b)).filter((t) => t.active).map((t) => t.key)
    if (lit.join() !== 'quote') fail(`the Quote lifecycle tab is not the lit one on /tms/rates (lit: ${lit.join(', ') || 'none'})`)
    return 'title Quote · Spot quotes; Quote tab lit'
  })
  await step(`AA08-settings-title-${theme}`, async () => {
    const text = await read('/tms/brokerage')
    const head = text.split('\n').slice(0, 8).join('\n')
    if (!/Settings/.test(head)) fail('the page title is not "Settings"')
    if (/My Brokerage/.test(await b.evaluate('document.body.innerText'))) fail('"My Brokerage" is still rendered')
    const crumb = await b.evaluate(`document.querySelector('nav[aria-label="Breadcrumb"]')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
    if (!/Settings\s*›?\s*General & automation/.test(crumb)) fail(`breadcrumb "${crumb}" is not Settings › General & automation`)
    return 'title Settings; breadcrumb Settings › General & automation'
  })
  await step(`AA09-compliance-in-settings-${theme}`, async () => {
    await b.navigate('/compliance'); await waitBody(b)
    const crumb = await b.evaluate(`document.querySelector('nav[aria-label="Breadcrumb"]')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
    if (!/Settings\s*›?\s*Compliance/.test(crumb)) fail(`breadcrumb "${crumb}" is not Settings › Compliance`)
    return 'breadcrumb Settings › Compliance'
  })
  await step(`AA06-accounting-lit-${theme}`, async () => {
    for (const [path, child] of [['/tms/invoicing', 'Accounts Receivable'], ['/tms/invoicing/payable', 'Accounts Payable'], ['/tms/vendors', 'Vendors'], ['/tms/factors', 'Factoring']]) {
      await read(path)
      const lit = await b.evaluate(`[...document.querySelectorAll('.tms-nav-row.tms-active .tms-nav-label, .tms-nav-child.tms-active .tms-nav-child-label')].map((n) => n.textContent.trim())`)
      if (!lit.includes('Accounting') || !lit.includes(child)) fail(`${path}: lit rows [${lit.join(', ')}] lack Accounting + ${child}`)
    }
    return 'Accounting and the right child light on AR, AP, Vendors, Factoring'
  })
  await step(`AA04-vendors-${theme}`, async () => {
    const text = await read('/tms/vendors')
    const tabs = await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].map((t) => t.textContent.trim())`)
    for (const wanted of [/^Bills/i, /By vendor/i]) if (!tabs.some((t) => wanted.test(t))) fail(`Vendors has no ${wanted} tab (tabs: ${tabs.join(', ')})`)
    if (!/Not in this queue/i.test(text)) fail('the "Not in this queue" card is missing')
    if (!/Maintenance|E-?mail|Email/i.test(text)) fail('no source chip (Maintenance / E-mail) on the page')
    return 'Bills + By vendor tabs, source chips, "Not in this queue" card'
  })
  await step(`AA02-carrier-sales-${theme}`, async () => {
    const text = await read('/tms/carrier-sales')
    const tabs = await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].map((t) => t.textContent.trim())`)
    for (const wanted of [/^Needs cover/i, /^Offers/i, /^Covered/i]) if (!tabs.some((t) => wanted.test(t))) fail(`Carrier Sales has no ${wanted} tab (tabs: ${tabs.join(', ')})`)
    if (!/Book · Carrier sales/.test(text.split('\n').slice(0, 6).join('\n'))) fail('the page title is not "Book · Carrier sales"')
    return 'Needs cover / Offers / Covered tabs'
  })
  await step(`AA11-settlements-banner-${theme}`, async () => {
    for (const path of ['/driver-pay', '/driver-pay-box-trucks', '/owner-operator-pay']) {
      await b.navigate(path); await waitBody(b)
      const text = await bodyText(b)
      if (!/Payroll runs every Wednesday/.test(text)) fail(`${path}: no "Payroll runs every Wednesday" banner`)
      const line1 = /Payroll runs every Wednesday[^\n]*/.exec(text)?.[0] ?? ''
      if (!/Next pay date\s+\w+|Pay date is today/.test(line1)) fail(`${path}: banner has no next pay date: ${line1.slice(0, 80)}`)
      if (!/Covers\s+Sun/.test(line1)) fail(`${path}: banner does not name the Sun–Sat period: ${line1.slice(0, 120)}`)
    }
    return 'the cadence line (Wednesday, next pay date, Sun–Sat period) shows on all three settlement pages'
  })
  for (const [nn, path] of [['AA12', '/tms/rates/spot'], ['AA14', '/tms/brokerage/spot-quoter']]) {
    await step(`${nn}-placeholder-${theme}`, async () => {
      const text = await read(path)
      if (!/Arrives with Step AB/i.test(text) && !/Spot|Follow-?ups?/i.test(text)) fail(`${path} renders neither the labelled placeholder nor Step AB content`)
      return /Arrives with Step AB/i.test(text) ? 'labelled placeholder' : 'Step AB content present'
    })
  }
}

// ───────────────────────────── phone ─────────────────────────────
async function phonePass(b, ctx) {
  await b.command('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await b.setViewport(390, 844, 2)
  try {
    await step('AA01-drawer-phone', async () => {
      await b.navigate('/tms/dashboard'); await waitShell(b); await pause(500)
      await b.click({ selector: '[aria-label="Open menu"]' })
      await b.poll(() => b.evaluate(`!!document.querySelector('.tms-shell.tms-nav-open')`), 'nav drawer open', 10_000)
      await openAllGroups(b)
      const rows = await sidebarRows(b)
      const pinned = rows.filter((r) => r.section === null)
      for (const [label, href, depth] of AA_SIDEBAR) {
        const row = pinned.find((r) => r.label === label && r.href === href && r.depth === depth)
        if (!row) fail(`the 390 px drawer lacks ${label}`)
        if (!row.visible) fail(`the 390 px drawer renders ${label} with no width`)
      }
      await walk.shot(b, 'AA01', 'sidebar-drawer', 'M', false).catch(() => {})
      return `${AA_SIDEBAR.length} pinned rows render in the drawer`
    })
    const targets = AA_ROUTES.filter((r) => r.phone && r.nn !== 'AA01')
    for (const r of targets) {
      await step(`${r.nn}-${r.slug}-phone`, async () => {
        b.mark()
        await b.navigate(r.path); await waitLoaded(b).catch(() => {}); await pause(700)
        const failures = [...problemList(b).slice(0, 3), ...await audit(b, 'light', { wideOk: true }), ...await uAudit(b)]
        const overflow = await b.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        if (overflow > 1) failures.push(`horizontal overflow ${overflow}px`)
        if (failures.length) fail(failures.slice(0, 3).join(' | '))
        await walk.shot(b, r.nn, r.slug, 'M', false).catch(() => {})
        return 'no overflow'
      })
    }
    if (ctx.lr?.seeded) {
      await step('AA03-load-review-drawer-phone', async () => {
        await b.navigate(`/tms/load-review?shipment=${encodeURIComponent(ctx.demo.readytobill.id)}`); await waitLoaded(b).catch(() => {}); await pause(1200)
        const text = await drawerText(b)
        if (!text) fail('the drawer did not open from ?shipment=')
        const overflow = await b.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        if (overflow > 1) fail(`horizontal overflow ${overflow}px with the drawer open`)
        await walk.shot(b, 'AA03', 'load-review-drawer', 'M', false).catch(() => {})
        return 'drawer opens from ?shipment= with no overflow'
      })
    }
  } finally {
    await b.setViewport(1600, 1000, 1)
  }
}

// ───────────────────────────── identities, fixtures ─────────────────────────────
async function openInIdentity(ctx, storage, prefix, theme, fn) {
  const b = await launchBrowser({ origin: ctx.origin, storage: { ...storage, ...(theme === 'dark' ? { 'tms-theme': 'dark' } : {}) }, profilePrefix: prefix, purpose: 'AA verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
  try {
    await b.navigate('/tms/dashboard')
    await waitShell(b)
    return await fn(b)
  } finally { await b.close() }
}

const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

const TINY_PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
async function attachDocument(ctx, shipmentId, loadId, type) {
  const ship = ctx.shipAs.admin
  const name = `zz-aa-${type.toLowerCase()}.pdf`
  const prepared = await ship('PREPARE_DOCUMENT_UPLOAD', { shipmentId, type, name, contentType: 'application/pdf', sizeBytes: TINY_PDF.length })
  const put = await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: TINY_PDF })
  if (!put.ok) fail(`document upload answered ${put.status}`)
  return ship('COMMIT_DOCUMENT', { shipmentId, documentId: prepared.documentId, s3Key: prepared.s3Key, type, name, contentType: 'application/pdf', sizeBytes: TINY_PDF.length, loadId })
}

/** A delivered ZZ shipment through the real actions (the same ladder devVerifyAr climbs). */
async function buildDelivered(ctx, label, { docs, rep }) {
  const ship = ctx.shipAs.admin
  const today = chicagoToday()
  let bundle = await ship('CREATE_SHIPMENT', { customerId: ctx.customerId })
  const shipmentId = bundle.shipment.id
  ctx.shipmentIds.add(shipmentId)
  bundle = await ship('SAVE_ORDER_FORM', {
    shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt,
    order: { mode: 'FTL', equipmentType: 'Dry Van', references: [{ code: 'PO', label: 'Purchase order', value: `ZZ-AA-${label}-${ctx.ts}`, level: 'ORDER', visibility: 'CUSTOMER' }] },
    stops: [
      { type: 'pickup', name: 'ZZ AA Shipper', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: `${today}T13:00:00.000Z` },
      { type: 'delivery', name: 'ZZ AA Receiver', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: `${today}T23:00:00.000Z` },
    ],
    charges: [{ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 250000, count: 1 }, { side: 'CARRIER', code: 'LINEHAUL', rateCents: 180000, count: 1 }],
  })
  const reload = async () => { bundle = await ship('GET_SHIPMENT_BUNDLE', { shipmentId }) }
  await ship('SUBMIT_ORDER', { shipmentId, expectedUpdatedAt: bundle.shipment.updatedAt }); await reload()
  for (const status of ['BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'UNLOADING', 'DELIVERED']) {
    const load = bundle.loads[0]
    await ship('SET_LOAD_STATUS', { loadId: load.id, status, expectedUpdatedAt: load.updatedAt }).catch(() => {})
    await reload()
  }
  if (docs) { await attachDocument(ctx, shipmentId, bundle.loads[0].id, 'BOL'); await attachDocument(ctx, shipmentId, bundle.loads[0].id, 'POD'); await reload() }
  await ship('SET_REV_TAG', { shipmentId, divisionCode: ctx.divisionCode })
  await ship('SET_SALES_REP', { shipmentId, repId: rep ? ctx.repId : null })
  await reload()
  return { id: shipmentId, number: bundle.shipment.number, orderId: bundle.orders[0].id, orderUpdatedAt: bundle.orders[0].updatedAt }
}

// ───────────────────────────── gate 5: personas ─────────────────────────────
async function personaGate(ctx, theme) {
  await step(`AA05-persona-load-review-${theme}`, () => openInIdentity(ctx, ctx.ids.lr.storage, 'bcat-aa-lr-', theme, async (b) => {
    await waitLoaded(b).catch(() => {})
    const landed = await pathname(b)
    if (landed !== AA_PERSONAS.loadReview.landing) fail(`a page-loadReview-only user lands on ${landed}, expected ${AA_PERSONAS.loadReview.landing}`)
    const rows = await sidebarRows(b)
    const hrefs = [...new Set(rows.map((r) => pathOf(r.href)))]
    if (hrefs.length !== AA_PERSONAS.loadReview.rail.length) fail(`the rail is [${hrefs.join(', ')}], expected no sidebar rows (Load Review is a lifecycle tab)`)
    const tabs = (await lifecycleStrip(b)).map((t) => t.key)
    if (tabs.join() !== AA_PERSONAS.loadReview.tabs.join()) fail(`the lifecycle strip is [${tabs.join(', ')}], expected [${AA_PERSONAS.loadReview.tabs.join(', ')}]`)
    await b.navigate(AA_PERSONAS.loadReview.redirected); await pause(2500)
    if ((await pathname(b)) !== AA_PERSONAS.loadReview.landing) fail(`${AA_PERSONAS.loadReview.redirected} did not redirect to ${AA_PERSONAS.loadReview.landing} (at ${await pathname(b)})`)
    return 'rail = []; lifecycle strip = [Review]; lands on /tms/load-review; /tms/carriers redirects there'
  }))
  await step(`AA05-persona-compliance-${theme}`, () => openInIdentity(ctx, ctx.ids.comp.storage, 'bcat-aa-comp-', theme, async (b) => {
    await b.navigate('/compliance'); await waitBody(b)
    const rows = await sidebarRows(b)
    const settings = rows.find((r) => r.depth === 0 && r.label === 'Settings')
    if (!settings) fail('a page-compliance-only user has no Settings row')
    if (settings.href !== '/compliance') fail(`the Settings header href is ${settings.href}, expected /compliance`)
    const child = rows.find((r) => r.depth === 1 && r.label === 'Compliance')
    if (!child) fail('Settings has no Compliance child for a page-compliance-only user')
    const stray = rows.filter((r) => r !== settings && r !== child && !(r.depth === 1 && pathOf(r.href) === '/compliance'))
    if (stray.length) fail(`the rail also shows: ${stray.map((r) => r.label).join(', ')}`)
    return 'rail = Settings › Compliance; Settings header → /compliance'
  }))
  await step(`AA05-persona-tms-${theme}`, () => openInIdentity(ctx, ctx.ids.tms.storage, 'bcat-aa-tms-', theme, async (b) => {
    await b.navigate('/tms/dashboard'); await waitLoaded(b).catch(() => {})
    await openAllGroups(b)
    const rows = await sidebarRows(b)
    const hrefs = new Set(rows.map((r) => pathOf(r.href)))
    const leaked = AA_ADMIN_ONLY_HREFS.filter((h) => hrefs.has(h))
    if (leaked.length) fail(`a page-tms user sees ADMIN-only rows: ${leaked.join(', ')}`)
    const tabs = await lifecycleStrip(b)
    const lost = AA_PERSONAS.tms.presentTabs.filter((k) => !tabs.some((t) => t.key === k))
    if (lost.length) fail(`a page-tms user's lifecycle strip lacks: ${lost.join(', ')} (has ${tabs.map((t) => t.key).join(', ') || 'none'})`)
    return 'no ADMIN-only rows; the lifecycle strip shows all six tabs, Review included'
  }))
  if (theme !== 'light') return
  if (!ctx.reviewDeployed || !ctx.zz.noDocs) { if (matches('AA05-persona-load-review-server')) skipLine('AA05-persona-load-review-server', '', 'Step AA review backend or the ZZ fixture is unavailable', BACKEND_ALLOWED); return }
  await step('AA05-persona-load-review-server', async () => {
    const lr = ctx.shipAs.lr
    const z = ctx.zz.noDocs
    const review = await lr('REVIEW_LOAD', { shipmentId: z.id })
    if (!review || typeof review !== 'object') fail('REVIEW_LOAD returned nothing')
    await lr('SET_SALES_REP', { shipmentId: z.id, repId: null })
    await lr('SET_REV_TAG', { shipmentId: z.id, divisionCode: ctx.divisionCode })
    // READY_TO_INVOICE may be refused by the gate (this fixture has no documents); it must not be refused as Forbidden
    try { await lr('READY_TO_INVOICE', { shipmentId: z.id, orderId: z.orderId, expectedUpdatedAt: z.orderUpdatedAt }) } catch (err) {
      if (/Forbidden/i.test(String(err?.message ?? err))) fail(`READY_TO_INVOICE is Forbidden for page-loadReview: ${short(err)}`)
    }
    for (const [action, input] of [
      ['PREPARE_DOCUMENT_UPLOAD', { shipmentId: z.id, type: 'POD', name: 'zz-aa.pdf', contentType: 'application/pdf', sizeBytes: 10 }],
      ['COMMIT_DOCUMENT', { shipmentId: z.id, documentId: 'zz', s3Key: 'zz', type: 'POD', name: 'zz-aa.pdf', contentType: 'application/pdf', sizeBytes: 10 }],
    ]) {
      try { await lr(action, input) } catch (err) {
        if (/Forbidden/i.test(String(err?.message ?? err))) continue
        fail(`${action} refused for the wrong reason for page-loadReview: ${short(err)}`)
      }
      fail(`${action} was allowed for page-loadReview (the grant must not widen to documents)`)
    }
    return 'REVIEW_LOAD, SET_SALES_REP, SET_REV_TAG and READY_TO_INVOICE are not Forbidden; document upload is'
  })
}

// ───────────────────────────── gate 6: Load Review on dev data ─────────────────────────────
const clickTab = async (b, pattern) => { await clickByText(b, 'main', '[role="tab"]', pattern); await pause(500) }
const rowText = (b, needle) => b.evaluate(`(() => {
  const row = [...document.querySelectorAll('.tms-main tr, .tms-main [role="row"]')].find((r) => r.textContent.includes(${JSON.stringify(needle)}));
  return row ? row.innerText.replace(/\\s+/g, ' ') : null;
})()`)
/** The queue is oldest-delivered first, 50 a page, and a fixture delivered today sorts last: narrow it with the page's own search. */
async function filterQueue(b, number) {
  const url = new URL(await b.evaluate('location.href'))
  url.searchParams.set('q', number); url.searchParams.delete('page'); url.searchParams.delete('shipment')
  await b.navigate(url.pathname + url.search); await waitLoaded(b).catch(() => {}); await pause(800)
}
async function openRowDrawer(b, number) {
  const hit = await b.evaluate(`(() => {
    const row = [...document.querySelectorAll('.tms-main tr, .tms-main [role="row"]')].find((r) => r.textContent.includes(${JSON.stringify(number)}));
    if (!row) return 'no-row';
    (row.querySelector('td:not(:first-child), [role="cell"]:not(:first-child)') ?? row).click();
    return 'ok';
  })()`)
  if (hit !== 'ok') fail(`no row for ${number}`)
  await b.poll(async () => (await drawerText(b)).includes(number), `drawer for ${number}`, 20_000)
  await pause(800)
}

/** The seed's six staff slots (demo.ts STAFF_ROLES) need REAL UserProfile ids: the seed assigns a carrier rep, and the handler refuses a rep without a CARRIER_REP profile. */
async function demoStaff(ctx) {
  const rows = (await gql(ctx.token, 'query { listUserProfiles(limit: 1000) { items { id name email role status } } }', {})).listUserProfiles.items.filter((p) => p.status === 'ACTIVE')
  const pick = (role, n = 0) => rows.filter((p) => p.role === role)[n] ?? rows[0]
  const slots = [pick('CARRIER_REP', 0), pick('CARRIER_REP', 1), pick('MANAGER'), pick('CUSTOMER_REP'), pick('CARRIER_REP', 2), pick('AR_AP')]
  if (slots.some((p) => !p)) fail('dev has no UserProfile rows to seed the demo staff with')
  return slots.map((p) => ({ id: p.id, name: p.name ?? p.email ?? p.id }))
}

const demoKeysOf = (state) => (state.records ?? []).filter((r) => r.kind === 'SHIPMENT').map((r) => r.demoKey)
const DEMO_NAMED = ['shipment.readytobill', 'shipment.podflagged']

/**
 * RESET_DEMO_DATA outlives the 30 s the API waits for it on a large dev table (the Lambda keeps running): a client
 * timeout is not a failure. Wait for the seed to be whole again instead of trusting the response.
 */
async function resetDemo(ctx) {
  const staff = await demoStaff(ctx)
  try { await ctx.shipAs.admin('RESET_DEMO_DATA', { staff }) } catch (err) {
    if (!/timed out/i.test(String(err?.message ?? err))) throw err
  }
  await ctx.poll(async () => { const keys = demoKeysOf(await ctx.shipAs.admin('GET_DEMO_STATE', {})); return DEMO_NAMED.every((k) => keys.includes(k)) }, 'the demo seed to be whole again after RESET_DEMO_DATA', 180_000)
}

/** Load Review lists a delivered DOCS_NEEDED order only while `readyToInvoiceAt` is empty; an older seed stamped it on delivery. */
async function demoStamped(ctx, state) {
  for (const key of DEMO_NAMED) {
    const rec = state.records?.find((r) => r.kind === 'SHIPMENT' && r.demoKey === key)
    if (!rec) continue
    const orders = (await gql(ctx.token, `query { listOrderByShipmentId(shipmentId: ${JSON.stringify(rec.recordId)}) { items { arStatus readyToInvoiceAt } } }`, {})).listOrderByShipmentId.items
    if (orders.some((o) => o.arStatus === 'DOCS_NEEDED' && o.readyToInvoiceAt)) return true
  }
  return false
}

async function seedDemoRefs(ctx) {
  let state = await ctx.shipAs.admin('GET_DEMO_STATE', {})
  // an interrupted earlier seed leaves records behind and the seed then skips forever: reset it (so does a seed from before the
  // demo stopped stamping readyToInvoiceAt on delivered orders)
  const whole = DEMO_NAMED.every((k) => demoKeysOf(state).includes(k))
  if (!whole || await demoStamped(ctx, state)) {
    if ((state.records ?? []).length) await resetDemo(ctx)
    else await ctx.shipAs.admin('SEED_DEMO_DATA', { staff: await demoStaff(ctx) })
    state = await ctx.shipAs.admin('GET_DEMO_STATE', {})
    if (await demoStamped(ctx, state)) fail('the deployed demo seed still stamps readyToInvoiceAt on delivered DOCS_NEEDED orders (demo.ts stageTrackingStates), so Load Review cannot list them')
  }
  const find = (key) => state.records?.find((r) => r.kind === 'SHIPMENT' && r.demoKey === key)
  const out = {}
  for (const [name, key] of [['readytobill', 'shipment.readytobill'], ['podflagged', 'shipment.podflagged']]) {
    const rec = find(key)
    if (!rec) fail(`the demo seed has no ${key}`)
    const s = await getRow(ctx.token, 'Shipment', rec.recordId, 'id number')
    out[name] = { id: rec.recordId, number: s.number }
  }
  return out
}

const reviewAudits = async (ctx) => (await listAllRows(ctx.token, 'listAuditLogs', 'id entityType entityId action user changes createdAt')).filter((a) => a.createdAt >= ctx.runStart)

async function loadReviewGate(b, ctx, theme) {
  const light = theme === 'light'
  if (!ctx.demo) { if (matches('AA03')) skipLine('AA03-load-review', theme, 'the demo seed could not be read', 'dev demo seed unavailable'); return }
  await step(`AA03-list-${theme}`, async () => {
    await b.navigate('/tms/load-review'); await waitLoaded(b)
    await b.poll(async () => /Looks ready|Needs fixes/i.test(await mainText(b)), 'queue tabs', 30_000)
    const text0 = await mainText(b)
    const tabs = await b.evaluate(`[...document.querySelectorAll('.tms-main [role="tab"]')].map((t) => t.textContent.trim())`)
    for (const wanted of [/Needs fixes/i, /Looks ready/i, /All in review/i, /Released/i]) if (!tabs.some((t) => wanted.test(t))) fail(`no ${wanted} tab (tabs: ${tabs.join(', ')})`)
    if (!/Review · Load review/.test(text0.split('\n').slice(0, 6).join('\n'))) fail('the page title is not "Review · Load review"')
    await clickTab(b, 'Looks ready'); await filterQueue(b, ctx.demo.readytobill.number); await clickTab(b, 'Looks ready')
    if (ctx.demoReleased) { if (await rowText(b, ctx.demo.readytobill.number)) fail('the released demo shipment is still in the queue') } else if (!(await rowText(b, ctx.demo.readytobill.number))) fail(`${ctx.demo.readytobill.number} (shipment.readytobill) is not under Looks ready`)
    await clickTab(b, 'Needs fixes'); await filterQueue(b, ctx.demo.podflagged.number); await clickTab(b, 'Needs fixes')
    if (!(await rowText(b, ctx.demo.podflagged.number))) fail(`${ctx.demo.podflagged.number} (shipment.podflagged) is not under Needs fixes`)
    await walk.shot(b, 'AA03', 'load-review-list', themeTag(theme), true).catch(() => {})
    return 'tabs present; readytobill under Looks ready, podflagged under Needs fixes'
  })
  await step(`AA03-drawer-failing-${theme}`, async () => {
    await b.navigate('/tms/load-review'); await waitLoaded(b); await pause(800)
    await clickTab(b, 'Needs fixes'); await filterQueue(b, ctx.demo.podflagged.number); await clickTab(b, 'Needs fixes')
    await openRowDrawer(b, ctx.demo.podflagged.number)
    const text = await drawerText(b)
    for (const section of [/Sales rep/i, /Rev(enue)? division/i, /Details/i, /Charges/i, /Documents/i]) if (!section.test(text)) fail(`the drawer lacks the ${section} section`)
    if (!/Missing document:?\s*POD/i.test(text)) fail('the drawer does not say "Missing document: POD" for the POD-flagged shipment')
    await walk.shot(b, 'AA03', 'load-review-drawer-failing', themeTag(theme), false).catch(() => {})
    return 'five sections; "Missing document: POD" reason'
  })
  await step(`AA03-drawer-ready-${theme}`, async () => {
    if (ctx.demoReleased) return 'released earlier in this run; the drawer-ready screenshot was taken before'
    await b.navigate('/tms/load-review'); await waitLoaded(b); await pause(800)
    await clickTab(b, 'Looks ready'); await filterQueue(b, ctx.demo.readytobill.number); await clickTab(b, 'Looks ready')
    await openRowDrawer(b, ctx.demo.readytobill.number)
    const text = await drawerText(b)
    if (!/Move to billing/i.test(text)) fail('the ready drawer has no Move to billing action')
    if (/Missing document/i.test(text)) fail('the ready shipment reports a missing document')
    await walk.shot(b, 'AA03', 'load-review-drawer-ready', themeTag(theme), false).catch(() => {})
    return 'Move to billing offered; no failing reason'
  })
  if (!light) return
  await step('AA03-legacy-excluded', async () => {
    const rows = await listAllRows(ctx.token, 'listShipments', 'id number status legacyImported voidedAt')
    const legacy = rows.filter((s) => s.legacyImported === true && !s.voidedAt && ['DELIVERED', 'DOCS_NEEDED'].includes(String(s.status))).slice(0, 25)
    if (!legacy.length) {
      line('SKIPPED', 'AA03-legacy-excluded', '(allowed: no legacyImported delivered shipment on this dev stack; the exclusion is asserted by loadReview.test.ts)')
      return undefined
    }
    await b.navigate('/tms/load-review'); await waitLoaded(b)
    for (const tab of ['Needs fixes', 'Looks ready', 'All in review']) {
      await clickTab(b, tab)
      const text = await mainText(b)
      const leaked = legacy.filter((s) => s.number && text.includes(s.number))
      if (leaked.length) fail(`legacy-imported shipments appear under ${tab}: ${leaked.slice(0, 3).map((s) => s.number).join(', ')}`)
    }
    return `${legacy.length} legacy delivered shipments checked across three tabs; none listed`
  })
}

/** Gate 6(c): as the reviewer persona, Move to billing on the green demo shipment. */
async function loadReviewMove(b, ctx) {
  await backendStep(ctx, 'AA03-move-to-billing', async () => {
    await b.navigate('/tms/load-review'); await waitLoaded(b); await pause(800)
    await clickTab(b, 'Looks ready'); await filterQueue(b, ctx.demo.readytobill.number); await clickTab(b, 'Looks ready')
    await openRowDrawer(b, ctx.demo.readytobill.number)
    await clickByText(b, 'drawer', 'button', 'Move to billing')
    // a confirm step may sit between the click and the call
    await pause(600)
    if (/Confirm|Are you sure/i.test(await drawerText(b)) || (await b.evaluate(`document.querySelectorAll('[role="alertdialog"], [role="dialog"]').length`)) > 1) {
      await clickByText(b, 'drawer', 'button', '^(Confirm|Move to billing|Yes)').catch(() => {})
    }
    ctx.demoReleased = true
    ctx.demoTouched = true
    const sid = ctx.demo.readytobill.id
    const ordersOf = async () => (await listAllRows(ctx.token, 'listOrders', 'id shipmentId arStatus readyToInvoiceAt')).filter((o) => o.shipmentId === sid)
    await ctx.poll(async () => (await ordersOf()).some((o) => o.arStatus === 'UNBILLED' && o.readyToInvoiceAt), 'order UNBILLED with readyToInvoiceAt', 45_000)
    const order = (await ordersOf()).find((o) => o.arStatus === 'UNBILLED')
    const audits = await reviewAudits(ctx)
    const ready = audits.find((a) => a.entityType === 'ORDER' && a.action === 'READY_TO_INVOICE' && a.entityId === order.id)
    if (!ready) fail('no ORDER/READY_TO_INVOICE audit row for the released order')
    const checks = asJson(ready.changes)?.review?.checks
    if (!checks) fail('the READY_TO_INVOICE audit row carries no review.checks')
    const released = audits.find((a) => a.entityType === 'SHIPMENT' && a.action === 'LOAD_REVIEW_RELEASED' && a.entityId === sid)
    if (!released) fail('no SHIPMENT/LOAD_REVIEW_RELEASED audit row')
    if (String(released.user).toLowerCase() !== ctx.emails.lr.toLowerCase() && String(released.user).toLowerCase() !== String(ctx.lrUsername ?? '').toLowerCase()) fail(`LOAD_REVIEW_RELEASED user ${released.user} is not the reviewer`)
    ctx.trackedIds.add(order.id)
    await b.navigate('/tms/load-review'); await waitLoaded(b); await pause(800)
    await clickTab(b, 'Looks ready'); await filterQueue(b, ctx.demo.readytobill.number); await clickTab(b, 'Looks ready')
    if (await rowText(b, ctx.demo.readytobill.number)) fail('the released shipment is still in Looks ready')
    await clickTab(b, 'Released'); await filterQueue(b, ctx.demo.readytobill.number); await clickTab(b, 'Released')
    await b.poll(async () => !!(await rowText(b, ctx.demo.readytobill.number)), 'row under Released', 20_000)
    const row = await rowText(b, ctx.demo.readytobill.number)
    if (!/\bby\b/i.test(row) && !new RegExp(ctx.emails.lr.split('@')[0], 'i').test(row)) fail(`the Released row does not say who released it: ${row}`)
    await walk.shot(b, 'AA03', 'load-review-released', 'L', true).catch(() => {})
    return 'order UNBILLED + readyToInvoiceAt; READY_TO_INVOICE audit with review.checks; LOAD_REVIEW_RELEASED by the reviewer; row moved to Released with "by"'
  })
}

/** Gate 6(d): a shipment with its sales rep cleared is refused by the server inside a batch; the clean row still moves. */
async function loadReviewBatch(ctx) {
  await backendStep(ctx, 'AA03-batch-refusal', async () => {
    // (c) released the green demo shipment: put the seed back so the batch has a clean row again
    await resetDemo(ctx)
    ctx.demoTouched = true
    ctx.demo = await seedDemoRefs(ctx)
    ctx.demoReleased = false
    const z = ctx.zz.noRep
    const result = await ctx.shipAs.lr('BATCH_SHIPMENT_TASK', { task: 'RELEASE_TO_BILLING', shipmentIds: [z.id, ctx.demo.readytobill.id], params: { review: { source: 'LOAD_REVIEW' } } })
    const byId = new Map((result.results ?? []).map((r) => [r.shipmentId, r]))
    const bad = byId.get(z.id)
    const good = byId.get(ctx.demo.readytobill.id)
    if (!bad || bad.ok) fail(`the rep-cleared shipment was not refused: ${JSON.stringify(bad)}`)
    if (!/sales rep|rep/i.test(String(bad.message))) fail(`the refusal does not name the sales rep: ${bad.message}`)
    if (!good?.ok) fail(`the clean row did not move: ${JSON.stringify(good)}`)
    ctx.demoReleased = true
    return `batch of 2: ${z.number} refused ("${String(bad.message).slice(0, 80)}"), ${ctx.demo.readytobill.number} moved`
  })
}

// ───────────────────────────── gate 7: intake review gate ─────────────────────────────
const INTAKE_KEYS = [
  'customerId', 'customerName', 'billToId', 'salesRepId', 'divisionCode', 'reference', 'pickupNumber', 'deliveryNumber',
  'equipmentType', 'commodity', 'weightLb', 'customerRateCents',
  ...[0, 1].flatMap((i) => ['name', 'street', 'city', 'state', 'zip', 'date', 'time', 'instructions'].map((k) => `stops.${i}.${k}`)),
]

/** The fields a reviewer would type, with every key confirmed: a fully populated, high-confidence load. */
function completeFields(ctx, n) {
  const day = chicagoToday()
  return {
    customerId: ctx.customerId, customerName: `ZZ AA Customer ${ctx.ts}`, billToId: ctx.billToId, salesRepId: ctx.repId ?? null,
    divisionCode: ctx.divisionCode, reference: `ZZAA${n}${String(ctx.ts).slice(-6)}`, pickupNumber: `P${n}`, deliveryNumber: `D${n}`,
    equipmentType: 'Dry Van', commodity: 'ZZ AA paper', weightLb: 20000, customerRateCents: 150000,
    stops: [
      { type: 'pickup', name: 'ZZ AA Shipper', street: '1 Main St', city: 'Dallas', state: 'TX', zip: '75201', date: addDays(day, 1), time: '08:00', instructions: 'ZZ AA' },
      { type: 'delivery', name: 'ZZ AA Receiver', street: '2 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30301', date: addDays(day, 3), time: '14:00', instructions: 'ZZ AA' },
    ],
  }
}

async function ingestIntake(ctx) {
  const stamp = ctx.ts
  const fixture = (key, over) => ({ role: 'TENDER', messageId: `zzaa-${key}-${stamp}-${randomUUID()}`, receivedAt: new Date().toISOString(), fromName: 'ZZ AA Sender', ...over })
  const mails = {
    a: fixture('a', { subject: `Tender TMS ID ${String(stamp).slice(-10)}: Dallas, TX to Atlanta, GA`, fromEmail: ctx.senderEmail, bodyText: tenderBody(String(stamp).slice(-10)), toAddresses: [ctx.addressA] }),
    b: fixture('b', { subject: `Tender TMS ID ${String(stamp + 1).slice(-10)}: Dallas, TX to Atlanta, GA`, fromEmail: ctx.senderEmail, bodyText: tenderBody(String(stamp + 1).slice(-10)), toAddresses: [ctx.addressA] }),
    c: fixture('c', { subject: `ZZ AA sparse tender ${stamp}`, fromEmail: `zz-aa-stranger-${stamp}@example.invalid`, bodyText: 'Can you cover a load for us?', toAddresses: [ctx.addressA] }),
  }
  ctx.mail = {}
  for (const [key, f] of Object.entries(mails)) {
    const sent = await deliver(f)
    ctx.mail[key] = sent
    ctx.prefixes.add(sent.prefix)
    ctx.runIds.add(sent.runId)
  }
  const wanted = Object.entries(ctx.mail).map(([k, m]) => [k, `il:${m.runId}`])
  const rows = {}
  await ctx.poll(async () => {
    for (const [k, id] of wanted) rows[k] ??= await getRow(ctx.token, 'IntakeLoad', id, INTAKE_SELECTION)
    return wanted.every(([k]) => rows[k])
  }, 'intake rows for A, B, C', 120_000)
  for (const [, id] of wanted) ctx.intakeIds.add(id)
  ctx.rows = rows
}

async function freshIntake(ctx, key) {
  ctx.rows[key] = await getRow(ctx.token, 'IntakeLoad', ctx.rows[key].id, INTAKE_SELECTION)
  return ctx.rows[key]
}
const versionOf = (row) => Number(row.version ?? 1)

async function completeIntake(ctx, key, n) {
  const row = await freshIntake(ctx, key)
  const saved = await ctx.shipAs.rev('INTAKE_SAVE_DRAFT', { intakeId: row.id, expectedVersion: versionOf(row), fields: completeFields(ctx, n), confirm: { add: INTAKE_KEYS, remove: [] } })
  const after = await freshIntake(ctx, key)
  if ((after.missingFields ?? []).length) fail(`intake ${key} is still missing ${JSON.stringify(after.missingFields)} after a full save (${short(saved)})`)
  return after
}

const refused = async (name, pattern, run) => {
  try { await run() } catch (err) {
    if (pattern.test(String(err?.message ?? err))) return String(err.message).slice(0, 140)
    fail(`${name} refused for the wrong reason: ${short(err)}`)
  }
  fail(`${name} was allowed`)
}

async function intakeServerGate(ctx) {
  await backendStep(ctx, 'AA07-intake-complete-unreviewed', async () => {
    await completeIntake(ctx, 'a', 1)
    const row = await freshIntake(ctx, 'a')
    if (row.reviewedAt || row.reviewedBy) fail('a freshly completed load is already reviewed')
    const why = await refused('move without review', /Not ready to move to active — still needs: review/, () => ctx.shipAs.rev('INTAKE_MOVE_TO_ACTIVE', { intakeId: row.id, expectedVersion: versionOf(row) }))
    return `complete but unreviewed: move refused ("${why}")`
  })
  await backendStep(ctx, 'AA07-intake-edit-clears-review', async () => {
    await completeIntake(ctx, 'b', 2)
    let row = await freshIntake(ctx, 'b')
    await ctx.shipAs.rev('INTAKE_MARK_REVIEWED', { intakeId: row.id, expectedVersion: versionOf(row) })
    row = await freshIntake(ctx, 'b')
    if (!row.reviewedAt || String(row.reviewedBy).toLowerCase() !== ctx.emails.rev.toLowerCase()) fail(`mark reviewed recorded ${row.reviewedBy} / ${row.reviewedAt}`)
    // a no-op save keeps the review
    await ctx.shipAs.rev('INTAKE_SAVE_DRAFT', { intakeId: row.id, expectedVersion: versionOf(row), fields: {}, confirm: { add: [], remove: [] } })
    row = await freshIntake(ctx, 'b')
    if (!row.reviewedAt) fail('a no-op save cleared the review')
    await ctx.shipAs.rev('INTAKE_SAVE_DRAFT', { intakeId: row.id, expectedVersion: versionOf(row), fields: { commodity: 'ZZ AA edited after review' }, confirm: { add: [], remove: [] } })
    row = await freshIntake(ctx, 'b')
    if (row.reviewedAt || row.reviewedBy) fail(`an edit left reviewedAt/reviewedBy set (${row.reviewedBy} / ${row.reviewedAt})`)
    await refused('move after an edit', /Not ready to move to active — still needs: review/, () => ctx.shipAs.rev('INTAKE_MOVE_TO_ACTIVE', { intakeId: row.id, expectedVersion: versionOf(row) }))
    return 'reviewed → no-op save keeps it → edit clears it → move refused again'
  })
  await backendStep(ctx, 'AA07-intake-incomplete-cannot-review', async () => {
    const row = await freshIntake(ctx, 'c')
    const why = await refused('mark reviewed on an incomplete load', /Cannot mark reviewed — still needs/, () => ctx.shipAs.rev('INTAKE_MARK_REVIEWED', { intakeId: row.id, expectedVersion: versionOf(row) }))
    return `incomplete load cannot be reviewed ("${why}")`
  })
  await backendStep(ctx, 'AA07-intake-forbidden', async () => {
    const row = await freshIntake(ctx, 'a')
    await refused('mark reviewed as page-tms only', /Forbidden/, () => ctx.shipAs.tms('INTAKE_MARK_REVIEWED', { intakeId: row.id, expectedVersion: versionOf(row) }))
    return 'INTAKE_MARK_REVIEWED needs the intakeReview grant'
  })
}

/** AA10 in the browser as the reviewer: the gate on screen, the Mark reviewed click, then the real move. */
async function intakeUiGate(b, ctx, theme) {
  const light = theme === 'light'
  await backendStep(ctx, `AA10-intake-gate-ui-${theme}`, async () => {
    const row = await freshIntake(ctx, 'a')
    await b.navigate(`/tms/shipments/intake/${encodeURIComponent(row.id)}`); await waitLoaded(b)
    const text = await mainText(b)
    if (row.reviewedAt) {
      if (!/Reviewed by/i.test(text)) fail('a reviewed load does not say "Reviewed by"')
      await walk.shot(b, 'AA10', 'intake-reviewed', themeTag(theme), true).catch(() => {})
      return 'reviewed state shows "Reviewed by …"'
    }
    if ((await buttonState(b, '^Move to active$')) !== 'disabled') fail('Move to active is enabled on a complete but unreviewed load')
    // the customer, division and settings lists the verdict needs load after the row does: wait for them instead of sampling once
    await b.poll(async () => (await buttonState(b, '^Mark reviewed$')) === 'enabled', 'Mark reviewed to enable', 30_000).catch(async () => {
      const why = (await mainText(b)).split('\n').map((l) => l.trim()).filter((l) => /needs|not active|choose|missing|confirm|valid|add /i.test(l)).slice(0, 6).join(' | ')
      fail(`Mark reviewed is not enabled on a complete load (page says: ${why || 'nothing about why'})`)
    })
    if (!/Needs review/i.test(text)) fail('the page does not say the load "Needs review"')
    await walk.shot(b, 'AA10', 'intake-needs-review', themeTag(theme), true).catch(() => {})
    if (!light) return 'unreviewed: Move disabled, Mark reviewed enabled, "Needs review"'
    await clickByText(b, 'main', 'button', '^Mark reviewed$')
    await b.poll(async () => String((await freshIntake(ctx, 'a')).reviewedBy).toLowerCase() === ctx.emails.rev.toLowerCase(), 'reviewedBy = reviewer', 30_000)
    await b.poll(async () => (await buttonState(b, '^Move to active$')) === 'enabled', 'Move to active enabled after review', 30_000)
    if (!/Reviewed by/i.test(await mainText(b))) fail('after Mark reviewed the page does not say "Reviewed by"')
    await walk.shot(b, 'AA10', 'intake-reviewed', 'L', true).catch(() => {})
    return 'Mark reviewed recorded the reviewer and enabled Move to active'
  })
  if (!light) return
  await backendStep(ctx, 'AA07-intake-move-after-review', async () => {
    const row = await freshIntake(ctx, 'a')
    await ctx.shipAs.rev('INTAKE_MOVE_TO_ACTIVE', { intakeId: row.id, expectedVersion: versionOf(row) })
    const moved = await freshIntake(ctx, 'a')
    if (moved.status !== 'MOVED' || !moved.shipmentId) fail(`intake status ${moved.status} / shipment ${moved.shipmentId}`)
    ctx.shipmentIds.add(moved.shipmentId)
    const s = await getRow(ctx.token, 'Shipment', moved.shipmentId, 'id number intakeReviewedBy')
    if (String(s.intakeReviewedBy).toLowerCase() !== ctx.emails.rev.toLowerCase()) fail(`Shipment.intakeReviewedBy ${s.intakeReviewedBy}, expected the reviewer`)
    if (String(moved.reviewedBy).toLowerCase() !== ctx.emails.rev.toLowerCase()) fail(`the move overwrote IntakeLoad.reviewedBy (${moved.reviewedBy})`)
    return `moved to ${s.number}; Shipment.intakeReviewedBy = reviewer`
  })
}

// ───────────────────────────── cleanup ─────────────────────────────
async function cleanup(ctx) {
  const say = (msg, ok = true) => { console.log(`cleanup: ${msg}`); if (!ok) process.exitCode = 1 }
  const token = ctx.token
  if (token) {
    if (ctx.demoTouched) {
      await resetDemo(ctx).then(() => say('demo seed restored with RESET_DEMO_DATA'), (err) => say(`RESET_DEMO_DATA failed: ${short(err).slice(0, 100)}`, false))
    }
    for (const id of ctx.shipmentIds) {
      try {
        const row = await getRow(token, 'Shipment', id, 'id updatedAt voidedAt')
        if (!row?.voidedAt) await ctx.shipAs.admin('VOID_SHIPMENT', { shipmentId: id, reason: 'step AA verification fixture', expectedUpdatedAt: String(row?.updatedAt ?? '') })
        const after = await getRow(token, 'Shipment', id, 'voidedAt')
        say(`shipment ${id} ${after?.voidedAt ? 'voided and confirmed' : 'NOT confirmed voided'}`, !!after?.voidedAt)
      } catch (err) { say(`shipment ${id} void failed: ${short(err).slice(0, 100)}`, false) }
    }
    for (const runId of ctx.runIds) {
      try {
        const run = await ctx.wf('GET_RUN', { id: runId })
        if (run && !['DISMISSED', 'APPLIED'].includes(String(run.outcome))) await ctx.wf('DISMISS_RUN', { id: runId, reason: 'step AA verification fixture', expectedVersion: Number(run.version ?? 0) })
        say(`workflow run ${runId.slice(0, 18)}… dismissed`)
      } catch (err) { say(`workflow run ${runId.slice(0, 18)}… could not be dismissed: ${short(err).slice(0, 80)}`, false) }
    }
    for (const id of ctx.divisionIds) await ctx.dir('ARCHIVE_OWNERSHIP_DIVISION', { id }).catch(() => {})
    if (ctx.customerId) {
      const row = await getRow(token, 'Customer', ctx.customerId, 'id updatedAt').catch(() => null)
      if (row) await ctx.dir('ARCHIVE_CUSTOMER', { id: ctx.customerId, expectedUpdatedAt: String(row.updatedAt) }).then(() => say(`customer ${ctx.customerId} archived`), (err) => say(`customer archive failed: ${short(err).slice(0, 80)}`, false))
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
  const tracked = new Set([...ctx.intakeIds, ...ctx.divisionIds, ...ctx.shipmentIds, ...ctx.runIds, ...ctx.trackedIds])
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
  if (flag('pay-guard')) { if (!payGuard()) process.exitCode = 1; return }
  if (flag('inventory')) {
    if (flag('markdown')) {
      const commit = git('rev-parse', '--short', 'HEAD').trim()
      console.log(await aaMarkdown(process.cwd(), `${commit} + working tree`))
      return
    }
    if (!(await inventory())) process.exitCode = 1
    return
  }
  if (!DEV_APPSYNC.test(DEV_API)) fail('devVerifyAA refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') fail('devVerifyAA refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) fail(`devVerifyAA only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  if (!(await inventory())) { process.exitCode = 1; return }
  if (!payGuard()) process.exitCode = 1

  await mkdir(SHOTS, { recursive: true })
  const ts = Date.now()
  const emails = {
    admin: `zz-aa-admin-${ts}@example.invalid`, lr: `zz-aa-lr-${ts}@example.invalid`, comp: `zz-aa-comp-${ts}@example.invalid`,
    tms: `zz-aa-tms-${ts}@example.invalid`, rev: `zz-aa-rev-${ts}@example.invalid`,
  }
  const made = []
  const ctx = {
    ts, origin, emails, runStart: new Date().toISOString(), suffix: null, backend: false,
    trackedEmails: new Set(Object.values(emails)), senderEmail: `zz-aa-sender-${ts}@example.invalid`, addressA: `zz-aa-tenders-${ts}@example.invalid`,
    divisionIds: new Set(), intakeIds: new Set(), shipmentIds: new Set(), runIds: new Set(), prefixes: new Set(), trackedIds: new Set(),
    customerId: null, billToId: `zz-aa-bt-${ts}`, divisionCode: null, ids: {}, zz: {}, demo: null, rows: {},
    poll: async (fn, label, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await pause(3000) } fail(`timed out: ${label}`) },
  }
  ctx.trackedEmails.add(ctx.senderEmail).add(ctx.addressA)

  try {
    try { ctx.suffix = await discoverDevSuffix(); console.log('dev table suffix discovered (ok)') } catch (err) { console.log(`dev DynamoDB unavailable: ${short(err).slice(0, 160)}`) }

    // mint before calling: groups come from the token
    ctx.ids.admin = await mintIdentity(emails.admin, ['ADMIN', 'page-tms']); made.push(emails.admin)
    ctx.ids.lr = await mintIdentity(emails.lr, [...AA_PERSONAS.loadReview.groups]); made.push(emails.lr)
    ctx.ids.comp = await mintIdentity(emails.comp, [...AA_PERSONAS.compliance.groups]); made.push(emails.comp)
    ctx.ids.tms = await mintIdentity(emails.tms, [...AA_PERSONAS.tms.groups]); made.push(emails.tms)
    ctx.ids.rev = await mintIdentity(emails.rev, ['page-intakeReview', 'page-tms']); made.push(emails.rev)
    console.log('identity: temporary staff identities created (admin, load-review, compliance, page-tms, intake reviewer)')
    ctx.token = ctx.ids.admin.token
    ctx.dir = routerAs(ctx.token, 'tmsDirectoryActions')
    ctx.wf = routerAs(ctx.token, 'tmsWorkflowActions')
    ctx.shipAs = Object.fromEntries(Object.entries(ctx.ids).map(([k, v]) => [k, routerAs(v.token, 'tmsShipmentActions')]))
    ctx.adminUsername = Object.entries(ctx.ids.admin.storage).find(([k]) => k.endsWith('.LastAuthUser'))?.[1]
    ctx.lrUsername = Object.entries(ctx.ids.lr.storage).find(([k]) => k.endsWith('.LastAuthUser'))?.[1]
    ctx.trackedEmails.add(String(ctx.adminUsername ?? '').toLowerCase()).add(String(ctx.lrUsername ?? '').toLowerCase())

    try { await gql(ctx.token, 'query { listIntakeLoads(limit: 1) { items { id } } }', {}); ctx.backend = true } catch { ctx.backend = false }
    console.log(`backend: Step U intake ${ctx.backend ? 'deployed' : 'NOT deployed — backend steps will be SKIPPED (allowed)'}`)
    if (ctx.backend) await resolveIntakeSecret().catch((err) => line('FAIL', 'setup: intake secret', short(err)))
    // the review actions only exist once Step AA is deployed: probe with the read-only one
    ctx.reviewDeployed = false
    try { await ctx.shipAs.admin('REVIEW_LOAD', { shipmentId: 'zz-aa-probe' }) } catch (err) { ctx.reviewDeployed = !/unknown action|unsupported action|not supported|invalid action|unrecognized/i.test(String(err?.message ?? err)) }
    console.log(`backend: Step AA review actions ${ctx.reviewDeployed ? 'deployed' : 'NOT deployed — Load Review server steps will be SKIPPED (allowed)'}`)

    // fixtures
    await step('setup-fixtures', async () => {
      // The throwaway admin has no UserProfile, and a sales rep must be one: use a real, active staff profile (read only; nothing is written to it).
      const profiles = (await gql(ctx.token, 'query { listUserProfiles(limit: 1000) { items { id status } } }', {})).listUserProfiles.items
      ctx.repId = (profiles.find((p) => p.status === 'ACTIVE') ?? profiles[0])?.id ?? null
      if (!ctx.repId) fail('no UserProfile exists in dev to act as the sales rep')
      const division = await ctx.dir('SAVE_OWNERSHIP_DIVISION', { parentId: null, active: true, brand: null, sortOrder: 900, code: `ZZ_AA_${ts}`, name: `ZZ AA ${ts}`, intakeEmail: ctx.addressA })
      ctx.divisionCode = `ZZ_AA_${ts}`
      ctx.divisionIds.add(String(division.id ?? ctx.divisionCode))
      const customer = await ctx.dir('UPSERT_CUSTOMER', {
        name: `ZZ AA Customer ${ts}`, creditLimitCents: 100_000_000, defaultSalesRepId: ctx.repId ?? null,
        contacts: [{ id: `cnt-${randomUUID()}`, name: 'ZZ AA Sender', email: ctx.senderEmail, types: [] }],
        billToParties: [{ id: ctx.billToId, name: 'ZZ AA Bill To', isDefault: true }],
      })
      ctx.customerId = String((customer.customer ?? customer).id)
      ctx.zz.noDocs = await buildDelivered(ctx, 'ND', { docs: false, rep: true })
      ctx.zz.noRep = await buildDelivered(ctx, 'NR', { docs: true, rep: false })
      return `division ${ctx.divisionCode}, customer, ${ctx.zz.noDocs.number} (no documents), ${ctx.zz.noRep.number} (rep cleared)`
    })
    if (ctx.backend && ctx.divisionCode) await step('setup-intake-ingest', async () => { await ingestIntake(ctx); return 'three tenders staged (A complete-able, B complete-able, C sparse)' })
    if (ctx.reviewDeployed) {
      await step('setup-demo-seed', async () => { ctx.demoTouched = true; ctx.demo = await seedDemoRefs(ctx); return `${ctx.demo.readytobill.number} (readytobill), ${ctx.demo.podflagged.number} (podflagged)` })
    }
    ctx.lr = { seeded: !!ctx.demo }

    // gate 7 (server): runs before the browser pass so the screenshots see the right states
    if (ctx.rows.a) await intakeServerGate(ctx)

    const themes = flag('no-dark') ? ['light'] : ['light', 'dark']
    const b = await launchBrowser({ origin, storage: ctx.ids.admin.storage, profilePrefix: 'bcat-aa-', purpose: 'AA verification', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 } })
    b.ctx = ctx
    try {
      await b.navigate('/tms/dashboard'); await waitLoaded(b).catch(() => {}); await waitShell(b)
      const refs = {}
      for (const theme of themes) { await setTheme(b, theme); refs[theme] = await b.evaluate(SHELL_FACTS) }
      await setTheme(b, 'light')

      await oldUrlsGate(b)
      for (const theme of themes) {
        await b.navigate('/tms/dashboard'); await waitLoaded(b).catch(() => {})
        await setTheme(b, theme).catch(() => {})
        await sidebarGate(b, ctx, theme)
        for (const route of AA_ROUTES) {
          if (theme === 'dark' && !route.dark) continue
          await auditRoute(b, route, theme, refs[theme])
        }
        await pageFacts(b, ctx, theme)
        if (ctx.reviewDeployed) await loadReviewGate(b, ctx, theme)
        else if (matches('AA03')) skipLine('AA03-load-review', theme, 'Step AA review backend not deployed', BACKEND_ALLOWED)
      }
      await b.navigate('/tms/dashboard'); await waitLoaded(b).catch(() => {})
      await setTheme(b, 'light').catch(() => {})
      await phonePass(b, ctx)
    } finally { await b.close() }

    // personas (gate 5), then the reviewer-owned flows: Load Review move + batch (6), intake UI (7)
    for (const theme of themes) await personaGate(ctx, theme)
    if (ctx.reviewDeployed && ctx.demo) {
      await openInIdentity(ctx, ctx.ids.lr.storage, 'bcat-aa-lr-', 'light', (lb) => loadReviewMove(lb, ctx)).catch((err) => line('FAIL', 'AA03-reviewer-move', short(err)))
      await loadReviewBatch(ctx)
    }
    if (ctx.rows.a) {
      for (const theme of [...themes].reverse()) {
        await openInIdentity(ctx, ctx.ids.rev.storage, 'bcat-aa-rev-', theme, (rb) => intakeUiGate(rb, ctx, theme)).catch((err) => line('FAIL', `AA10-reviewer-${theme}`, short(err)))
      }
    }
  } finally {
    await cleanup(ctx).catch((err) => { console.log(`cleanup: failed (${short(err).slice(0, 120)})`); process.exitCode = 1 })
    for (const email of Object.values(emails).filter((e) => made.includes(e)).reverse()) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary staff identity ${email.replace(/-\d+@/, '-…@')} ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }

  const pass = report.filter((r) => r.status === 'PASS').length
  const failed = report.filter((r) => r.status === 'FAIL').length
  const skipped = report.filter((r) => r.status === 'SKIPPED')
  const unallowed = skipped.filter((r) => !/\(allowed:/.test(r.detail ?? ''))
  console.log(`\nsummary: ${JSON.stringify({ pass, fail: failed, skipped: skipped.length, skippedNotAllowed: unallowed.length })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (failed > 0 || unallowed.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAA failed: ${err?.message ?? err}`); process.exit(1) })
}
