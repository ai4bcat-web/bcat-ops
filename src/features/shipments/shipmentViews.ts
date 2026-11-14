/**
 * Everything the one Shipments list decides without React: how a row is matched by the
 * search box, which columns exist, what a CSV export of the current list looks like,
 * how a board row is projected onto the `ShipmentViewRow` the saved department views
 * filter, and the R2 Aljex-style board logic (status mapping, filters, counts).
 *
 * Status vocabulary is MVMNT's (spec §6.8). Void is the only exit a shipment has: a
 * voided row keeps its PRO, and rows that were soft-deleted before Void existed are
 * read as voided for exactly the same reason — the PRO never leaves the book.
 */
import { STATUS_META } from '@/lib/apptStatus'
import { PHASE_LABEL, deliveryPhase, deliveryPhaseText } from '@/lib/deliveryPhase'
import { phaseInputOfRow } from './deliveryPhaseInputs'
import { rateConStatusText } from '@/lib/rateConLabel'
import type { Stop } from '@/types'
import type {
  ApStatus,
  ArStatus,
  AssignmentType,
  AuthorityStatus,
  BoardDetailKey,
  BoardFilterSet,
  BoardStatusKey,
  CarrierStatus,
  ComplianceCheckStatus,
  CustomerStatus,
  InvoiceFrequency,
  LoadWorkflowStatus,
  RateConStatus,
  RateType,
  SafetyRating,
  ShipmentRecord,
  ShipmentViewRow,
  SpecialRequirements,
} from '@/types/tms'

