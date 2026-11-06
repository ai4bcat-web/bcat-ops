/**
 * The shipment lifecycle strip (Step AV): Quote · Build · View · Book · Track · Review.
 *
 * One table drives the strip in the TMS top bar. Each tab names the page it opens, the paths
 * that light it, the page grant behind it (the same `pageKey` the sidebar gated these pages on)
 * and the `useShellBadgeCounts` key its count badge reads.
 *
 * `matches` are path patterns: `:name` is exactly one segment, a trailing `/*` is one or more
 * further segments. The first tab, in table order, with a matching pattern wins, so Build sits
 * ahead of View: `/tms/shipments/new` and `/tms/shipments/intake` are Build, not a shipment id.
 */
export type LifecycleKey = 'quote' | 'build' | 'view' | 'book' | 'track' | 'review'

export interface LifecycleTab {
  key: LifecycleKey
  label: string
  /** One-word sub-caption, so new users learn the mapping. */
  caption: string
  /** Where the tab goes. */
  to: string
  /** Path patterns that light this tab. */
  matches: string[]
  /** The grant that opens the page behind the tab (`tms` always opens it too). */
  pageKey: string
  /** The `useShellBadgeCounts` key for the count badge, if any. */
  badgeKey: string | null
}

export const LIFECYCLE_TABS: readonly LifecycleTab[] = [
  {
    key: 'quote',
    label: 'Quote',
    caption: 'Spot quotes',
    to: '/tms/rates',
    matches: ['/tms/rates', '/tms/rates/*'],
    pageKey: 'quotes',
    badgeKey: 'quotesToReply',
  },
  {
    key: 'build',
    label: 'Build',
    caption: 'Intake',
    to: '/tms/shipments/intake',
    matches: ['/tms/shipments/intake', '/tms/shipments/intake/*', '/tms/shipments/new', '/tms/shipments/:id/edit'],
    pageKey: 'loads',
    badgeKey: 'intakeLoads',
  },
  {
    key: 'view',
    label: 'View',
    caption: 'Active shipments',
    to: '/tms/shipments',
    matches: ['/tms/shipments', '/tms/shipments/:id', '/tms/shipments/:id/*'],
    pageKey: 'loads',
    badgeKey: null,
  },
  {
    key: 'book',
    label: 'Book',
    caption: 'Carrier sales',
    to: '/tms/carrier-sales',
    matches: ['/tms/carrier-sales', '/tms/carrier-sales/*'],
    pageKey: 'loads',
    badgeKey: 'carrierSales',
  },
  {
    key: 'track',
    label: 'Track',
    caption: 'Tracking',
    to: '/tms/tracking',
    matches: ['/tms/tracking', '/tms/tracking/*'],
    pageKey: 'loads',
    badgeKey: 'loadTracking',
  },
  {
    key: 'review',
    label: 'Review',
    caption: 'Load review',
    to: '/tms/load-review',
    matches: ['/tms/load-review', '/tms/load-review/*'],
    pageKey: 'loadReview',
    badgeKey: 'loadReview',
  },
]

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function matchesPattern(pathSegments: string[], pattern: string): boolean {
  const want = segments(pattern)
  const rest = want[want.length - 1] === '*'
  const fixed = rest ? want.slice(0, -1) : want
  if (rest ? pathSegments.length <= fixed.length : pathSegments.length !== fixed.length) return false
  return fixed.every((seg, i) => seg.startsWith(':') || seg === pathSegments[i])
}

/** The tab a path belongs to, or null for a page outside the lifecycle (customers, accounting …). */
export function activeLifecycleTab(pathname: string): LifecycleKey | null {
  const path = segments(pathname.split(/[?#]/)[0])
  return LIFECYCLE_TABS.find((tab) => tab.matches.some((pattern) => matchesPattern(path, pattern)))?.key ?? null
}

/** The tabs this person may open: `canOpenPage` is the same gate the sidebar rows use. */
export function visibleLifecycleTabs(canOpenPage: (pageKey: string) => boolean): LifecycleTab[] {
  return LIFECYCLE_TABS.filter((tab) => canOpenPage(tab.pageKey))
}
