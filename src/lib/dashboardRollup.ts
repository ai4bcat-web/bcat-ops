/**
 * DashboardRollup core (Step AF): the pure compute behind the `/tms/dashboard` KPI strip.
 *
 * Shared by three callers, so it has NO React, NO I/O and RELATIVE imports only (the
 * `tms-dashboard-rollup` Lambda bundles it):
 *  - the Lambda computes month / live payloads with `computeMonth` / `computeLive`,
 *  - the browser reduces stored payloads to strips and company totals with `stripsFromRollup`,
 *  - `businessStrips.ts` shares `stripFigures` / `rollupStrips` (one implementation of the
 *    arithmetic and of every null-versus-zero rule).
 *
 * A payload is a pure function of the source rows, so recomputing it twice yields the same
 * row. Day keys are the first ten characters of the stored ISO string, exactly what
 * `dateOf` / `inWindow` use on the exact path, so no time-zone arithmetic happens anywhere.
 *
 * Intended differences from the exact path (documented in AF-plan §3.2, §5):
 *  - open AR/AP are resolved to a division by id (shipmentId / loadId), so a strip's AR/AP
 *    can only be >= the exact path's, which drops open rows whose referents it did not load;
 *  - a delivered shipment's POD state reads the sample of the same pickup month (the exact
 *    path reads the samples inside the window).
 */
import { isPodMissing } from './podState'
import { MOVEMENT_STATUSES } from './movementStatuses'
import { divisionTree, topLevelOf } from './ownership'
import type { OwnershipDivisionRecord } from '../types/tms'

export const ROLLUP_SCHEMA_VERSION = 1

/** `${revDivision ?? ''}|${revSubdivision ?? ''}`; `'|'` is untagged. */
export type ScopeKey = string

export interface DayScope { st: Record<string, number>; ld: number; trk: number; pod: number }
export interface FinScope { n: number; rev: number; cost: number; prof: number }
export interface MonthPayload {
  v: 1
  month: string
  ship: Record<string, Record<ScopeKey, DayScope>>
  fin: Record<string, Record<ScopeKey, FinScope>>
}
export interface LivePayload {
  v: 1
  ar: Record<ScopeKey, { n: number; c: number }>
  ap: Record<ScopeKey, { n: number; c: number }>
}
export interface RollupRow<P> { id: string; schemaVersion: number; computedAt: string; payload: P }
export interface RollupWindow {
  months: RollupRow<MonthPayload>[]
  live: RollupRow<LivePayload> | null
}

type Maybe<T> = T | null | undefined

export interface ShipmentLite {
  id: string
  status?: Maybe<string>
  pickupAppt?: Maybe<string>
  pickupMonth?: Maybe<string>
  revDivision?: Maybe<string>
  revSubdivision?: Maybe<string>
  voidedAt?: Maybe<string>
  deletedAt?: Maybe<string>
}
export interface LoadLite {
  id: string
  shipmentId?: Maybe<string>
  status?: Maybe<string>
  pickupAppt?: Maybe<string>
  revDivision?: Maybe<string>
  revSubdivision?: Maybe<string>
  voidedAt?: Maybe<string>
}
export interface OrderLite { shipmentId: string; docsMissing?: Maybe<readonly string[]> }
export interface SampleLite {
  shipmentId?: Maybe<string>
  date: string
  excluded?: Maybe<boolean>
  revenueCents?: Maybe<number>
  costCents?: Maybe<number>
  profitCents?: Maybe<number>
  revDivision?: Maybe<string>
  revSubdivision?: Maybe<string>
  podReceivedAt?: Maybe<string>
}
export interface InvoiceLite { id: string; orderId?: Maybe<string>; shipmentId?: Maybe<string>; balanceCents?: Maybe<number> }
export interface BillLite { id: string; loadId?: Maybe<string>; shipmentId?: Maybe<string>; balanceCents?: Maybe<number> }

export interface MonthSource {
  /** Shipments whose pickup month is `month` (voided rows may be included; compute drops them). */
  shipments(month: string): Promise<ShipmentLite[]>
  loadsOf(shipmentIds: string[]): Promise<LoadLite[]>
  /** Orders of the given (DELIVERED) shipments. */
  deliveredOrders(shipmentIds: string[]): Promise<OrderLite[]>
  samples(month: string): Promise<SampleLite[]>
  /** Any shipments by id, voided included. */
  shipmentsByIds(ids: string[]): Promise<ShipmentLite[]>
}
export interface LiveSource {
  openInvoices(): Promise<InvoiceLite[]>
  openBills(): Promise<BillLite[]>
  shipmentsByIds(ids: string[]): Promise<ShipmentLite[]>
  loadsByIds(ids: string[]): Promise<LoadLite[]>
}

