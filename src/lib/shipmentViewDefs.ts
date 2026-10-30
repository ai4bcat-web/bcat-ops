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
  AssignmentType,
  BoardDateFilter,
  BoardDetailFilter,
  BoardDetailKey,
  BoardFilterSet,
  BoardStatusKey,
  ShipmentStatus,
  ShipmentViewAudience,
  ShipmentViewFilters,
  ShipmentViewPickupWindow,
  ShipmentViewRecord,
  ShipmentViewRow,
} from '../types/tms'
import type { Stop } from '../types'
import { regionOfState } from './usRegions'
import { checkCallState } from './checkCalls'

/** View rows as the seed carries them: no audit columns, the server adds those. */
export type ShipmentViewSeed = Omit<
  ShipmentViewRecord,
  'createdBy' | 'updatedBy' | 'version' | 'createdAt' | 'updatedAt'
>

/** Who a view is for. Owner and ADMIN always see every active view. */
export interface ViewCaller {
  groups: string[]
  role: string | null
  /** The OwnershipDivision codes this person works in, off their `UserProfile`. */
  divisions: string[]
  isOwner: boolean
  isAdmin: boolean
}

/** A role is data on the profile, projected onto exactly one `role-<ROLE>` group. */
const ROLE_GROUP_PREFIX = 'role-'

/**
 * The caller an audience is matched against, built from the signed-in token and the
 * profile. The role is read off the Cognito groups rather than the profile row because
 * the token is the only thing a gate may trust, and it is derived here — once — so the
 * sidebar and the Shipments page can never disagree about which views exist.
 */
