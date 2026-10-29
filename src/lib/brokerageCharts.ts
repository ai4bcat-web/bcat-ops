/**
 * Ryne's nine Brokerage dashboard cards (Step R, direction-change rule 4).
 *
 * Every function here is pure over the `DashboardData` bundle the page already read:
 * no fetching, no clock of its own (`data.now` is the one read instant), no invented
 * numbers. Where a fact has not been written yet — DAT posting arrives with the Step J
 * integrations, the tracking facts fill in as the lane samples refresh — the card
 * returns its real zero and says so in `ChartSeries.note`.
 *
 * Filtering, grouping and the row joins are not reimplemented here: `applyFilters`,
 * `groupKey`, `shipmentRow`, `loadRow` and `indexOf` come from `dashboardCharts.ts`, so
 * the Classic cards and these nine answer a filter chip identically. `applyFilters` is
 * idempotent and memoised, so each card calls it itself and the page hands over the raw
 * bundle; it already drops voided shipments and loads.
 *
 * Two different sets are at play and the difference is deliberate: the shipments, loads
 * and samples a card counts come from the *filtered* bundle (they are what the window is
 * about), while the joins a row needs to name itself — the order behind an invoice, the
 * shipment behind an old open bill, the sample carrying a POD stamp — are looked up in
 * the *unfiltered* bundle. Outstanding AR and AP carry no window: money owed from August
 * is still owed in October, and `applyFilters` has already narrowed those two lists by
 * division, rep and customer.
 */
import type {
  ChartColumn,
  ChartSeries,
  DashboardData,
  DashboardFilters,
  DashboardGroupBy,
  LoadSummaryRecord,
} from '@/features/tms/dashboard/types'
import {
  applyFilters,
  dateOf,
  groupKey,
  indexOf,
  inWindow,
  loadRow,
  shipmentRow,
  UNGROUPED,
} from '@/lib/dashboardCharts'
import { SHIPMENT_STATUSES, SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'
import type {
  LaneRateSampleRecord,
  LoadCarrierRecord,
  LoadWorkflowStatus,
  ShipmentRecord,
} from '@/types/tms'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** A load is "moving" from the moment it is dispatched until the trailer is empty. */
export const MOVEMENT_STATUSES: readonly LoadWorkflowStatus[] = [
  'DISPATCHED',
  'LOADING',
  'PICKED_UP',
  'IN_TRANSIT',
  'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL',
  'OUT_FOR_DELIVERY',
  'UNLOADING',
]

/** Providers that report a position on their own; MANUAL is a person telephoning. */
export const LIVE_TRACKING_PROVIDERS: readonly string[] = ['LINK', 'DRIVER_APP', 'MOTIVE']

/** A position older than this is not "live" any more. */
export const LIVE_TRACKING_MAX_AGE_MS = 24 * HOUR_MS

/** The POD table lists the oldest few; the rest are the same story. */
export const POD_NEEDED_ROW_LIMIT = 25

/** The POD-timing table answers "who is slow", so it stops at the ten slowest. */
export const POD_TIMING_ROW_LIMIT = 10

/** Below this, a p50/p90 is one carrier's bad week rather than a rate of collection. */
export const POD_TIMING_MIN_SAMPLES = 3

export const DAT_EMPTY_NOTE =
  'DAT posting arrives with the Step J integrations; no shipment carries datPostedAt yet'

export const TRACKING_HISTORY_EMPTY_NOTE = 'Tracking facts fill in as samples refresh'

export const POD_NEEDED_CLEAR_NOTE = 'Every delivered shipment in this window has its POD.'

// ── small shared helpers ─────────────────────────────────────────────────────

function msOf(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Nearest-rank percentile: sort ascending, take element `ceil(p/100 × n)`.
 *
 * No interpolation — every number printed is an observed collection time, not the
 * average of two carriers'. p50 of `[1,2,3]` is 2; p50 of `[1,2,3,4]` is 2; p90 of
 * `[1…10]` is 9.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

function bump(outer: Map<string, Map<string, number>>, rowKey: string, group: string, amount: number): void {
  let inner = outer.get(rowKey)
  if (!inner) {
    inner = new Map<string, number>()
    outer.set(rowKey, inner)
  }
  inner.set(group, (inner.get(group) ?? 0) + amount)
}

function totalOf(inner: Map<string, number> | undefined): number {
  let sum = 0
  if (inner) for (const v of inner.values()) sum += v
  return sum
}

/** Legend order: biggest first, ties alphabetical, so a re-render never reshuffles. */
function orderedGroups(outer: Map<string, Map<string, number>>, groupBy: DashboardGroupBy | null): string[] {
  if (!groupBy) return [UNGROUPED]
  const totals = new Map<string, number>()
  for (const inner of outer.values()) {
    for (const [group, value] of inner) totals.set(group, (totals.get(group) ?? 0) + value)
  }
  if (totals.size === 0) return [UNGROUPED]
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g)
}

/** Every group gets a cell, so a stacked bar lines up and a zero reads as a zero. */
function valuesFor(inner: Map<string, number> | undefined, groups: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const g of groups) out[g] = inner?.get(g) ?? 0
  return out
}

