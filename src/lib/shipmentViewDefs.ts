/**
 * Department views: the saved slices of the one Shipments page.
 *
 * Ryne, 2026-10-28: every department opens the list it cares about — dispatch sees
 * today and tomorrow on the own fleet, tracking sees what is rolling, accounting
 * sees what is billable. Those are ROWS, not code: adding a department is adding a
 * `ShipmentView`, and the sidebar, the view tabs and the audience all read it.
 *
 * This file is the pure half: the filter engine the page runs, who may see a view,
 * and the ten seed views. The rows it filters are `ShipmentViewRow` — a flat shape
 * the board maps its own rows onto, so the filters never learn how a board row is
 * assembled.
 *
 * A VOIDED shipment is never in a view. Void is the only exit from the working set
 * (the PRO, the history and the documents all stay), and a view is a working list.
 *
 * Imports are relative and type-only: the tmsDirectoryActions Lambda bundles this
 * file by path, so a `@/` alias would break the function build.
 */
import type {
  ShipmentViewAudience,
  ShipmentViewFilters,
  ShipmentViewPickupWindow,
  ShipmentViewRecord,
  ShipmentViewRow,
  ShipmentStatus,
} from '../types/tms'

/** View rows as the seed carries them: no audit columns, the server adds those. */
export type ShipmentViewSeed = Omit<
  ShipmentViewRecord,
  'createdBy' | 'updatedBy' | 'version' | 'createdAt' | 'updatedAt'
>

/** Who a view is for. Owner and ADMIN always see every active view. */
export interface ViewCaller {
  groups: string[]
  role: string | null
  isOwner: boolean
  isAdmin: boolean
}

const SHIPMENT_STATUSES: Record<string, boolean> = {
  DRAFT: true, TENDER_PENDING: true, TENDER_REJECTED: true, OPEN: true, ON_HOLD: true,
  BOOKED: true, PLANNED: true, DISPATCHED: true, LOADING: true, PICKED_UP: true,
  IN_TRANSIT: true, RECOVERED: true, ARRIVED_AT_DELIVERY_TERMINAL: true,
  OUT_FOR_DELIVERY: true, UNLOADING: true, DELIVERED: true, CANCELED: true,
}

/** Dispatched through unloading: the freight is moving and somebody is tracking it. */
export const IN_TRANSIT_STATUSES: ShipmentStatus[] = [
  'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING',
]

const nonEmpty = (list: string[] | null | undefined): boolean => Array.isArray(list) && list.length > 0

/** Local midnight `days` from the day `at` falls in. */
function addDays(at: Date, days: number): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days)
}

/** The half-open [from, to) window a pickup window names, in local time. */
function pickupRange(window: ShipmentViewPickupWindow, now: Date): { from: Date; to: Date } {
  const today = addDays(now, 0)
  switch (window) {
    case 'today':
      return { from: today, to: addDays(today, 1) }
    case 'tomorrow':
      return { from: addDays(today, 1), to: addDays(today, 2) }
    case 'today_tomorrow':
      return { from: today, to: addDays(today, 2) }
    case 'this_week': {
      // Weeks start Monday — the dispatch week everybody here already works to.
      const offset = (today.getDay() + 6) % 7
      const monday = addDays(today, -offset)
      return { from: monday, to: addDays(monday, 7) }
    }
    case 'this_month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from, to: new Date(now.getFullYear(), now.getMonth() + 1, 1) }
    }
    case 'last_30_days':
      return { from: addDays(today, -30), to: addDays(today, 1) }
    default:
      return { from: today, to: addDays(today, 1) }
  }
}

function inPickupWindow(appt: string | null, window: ShipmentViewPickupWindow, now: Date): boolean {
  if (!appt) return false
  const at = new Date(appt)
  if (Number.isNaN(at.getTime())) return false
  const { from, to } = pickupRange(window, now)
  return at.getTime() >= from.getTime() && at.getTime() < to.getTime()
}

const isTracked = (row: ShipmentViewRow): boolean =>
  row.trackingProvider != null && row.trackingProvider !== '' && row.trackingProvider !== 'NONE'

/**
 * The rows a view shows. Absent clauses filter nothing; a voided shipment is never
 * shown. `now` is injected so the date windows are testable and so a board that
 * renders for a while does not drift mid-render.
 */
export function applyViewFilters(
  filters: ShipmentViewFilters | null | undefined,
  rows: ShipmentViewRow[],
  now: Date = new Date(),
): ShipmentViewRow[] {
  const f = filters ?? {}
  const search = typeof f.search === 'string' && f.search.trim() !== '' ? f.search.trim().toLowerCase() : null
  const nowMs = now.getTime()

  return rows.filter((row) => {
    if (row.voidedAt) return false
    if (nonEmpty(f.divisions) && !(f.divisions as string[]).includes(row.revDivision ?? '')) return false
    if (nonEmpty(f.subdivisions) && !(f.subdivisions as string[]).includes(row.revSubdivision ?? '')) return false
    if (nonEmpty(f.statuses) && !(f.statuses as string[]).includes(row.status)) return false

    if (f.carrierType) {
      const wanted = f.carrierType === 'OWN_FLEET' ? 'OWN_ASSET' : f.carrierType
      if (row.assignmentType !== wanted) return false
    }

    if (f.repId && row.salesRepId !== f.repId && row.customerRepId !== f.repId) return false

    if (f.pickupWindow && !inPickupWindow(row.pickupAppt, f.pickupWindow, now)) return false

    if (f.docsState) {
      const missing = row.docsMissing ?? []
      if (f.docsState === 'POD_MISSING' && !missing.includes('POD')) return false
      if (f.docsState === 'DOCS_NEEDED' && missing.length === 0) return false
      if (f.docsState === 'COMPLETE' && missing.length > 0) return false
    }

    if (f.trackingState) {
      if (f.trackingState === 'TRACKED' && !isTracked(row)) return false
      if (f.trackingState === 'UNTRACKED' && isTracked(row)) return false
      if (f.trackingState === 'OVERDUE') {
        const due = row.nextCheckCallAt ? new Date(row.nextCheckCallAt).getTime() : NaN
        if (Number.isNaN(due) || due >= nowMs) return false
      }
    }

    if (nonEmpty(f.arStatuses) && !(f.arStatuses as string[]).includes(row.arStatus ?? '')) return false
    if (nonEmpty(f.apStatuses) && !(f.apStatuses as string[]).includes(row.apStatus ?? '')) return false
    if (f.quoteToBooked && !row.quoteId) return false
    if (search && !(row.searchKey ?? '').toLowerCase().includes(search)) return false
    return true
  })
}

