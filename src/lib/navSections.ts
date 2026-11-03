/**
 * The sidebar, grouped by the business that owns the page.
 *
 * BCAT runs three businesses out of one book — the brokerage (BCAT Logistics), the asset
 * fleet (Ivan Cartage) and car shipping (Best Care Auto Transport) — plus the company
 * itself. Those are `OwnershipDivision` rows, not a hardcoded list: the sections come from
 * whatever divisions exist, and a division somebody adds in settings shows up here.
 *
 * The one `TmsShell` rail renders this function, on `/tms/*` and on the legacy pages alike. The BROKERAGE section is the MVMNT page set
 * (`TMS_ITEMS`); every other section is the existing nav config grouped by its `section`
 * code. A BROKERAGE page opens for anybody granted `tms` OR that page's original key, so
 * a broker is granted one thing rather than fifteen.
 */
import {
  LayoutDashboard, Package, LineChart, FileSpreadsheet, Truck, Banknote, Building2,
  MapPin, Receipt, Workflow, GraduationCap, Building, Link2, type LucideIcon,
} from 'lucide-react'
import { NAV_ITEMS } from '@/lib/navItems'
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

export interface NavItemDef {
  to: string
  label: string
  icon: LucideIcon
  pageKey: string
  section: SectionKey
  /** Set on the `/tms/*` pages: they also open on the `tms` grant. */
  tms?: boolean
  /** Which sidebar count this item carries, if any (`useShellBadgeCounts` resolves it). */
  badgeKey?: string
  /** A fixed label badge, e.g. Academy's BETA tag. */
  badge?: string | null
  /** Sub-items rendered under this row in the MVMNT rail. */
  children?: TmsNavChild[]
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
}

/**
 * Pages that sit above the business sections because they serve all three businesses.
 * The company dashboard is the top-level home; Shipments is the shared freight list.
 * Shipments renders its workstation pages and saved views as children in `TmsShell`.
 */
export const PINNED_ITEMS: NavItemDef[] = [
  { to: '/tms/dashboard', label: 'Company Dashboard', icon: LayoutDashboard, pageKey: 'tms', section: BROKERAGE, tms: true },
  {
    to: '/tms/shipments',
    label: 'Shipments',
    icon: Package,
    pageKey: 'loads',
    section: BROKERAGE,
    tms: true,
    badgeKey: 'checkCalls',
    children: [
      { to: '/tms/shipments/view/my-queue', label: 'My queue', badgeKey: 'myQueue' },
      { to: '/tms/shipments/view/team-queue', label: 'Team queue', badgeKey: 'teamQueue' },
    ],
  },
]

/**
 * The Brokerage pages, in MVMNT's sidebar order (MVMNT_UI_REFERENCE §1). Each keeps the
 * page key its old path used, so an existing grant still opens the re-homed page.
 * The company dashboard and Shipments are pinned above the sections and are not in this bucket.
 */
export const TMS_ITEMS: NavItemDef[] = [
  { to: '/tms/rates',      label: 'Rates',        icon: LineChart,       pageKey: 'quotes',    section: BROKERAGE, tms: true, badgeKey: 'quotesToReply' },
  { to: '/tms/invoicing',  label: 'Invoicing',    icon: FileSpreadsheet, pageKey: 'invoicing', section: BROKERAGE, tms: true, badgeKey: 'arToInvoice' },
  { to: '/tms/carriers',   label: 'Carriers',     icon: Truck,           pageKey: 'carriers',  section: BROKERAGE, tms: true },
  { to: '/tms/factors',    label: 'Factors',      icon: Banknote,        pageKey: 'factoring', section: BROKERAGE, tms: true },
  { to: '/tms/customers',  label: 'Customers',    icon: Building2,       pageKey: 'customers', section: BROKERAGE, tms: true },
  { to: '/tms/locations',  label: 'Locations',    icon: MapPin,          pageKey: 'locations', section: BROKERAGE, tms: true },
  { to: '/tms/vendors',    label: 'Vendors',      icon: Receipt,         pageKey: 'vendorAp',  section: BROKERAGE, tms: true },
  { to: '/tms/workflows',  label: 'Workflows',    icon: Workflow,        pageKey: 'tms',       section: BROKERAGE, tms: true },
  { to: '/tms/academy',    label: 'Academy',      icon: GraduationCap,   pageKey: 'tms',       section: BROKERAGE, tms: true, badge: 'BETA' },
  { to: '/tms/tracking/links',  label: 'Manage Customer Links', icon: Link2, pageKey: 'tms', section: BROKERAGE, tms: true },
  { to: '/tms/brokerage',  label: 'My Brokerage', icon: Building,        pageKey: 'settings',  section: BROKERAGE, tms: true },
]