/** Money rows (AR, AP) are one bar per rep, optionally stacked by the card's group-by. */
function repMoneySeries(
  byRep: Map<string, Map<string, number>>,
  repIds: Map<string, string | null>,
  groupBy: DashboardGroupBy | null,
  data: DashboardData,
): ChartSeries {
  const groups = orderedGroups(byRep, groupBy)
  const { repLabel } = indexOf(data)
  const rows = [...byRep.entries()]
    .sort((a, b) => totalOf(b[1]) - totalOf(a[1]) || a[0].localeCompare(b[0]))
    .map(([key, inner]) => ({
      label: repLabel(repIds.get(key) ?? null),
      values: valuesFor(inner, groups),
    }))
  return { rows, groups, valueFormat: 'cents', note: null }
}

/** One bar per group (or one bar for everything); the legend stays `total`. */
function groupedCountSeries(
  counts: Map<string, number>,
  groupBy: DashboardGroupBy | null,
  ungroupedLabel: string,
  note: string | null = null,
): ChartSeries {
  let total = 0
  for (const v of counts.values()) total += v
  const rows = groupBy
    ? [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([label, value]) => ({ label, values: { [UNGROUPED]: value } }))
    : [{ label: ungroupedLabel, values: { [UNGROUPED]: total } }]
  return { rows, groups: [UNGROUPED], valueFormat: 'count', note }
}

/** The whole bundle's samples by shipment, so a POD fact outside the window still joins. */
function sampleByShipmentId(data: DashboardData): Map<string, LaneRateSampleRecord> {
  const map = new Map<string, LaneRateSampleRecord>()
  for (const sample of data.samples) {
    if (sample.shipmentId && !map.has(sample.shipmentId)) map.set(sample.shipmentId, sample)
  }
  return map
}

function legById(data: DashboardData): Map<string, LoadCarrierRecord> {
  return new Map(data.loadCarriers.map((leg) => [leg.id, leg]))
}

// ── 1. Shipments in each status ──────────────────────────────────────────────

/**
 * Every status keeps its row, even at zero: the shape of the board is the point, and a
 * missing "On hold" row would read as "no such thing" instead of "none today".
 */
export function statusCounts(
  data: DashboardData,
  filters: DashboardFilters,
  groupBy: DashboardGroupBy | null,
): ChartSeries {
  const d = applyFilters(data, filters)
  const byStatus = new Map<string, Map<string, number>>()
  for (const status of SHIPMENT_STATUSES) byStatus.set(status, new Map())
  for (const shipment of d.shipments) {
    bump(byStatus, shipment.status, groupKey(groupBy, shipmentRow(shipment, d), d), 1)
  }
  const groups = orderedGroups(byStatus, groupBy)
  return {
    rows: SHIPMENT_STATUSES.map((status) => ({
      label: SHIPMENT_STATUS_LABELS[status],
      values: valuesFor(byStatus.get(status), groups),
    })),
    groups,
    valueFormat: 'count',
    note: null,
  }
}

// ── 2. Posted to DAT ─────────────────────────────────────────────────────────

