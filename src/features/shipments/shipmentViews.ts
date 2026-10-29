/**
 * Everything the one Shipments list decides without React: which statuses sit under
 * which quick-tab, how a row is matched by the search box and the filter chips, which
 * columns exist, what a CSV export of the current list looks like, and how a board row
 * is projected onto the `ShipmentViewRow` the saved department views filter.
 *
 * Status vocabulary is MVMNT's (spec §6.8); the quick-tab grouping is MVMNT's own —
 * Today's Open, Booked, Load, Disp, Unload, In Transit, Del — with the five tabs the
 * pre-MVMNT board had (All, Draft, Tender, Canceled, Voided) kept after them so nothing
 * the list could show before disappears.
 *
 * Void is the only exit a shipment has: a voided row keeps its PRO and shows under the
 * Voided tab, and under no other tab. Rows that were soft-deleted before Void existed
 * are read as voided for exactly the same reason — the PRO never leaves the book.
 */
import type {
  ApStatus,
  ArStatus,
  AssignmentType,
  LoadWorkflowStatus,
  ShipmentMode,
  ShipmentRecord,
  ShipmentStatus,
  ShipmentViewFilters,
  ShipmentViewRow,
} from '@/types/tms'
import { checkCallState } from '@/lib/checkCalls'
import { formatCents } from '@/lib/invoiceBuild'
import { SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'

/**
 * A board row: the shipment plus the facets that live on its order, its load and that
 * load's active assignment. Structural, so a plain `ShipmentRecord[]` assigns without a
 * cast and every facet filter simply matches everything when the projection is absent.
 */
export type ShipmentRow = ShipmentRecord & {
  arStatus?: ArStatus | null
  /** The active assignment's AP rung. */
  apStatus?: ApStatus | null
  assignmentType?: AssignmentType | null
  loadStatus?: LoadWorkflowStatus | null
  /** Step D — the load's tracking clock, projected onto the shipment. */
  lastUpdateAt?: string | null
  lastUpdatePlace?: string | null
  nextCheckCallAt?: string | null
  lastCheckCallAt?: string | null
  checkCallOpen?: 'OPEN' | null
  openIncidentCount?: number | null
  trackingProvider?: string | null
  /**
   * Step E. `[]` means every required document is in hand, a non-empty array names what
   * is still missing, and `null` means the gate has never run for this shipment — three
   * different answers the Docs column must not flatten into one.
   */
  docsMissing?: string[] | null
  /** Carrier uploads on this shipment still waiting on a reviewer. */
  pendingDocReviewCount?: number | null
  /** The order's first reference value — MVMNT's REFERENCE column. */
  reference?: string | null
  /** Stops on the shipment's loads. Null when the backend has not sent the stop list. */
  stopCount?: number | null
  /** The ACTIVE assignment: an outside carrier's name, or our own driver and truck. */
  carrierName?: string | null
  driverName?: string | null
  truckNumber?: string | null
  /** The order's rep, when the shipment itself carries none. */
  customerRepId?: string | null
  /** The quote this shipment was sold off, when it came from one. */
  quoteId?: string | null
  /**
   * Set only on a row that is a Load no Shipment ever claimed: the load's own id, which
   * is what such a row opens. Null or absent on every row that really is a shipment.
   */
  unlinkedLoadId?: string | null
  /** An unlinked load's own `rate`, in cents. A shipment's money lives on its order. */
  loadRateCents?: number | null
}

// ── Quick tabs ───────────────────────────────────────────────────────────────

export type BoardTabKey =
  | 'todays-open' | 'booked' | 'load' | 'disp' | 'unload' | 'transit' | 'delivered'
  | 'all' | 'draft' | 'tender' | 'canceled' | 'voided'

export interface BoardTab {
  key: BoardTabKey
  label: string
  /** Empty = every status. */
  statuses: ShipmentStatus[]
  /** Today's Open also asks the pickup to be today. */
  pickupToday?: boolean
  /** The Voided tab is the only one that shows voided shipments. */
  voided?: boolean
  /** Kept from the pre-MVMNT board; rendered after MVMNT's seven. */
  overflow?: boolean
}

/** MVMNT's seven, then the five the old board had. */
export const BOARD_TABS: BoardTab[] = [
  { key: 'todays-open', label: "Today's Open", statuses: ['OPEN', 'ON_HOLD'], pickupToday: true },
  { key: 'booked', label: 'Booked', statuses: ['BOOKED', 'PLANNED'] },
  { key: 'load', label: 'Load', statuses: ['DISPATCHED', 'LOADING'] },
  { key: 'disp', label: 'Disp', statuses: ['DISPATCHED'] },
  { key: 'unload', label: 'Unload', statuses: ['ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING'] },
  { key: 'transit', label: 'In Transit', statuses: ['PICKED_UP', 'IN_TRANSIT', 'RECOVERED'] },
  { key: 'delivered', label: 'Del', statuses: ['DELIVERED'] },
  { key: 'all', label: 'All', statuses: [], overflow: true },
  { key: 'draft', label: 'Draft', statuses: ['DRAFT'], overflow: true },
  { key: 'tender', label: 'Tender', statuses: ['TENDER_PENDING', 'TENDER_REJECTED'], overflow: true },
  { key: 'canceled', label: 'Canceled', statuses: ['CANCELED'], overflow: true },
  { key: 'voided', label: 'Voided', statuses: [], voided: true, overflow: true },
]

export function tabFor(key: BoardTabKey): BoardTab {
  return BOARD_TABS.find((t) => t.key === key) ?? BOARD_TABS[0]
}

export function isBoardTabKey(value: string | null | undefined): value is BoardTabKey {
  return BOARD_TABS.some((t) => t.key === value)
}

/**
 * When a shipment left the working set, whatever the era. `voidedAt` is step R's Void;
 * `deletedAt` is the soft delete R removed, and those rows are shown as voided rather
 * than hidden, because the PRO is permanent and the user has to be able to find it.
 */
export function voidedAtOf(row: ShipmentRow): string | null {
  return row.voidedAt ?? row.deletedAt ?? null
}

export function isVoided(row: ShipmentRow): boolean {
  return voidedAtOf(row) != null
}

/**
 * A Load that has no Shipment: created by the new-load form, the scheduler's duplicate
 * or "create load from factoring item" with no customer record matched, so nothing ever
 * minted a shipment for it. It is on this list because this list is the one list, but it
 * answers none of the questions the status tabs and the status, mode and customer chips
 * ask, and every one of them has to let it alone rather than let it pass for a shipment.
 */
export function isUnlinkedLoad(row: ShipmentRow): boolean {
  return row.unlinkedLoadId != null
}

/** What the Status column says about such a row, in the user's words. */
export const UNLINKED_LOAD_LABEL = 'Unlinked load'

/** The one line the board shows so the label is not a riddle. */
export const UNLINKED_LOAD_NOTE =
  'Unlinked load: no customer record is matched to it, so it has no shipment yet. Open it and set its customer.'

/** Local calendar day of an ISO instant, as `YYYY-MM-DD`. */
function localDay(at: Date): string {
  const month = `${at.getMonth() + 1}`.padStart(2, '0')
  const day = `${at.getDate()}`.padStart(2, '0')
  return `${at.getFullYear()}-${month}-${day}`
}

function isToday(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return false
  return localDay(at) === localDay(new Date(nowMs))
}

export function matchesTab(row: ShipmentRow, key: BoardTabKey, nowMs: number = Date.now()): boolean {
  const tab = tabFor(key)
  if (tab.voided) return isVoided(row)
  if (isVoided(row)) return false
  // An unlinked load has no shipment status, so it satisfies no status tab's meaning.
  // All is the one tab that asks nothing of a row, and the one list Ryne's rule promises.
  if (isUnlinkedLoad(row)) return key === 'all'
  if (tab.statuses.length > 0 && !tab.statuses.includes(row.status)) return false
  if (tab.pickupToday && !isToday(row.pickupAppt, nowMs)) return false
  return true
}

/** Per-tab counts for the tab strip, computed once over the rows the page holds. */
export function tabCounts(rows: readonly ShipmentRow[], nowMs: number = Date.now()): Record<BoardTabKey, number> {
  const counts = Object.fromEntries(BOARD_TABS.map((t) => [t.key, 0])) as Record<BoardTabKey, number>
  for (const row of rows) {
    for (const tab of BOARD_TABS) if (matchesTab(row, tab.key, nowMs)) counts[tab.key] += 1
  }
  return counts
}

// ── Filters ──────────────────────────────────────────────────────────────────

/**
 * The filter chips MVMNT shows, plus the toggles this board had before the re-skin.
 * Every chip is `null` when it is off, so "how many filters are on" stays the count of
 * filters that actually narrow the list.
 */
export interface BoardFilters {
  customerId: string | null
  status: ShipmentStatus | null
  /** Inclusive calendar dates (YYYY-MM-DD) matched against the appointments. */
  pickupFrom: string | null
  pickupTo: string | null
  deliveryFrom: string | null
  deliveryTo: string | null
  /** Substring of the city text, the way the user reads it on the row. */
  origin: string | null
  destination: string | null
  /** A division or subdivision code; a parent code matches its subdivision rows too. */
  division: string | null
  /** MVMNT calls it "Carrier type": own fleet, an outside carrier, or nobody yet. */
  assignmentType: AssignmentType | null
  /** Cognito username of the sales rep (or the order's customer rep). */
  repId: string | null
  arStatus: ArStatus | null
  apStatus: ApStatus | null
  mode: ShipmentMode | null
  checkCallDue: true | null
  checkCallOverdue: true | null
  openExceptions: true | null
  /**
   * "Docs missing" is the cached gate result; "Uploads to review" is work sitting in
   * the review queue, which is a different problem — paperwork that has arrived but
   * nobody has accepted.
   */
  docsMissing: true | null
  uploadsToReview: true | null
}

export const EMPTY_FILTERS: BoardFilters = {
  customerId: null, status: null,
  pickupFrom: null, pickupTo: null, deliveryFrom: null, deliveryTo: null,
  origin: null, destination: null, division: null, assignmentType: null, repId: null,
  arStatus: null, apStatus: null, mode: null,
  checkCallDue: null, checkCallOverdue: null, openExceptions: null,
  docsMissing: null, uploadsToReview: null,
}

export function activeFilterCount(f: BoardFilters): number {
  return (Object.keys(EMPTY_FILTERS) as (keyof BoardFilters)[]).filter((k) => f[k] != null && f[k] !== '').length
}

export function matchesQuery(row: ShipmentRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  // The search box reads the server-built `searchKey`, falling back to visible text.
  const hay = (row.searchKey
    ?? [row.number, row.customerName, row.originCity, row.destinationCity].filter(Boolean).join(' ')
  ).toLowerCase()
  return q.split(/\s+/).every((term) => hay.includes(term))
}

function inDateWindow(iso: string | null | undefined, from: string | null, to: string | null): boolean {
  if (!from && !to) return true
  // Appointments are ISO UTC; the list filters on the date part the user sees.
  const day = iso ? iso.slice(0, 10) : null
  if (!day) return false
  if (from && day < from) return false
  if (to && day > to) return false
  return true
}

export function matchesFilters(row: ShipmentRow, f: BoardFilters, nowMs: number = Date.now()): boolean {
  if (f.customerId && row.customerId !== f.customerId) return false
  // The status and the mode an unlinked load's row carries are placeholders the record
  // type demands, not answers; a chip that asks for either excludes such a row outright.
  if (f.status && (isUnlinkedLoad(row) || row.status !== f.status)) return false
  if (f.mode && (isUnlinkedLoad(row) || row.mode !== f.mode)) return false
  if (f.arStatus && (row.arStatus ?? null) !== f.arStatus) return false
  if (f.apStatus && (row.apStatus ?? null) !== f.apStatus) return false
  if (f.assignmentType && (row.assignmentType ?? null) !== f.assignmentType) return false
  if (f.division && row.revDivision !== f.division && row.revSubdivision !== f.division) return false
  if (f.repId && row.salesRepId !== f.repId && row.customerRepId !== f.repId) return false
  if (f.origin && !(row.originCity ?? '').toLowerCase().includes(f.origin.toLowerCase())) return false
  if (f.destination && !(row.destinationCity ?? '').toLowerCase().includes(f.destination.toLowerCase())) return false
  if (!inDateWindow(row.pickupAppt, f.pickupFrom, f.pickupTo)) return false
  if (!inDateWindow(row.deliveryAppt, f.deliveryFrom, f.deliveryTo)) return false
  if (f.checkCallDue || f.checkCallOverdue) {
    // Due vs overdue is the one state function, so the list agrees with the worklist
    // and the notifier about which side of the grace a load is on.
    const state = checkCallState({ nextCheckCallAt: row.nextCheckCallAt }, nowMs)
    if (f.checkCallOverdue && state !== 'OVERDUE') return false
    if (f.checkCallDue && !f.checkCallOverdue && state !== 'DUE' && state !== 'OVERDUE') return false
  }
  if (f.openExceptions && (row.openIncidentCount ?? 0) === 0) return false
  // A shipment whose gate has never run is not evidence of missing paperwork, so the
  // filter shows only shipments that are known to owe something.
  if (f.docsMissing && (row.docsMissing?.length ?? 0) === 0) return false
  if (f.uploadsToReview && (row.pendingDocReviewCount ?? 0) === 0) return false
  return true
}

export type SortKey =
  | 'number' | 'status' | 'customerName' | 'pickupAppt' | 'deliveryAppt'
  | 'originCity' | 'destinationCity' | 'division'
export type SortDir = 'asc' | 'desc'

const SORT_KEYS: SortKey[] = [
  'number', 'status', 'customerName', 'pickupAppt', 'deliveryAppt', 'originCity', 'destinationCity', 'division',
]

export function isSortKey(value: string | null | undefined): value is SortKey {
  return SORT_KEYS.some((k) => k === value)
}

function sortValue(row: ShipmentRow, key: SortKey): string {
  switch (key) {
    case 'pickupAppt': return row.pickupAppt ?? ''
    case 'deliveryAppt': return row.deliveryAppt ?? ''
    case 'number': return row.number ?? ''
    case 'customerName': return (row.customerName ?? '').toLowerCase()
    case 'originCity': return (row.originCity ?? '').toLowerCase()
    case 'destinationCity': return (row.destinationCity ?? '').toLowerCase()
    case 'division': return `${row.revDivision ?? ''} ${row.revSubdivision ?? ''}`.trim().toLowerCase()
    case 'status': return row.status
  }
}

export function applyBoard(
  rows: readonly ShipmentRow[],
  opts: { tab: BoardTabKey; query: string; filters: BoardFilters; sortKey: SortKey; sortDir: SortDir; nowMs?: number },
): ShipmentRow[] {
  const nowMs = opts.nowMs ?? Date.now()
  const out = rows.filter((r) =>
    matchesTab(r, opts.tab, nowMs) && matchesQuery(r, opts.query) && matchesFilters(r, opts.filters, nowMs))
  const dir = opts.sortDir === 'asc' ? 1 : -1
  return out.sort((a, b) => {
    const cmp = sortValue(a, opts.sortKey).localeCompare(sortValue(b, opts.sortKey))
    return cmp !== 0 ? cmp * dir : a.id.localeCompare(b.id)
  })
}

// ── Columns ──────────────────────────────────────────────────────────────────

export interface BoardColumn {
  key: string
  label: string
  /** The text of the cell — what the CSV writes and what a plain cell renders. */
  value: (row: ShipmentRow) => string
  sortKey?: SortKey
  width?: number
}

/** Dates render in the viewer's zone; the CSV gets the same text the screen shows. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Date and time, because a check call an hour from now and one tomorrow read alike otherwise. */
function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * Who is hauling it, in MVMNT's words: the outside carrier's name, our own driver and
 * truck when the fleet has it, and "Need to cover" while nobody does.
 */
export function carrierLabel(row: ShipmentRow): string {
  if (row.assignmentType === 'OWN_ASSET') {
    const own = [row.driverName, row.truckNumber ? `Truck ${row.truckNumber}` : null].filter(Boolean).join(' · ')
    return own || 'Own fleet'
  }
  if (row.carrierName) return row.carrierName
  return 'Need to cover'
}

/** `BROKERAGE` / `ASSETS (Box trucks)` — the division chip's text. */
export function divisionLabel(row: ShipmentRow, nameOf?: (code: string) => string): string {
  const name = (code: string) => (nameOf ? nameOf(code) : code)
  if (!row.revDivision) return ''
  return row.revSubdivision ? `${name(row.revDivision)} (${name(row.revSubdivision)})` : name(row.revDivision)
}

export function statusLabel(row: ShipmentRow): string {
  if (isVoided(row)) return 'VOIDED'
  if (isUnlinkedLoad(row)) return UNLINKED_LOAD_LABEL
  return SHIPMENT_STATUS_LABELS[row.status]
}

const titleCase = (value: string): string =>
  value.toLowerCase().replace(/(^|[\s_])(\w)/g, (_, lead: string, ch: string) => `${lead === '_' ? ' ' : lead}${ch.toUpperCase()}`)

/** MVMNT's column order. The first thirteen are the ones MVMNT shows by default. */
export const BOARD_COLUMNS: BoardColumn[] = [
  { key: 'number', label: 'Shipment ID', value: (r) => r.number ?? '', sortKey: 'number', width: 120 },
  { key: 'status', label: 'Status', value: statusLabel, sortKey: 'status', width: 110 },
  { key: 'reference', label: 'Reference', value: (r) => r.reference ?? '', width: 140 },
  { key: 'originCity', label: 'Origin', value: (r) => r.originCity ?? '', sortKey: 'originCity', width: 150 },
  { key: 'destinationCity', label: 'Destination', value: (r) => r.destinationCity ?? '', sortKey: 'destinationCity', width: 150 },
  { key: 'pickupAppt', label: 'Pick up', value: (r) => shortDate(r.pickupAppt), sortKey: 'pickupAppt', width: 100 },
  { key: 'deliveryAppt', label: 'Delivery', value: (r) => shortDate(r.deliveryAppt), sortKey: 'deliveryAppt', width: 100 },
  { key: 'stops', label: 'Stops', value: (r) => (r.stopCount == null ? '' : String(r.stopCount)), width: 70 },
  { key: 'salesRepId', label: 'Customer rep', value: (r) => r.salesRepId ?? r.customerRepId ?? '', width: 140 },
  { key: 'customerName', label: 'Customer', value: (r) => r.customerName ?? '', sortKey: 'customerName', width: 180 },
  { key: 'carrier', label: 'Carrier', value: carrierLabel, width: 180 },
  { key: 'division', label: 'Division', value: (r) => divisionLabel(r), sortKey: 'division', width: 160 },
  { key: 'driver', label: 'Driver', value: (r) => r.driverName ?? '', width: 150 },
  { key: 'truck', label: 'Truck', value: (r) => r.truckNumber ?? '', width: 100 },
  { key: 'arStatus', label: 'AR', value: (r) => (r.arStatus ? titleCase(r.arStatus) : ''), width: 120 },
  { key: 'apStatus', label: 'AP', value: (r) => (r.apStatus ? titleCase(r.apStatus) : ''), width: 120 },
  {
    key: 'lastUpdateAt',
    label: 'Last update',
    value: (r) => [shortDateTime(r.lastUpdateAt), r.lastUpdatePlace].filter(Boolean).join(' · '),
    width: 180,
  },
  { key: 'nextCheckCallAt', label: 'Next check call', value: (r) => shortDateTime(r.nextCheckCallAt), width: 160 },
  {
    key: 'openIncidentCount',
    label: 'Exceptions',
    value: (r) => ((r.openIncidentCount ?? 0) > 0 ? String(r.openIncidentCount) : ''),
    width: 110,
  },
  { key: 'mode', label: 'Mode', value: (r) => (isUnlinkedLoad(r) ? '' : r.mode), width: 90 },
  /*
   * The only rows that carry money on the row itself are the unlinked loads — a
   * shipment's revenue lives on its order, which this list does not read — so the
   * column is offered in the field picker and is not one of the thirteen defaults.
   */
  { key: 'loadRate', label: 'Load rate', value: (r) => (r.loadRateCents == null ? '' : formatCents(r.loadRateCents)), width: 110 },
  /*
   * Three states, and the CSV says which in words: nothing at all when the gate has
   * never run for this shipment, "Complete" when it has and found everything, and the
   * count when paperwork is outstanding. A blank cell is not "complete".
   */
  {
    key: 'docsMissing',
    label: 'Docs',
    value: (r) => (r.docsMissing == null ? '' : r.docsMissing.length === 0 ? 'Complete' : `${r.docsMissing.length} missing`),
    width: 120,
  },
]

/** MVMNT's thirteen visible columns. */
export const DEFAULT_COLUMN_KEYS = [
  'number', 'status', 'reference', 'originCity', 'destinationCity', 'pickupAppt', 'deliveryAppt',
  'stops', 'salesRepId', 'customerName', 'carrier', 'division', 'driver',
]

export function visibleColumns(keys: readonly string[]): BoardColumn[] {
  return BOARD_COLUMNS.filter((c) => keys.includes(c.key))
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** CSV of exactly what is on screen — same columns, same order, same rows. */
export function toCsv(rows: readonly ShipmentRow[], columnKeys: readonly string[]): string {
  const cols = visibleColumns(columnKeys)
  const lines = [cols.map((c) => csvCell(c.label)).join(',')]
  for (const row of rows) lines.push(cols.map((c) => csvCell(c.value(row))).join(','))
  return lines.join('\n')
}

// ── Department views ─────────────────────────────────────────────────────────

/** The row shape `applyViewFilters` reads, built from what the list already holds. */
export function toViewRow(row: ShipmentRow): ShipmentViewRow {
  return {
    id: row.id,
    status: row.status,
    revDivision: row.revDivision ?? null,
    revSubdivision: row.revSubdivision ?? null,
    assignmentType: row.assignmentType ?? null,
    salesRepId: row.salesRepId ?? null,
    customerRepId: row.customerRepId ?? null,
    pickupAppt: row.pickupAppt ?? null,
    docsMissing: row.docsMissing ?? [],
    arStatus: row.arStatus ?? null,
    apStatus: row.apStatus ?? null,
    trackingProvider: row.trackingProvider ?? null,
    nextCheckCallAt: row.nextCheckCallAt ?? null,
    lastCheckCallAt: row.lastCheckCallAt ?? null,
    quoteId: row.quoteId ?? null,
    searchKey: row.searchKey ?? null,
    voidedAt: voidedAtOf(row),
  }
}

/** The sidebar's per-division slice: `/tms/shipments/view/division-ASSETS`. */
export const DIVISION_VIEW_PREFIX = 'division-'

export function divisionCodeOfViewSlug(slug: string | null | undefined): string | null {
  if (!slug || !slug.startsWith(DIVISION_VIEW_PREFIX)) return null
  const code = slug.slice(DIVISION_VIEW_PREFIX.length)
  return code || null
}

/** What "Save as view" stores: the chips the user set, in the view vocabulary. */
export function filtersToViewFilters(filters: BoardFilters, query: string, tab: BoardTabKey): ShipmentViewFilters {
  const out: ShipmentViewFilters = {}
  const statuses = filters.status ? [filters.status] : tabFor(tab).statuses
  if (statuses.length > 0) out.statuses = [...statuses]
  if (filters.division) out.divisions = [filters.division]
  if (filters.assignmentType) out.carrierType = filters.assignmentType === 'OWN_ASSET' ? 'OWN_FLEET' : filters.assignmentType
  if (filters.repId) out.repId = filters.repId
  if (filters.arStatus) out.arStatuses = [filters.arStatus]
  if (filters.apStatus) out.apStatuses = [filters.apStatus]
  if (filters.docsMissing) out.docsState = 'DOCS_NEEDED'
  if (filters.checkCallOverdue) out.trackingState = 'OVERDUE'
  if (query.trim()) out.search = query.trim()
  return out
}
