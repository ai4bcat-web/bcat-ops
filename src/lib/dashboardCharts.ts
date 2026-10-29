/**
 * The Brokerage dashboard's arithmetic (Step R).
 *
 * Everything here is pure: it takes the bundle `useBrokerageDashboard` loaded and the
 * filter row, and returns rows of numbers. No React, no I/O, no invented figures — a
 * dimension nothing carries comes back as its real zero with a label that says so.
 *
 * Shape of the work:
 *   `hydrateLoads` joins the shipment / leg / sample facts onto a board load once,
 *   `applyFilters` narrows the whole bundle (memoised per bundle + filter string, so the
 *   26 cards filter once between them), `groupKey` turns a row into its legend label, and
 *   `collect` → `rankRows`/`limitRows` → `toSeries` builds a `ChartSeries`.
 *
 * Money is integer cents throughout; margin is basis points (4670 = 46.7%) and is 0 — not
 * an em dash, not a guess — when there is no revenue to divide by.
 */
import { formatCents } from './invoiceBuild'
import { SHIPMENT_STATUS_LABELS } from './shipmentStatus'
import type { LoadBoardSummary } from './apiClient'
import type {
  ChartSeries,
  DashboardData,
  DashboardFilters,
  DashboardGroupBy,
  LoadSummaryRecord,
  ValueFormat,
} from '@/features/tms/dashboard/types'
import type {
  LaneRateSampleRecord,
  LoadCarrierRecord,
  OrderRecord,
  QuoteRecord,
  ShipmentRecord,
  ShipmentStatus,
} from '@/types/tms'

// ── Labels for a dimension nothing filled in ─────────────────────────────────

export const UNGROUPED = 'total'
export const UNTAGGED = 'Untagged'
export const NO_SUBDIVISION = 'No subdivision'
export const UNASSIGNED = 'Unassigned'
export const NO_CUSTOMER = 'No customer'
export const NO_CARRIER = 'No carrier'
export const OWN_FLEET = 'Own fleet'
export const NO_STATUS = 'No status'
export const NO_DATE = 'No date'

// ── Dates ────────────────────────────────────────────────────────────────────