/** Shipments whose DAT stamp falls inside the window. Zero until Step J writes one. */
export function datPosted(
  data: DashboardData,
  filters: DashboardFilters,
  groupBy: DashboardGroupBy | null,
): ChartSeries {
  const d = applyFilters(data, filters)
  const counts = new Map<string, number>()
  let total = 0
  for (const shipment of d.shipments) {
    if (!inWindow(shipment.datPostedAt, filters.from, filters.to)) continue
    const group = groupKey(groupBy, shipmentRow(shipment, d), d)
    counts.set(group, (counts.get(group) ?? 0) + 1)
    total += 1
  }
  return groupedCountSeries(counts, groupBy, 'Posted to DAT', total === 0 ? DAT_EMPTY_NOTE : null)
}

// ── 3. Outstanding AR by rep ─────────────────────────────────────────────────

/**
 * Σ of what every open invoice still owes, against the rep who sold the shipment.
 * The joins run over the unfiltered bundle: an invoice from a window the dashboard is
 * not showing is still outstanding, and `applyFilters` has already narrowed the list by
 * division, rep and customer.
 */
export function arByRep(
  data: DashboardData,
  filters: DashboardFilters,
  groupBy: DashboardGroupBy | null,
): ChartSeries {
  const d = applyFilters(data, filters)
  const index = indexOf(data)
  const byRep = new Map<string, Map<string, number>>()
  const repIds = new Map<string, string | null>()
  for (const invoice of d.openInvoices) {
    if (invoice.voidedAt) continue
    const balance = invoice.balanceCents ?? 0
    if (balance <= 0) continue
    const order = invoice.orderId ? index.orderById.get(invoice.orderId) : undefined
    const shipment = index.shipmentById.get(order?.shipmentId ?? invoice.shipmentId)
    const repId = shipment?.salesRepId ?? order?.customerRepId ?? null
    const key = repId ?? ''
    repIds.set(key, repId)
    const group = shipment ? groupKey(groupBy, shipmentRow(shipment, data), data) : groupKey(groupBy, {}, data)
    bump(byRep, key, group, balance)
  }
  return repMoneySeries(byRep, repIds, groupBy, data)
}

// ── 4. Outstanding AP by rep ─────────────────────────────────────────────────

/** Σ of what every open carrier bill still owes, against the rep who booked the leg. */
export function apByRep(
  data: DashboardData,
  filters: DashboardFilters,
  groupBy: DashboardGroupBy | null,
): ChartSeries {
  const d = applyFilters(data, filters)
  const index = indexOf(data)
  const legs = legById(data)
  const byRep = new Map<string, Map<string, number>>()
  const repIds = new Map<string, string | null>()
  for (const bill of d.openBills) {
    if (bill.voidedAt) continue
    const balance = bill.balanceCents ?? 0
    if (balance <= 0) continue
    const shipment = bill.shipmentId ? index.shipmentById.get(bill.shipmentId) : undefined
    const leg = bill.loadCarrierId ? legs.get(bill.loadCarrierId) : undefined
    const repId = leg?.carrierRepId ?? shipment?.salesRepId ?? null
    const key = repId ?? ''
    repIds.set(key, repId)
    const group = shipment ? groupKey(groupBy, shipmentRow(shipment, data), data) : groupKey(groupBy, {}, data)
    bump(byRep, key, group, balance)
  }
  return repMoneySeries(byRep, repIds, groupBy, data)
}

// ── 5. Rep leaderboard ───────────────────────────────────────────────────────

export const REP_LEADERBOARD_COLUMNS: ChartColumn[] = [
  { key: 'shipments', label: 'Shipments', format: 'count' },
  { key: 'revenue', label: 'Revenue', format: 'cents' },
  { key: 'profit', label: 'Profit', format: 'cents' },
  { key: 'marginBps', label: 'Margin', format: 'bps' },
  { key: 'openAr', label: 'Open AR', format: 'cents' },
]

interface RepTotals {
  repId: string | null
  shipments: number
  revenue: number
  profit: number
  openAr: number
}

/**
 * One row per rep, from the lane samples (the delivered-and-priced fact table) plus the
 * open AR that rep is still chasing. Sorted by profit, because that is the league.
 */
