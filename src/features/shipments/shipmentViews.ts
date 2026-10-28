/**
 * Everything the shipments board decides without React: which statuses sit under which
 * tab, how a row is matched by the search box and the filter rail, which columns exist,
 * what a CSV export of the current view looks like, and where this user's saved views
 * live. Pure functions so the board stays a thin renderer and the rules are testable.
 *
 * Status vocabulary is MVMNT's (spec §6.8); the tab grouping is the operational one —
 * what needs work (Draft/Tender/Open/Hold), what is moving (Booked/In transit), and
 * what is finished (Delivered/Canceled).
 */
import type {
  ArStatus,
  AssignmentType,
  LoadWorkflowStatus,
  ShipmentMode,
  ShipmentRecord,
  ShipmentStatus,
} from '@/types/tms'
import { checkCallState } from '@/lib/checkCalls'

/**
 * A board row: the shipment plus the two facets that live on its order and its load.
 * Structural, so a plain `ShipmentRecord[]` from the hook assigns without a cast and the
 * AR / assignment filters simply match everything when the projection is absent.
 */
export type ShipmentRow = ShipmentRecord & {
  arStatus?: ArStatus | null
  assignmentType?: AssignmentType | null
  loadStatus?: LoadWorkflowStatus | null
  /** Step D — the load's tracking clock, projected onto the shipment. */
  lastUpdateAt?: string | null
  lastUpdatePlace?: string | null
  nextCheckCallAt?: string | null
  checkCallOpen?: 'OPEN' | null
  openIncidentCount?: number | null
  /**
   * Step E. `[]` means every required document is in hand, a non-empty array names what
   * is still missing, and `null` means the gate has never run for this shipment — three
   * different answers the Docs column must not flatten into one.
   */
  docsMissing?: string[] | null
  /** Carrier uploads on this shipment still waiting on a reviewer. */
  pendingDocReviewCount?: number | null
}

export type BoardTabKey =
  | 'all' | 'draft' | 'tender' | 'open' | 'hold' | 'booked' | 'transit' | 'delivered' | 'canceled'

export interface BoardTab {
  key: BoardTabKey
  label: string
  /** Empty = every status (the All tab). */
  statuses: ShipmentStatus[]
}

/** In-transit covers every movement label between dispatch and the drop. */
const TRANSIT_STATUSES: ShipmentStatus[] = [
  'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY', 'UNLOADING',
]

export const BOARD_TABS: BoardTab[] = [
  { key: 'all', label: 'All', statuses: [] },
  { key: 'draft', label: 'Draft', statuses: ['DRAFT'] },
  { key: 'tender', label: 'Tender', statuses: ['TENDER_PENDING', 'TENDER_REJECTED'] },
  { key: 'open', label: 'Open', statuses: ['OPEN'] },
  { key: 'hold', label: 'On hold', statuses: ['ON_HOLD'] },
  { key: 'booked', label: 'Booked', statuses: ['BOOKED', 'PLANNED'] },
  { key: 'transit', label: 'In transit', statuses: TRANSIT_STATUSES },
  { key: 'delivered', label: 'Delivered', statuses: ['DELIVERED'] },
  { key: 'canceled', label: 'Canceled', statuses: ['CANCELED'] },
]

export function tabFor(key: BoardTabKey): BoardTab {
  return BOARD_TABS.find((t) => t.key === key) ?? BOARD_TABS[0]
}

/** Deleted shipments never show on the board; Restore is reached by id from the admin menu. */
export function isBoardVisible(row: ShipmentRow): boolean {
  return !row.deletedAt
}

export function matchesTab(row: ShipmentRow, key: BoardTabKey): boolean {
  const tab = tabFor(key)
  return tab.statuses.length === 0 || tab.statuses.includes(row.status)
}

/** Per-tab counts for the tab strip, computed once over the visible rows. */
export function tabCounts(rows: readonly ShipmentRow[]): Record<BoardTabKey, number> {
  const counts = Object.fromEntries(BOARD_TABS.map((t) => [t.key, 0])) as Record<BoardTabKey, number>
  for (const row of rows) {
    if (!isBoardVisible(row)) continue
    for (const tab of BOARD_TABS) {
      if (tab.statuses.length === 0 || tab.statuses.includes(row.status)) counts[tab.key] += 1
    }
  }
  return counts
}

export interface BoardFilters {
  customerId: string | null
  /** Inclusive calendar dates (YYYY-MM-DD) matched against the pickup appointment. */
  pickupFrom: string | null
  pickupTo: string | null
  mode: ShipmentMode | null
  arStatus: ArStatus | null
  assignmentType: AssignmentType | null
  /**
   * Step D toggles. `null` is off — they are never stored as `false`, so the "how many
   * filters are on" count stays the count of filters that actually narrow the board.
   */
  checkCallDue: true | null
  checkCallOverdue: true | null
  openExceptions: true | null
  /**
   * Step E toggles, same `null`-is-off rule. "Docs missing" is the cached gate result;
   * "Uploads to review" is work sitting in the review queue, which is a different
   * problem — paperwork that has arrived but nobody has accepted.
   */
  docsMissing: true | null
  uploadsToReview: true | null
}

