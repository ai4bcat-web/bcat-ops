/**
 * Merge-surface guard (MERGE_REGRESSION T3): what production (origin/main) exposes to staff and
 * to its own Lambdas must still exist in the merged tree. The expectation is a checked-in
 * snapshot taken once from `git show origin/main:...` by scripts/snapshotMergeSurface.mjs, so
 * this test reads no git and runs offline. A merge that silently drops a production page, its
 * grant, its apiClient call or the table env var its Lambda reads fails here, by name.
 *
 * Only DELIBERATE removals are listed below, each with the reason. Anything else is a bug.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAV_ITEMS, PERMISSION_PAGES } from './navItems'
import { buildNavSections } from './navSections'
import snapshot from './mergeSurface.snapshot.json'

const root = join(__dirname, '..', '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')

interface NavRow { to: string; label: string; pageKey: string }
const mainNav = snapshot.navItems as NavRow[]

/** The production pages whose behaviour the merge must not change, by their main nav row / route. */
const PRODUCTION_PAGES: Array<{ page: string; to: string; pageKey?: string; route: string }> = [
  { page: 'Dispatch', to: '/dispatch', pageKey: 'dispatch', route: '/dispatch' },
  { page: 'Calendar', to: '/calendar', pageKey: 'calendar', route: '/calendar' },
  { page: 'Driver info', to: '/driver-info', pageKey: 'dispatch', route: '/driver-info' },
  { page: 'Hours', to: '/hours', pageKey: 'hours', route: '/hours' },
  { page: 'Time off', to: '/time-off', pageKey: 'timeOff', route: '/time-off' },
  { page: 'Files', to: '/files', pageKey: 'files', route: '/files' },
  { page: 'Fleet', to: '/trucks', pageKey: 'trucks', route: '/trucks' },
  { page: 'Fuel', to: '/fuel', pageKey: 'fuel', route: '/fuel' },
  { page: 'Maintenance', to: '/maintenance', pageKey: 'maintenance', route: '/maintenance' },
  { page: 'Insurance', to: '/insurance', pageKey: 'insurance', route: '/insurance' },
  { page: 'Appts', to: '/appts', pageKey: 'appts', route: '/appts' },
  { page: 'Reddit queue', to: '/reddit-queue', pageKey: 'redditQueue', route: '/reddit-queue' },
  { page: 'Finances', to: '/finances', pageKey: 'finances', route: '/finances' },
  // Reached by in-page links: a grant (Tasks) or no grant at all (Feedback), and no nav row.
  { page: 'Tasks', to: '', pageKey: 'tasks', route: '/tasks' },
  { page: 'Feedback', to: '', route: '/feedback' },
  // Main redirected /compliance to /files; dev serves the overview there. The route must still answer.
  { page: 'Compliance', to: '', route: '/compliance' },
]

/**
 * Main nav rows that are intentionally not a rail row on dev. Each one is a Step AA/AV re-home:
 * the page key survives (asserted below) and the old path redirects to its new home.
 */
const REHOMED_NAV_PATHS = new Set([
  '/loads', '/grid', // Step AV: the Load grid is retired; /loads -> /tms/shipments
  '/factoring', '/vendor-ap', // moved under /tms (pinned block); old paths redirect
  '/customers', '/locations', '/settings', '/audit-log', // Step AA: pinned block / Settings group under /tms/brokerage
])

describe('the snapshot itself', () => {
  it('was taken from production main and is not empty', () => {
    expect(snapshot.ref).toBe('origin/main')
    expect(mainNav.length).toBeGreaterThan(30)
    expect(Object.keys(snapshot.apiClientUse).length).toBeGreaterThan(100)
    expect(Object.keys(snapshot.backendEnv).length).toBeGreaterThan(30)
  })
})