export function repLeaderboard(data: DashboardData, filters: DashboardFilters): ChartSeries {
  const d = applyFilters(data, filters)
  const index = indexOf(data)
  const totals = new Map<string, RepTotals>()
  const touch = (repId: string | null): RepTotals => {
    const key = repId ?? ''
    let row = totals.get(key)
    if (!row) {
      row = { repId, shipments: 0, revenue: 0, profit: 0, openAr: 0 }
      totals.set(key, row)
    }
    return row
  }
  for (const sample of d.samples) {
    if (sample.excluded) continue
    const shipment = sample.shipmentId ? index.shipmentById.get(sample.shipmentId) : undefined
    const row = touch(sample.salesRepId ?? shipment?.salesRepId ?? sample.customerRepId ?? null)
    row.shipments += 1
    row.revenue += sample.revenueCents ?? 0
    row.profit += sample.profitCents ?? 0
  }
  for (const invoice of d.openInvoices) {
    if (invoice.voidedAt) continue
    const balance = invoice.balanceCents ?? 0
    if (balance <= 0) continue
    const order = invoice.orderId ? index.orderById.get(invoice.orderId) : undefined
    const shipment = index.shipmentById.get(order?.shipmentId ?? invoice.shipmentId)
    touch(shipment?.salesRepId ?? order?.customerRepId ?? null).openAr += balance
  }
  return {
    rows: [...totals.values()]
      .sort((a, b) => b.profit - a.profit || b.revenue - a.revenue)
      .map((row) => ({
        label: index.repLabel(row.repId),
        values: {
          shipments: row.shipments,
          revenue: row.revenue,
          profit: row.profit,
          marginBps: row.revenue > 0 ? Math.round((row.profit / row.revenue) * 10_000) : 0,
          openAr: row.openAr,
        },
      })),
    groups: REP_LEADERBOARD_COLUMNS.map((c) => c.key),
    columns: REP_LEADERBOARD_COLUMNS,
    valueFormat: 'cents',
    note: null,
  }
}

// ── 6. Being tracked now ─────────────────────────────────────────────────────

function isLiveTracked(load: LoadSummaryRecord, now: number): boolean {
  if (!load.trackingProvider || !LIVE_TRACKING_PROVIDERS.includes(load.trackingProvider)) return false
  const last = msOf(load.lastKnownAt)
  return last != null && now - last <= LIVE_TRACKING_MAX_AGE_MS
}

/**
 * The live picture, aged against `data.now`: a load counts as tracked when an automatic
 * provider reported a position in the last 24 hours. Everything else that is moving is
 * untracked, and that — with the check calls already past due — is the number worth
 * looking at.
 */