export const EMPTY_FILTERS: BoardFilters = {
  customerId: null, pickupFrom: null, pickupTo: null, mode: null, arStatus: null, assignmentType: null,
  checkCallDue: null, checkCallOverdue: null, openExceptions: null,
  docsMissing: null, uploadsToReview: null,
}

export function activeFilterCount(f: BoardFilters): number {
  return (Object.keys(EMPTY_FILTERS) as (keyof BoardFilters)[]).filter((k) => f[k] != null && f[k] !== '').length
}

export function matchesQuery(row: ShipmentRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  // The board search box reads the server-built `searchKey`, falling back to visible text.
  const hay = (row.searchKey
    ?? [row.number, row.customerName, row.originCity, row.destinationCity].filter(Boolean).join(' ')
  ).toLowerCase()
  return q.split(/\s+/).every((term) => hay.includes(term))
}

export function matchesFilters(row: ShipmentRow, f: BoardFilters): boolean {
  if (f.customerId && row.customerId !== f.customerId) return false
  if (f.mode && row.mode !== f.mode) return false
  if (f.arStatus && (row.arStatus ?? null) !== f.arStatus) return false
  if (f.assignmentType && (row.assignmentType ?? null) !== f.assignmentType) return false
  if (f.pickupFrom || f.pickupTo) {
    // Appointments are ISO UTC; the board filters on the date part the user sees.
    const day = row.pickupAppt ? row.pickupAppt.slice(0, 10) : null
    if (!day) return false
    if (f.pickupFrom && day < f.pickupFrom) return false
    if (f.pickupTo && day > f.pickupTo) return false
  }
  if (f.checkCallDue || f.checkCallOverdue) {
    // Due vs overdue is the one state function, so the board agrees with the worklist
    // and the notifier about which side of the grace a load is on.
    const state = checkCallState({ nextCheckCallAt: row.nextCheckCallAt }, Date.now())
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

export type SortKey = 'pickupAppt' | 'number' | 'customerName' | 'status'
export type SortDir = 'asc' | 'desc'

function sortValue(row: ShipmentRow, key: SortKey): string {
  switch (key) {
    case 'pickupAppt': return row.pickupAppt ?? ''
    case 'number': return row.number ?? ''
    case 'customerName': return (row.customerName ?? '').toLowerCase()
    case 'status': return row.status
  }
}

export function applyBoard(
  rows: readonly ShipmentRow[],
  opts: { tab: BoardTabKey; query: string; filters: BoardFilters; sortKey: SortKey; sortDir: SortDir },
): ShipmentRow[] {
  const out = rows.filter((r) =>
    isBoardVisible(r) && matchesTab(r, opts.tab) && matchesQuery(r, opts.query) && matchesFilters(r, opts.filters))
  const dir = opts.sortDir === 'asc' ? 1 : -1
  return out.sort((a, b) => {
    const cmp = sortValue(a, opts.sortKey).localeCompare(sortValue(b, opts.sortKey))
    return cmp !== 0 ? cmp * dir : a.id.localeCompare(b.id)
  })
}

export interface BoardColumn {
  key: string
  label: string
  value: (row: ShipmentRow) => string
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

export const BOARD_COLUMNS: BoardColumn[] = [
  { key: 'number', label: 'Shipment', value: (r) => r.number ?? '' },
  { key: 'status', label: 'Status', value: (r) => r.status },
  { key: 'customerName', label: 'Customer', value: (r) => r.customerName ?? '' },
  { key: 'mode', label: 'Mode', value: (r) => r.mode },
  { key: 'originCity', label: 'Origin', value: (r) => r.originCity ?? '' },
  { key: 'destinationCity', label: 'Destination', value: (r) => r.destinationCity ?? '' },
  { key: 'pickupAppt', label: 'Pickup', value: (r) => shortDate(r.pickupAppt) },
  { key: 'deliveryAppt', label: 'Delivery', value: (r) => shortDate(r.deliveryAppt) },
  { key: 'arStatus', label: 'AR', value: (r) => r.arStatus ?? '' },
  { key: 'assignmentType', label: 'Assignment', value: (r) => r.assignmentType ?? '' },
  { key: 'lastUpdateAt', label: 'Last update', value: (r) => [shortDateTime(r.lastUpdateAt), r.lastUpdatePlace].filter(Boolean).join(' · ') },
  { key: 'nextCheckCallAt', label: 'Next check call', value: (r) => shortDateTime(r.nextCheckCallAt) },
  { key: 'openIncidentCount', label: 'Exceptions', value: (r) => ((r.openIncidentCount ?? 0) > 0 ? String(r.openIncidentCount) : '') },
  /*
   * Three states, and the CSV says which in words: nothing at all when the gate has
   * never run for this shipment, "Complete" when it has and found everything, and the
   * count when paperwork is outstanding. A blank cell is not "complete".
   */
  { key: 'docsMissing', label: 'Docs', value: (r) => (
    r.docsMissing == null ? '' : r.docsMissing.length === 0 ? 'Complete' : `${r.docsMissing.length} missing`
  ) },
]

export const DEFAULT_COLUMN_KEYS = [
  'number', 'status', 'customerName', 'mode', 'originCity', 'destinationCity', 'pickupAppt', 'deliveryAppt',
  'lastUpdateAt', 'nextCheckCallAt', 'openIncidentCount', 'docsMissing',
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

// ── Saved views ──────────────────────────────────────────────────────────────

export interface SavedView {
  id: string
  name: string
  tab: BoardTabKey
  query: string
  filters: BoardFilters
  columnKeys: string[]
  sortKey: SortKey
  sortDir: SortDir
  /** The view this user lands on when the board opens. At most one. */
  isDefault?: boolean
}

const VIEWS_KEY = (email: string) => `bcat.shipments.views.${(email || 'anon').toLowerCase()}`

type ReadStorage = Pick<Storage, 'getItem'> | null
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'> | null

const defaultRead = (): ReadStorage => (typeof localStorage === 'undefined' ? null : localStorage)
const defaultWrite = (): WriteStorage => (typeof localStorage === 'undefined' ? null : localStorage)

function sanitizeFilters(v: unknown): BoardFilters {
  const raw = (v ?? {}) as Partial<BoardFilters>
  const str = (x: unknown) => (typeof x === 'string' && x ? x : null)
  return {
    customerId: str(raw.customerId),
    pickupFrom: str(raw.pickupFrom),
    pickupTo: str(raw.pickupTo),
    mode: str(raw.mode) as ShipmentMode | null,
    arStatus: str(raw.arStatus) as ArStatus | null,
    assignmentType: str(raw.assignmentType) as AssignmentType | null,
    checkCallDue: raw.checkCallDue === true ? true : null,
    checkCallOverdue: raw.checkCallOverdue === true ? true : null,
    openExceptions: raw.openExceptions === true ? true : null,
    docsMissing: raw.docsMissing === true ? true : null,
    uploadsToReview: raw.uploadsToReview === true ? true : null,
  }
}

function sanitizeView(v: unknown): SavedView | null {
  const raw = (v ?? {}) as Partial<SavedView>
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name) return null
  const columnKeys = Array.isArray(raw.columnKeys)
    ? raw.columnKeys.filter((k): k is string => typeof k === 'string' && BOARD_COLUMNS.some((c) => c.key === k))
    : [...DEFAULT_COLUMN_KEYS]
  return {
    id: raw.id,
    name: raw.name,
    tab: BOARD_TABS.some((t) => t.key === raw.tab) ? raw.tab as BoardTabKey : 'all',
    query: typeof raw.query === 'string' ? raw.query : '',
    filters: sanitizeFilters(raw.filters),
    columnKeys: columnKeys.length ? columnKeys : [...DEFAULT_COLUMN_KEYS],
    sortKey: (['pickupAppt', 'number', 'customerName', 'status'] as SortKey[]).includes(raw.sortKey as SortKey)
      ? raw.sortKey as SortKey : 'pickupAppt',
    sortDir: raw.sortDir === 'desc' ? 'desc' : 'asc',
    isDefault: raw.isDefault === true,
  }
}

export function readSavedViews(email: string, storage: ReadStorage = defaultRead()): SavedView[] {
  try {
    const raw = storage?.getItem(VIEWS_KEY(email))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitizeView).filter((v): v is SavedView => v != null)
  } catch {
    return []
  }
}

export function writeSavedViews(email: string, views: readonly SavedView[], storage: WriteStorage = defaultWrite()): void {
  try {
    if (views.length === 0) storage?.removeItem(VIEWS_KEY(email))
    else storage?.setItem(VIEWS_KEY(email), JSON.stringify(views))
  } catch { /* storage can be off; the views just live for this page load */ }
}

/** Saving under an existing name replaces it, so "Save view" twice never duplicates. */
export function upsertView(views: readonly SavedView[], view: SavedView): SavedView[] {
  const next = views.some((v) => v.id === view.id)
    ? views.map((v) => (v.id === view.id ? view : v))
    : [...views, view]
  return view.isDefault ? next.map((v) => (v.id === view.id ? v : { ...v, isDefault: false })) : [...next]
}

export function removeView(views: readonly SavedView[], id: string): SavedView[] {
  return views.filter((v) => v.id !== id)
}
