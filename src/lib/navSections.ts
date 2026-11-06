/**
 * The sidebar, grouped by the business that owns the page.
 *
 * BCAT runs three businesses out of one book — the brokerage (BCAT Logistics), the asset
 * fleet (Ivan Cartage) and car shipping (Best Care Auto Transport) — plus the company
 * itself. Those are `OwnershipDivision` rows, not a hardcoded list: the sections come from
 * whatever divisions exist, and a division somebody adds in settings shows up here.
 *
 * The one `TmsShell` rail renders this function, on `/tms/*` and on the legacy pages alike.
 * The freight pages (the old BROKERAGE section) are the pinned block (`PINNED_ITEMS`): one
 * flat list with no header, children as data, never folded when a business is chosen,
 * because Shipments, Customers and Carriers serve all three businesses. Every other
 * section is the existing nav config grouped by its `section` code. A pinned page opens
 * for anybody granted `tms` OR that page's original key, so a broker is granted one thing
 * rather than fifteen; a child is gated the same way, and a group header shows only while
 * one of its children does.
 */
import {
  LayoutDashboard, Package, Truck, Banknote, Building2,
  MapPin, SlidersHorizontal, type LucideIcon,
} from 'lucide-react'
import { NAV_ITEMS } from '@/lib/navItems'
import { LIFECYCLE_TABS } from '@/lib/lifecycleTabs'
import { SEED_DIVISIONS, topLevelOf } from '@/lib/ownership'
import type { OwnershipDivisionRecord } from '@/types/tms'
import type { TmsBreadcrumbItem, TmsCompanyOption, TmsNavChild, TmsNavItem, TmsNavSection } from '@/features/tms/TmsShell'

/** The single grant that opens the whole Brokerage section. */
export const TMS_PAGE_KEY = 'tms'

/** A division code. Sections are data, so this is deliberately not a union. */
export type SectionKey = string

const BROKERAGE = 'BROKERAGE'
const SHIPMENTS_PATH = '/tms/shipments'
export const COMPANY_DIVISION = 'COMPANY'

/**
 * The three rows Step AB owns (Spot inbox, Follow-ups, Spot quoter & e-mail). Their routes
 * and placeholder pages exist either way; flip to `false` to hide the rows before AB ships.
 */
const SHOW_RESERVED_AB = true

/** A child row plus the gate that decides whether this user sees it. */
export interface NavChildDef extends TmsNavChild {
  pageKey: string
  /** Set on the `/tms/*` pages: they also open on the `tms` grant. */
  tms?: boolean
  /** Owner/ADMIN only (never opened by a page grant). */
  adminOnly?: boolean
}

export interface NavItemDef {
  to: string
  label: string
  icon: LucideIcon
  pageKey: string
  section: SectionKey
  /** Set on the `/tms/*` pages: they also open on the `tms` grant. */
  tms?: boolean
  /** Owner/ADMIN only (never opened by a page grant). */
  adminOnly?: boolean
  /** Which sidebar count this item carries, if any (`useShellBadgeCounts` resolves it). */
  badgeKey?: string
  /** A fixed label badge. */
  badge?: string | null
  /** A header row with no page of its own: visible while a child is, `to` is the first visible child. */
  group?: boolean
  /** Sub-items rendered under this row. */
  children?: NavChildDef[]
}

/** A built item: a `TmsNavItem` plus what the legacy rail needs to gate and count it. */
export interface NavSectionItem extends TmsNavItem {
  pageKey: string
  badgeKey?: string
}

export interface NavSection extends TmsNavSection {
  items: NavSectionItem[]
}

export interface NavSectionsResult {
  pinned: NavSectionItem[]
  sections: NavSection[]
  /** The businesses the switcher offers: BROKERAGE whenever any pinned row shows, then each visible section. */
  businesses: Array<{ key: string }>
}

const ACCOUNTING_CHILDREN: NavChildDef[] = [
  { to: '/tms/invoicing', label: 'Accounts Receivable', pageKey: 'invoicing', tms: true, badgeKey: 'arToInvoice', exclude: ['/tms/invoicing/payable'] },
  { to: '/tms/invoicing/payable', label: 'Accounts Payable', pageKey: 'carrierPay', tms: true, badgeKey: 'apToReview' },
  { to: '/tms/vendors', label: 'Vendors', pageKey: 'vendorAp', tms: true },
  { to: '/tms/factors', label: 'Factoring', pageKey: 'factoring', tms: true },
]