import { isDemoText } from '@/lib/demoFlow'
import { customerDisplayName } from '@/lib/customerResolution'
import { formatBoardDate, formatBoardDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { paperworkShortLabel, type PaperworkLocation } from '@/lib/paperworkLocation'
import { DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import { SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'
import { boardStatusOf, detailValuesFor, type BoardCarrier } from '@/lib/shipmentViewDefs'
import { assignmentChipText } from './carrierLadder'
import { isReleasedToInvoicing } from '@/lib/shipmentLists'
import { loadInvoiceStatusOf, loadInvoiceStatusText, type LoadInvoiceStatus } from '@/lib/loadInvoiceStatus'
import { factorGapSummary, type FactorGapCode } from '@/lib/factorReadyAtCreate'
import { effectiveShipmentType, shipmentTypeLabel } from '@/lib/shipmentTypes'
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
  /** Imported Aljex history: no driver is expected and none is ever written (DECIDED-5). */
  legacyImported?: boolean | null
  arStatus?: ArStatus | null
  /** The active assignment's AP rung. */
  apStatus?: ApStatus | null
  /** Step AT — the live carriers when there are two or more; absent/empty means read `carrierName`. */
  carriers?: BoardCarrier[] | null
  carrierCount?: number | null
  assignmentType?: AssignmentType | null
  /** Step V — display name of `trackerId`, projected by useShipments. */
  trackerName?: string | null
  loadStatus?: LoadWorkflowStatus | null
  /** Step D — the load's tracking clock, projected onto the shipment. */
  lastUpdateAt?: string | null
  lastUpdatePlace?: string | null
  /** Step P8 — prior ping so the tracking board can prove Moving/Stopped from two fixes. */
  previousUpdateAt?: string | null
  previousUpdatePlace?: string | null
  nextCheckCallAt?: string | null
  lastCheckCallAt?: string | null
  checkCallOpen?: 'OPEN' | null
  openIncidentCount?: number | null
  trackingProvider?: string | null
  /** The active CARRIER_PING TrackingLink, while one is out. */
  trackingLinkId?: string | null
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
  /** The ACTIVE assignment's driver id. Blank on an own-fleet row is the "no driver" exception. */
  driverId?: string | null
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
  /** Where the invoice stands, read by the board from the open invoices and the OTR queue (`loadInvoiceStatusOf`). */
  invoiceStatus?: LoadInvoiceStatus | null
  invoiceId?: string | null
  /** What a factor-billed load is missing for factoring, derived by useShipments; null = not judged. */
  factorGaps?: FactorGapCode[] | null
  // ── R2 column catalog (projected by the data layer; every one null when unknown) ──
  /** Rep and audit ids resolved to profile names; null when no profile matches. */
  salesRepName?: string | null
  customerRepName?: string | null
  dispatcherAssignedName?: string | null
  dispatcherActualName?: string | null
  statusChangedByName?: string | null
  voidedByName?: string | null
  createdByName?: string | null
  updatedByName?: string | null
  // Order — the customer side, one field per catalog column.
  refPo?: string | null
  refPu?: string | null
  refDelivery?: string | null
  refBol?: string | null
  billToName?: string | null
  costCenter?: string | null
  rateType?: RateType | null
  equipmentLengthFt?: number | null
  specialRequirements?: SpecialRequirements | null
  /** The order's freight lines: joined descriptions, summed weight/pieces/pallets. */
  orderCommodity?: string | null
  freightWeightLbs?: number | null
  freightPieces?: number | null
  freightPallets?: number | null
  customerNotes?: string | null
  internalNotes?: string | null
  customerRateCents?: number | null
  /** The order's own cached revenue, beside the financials-backed `revenueCents`. */
  orderRevenueCents?: number | null
  arStatusChangedAt?: string | null
  invoiceNumber?: string | null
  invoicedAt?: string | null
  paidAt?: string | null
  arBalanceCents?: number | null
  factoringItemId?: string | null
  docsRequired?: string[] | null
  /** Every document type on file (the order gate's `present`); null until the gate re-caches. */
  docsPresent?: string[] | null
  docsCheckedAt?: string | null
  docsOverrideAt?: string | null
  docsOverrideBy?: string | null
  docsOverrideNote?: string | null
  quoteNumber?: string | null
  quoteAmountCents?: number | null
  // Load — legacy and own-fleet facts, folded across the shipment's legs.
  loadAljexId?: string | null
  loadTmsId?: string | null
  pickupNumber?: string | null
  pickupApptEnd?: string | null
  pickupApptType?: string | null
  deliveryApptEnd?: string | null
  deliveryApptType?: string | null
  pickupDriverName?: string | null
  deliveryDriverName?: string | null
  loadTrailerNumber?: string | null
  loadRateCents?: number | null
  miles?: number | null
  hot?: boolean | null
  weightLbs?: number | null
  pieces?: number | null
  piecesUnit?: string | null
  paperworkLocation?: PaperworkLocation | null
  eldLogsReviewedAt?: string | null
  eldLogsReviewedBy?: string | null
  eldLogsReviewedByName?: string | null
  readyToInvoice?: boolean | null
  rateConOnFile?: boolean | null
  divisionKey?: string | null
  nextCheckCallNote?: string | null
  lastCheckCallType?: string | null
  lastKnownAt?: string | null
  lastKnownCity?: string | null
  lastKnownState?: string | null
  lastKnownSource?: string | null
  lastKnownLat?: number | null
  lastKnownLng?: number | null
  loadDeliveredAt?: string | null
  cargoValueCents?: number | null
  loadNotes?: string | null
  podNotes?: string | null
  // Carrier leg — the ACTIVE LoadCarrier.
  carrierMc?: string | null
  carrierDispatcherName?: string | null
  carrierDispatcherPhone?: string | null
  carrierDispatcherEmail?: string | null
  driverPhone?: string | null
  driver2Name?: string | null
  driver2Phone?: string | null
  trailerNumber?: string | null
  plates?: string | null
  vin?: string | null
  sealNumber?: string | null
  tripNumber?: string | null
  pickupEtaAt?: string | null
  deliveryEtaAt?: string | null
  rateConStatus?: RateConStatus | null
  rateConVersion?: number | null
  rateConSentAt?: string | null
  rateConSignedAt?: string | null
  carrierRateCents?: number | null
  legCostCents?: number | null
  apBalanceCents?: number | null
  apPaidAt?: string | null
  quickPay?: boolean | null
  quickPayDays?: number | null
  quickPayFeeBps?: number | null
  paymentTermsDays?: number | null
  bookedAt?: string | null
  dispatchedAt?: string | null
  trackingStartedAt?: string | null
  trackingAcceptedAt?: string | null
  trackingStoppedAt?: string | null
  podRequestedAt?: string | null
  /** Carrier-scope paperwork still outstanding (the leg's own gate, not the order's). */
  legDocsMissing?: string[] | null
  ratingStars?: number | null
  // Customer directory.
  customerMc?: string | null
  customerDot?: string | null
  customerFactored?: boolean | null
  customerPaymentTermsDays?: number | null
  creditLimitCents?: number | null
  creditHold?: boolean | null
  customerStatus?: CustomerStatus | null
  serviceTier?: string | null
  customerTeamKey?: string | null
  customerOwnerNames?: string | null
  defaultSalesRepName?: string | null
  invoiceFrequency?: InvoiceFrequency | null
  // Carrier directory.
  carrierDot?: string | null
  carrierScac?: string | null
  carrierStatus?: CarrierStatus | null
  authorityStatus?: AuthorityStatus | null
  safetyRating?: SafetyRating | null
  cargoInsuranceExpiresAt?: string | null
  liabilityInsuranceExpiresAt?: string | null
  mcpStatus?: string | null
  highwayStatus?: ComplianceCheckStatus | null
  rmisStatus?: ComplianceCheckStatus | null
  quickPayEligible?: boolean | null
  carrierTeamKey?: string | null
  carrierOwnerNames?: string | null
  carrierLoadCount?: number | null
  carrierLastLoadAt?: string | null
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

/** What a delivered shipment already released to invoicing reads as. Display only: the stored status stays DELIVERED. */
export const RELEASED_LABEL = 'RELEASED'

/**
 * The board status as the person reads it: a load past Load Review (released to invoicing, the same
 * `isReleasedToInvoicing` rule that takes it off Active) reads RELEASED whatever its stop status (Ryne
 * 2026-11-14); where its money stands is the invoice pill beside it. Voided and canceled loads keep theirs.
 */
export function displayStatusOf(row: ShipmentRow): BoardStatusKey | 'CANCELED' | typeof RELEASED_LABEL {
  const status = boardStatusOf(row)
  return status !== 'VOIDED' && status !== 'CANCELED' && isReleasedToInvoicing(row) ? RELEASED_LABEL : status
}

/**
 * What a factored load still needs before it can be factored (Ryne 2026-11-14), while that still matters: not void or
 * canceled, and not yet invoiced or handed to the factor. Empty otherwise.
 */
export function openFactorGaps(row: ShipmentRow): FactorGapCode[] {
  if (!row.factorGaps || row.factorGaps.length === 0) return []
  if (row.voidedAt || row.deletedAt || row.status === 'CANCELED') return []
  if (row.invoiceId || row.factoringItemId) return []
  return row.factorGaps
}

/** "Missing 3" for the board cell; empty when nothing is missing. */
export function factorInfoText(row: ShipmentRow): string {
  const gaps = openFactorGaps(row)
  return gaps.length > 0 ? `Missing ${gaps.length}` : ''
}

/** The cell's tooltip: "Missing for factoring: PO, Pick Up ZIP". */
export function factorInfoTitle(row: ShipmentRow): string {
  return factorGapSummary(openFactorGaps(row))
}

/** The row's invoice status: the board's live read when it has one, the order's cached AR fields otherwise. */
export function invoiceStatusOfRow(row: ShipmentRow): LoadInvoiceStatus {
  return row.invoiceStatus ?? loadInvoiceStatusOf(row)
}

// ── R2 board status, tone and stop progress ─────────────────────────────────

/**
 * Departed stops over total stops, the "2/2" Aljex prints beside the status.
 *
 * A stop counts once the truck has left it. Legacy freight carries a stop array with
 * no departure stamps at all — the move happened before anybody recorded stops — and
 * printing `0/2` beside DELIVERED would assert that nothing has happened yet, which
 * is a worse answer than saying nothing. So a shipment that demonstrably moved with
 * no stop evidence reports a total of zero, and the cell shows the status alone.
 */
export function stopProgressOf(row: ShipmentRow): { done: number; total: number } {
  const stops = row.stops
  if (!Array.isArray(stops) || stops.length === 0) return { done: 0, total: 0 }
  const total = stops.length
  const done = stops.filter((s) => s.departedAt != null).length
  if (done === 0 && MOVED_STATUSES[boardStatusOf(row)]) return { done: 0, total: 0 }
  return { done, total }
}

/** The board statuses that mean the truck has already left the first stop. */
const MOVED_STATUSES: Partial<Record<BoardStatusKey | 'CANCELED', true>> = {
  DEPARTED: true,
  ARRIVED: true,
  DELIVERED: true,
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

/** One distinct value of one detail facet. */
export interface BoardDetailOption {
  value: string
  label: string
  count: number
  /**
   * Extra needles the type-ahead matches beyond the label: the carrier's MC and
   * SCAC, the two-letter state code, the division code. Absent when a facet value
   * has no codes, so a picker never searches an empty channel.
   */
  codes?: string[]
}

/**
 * Distinct values for one detail facet, with occurrence counts. Multi-value facets
 * (office, from/to states, revenue type) count each value where it appears.
 */
export function detailOptions(
  rows: readonly ShipmentRow[],
  key: BoardDetailKey,
): BoardDetailOption[] {
  const map = new Map<string, { count: number; codes: Set<string> }>()
  for (const row of rows) {
    for (const value of detailValuesFor(row, key)) {
      const entry = map.get(value) ?? { count: 0, codes: new Set<string>() }
      entry.count += 1
      for (const code of detailCodesFor(row, key, value)) entry.codes.add(code)
      map.set(value, entry)
    }
  }
  return [...map.entries()]
    .map(([value, entry]) => ({
      value,
      label: value,
      count: entry.count,
      ...(entry.codes.size > 0 ? { codes: [...entry.codes] } : {}),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** The code needles one facet value carries, beyond its own text. */
function detailCodesFor(row: ShipmentRow, key: BoardDetailKey, value: string): string[] {
  switch (key) {
    case 'carrier':
      if (row.carrierName !== value) return []
      return [row.carrierMc, row.carrierScac].filter((c): c is string => !!c)
    case 'fromStates':
    case 'toStates':
    case 'revenueType':
      // The value IS the code (IL, BROKERAGE) — naming it keeps codes and labels in
      // one searchable channel for every facet.
      return [value]
    default:
      return []
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

export function matchesQuery(row: ShipmentRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  // The search box reads the server-built `searchKey`, falling back to visible text.
  const hay = (row.searchKey
    ?? [row.number, row.customerName, row.originCity, row.destinationCity].filter(Boolean).join(' ')
  ).toLowerCase() + ' ' + (row.carriers ?? []).map((c) => c.name.toLowerCase()).join(' ')
  return q.split(/\s+/).every((term) => hay.includes(term))
}

/** The "Demo" chip: a walkthrough shipment, recognised by the ZZ DEMO marker in its customer, reference or search text. */
export function isDemoShipment(row: Pick<ShipmentRow, 'customerName' | 'reference' | 'searchKey'>): boolean {
  return isDemoText(row.customerName, row.reference, row.searchKey)
}

// ── Columns ──────────────────────────────────────────────────────────────────

export interface BoardColumn {
  key: string
  label: string
  /** The record the value comes off — the picker's catalog groups by it. */
  group: 'Shipment' | 'Order' | 'Load' | 'Carrier leg' | 'Customer' | 'Carrier' | 'Computed'
  /** The text of the cell — what the CSV writes and what a plain cell renders. */
  value: (row: ShipmentRow) => string
  sortKey?: string
  width?: number
}

/** Catalog display order — the groups the Columns picker lists top to bottom. */
export const BOARD_COLUMN_GROUPS: readonly BoardColumn['group'][] = [
  'Shipment', 'Order', 'Load', 'Carrier leg', 'Customer', 'Carrier', 'Computed',
]

function formatCentsOrEmpty(cents: number | null | undefined): string {
  if (cents == null) return ''
  return formatCents(cents)
}

function formatBpsOrEmpty(bps: number | null | undefined): string {
  if (bps == null) return ''
  return `${(bps / 100).toFixed(2)}%`
}

/** `41,000 lb` — pounds with the unit, so a weight never reads as a rate. */
function formatLbsOrEmpty(lbs: number | null | undefined): string {
  if (lbs == null) return ''
  return `${lbs.toLocaleString('en-US')} lb`
}

/** Tri-state boolean: 'Yes' / 'No' / '' (unknown). */
function yesNoOrEmpty(value: boolean | null | undefined): string {
  if (value == null) return ''
  return value ? 'Yes' : 'No'
}

/** A flag column: 'Yes' when set, nothing otherwise — false is the ground state. */
function flagOrEmpty(value: boolean | null | undefined): string {
  return value ? 'Yes' : ''
}

/** `Net 30` — payment terms in days. */
function paymentTermsLabel(days: number | null | undefined): string {
  if (days == null) return ''
  return `Net ${days}`
}

/** The Carrier column's text for an own-fleet shipment nobody is driving. */
export const OWN_FLEET_NO_DRIVER = 'Ivan Cartage · no driver'

/** The Carrier column's text for imported own-fleet history, which never has a driver. */
export const OWN_FLEET_HISTORY = 'Ivan Cartage (history)'

/**
 * A live Ivan Cartage shipment with no driver on its active assignment (Step W).
 * Imported Aljex history is exempt: it has no driver and nobody may be asked for one.
 */
export function needsDriver(row: ShipmentRow): boolean {
  return (
    row.assignmentType === 'OWN_ASSET' &&
    !row.driverId &&
    !isVoided(row) &&
    row.status !== 'CANCELED' &&
    row.legacyImported !== true
  )
}

/**
 * Who is hauling it, in MVMNT's words: the outside carrier's name, our own driver and
 * truck when the fleet has it, and "Need to cover" while nobody does.
 */
/**
 * Every driver on the load, once each: the one who picks up and the one who delivers can differ, and the active leg's driver
 * may be either. Nobody assigned reads as an empty list (never "own fleet" or a carrier name).
 */
export function driverNamesOf(row: ShipmentRow): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of [row.pickupDriverName, row.driverName, row.deliveryDriverName]) {
    const trimmed = (name ?? '').trim()
    const key = trimmed.toLowerCase()
    if (trimmed && !seen.has(key)) { seen.add(key); out.push(trimmed) }
  }
  return out
}

const FLEET_GROUP_LABEL: Record<string, string> = {
  OWNER_OPERATOR: 'Owner Operators', BOX_TRUCK: 'Box Trucks', LOCAL: 'Local Drivers', AMAZON: 'Amazon',
}
interface FleetDriver { id: string; name: string; fleetGroup?: string | null }
let fleetById = new Map<string, FleetDriver>()
let fleetByName = new Map<string, FleetDriver>()
const nameKey = (n: string | null | undefined): string => (n ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** The driver files, so the Carrier column can say which Ivan Cartage group a driver is mapped to. Set by the board. */
export function setFleetDrivers(drivers: readonly FleetDriver[]): void {
  fleetById = new Map(drivers.map((d) => [d.id, d]))
  fleetByName = new Map(drivers.map((d) => [nameKey(d.name), d]))
}

/** A carrier "name" that is really one of our drivers (Zak Pace, Lee Lara): the freight is Ivan Cartage's. */
function carrierIsDriverName(row: ShipmentRow): boolean {
  return !!row.carrierName && fleetByName.has(nameKey(row.carrierName))
}

function ivanCartageLabel(row: ShipmentRow): string {
  const driver = (row.driverId ? fleetById.get(row.driverId) : undefined)
    ?? fleetByName.get(nameKey(row.driverName)) ?? fleetByName.get(nameKey(row.carrierName))
  const group = driver?.fleetGroup ? FLEET_GROUP_LABEL[driver.fleetGroup] : undefined
  return group ? `Ivan Cartage (${group})` : 'Ivan Cartage'
}

export function carrierLabel(row: ShipmentRow): string {
  if (row.assignmentType === 'OWN_ASSET' || carrierIsDriverName(row)) {
    if (needsDriver(row)) return OWN_FLEET_NO_DRIVER
    return row.legacyImported === true && !row.driverId && !carrierIsDriverName(row) ? OWN_FLEET_HISTORY : ivanCartageLabel(row)
  }
  if (row.carriers && row.carriers.length >= 2) return `${row.carriers.length} carriers`
  if (row.carrierName) return row.carrierName
  return 'Need to cover'
}

/**
 * The Carrier cell's hover list for a load with two or more live carriers, one line per
 * carrier: `name · AP rung · $cost`. Undefined for a single carrier (the cell shows the
 * name alone, as before).
 */
export function carrierHoverText(row: ShipmentRow): string | undefined {
  if (!row.carriers || row.carriers.length < 2 || row.assignmentType === 'OWN_ASSET') return undefined
  return row.carriers
    .map((c) => [c.name, enumLabel(c.apStatus), formatCentsOrEmpty(c.costCents)].filter(Boolean).join(' · '))
    .join('\n')
}

/** What the Carrier column sorts by: the carriers' names alphabetically, so a "2 carriers" cell sorts with its names, not under "2". */
export function carrierSortKey(row: ShipmentRow): string {
  if (row.carriers && row.carriers.length >= 2 && row.assignmentType !== 'OWN_ASSET') {
    return row.carriers.map((c) => c.name).sort((a, b) => a.localeCompare(b)).join(', ')
  }
  return carrierLabel(row)
}

/** `BROKERAGE` / `Assets Box Truck` — the division chip's text. */
export function divisionLabel(row: ShipmentRow, nameOf?: (code: string) => string): string {
  // A division code reads as words: CAR_SHIPPING is CAR SHIPPING.
  const name = (code: string) => (nameOf ? nameOf(code) : code.replace(/_/g, ' '))
  if (!row.revDivision) return ''
  // Ivan Cartage reads as "Assets", "Assets Local", "Assets Owner Operator", "Assets Box Truck" (Ryne 2026-11-11).
  if (row.revDivision === 'ASSETS' && !nameOf) {
    const words = (code: string) => code.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    return row.revSubdivision ? `Assets ${words(row.revSubdivision)}` : 'Assets'
  }
  return row.revSubdivision ? `${name(row.revDivision)} (${name(row.revSubdivision)})` : name(row.revDivision)
}

export function statusLabel(row: ShipmentRow): string {
  if (isVoided(row)) return 'VOIDED'
  return SHIPMENT_STATUS_LABELS[row.status]
}

/** The Appts-page workflow status of the first pickup / last delivery stop; blank when the stop carries none. */
const APPT_STATUS_TEXT: Record<string, string> = Object.fromEntries(Object.entries(STATUS_META).map(([k, v]) => [k, v.label]))

function apptStatusText(row: ShipmentRow, type: 'pickup' | 'delivery'): string {
  const stops = (Array.isArray(row.stops) ? row.stops : []).filter((s) => s.type === type)
  const stop = type === 'pickup' ? stops[0] : stops[stops.length - 1]
  const status = stop?.apptStatus
  return status ? (APPT_STATUS_TEXT[status] ?? String(status)) : ''
}


/**
 * The Status cell: `DELIVERED 2/2`, `DEPARTED 1/2`, `COVERED`.
 *
 * It speaks the board's own eight-status vocabulary — the same words the status
 * checkboxes use — rather than MVMNT's abbreviations, because a row that reads
 * `DEL` while the checkbox beside it says `Delivered` is two names for one fact.
 * A row with no stop evidence shows the status alone.
 */
export function statusWithProgress(row: ShipmentRow): string {
  let label: string = isVoided(row) ? 'VOIDED' : displayStatusOf(row)
  if (label === RELEASED_LABEL) return label
  // A brokerage load that is covered but not moving yet reads where it stands on the carrier ladder (Ryne 2026-11-09):
  // COVERED, RC SENT (rate con out), DISPATCHED (rate con signed and the driver details in).
  if (label === 'COVERED' && row.revDivision === 'BROKERAGE') {
    const phase = deliveryPhase(phaseInputOfRow(row, Date.now())).phase
    if (phase === 'RC_SENT' || phase === 'DISPATCHED') label = PHASE_LABEL[phase].toUpperCase()
  }
  const { done, total } = stopProgressOf(row)
  if (total === 0) return label
  return `${label} ${done}/${total}`
}

function deliveryText(row: ShipmentRow): string {
  return deliveryPhaseText(deliveryPhase(phaseInputOfRow(row, Date.now())))
}

const titleCase = (value: string): string =>
  value.toLowerCase().replace(/(^|[\s_])(\w)/g, (_, lead: string, ch: string) => `${lead === '_' ? ' ' : lead}${ch.toUpperCase()}`)

/** The title-cased wire value of an enum cell, or '' when the row carries none. */
function enumLabel(value: string | null | undefined): string {
  return value ? titleCase(value) : ''
}

/** The row's shipment type key: the order form's explicit key, else the one derived from `mode`. */
export function rowShipmentType(r: Pick<ShipmentRow, 'mode' | 'specialRequirements'>): string {
  const explicit = (r.specialRequirements?.form as { shipmentType?: unknown } | null | undefined)?.shipmentType
  return effectiveShipmentType(typeof explicit === 'string' ? explicit : null, r.mode)
}

/** "Team, Tarps, 34–36°F" — the order's special requirements in one cell. */
function specialRequirementsLabel(req: SpecialRequirements | null | undefined): string {
  if (!req) return ''
  const parts: string[] = []
  if (req.team) parts.push('Team')
  if (req.tarps) parts.push('Tarps')
  if (req.straps) parts.push('Straps')
  if (req.liftgate) parts.push('Liftgate')
  if (req.hazmat) parts.push('Hazmat')
  if (req.tempF) parts.push(`${req.tempF.min}–${req.tempF.max}°F`)
  for (const other of req.other ?? []) parts.push(other)
  return parts.join(', ')
}

/** Whole days since the shipment entered its current status; '' when that is unknown. */
/**
 * Whether a shipment still waits on its POD (Ryne 2026-11-11), for every revenue type except car shipping. Read from the order's document
 * gate (`docsMissing`), the same fact the dashboard's POD strip and the POD Present column use, so no extra read is needed.
 * Hard-coded for now (Ryne 2026-11-11): every customer requires a POD, whatever its own setting says; car shipping (auto shippers) shows 'NA'.
 * 'NO_POD' = the gate says the POD is outstanding; 'POD_IN' = the gate ran and the POD is not among what is missing; '' = not known yet
 * (the gate never ran for this shipment).
 */
export function podStatusOf(row: Pick<ShipmentRow, 'revDivision' | 'docsMissing'> & { docsRequired?: string[] | null }): 'NO_POD' | 'POD_IN' | 'NA' | '' {
  if (row.revDivision === 'CAR_SHIPPING') return 'NA'
  if (row.docsMissing == null) return ''
  // `docsMissing` only lists what the customer requires: with POD off that list, "POD not missing" says nothing about a POD being on file.
  if (Array.isArray(row.docsRequired) && !row.docsRequired.includes('POD')) return ''
  return row.docsMissing.includes('POD') ? 'NO_POD' : 'POD_IN'
}

/**
 * The rate confirmation is on file or signed (the RC column's rule). "On file" includes the order's document
 * gate: the gate reads the shipment's Documents (the Rate confirmation box), so a file uploaded there, or
 * retyped into a rate confirmation, counts the moment the gate re-reads (Ryne 2026-11-14).
 */
export function rateConIn(row: Pick<ShipmentRow, 'rateConSignedAt' | 'rateConStatus' | 'rateConOnFile'> & { docsMissing?: string[] | null; docsRequired?: string[] | null; docsPresent?: string[] | null }): boolean {
  if (Boolean(row.rateConSignedAt) || row.rateConStatus === 'SIGNED' || row.rateConOnFile === true) return true
  if (Array.isArray(row.docsPresent) && row.docsPresent.includes('RATE_CON')) return true
  return Array.isArray(row.docsMissing) && Array.isArray(row.docsRequired)
    && row.docsRequired.includes('RATE_CON') && !row.docsMissing.includes('RATE_CON')
}

export type DocCellState = 'PRESENT' | 'MISSING' | 'NA' | ''

/**
 * The POD and RC board cells (Ryne 2026-11-14: "mapped to the column in the active shipment table so we know
 * which is missing"), read from the same facts as the shipment's POD and Rate confirmation boxes: the order's
 * document gate, re-cached on every upload, retype and delete. NA where the document is not chased: car shipping
 * has neither, and Ivan Cartage's own fleet (ASSETS) has no carrier rate confirmation. '' = not known yet.
 */
export function docCellOf(
  row: Pick<ShipmentRow, 'status' | 'voidedAt' | 'deletedAt' | 'assignmentType' | 'revDivision' | 'docsMissing' | 'rateConSignedAt' | 'rateConStatus' | 'rateConOnFile'> & { docsRequired?: string[] | null; docsPresent?: string[] | null },
  docType: 'POD' | 'RATE_CON',
): DocCellState {
  if (row.revDivision === 'CAR_SHIPPING') return 'NA'
  const delivered = boardStatusOf(row) === 'DELIVERED'
  if (docType === 'POD') {
    // What is on file wins, whether or not the customer's list requires a POD.
    if (Array.isArray(row.docsPresent) && row.docsPresent.includes('POD')) return 'PRESENT'
    const pod = podStatusOf(row)
    if (pod === 'POD_IN') return 'PRESENT'
    if (pod === 'NO_POD') return 'MISSING'
    return delivered ? 'MISSING' : ''
  }
  if (row.revDivision === 'ASSETS') return 'NA'
  if (rateConIn(row)) return 'PRESENT'
  if (Array.isArray(row.docsMissing) && row.docsMissing.includes('RATE_CON')) return 'MISSING'
  return delivered ? 'MISSING' : ''
}

export const DOC_CELL_TEXT: Record<DocCellState, string> = { PRESENT: 'Y', MISSING: 'NEED', NA: 'N/A', '': '' }

/**
 * The documents a shipment is missing (Ryne 2026-11-11): whatever the order's document gate lists, plus, once it is DELIVERED, a POD and a rate
 * confirmation (RC) that are not on it. Car shipping (auto shippers) has neither to chase; Ivan Cartage's own fleet has no carrier RC; a shipment
 * whose documents were signed off by hand (`docsOverrideAt`) is not flagged again. A delivered shipment whose gate never ran counts as missing a POD.
 */
export function docsMissingOf(row: Pick<ShipmentRow, 'status' | 'voidedAt' | 'deletedAt' | 'assignmentType' | 'revDivision' | 'docsMissing' | 'docsOverrideAt' | 'rateConSignedAt' | 'rateConStatus' | 'rateConOnFile'> & { docsRequired?: string[] | null; docsPresent?: string[] | null }): string[] {
  const out = [...(row.docsMissing ?? [])]
  if (row.revDivision === 'CAR_SHIPPING' || row.docsOverrideAt || boardStatusOf(row) !== 'DELIVERED') return out
  const podOnFile = Array.isArray(row.docsPresent) && row.docsPresent.includes('POD')
  if (!podOnFile && (row.docsMissing == null || row.docsMissing.includes('POD')) && !out.includes('POD')) out.push('POD')
  // The gate's RATE_CON and the board's RC are the same document: count it once.
  if (row.revDivision !== 'ASSETS' && !rateConIn(row) && !out.includes('RC') && !out.includes('RATE_CON')) out.push('RC')
  return out
}

export const POD_STATUS_TEXT = { NO_POD: 'No POD', POD_IN: 'POD in', NA: 'NA', '': '' } as const

function daysInStatusOf(row: ShipmentRow): string {
  if (!row.statusChangedAt) return ''
  const changed = new Date(row.statusChangedAt).getTime()
  if (Number.isNaN(changed)) return ''
  const days = Math.floor((Date.now() - changed) / 86_400_000)
  return days >= 0 ? String(days) : ''
}

/**
 * "Pickup starts in 23 h" / "Delivery in 6 h" — the next thing the clock brings,
 * computed from the appointment mirrors and the stop clocks. Past and done events
 * are not announced, so the cell is empty rather than a countdown to history.
 */
function nextEventOf(row: ShipmentRow): string {
  if (isVoided(row)) return ''
  const now = Date.now()
  const until = (iso: string | null | undefined): string | null => {
    if (!iso) return null
    const ms = new Date(iso).getTime() - now
    if (Number.isNaN(ms) || ms <= 0) return null
    const hours = ms / 3_600_000
    return hours >= 48 ? `${Math.round(hours / 24)} d` : `${Math.max(1, Math.round(hours))} h`
  }
  const stops = Array.isArray(row.stops) ? row.stops : []
  const firstPickup = stops.find((s) => s.type === 'pickup')
  const pickupDone = firstPickup?.departedAt != null || (stops.length === 0 && MOVED_STATUSES[boardStatusOf(row)] === true)
  if (!pickupDone) {
    const t = until(row.pickupAppt)
    if (t) return `Pickup starts in ${t}`
  }
  if (boardStatusOf(row) !== 'DELIVERED') {
    const t = until(row.deliveryAppt)
    if (t) return `Delivery in ${t}`
  }
  return ''
}

/**
 * Rolling / At stop, from the newest stop clock on the route: a departure means the
 * wheels are turning, an arrival means they are not. '' when nothing has been stamped —
 * the two pings the fuller motion story needs are not a field the row carries.
 */
function trackingMotionOf(row: ShipmentRow): string {
  const stops = row.stops
  if (!Array.isArray(stops) || stops.length === 0) return ''
  let latestAt = ''
  let latestKind: 'departed' | 'arrived' | null = null
  for (const stop of stops) {
    if (stop.arrivedAt && stop.arrivedAt > latestAt) {
      latestAt = stop.arrivedAt
      latestKind = 'arrived'
    }
    if (stop.departedAt && stop.departedAt > latestAt) {
      latestAt = stop.departedAt
      latestKind = 'departed'
    }
  }
  if (latestKind == null) return ''
  return latestKind === 'departed' ? 'Rolling' : 'At stop'
}

/**
 * MVMNT's column order first — the existing keys keep their place, their labels and
 * their behaviour — then the rest of the R2 catalog, grouped by the record each value
 * comes off. Formatting rules hold across every column: money is dollars (cents are
 * never shown raw), timestamps are America/Chicago, rep and party ids are names the
 * data layer resolved, and a field the row does not carry is '' — never 0, never a
 * dash, never a guess.
 */
export const BOARD_COLUMNS: BoardColumn[] = [
  { key: 'number', label: 'Shipment ID', group: 'Shipment', value: (r) => r.number ?? '', sortKey: 'number', width: 120 },
  // ── Aljex-style board columns (R2) ────────────────────────────────────────
  {
    key: 'exceptions',
    label: 'Exceptions',
    group: 'Computed',
    value: (r) => ((r.openIncidentCount ?? 0) > 0 ? String(r.openIncidentCount) : ''),
    width: 90,
  },
  { key: 'status', label: 'Status', group: 'Shipment', value: statusWithProgress, sortKey: 'status', width: 240 },
  // Optional (not in the default layout): where the load is in its delivery, from the stop projection the row already carries. No extra reads.
  { key: 'delivery', label: 'Delivery', group: 'Computed', value: deliveryText, width: 170 },
  { key: 'proNumber', label: 'PRO #', group: 'Shipment', value: (r) => r.number ?? '', sortKey: 'number', width: 120 },
  { key: 'equip', label: 'Equip', group: 'Order', value: (r) => r.equipmentType ?? '', width: 100 },
  { key: 'customerReference', label: 'Customer Ref #', group: 'Order', value: (r) => r.customerReference ?? '', width: 180 },
  { key: 'description', label: 'Description', group: 'Order', value: (r) => r.commodity ?? '', width: 180 },
  { key: 'revenueType', label: 'Revenue Type', group: 'Shipment', value: (r) => divisionLabel(r), sortKey: 'division', width: 160 },
  { key: 'salesRep', label: 'Sales Rep', group: 'Shipment', // The person's name only: while the staff directory is still loading (or when no profile claims the id) the cell is empty, never the raw id.
    value: (r) => r.salesRepName ?? '', width: 140 },
  { key: 'tracker', label: 'Tracker', group: 'Shipment', value: (r) => r.trackerName ?? '', width: 140 },
  // The typed text when there is one, "Customer not linked" when the row carries nothing:
  // a blank cell would read as "no customer needed" rather than "nobody matched one yet".
  { key: 'customerName', label: 'Customer', group: 'Customer', value: customerDisplayName, sortKey: 'customerName', width: 240 },
  { key: 'carrier', label: 'Carrier', group: 'Carrier leg', value: carrierLabel, width: 250 },
  { key: 'customerTotalRate', label: 'Customer Total Rate', group: 'Order', value: (r) => formatCentsOrEmpty(r.revenueCents), width: 150 },
  { key: 'carrierTotalRates', label: 'Carrier Total Rates', group: 'Carrier leg', value: (r) => formatCentsOrEmpty(r.costCents), width: 150 },
  { key: 'grossProfit', label: 'Gross Profit', group: 'Computed', value: (r) => formatCentsOrEmpty(r.profitCents), width: 130 },
  { key: 'netMargin', label: 'Net Margin %', group: 'Computed', value: (r) => formatBpsOrEmpty(r.marginBps), width: 120 },
  { key: 'pickupShip', label: 'Pick-up/Ship', group: 'Shipment', value: (r) => formatBoardDate(r.shipDate), width: 110 },
  // ── Existing MVMNT columns, unchanged ─────────────────────────────────────
  { key: 'originCity', label: 'Origin', group: 'Shipment', value: (r) => r.originCity ?? '', sortKey: 'originCity', width: 150 },
  { key: 'destinationCity', label: 'Destination', group: 'Shipment', value: (r) => r.destinationCity ?? '', sortKey: 'destinationCity', width: 150 },
  { key: 'pickupAppt', label: 'Pick up', group: 'Shipment', value: (r) => formatBoardDate(r.pickupAppt), sortKey: 'pickupAppt', width: 100 },
  { key: 'deliveryAppt', label: 'Delivery', group: 'Shipment', value: (r) => formatBoardDate(r.deliveryAppt), sortKey: 'deliveryAppt', width: 100 },
  // The appointment workflow status set on the Appts page, on the shipment itself (Ryne queue): first pickup and last delivery stop.
  { key: 'pickupApptStatus', label: 'Pickup Appt Status', group: 'Shipment', value: (r) => apptStatusText(r, 'pickup'), width: 150 },
  { key: 'deliveryApptStatus', label: 'Delivery Appt Status', group: 'Shipment', value: (r) => apptStatusText(r, 'delivery'), width: 150 },
  { key: 'stops', label: 'Stops', group: 'Computed', value: (r) => (r.stopCount == null ? '' : String(r.stopCount)), width: 70 },
  { key: 'salesRepId', label: 'Customer rep', group: 'Order', value: (r) => r.salesRepName ?? r.customerRepName ?? '', width: 140 },
  { key: 'driver', label: 'Driver', group: 'Load', value: (r) => driverNamesOf(r).join(', ') },
  { key: 'truck', label: 'Truck', group: 'Load', value: (r) => r.truckNumber ?? '', width: 100 },
  { key: 'arStatus', label: 'AR', group: 'Order', value: (r) => enumLabel(r.arStatus), width: 120 },
  { key: 'apStatus', label: 'AP', group: 'Carrier leg', value: (r) => enumLabel(r.apStatus), width: 120 },
  {
    key: 'lastUpdateAt',
    label: 'Last update',
    group: 'Load',
    value: (r) => [formatBoardDateTime(r.lastUpdateAt), r.lastUpdatePlace].filter(Boolean).join(' · '),
    width: 180,
  },
  { key: 'nextCheckCallAt', label: 'Next check call', group: 'Load', value: (r) => formatBoardDateTime(r.nextCheckCallAt), width: 160 },
  {
    key: 'openIncidentCount',
    label: 'Exceptions',
    group: 'Computed',
    value: (r) => ((r.openIncidentCount ?? 0) > 0 ? String(r.openIncidentCount) : ''),
    width: 110,
  },
  { key: 'mode', label: 'Mode', group: 'Shipment', value: (r) => r.mode, width: 90 },
  {
    // The order form's `shipmentType` key when the projected row carries it; else derived from the stored mode
    // (the board projection has no other source: no extra order read).
    key: 'shipmentType',
    label: 'Shipment type',
    group: 'Shipment',
    value: (r) => shipmentTypeLabel(rowShipmentType(r)),
    width: 160,
  },
  /*
   * Three states, and the CSV says which in words: nothing at all when the gate has
   * never run for this shipment, "Complete" when it has and found everything, and the
   * count when paperwork is outstanding. A blank cell is not "complete".
   */
  {
    key: 'docsMissing',
    label: 'Docs',
    group: 'Computed',
    value: (r) => {
      const missing = docsMissingOf(r)
      return r.docsMissing == null && missing.length === 0 ? '' : missing.length === 0 ? 'Complete' : `${missing.length} missing`
    },
    width: 120,
  },
  // ── Shipment ─────────────────────────────────────────────────────────────
  { key: 'previousStatus', label: 'Previous Status', group: 'Shipment', value: (r) => (r.previousStatus ? SHIPMENT_STATUS_LABELS[r.previousStatus] : ''), width: 140 },
  { key: 'statusChangedAt', label: 'Status Changed At', group: 'Shipment', value: (r) => formatBoardDateTime(r.statusChangedAt), width: 150 },
  { key: 'statusChangedBy', label: 'Status Changed By', group: 'Shipment', value: (r) => r.statusChangedByName ?? r.statusChangedBy ?? '', width: 150 },
  { key: 'holdReason', label: 'Hold Reason', group: 'Shipment', value: (r) => r.holdReason ?? '', width: 160 },
  { key: 'voidReason', label: 'Cancel/Void Reason', group: 'Shipment', value: (r) => r.cancelReason ?? r.voidReason ?? '', width: 170 },
  { key: 'pickupMonth', label: 'Pickup Month', group: 'Shipment', value: (r) => r.pickupMonth ?? '', width: 110 },
  { key: 'originState', label: 'Origin State', group: 'Shipment', value: (r) => r.fromState ?? '', width: 100 },
  { key: 'destinationState', label: 'Destination State', group: 'Shipment', value: (r) => r.toState ?? '', width: 120 },
  { key: 'source', label: 'Source', group: 'Shipment', value: (r) => enumLabel(r.source), width: 100 },
  { key: 'customerLinkSentAt', label: 'Customer Link Sent', group: 'Shipment', value: (r) => formatBoardDateTime(r.customerLinkSentAt), width: 150 },
  { key: 'deliveredAt', label: 'Delivered At', group: 'Shipment', value: (r) => formatBoardDateTime(r.deliveredAt), width: 140 },
  {
    key: 'lastNoticeAt',
    label: 'Last Notice',
    group: 'Shipment',
    value: (r) => [formatBoardDateTime(r.lastNoticeAt), r.lastNoticeStatus ? titleCase(r.lastNoticeStatus) : ''].filter(Boolean).join(' · '),
    width: 160,
  },
  { key: 'revSubdivision', label: 'Subsidiary', group: 'Shipment', value: (r) => r.revSubdivision ?? '', width: 130 },
  { key: 'revTagSource', label: 'Tag Source', group: 'Shipment', value: (r) => enumLabel(r.revTagSource), width: 100 },
  { key: 'datPostedAt', label: 'DAT Posted At', group: 'Shipment', value: (r) => formatBoardDateTime(r.datPostedAt), width: 140 },
  { key: 'voidedAt', label: 'Voided At', group: 'Shipment', value: (r) => formatBoardDateTime(voidedAtOf(r)), width: 140 },
  { key: 'voidedBy', label: 'Voided By', group: 'Shipment', value: (r) => r.voidedByName ?? r.voidedBy ?? r.deletedBy ?? '', width: 140 },
  { key: 'createdAt', label: 'Created At', group: 'Shipment', value: (r) => formatBoardDateTime(r.createdAt), width: 140 },
  { key: 'createdBy', label: 'Created By', group: 'Shipment', value: (r) => r.createdByName ?? r.createdBy ?? '', width: 150 },
  { key: 'updatedAt', label: 'Updated At', group: 'Shipment', value: (r) => formatBoardDateTime(r.updatedAt), width: 140 },
  { key: 'updatedBy', label: 'Updated By', group: 'Shipment', value: (r) => r.updatedByName ?? r.updatedBy ?? '', width: 150 },
  // ── Order (the customer side) ─────────────────────────────────────────────
  { key: 'billTo', label: 'Bill-To', group: 'Order', value: (r) => r.billToName ?? '', width: 160 },
  { key: 'costCenter', label: 'Cost Center', group: 'Order', value: (r) => r.costCenter ?? '', width: 120 },
  { key: 'rateType', label: 'Rate Type', group: 'Order', value: (r) => enumLabel(r.rateType), width: 100 },
  { key: 'refPo', label: 'PO', group: 'Order', value: (r) => r.refPo ?? '', width: 110 },
  { key: 'refPu', label: 'PU', group: 'Order', value: (r) => r.refPu ?? '', width: 110 },
  { key: 'refDelivery', label: 'Delivery #', group: 'Order', value: (r) => r.refDelivery ?? '', width: 110 },
  { key: 'refBol', label: 'BOL', group: 'Order', value: (r) => r.refBol ?? '', width: 110 },
  { key: 'equipmentLength', label: 'Equipment Length', group: 'Order', value: (r) => (r.equipmentLengthFt == null ? '' : `${r.equipmentLengthFt}'`), width: 120 },
  { key: 'specialRequirements', label: 'Special Requirements', group: 'Order', value: (r) => specialRequirementsLabel(r.specialRequirements), width: 180 },
  { key: 'freightCommodity', label: 'Freight Commodity', group: 'Order', value: (r) => r.orderCommodity ?? '', width: 160 },
  { key: 'freightWeight', label: 'Freight Weight', group: 'Order', value: (r) => formatLbsOrEmpty(r.freightWeightLbs), width: 120 },
  { key: 'freightPieces', label: 'Freight Pieces', group: 'Order', value: (r) => (r.freightPieces == null ? '' : String(r.freightPieces)), width: 110 },
  { key: 'freightPallets', label: 'Freight Pallets', group: 'Order', value: (r) => (r.freightPallets == null ? '' : String(r.freightPallets)), width: 110 },
  { key: 'customerNotes', label: 'Customer Notes', group: 'Order', value: (r) => r.customerNotes ?? '', width: 200 },
  { key: 'internalNotes', label: 'Internal Notes', group: 'Order', value: (r) => r.internalNotes ?? '', width: 200 },
  { key: 'customerRate', label: 'Customer Rate', group: 'Order', value: (r) => formatCentsOrEmpty(r.customerRateCents), width: 130 },
  { key: 'orderRevenue', label: 'Order Revenue', group: 'Order', value: (r) => formatCentsOrEmpty(r.orderRevenueCents), width: 130 },
  { key: 'arStatusChangedAt', label: 'AR Status Changed At', group: 'Order', value: (r) => formatBoardDateTime(r.arStatusChangedAt), width: 160 },
  { key: 'invoiceNumber', label: 'Invoice #', group: 'Order', value: (r) => r.invoiceNumber ?? '', width: 120 },
  { key: 'invoicedAt', label: 'Invoiced At', group: 'Order', value: (r) => formatBoardDateTime(r.invoicedAt), width: 140 },
  { key: 'paidAt', label: 'Paid At', group: 'Order', value: (r) => formatBoardDateTime(r.paidAt), width: 140 },
  { key: 'arBalance', label: 'AR Balance', group: 'Order', value: (r) => formatCentsOrEmpty(r.arBalanceCents), width: 120 },
  { key: 'invoiceStatus', label: 'Invoice Status', group: 'Order', value: (r) => loadInvoiceStatusText(invoiceStatusOfRow(r), formatBoardDate), width: 150 },
  { key: 'factorInfo', label: 'Factoring Info', group: 'Order', value: (r) => factorInfoTitle(r), width: 110 },
  { key: 'factoringItem', label: 'Factoring Item', group: 'Order', value: (r) => r.factoringItemId ?? '', width: 140 },
  {
    key: 'docsRequired',
    label: 'Docs Required',
    group: 'Order',
    value: (r) => (r.docsRequired ?? []).map((type) => (DOCUMENT_TYPE_LABELS as Record<string, string>)[type] ?? type).join(', '),
    width: 180,
  },
  { key: 'docsCheckedAt', label: 'Docs Checked At', group: 'Order', value: (r) => formatBoardDateTime(r.docsCheckedAt), width: 150 },
  {
    key: 'docsOverride',
    label: 'Docs Override',
    group: 'Order',
    value: (r) => {
      if (!r.docsOverrideAt) return ''
      return [
        formatBoardDateTime(r.docsOverrideAt),
        r.docsOverrideBy ?? '',
        r.docsOverrideNote ? `: ${r.docsOverrideNote}` : '',
      ].join(' ').trim()
    },
    width: 200,
  },
  { key: 'quoteNumber', label: 'Quote #', group: 'Order', value: (r) => r.quoteNumber ?? '', width: 110 },
  { key: 'quoteAmount', label: 'Quote Amount', group: 'Order', value: (r) => formatCentsOrEmpty(r.quoteAmountCents), width: 130 },
  // ── Load (legacy and own-fleet) ───────────────────────────────────────────
  { key: 'loadAljexId', label: 'Load PRO (Aljex)', group: 'Load', value: (r) => r.loadAljexId ?? '', width: 130 },
  { key: 'loadTmsId', label: 'Load TMS ID', group: 'Load', value: (r) => r.loadTmsId ?? '', width: 130 },
  { key: 'pickupNumber', label: 'Pickup Number', group: 'Load', value: (r) => r.pickupNumber ?? '', width: 130 },
  { key: 'originName', label: 'Origin Name', group: 'Load', value: (r) => r.pickupName ?? '', width: 170 },
  { key: 'destinationName', label: 'Destination Name', group: 'Load', value: (r) => r.consigneeName ?? '', width: 170 },
  { key: 'pickupApptEnd', label: 'Pickup Appt End', group: 'Load', value: (r) => formatBoardDateTime(r.pickupApptEnd), width: 150 },
  { key: 'pickupApptType', label: 'Pickup Appt Type', group: 'Load', value: (r) => enumLabel(r.pickupApptType), width: 130 },
  { key: 'deliveryApptEnd', label: 'Delivery Appt End', group: 'Load', value: (r) => formatBoardDateTime(r.deliveryApptEnd), width: 150 },
  { key: 'deliveryApptType', label: 'Delivery Appt Type', group: 'Load', value: (r) => enumLabel(r.deliveryApptType), width: 140 },
  { key: 'pickupDriver', label: 'Pickup Driver', group: 'Load', value: (r) => r.pickupDriverName ?? '', width: 140 },
  { key: 'deliveryDriver', label: 'Delivery Driver', group: 'Load', value: (r) => r.deliveryDriverName ?? '', width: 140 },
  { key: 'loadTrailer', label: 'Load Trailer', group: 'Load', value: (r) => r.loadTrailerNumber ?? '', width: 110 },
  { key: 'loadRate', label: 'Load Rate', group: 'Load', value: (r) => formatCentsOrEmpty(r.loadRateCents), width: 120 },
  { key: 'miles', label: 'Miles', group: 'Load', value: (r) => (r.miles == null ? '' : r.miles.toLocaleString('en-US')), width: 90 },
  { key: 'hot', label: 'Hot', group: 'Load', value: (r) => flagOrEmpty(r.hot), width: 70 },
  { key: 'loadCommodity', label: 'Load Commodity', group: 'Load', value: (r) => r.commodity ?? '', width: 160 },
  { key: 'loadWeight', label: 'Load Weight', group: 'Load', value: (r) => formatLbsOrEmpty(r.weightLbs), width: 120 },
  {
    key: 'loadPieces',
    label: 'Load Pieces',
    group: 'Load',
    value: (r) => (r.pieces == null ? '' : `${r.pieces}${r.piecesUnit ? ` ${r.piecesUnit}` : ''}`),
    width: 110,
  },
  { key: 'paperworkLocation', label: 'Paperwork', group: 'Load', value: (r) => paperworkShortLabel(r.paperworkLocation) ?? '', width: 130 },
  { key: 'eldReviewedAt', label: 'ELD Reviewed At', group: 'Load', value: (r) => formatBoardDateTime(r.eldLogsReviewedAt), width: 150 },
  { key: 'eldReviewedBy', label: 'ELD Reviewed By', group: 'Load', value: (r) => r.eldLogsReviewedByName ?? r.eldLogsReviewedBy ?? '', width: 140 },
  { key: 'readyToInvoice', label: 'Ready To Invoice', group: 'Load', value: (r) => yesNoOrEmpty(r.readyToInvoice), width: 130 },
  { key: 'rateConOnFile', label: 'Rate Con On File', group: 'Load', value: (r) => yesNoOrEmpty(r.rateConOnFile), width: 130 },
  { key: 'assignmentType', label: 'Assignment', group: 'Load', value: (r) => enumLabel(r.assignmentType), width: 130 },
  { key: 'divisionKey', label: 'Division Key', group: 'Load', value: (r) => r.divisionKey ?? '', width: 110 },
  { key: 'trackingProvider', label: 'Tracking Provider', group: 'Load', value: (r) => enumLabel(r.trackingProvider), width: 130 },
  { key: 'nextCheckCallNote', label: 'Next Check Call Note', group: 'Load', value: (r) => r.nextCheckCallNote ?? '', width: 180 },
  { key: 'checkCallOpen', label: 'Check Call Open', group: 'Load', value: (r) => (r.checkCallOpen === 'OPEN' ? 'Yes' : ''), width: 120 },
  { key: 'lastCheckCallAt', label: 'Last Check Call At', group: 'Load', value: (r) => formatBoardDateTime(r.lastCheckCallAt), width: 150 },
  { key: 'lastCheckCallType', label: 'Last Check Call Type', group: 'Load', value: (r) => enumLabel(r.lastCheckCallType), width: 150 },
  { key: 'lastKnownAt', label: 'Last Known At', group: 'Load', value: (r) => formatBoardDateTime(r.lastKnownAt), width: 140 },
  { key: 'lastKnownCity', label: 'Last Known City', group: 'Load', value: (r) => r.lastKnownCity ?? '', width: 140 },
  { key: 'lastKnownState', label: 'Last Known State', group: 'Load', value: (r) => r.lastKnownState ?? '', width: 130 },
  { key: 'lastKnownSource', label: 'Last Known Source', group: 'Load', value: (r) => enumLabel(r.lastKnownSource), width: 140 },
  { key: 'loadDeliveredAt', label: 'Load Delivered At', group: 'Load', value: (r) => formatBoardDateTime(r.loadDeliveredAt), width: 150 },
  { key: 'cargoValue', label: 'Cargo Value', group: 'Load', value: (r) => formatCentsOrEmpty(r.cargoValueCents), width: 120 },
  { key: 'loadNotes', label: 'Load Notes', group: 'Load', value: (r) => r.loadNotes ?? '', width: 200 },
  { key: 'podNotes', label: 'POD Notes', group: 'Load', value: (r) => r.podNotes ?? '', width: 200 },
  // ── Carrier leg (the ACTIVE LoadCarrier) ──────────────────────────────────
  { key: 'carrierName', label: 'Carrier Name', group: 'Carrier', value: (r) => r.carrierName ?? '', width: 180 },
  // Step AM: the assignment ladder chip; the shipment's own status takes over once driver info is in and it is moving.
  { key: 'carrierAssignment', label: 'Carrier Status', group: 'Carrier leg', value: (r) => assignmentChipText(r, statusWithProgress(r)), width: 260 },
  { key: 'carrierMc', label: 'Carrier MC', group: 'Carrier leg', value: (r) => r.carrierMc ?? '', width: 110 },
  { key: 'carrierRep', label: 'Carrier Rep', group: 'Carrier leg', value: (r) => r.dispatcherAssignedName ?? r.dispatcherAssignedId ?? '', width: 140 },
  { key: 'carrierDispatcher', label: 'Carrier Dispatcher', group: 'Carrier leg', value: (r) => r.carrierDispatcherName ?? '', width: 150 },
  { key: 'carrierDispatcherPhone', label: 'Dispatcher Phone', group: 'Carrier leg', value: (r) => r.carrierDispatcherPhone ?? '', width: 130 },
  { key: 'carrierDispatcherEmail', label: 'Dispatcher Email', group: 'Carrier leg', value: (r) => r.carrierDispatcherEmail ?? '', width: 170 },
  { key: 'driverPhone', label: 'Driver Phone', group: 'Carrier leg', value: (r) => r.driverPhone ?? '', width: 130 },
  { key: 'driver2', label: 'Driver 2', group: 'Carrier leg', value: (r) => r.driver2Name ?? '', width: 140 },
  { key: 'driver2Phone', label: 'Driver 2 Phone', group: 'Carrier leg', value: (r) => r.driver2Phone ?? '', width: 130 },
  { key: 'trailerNumber', label: 'Trailer Number', group: 'Carrier leg', value: (r) => r.trailerNumber ?? '', width: 120 },
  { key: 'plates', label: 'Plates', group: 'Carrier leg', value: (r) => r.plates ?? '', width: 100 },
  { key: 'vin', label: 'VIN', group: 'Carrier leg', value: (r) => r.vin ?? '', width: 150 },
  { key: 'seal', label: 'Seal', group: 'Carrier leg', value: (r) => r.sealNumber ?? '', width: 100 },
  { key: 'tripNumber', label: 'Trip #', group: 'Carrier leg', value: (r) => r.tripNumber ?? '', width: 110 },
  { key: 'pickupEta', label: 'Pickup ETA', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.pickupEtaAt), width: 140 },
  { key: 'deliveryEta', label: 'Delivery ETA', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.deliveryEtaAt), width: 140 },
  { key: 'rateConStatus', label: 'Rate Con Status', group: 'Carrier leg', value: (r) => (r.rateConStatus ? rateConStatusText(r.rateConStatus, r.rateConVersion) : enumLabel(r.rateConStatus)), width: 130 },
  { key: 'rateConSentAt', label: 'Rate Con Sent At', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.rateConSentAt), width: 150 },
  { key: 'rateConSignedAt', label: 'Rate Con Signed At', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.rateConSignedAt), width: 150 },
  { key: 'carrierRate', label: 'Carrier Rate', group: 'Carrier leg', value: (r) => formatCentsOrEmpty(r.carrierRateCents), width: 120 },
  { key: 'legCost', label: 'Carrier Cost', group: 'Carrier leg', value: (r) => formatCentsOrEmpty(r.legCostCents), width: 120 },
  { key: 'apBalance', label: 'AP Balance', group: 'Carrier leg', value: (r) => formatCentsOrEmpty(r.apBalanceCents), width: 120 },
  { key: 'apPaidAt', label: 'AP Paid At', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.apPaidAt), width: 140 },
  {
    key: 'quickPay',
    label: 'Quick Pay',
    group: 'Carrier leg',
    value: (r) => {
      if (r.quickPay == null) return ''
      if (!r.quickPay) return 'No'
      const terms = [r.quickPayDays != null ? `${r.quickPayDays} days` : '', r.quickPayFeeBps != null ? formatBpsOrEmpty(r.quickPayFeeBps) : '']
        .filter(Boolean).join(' · ')
      return terms || 'Yes'
    },
    width: 130,
  },
  { key: 'paymentTerms', label: 'Carrier Payment Terms', group: 'Carrier leg', value: (r) => paymentTermsLabel(r.paymentTermsDays), width: 150 },
  { key: 'bookedAt', label: 'Booked At', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.bookedAt), width: 140 },
  { key: 'dispatchedAt', label: 'Dispatched At', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.dispatchedAt), width: 140 },
  { key: 'trackingStartedAt', label: 'Tracking Started', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.trackingStartedAt), width: 140 },
  { key: 'trackingStoppedAt', label: 'Tracking Stopped', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.trackingStoppedAt), width: 140 },
  { key: 'podRequestedAt', label: 'POD Requested At', group: 'Carrier leg', value: (r) => formatBoardDateTime(r.podRequestedAt), width: 150 },
  {
    key: 'legDocs',
    label: 'Carrier Docs',
    group: 'Carrier leg',
    value: (r) => (r.legDocsMissing == null ? '' : r.legDocsMissing.length === 0 ? 'Complete' : `${r.legDocsMissing.length} missing`),
    width: 120,
  },
  { key: 'rating', label: 'Carrier Rating', group: 'Carrier leg', value: (r) => (r.ratingStars == null ? '' : `${r.ratingStars}/5`), width: 110 },
  // ── Customer directory ────────────────────────────────────────────────────
  { key: 'customerMc', label: 'Customer MC', group: 'Customer', value: (r) => r.customerMc ?? '', width: 110 },
  { key: 'customerDot', label: 'Customer DOT', group: 'Customer', value: (r) => r.customerDot ?? '', width: 110 },
  { key: 'customerFactored', label: 'Factored', group: 'Customer', value: (r) => yesNoOrEmpty(r.customerFactored), width: 90 },
  { key: 'customerPaymentTerms', label: 'Customer Payment Terms', group: 'Customer', value: (r) => paymentTermsLabel(r.customerPaymentTermsDays), width: 160 },
  { key: 'creditLimit', label: 'Credit Limit', group: 'Customer', value: (r) => formatCentsOrEmpty(r.creditLimitCents), width: 120 },
  { key: 'creditHold', label: 'Credit Hold', group: 'Customer', value: (r) => flagOrEmpty(r.creditHold), width: 100 },
  { key: 'customerStatus', label: 'Customer Status', group: 'Customer', value: (r) => enumLabel(r.customerStatus), width: 130 },
  { key: 'serviceTier', label: 'Service Tier', group: 'Customer', value: (r) => r.serviceTier ?? '', width: 110 },
  { key: 'customerTeam', label: 'Customer Team', group: 'Customer', value: (r) => r.customerTeamKey ?? '', width: 120 },
  { key: 'customerOwners', label: 'Customer Account Owners', group: 'Customer', value: (r) => r.customerOwnerNames ?? '', width: 180 },
  { key: 'defaultSalesRep', label: 'Default Sales Rep', group: 'Customer', value: (r) => r.defaultSalesRepName ?? '', width: 150 },
  { key: 'invoiceFrequency', label: 'Invoice Frequency', group: 'Customer', value: (r) => enumLabel(r.invoiceFrequency), width: 140 },
  // ── Carrier directory ─────────────────────────────────────────────────────
  { key: 'carrierDot', label: 'Carrier DOT', group: 'Carrier', value: (r) => r.carrierDot ?? '', width: 110 },
  { key: 'carrierScac', label: 'SCAC', group: 'Carrier', value: (r) => r.carrierScac ?? '', width: 90 },
  { key: 'carrierStatus', label: 'Carrier Status', group: 'Carrier', value: (r) => enumLabel(r.carrierStatus), width: 120 },
  { key: 'authorityStatus', label: 'Authority', group: 'Carrier', value: (r) => enumLabel(r.authorityStatus), width: 100 },
  { key: 'safetyRating', label: 'Safety Rating', group: 'Carrier', value: (r) => enumLabel(r.safetyRating), width: 120 },
  { key: 'cargoInsuranceExpiry', label: 'Cargo Insurance Expires', group: 'Carrier', value: (r) => formatBoardDate(r.cargoInsuranceExpiresAt), width: 160 },
  { key: 'liabilityInsuranceExpiry', label: 'Liability Insurance Expires', group: 'Carrier', value: (r) => formatBoardDate(r.liabilityInsuranceExpiresAt), width: 170 },
  { key: 'mcpStatus', label: 'MyCarrierPackets', group: 'Carrier', value: (r) => r.mcpStatus ?? '', width: 140 },
  { key: 'highwayStatus', label: 'Highway', group: 'Carrier', value: (r) => enumLabel(r.highwayStatus), width: 100 },
  { key: 'rmisStatus', label: 'RMIS', group: 'Carrier', value: (r) => enumLabel(r.rmisStatus), width: 90 },
  { key: 'quickPayEligible', label: 'Quick-Pay Eligible', group: 'Carrier', value: (r) => yesNoOrEmpty(r.quickPayEligible), width: 130 },
  { key: 'carrierTeam', label: 'Carrier Team', group: 'Carrier', value: (r) => r.carrierTeamKey ?? '', width: 120 },
  { key: 'carrierOwners', label: 'Carrier Account Owners', group: 'Carrier', value: (r) => r.carrierOwnerNames ?? '', width: 180 },
  { key: 'carrierLoadCount', label: 'Carrier Loads', group: 'Carrier', value: (r) => (r.carrierLoadCount == null ? '' : String(r.carrierLoadCount)), width: 110 },
  { key: 'carrierLastLoadAt', label: 'Carrier Last Load', group: 'Carrier', value: (r) => formatBoardDate(r.carrierLastLoadAt), width: 130 },
  // ── Computed ─────────────────────────────────────────────────────────────
  {
    key: 'stopProgress',
    label: 'Stop Progress',
    group: 'Computed',
    value: (r) => {
      const { done, total } = stopProgressOf(r)
      return total === 0 ? '' : `${done}/${total}`
    },
    width: 110,
  },
  { key: 'daysInStatus', label: 'Days In Status', group: 'Computed', value: daysInStatusOf, width: 120 },
  { key: 'podStatus', label: 'POD Status', group: 'Computed', value: (r) => POD_STATUS_TEXT[podStatusOf(r)], width: 56 },
  { key: 'docsNeededCount', label: 'Docs Needed', group: 'Computed', value: (r) => (r.docsMissing == null ? '' : String(r.docsMissing.length)), width: 110 },
  {
    key: 'podPresent',
    // Ryne 2026-11-11: just "POD", with a Y when the POD is in and blank when it is not (or not known yet).
    label: 'POD',
    group: 'Computed',
    // Car shipping (auto shippers) has no POD or RC to chase: both columns stay blank for it (Ryne 2026-11-11).
    value: (r) => DOC_CELL_TEXT[docCellOf(r, 'POD')],
    width: 56,
  },
  {
    key: 'rateConPresent',
    // Ryne 2026-11-11: "RC", a Y when the rate confirmation is on file or signed and blank otherwise, fixed beside POD.
    label: 'RC',
    group: 'Computed',
    value: (r) => DOC_CELL_TEXT[docCellOf(r, 'RATE_CON')],
    width: 56,
  },
  { key: 'postedBoards', label: 'Posted Boards', group: 'Computed', value: (r) => (r.datPostedAt ? 'DAT' : ''), width: 120 },
  { key: 'nextEvent', label: 'Next Event', group: 'Computed', value: nextEventOf, width: 160 },
  { key: 'trackingMotion', label: 'Motion', group: 'Computed', value: trackingMotionOf, width: 100 },
]

