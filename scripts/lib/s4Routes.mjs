/**
 * S4 route registry for the dev verification scripts (no network, no browser).
 *
 *  - S4_ROUTES    rendered pages the S4 walk visits (same shape as devVerifyS3 ROUTES; `tms: true` = lives
 *                 under /tms and is therefore outside S3's non-/tms completeness gate).
 *  - S4_PATTERNS  normalised App.tsx patterns S3's completeness gate must accept as covered.
 *  - S4_REDIRECTS [App.tsx pattern, concrete path, expected landing pathname] rows now owned by S4.
 *  - s4NavGaps()  completeness gate 2: every nav item S4 added has a <Route> in App.tsx and an S4_ROUTES row.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Rendered S4 pages. wideOk: fill-mode / wide pages (own scroller). */
export const S4_ROUTES = [
  { nn: 'S01', slug: 'compliance', path: '/compliance', pattern: '/compliance', phone: true },
  { nn: 'S02', slug: 'users', path: '/tms/brokerage/users', pattern: '/tms/brokerage/users', tms: true },
  { nn: 'S03', slug: 'financial-operations', path: '/financial-operations', pattern: '/financial-operations' },
  { nn: 'S04', slug: 'expenses', path: '/expenses', pattern: '/expenses', phone: true },
  { nn: 'S05', slug: 'platform-health', path: '/platform-health', pattern: '/platform-health' },
  { nn: 'S06', slug: 'feedback', path: '/feedback', pattern: '/feedback' },
]

/** Patterns for S3's completeness gate (outside /tms), normalised the way S3's `normalise` does. */
export const S4_PATTERNS = S4_ROUTES.filter((r) => !r.tms).map((r) => r.pattern)

/** Redirect rows that moved from S3 to S4: `/compliance/review` now lands on the new page's review tab. */
export const S4_REDIRECTS = [['/compliance/review', '/compliance/review', '/compliance']]

/** Nav targets S4 added to src/lib/navItems.ts (each must be routed and walked). */
export const S4_NAV_TARGETS = ['/compliance', '/financial-operations', '/expenses', '/platform-health', '/tms/brokerage/users']

const routePaths = (app) => {
  const found = new Set()
  for (const m of app.matchAll(/<Route\s+(?:[^>]*?\s)?path="([^"]+)"/g)) found.add(m[1])
  for (const m of app.matchAll(/<Route\s*\n\s*path="([^"]+)"/g)) found.add(m[1])
  return found
}

/**
 * Gate 2. Returns a list of human-readable gaps (empty = pass).
 * `/tms/...` targets are routed by the /tms block or the `brokerage/*` splat, so they are checked
 * against those rather than by literal path.
 */
export async function s4NavGaps(root = process.cwd()) {
  const [nav, app] = await Promise.all([
    readFile(join(root, 'src/lib/navItems.ts'), 'utf8'),
    readFile(join(root, 'src/App.tsx'), 'utf8'),
  ])
  const routes = routePaths(app)
  const walked = new Set(S4_ROUTES.map((r) => r.path))
  const gaps = []
  for (const to of S4_NAV_TARGETS) {
    if (!nav.includes(`to: '${to}'`)) gaps.push(`${to}: no NAV_ITEMS entry in src/lib/navItems.ts`)
    if (to.startsWith('/tms/')) {
      const segment = to.split('/')[2]
      if (!routes.has(`${segment}/*`)) gaps.push(`${to}: App.tsx has no <Route path="${segment}/*">`)
    } else if (!routes.has(to)) {
      gaps.push(`${to}: no <Route path="${to}"> in src/App.tsx`)
    }
    if (!walked.has(to)) gaps.push(`${to}: no S4_ROUTES row`)
  }
  for (const [pattern] of S4_REDIRECTS) {
    if (!routes.has(pattern)) gaps.push(`${pattern}: redirect has no <Route> in src/App.tsx`)
  }
  return gaps
}