const SETTINGS_CHILDREN: NavChildDef[] = [
  { to: '/tms/brokerage', label: 'General & automation', pageKey: 'settings', tms: true, exact: true },
  { to: '/tms/brokerage/company', label: 'Company', pageKey: 'tms', adminOnly: true },
  { to: '/tms/brokerage/divisions', label: 'Divisions & ownership', pageKey: 'tms', adminOnly: true },
  { to: '/tms/brokerage/users', label: 'Users & roles', pageKey: 'users', adminOnly: true },
  { to: '/tms/brokerage/integrations', label: 'Integrations', pageKey: 'tms', adminOnly: true },
  { to: '/tms/brokerage/ai-agents', label: 'AI agents', pageKey: 'tms', adminOnly: true },
  ...(SHOW_RESERVED_AB
    ? [{ to: '/tms/brokerage/spot-quoter', label: 'Spot quoter & e-mail', pageKey: 'tms', adminOnly: true }]
    : []),
  { to: '/tms/brokerage/carrier-sales', label: 'Carrier Sales', pageKey: 'tms', adminOnly: true },
  { to: '/tms/brokerage/commissions', label: 'Commissions', pageKey: 'commissions', tms: true },
  { to: '/tms/brokerage/reports', label: 'Reports', pageKey: 'reports', tms: true },
  { to: '/tms/brokerage/audit', label: 'Audit log', pageKey: 'audit', tms: true },
  { to: '/compliance', label: 'Compliance', pageKey: 'compliance', badgeKey: 'review' },
  { to: '/platform-health', label: 'Platform health', pageKey: 'platformHealth', adminOnly: true },
  { to: '/tms/brokerage/demo', label: 'Demo', pageKey: 'tms', tms: true },
]

/**
 * The pinned block, top to bottom: every freight page, once. Page keys are the ones the
 * old paths used, so an existing grant still opens the re-homed page.
 */
export const PINNED_ITEMS: NavItemDef[] = [
  { to: '/tms/dashboard', label: 'Company Dashboard', icon: LayoutDashboard, pageKey: 'tms', section: BROKERAGE, tms: true },
  // The lifecycle pages (Quote · Build · View · Book · Track · Review) are the top-bar strip
  // (`LIFECYCLE_TABS`); the sidebar keeps the one list people return to all day.
  { to: SHIPMENTS_PATH, label: 'Active shipments', icon: Package, pageKey: 'loads', section: BROKERAGE, tms: true },
  {
    to: '/tms/customers',
    label: 'Customers',
    icon: Building2,
    pageKey: 'customers',
    section: BROKERAGE,
    tms: true,
    children: [
      { to: '/tms/customers', label: 'Customers', pageKey: 'customers', tms: true, exclude: ['/tms/customers/follow-ups'] },
      ...(SHOW_RESERVED_AB
        ? [{ to: '/tms/customers/follow-ups', label: 'Follow-ups', pageKey: 'customers', tms: true }]
        : []),
    ],
  },
  {
    to: '/tms/carriers',
    label: 'Carriers',
    icon: Truck,
    pageKey: 'carriers',
    section: BROKERAGE,
    tms: true,
    children: [
      { to: '/tms/carriers', label: 'Carriers', pageKey: 'carriers', tms: true, exclude: ['/tms/carriers/find'] },
      { to: '/tms/carriers/find', label: 'Find & Invite', pageKey: 'carriers', tms: true },
    ],
  },
  { to: '/tms/locations', label: 'Locations', icon: MapPin, pageKey: 'locations', section: BROKERAGE, tms: true },
  {
    to: '/tms/invoicing',
    label: 'Accounting',
    icon: Banknote,
    pageKey: 'tms',
    section: BROKERAGE,
    group: true,
    badgeKey: 'accounting',
    children: ACCOUNTING_CHILDREN,
  },
  {
    to: '/tms/brokerage',
    label: 'Settings',
    icon: SlidersHorizontal,
    pageKey: 'tms',
    section: BROKERAGE,
    group: true,
    children: SETTINGS_CHILDREN,
  },
]

