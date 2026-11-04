/**
 * Step U route registry for devVerifyU (no network, no browser).
 *
 *  - U_ROUTES     rendered `/tms` pages the walk audits (shot number `nn`, same shape as s4Routes).
 *  - U_KEPT       pages the removal sweep must prove still render (the KEEP set of U-plan §1.1/§2).
 *  - U_REDIRECTS  [App.tsx pattern, concrete path, expected landing pathname].
 *  - U_GONE       removed pages: each lands on its target and renders none of its old markers.
 *  - uNavGaps()   gate 1: every nav target U added is routed and has a U_ROUTES row.
 *  - uGoneGaps()  gate 3: App.tsx (and BrokeragePage) really dropped the removed pages.
 *  - uViewHookGaps() gate 4: nothing under src/ still imports useShipmentViews.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const U_ROUTES = [
  { nn: 'U01', slug: 'shipments-active', path: '/tms/shipments', pattern: '/tms/shipments', tms: true },
  { nn: 'U02', slug: 'shipments-all', path: '/tms/shipments?list=all', pattern: '/tms/shipments', tms: true },
  { nn: 'U07', slug: 'intake', path: '/tms/shipments/intake', pattern: '/tms/shipments/intake', tms: true, phone: true },
]

/** Kept pages (no U shot): each must still render content under the shell. */
export const U_KEPT = [
  { slug: 'workflows', path: '/tms/workflows' },
  { slug: 'tracking', path: '/tms/tracking' },
  { slug: 'tracking-links', path: '/tms/tracking/links' },
]

export const U_REDIRECTS = [
  ['/tms/shipments/view/*', '/tms/shipments/view/zz-x', '/tms/shipments'],
  ['/tms/shipments/view/*', '/tms/shipments/view/all-shipments', '/tms/shipments'],
  ['/tms/dispatch', '/tms/dispatch', '/tms/carrier-sales'],
  ['/tms/documents/*', '/tms/documents', '/tms/tracking'],
  ['/tms/documents/*', '/tms/documents/view/zz-x', '/tms/tracking'],
  ['/tms/academy/*', '/tms/academy', '/tms/dashboard'],
  ['/tms/academy/*', '/tms/academy/zz-x', '/tms/dashboard'],
]

/**
 * Removed pages. `routePath` is the `<Route path>` inside the /tms block; `component` the page that must no
 * longer be imported by App.tsx (null when the route now only redirects). `markers` are strings the old page
 * rendered and the landing page must not. `target: null` = the Brokerage default (no fixed landing path).
 */
export const U_GONE = [
  { path: '/tms/shipments/view/zz-x', routePath: 'shipments/view/*', component: null, target: '/tms/shipments', markers: ['Save as view'] },
  { path: '/tms/dispatch', routePath: 'dispatch', component: 'DispatchWorkstation', target: '/tms/carrier-sales', markers: ['Covering now', 'No freight needs coverage'] },
  { path: '/tms/documents', routePath: 'documents/*', component: 'DocumentsWorkstation', target: '/tms/tracking', markers: ['Documents on this shipment'] },
  { path: '/tms/documents/view/zz-x', routePath: 'documents/*', component: 'DocumentsWorkstation', target: '/tms/tracking', markers: ['Documents on this shipment'] },
  { path: '/tms/academy', routePath: 'academy/*', component: 'AcademyPage', target: '/tms/dashboard', markers: ['Ask the Academy'] },
  { path: '/tms/academy/zz-x', routePath: 'academy/*', component: 'AcademyPage', target: '/tms/dashboard', markers: ['Ask the Academy'] },
  { path: '/tms/brokerage/views', routePath: null, component: 'ShipmentViewsPage', target: null, markers: ['Shipment views'] },
]

/**
 * Sidebar words that must no longer appear (whole words). `Dispatch` is deliberately absent: the fleet-messaging page
 * (/dispatch, ASSETS group, src/lib/navItems.ts) is a different product from the removed /tms/dispatch board and stays;
 * the board's absence is asserted by SIDEBAR_BANNED_HREFS instead.
 */