function audienceAllows(audience: ShipmentViewAudience | null, caller: ViewCaller): boolean {
  if (!audience) return true
  const groups = audience.groups ?? []
  const roles = audience.roles ?? []
  // No groups and no roles named: the view is for everyone who can open Shipments.
  // `audience.divisions` only groups the view in the sidebar — it never hides it.
  if (groups.length === 0 && roles.length === 0) return true
  if (groups.some((g) => caller.groups.includes(g))) return true
  return caller.role != null && roles.includes(caller.role)
}

/** The active views this caller may open, in `sortOrder`. */
export function viewsVisibleTo(views: ShipmentViewRecord[], caller: ViewCaller): ShipmentViewRecord[] {
  return views
    .filter((v) => v.active && (caller.isOwner || caller.isAdmin || audienceAllows(v.audience, caller)))
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/** `'POD collection'` → `'pod-collection'`. The slug IS the view's id and its URL. */
export function slugify(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Everything wrong with a view, in plain English. Empty = it is saveable. */
export function validateView(view: Partial<ShipmentViewSeed>): string[] {
  const errors: string[] = []
  const name = (view.name ?? '').trim()
  if (name === '') errors.push('The view needs a name.')

  const slug = (view.slug ?? '').trim()
  if (slug === '') errors.push('The view needs a slug.')
  else if (slug !== slugify(slug)) errors.push(`"${slug}" is not a valid slug — use ${slugify(slug) || 'letters and numbers'}.`)

  for (const status of view.filters?.statuses ?? []) {
    if (!SHIPMENT_STATUSES[status]) errors.push(`"${status}" is not a shipment status.`)
  }

  const dir = view.sort?.dir
  if (view.sort && dir !== 'asc' && dir !== 'desc') errors.push('The sort direction must be asc or desc.')
  if (view.sort && (view.sort.key ?? '').trim() === '') errors.push('The sort needs a column.')

  if (typeof view.sortOrder === 'number' && !Number.isFinite(view.sortOrder)) {
    errors.push('The sort order must be a number.')
  }
  return errors
}

// ── Seed views ───────────────────────────────────────────────────────────────
// The ten department slices Ryne named. Seed data, not constants: an admin edits
// them, archives them and adds their own from My Brokerage → Shipment views.

const seed = (
  slug: string,
  name: string,
  department: string,
  description: string,
  sortOrder: number,
  filters: ShipmentViewFilters,
  extra: Partial<ShipmentViewSeed> = {},
): ShipmentViewSeed => ({
  id: slug,
  slug,
  name,
  department,
  description,
  filters,
  columns: null,
  sort: null,
  isDefault: false,
  // Everyone who can open Shipments; an admin narrows it per view afterwards.
  audience: null,
  sortOrder,
  active: true,
  ...extra,
})

export const SEED_VIEWS: ShipmentViewSeed[] = [
  seed('dispatch', 'Dispatch', 'Dispatch',
    "Ivan Cartage's own trucks, picking up today or tomorrow.", 10,
    { divisions: ['ASSETS'], pickupWindow: 'today_tomorrow' }),
  seed('tracking', 'Tracking', 'Tracking',
    'Everything rolling that somebody is tracking.', 20,
    { statuses: IN_TRANSIT_STATUSES, trackingState: 'TRACKED' }),
  seed('pod-collection', 'POD collection', 'Documents',
    'Delivered, with the POD still outstanding.', 30,
    { statuses: ['DELIVERED'], docsState: 'POD_MISSING' }),
  seed('accounting', 'Accounting', 'Accounting',
    'Docs needed, unbilled and unpaid — the AR worklist.', 40,
    { arStatuses: ['DOCS_NEEDED', 'UNBILLED', 'UNPAID'] }),
  seed('sales', 'Sales', 'Sales',
    'Quotes that became shipments, by rep.', 50,
    { quoteToBooked: true },
    { sort: { key: 'salesRepId', dir: 'asc' } }),
  seed('brokerage-board', 'Brokerage board', 'Brokerage',
    'Everything earned by BCAT Logistics.', 60,
    { divisions: ['BROKERAGE'] }),
  seed('car-shipping-board', 'Car shipping board', 'Car shipping',
    'Everything earned by Best Care Auto Transport.', 70,
    { divisions: ['CAR_SHIPPING'] }),
  seed('owner-operators', 'Owner operators', 'Assets',
    "Ivan Cartage's owner-operator work.", 80,
    { subdivisions: ['OWNER_OPERATOR'] }),
  seed('box-trucks', 'Box trucks', 'Assets',
    "Ivan Cartage's box-truck work.", 90,
    { subdivisions: ['BOX_TRUCK'] }),
  seed('local-drivers', 'Local drivers', 'Assets',
    "Ivan Cartage's local drivers.", 100,
    { subdivisions: ['LOCAL'] }),
]