/**
 * Every page-bearing nav def once, in sidebar order: top-level rows and their children,
 * group headers excluded (they open nothing of their own).
 */
export function flatNavDefs(): Array<Pick<NavItemDef, 'to' | 'label' | 'pageKey'>> {
  return PINNED_ITEMS.flatMap((item) => [...(item.group ? [] : [item]), ...(item.children ?? [])])
}

/** A division code as a section header: `CAR_SHIPPING` reads `CAR SHIPPING`. */
export function sectionTitle(code: string): string {
  return code.replace(/_/g, ' ')
}

const INTAKE_PATH = '/tms/shipments/intake'

interface CrumbRule {
  path: string
  /** Matches the path or anything under it; without it only the exact path matches. */
  prefix?: boolean
  crumbs: TmsBreadcrumbItem[]
}

const QUOTES: TmsBreadcrumbItem = { label: 'Quotes', to: '/tms/rates' }
const SHIPMENTS: TmsBreadcrumbItem = { label: 'Shipments', to: SHIPMENTS_PATH }
const ACCOUNTING: TmsBreadcrumbItem = { label: 'Accounting' }
const SETTINGS: TmsBreadcrumbItem = { label: 'Settings' }
const LOAD_TRACKING: TmsBreadcrumbItem = { label: 'Load Tracking', to: '/tms/tracking' }
const AR: TmsBreadcrumbItem = { label: 'Accounts Receivable', to: '/tms/invoicing' }
const AP: TmsBreadcrumbItem = { label: 'Accounts Payable', to: '/tms/invoicing/payable' }

/**
 * Trails for the pages whose trail is not just their nav label. The longest matching path
 * wins; at equal length an exact rule beats a prefix rule. A group crumb has no link.
 */
const CRUMBS: CrumbRule[] = [
  { path: '/tms/rates', crumbs: [{ label: 'Quotes' }] },
  { path: '/tms/rates', prefix: true, crumbs: [QUOTES, { label: 'Quote' }] },
  { path: '/tms/rates/new', crumbs: [QUOTES, { label: 'New quote' }] },
  { path: '/tms/rates/spot', prefix: true, crumbs: [QUOTES, { label: 'Spot inbox' }] },
  { path: SHIPMENTS_PATH, crumbs: [{ label: 'Shipments' }] },
  { path: SHIPMENTS_PATH, prefix: true, crumbs: [SHIPMENTS, { label: 'Shipment' }] },
  { path: '/tms/shipments/new', crumbs: [SHIPMENTS, { label: 'New shipment' }] },
  // After the generic shipment branch, or an intake load would read "Shipment".
  { path: INTAKE_PATH, crumbs: [SHIPMENTS, { label: 'Intake' }] },
  { path: INTAKE_PATH, prefix: true, crumbs: [SHIPMENTS, { label: 'Intake', to: INTAKE_PATH }, { label: 'Load' }] },
  { path: '/tms/tracking', crumbs: [{ label: 'Load Tracking' }] },
  { path: '/tms/carrier-sales', prefix: true, crumbs: [{ label: 'Carrier Sales' }] },
  { path: '/tms/load-review', prefix: true, crumbs: [{ label: 'Load Review' }] },
  { path: '/tms/tracking/links', crumbs: [LOAD_TRACKING, { label: 'Customer links' }] },
  { path: '/tms/carriers/find', crumbs: [{ label: 'Carriers', to: '/tms/carriers' }, { label: 'Find & Invite' }] },
  { path: '/tms/customers/follow-ups', crumbs: [{ label: 'Customers', to: '/tms/customers' }, { label: 'Follow-ups' }] },
  { path: '/tms/invoicing', crumbs: [ACCOUNTING, { label: 'Accounts Receivable' }] },
  { path: '/tms/invoicing/invoices', prefix: true, crumbs: [ACCOUNTING, AR, { label: 'Invoice' }] },
  { path: '/tms/invoicing/payable', crumbs: [ACCOUNTING, { label: 'Accounts Payable' }] },
  { path: '/tms/invoicing/payable/bills', prefix: true, crumbs: [ACCOUNTING, AP, { label: 'Bill' }] },
  { path: '/tms/vendors', crumbs: [ACCOUNTING, { label: 'Vendors' }] },
  { path: '/tms/factors', crumbs: [ACCOUNTING, { label: 'Factoring' }] },
  { path: '/tms/brokerage', prefix: true, crumbs: [SETTINGS, { label: 'General & automation' }] },
  // One rule per Settings child, labelled as the sidebar labels it (the root is exact-only).
  ...SETTINGS_CHILDREN.filter((c) => c.to !== '/tms/brokerage').map<CrumbRule>((c) => ({
    path: c.to,
    prefix: true,
    crumbs: [SETTINGS, { label: c.label }],
  })),
  { path: '/tms/workflows', prefix: true, crumbs: [SETTINGS, { label: 'Workflows' }] },
]

