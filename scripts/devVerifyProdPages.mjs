#!/usr/bin/env node
/**
 * Production-page smoke harness: opens EVERY rendered staff page route in src/App.tsx as a temporary ADMIN and asserts
 *
 *   1. no uncaught exception on the page
 *   2. no error-boundary screen ("Something went wrong", "Calendar failed to load", "Application error")
 *   3. the page heading renders (an <h1>/<h2>/[role=heading] with text inside the shell content). Routes with a URL
 *      parameter are opened with a placeholder id (`zz-none`), so they only assert 1, 2 and 4.
 *   4. no horizontal scroll at 1440 px
 *
 *   node scripts/devVerifyProdPages.mjs --inventory      no network, no browser: print the route table parsed from App.tsx
 *   node scripts/devVerifyProdPages.mjs [--only=<substring>] [--shots]
 *   BCAT_STACK=rehearsal DEV_VERIFY_UI_URL=... node scripts/devVerifyProdPages.mjs
 *
 * Stack: BCAT_STACK (dev default | rehearsal) through scripts/lib/stackConfig.mjs; production is never a value and the
 * browser only opens the selected stack's origin or localhost. Temp identity zz-prodpages-*@example.invalid is created
 * in the selected staff pool and deleted (and re-read) in `finally`. Nothing else is written; passwords/tokens are never
 * printed. Screenshots (--shots) go to Docs/tms-build/screenshots/ProdPages/.
 *
 * Redirect routes (<Navigate>, ParamRedirect, LoadRedirect, SavedViewRedirect), the public pages and the driver PWA
 * are outside this harness (devVerifyS3 covers them).
 */
import { readFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REDIRECT_ELEMENT = /<(Navigate|ParamRedirect|LoadRedirect|SavedViewRedirect)\b/
/** Pages that scroll their own pane at 1440 by design (calendar/dispatch grids). Heading and exception checks still apply. */
const WIDE_OK = new Set(['/calendar', '/dispatch', '/appts', '/trucks'])
const BOUNDARY = /something went wrong|calendar failed to load|application error|unexpected application error/i
const WIDTH = 1440

/** `/tms/...` route paths in App.tsx are relative to the `<Route path="/tms">` parent. */
export function parseRoutes(appSource) {
  const tmsStart = appSource.indexOf('<Route path="/tms"')
  if (tmsStart < 0) throw new Error('src/App.tsx has no <Route path="/tms"> block')
  const tmsEnd = appSource.indexOf('</Route>', tmsStart)
  if (tmsEnd < 0) throw new Error('src/App.tsx: <Route path="/tms"> is not closed')
  const publicEnd = appSource.indexOf('<Route path="/*"')
  if (publicEnd < 0) throw new Error('src/App.tsx has no <Route path="/*"> staff block')
  const rows = []
  const re = /<Route\s+path="([^"]+)"\s+element=\{([\s\S]*?)\}\s*\/>/g
  for (const m of appSource.matchAll(re)) {
    const at = m.index
    if (at < publicEnd) continue // public pages + /driver/*: not staff-shell pages
    const inTms = at > tmsStart && at < tmsEnd
    const raw = m[1]
    const element = m[2]
    if (REDIRECT_ELEMENT.test(element)) continue
    if (raw === '/*' || raw === '/driver/*') continue
    const absolute = inTms ? `/tms/${raw}` : raw
    const path = absolute.replace(/\/\*$/, '').replace(/:\w+/g, 'zz-none')
    rows.push({ pattern: absolute, path, param: /:\w+/.test(absolute), tms: inTms })
  }
  // RETIRED_ROUTES.map(...) rows are ParamRedirects by construction and are not matched by `path="` literals.
  const seen = new Set()
  return rows.filter((r) => (seen.has(r.path) ? false : seen.add(r.path)))
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