export function trackingLive(
  data: DashboardData,
  filters: DashboardFilters,
  groupBy: DashboardGroupBy | null,
): ChartSeries {
  const d = applyFilters(data, filters)
  const now = msOf(d.now) ?? 0
  const counts = new Map<string, number>()
  let moving = 0
  let tracked = 0
  let overdue = 0
  for (const load of d.loads) {
    if (load.status == null || !MOVEMENT_STATUSES.includes(load.status)) continue
    moving += 1
    const next = msOf(load.nextCheckCallAt)
    if (next != null && next < now) overdue += 1
    if (!isLiveTracked(load, now)) continue
    tracked += 1
    const group = groupKey(groupBy, loadRow(load, d), d)
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  const series = groupedCountSeries(counts, groupBy, 'Tracked now')
  series.kpis = [
    { label: 'Tracked now', value: String(tracked), sub: `of ${moving} moving` },
    { label: 'In transit untracked', value: String(moving - tracked), sub: 'no automatic position in 24h' },
    { label: 'Overdue check calls', value: String(overdue), sub: 'next check call is past due' },
  ]
  return series
}

// ── 7. Tracking history ──────────────────────────────────────────────────────

/**
 * What the window's finished shipments say about tracking: how many were tracked at all,
 * by what, whether the check calls that were due actually landed, and how long the first
 * position took to arrive. Every number is Σ over the sample facts, so a null fact lowers
 * nothing — it simply is not counted, and the note says the facts are still filling in.
 */
export function trackingHistory(data: DashboardData, filters: DashboardFilters): ChartSeries {
  const d = applyFilters(data, filters)
  const index = indexOf(data)
  const sourceCounts = new Map<string, number>()
  const pingHours: number[] = []
  let total = 0
  let trackedCount = 0
  let knownProvider = 0
  let due = 0
  let met = 0
  let dueRows = 0
  for (const sample of d.samples) {
    if (sample.excluded) continue
    total += 1
    const provider = sample.trackingProvider ?? null
    if (provider) knownProvider += 1
    const label = provider ?? 'Unknown'
    sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1)
    // NONE is nothing and MANUAL is a person telephoning, so neither counts as tracked.
    if (provider != null && provider !== 'NONE' && provider !== 'MANUAL') trackedCount += 1
    if (sample.checkCallsDue != null) {
      due += sample.checkCallsDue
      met += sample.checkCallsMet ?? 0
      dueRows += 1
    }
    const ping = msOf(sample.firstPingAt)
    const shipment = sample.shipmentId ? index.shipmentById.get(sample.shipmentId) : undefined
    const pickup = msOf(shipment?.pickupAppt ?? sample.date)
    if (ping != null && pickup != null && ping >= pickup) pingHours.push((ping - pickup) / HOUR_MS)
  }
  const shareTracked = total > 0 ? trackedCount / total : 0
  const compliance = due > 0 ? met / due : 0
  return {
    kpis: [
      {
        label: 'Share tracked',
        value: `${round1(shareTracked * 100)}%`,
        sub: `${trackedCount} of ${total} shipments`,
      },
      {
        label: 'Check-call compliance',
        value: `${round1(compliance * 100)}%`,
        sub: `${met} of ${due} check calls`,
      },
      {
        label: 'Median hours to first ping',
        value: String(pingHours.length > 0 ? round1(percentile(pingHours, 50)) : 0),
        sub: `${pingHours.length} shipments pinged`,
      },
    ],
    rows: [...sourceCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, value]) => ({ label, values: { [UNGROUPED]: value } })),
    groups: [UNGROUPED],
    valueFormat: 'count',
    note: knownProvider === 0 && dueRows === 0 && pingHours.length === 0 ? TRACKING_HISTORY_EMPTY_NOTE : null,
  }
}

// ── 8. Shipments needing PODs ────────────────────────────────────────────────

export const POD_NEEDED_COLUMNS: ChartColumn[] = [
  { key: 'customer', label: 'Customer', format: 'text' },
  { key: 'carrier', label: 'Carrier', format: 'text' },
  { key: 'delivered', label: 'Delivered', format: 'date' },
  { key: 'days', label: 'Days waiting', format: 'count' },
]

interface PodWait {
  number: string
  customer: string
  carrier: string
  delivered: string | null
  deliveredMs: number | null
  days: number
}

function podDeliveredAt(
  shipment: ShipmentRecord,
  sample: LaneRateSampleRecord | undefined,
  load: LoadSummaryRecord | undefined,
): string | null {
  return shipment.deliveredAt ?? sample?.deliveredAt ?? load?.deliveredAt ?? null
}

/**
 * Delivered and still no POD. The lane sample is the truth when the shipment has one;
 * before the sample is written the order's own `docsMissing` list answers.
 */