/** Legacy pages that are not nav items of their own (or whose trail differs from their item). */
const LEGACY_CRUMBS: CrumbRule[] = [
  { path: '/finances/review', crumbs: [{ label: 'Finances', to: '/finances' }, { label: 'Profit review' }] },
  { path: '/finance/cash-checkin', crumbs: [{ label: 'Cash check-in' }] },
  { path: '/driver-view', prefix: true, crumbs: [{ label: 'Owner operator pay', to: '/owner-operator-pay' }, { label: 'Driver app' }] },
  { path: '/truck-docs', crumbs: [{ label: 'Truck documents' }] },
  { path: '/ivan-driver-app', crumbs: [{ label: 'Ivan driver app' }] },
  { path: '/invoices', crumbs: [{ label: 'Invoices' }] },
]

function bestRule(rules: CrumbRule[], pathname: string): CrumbRule | null {
  let best: CrumbRule | null = null
  let bestScore = -1
  for (const rule of rules) {
    const hit = pathname === rule.path || (rule.prefix === true && pathname.startsWith(`${rule.path}/`))
    if (!hit) continue
    const score = rule.path.length * 2 + (rule.prefix ? 0 : 1)
    if (score > bestScore) {
      best = rule
      bestScore = score
    }
  }
  return best
}

/** `team-queue` reads `Team queue`. */
function titleCase(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The trail the TMS top bar shows for a path: an explicit rule when the page has one, else
 * the nav item the page belongs to (the longest match wins) and at most one more level.
 * Every crumb but the last links.
 */
export function tmsBreadcrumb(pathname: string): TmsBreadcrumbItem[] {
  const explicit = bestRule(CRUMBS, pathname) ?? bestRule(LEGACY_CRUMBS, pathname)
  if (explicit) return explicit.crumbs

  // Every nav item answers to its own label, and nothing ever reads "TMS".
  const isTms = pathname === '/tms' || pathname.startsWith('/tms/')
  let best: Pick<NavItemDef, 'to' | 'label'> | null = null
  for (const item of isTms ? [...flatNavDefs(), ...LIFECYCLE_TABS.map((t) => ({ to: t.to, label: `${t.label} · ${t.caption}` }))] : ITEM_POOL) {
    if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.to.length) best = item
    }
  }
  if (!best) {
    if (isTms) return [{ label: 'TMS' }]
    const first = pathname.split('/').filter(Boolean)[0]
    return [{ label: first ? titleCase(first) : 'Home' }]
  }
  if (pathname === best.to) return [{ label: best.label }]
  const segment = pathname.slice(best.to.length + 1).split('/')[0]
  return [{ label: best.label, to: best.to }, { label: /\d/.test(segment) ? 'Details' : titleCase(segment) }]
}

/**
 * The businesses the company switcher offers: one per visible business, in section order,
 * minus the COMPANY group (it is the company, not a business). Names come from the
 * division list so the switcher never shows a code.
 */
export function companyOptions(
  sections: Array<{ key: string }>,
  divisions: Array<Pick<OwnershipDivisionRecord, 'code' | 'name'>> | null,
): TmsCompanyOption[] {
  const known = divisions ?? SEED_DIVISIONS
  return sections
    .filter((s) => s.key !== COMPANY_DIVISION)
    .map((s) => ({ code: s.key, name: known.find((d) => d.code === s.key)?.name ?? s.key }))
}

type DivisionLike = Pick<OwnershipDivisionRecord, 'id' | 'code' | 'name' | 'brand' | 'parentId' | 'sortOrder' | 'active'>