export const SIDEBAR_BANNED = ['Academy', 'Workflows', 'My queue', 'Team queue', 'Views']

/** Sidebar link targets (exact paths) that must no longer exist. */
export const SIDEBAR_BANNED_HREFS = ['/tms/dispatch', '/tms/academy', '/tms/brokerage/views']

/** Nav targets U added to src/lib/navSections.ts. */
export const U_NAV_TARGETS = ['/tms/shipments/intake']

const routePaths = (app) => {
  const found = new Map()
  for (const m of app.matchAll(/<Route\s+(?:[^>]*?\s)?path="([^"]+)"([^\n]*)/g)) found.set(m[1], m[2])
  return found
}

/** Gate 1. Returns human-readable gaps (empty = pass). */
export async function uNavGaps(root = process.cwd()) {
  const [nav, app] = await Promise.all([
    readFile(join(root, 'src/lib/navSections.ts'), 'utf8'),
    readFile(join(root, 'src/App.tsx'), 'utf8'),
  ])
  const routes = routePaths(app)
  const walked = new Set(U_ROUTES.map((r) => r.path))
  const gaps = []
  for (const to of U_NAV_TARGETS) {
    if (!nav.includes(`to: '${to}'`)) gaps.push(`${to}: no nav entry in src/lib/navSections.ts`)
    const segment = to.replace(/^\/tms\//, '')
    if (!routes.has(segment)) gaps.push(`${to}: App.tsx has no <Route path="${segment}">`)
    if (!walked.has(to)) gaps.push(`${to}: no U_ROUTES row`)
  }
  if (!routes.has('shipments/intake/:intakeId')) gaps.push('App.tsx has no <Route path="shipments/intake/:intakeId">')
  for (const [pattern] of U_REDIRECTS) {
    const segment = pattern.replace(/^\/tms\//, '')
    if (!routes.has(segment)) gaps.push(`${pattern}: redirect has no <Route path="${segment}"> in src/App.tsx`)
  }
  return gaps
}

/** Gate 3: greps the source, so a half-removal cannot pass. */
export async function uGoneGaps(root = process.cwd()) {
  const [app, brokerage] = await Promise.all([
    readFile(join(root, 'src/App.tsx'), 'utf8'),
    readFile(join(root, 'src/features/tms/brokerage/BrokeragePage.tsx'), 'utf8'),
  ])
  const routes = routePaths(app)
  const gaps = []
  for (const gone of U_GONE) {
    if (gone.component) {
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${gone.component}\\b[^}]*\\}`).test(app) || new RegExp(`import\\s+${gone.component}\\b`).test(app)
      if (imported && gone.routePath) gaps.push(`${gone.path}: App.tsx still imports ${gone.component}`)
      if (!gone.routePath && new RegExp(`\\b${gone.component}\\b`).test(brokerage)) gaps.push(`${gone.path}: BrokeragePage still references ${gone.component}`)
    }
    if (gone.routePath) {
      const rest = routes.get(gone.routePath)
      if (rest === undefined) continue // no route at all = also gone (the catch-all lands it)
      if (!/Navigate|Redirect/.test(rest)) gaps.push(`${gone.path}: <Route path="${gone.routePath}"> is not a redirect`)
    }
  }
  if (/path="views"/.test(brokerage)) gaps.push('/tms/brokerage/views: BrokeragePage still has a views route')
  return gaps
}

async function walkSrc(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkSrc(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Gate 4: files under src/ that still import `useShipmentViews`. */
export async function uViewHookGaps(root = process.cwd()) {
  const hits = []
  for (const file of await walkSrc(join(root, 'src'))) {
    const source = await readFile(file, 'utf8')
    if (/import[^;]*from\s*['"][^'"]*useShipmentViews['"]/.test(source)) hits.push(file.replace(`${root}/`, ''))
  }
  return hits.map((f) => `${f}: still imports useShipmentViews`)
}