/** `'YYYY-MM-DD'` of a date or an ISO instant; null when there is no date at all. */
export function dateOf(value: string | null | undefined): string | null {
  if (!value) return null
  const day = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

/** `'YYYY-MM'` of a date or an ISO instant. */
export function monthOf(value: string | null | undefined): string | null {
  const day = dateOf(value)
  return day ? day.slice(0, 7) : null
}

/** Inclusive on both ends; `from`/`to` are `'YYYY-MM-DD'`. */
export function inWindow(value: string | null | undefined, from: string, to: string): boolean {
  const day = dateOf(value)
  return day !== null && day >= from && day <= to
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `'2026-10'` → `'Oct 2026'`. */
export function monthLabel(month: string): string {
  const [year, mm] = month.split('-')
  const index = Number(mm) - 1
  return MONTH_NAMES[index] ? `${MONTH_NAMES[index]} ${year}` : month
}

/** Every `'YYYY-MM'` the window touches, oldest first — what the month reads ask for. */
export function monthsBetween(from: string, to: string): string[] {
  const first = monthOf(from)
  const last = monthOf(to)
  if (!first || !last || last < first) return first ? [first] : []
  const months: string[] = []
  let [year, month] = first.split('-').map(Number)
  for (;;) {
    const ym = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
    months.push(ym)
    if (ym >= last || months.length > 120) break
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return months
}

/** `'2026-10-08'` → `'10/8/26'` — the short date the tables print. */
export function shortDate(value: string | null | undefined): string {
  const day = dateOf(value)
  if (!day) return ''
  const [year, month, date] = day.split('-')
  return `${Number(month)}/${Number(date)}/${year.slice(2)}`
}

// ── Number printing ──────────────────────────────────────────────────────────

const counts = new Intl.NumberFormat('en-US')

export function formatValue(value: number, format: ValueFormat): string {
  switch (format) {
    case 'cents': return formatCents(Math.round(value))
    case 'bps': return `${(value / 100).toFixed(1)}%`
    case 'percent': return `${Math.round(value)}%`
    case 'hours': return `${value.toFixed(1)} h`
    default: return counts.format(Math.round(value))
  }
}

// ── The joins every card needs ───────────────────────────────────────────────

export interface DataIndex {
  shipmentById: Map<string, ShipmentRecord>
  orderById: Map<string, OrderRecord>
  orderByShipmentId: Map<string, OrderRecord>
  loadById: Map<string, LoadSummaryRecord>
  activeLegByShipmentId: Map<string, LoadCarrierRecord>
  sampleByLoadId: Map<string, LaneRateSampleRecord>
  divisionName(code: string | null | undefined): string
  repLabel(id: string | null | undefined): string
}

const indexCache = new WeakMap<DashboardData, DataIndex>()

/** The lookup tables for one bundle, built once and kept with it. */
export function indexOf(data: DashboardData): DataIndex {
  const cached = indexCache.get(data)
  if (cached) return cached

  const shipmentById = new Map(data.shipments.map((s) => [s.id, s]))
  const orderById = new Map(data.orders.map((o) => [o.id, o]))
  const orderByShipmentId = new Map<string, OrderRecord>()
  for (const order of data.orders) if (!orderByShipmentId.has(order.shipmentId)) orderByShipmentId.set(order.shipmentId, order)
  const loadById = new Map(data.loads.map((l) => [l.id, l]))
  const activeLegByShipmentId = new Map<string, LoadCarrierRecord>()
  for (const leg of data.loadCarriers) {
    if (leg.status === 'ACTIVE' && leg.shipmentId) activeLegByShipmentId.set(leg.shipmentId, leg)
  }
  const sampleByLoadId = new Map(data.samples.map((s) => [s.loadId, s]))

  const divisionNames = new Map(data.divisions.map((d) => [d.code, d.name]))
  const profileById = new Map(data.profiles.map((p) => [p.id, p]))

  const index: DataIndex = {
    shipmentById,
    orderById,
    orderByShipmentId,
    loadById,
    activeLegByShipmentId,
    sampleByLoadId,
    divisionName: (code) => (code ? divisionNames.get(code) ?? code : UNTAGGED),
    repLabel: (id) => {
      if (!id) return UNASSIGNED
      const profile = profileById.get(id)
      // Legacy rows carry an e-mail where a Cognito username belongs; show the e-mail.
      return profile?.name?.trim() || profile?.email || id
    },
  }
  indexCache.set(data, index)
  return index
}

// ── One row, as a chart sees it ──────────────────────────────────────────────

export interface GroupRow {
  revDivision?: string | null
  revSubdivision?: string | null
  salesRepId?: string | null
  customerRepId?: string | null
  customerId?: string | null
  customerName?: string | null
  carrierId?: string | null
  carrierName?: string | null
  status?: string | null
  date?: string | null
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return NO_STATUS
  return SHIPMENT_STATUS_LABELS[status as ShipmentStatus] ?? status
}

/** The rep who owns a shipment: the sales rep, else the order's customer rep. */
export function repOfShipment(shipment: ShipmentRecord, index: DataIndex): string | null {
  return shipment.salesRepId ?? index.orderByShipmentId.get(shipment.id)?.customerRepId ?? null
}

export function shipmentRow(shipment: ShipmentRecord, data: DashboardData): GroupRow {
  const index = indexOf(data)
  const leg = index.activeLegByShipmentId.get(shipment.id)
  return {
    revDivision: shipment.revDivision ?? null,
    revSubdivision: shipment.revSubdivision ?? null,
    salesRepId: repOfShipment(shipment, index),
    customerId: shipment.customerId,
    customerName: shipment.customerName ?? null,
    carrierId: leg?.carrierId ?? null,
    carrierName: leg?.carrierName ?? null,
    status: shipment.status,
    date: shipment.pickupAppt ?? null,
  }
}

export function sampleRow(sample: LaneRateSampleRecord, data: DashboardData): GroupRow {
  const shipment = sample.shipmentId ? indexOf(data).shipmentById.get(sample.shipmentId) : undefined
  return {
    // A sample taken before the tag backfill reads its shipment's tag instead.
    revDivision: sample.revDivision ?? shipment?.revDivision ?? null,
    revSubdivision: sample.revSubdivision ?? shipment?.revSubdivision ?? null,
    salesRepId: sample.salesRepId ?? sample.customerRepId ?? shipment?.salesRepId ?? null,
    customerId: sample.customerId ?? null,
    customerName: sample.customerName ?? null,
    carrierId: sample.carrierId ?? null,
    carrierName: sample.carrierName ?? (sample.assignmentKind === 'OWN_ASSET' ? OWN_FLEET : null),
    status: shipment?.status ?? sample.loadStatus ?? null,
    date: sample.date,
  }
}

export function loadRow(load: LoadSummaryRecord, data: DashboardData): GroupRow {
  const shipment = load.shipmentId ? indexOf(data).shipmentById.get(load.shipmentId) : undefined
  return {
    revDivision: load.revDivision ?? shipment?.revDivision ?? null,
    revSubdivision: load.revSubdivision ?? shipment?.revSubdivision ?? null,
    salesRepId: load.salesRepId ?? shipment?.salesRepId ?? null,
    customerId: load.customerId ?? shipment?.customerId ?? null,
    customerName: load.customerName ?? shipment?.customerName ?? null,
    carrierId: load.carrierId ?? null,
    carrierName: load.carrierName ?? null,
    status: load.shipmentStatus ?? shipment?.status ?? load.status ?? null,
    date: load.pickupAppt ?? shipment?.pickupAppt ?? null,
  }
}

export function quoteRow(quote: QuoteRecord, data: DashboardData): GroupRow {
  const shipment = quote.shipmentId ? indexOf(data).shipmentById.get(quote.shipmentId) : undefined
  return {
    revDivision: shipment?.revDivision ?? null,
    revSubdivision: shipment?.revSubdivision ?? null,
    salesRepId: quote.customerRepId ?? shipment?.salesRepId ?? null,
    customerId: quote.customerId ?? null,
    customerName: quote.customerName ?? null,
    carrierId: quote.carrierId ?? null,
    carrierName: quote.carrierName ?? null,
    status: shipment?.status ?? null,
    date: quote.quoteDate,
  }
}

/** The legend label for one row. `'total'` when the card is not grouped. */
export function groupKey(groupBy: DashboardGroupBy | null, row: GroupRow, data: DashboardData): string {
  if (!groupBy) return UNGROUPED
  const index = indexOf(data)
  switch (groupBy) {
    case 'DIVISION':
      return row.revDivision ? index.divisionName(row.revDivision) : UNTAGGED
    case 'SUBDIVISION':
      return row.revSubdivision ? index.divisionName(row.revSubdivision) : NO_SUBDIVISION
    case 'REP': {
      const rep = row.salesRepId ?? row.customerRepId ?? null
      return rep ? index.repLabel(rep) : UNASSIGNED
    }
    case 'CUSTOMER':
      return row.customerName?.trim() || row.customerId || NO_CUSTOMER
    case 'CARRIER':
      return row.carrierName?.trim() || row.carrierId || NO_CARRIER
    case 'STATUS':
      return statusLabel(row.status)
    case 'MONTH': {
      const month = monthOf(row.date)
      return month ? monthLabel(month) : NO_DATE
    }
  }
}

// ── Hydration ────────────────────────────────────────────────────────────────

/**
 * The board load plus what the dashboard needs and the summary read cannot carry: the
 * mirrored shipment's customer, mode, status and void marker, the ACTIVE leg's carrier,
 * and this load's POD / first-ping / check-call facts from its rate sample.
 */
export function hydrateLoads(
  loads: LoadBoardSummary[],
  shipments: ShipmentRecord[],
  loadCarriers: LoadCarrierRecord[],
  samples: LaneRateSampleRecord[],
): LoadSummaryRecord[] {
  const shipmentById = new Map(shipments.map((s) => [s.id, s]))
  const legById = new Map(loadCarriers.map((l) => [l.id, l]))
  const activeLegByLoadId = new Map<string, LoadCarrierRecord>()
  for (const leg of loadCarriers) if (leg.status === 'ACTIVE') activeLegByLoadId.set(leg.loadId, leg)
  const sampleByLoadId = new Map(samples.map((s) => [s.loadId, s]))

  return loads.map((load) => {
    const shipment = load.shipmentId ? shipmentById.get(load.shipmentId) : undefined
    const leg = (load.activeLoadCarrierId ? legById.get(load.activeLoadCarrierId) : undefined)
      ?? activeLegByLoadId.get(load.id)
    const sample = sampleByLoadId.get(load.id)
    return {
      ...load,
      revDivision: load.revDivision ?? shipment?.revDivision ?? null,
      revSubdivision: load.revSubdivision ?? shipment?.revSubdivision ?? null,
      salesRepId: load.salesRepId ?? shipment?.salesRepId ?? null,
      customerId: load.customerId ?? shipment?.customerId ?? null,
      customerName: shipment?.customerName ?? null,
      mode: shipment?.mode ?? null,
      pickupAppt: load.pickupAppt ?? shipment?.pickupAppt ?? null,
      deliveredAt: load.deliveredAt ?? shipment?.deliveredAt ?? null,
      datPostedAt: shipment?.datPostedAt ?? null,
      shipmentNumber: shipment?.number ?? null,
      shipmentStatus: shipment?.status ?? null,
      voidedAt: shipment?.voidedAt ?? null,
      activeLoadCarrierId: load.activeLoadCarrierId ?? leg?.id ?? null,
      carrierId: leg?.carrierId ?? sample?.carrierId ?? null,
      carrierName: load.carrierName ?? leg?.carrierName ?? sample?.carrierName ?? null,
      trackingProvider: load.trackingProvider ?? sample?.trackingProvider ?? null,
      podReceivedAt: sample?.podReceivedAt ?? null,
      firstPingAt: sample?.firstPingAt ?? null,
      checkCallsDue: sample?.checkCallsDue ?? null,
      checkCallsMet: sample?.checkCallsMet ?? null,
    }
  })
}

// ── Filtering ────────────────────────────────────────────────────────────────

function matchesDivision(filters: DashboardFilters, division: string | null | undefined, subdivision: string | null | undefined): boolean {
  if (filters.divisions.length > 0 && !(division && filters.divisions.includes(division))) return false
  if (filters.subdivisions.length > 0 && !(subdivision && filters.subdivisions.includes(subdivision))) return false
  return true
}

function filterSignature(filters: DashboardFilters): string {
  return JSON.stringify([
    [...filters.divisions].sort(), [...filters.subdivisions].sort(),
    filters.from, filters.to, filters.mode, filters.status,
    filters.customerId, filters.carrierId, filters.repId,
  ])
}

const filterCache = new WeakMap<DashboardData, Map<string, DashboardData>>()

/**
 * The bundle narrowed to the filter row. Idempotent — every card may call it, and the
 * result is memoised per (bundle, filters) so they all share one pass.
 *
 * Rules worth knowing:
 * - A voided shipment is never counted: Void is the only exit and a voided PRO is not work.
 * - The window is the **pickup** window over `pickupAppt`, and over a sample's own `date`.
 * - Open AR / AP carry no window — outstanding is outstanding — but they are narrowed by
 *   division / customer / rep through the order or load they belong to. One that cannot be
 *   resolved to a division is dropped while a division filter is on, so a Brokerage figure
 *   never quietly includes another business's money.
 * - A quote that has not become a shipment carries no division tag, so it survives a
 *   division filter; the card says so in its note.
 */
export function applyFilters(data: DashboardData, filters: DashboardFilters): DashboardData {
  const signature = filterSignature(filters)
  let perFilters = filterCache.get(data)
  if (!perFilters) { perFilters = new Map(); filterCache.set(data, perFilters) }
  const cached = perFilters.get(signature)
  if (cached) return cached

  const index = indexOf(data)
  const { from, to } = filters

  const shipments = data.shipments.filter((shipment) => {
    if (shipment.voidedAt) return false
    if (!matchesDivision(filters, shipment.revDivision, shipment.revSubdivision)) return false
    if (!inWindow(shipment.pickupAppt, from, to)) return false
    if (filters.mode && shipment.mode !== filters.mode) return false
    if (filters.status && shipment.status !== filters.status) return false
    if (filters.customerId && shipment.customerId !== filters.customerId) return false
    if (filters.repId && repOfShipment(shipment, index) !== filters.repId) return false
    if (filters.carrierId && index.activeLegByShipmentId.get(shipment.id)?.carrierId !== filters.carrierId) return false
    return true
  })
  const keptShipmentIds = new Set(shipments.map((s) => s.id))

  const loads = data.loads.filter((load) => {
    if (load.voidedAt) return false
    if (!matchesDivision(filters, load.revDivision, load.revSubdivision)) return false
    if (!inWindow(load.pickupAppt, from, to)) return false
    if (filters.mode && load.mode !== filters.mode) return false
    if (filters.status && (load.shipmentStatus ?? null) !== filters.status) return false
    if (filters.customerId && load.customerId !== filters.customerId) return false
    if (filters.repId && (load.salesRepId ?? null) !== filters.repId) return false
    if (filters.carrierId && (load.carrierId ?? null) !== filters.carrierId) return false
    return true
  })
  const keptLoadIds = new Set(loads.map((l) => l.id))

  const samples = data.samples.filter((sample) => {
    const row = sampleRow(sample, data)
    if (sample.shipmentId && index.shipmentById.get(sample.shipmentId)?.voidedAt) return false
    if (!matchesDivision(filters, row.revDivision, row.revSubdivision)) return false
    if (!inWindow(sample.date, from, to)) return false
    if (filters.mode && sample.mode !== filters.mode) return false
    if (filters.status && row.status !== filters.status) return false
    if (filters.customerId && sample.customerId !== filters.customerId) return false
    if (filters.repId && (row.salesRepId ?? null) !== filters.repId) return false
    if (filters.carrierId && (sample.carrierId ?? null) !== filters.carrierId) return false
    return true
  })

  const quotes = data.quotes.filter((quote) => {
    const row = quoteRow(quote, data)
    // Untagged (not yet a shipment) quotes survive a division filter; tagged ones must match.
    if (row.revDivision && !matchesDivision(filters, row.revDivision, row.revSubdivision)) return false
    if (!inWindow(quote.quoteDate, from, to)) return false
    if (filters.mode && quote.mode !== filters.mode) return false
    if (filters.customerId && quote.customerId !== filters.customerId) return false
    if (filters.repId && (quote.customerRepId ?? null) !== filters.repId) return false
    if (filters.carrierId && (quote.carrierId ?? null) !== filters.carrierId) return false
    return true
  })

  const narrowed = (division: string | null, subdivision: string | null, rep: string | null, customerId: string | null): boolean => {
    if (filters.divisions.length > 0 || filters.subdivisions.length > 0) {
      if (!division && !subdivision) return false
      if (!matchesDivision(filters, division, subdivision)) return false
    }
    if (filters.repId && rep !== filters.repId) return false
    if (filters.customerId && customerId !== filters.customerId) return false
    return true
  }

  const openInvoices = data.openInvoices.filter((invoice) => {
    const order = index.orderById.get(invoice.orderId)
    const shipment = order ? index.shipmentById.get(order.shipmentId) : undefined
    return narrowed(
      shipment?.revDivision ?? null,
      shipment?.revSubdivision ?? null,
      shipment ? repOfShipment(shipment, index) : order?.customerRepId ?? null,
      invoice.customerId ?? order?.customerId ?? null,
    )
  })

  const openBills = data.openBills.filter((bill) => {
    const load = index.loadById.get(bill.loadId)
    return narrowed(
      load?.revDivision ?? null,
      load?.revSubdivision ?? null,
      load?.salesRepId ?? null,
      load?.customerId ?? null,
    )
  })

  const result: DashboardData = {
    ...data,
    shipments,
    orders: data.orders.filter((order) => keptShipmentIds.has(order.shipmentId)),
    loads,
    loadCarriers: data.loadCarriers.filter((leg) => keptLoadIds.has(leg.loadId)),
    samples,
    quotes,
    openInvoices,
    openBills,
  }
  perFilters.set(signature, result)
  return result
}

// ── Buckets → series ─────────────────────────────────────────────────────────

export interface Bucket {
  revenueCents: number
  costCents: number
  profitCents: number
  count: number
}

export interface BucketRow {
  /** Stable identity (customer id, `'YYYY-MM'`, status code) — rows sort on it. */
  key: string
  label: string
  buckets: Map<string, Bucket>
}

export interface GroupedBuckets {
  rows: BucketRow[]
  groups: string[]
}

export type Metric = 'revenue' | 'cost' | 'profit' | 'margin' | 'count'

export function emptyBucket(): Bucket {
  return { revenueCents: 0, costCents: 0, profitCents: 0, count: 0 }
}

/** Priced facts only: a canceled or TONU'd sample is kept in the table, never counted. */
export function pricedSamples(samples: LaneRateSampleRecord[]): LaneRateSampleRecord[] {
  return samples.filter((s) => !s.excluded)
}

export function addSample(bucket: Bucket, sample: LaneRateSampleRecord): void {
  const revenue = sample.revenueCents ?? 0
  const cost = sample.costCents ?? 0
  bucket.revenueCents += revenue
  bucket.costCents += cost
  bucket.profitCents += sample.profitCents ?? revenue - cost
  bucket.count += 1
}

export function addCount(bucket: Bucket): void {
  bucket.count += 1
}

export function metricValue(bucket: Bucket, metric: Metric): number {
  switch (metric) {
    case 'revenue': return bucket.revenueCents
    case 'cost': return bucket.costCents
    case 'profit': return bucket.profitCents
    case 'count': return bucket.count
    // Margin never divides by nothing: no revenue is 0%, not infinity and not an estimate.
    case 'margin': return bucket.revenueCents > 0 ? Math.round((bucket.profitCents / bucket.revenueCents) * 10000) : 0
  }
}

/** Rows in first-seen order, groups in first-seen order. */
export function collect<T>(
  items: T[],
  rowOf: (item: T) => { key: string; label: string },
  groupOf: (item: T) => string,
  add: (bucket: Bucket, item: T) => void,
): GroupedBuckets {
  const rows = new Map<string, BucketRow>()
  const groups: string[] = []
  for (const item of items) {
    const { key, label } = rowOf(item)
    let row = rows.get(key)
    if (!row) { row = { key, label, buckets: new Map() }; rows.set(key, row) }
    const group = groupOf(item)
    if (!groups.includes(group)) groups.push(group)
    let bucket = row.buckets.get(group)
    if (!bucket) { bucket = emptyBucket(); row.buckets.set(group, bucket) }
    add(bucket, item)
  }
  return { rows: [...rows.values()], groups }
}

function rowTotal(row: BucketRow, rank: (bucket: Bucket) => number): number {
  let total = 0
  for (const bucket of row.buckets.values()) total += rank(bucket)
  return total
}

/** Biggest first. `rank` reads one bucket; a margin chart ranks on revenue. */
export function rankRows(grouped: GroupedBuckets, rank: (bucket: Bucket) => number): GroupedBuckets {
  const rows = [...grouped.rows].sort((a, b) => {
    const delta = rowTotal(b, rank) - rowTotal(a, rank)
    return delta !== 0 ? delta : a.label.localeCompare(b.label)
  })
  return { rows, groups: grouped.groups }
}

/** Chronological, by the row key (`'YYYY-MM'` sorts as a string). */
export function sortRowsByKey(grouped: GroupedBuckets): GroupedBuckets {
  return { rows: [...grouped.rows].sort((a, b) => a.key.localeCompare(b.key)), groups: grouped.groups }
}

/**
 * The first `limit` rows. The rest roll into one `other` row — summed as buckets, so a
 * rolled-up margin is the real weighted margin of everything inside it. `other: null`
 * drops the tail instead (a "top 5" chart shows five customers, not six).
 */
export function limitRows(grouped: GroupedBuckets, limit: number, other: string | null = 'Other'): GroupedBuckets {
  if (grouped.rows.length <= limit) return grouped
  const kept = grouped.rows.slice(0, limit)
  if (other === null) return { rows: kept, groups: grouped.groups }
  const rest: BucketRow = { key: '__other__', label: other, buckets: new Map() }
  for (const row of grouped.rows.slice(limit)) {
    for (const [group, bucket] of row.buckets) {
      let into = rest.buckets.get(group)
      if (!into) { into = emptyBucket(); rest.buckets.set(group, into) }
      into.revenueCents += bucket.revenueCents
      into.costCents += bucket.costCents
      into.profitCents += bucket.profitCents
      into.count += bucket.count
    }
  }
  return { rows: [...kept, rest], groups: grouped.groups }
}

/**
 * Buckets → the shape a card returns. Every row carries every group (a missing one is a
 * real 0), and the groups are ordered biggest first so the legend reads like the chart.
 */
export function toSeries(
  grouped: GroupedBuckets,
  metric: Metric,
  valueFormat: ValueFormat,
  note?: string | null,
): ChartSeries {
  const rank = metric === 'margin' ? (b: Bucket) => b.revenueCents : (b: Bucket) => metricValue(b, metric)
  const groupTotals = new Map<string, number>()
  for (const group of grouped.groups) groupTotals.set(group, 0)
  for (const row of grouped.rows) {
    for (const [group, bucket] of row.buckets) {
      groupTotals.set(group, (groupTotals.get(group) ?? 0) + rank(bucket))
    }
  }
  const groups = [...grouped.groups].sort((a, b) => {
    const delta = (groupTotals.get(b) ?? 0) - (groupTotals.get(a) ?? 0)
    return delta !== 0 ? delta : a.localeCompare(b)
  })
  const rows = grouped.rows.map((row) => {
    const values: Record<string, number> = {}
    for (const group of groups) {
      const bucket = row.buckets.get(group)
      values[group] = bucket ? metricValue(bucket, metric) : 0
    }
    return { label: row.label, values }
  })
  return { rows, groups: groups.length > 0 ? groups : [UNGROUPED], valueFormat, note: note ?? null }
}

/** Σ over every bucket of a filtered set — what the KPI tiles print. */
export function totals(samples: LaneRateSampleRecord[]): Bucket {
  const bucket = emptyBucket()
  for (const sample of pricedSamples(samples)) addSample(bucket, sample)
  return bucket
}

// ── Row builders the cards share ─────────────────────────────────────────────

export type Dimension = 'REP' | 'CUSTOMER' | 'CARRIER' | 'STATUS' | 'MONTH'

/** The row identity/label of a sample along one dimension. */
export function dimensionRowOf(dimension: Dimension, row: GroupRow, data: DashboardData): { key: string; label: string } {
  const index = indexOf(data)
  switch (dimension) {
    case 'REP': {
      const rep = row.salesRepId ?? row.customerRepId ?? null
      return { key: rep ?? '__none__', label: rep ? index.repLabel(rep) : UNASSIGNED }
    }
    case 'CUSTOMER':
      return { key: row.customerId ?? '__none__', label: row.customerName?.trim() || row.customerId || NO_CUSTOMER }
    case 'CARRIER':
      return { key: row.carrierId ?? row.carrierName ?? '__none__', label: row.carrierName?.trim() || row.carrierId || NO_CARRIER }
    case 'STATUS':
      return { key: row.status ?? '__none__', label: statusLabel(row.status) }
    case 'MONTH': {
      const month = monthOf(row.date)
      return { key: month ?? '__none__', label: month ? monthLabel(month) : NO_DATE }
    }
  }
}