export function viewCallerOf(input: {
  groups?: string[] | null
  divisions?: string[] | null
  isOwner: boolean
  isAdmin: boolean
}): ViewCaller {
  const groups = input.groups ?? []
  const roleGroup = groups.find((g) => g.startsWith(ROLE_GROUP_PREFIX))
  return {
    groups,
    role: roleGroup ? roleGroup.slice(ROLE_GROUP_PREFIX.length) : null,
    divisions: input.divisions ?? [],
    isOwner: input.isOwner,
    isAdmin: input.isAdmin,
  }
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

// ── R2 board status and filters ──────────────────────────────────────────────
// These live here so the tms-directory-actions Lambda can bundle them without
// pulling in the aliased UI module. Keep every import above relative and alias-free.

/**
 * The single status the Aljex-style board checkboxes, Status column and row tone all
 * read. VOIDED wins over everything; CANCELED without a void keeps its own label and is
 * matched by no status checkbox.
 */
export function boardStatusOf(row: {
  status: ShipmentStatus
  voidedAt?: string | null
  deletedAt?: string | null
  assignmentType?: AssignmentType | null
}): BoardStatusKey | 'CANCELED' {
  if (row.voidedAt) return 'VOIDED'
  if (row.deletedAt) return 'VOIDED'
  if (row.status === 'CANCELED') return 'CANCELED'
  if (row.status === 'ON_HOLD') return 'HOLD'
  if (row.status === 'DELIVERED') return 'DELIVERED'
  if (['ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING'].includes(row.status)) return 'ARRIVED'
  if (['PICKED_UP', 'IN_TRANSIT', 'RECOVERED'].includes(row.status)) return 'DEPARTED'
  if (['DISPATCHED', 'LOADING'].includes(row.status)) return 'DISPATCHED'
  if (['BOOKED', 'PLANNED'].includes(row.status)) {
    if (row.assignmentType === 'OWN_ASSET') return 'RESERVED'
    if (row.assignmentType === 'CARRIER') return 'COVERED'
    return 'OPEN'
  }
  return 'OPEN'
}

/**
 * The row shape the board filter matcher actually reads. Both the board's
 * `ShipmentRow` and the extended `ShipmentViewRow` satisfy it, so saved views can run
 * the same filter code without importing the full shipment type.
 */
interface BoardFilterableRow {
  status: ShipmentStatus
  voidedAt?: string | null
  deletedAt?: string | null
  customerId?: string | null
  carrierName?: string | null
  pickupName?: string | null
  consigneeName?: string | null
  fromState?: string | null
  toState?: string | null
  revDivision?: string | null
  revSubdivision?: string | null
  equipmentType?: string | null
  officeTeamKeys?: string[] | null
  salesRepId?: string | null
  customerRepId?: string | null
  dispatcherAssignedId?: string | null
  dispatcherActualId?: string | null
  shipDate?: string | null
  pickupAppt?: string | null
  deliveryAppt?: string | null
  createdAt?: string | null
  stops?: Stop[] | null
  nextCheckCallAt?: string | null
  openIncidentCount?: number | null
  docsMissing?: string[] | null
}

export function detailValuesFor(row: BoardFilterableRow, key: BoardDetailKey): string[] {
  switch (key) {
    case 'customer': return row.customerId != null ? [row.customerId] : []
    case 'carrier': return row.carrierName ? [row.carrierName] : []
    case 'pickupName': return row.pickupName ? [row.pickupName] : []
    case 'consigneeName': return row.consigneeName ? [row.consigneeName] : []
    case 'fromStates': return row.fromState ? [row.fromState] : []
    case 'toStates': return row.toState ? [row.toState] : []
    case 'revenueType': {
      const out: string[] = []
      if (row.revDivision) out.push(row.revDivision)
      if (row.revSubdivision) out.push(row.revSubdivision)
      return out
    }
    case 'equipment': return row.equipmentType ? [row.equipmentType] : []
    case 'office': return row.officeTeamKeys ?? []
    case 'fromRegion': {
      const r = regionOfState(row.fromState ?? null)
      return r ? [r] : []
    }
    case 'toRegion': {
      const r = regionOfState(row.toState ?? null)
      return r ? [r] : []
    }
    case 'salesRep': return row.salesRepId ? [row.salesRepId] : []
    case 'serviceRep': return row.customerRepId ? [row.customerRepId] : []
    case 'dispatcherAssigned': return row.dispatcherAssignedId ? [row.dispatcherAssignedId] : []
    case 'dispatcherActual': return row.dispatcherActualId ? [row.dispatcherActualId] : []
  }
}

function dateField(row: BoardFilterableRow, key: 'ship' | 'pickup' | 'delivery' | 'created'): string | null {
  switch (key) {
    case 'ship': return row.shipDate ?? null
    case 'pickup': return row.pickupAppt ?? null
    case 'delivery': return row.deliveryAppt ?? null
    case 'created': return row.createdAt ?? null
  }
}

function localDayOf(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function matchesDateFilter(iso: string | null, filter: BoardDateFilter, _now: Date): boolean {
  const day = localDayOf(iso)
  if (filter.mode === 'FIXED') {
    if (!filter.date) return true
    return day === filter.date
  }
  // RANGE inclusive of both ends; missing end is open.
  if (!day) return false
  if (filter.from && day < filter.from) return false
  if (filter.to && day > filter.to) return false
  return true
}

/**
 * Apply one R2 board filter set to one row. Empty statuses match every status except
 * VOIDED; VOIDED only matches when it is named. A detail filter with no values is
 * ignored. An exclusion inverts one facet: a null/unknown facet is kept by an exclusion
 * and dropped by an inclusion. Dates match in the viewer's local calendar day; RANGE is
 * inclusive with open ends.
 */
export function matchesBoardFilters<R extends BoardFilterableRow>(row: R, set: BoardFilterSet, now: Date): boolean {
  const status = boardStatusOf(row)
  if (status === 'VOIDED') return set.statuses.includes('VOIDED')
  if (status === 'CANCELED') return set.statuses.length === 0
  if (set.statuses.length > 0 && !set.statuses.includes(status)) return false

  for (const [key, filter] of Object.entries(set.details) as [BoardDetailKey, BoardDetailFilter | undefined][]) {
    if (!filter || filter.values.length === 0) continue
    const rowValues = detailValuesFor(row, key)
    const hasMatch = rowValues.some((value) => filter.values.includes(value))
    if (filter.exclude) {
      // An empty/unknown facet is kept by an exclusion.
      if (rowValues.length === 0) continue
      if (hasMatch) return false
    } else {
      // An empty/unknown facet is dropped by an inclusion.
      if (rowValues.length === 0) return false
      if (!hasMatch) return false
    }
  }

  for (const [key, filter] of Object.entries(set.dates) as [
    'ship' | 'pickup' | 'delivery' | 'created',
    BoardDateFilter | undefined,
  ][]) {
    if (!filter) continue
    const iso = dateField(row, key)
    if (!matchesDateFilter(iso, filter, now)) return false
  }

  if (set.flags) {
    const { checkCallDue, checkCallOverdue, openExceptions, docsMissing } = set.flags
    if (checkCallDue || checkCallOverdue) {
      const state = checkCallState(row, now.getTime())
      if (checkCallOverdue && state !== 'OVERDUE') return false
      if (checkCallDue && state !== 'DUE' && state !== 'OVERDUE') return false
    }
    if (openExceptions && (row.openIncidentCount ?? 0) === 0) return false
    if (docsMissing && (row.docsMissing?.length ?? 0) === 0) return false
  }

  return true
}

/** Aljex Active Shipments default column order. */
export const ALJEX_COLUMN_KEYS = [
  'exceptions', 'status', 'proNumber', 'massRelease', 'equip', 'customerReference', 'description',
  'revenueType', 'salesRep', 'customerName', 'carrier', 'customerTotalRate', 'carrierTotalRates',
  'grossProfit', 'netMargin', 'pickupShip', 'originCity', 'destinationCity', 'deliveryAppt', 'stops',
  'driver', 'truck', 'arStatus', 'apStatus', 'lastUpdateAt', 'nextCheckCallAt', 'mode', 'docsMissing',
]

/**
 * Every valid board column key the R2 shipments board can render. Column templates
 * saved from the UI are validated against this list, so it must stay in sync with
 * `BOARD_COLUMNS` in the UI module without importing that aliased module — the test
 * in this file fails the moment the two drift apart.
 */
export const BOARD_COLUMN_KEYS = [
  // The original MVMNT and Aljex-board columns, in the catalog's order.
  'number', 'exceptions', 'status', 'proNumber', 'massRelease', 'equip', 'customerReference',
  'description', 'revenueType', 'salesRep', 'customerName', 'carrier', 'customerTotalRate',
  'carrierTotalRates', 'grossProfit', 'netMargin', 'pickupShip', 'originCity', 'destinationCity',
  'pickupAppt', 'deliveryAppt', 'stops', 'salesRepId', 'division', 'driver', 'truck', 'arStatus',
  'apStatus', 'lastUpdateAt', 'nextCheckCallAt', 'openIncidentCount', 'mode', 'docsMissing',
  // Shipment.
  'previousStatus', 'statusChangedAt', 'statusChangedBy', 'holdReason', 'voidReason',
  'pickupMonth', 'originState', 'destinationState', 'source', 'customerLinkSentAt',
  'deliveredAt', 'lastNoticeAt', 'revSubdivision', 'revTagSource', 'datPostedAt',
  'voidedAt', 'voidedBy', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
  // Order.
  'billTo', 'costCenter', 'rateType', 'refPo', 'refPu', 'refDelivery', 'refBol',
  'equipmentLength', 'specialRequirements', 'freightCommodity', 'freightWeight',
  'freightPieces', 'freightPallets', 'customerNotes', 'internalNotes', 'customerRate',
  'orderRevenue', 'arStatusChangedAt', 'invoiceNumber', 'invoicedAt', 'paidAt', 'arBalance',
  'factoringItem', 'docsRequired', 'docsCheckedAt', 'docsOverride', 'quoteNumber', 'quoteAmount',
  // Load.
  'loadAljexId', 'loadTmsId', 'pickupNumber', 'originName', 'destinationName',
  'pickupApptEnd', 'pickupApptType', 'deliveryApptEnd', 'deliveryApptType',
  'pickupDriver', 'deliveryDriver', 'loadTrailer', 'loadRate', 'miles', 'hot',
  'loadCommodity', 'loadWeight', 'loadPieces', 'paperworkLocation', 'eldReviewedAt',
  'eldReviewedBy', 'readyToInvoice', 'rateConOnFile', 'assignmentType', 'divisionKey',
  'trackingProvider', 'nextCheckCallNote', 'checkCallOpen', 'lastCheckCallAt',
  'lastCheckCallType', 'lastKnownAt', 'lastKnownCity', 'lastKnownState', 'lastKnownSource',
  'loadDeliveredAt', 'cargoValue', 'loadNotes', 'podNotes',
  // Carrier leg.
  'carrierName', 'carrierMc', 'carrierRep', 'carrierDispatcher', 'carrierDispatcherPhone',
  'carrierDispatcherEmail', 'driverPhone', 'driver2', 'driver2Phone', 'trailerNumber',
  'plates', 'vin', 'seal', 'tripNumber', 'pickupEta', 'deliveryEta', 'rateConStatus',
  'rateConSentAt', 'rateConSignedAt', 'carrierRate', 'legCost', 'apBalance', 'apPaidAt',
  'quickPay', 'paymentTerms', 'bookedAt', 'dispatchedAt', 'trackingStartedAt',
  'trackingStoppedAt', 'podRequestedAt', 'legDocs', 'rating',
  // Customer.
  'customerMc', 'customerDot', 'customerFactored', 'customerPaymentTerms', 'creditLimit',
  'creditHold', 'customerStatus', 'serviceTier', 'customerTeam', 'customerOwners',
  'defaultSalesRep', 'invoiceFrequency',
  // Carrier.
  'carrierDot', 'carrierScac', 'carrierStatus', 'authorityStatus', 'safetyRating',
  'cargoInsuranceExpiry', 'liabilityInsuranceExpiry', 'mcpStatus', 'highwayStatus',
  'rmisStatus', 'quickPayEligible', 'carrierTeam', 'carrierOwners', 'carrierLoadCount',
  'carrierLastLoadAt',
  // Computed.
  'stopProgress', 'daysInStatus', 'docsNeededCount', 'podPresent', 'rateConPresent',
  'postedBoards', 'nextEvent', 'trackingMotion',
]

/**
 * The rows a view shows. Absent clauses filter nothing; a voided shipment is never
 * shown unless the R2 board filter explicitly names VOIDED. `now` is injected so the
 * date windows are testable and so a board that renders for a while does not drift
 * mid-render.
 */
export function applyViewFilters(
  filters: ShipmentViewFilters | null | undefined,
  rows: ShipmentViewRow[],
  now: Date = new Date(),
): ShipmentViewRow[] {
  const f = filters ?? {}
  const search = typeof f.search === 'string' && f.search.trim() !== '' ? f.search.trim().toLowerCase() : null
  const nowMs = now.getTime()
  const voidedAllowed = f.board?.statuses.includes('VOIDED') ?? false

  return rows.filter((row) => {
    if (row.voidedAt && !voidedAllowed) return false
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

    if (f.board && !matchesBoardFilters(row, f.board, now)) return false
    return true
  })
}

/**
 * The facets have two different jobs, and the order below is the precedence.
 * `divisions` NARROWS: a view that names divisions belongs to those businesses, so it
 * is hidden from anybody who works in none of them even if a group or a role would
 * otherwise let them in. `groups` and `roles` ADMIT: within what the divisions leave,
 * either one matching is enough. Naming neither groups nor roles admits everyone the
 * divisions allowed, and an audience that names nothing at all is for everyone who can
 * open Shipments. Owner and ADMIN never reach here — `viewsVisibleTo` lets them past.
 */
function audienceAllows(audience: ShipmentViewAudience | null, caller: ViewCaller): boolean {
  if (!audience) return true
  const groups = audience.groups ?? []
  const roles = audience.roles ?? []
  const divisions = audience.divisions ?? []
  if (divisions.length > 0 && !divisions.some((code) => caller.divisions.includes(code))) return false
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

/**
 * Seeded views that R2's follow-up retired, by id. They are deactivated rather than
 * deleted, because somebody may have bookmarked one and an archived view still
 * answers for its slug. A view an admin wrote is never in this list.
 */
export const RETIRED_SEED_VIEWS = ['dispatch', 'tracking', 'pod-collection', 'accounting', 'sales'] as const

/**
 * Step P2. The two placeholders a shared queue view carries on the
 * `dispatcherAssigned` facet. `useBoardFilters` swaps them for the signed-in
 * user's Cognito username and their team's reps before the facet is applied; a
 * view that still carries one after resolution matches nothing, which is the
 * honest answer for a user who is on no team.
 */
export const ME_SENTINEL = '@me'
export const MY_TEAM_SENTINEL = '@myteam'

export const SEED_VIEWS: ShipmentViewSeed[] = [
  seed('active-shipments', 'Active Shipments', 'Shipments',
    'The default Aljex-style board: open, covered, in transit and delivered (Hold and Reserved off).', 0,
    {
      board: {
        statuses: ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED', 'DELIVERED'],
        details: {},
        dates: {},
      },
    },
    { columns: ALJEX_COLUMN_KEYS, isDefault: true }),
  // Step P2. The queue IS the board: a rep's work is a filter set on
  // `dispatcherAssigned`, not a second list that can disagree with the board.
  // `@me` and `@myteam` are resolved to the signed-in user by `useBoardFilters`
  // — a seeded view is one row for everybody, so the sentinel is the only way a
  // shared view can mean "mine" without minting a view per rep.
  seed('my-queue', 'My queue', 'Shipments',
    'Everything assigned to you to cover, from Open through Delivered.', 10,
    {
      board: {
        statuses: ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED'],
        details: { dispatcherAssigned: { values: [ME_SENTINEL], exclude: false } },
        dates: {},
      },
    },
    { columns: ALJEX_COLUMN_KEYS }),
  seed('team-queue', 'Team queue', 'Shipments',
    "Everything assigned to your carrier team, however it is split between you.", 20,
    {
      board: {
        statuses: ['OPEN', 'COVERED', 'DISPATCHED', 'ARRIVED', 'DEPARTED'],
        details: { dispatcherAssigned: { values: [MY_TEAM_SENTINEL], exclude: false } },
        dates: {},
      },
    },
    { columns: ALJEX_COLUMN_KEYS }),
  // Dispatch, Tracking and Documents are workstation pages now, each with its own UI
  // (R2 follow-up); Accounting and Sales left the Shipments menu for the AR/AP queues
  // and the quote flow that already own them. The seed sweep deactivates them.
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