describe('page grants and nav rows', () => {
  const merged = new Map<string, NavRow>(NAV_ITEMS.map((i) => [i.to, { to: i.to, label: i.label, pageKey: i.pageKey }]))
  const grantKeys = new Set(PERMISSION_PAGES.map((p) => p.key))

  it.each(PRODUCTION_PAGES.filter((p) => p.pageKey))('$page still has its page grant ($pageKey)', ({ pageKey }) => {
    expect(grantKeys.has(pageKey!)).toBe(true)
  })

  it.each(PRODUCTION_PAGES.filter((p) => p.to))('$page still has its nav row at $to under the same grant', ({ to, pageKey }) => {
    expect(merged.get(to)?.pageKey).toBe(pageKey)
  })

  it('keeps every page key main could grant (nav rows and off-nav grants)', () => {
    const wanted = new Set([...mainNav.map((i) => i.pageKey), ...snapshot.offNavKeys])
    const lost = [...wanted].filter((k) => !grantKeys.has(k))
    expect(lost).toEqual([])
  })

  it("keeps every main nav row's path, except the documented re-homes, each with its grant intact", () => {
    const lost = mainNav.filter((i) => !merged.has(i.to) && !REHOMED_NAV_PATHS.has(i.to)).map((i) => i.to)
    expect(lost).toEqual([])
    for (const i of mainNav.filter((r) => REHOMED_NAV_PATHS.has(r.to))) expect(grantKeys.has(i.pageKey)).toBe(true)
  })

  it('shows each guarded production page in the owner\'s sidebar', () => {
    const { pinned, sections } = buildNavSections({ divisions: null, hasPageAccess: () => false, isOwner: true })
    const shown = new Set<string>()
    const walk = (items: Array<{ to?: string; children?: Array<{ to?: string }>; childGroups?: Array<{ children: Array<{ to?: string }> }> }> | undefined) => {
      for (const it of items ?? []) {
        if (it.to) shown.add(it.to)
        walk(it.children)
        for (const g of it.childGroups ?? []) walk(g.children)
      }
    }
    walk(pinned)
    for (const s of sections) walk(s.items)
    const missing = PRODUCTION_PAGES.filter((p) => p.to).filter((p) => !shown.has(p.to)).map((p) => p.to)
    expect(missing).toEqual([])
  })
})

describe('routes', () => {
  const app = read('src/App.tsx')
  it.each(PRODUCTION_PAGES)('$page is still routed at $route', ({ route }) => {
    expect(app).toContain(`path="${route}"`)
    expect(snapshot.routes).toContain(route)
  })
})

describe('apiClient', () => {
  const api = read('src/lib/apiClient.ts')
  const exported = new Set<string>()
  for (const m of api.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class|enum)\s+(\w+)/gm)) exported.add(m[1])

  it('still exports every function production code imported from it', () => {
    const lost = Object.entries(snapshot.apiClientUse as Record<string, string[]>)
      .filter(([name]) => !exported.has(name))
      .map(([name, files]) => `${name} (used by ${files.slice(0, 3).join(', ')})`)
    expect(lost).toEqual([])
  })
})

/**
 * Env wiring that changed on purpose. `directoryActionsFn`: it derives `<Model>-<suffix>` table
 * names from DATA_TABLE_SUFFIX instead of one env var per table (deploy 158), so that one var must stay.
 * (`vendorApExtractFn` is wired again, behind the stage gate, until the stage that creates WorkflowRun.)
 */
const REPLACED_WIRING: Record<string, string> = { directoryActionsFn: 'DATA_TABLE_SUFFIX' }

describe('backend.ts env wiring', () => {
  const backend = read('amplify/backend.ts')
  const wired = new Set<string>()
  for (const m of backend.matchAll(/([\w.]+)(?:\s+as\s+\w+\))?\.addEnvironment\(\s*['"]([A-Z0-9_]+)['"]/g)) {
    wired.add(`${m[1].replace(/^backend\./, '').replace(/\.resources\.lambda$/, '')}:${m[2]}`)
  }
  const wantedPairs = Object.entries(snapshot.backendEnv as Record<string, string[]>).flatMap(([lambda, names]) => names.map((n) => `${lambda}:${n}`))

  it('still gives each production Lambda the env vars main wired for it', () => {
    expect(wantedPairs.length).toBeGreaterThan(100)
    const lost = wantedPairs.filter((p) => {
      const lambda = p.split(':')[0]
      return !wired.has(p) && !(lambda in REPLACED_WIRING)
    })
    expect(lost).toEqual([])
  })

  it.each(Object.entries(REPLACED_WIRING))('%s keeps the replacement env var %s', (lambda, name) => {
    expect(wired.has(`${lambda}:${name}`)).toBe(true)
  })
})