/**
 * Every section nav item, once, tagged with the division that owns it. The freight pages
 * are the pinned block; the legacy config's BROKERAGE rows are the old paths those replaced
 * (they stay in `navItems.ts` because they are still the permission list), so they are not
 * rendered here.
 */
const ITEM_POOL: NavItemDef[] = NAV_ITEMS.filter((i) => i.section !== BROKERAGE)

export function buildNavSections({
  divisions,
  hasPageAccess,
  isOwner = false,
  isAdmin = false,
}: {
  divisions: OwnershipDivisionRecord[] | null
  hasPageAccess: (pageKey: string) => boolean
  isOwner?: boolean
  isAdmin?: boolean
}): NavSectionsResult {
  // Null means "the divisions have not loaded (or the table is not deployed yet)". The
  // seeds are the same four the Lambda writes, so the rail looks right either way.
  const all: DivisionLike[] = divisions ?? SEED_DIVISIONS
  const everything = isOwner || isAdmin
  const canOpenTms = everything || hasPageAccess(TMS_PAGE_KEY)
  const visible = (def: { pageKey: string; tms?: boolean; adminOnly?: boolean }): boolean =>
    everything || (def.adminOnly !== true && (hasPageAccess(def.pageKey) || (def.tms === true && canOpenTms)))

  // Pinned items are never part of a business section; they render first and are gated
  // exactly like any other page, so a shared-loads grant keeps seeing Shipments.
  const pinned: NavSectionItem[] = []
  for (const def of PINNED_ITEMS) {
    const children = (def.children ?? []).filter(visible).map<TmsNavChild>((c) => ({
      to: c.to,
      label: c.label,
      badgeKey: c.badgeKey,
      exact: c.exact,
      exclude: c.exclude,
      params: c.params,
    }))
    // A group is only as visible as its children; a page with children is visible by its own gate.
    if (def.group ? children.length === 0 : !visible(def)) continue
    pinned.push({
      to: def.group ? children[0].to : def.to,
      label: def.label,
      icon: def.icon,
      badge: def.badge ?? null,
      pageKey: def.pageKey,
      badgeKey: def.badgeKey,
      children: children.length > 0 ? children : undefined,
      group: def.group,
    })
  }

  // An item tagged with a subdivision (Owner Operators, Box Trucks…) belongs to the
  // business that owns it, so it rolls up to the top-level division's section.
  const byTopLevel = new Map<string, NavItemDef[]>()
  for (const def of ITEM_POOL) {
    const top = topLevelOf(all, def.section) ?? def.section
    const bucket = byTopLevel.get(top)
    if (bucket) bucket.push(def)
    else byTopLevel.set(top, [def])
  }

  const tops = all
    .filter((d) => d.active && !d.parentId)
    .sort((a, b) => (a.code === COMPANY_DIVISION ? 1 : b.code === COMPANY_DIVISION ? -1 : a.sortOrder - b.sortOrder))

  const sections: NavSection[] = []
  for (const division of tops) {
    // The brokerage is the pinned block above: no section, no intake fallback link.
    if (division.code === BROKERAGE) continue
    const defs = byTopLevel.get(division.code) ?? []
    if (defs.length === 0) {
      // A division nobody has written pages for yet still has freight: its shipments.
      if (!canOpenTms) continue
      sections.push({
        // The rails render "CODE [brand]"; the code IS the section label, and the
        // business it trades as is the brand beside it.
        key: division.code,
        name: sectionTitle(division.code),
        brand: division.brand ?? null,
        items: [{
          to: `/tms/shipments/intake?division=${division.code}`,
          label: `Intake · ${division.name}`,
          icon: Package,
          badge: null,
          pageKey: TMS_PAGE_KEY,
        }],
      })
      continue
    }
    const items = defs.filter(visible).map((def) => ({
      to: def.to,
      label: def.label,
      icon: def.icon,
      badge: def.badge ?? null,
      pageKey: def.pageKey,
      badgeKey: def.badgeKey,
    }))
    if (items.length === 0) continue
    sections.push({ key: division.code, name: sectionTitle(division.code), brand: division.brand ?? null, items })
  }

  const businesses = tops
    .filter((d) => d.code !== COMPANY_DIVISION && (d.code === BROKERAGE ? pinned.length > 0 : sections.some((s) => s.key === d.code)))
    .map((d) => ({ key: d.code }))
  return { pinned, sections, businesses }
}