export function podNeeded(
  data: DashboardData,
  filters: DashboardFilters,
  groupBy: DashboardGroupBy | null,
): ChartSeries {
  const d = applyFilters(data, filters)
  const index = indexOf(data)
  const now = msOf(d.now) ?? 0
  const samples = sampleByShipmentId(data)
  const loadByShipment = new Map(d.loads.map((l) => [l.shipmentId ?? '', l]))
  const counts = new Map<string, number>()
  const waiting: PodWait[] = []
  let total = 0
  for (const shipment of d.shipments) {
    if (shipment.status !== 'DELIVERED') continue
    const sample = samples.get(shipment.id)
    const missing = sample
      ? !sample.podReceivedAt
      : (index.orderByShipmentId.get(shipment.id)?.docsMissing ?? []).includes('POD')
    if (!missing) continue
    const group = groupKey(groupBy, shipmentRow(shipment, d), d)
    counts.set(group, (counts.get(group) ?? 0) + 1)
    total += 1
    const load = loadByShipment.get(shipment.id)
    const delivered = podDeliveredAt(shipment, sample, load)
    const deliveredMs = msOf(delivered)
    waiting.push({
      number: shipment.number,
      customer: shipment.customerName ?? load?.customerName ?? '—',
      carrier:
        load?.carrierName ?? index.activeLegByShipmentId.get(shipment.id)?.carrierName ?? sample?.carrierName ?? '—',
      delivered: dateOf(delivered),
      deliveredMs,
      days: deliveredMs != null ? Math.max(0, Math.floor((now - deliveredMs) / DAY_MS)) : 0,
    })
  }
  // Oldest delivery first; a shipment with no delivery stamp sorts last — it cannot be aged.
  waiting.sort((a, b) => {
    if (a.deliveredMs == null || b.deliveredMs == null) {
      if (a.deliveredMs == null && b.deliveredMs == null) return a.number.localeCompare(b.number)
      return a.deliveredMs == null ? 1 : -1
    }
    return a.deliveredMs - b.deliveredMs || a.number.localeCompare(b.number)
  })
  const kpis: NonNullable<ChartSeries['kpis']> = [
    { label: 'Needs POD', value: String(total), sub: 'delivered, POD not received' },
  ]
  if (groupBy) {
    for (const [label, value] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      kpis.push({ label, value: String(value), sub: null })
    }
  }
  return {
    kpis,
    rows: waiting.slice(0, POD_NEEDED_ROW_LIMIT).map((row) => ({
      label: row.number,
      values: { days: row.days },
      text: { customer: row.customer, carrier: row.carrier, delivered: row.delivered ?? '—' },
    })),
    groups: ['days'],
    columns: POD_NEEDED_COLUMNS,
    valueFormat: 'count',
    note: total === 0 ? POD_NEEDED_CLEAR_NOTE : null,
  }
}

// ── 9. POD collection by carrier ─────────────────────────────────────────────

export const POD_TIMING_COLUMNS: ChartColumn[] = [
  { key: 'p50', label: 'p50 hours', format: 'hours' },
  { key: 'p90', label: 'p90 hours', format: 'hours' },
  { key: 'samples', label: 'PODs', format: 'count' },
]

/**
 * Hours from delivery to the POD landing, per carrier, as nearest-rank p50 and p90.
 * Slowest p90 first — the question this card answers is who to chase.
 */
export function podTiming(data: DashboardData, filters: DashboardFilters): ChartSeries {
  const d = applyFilters(data, filters)
  const byCarrier = new Map<string, number[]>()
  const all: number[] = []
  let usable = 0
  for (const sample of d.samples) {
    if (sample.excluded) continue
    usable += 1
    const delivered = msOf(sample.deliveredAt)
    const pod = msOf(sample.podReceivedAt)
    if (delivered == null || pod == null || pod < delivered) continue
    const hours = (pod - delivered) / HOUR_MS
    const carrier = sample.carrierName ?? sample.carrierId ?? 'Unassigned carrier'
    const list = byCarrier.get(carrier)
    if (list) list.push(hours)
    else byCarrier.set(carrier, [hours])
    all.push(hours)
  }
  return {
    kpis: [
      { label: 'Overall p50', value: String(round1(percentile(all, 50))), sub: 'hours to POD' },
      { label: 'Overall p90', value: String(round1(percentile(all, 90))), sub: 'hours to POD' },
      { label: 'PODs measured', value: String(all.length), sub: `of ${usable} shipments` },
    ],
    rows: [...byCarrier.entries()]
      .map(([carrier, hours]) => ({
        label: carrier,
        values: {
          p50: round1(percentile(hours, 50)),
          p90: round1(percentile(hours, 90)),
          samples: hours.length,
        },
      }))
      .sort((a, b) => b.values.p90 - a.values.p90 || a.label.localeCompare(b.label))
      .slice(0, POD_TIMING_ROW_LIMIT),
    groups: POD_TIMING_COLUMNS.map((c) => c.key),
    columns: POD_TIMING_COLUMNS,
    valueFormat: 'hours',
    note:
      all.length < POD_TIMING_MIN_SAMPLES
        ? `Only ${all.length} of ${usable} shipments in this window carry both a delivery and a POD time; percentiles need at least ${POD_TIMING_MIN_SAMPLES}.`
        : null,
  }
}
