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
  CalendarDays, LayoutDashboard, MessageSquare, Package, Banknote, Building2,
  SlidersHorizontal, Gauge, type LucideIcon,
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
 * The row Step AB owns (Spot quoter & e-mail). Its route and placeholder page exist either way;
 * flip to `false` to hide the row before AB ships.
 */
const SHOW_RESERVED_AB = true

/** A child row plus the gate that decides whether this user sees it. */
export interface NavChildDef extends TmsNavChild {
  pageKey: string
  /** Set on the `/tms/*` pages: they also open on the `tms` grant. */
  tms?: boolean
  /** Owner/ADMIN only (never opened by a page grant). */
  adminOnly?: boolean
  /** Other page grants that also open this entry. */
  alsoPageKeys?: string[]
  /** Hidden when the viewer holds this grant (they reach the page another way); owners/admins never see it. */
  hiddenWithPageKey?: string
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
  /** Shown only when the pinned row with this path shows: otherwise the page stays in its own section. */
  showWithPath?: string
  /** Labeled sub-lists under the row (e.g. Payroll under Accounting). */
  childGroups?: Array<{ label: string; children: NavChildDef[] }>
  children?: NavChildDef[]
  /** Sub-pages are a top-bar tab strip, not a sidebar list. */
  tabs?: boolean
  /** Path prefixes that also light this row when its own `to` is not their prefix. */
  matches?: string[]
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

// Accounting pages open only on their own grant (or ADMIN/owner), never on the broad `tms` grant: src/lib/accountingAccess.ts.
const ACCOUNTING_CHILDREN: NavChildDef[] = [
  { to: '/tms/invoicing', label: 'Accounts Receivable', pageKey: 'invoicing', badgeKey: 'arToInvoice', exclude: ['/tms/invoicing/payable'] },
  { to: '/tms/invoicing/payable', label: 'Accounts Payable', pageKey: 'carrierPay', badgeKey: 'apToReview' },
  // Factoring lives inside Invoicing (the Factored view); this entry is only for Factoring-only users.
  { to: '/tms/invoicing/factored', label: 'Factoring', pageKey: 'factoring', hiddenWithPageKey: 'invoicing' },
  { to: '/tms/vendors', label: 'Vendors', pageKey: 'vendorAp' },
]

/** Settlements and time cards: the pages the sidebar used to list under Ivan Cartage. Same paths and page grants. */
const PAYROLL_CHILDREN: NavChildDef[] = [
  { to: '/driver-pay-box-trucks', label: 'Box Truck Settlements', pageKey: 'driverPayBoxTrucks' },
  // Amazon settlements are the Amazon-week view of this page; someone who holds only the Amazon grant still gets the entry.
  { to: '/owner-operator-pay', label: 'Owner Operator Settlements', pageKey: 'ownerOperatorPay', alsoPageKeys: ['driverPay'] },
  { to: '/hours', label: 'Employee Hours', pageKey: 'hours' },
]

/** Under Calendar, in this order (Ryne 2026-11-09). */
const CALENDAR_CHILDREN: NavChildDef[] = [
  { to: '/driver-info', label: 'Driver info', pageKey: 'dispatch' },
  { to: '/appts', label: 'Appts', pageKey: 'appts', badgeKey: 'appts' },
  { to: '/time-off', label: 'Time off', pageKey: 'timeOff', badgeKey: 'timeOff' },
  // Moved up from Fleet manager so the driver sign-in invites are next to the people they are for (Ryne 2026-11-12).
  { to: '/ivan-driver-app', label: 'Ivan driver app', pageKey: 'ivanDriverApp' },
]

/** Customers, Carriers and Locations: one Profiles section. Carriers opens the Carrier list; Find & Invite is its other tab. */
const PROFILES_CHILDREN: NavChildDef[] = [
  { to: '/tms/customers', label: 'Customers', pageKey: 'customers', tms: true },
  { to: '/tms/carriers', label: 'Carriers', pageKey: 'carriers', tms: true },
  { to: '/tms/locations', label: 'Locations', pageKey: 'locations', tms: true },
  // The fleet's people: pay, truck, documents and details in one profile (Phase 2 adds Assets: Trucks | Trailers).
  { to: '/profiles/drivers', label: 'Drivers', pageKey: 'files', adminOnly: true },
  // Trucks and trailers: details, assignment and documents in one profile (tabs: Trucks | Trailers).
  { to: '/profiles/assets', label: 'Assets', pageKey: 'trucks', adminOnly: true },
]

/**
 * The fleet manager's pages, replacing the old Assets / Ivan Cartage section. The five asked for come first; the rest of what that
 * section held follows so no page loses its link. Fleet (trucks) is a tab of Asset documents.
 */
const FLEET_MANAGER_CHILDREN: NavChildDef[] = [
  { to: '/fleet-dashboard', label: 'Fleet manager dashboard', pageKey: 'fleetManagerDashboard' },
  { to: '/maintenance', label: 'Maintenance', pageKey: 'maintenance', badgeKey: 'maintenance' },
  { to: '/invoices', label: 'Invoices', pageKey: 'invoices' },
  { to: '/truck-docs', label: 'Asset documents', pageKey: 'truckDocs', badgeKey: 'truckDocs' },
  { to: '/fuel', label: 'Fuel', pageKey: 'fuel' },
  { to: '/files', label: 'Files', pageKey: 'files' },
  { to: '/disputes', label: 'Amazon disputes', pageKey: 'disputes' },
  { to: '/expenses', label: 'Expenses', pageKey: 'finances' },
  { to: '/insurance', label: 'Insurance', pageKey: 'insurance' },
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
  // The production (ASSETS) Dashboard. Its own grant, no `tms` flag: a Brokerage-only user never sees it.
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, pageKey: 'dashboard', section: BROKERAGE },
  // The lifecycle pages (Quote · Build · View · Book · Track · Review) are the top-bar strip
  // (`LIFECYCLE_TABS`); the sidebar keeps the one list people return to all day.
  { to: SHIPMENTS_PATH, label: 'Active shipments', icon: Package, pageKey: 'loads', section: BROKERAGE, tms: true },
  // Dispatch and Calendar are pages of their own, listed right under Active shipments (for people who see the freight list).
  { to: '/dispatch', label: 'Dispatch', icon: MessageSquare, pageKey: 'dispatch', section: BROKERAGE, badgeKey: 'dispatch', showWithPath: SHIPMENTS_PATH },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, pageKey: 'calendar', section: BROKERAGE, children: CALENDAR_CHILDREN },
  { to: '/tms/customers', label: 'Profiles', icon: Building2, pageKey: 'tms', section: BROKERAGE, group: true, tabs: true, children: PROFILES_CHILDREN },
  { to: '/fleet-dashboard', label: 'Fleet manager', icon: Gauge, pageKey: 'fleetManagerDashboard', section: BROKERAGE, group: true, tabs: true, children: FLEET_MANAGER_CHILDREN },
  {
    to: '/tms/invoicing',
    label: 'Accounting',
    icon: Banknote,
    pageKey: 'tms',
    section: BROKERAGE,
    group: true,
    badgeKey: 'accounting',
    tabs: true,
    children: ACCOUNTING_CHILDREN,
    childGroups: [{ label: 'Payroll', children: PAYROLL_CHILDREN }],
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
export function flatNavDefs(): Array<Pick<NavItemDef, 'to' | 'label' | 'pageKey' | 'adminOnly'>> {
  return PINNED_ITEMS.flatMap((item) => [...(item.group ? [] : [item]), ...(item.children ?? []), ...(item.childGroups ?? []).flatMap((g) => g.children)])
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
  { path: '/tms/carriers', crumbs: [{ label: 'Carriers', to: '/tms/carriers/find' }, { label: 'Carrier list' }] },
  { path: '/tms/carriers', prefix: true, crumbs: [{ label: 'Carriers', to: '/tms/carriers' }, { label: 'Details' }] },
  { path: '/tms/carriers/find', crumbs: [{ label: 'Carriers', to: '/tms/carriers/find' }, { label: 'Find & Invite' }] },
  { path: '/tms/invoicing', crumbs: [ACCOUNTING, { label: 'Accounts Receivable' }] },
  { path: '/tms/invoicing/invoices', prefix: true, crumbs: [ACCOUNTING, AR, { label: 'Invoice' }] },
  { path: '/tms/invoicing/payable', crumbs: [ACCOUNTING, { label: 'Accounts Payable' }] },
  { path: '/tms/invoicing/payable/bills', prefix: true, crumbs: [ACCOUNTING, AP, { label: 'Bill' }] },
  { path: '/tms/vendors', crumbs: [ACCOUNTING, { label: 'Vendors' }] },
  { path: '/tms/invoicing/factored', crumbs: [ACCOUNTING, AR, { label: 'Factored' }] },
  { path: '/tms/customers/billing-setup', crumbs: [{ label: 'Customers', to: '/tms/customers' }, { label: 'Billing setup' }] },
  { path: '/tms/brokerage/company/data/aljex-reconciliation', crumbs: [SETTINGS, { label: 'Company', to: '/tms/brokerage/company' }, { label: 'Aljex reconciliation' }] },
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
/** Pages that live inside another page now (still in `navItems.ts` as a permission): Amazon Settlements is Owner Operator Settlements' Amazon weeks. */
const FOLDED_PATHS = new Set(['/driver-pay'])
const ITEM_POOL: NavItemDef[] = NAV_ITEMS.filter((i) => i.section !== BROKERAGE && !FOLDED_PATHS.has(i.to))

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
  // The COMPANY section (Finances, Financial operations, Profit Review, Reddit Queue) is the company itself, not a
  // business a user can retire: it must show whether or not an OwnershipDivision row for it exists or is active.
  const loaded: DivisionLike[] = divisions ?? SEED_DIVISIONS
  const company = loaded.find((d) => d.code === COMPANY_DIVISION)
  const all: DivisionLike[] = company?.active && !company.parentId
    ? loaded
    : [
        ...loaded.filter((d) => d.code !== COMPANY_DIVISION),
        { id: COMPANY_DIVISION, code: COMPANY_DIVISION, name: company?.name ?? 'Company', brand: company?.brand ?? null, parentId: null, sortOrder: company?.sortOrder ?? 99, active: true },
      ]
  const everything = isOwner || isAdmin
  const canOpenTms = everything || hasPageAccess(TMS_PAGE_KEY)
  const visible = (def: { pageKey: string; tms?: boolean; adminOnly?: boolean; alsoPageKeys?: string[]; hiddenWithPageKey?: string }): boolean =>
    def.hiddenWithPageKey && (everything || hasPageAccess(def.hiddenWithPageKey))
      ? false
      : everything || (def.adminOnly !== true && (hasPageAccess(def.pageKey) || (def.alsoPageKeys ?? []).some(hasPageAccess) || (def.tms === true && canOpenTms)))

  // Pinned items are never part of a business section; they render first and are gated
  // exactly like any other page, so a shared-loads grant keeps seeing Shipments.
  const pinned: NavSectionItem[] = []
  const toChild = (c: NavChildDef): TmsNavChild => ({
    to: c.to,
    label: c.label,
    badgeKey: c.badgeKey,
    exact: c.exact,
    exclude: c.exclude,
    params: c.params,
  })
  // Paths drawn under a pinned row (Dispatch and Calendar under Active shipments, the Payroll pages under Accounting): they are
  // not drawn a second time in their old section. A person who cannot see the parent row keeps them where they were.
  const movedUnderPinned = new Set<string>()
  for (const def of PINNED_ITEMS) {
    const ownVisible = !def.group && visible(def)
    if (def.showWithPath && !pinned.some((p) => p.to === def.showWithPath)) continue
    // A row that is a page in its own right only lists its children when the person can open that page.
    const children = (def.group || ownVisible ? def.children ?? [] : []).filter(visible).map<TmsNavChild>(toChild)
    // A group (Accounting) lists its labeled sub-lists (Payroll) on their own page grants: someone with Box Truck Settlements and no accounting page still gets the entry (Ryne 2026-11-11, Ruben).
    const groups = (def.group || ownVisible ? def.childGroups ?? [] : [])
      .map((g) => ({ label: g.label, children: g.children.filter(visible).map<TmsNavChild>(toChild) }))
      .filter((g) => g.children.length > 0)
    // A group is only as visible as its children; a page is visible by its own gate.
    if (def.group ? children.length === 0 && groups.length === 0 : !ownVisible) continue
    if (def.showWithPath) movedUnderPinned.add(def.to)
    for (const c of children) movedUnderPinned.add(c.to)
    for (const g of groups) for (const c of g.children) movedUnderPinned.add(c.to)
    pinned.push({
      to: def.group ? (children[0]?.to ?? groups[0]!.children[0]!.to) : def.to,
      label: def.label,
      icon: def.icon,
      badge: def.badge ?? null,
      pageKey: def.pageKey,
      badgeKey: def.badgeKey,
      children: children.length > 0 ? children : undefined,
      childGroups: groups.length > 0 ? groups : undefined,
      group: def.group,
      tabs: def.tabs,
      matches: def.matches,
    })
  }

  // An item tagged with a subdivision (Owner Operators, Box Trucks…) belongs to the
  // business that owns it, so it rolls up to the top-level division's section.
  const byTopLevel = new Map<string, NavItemDef[]>()
  for (const def of ITEM_POOL) {
    if (movedUnderPinned.has(def.to)) continue
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
    // Assets / Ivan Cartage has no section of its own any more: its pages sit under Calendar, Accounting > Payroll and Fleet manager.
    if (division.code === 'ASSETS') continue
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