async function inventory() {
  const routes = parseRoutes(await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8'))
  if (routes.length === 0) throw new Error('inventory: parsed zero routes from src/App.tsx')
  for (const r of routes) console.log(`${r.pattern.padEnd(46)} -> ${r.path}${r.param ? '  (param: heading not asserted)' : ''}`)
  console.log(`\ninventory: ${routes.length} production page routes`)
  return routes
}

const HEADING_PROBE = `(() => {
  const root = document.querySelector('.tms-main') ?? document.body
  const heads = [...root.querySelectorAll('h1, h2, [role="heading"]')].filter((e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && e.textContent.trim().length > 0
  })
  return {
    heading: heads[0]?.textContent.trim().slice(0, 80) ?? null,
    boundary: document.body.innerText.match(${BOUNDARY}) ? document.body.innerText.match(${BOUNDARY})[0] : null,
    docW: document.documentElement.scrollWidth,
    winW: document.documentElement.clientWidth,
    mainW: (document.querySelector('.tms-main')?.scrollWidth ?? 0) - (document.querySelector('.tms-main')?.clientWidth ?? 0),
    shell: !!document.querySelector('.tms-sidebar'),
    signIn: !!document.querySelector('input[type="password"]'),
  }
})()`

async function main() {
  const routes = await inventory()
  if (flag('inventory')) return

  const [{ launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause }, { mintIdentity, deleteIdentity }, { STACK }] = await Promise.all([
    import('./lib/cdpBrowser.mjs'), import('./lib/devIdentity.mjs'), import('./lib/stackConfig.mjs'),
  ])
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyProdPages only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)
  const shots = resolve('Docs/tms-build/screenshots/ProdPages')
  if (flag('shots')) await mkdir(shots, { recursive: true })

  const email = `zz-prodpages-${Date.now()}@example.invalid`
  const results = []
  let made = false
  try {
    const identity = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    console.log(`stack: ${STACK.name}; identity: temporary admin created`)
    const b = await launchBrowser({ origin, storage: identity.storage, profilePrefix: 'bcat-prodpages-', purpose: 'production page smoke', viewport: { width: WIDTH, height: 900, deviceScaleFactor: 1 } })
    try {
      for (const r of routes) {
        if (only && !r.path.includes(only)) continue
        const fails = []
        await b.navigate(r.path)
        try {
          await b.poll(() => b.evaluate(`(() => { const m = document.querySelector('.tms-main'); return !!m && m.innerText.trim().length > 0 && !/(^|\\s)Loading(…|\\.\\.\\.)?(\\s|$)/.test(m.innerText) })()`), 'shell content', 30_000)
        } catch (e) { fails.push(e.message) }
        b.mark()
        await pause(700)
        const p = b.problems()
        if (p.exceptions.length) fails.push(`uncaught exception: ${p.exceptions[0]}`)
        const f = await b.evaluate(HEADING_PROBE)
        if (f.signIn) fails.push('redirected to sign-in (identity not accepted)')
        if (!f.shell) fails.push('TMS shell (.tms-sidebar) missing')
        if (f.boundary) fails.push(`error boundary: "${f.boundary}"`)
        if (!r.param && !f.heading) fails.push('no page heading rendered')
        const wide = WIDE_OK.has(r.path)
        if (!wide && (f.docW > f.winW + 2 || f.mainW > 2)) fails.push(`horizontal scroll at ${WIDTH}: document ${f.docW}>${f.winW}, main +${f.mainW}`)
        if (flag('shots')) await b.screenshot(join(shots, `${r.path.replace(/\W+/g, '_') || 'root'}.png`), { clipToContent: true }).catch(() => {})
        results.push({ path: r.path, ok: fails.length === 0 })
        console.log(`${fails.length ? 'FAIL   ' : 'PASS   '}${r.path}${f.heading ? ` — "${f.heading}"` : ''}${fails.length ? ` | ${fails.slice(0, 3).join(' | ')}` : ''}`)
      }
    } finally { await b.close() }
  } finally {
    if (made) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary staff identity ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }
  const fail = results.filter((r) => !r.ok).length
  console.log(`\nsummary: ${JSON.stringify({ pass: results.length - fail, fail, routes: routes.length })}`)
  if (fail > 0 || results.length === 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyProdPages failed: ${err?.message ?? err}`); process.exit(1) })
}