/** MVMNT's thirteen visible columns. */
export const DEFAULT_COLUMN_KEYS = [
  'number', 'status', 'originCity', 'destinationCity', 'pickupAppt', 'deliveryAppt',
  'stops', 'salesRepId', 'customerName', 'carrier', 'revenueType', 'driver',
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
    carriers: row.carriers ?? null,
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


export interface DivisionProfit { revenueCents: number; profitCents: number; count: number }
export interface ProfitByDivision {
  brokerage: DivisionProfit
  assets: DivisionProfit
  /** Car shipping, untagged and anything else. */
  other: DivisionProfit
  total: DivisionProfit
}

/**
 * Revenue and gross profit of the rows split into Brokerage, Assets (Ivan Cartage and its Local / Owner Operator / Box Truck
 * subdivisions) and Other, with the same per-row figures the stats strip already adds up.
 */
export function profitByDivision(rows: readonly ShipmentRow[], topLevel: (code: string) => string | null): ProfitByDivision {
  const zero = (): DivisionProfit => ({ revenueCents: 0, profitCents: 0, count: 0 })
  const out: ProfitByDivision = { brokerage: zero(), assets: zero(), other: zero(), total: zero() }
  for (const r of rows) {
    const top = r.revDivision ? (topLevel(r.revDivision) ?? r.revDivision) : null
    const bucket = top === 'BROKERAGE' ? out.brokerage : top === 'ASSETS' ? out.assets : out.other
    for (const b of [bucket, out.total]) {
      b.revenueCents += r.revenueCents ?? 0
      b.profitCents += r.profitCents ?? 0
      b.count += 1
    }
  }
  return out
}