// ── Small helpers ────────────────────────────────────────────────────────────

function dayOf(value: Maybe<string>): string | null {
  if (!value) return null
  const day = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

function monthOfValue(value: Maybe<string>): string | null {
  const day = dayOf(value)
  return day ? day.slice(0, 7) : null
}

export function scopeKey(division: Maybe<string>, subdivision: Maybe<string>): ScopeKey {
  return `${division ?? ''}|${subdivision ?? ''}`
}

function splitScope(key: ScopeKey): { division: string; subdivision: string } {
  const at = key.indexOf('|')
  return { division: key.slice(0, at), subdivision: key.slice(at + 1) }
}

const TRACKED: Record<string, true> = Object.fromEntries(MOVEMENT_STATUSES.map((s) => [s, true]))

function bump<T>(map: Record<string, T>, key: string, make: () => T): T {
  return (map[key] ??= make())
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ── Compute (Lambda side) ────────────────────────────────────────────────────

export async function computeMonth(src: MonthSource, month: string): Promise<MonthPayload> {
  const payload: MonthPayload = { v: 1, month, ship: {}, fin: {} }

  const monthShipments = await src.shipments(month)
  const byId = new Map<string, ShipmentLite>(monthShipments.map((s) => [s.id, s]))
  const live = monthShipments.filter((s) => !s.voidedAt)

  const dayScope = (day: string, scope: ScopeKey): DayScope =>
    bump(bump(payload.ship, day, () => ({})), scope, () => ({ st: {}, ld: 0, trk: 0, pod: 0 }))

  // Shipments by pickup day, status counts.
  for (const shipment of live) {
    const day = dayOf(shipment.pickupAppt)
    if (!day) continue
    const entry = dayScope(day, scopeKey(shipment.revDivision, shipment.revSubdivision))
    const status = shipment.status ?? ''
    entry.st[status] = (entry.st[status] ?? 0) + 1
  }

  // Loads of those shipments, by the load's own (hydrated) pickup day and tag.
  const liveIds = live.map((s) => s.id)
  const loads = liveIds.length > 0 ? await src.loadsOf(liveIds) : []
  for (const load of loads) {
    const shipment = load.shipmentId ? byId.get(load.shipmentId) : undefined
    if (!shipment || shipment.voidedAt || load.voidedAt) continue
    const day = dayOf(load.pickupAppt ?? shipment.pickupAppt)
    if (!day) continue
    const entry = dayScope(day, scopeKey(load.revDivision ?? shipment.revDivision, load.revSubdivision ?? shipment.revSubdivision))
    entry.ld += 1
    if (load.status != null && TRACKED[load.status]) entry.trk += 1
  }

  // Samples, month by sample date.
  const samples = await src.samples(month)
  const missing = [...new Set(samples.map((s) => s.shipmentId).filter((id): id is string => !!id && !byId.has(id)))]
  for (const ids of chunk(missing, 100)) {
    for (const shipment of await src.shipmentsByIds(ids)) byId.set(shipment.id, shipment)
  }
  const sampleByShipment = new Map<string, SampleLite>()
  for (const sample of samples) {
    const shipment = sample.shipmentId ? byId.get(sample.shipmentId) : undefined
    if (sample.shipmentId && shipment?.voidedAt) continue
    if (sample.shipmentId && sample.date) sampleByShipment.set(sample.shipmentId, sample)
    if (sample.excluded) continue
    const day = dayOf(sample.date)
    if (!day) continue
    const scope = scopeKey(sample.revDivision ?? shipment?.revDivision, sample.revSubdivision ?? shipment?.revSubdivision)
    const fin = bump(bump(payload.fin, day, () => ({})), scope, () => ({ n: 0, rev: 0, cost: 0, prof: 0 }))
    fin.n += 1
    fin.rev += sample.revenueCents ?? 0
    fin.cost += sample.costCents ?? 0
    fin.prof += sample.profitCents ?? 0
  }

  // POD needed: delivered shipments without a POD.
  const delivered = live.filter((s) => s.status === 'DELIVERED' && dayOf(s.pickupAppt))
  if (delivered.length > 0) {
    const orders = await src.deliveredOrders(delivered.map((s) => s.id))
    const orderByShipment = new Map<string, OrderLite>()
    for (const order of orders) if (!orderByShipment.has(order.shipmentId)) orderByShipment.set(order.shipmentId, order)
    for (const shipment of delivered) {
      const sample = sampleByShipment.get(shipment.id)
      if (!isPodMissing(shipment.status, orderByShipment.get(shipment.id)?.docsMissing, sample ? !!sample.podReceivedAt : null)) continue
      dayScope(dayOf(shipment.pickupAppt)!, scopeKey(shipment.revDivision, shipment.revSubdivision)).pod += 1
    }
  }

  return payload
}

export async function computeLive(src: LiveSource): Promise<LivePayload> {
  const payload: LivePayload = { v: 1, ar: {}, ap: {} }
  const [invoices, bills] = await Promise.all([src.openInvoices(), src.openBills()])

  const loadIds = [...new Set(bills.map((b) => b.loadId).filter((id): id is string => !!id))]
  const loadById = new Map<string, LoadLite>()
  for (const ids of chunk(loadIds, 100)) for (const load of await src.loadsByIds(ids)) loadById.set(load.id, load)

  const shipmentIds = new Set<string>()
  for (const invoice of invoices) if (invoice.shipmentId) shipmentIds.add(invoice.shipmentId)
  for (const bill of bills) {
    const load = bill.loadId ? loadById.get(bill.loadId) : undefined
    if (load?.shipmentId) shipmentIds.add(load.shipmentId)
    else if (bill.shipmentId) shipmentIds.add(bill.shipmentId)
  }
  const shipmentById = new Map<string, ShipmentLite>()
  for (const ids of chunk([...shipmentIds], 100)) for (const s of await src.shipmentsByIds(ids)) shipmentById.set(s.id, s)

  for (const invoice of invoices) {
    const shipment = invoice.shipmentId ? shipmentById.get(invoice.shipmentId) : undefined
    const slot = bump(payload.ar, scopeKey(shipment?.revDivision, shipment?.revSubdivision), () => ({ n: 0, c: 0 }))
    slot.n += 1
    slot.c += invoice.balanceCents ?? 0
  }
  for (const bill of bills) {
    const load = bill.loadId ? loadById.get(bill.loadId) : undefined
    const shipment = shipmentById.get(load?.shipmentId ?? bill.shipmentId ?? '')
    const slot = bump(payload.ap, scopeKey(load?.revDivision ?? shipment?.revDivision, load?.revSubdivision ?? shipment?.revSubdivision), () => ({ n: 0, c: 0 }))
    slot.n += 1
    slot.c += bill.balanceCents ?? 0
  }
  return payload
}

// ── Dirty keys (stream side) ─────────────────────────────────────────────────

export type RollupSourceTable = 'Shipment' | 'Order' | 'Load' | 'LaneRateSample' | 'Invoice' | 'CarrierBill'
export const ROLLUP_SOURCE_TABLES: readonly RollupSourceTable[] = ['Shipment', 'Order', 'Load', 'LaneRateSample', 'Invoice', 'CarrierBill']

export const LIVE_ROW_ID = 'L:CURRENT'

const COMPARED: Record<RollupSourceTable, readonly string[]> = {
  Shipment: ['status', 'pickupAppt', 'pickupMonth', 'revDivision', 'revSubdivision', 'voidedAt', 'deletedAt'],
  Order: ['docsMissing', 'shipmentId', 'pickupAppt'],
  Load: ['status', 'pickupAppt', 'pickupMonth', 'shipmentId', 'revDivision', 'revSubdivision', 'pickupDriverId', 'deliveryDriverId', 'rate', 'voidedAt'],
  LaneRateSample: ['excluded', 'date', 'sampleMonth', 'revenueCents', 'costCents', 'profitCents', 'revDivision', 'revSubdivision', 'podReceivedAt', 'shipmentId'],
  Invoice: ['arOpen', 'balanceCents', 'shipmentId', 'status'],
  CarrierBill: ['apOpen', 'balanceCents', 'loadId', 'status'],
}

function asRecord(image: unknown): Record<string, unknown> | null {
  return image && typeof image === 'object' ? (image as Record<string, unknown>) : null
}

function monthOfImage(table: RollupSourceTable, image: Record<string, unknown> | null): string | null {
  if (!image) return null
  const text = (key: string): string | null => (typeof image[key] === 'string' ? (image[key] as string) : null)
  if (table === 'LaneRateSample') return monthOfValue(text('sampleMonth') ? `${text('sampleMonth')}-01` : text('date'))
  if (table === 'Order') return monthOfValue(text('pickupAppt'))
  const pickupMonth = text('pickupMonth')
  return pickupMonth && /^\d{4}-\d{2}$/.test(pickupMonth) ? pickupMonth : monthOfValue(text('pickupAppt'))
}

/**
 * The rollup rows a source write can change. `oldImage` / `newImage` are plain unmarshalled
 * objects; `undefined`/`null` for an INSERT or REMOVE. A write that touches no field a figure
 * reads returns `[]`.
 */
export function dirtyKeysForRecord(table: RollupSourceTable, oldImage: unknown, newImage: unknown): string[] {
  const before = asRecord(oldImage)
  const after = asRecord(newImage)
  if (!before && !after) return []

  if (table === 'Invoice' || table === 'CarrierBill') {
    if (!before || !after) {
      const only = before ?? after!
      // An insert/remove matters only when the row is (or was) open.
      return only[table === 'Invoice' ? 'arOpen' : 'apOpen'] === 'OPEN' ? [LIVE_ROW_ID] : []
    }
    return COMPARED[table].some((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f])) ? [LIVE_ROW_ID] : []
  }

  const changed = COMPARED[table].some((f) => JSON.stringify(before?.[f]) !== JSON.stringify(after?.[f]))
  if (!changed) return []

  const keys = new Set<string>()
  for (const image of [before, after]) {
    const month = monthOfImage(table, image)
    if (!month) continue
    keys.add(`M:${month}`)
    if (table === 'Shipment' || table === 'Load') keys.add(`LG:${month}`)
  }
  return [...keys]
}

// ── Figures and strips (shared arithmetic; reader side) ──────────────────────

export interface StripFigures {
  shipmentsByStatus: Record<string, number>
  revenueCents: number | null
  profitCents: number | null
  marginBps: number | null
  arOpenCents: number | null
  apOpenCents: number | null
  trackedCount: number | null
  podNeededCount: number | null
}

/** What one bucket accumulated; `*N` counters decide null versus zero. */
export interface Accumulator {
  st: Record<string, number>
  shipments: number
  loads: number
  tracked: number
  pod: number
  samples: number
  rev: number
  prof: number
  invoices: number
  ar: number
  bills: number
  ap: number
}

export function emptyAccumulator(): Accumulator {
  return { st: {}, shipments: 0, loads: 0, tracked: 0, pod: 0, samples: 0, rev: 0, prof: 0, invoices: 0, ar: 0, bills: 0, ap: 0 }
}

export function marginBpsOf(revenue: number | null, profit: number | null): number | null {
  return revenue != null && revenue > 0 && profit != null ? Math.round((profit / revenue) * 10000) : null
}

/** The one null-vs-zero rule set: "no data" is `null`, a real zero is `0`. */
export function stripFigures(a: Accumulator): StripFigures {
  const revenueCents = a.samples > 0 ? a.rev : null
  const profitCents = a.samples > 0 ? a.prof : null
  return {
    shipmentsByStatus: a.shipments > 0 ? { ...a.st } : {},
    revenueCents,
    profitCents,
    marginBps: marginBpsOf(revenueCents, profitCents),
    arOpenCents: a.invoices > 0 ? a.ar : null,
    apOpenCents: a.bills > 0 ? a.ap : null,
    trackedCount: a.loads > 0 ? a.tracked : null,
    podNeededCount: a.shipments > 0 ? a.pod : null,
  }
}

export interface RollupSubdivision extends StripFigures {
  code: string
  name: string
  brand: string | null
}
export interface RollupStrip extends RollupSubdivision {
  subdivisions: RollupSubdivision[]
}
export interface RollupTotals {
  shipmentCount: number | null
  revenueCents: number | null
  profitCents: number | null
  marginBps: number | null
  arOpenCents: number | null
  apOpenCents: number | null
}

export const COMPANY_STRIP_CODE = 'COMPANY'

function sumOrNull(parts: Array<number | null>): number | null {
  let total: number | null = null
  for (const part of parts) if (part != null) total = (total ?? 0) + part
  return total
}

function isEmptyStrip(strip: StripFigures): boolean {
  return Object.keys(strip.shipmentsByStatus).length === 0
    && strip.revenueCents == null
    && strip.profitCents == null
    && strip.arOpenCents == null
    && strip.apOpenCents == null
    && strip.trackedCount == null
    && strip.podNeededCount == null
}

/**
 * What the dashboard renders: the Company strip carries the sum of the strips (margin
 * recomputed, never averaged), then any strip with nothing to show is dropped.
 */
export function rollupStrips<S extends RollupStrip>(strips: S[]): S[] {
  const filled = strips.map((strip): S => {
    if (strip.code !== COMPANY_STRIP_CODE) return strip
    const shipmentsByStatus: Record<string, number> = {}
    for (const other of strips) {
      for (const [status, count] of Object.entries(other.shipmentsByStatus)) {
        shipmentsByStatus[status] = (shipmentsByStatus[status] ?? 0) + count
      }
    }
    const revenueCents = sumOrNull(strips.map((s) => s.revenueCents))
    const profitCents = sumOrNull(strips.map((s) => s.profitCents))
    return {
      ...strip,
      shipmentsByStatus,
      revenueCents,
      profitCents,
      marginBps: marginBpsOf(revenueCents, profitCents),
      arOpenCents: sumOrNull(strips.map((s) => s.arOpenCents)),
      apOpenCents: sumOrNull(strips.map((s) => s.apOpenCents)),
      trackedCount: sumOrNull(strips.map((s) => s.trackedCount)),
      podNeededCount: sumOrNull(strips.map((s) => s.podNeededCount)),
    }
  })
  return filled.filter((strip) => !isEmptyStrip(strip))
}

export type DivisionInput = Pick<OwnershipDivisionRecord, 'id' | 'code' | 'name' | 'brand' | 'parentId' | 'sortOrder' | 'active'>
export interface RollupFilters {
  from: string
  to: string
  divisions: string[]
  subdivisions: string[]
}

function matchesDivision(filters: RollupFilters, division: string, subdivision: string): boolean {
  if (filters.divisions.length > 0 && !(division && filters.divisions.includes(division))) return false
  if (filters.subdivisions.length > 0 && !(subdivision && filters.subdivisions.includes(subdivision))) return false
  return true
}

/**
 * Reduce the rows covering a window to the strips the page renders and the company card
 * figures. `from`/`to` are inclusive `YYYY-MM-DD`; a reversed pair is swapped. Callers
 * must supply every month the window touches plus one either side (loads whose own pickup
 * day differs from their shipment's live in the shipment's month row).
 */
export function stripsFromRollup(
  window: RollupWindow,
  filters: RollupFilters,
  divisions: DivisionInput[],
): { strips: RollupStrip[]; totals: RollupTotals } {
  const [from, to] = filters.from <= filters.to ? [filters.from, filters.to] : [filters.to, filters.from]

  const scopes = new Map<ScopeKey, Accumulator>()
  const at = (scope: ScopeKey): Accumulator => {
    let acc = scopes.get(scope)
    if (!acc) { acc = emptyAccumulator(); scopes.set(scope, acc) }
    return acc
  }
  const allowed = (scope: ScopeKey): boolean => {
    const { division, subdivision } = splitScope(scope)
    return matchesDivision(filters, division, subdivision)
  }

  for (const row of window.months) {
    for (const [day, perScope] of Object.entries(row.payload.ship)) {
      if (day < from || day > to) continue
      for (const [scope, d] of Object.entries(perScope)) {
        if (!allowed(scope)) continue
        const acc = at(scope)
        for (const [status, count] of Object.entries(d.st)) {
          acc.st[status] = (acc.st[status] ?? 0) + count
          acc.shipments += count
        }
        acc.loads += d.ld
        acc.tracked += d.trk
        acc.pod += d.pod
      }
    }
    for (const [day, perScope] of Object.entries(row.payload.fin)) {
      if (day < from || day > to) continue
      for (const [scope, f] of Object.entries(perScope)) {
        if (!allowed(scope)) continue
        const acc = at(scope)
        acc.samples += f.n
        acc.rev += f.rev
        acc.prof += f.prof
      }
    }
  }

  const filtered = filters.divisions.length > 0 || filters.subdivisions.length > 0
  for (const kind of ['ar', 'ap'] as const) {
    for (const [scope, v] of Object.entries(window.live?.payload[kind] ?? {})) {
      const { division, subdivision } = splitScope(scope)
      // Same rule as `applyFilters`' open AR/AP: an unresolvable row is dropped under a division filter.
      if (filtered && ((!division && !subdivision) || !matchesDivision(filters, division, subdivision))) continue
      const acc = at(scope)
      if (kind === 'ar') { acc.invoices += v.n; acc.ar += v.c } else { acc.bills += v.n; acc.ap += v.c }
    }
  }

  // Company totals: every filtered row, untagged included.
  const company = emptyAccumulator()
  for (const acc of scopes.values()) {
    for (const [status, count] of Object.entries(acc.st)) company.st[status] = (company.st[status] ?? 0) + count
    company.shipments += acc.shipments
    company.samples += acc.samples
    company.rev += acc.rev
    company.prof += acc.prof
    company.invoices += acc.invoices
    company.ar += acc.ar
    company.bills += acc.bills
    company.ap += acc.ap
  }
  const companyFigures = stripFigures(company)
  const totals: RollupTotals = {
    shipmentCount: company.shipments > 0 ? company.shipments : null,
    revenueCents: companyFigures.revenueCents,
    profitCents: companyFigures.profitCents,
    marginBps: companyFigures.marginBps,
    arOpenCents: companyFigures.arOpenCents,
    apOpenCents: companyFigures.apOpenCents,
  }

  // Strips, one per active top-level division.
  const topNodes = divisionTree(divisions)
    .filter((node) => node.division.active !== false && node.division.parentId == null)
    .sort((a, b) => (a.division.sortOrder ?? 0) - (b.division.sortOrder ?? 0))
  if (topNodes.length === 0) return { strips: [], totals }

  const bucketOf = new Map<ScopeKey, { top: string | null; sub: string | null; division: string }>()
  for (const scope of scopes.keys()) {
    const { division, subdivision } = splitScope(scope)
    const code = subdivision || division || null
    const top = code ? topLevelOf(divisions, code) : null
    bucketOf.set(scope, { top, sub: code && top !== code ? code : null, division })
  }

  const sum = (match: (b: { top: string | null; sub: string | null; division: string }) => boolean): Accumulator => {
    const acc = emptyAccumulator()
    for (const [scope, part] of scopes) {
      if (!match(bucketOf.get(scope)!)) continue
      for (const [status, count] of Object.entries(part.st)) acc.st[status] = (acc.st[status] ?? 0) + count
      acc.shipments += part.shipments
      acc.loads += part.loads
      acc.tracked += part.tracked
      acc.pod += part.pod
      acc.samples += part.samples
      acc.rev += part.rev
      acc.prof += part.prof
      acc.invoices += part.invoices
      acc.ar += part.ar
      acc.bills += part.bills
      acc.ap += part.ap
    }
    return acc
  }

  const strips: RollupStrip[] = []
  for (const node of topNodes) {
    const topCode = node.division.code
    const children = node.children
      .filter((child) => child.division.active !== false)
      .sort((a, b) => (a.division.sortOrder ?? 0) - (b.division.sortOrder ?? 0))
    const childCodes = new Set(children.map((child) => child.division.code))

    const subdivisions: RollupSubdivision[] = children.map((child) => {
      const childCode = child.division.code
      const acc = sum((b) => {
        if (b.top !== topCode) return false
        if (b.sub) return b.sub === childCode
        return childCodes.has(b.division) && b.division === childCode
      })
      return { code: childCode, name: child.division.name, brand: child.division.brand ?? null, ...stripFigures(acc) }
    })

    strips.push({
      code: topCode,
      name: node.division.name,
      brand: node.division.brand ?? null,
      subdivisions,
      ...stripFigures(sum((b) => b.top === topCode)),
    })
  }

  return { strips: rollupStrips(strips), totals }
}

/** Month keys a window reads: every month it touches plus one either side. */
export function rollupMonthsFor(from: string, to: string, pad = 1): string[] {
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  const first = monthOfValue(lo)
  const last = monthOfValue(hi)
  if (!first || !last) return []
  let [y, m] = first.split('-').map(Number) as [number, number]
  const [ly, lm] = last.split('-').map(Number) as [number, number]
  m -= pad
  while (m < 1) { m += 12; y -= 1 }
  let endY = ly
  let endM = lm + pad
  while (endM > 12) { endM -= 12; endY += 1 }
  const out: string[] = []
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}