const ALL_TMS_ITEMS: NavItemDef[] = [...PINNED_ITEMS, ...TMS_ITEMS]

/** A division code as a section header: `CAR_SHIPPING` reads `CAR SHIPPING`. */
export function sectionTitle(code: string): string {
  return code.replace(/_/g, ' ')
}

/** Workstation pages that live under the Shipments item without being nav items of their own. */
const SHIPMENT_WORKSTATIONS: Record<string, string> = {
  '/tms/dispatch': 'Dispatch',
  '/tms/tracking': 'Tracking',
  '/tms/documents': 'Documents',
  '/tms/check-calls': 'Check calls',
}

/** Legacy pages that are not nav items of their own (or whose trail differs from their item). */
const LEGACY_CRUMBS: Array<{ path: string; prefix?: boolean; crumbs: TmsBreadcrumbItem[] }> = [
  { path: '/finances/review', crumbs: [{ label: 'Finances', to: '/finances' }, { label: 'Profit review' }] },
  { path: '/compliance', crumbs: [{ label: 'Compliance', to: '/compliance' }, { label: 'Document overview' }] },
  { path: '/finance/cash-checkin', crumbs: [{ label: 'Cash check-in' }] },
  { path: '/driver-view', prefix: true, crumbs: [{ label: 'Owner operator pay', to: '/owner-operator-pay' }, { label: 'Driver app' }] },
  { path: '/truck-docs', crumbs: [{ label: 'Truck documents' }] },
  { path: '/ivan-driver-app', crumbs: [{ label: 'Ivan driver app' }] },
  { path: '/invoices', crumbs: [{ label: 'Invoices' }] },
]

/** `my-queue` reads `My queue`. */
function titleCase(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The trail the TMS top bar shows for a path: the nav item the page belongs to (the
 * longest match wins), then at most one more level. Every crumb but the last links.
 */
export function tmsBreadcrumb(
  pathname: string,
  shipmentViews: Array<{ slug: string; name: string }> = [],
): TmsBreadcrumbItem[] {
  const shipments: TmsBreadcrumbItem = { label: 'Shipments', to: SHIPMENTS_PATH }

  if (pathname === '/tms/tracking/links') {
    return [shipments, { label: 'Tracking', to: '/tms/tracking' }, { label: 'Manage links' }]
  }
  const workstation = SHIPMENT_WORKSTATIONS[pathname]
  if (workstation) return [shipments, { label: workstation }]

  const viewPrefix = `${SHIPMENTS_PATH}/view/`
  if (pathname.startsWith(viewPrefix)) {
    const slug = pathname.slice(viewPrefix.length).split('/')[0]
    return [shipments, { label: shipmentViews.find((v) => v.slug === slug)?.name ?? titleCase(slug) }]
  }
  if (pathname.startsWith(`${SHIPMENTS_PATH}/`)) return [shipments, { label: 'Shipment' }]

  // Legacy (non-/tms) pages: pages that are not nav items get an explicit trail, every nav
  // item answers to its own label, and nothing ever reads "TMS".
  const isTms = pathname === '/tms' || pathname.startsWith('/tms/')
  if (!isTms) {
    const explicit = LEGACY_CRUMBS.find((c) => pathname === c.path || (c.prefix && pathname.startsWith(`${c.path}/`)))
    if (explicit) return explicit.crumbs
  }

  let best: NavItemDef | null = null
  for (const item of isTms ? ALL_TMS_ITEMS : ITEM_POOL) {
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
 * The businesses the company switcher offers: one per visible section, in section order,
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
 * Every nav item, once, tagged with the division that owns it. The Brokerage pages are
 * the `/tms/*` set; the legacy config's BROKERAGE rows are the old paths those replaced
 * (they stay in `navItems.ts` because they are still the permission list), so they are
 * listed here once, not twice.
 */
const ITEM_POOL: NavItemDef[] = [...TMS_ITEMS, ...NAV_ITEMS.filter((i) => i.section !== BROKERAGE)]

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
  const visible = (def: NavItemDef): boolean =>
    everything || hasPageAccess(def.pageKey) || ((def.tms === true || def.section === BROKERAGE) && canOpenTms)

  // Pinned items are never part of a business section; they render first and are gated
  // exactly like any other page, so a shared-loads grant keeps seeing Shipments.
  const pinned: NavSectionItem[] = PINNED_ITEMS.filter(visible).map((def) => ({
    to: def.to,
    label: def.label,
    icon: def.icon,
    badge: def.badge ?? null,
    pageKey: def.pageKey,
    badgeKey: def.badgeKey,
    children: def.children,
  }))

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
          to: `/tms/shipments/view/division-${division.code}`,
          label: `Shipments · ${division.name}`,
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
  return { pinned, sections }
}
