/**
 * Everything the one Shipments list decides without React: how a row is matched by the
 * search box, which columns exist, what a CSV export of the current list looks like,
 * how a board row is projected onto the `ShipmentViewRow` the saved department views
 * filter, and the R2 Aljex-style board logic (status mapping, filters, counts,
 * mass-release readiness).
 *
 * Status vocabulary is MVMNT's (spec §6.8). Void is the only exit a shipment has: a
 * voided row keeps its PRO, and rows that were soft-deleted before Void existed are
 * read as voided for exactly the same reason — the PRO never leaves the book.
 */
import type { Stop } from '@/types'
import type {
  ApStatus,
  ArStatus,
  AssignmentType,
  BoardDetailKey,
  BoardFilterSet,
  BoardStatusKey,
  LoadWorkflowStatus,
  ShipmentRecord,
  ShipmentViewRow,
} from '@/types/tms'

import { customerDisplayName } from '@/lib/customerResolution'
import { formatCents } from '@/lib/invoiceBuild'
import { DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import { SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'
import { boardStatusOf, detailValuesFor } from '@/lib/shipmentViewDefs'
export { ALJEX_COLUMN_KEYS, boardStatusOf, matchesBoardFilters } from '@/lib/shipmentViewDefs'

export type {
  BoardDateFilter,
  BoardDetailFilter,
  BoardDetailKey,
  BoardFilterSet,
  BoardStatusKey,
} from '@/types/tms'

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
  // ── Step R2 board facets (projected by the data layer) ─────────────────────
  revenueCents?: number | null
  costCents?: number | null
  profitCents?: number | null
  marginBps?: number | null
  equipmentType?: string | null
  commodity?: string | null
  customerReference?: string | null
  pickupName?: string | null
  consigneeName?: string | null
  fromState?: string | null
  toState?: string | null
  dispatcherAssignedId?: string | null
  dispatcherActualId?: string | null
  officeTeamKeys?: string[] | null
  /** Ship date: the first pickup appointment, which Aljex labels Pick-up/Ship. */
  shipDate?: string | null
  /** Stop list used for progress counts and region/state derivation. */
  stops?: Stop[] | null
  /** Step F — already released to accounting when either of these is set. */
  readyToInvoiceAt?: string | null
  invoiceId?: string | null
}

// ── Void detection ───────────────────────────────────────────────────────────

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

// ── R2 board status, tone and stop progress ─────────────────────────────────

/** Delivered stops over total stops; total is zero when the backend sent no stops. */
export function stopProgressOf(row: ShipmentRow): { done: number; total: number } {
  const stops = row.stops
  if (!Array.isArray(stops) || stops.length === 0) return { done: 0, total: 0 }
  const total = stops.length
  const done = stops.filter((s) => s.departedAt != null).length
  return { done, total }
}

export type BoardRowTone =
  | 'delivered' | 'dispatched' | 'departed' | 'arrived' | 'covered' | 'open' | 'hold' | 'reserved' | 'voided' | 'canceled'

/** The whole-row tone the CSS token applies. */
export function boardRowTone(row: ShipmentRow): BoardRowTone {
  const status = boardStatusOf(row)
  if (status === 'CANCELED') return 'canceled'
  return status.toLowerCase() as BoardRowTone
}

// ── R2 board filters ─────────────────────────────────────────────────────────

export const EMPTY_BOARD_FILTER_SET: BoardFilterSet = {
  statuses: [],
  details: {},
  dates: {},
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}

/** How many facets in the set actually narrow the list (empty statuses do not). */
export function boardFilterCount(set: BoardFilterSet): number {
  let count = 0
  if (set.statuses.length > 0) count += 1
  for (const filter of Object.values(set.details)) {
    if (filter && filter.values.length > 0) count += 1
  }
  for (const date of Object.values(set.dates)) {
    if (!date) continue
    if (date.mode === 'FIXED' && date.date) count += 1
    if (date.mode === 'RANGE' && (date.from || date.to)) count += 1
  }
  if (set.flags) {
    for (const value of Object.values(set.flags)) {
      if (value) count += 1
    }
  }
  return count
}

/** Whether two filter sets describe the same narrowing. */
export function boardFiltersEqual(a: BoardFilterSet, b: BoardFilterSet): boolean {
  if (!arraysEqual(a.statuses, b.statuses)) return false
  const aDetailKeys = Object.keys(a.details) as BoardDetailKey[]
  const bDetailKeys = Object.keys(b.details) as BoardDetailKey[]
  if (!arraysEqual(aDetailKeys, bDetailKeys)) return false
  for (const key of aDetailKeys) {
    const af = a.details[key]
    const bf = b.details[key]
    if (!af || !bf) return false
    if (af.exclude !== bf.exclude) return false
    if (!arraysEqual(af.values, bf.values)) return false
  }
  const aDateKeys = Object.keys(a.dates) as ('ship' | 'pickup' | 'delivery' | 'created')[]
  const bDateKeys = Object.keys(b.dates) as ('ship' | 'pickup' | 'delivery' | 'created')[]
  if (!arraysEqual(aDateKeys, bDateKeys)) return false
  for (const key of aDateKeys) {
    const ad = a.dates[key]
    const bd = b.dates[key]
    if (!ad || !bd) return false
    if (ad.mode !== bd.mode) return false
    if (ad.date !== bd.date) return false
    if (ad.from !== bd.from) return false
    if (ad.to !== bd.to) return false
  }

  const aFlagKeys = Object.keys(a.flags ?? {}) as (keyof NonNullable<BoardFilterSet['flags']>)[]
  const bFlagKeys = Object.keys(b.flags ?? {}) as (keyof NonNullable<BoardFilterSet['flags']>)[]
  if (!arraysEqual(aFlagKeys, bFlagKeys)) return false
  for (const key of aFlagKeys) {
    if ((a.flags?.[key] ?? false) !== (b.flags?.[key] ?? false)) return false
  }

  return true
}

/** Per-status counts for the left-panel checkboxes. */
export function boardStatusCounts(rows: readonly ShipmentRow[]): Record<BoardStatusKey, number> {
  const counts = {
    OPEN: 0, COVERED: 0, DISPATCHED: 0, ARRIVED: 0, DEPARTED: 0, DELIVERED: 0, HOLD: 0, RESERVED: 0, VOIDED: 0,
  }
  for (const row of rows) {
    const status = boardStatusOf(row)
    if (status !== 'CANCELED') counts[status] += 1
  }
  return counts
}

/**
 * Distinct values for one detail facet, with occurrence counts. Multi-value facets
 * (office, from/to states, revenue type) count each value where it appears.
 */
export function detailOptions(
  rows: readonly ShipmentRow[],
  key: BoardDetailKey,
): Array<{ value: string; label: string; count: number }> {
  const map = new Map<string, number>()
  for (const row of rows) {
    for (const value of detailValuesFor(row, key)) {
      map.set(value, (map.get(value) ?? 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// ── R2 mass release ──────────────────────────────────────────────────────────

/**
 * Whether the Mass Release checkbox may be shown for this row. It reads the cached
 * document gate verdict (the same facts the Step F release gate reads) and refuses if
 * the order has already been released to accounting. The returned reason is the muted
 * text the cell shows when the checkbox is absent.
 */
export function massReleaseReady(row: ShipmentRow): { ready: boolean; reason: string | null } {
  if (isVoided(row)) return { ready: false, reason: 'Voided shipment' }
  if (boardStatusOf(row) === 'CANCELED') return { ready: false, reason: 'Canceled shipment' }
  if (row.readyToInvoiceAt != null || row.invoiceId != null) {
    return { ready: false, reason: 'Already released to accounting' }
  }
  if (row.docsMissing == null) return { ready: false, reason: 'Documents not checked' }
  if (row.docsMissing.length > 0) {
    const labels = row.docsMissing.map((type) => (DOCUMENT_TYPE_LABELS as Record<string, string>)[type] ?? type)
    return { ready: false, reason: `Missing documents: ${labels.join(', ')}` }
  }
  return { ready: true, reason: null }
}

// ── Search ───────────────────────────────────────────────────────────────────

export function matchesQuery(row: ShipmentRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  // The search box reads the server-built `searchKey`, falling back to visible text.
  const hay = (row.searchKey
    ?? [row.number, row.customerName, row.originCity, row.destinationCity].filter(Boolean).join(' ')
  ).toLowerCase()
  return q.split(/\s+/).every((term) => hay.includes(term))
}

// ── Columns ──────────────────────────────────────────────────────────────────

export interface BoardColumn {
  key: string
  label: string
  /** The text of the cell — what the CSV writes and what a plain cell renders. */
  value: (row: ShipmentRow) => string
  sortKey?: string
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

function formatCentsOrEmpty(cents: number | null | undefined): string {
  if (cents == null) return ''
  return formatCents(cents)
}

function formatBpsOrEmpty(bps: number | null | undefined): string {
  if (bps == null) return ''
  return `${(bps / 100).toFixed(2)}%`
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
  return SHIPMENT_STATUS_LABELS[row.status]
}

/** Status cell text: "DELIVERED 2/2". A row with no stops shows the status alone. */
function statusWithProgress(row: ShipmentRow): string {
  const label = statusLabel(row)
  const { done, total } = stopProgressOf(row)
  if (total === 0) return label
  return `${label} ${done}/${total}`
}

const titleCase = (value: string): string =>
  value.toLowerCase().replace(/(^|[\s_])(\w)/g, (_, lead: string, ch: string) => `${lead === '_' ? ' ' : lead}${ch.toUpperCase()}`)

/** MVMNT's column order. The first thirteen are the ones MVMNT shows by default. */
export const BOARD_COLUMNS: BoardColumn[] = [
  { key: 'number', label: 'Shipment ID', value: (r) => r.number ?? '', sortKey: 'number', width: 120 },
  // ── Aljex-style board columns (R2) ────────────────────────────────────────
  {
    key: 'exceptions',
    label: 'Exceptions',
    value: (r) => ((r.openIncidentCount ?? 0) > 0 ? String(r.openIncidentCount) : ''),
    width: 90,
  },
  { key: 'status', label: 'Status', value: statusWithProgress, sortKey: 'status', width: 130 },
  { key: 'proNumber', label: 'PRO #', value: (r) => r.number ?? '', sortKey: 'number', width: 120 },
  { key: 'massRelease', label: 'Mass Release', value: () => '', width: 110 },
  { key: 'equip', label: 'Equip', value: (r) => r.equipmentType ?? '', width: 100 },
  { key: 'customerReference', label: 'Customer Reference Number', value: (r) => r.customerReference ?? '', width: 180 },
  { key: 'description', label: 'Description', value: (r) => r.commodity ?? '', width: 180 },
  { key: 'revenueType', label: 'Revenue Type', value: (r) => divisionLabel(r), width: 160 },
  { key: 'salesRep', label: 'Sales Rep', value: (r) => r.salesRepId ?? '', width: 140 },
  // The typed text when there is one, "Customer not linked" when the row carries nothing:
  // a blank cell would read as "no customer needed" rather than "nobody matched one yet".
  { key: 'customerName', label: 'Customer', value: customerDisplayName, sortKey: 'customerName', width: 180 },
  { key: 'carrier', label: 'Carrier', value: carrierLabel, width: 180 },
  { key: 'customerTotalRate', label: 'Customer Total Rate', value: (r) => formatCentsOrEmpty(r.revenueCents), width: 150 },
  { key: 'carrierTotalRates', label: 'Carrier Total Rates', value: (r) => formatCentsOrEmpty(r.costCents), width: 150 },
  { key: 'grossProfit', label: 'Gross Profit', value: (r) => formatCentsOrEmpty(r.profitCents), width: 130 },
  { key: 'netMargin', label: 'Net Margin %', value: (r) => formatBpsOrEmpty(r.marginBps), width: 120 },
  { key: 'pickupShip', label: 'Pick-up/Ship', value: (r) => shortDate(r.shipDate), width: 110 },
  // ── Existing MVMNT columns, unchanged ─────────────────────────────────────
  { key: 'originCity', label: 'Origin', value: (r) => r.originCity ?? '', sortKey: 'originCity', width: 150 },
  { key: 'destinationCity', label: 'Destination', value: (r) => r.destinationCity ?? '', sortKey: 'destinationCity', width: 150 },
  { key: 'pickupAppt', label: 'Pick up', value: (r) => shortDate(r.pickupAppt), sortKey: 'pickupAppt', width: 100 },
  { key: 'deliveryAppt', label: 'Delivery', value: (r) => shortDate(r.deliveryAppt), sortKey: 'deliveryAppt', width: 100 },
  { key: 'stops', label: 'Stops', value: (r) => (r.stopCount == null ? '' : String(r.stopCount)), width: 70 },
  { key: 'salesRepId', label: 'Customer rep', value: (r) => r.salesRepId ?? r.customerRepId ?? '', width: 140 },
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
  { key: 'mode', label: 'Mode', value: (r) => r.mode, width: 90 },
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
  'number', 'status', 'originCity', 'destinationCity', 'pickupAppt', 'deliveryAppt',
  'stops', 'salesRepId', 'customerName', 'carrier', 'division', 'driver',
]

export function visibleColumns(keys: readonly string[]): BoardColumn[] {
  const byKey: Record<string, BoardColumn | undefined> = Object.fromEntries(
    BOARD_COLUMNS.map((c) => [c.key, c]),
  )
  return keys.map((key) => byKey[key]).filter((c): c is BoardColumn => c != null)
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
    // R2 board facets projected so a saved view's board filters round-trip.
    customerId: row.customerId ?? null,
    carrierName: row.carrierName ?? null,
    pickupName: row.pickupName ?? null,
    consigneeName: row.consigneeName ?? null,
    fromState: row.fromState ?? null,
    toState: row.toState ?? null,
    equipmentType: row.equipmentType ?? null,
    officeTeamKeys: row.officeTeamKeys ?? null,
    dispatcherAssignedId: row.dispatcherAssignedId ?? null,
    dispatcherActualId: row.dispatcherActualId ?? null,
    shipDate: row.shipDate ?? null,
    deliveryAppt: row.deliveryAppt ?? null,
    createdAt: row.createdAt,
    stops: row.stops ?? null,
    revenueCents: row.revenueCents ?? null,
    costCents: row.costCents ?? null,
    profitCents: row.profitCents ?? null,
    marginBps: row.marginBps ?? null,
    customerReference: row.customerReference ?? null,
    commodity: row.commodity ?? null,
  }
}

/** The sidebar's per-division slice: `/tms/shipments/view/division-ASSETS`. */
export const DIVISION_VIEW_PREFIX = 'division-'

export function divisionCodeOfViewSlug(slug: string | null | undefined): string | null {
  if (!slug || !slug.startsWith(DIVISION_VIEW_PREFIX)) return null
  const code = slug.slice(DIVISION_VIEW_PREFIX.length)
  return code || null
}
