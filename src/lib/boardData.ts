// THE loader the shell, the board, tracking, the dashboard and the worklists share.
// Work per call follows the window and the open work, never the table (PERF-plan §4.3, §6).
import type { DocsNeededOrder } from '@/lib/apiClient'
import {
  getShipmentsBatch,
  listDocsNeededOrdersNarrow,
  listLoadCarriers,
  listLoadCarriersByShipmentIds,
  listLoadFinancials,
  listLoadFinancialsByLoadIds,
  listLoadSummaries,
  listLoadSummariesByShipmentIds,
  listOrders,
  listOrdersByShipmentIds,
  listShipments,
  listShipmentsByCustomer,
  listShipmentsByMonth,
  listShipmentsByMonthFiltered,
  listShipmentsByStatus,
  listShipmentsByStatusesFiltered,
} from '@/lib/apiClient'
import type {
  LoadBoardSummary,
  LoadCarrierRecord,
  LoadFinancialsRecord,
  OrderRecord,
  ShipmentRecord,
  ShipmentStatus,
} from '@/lib/apiClient'
import { peekFresh, peekList, putList, readList } from '@/lib/listCache'
import type { CacheOpts } from '@/lib/listCache'
import { OPEN_SHIPMENT_STATUSES, mergeShipmentSets } from '@/lib/shipmentWindows'

export type BoardView =
  /** The open-work set: every non-terminal shipment plus delivered-and-not-yet-released ones. */
  | { kind: 'working' }
  /** pickupMonth fan-out; `includeVoided` drops the server-side void filter. */
  | { kind: 'window'; months: string[]; includeVoided?: boolean }
  /** A getShipment batch (worklists, error tab). */
  | { kind: 'ids'; ids: string[] }
  | { kind: 'status'; status: ShipmentStatus }
  | { kind: 'customer'; customerId: string }
  | { kind: 'month'; month: string }
  /** Full scan. Export only (R1): no page uses it. */
  | { kind: 'all' }

export interface BoardBundle {
  shipments: ShipmentRecord[]
  orders: OrderRecord[]
  loads: LoadBoardSummary[]
  loadCarriers: LoadCarrierRecord[]
  loadFinancials: LoadFinancialsRecord[]
}

export interface LoadBoardOpts {
  /** Re-read instead of serving the cache (the in-flight read is still shared). */
  force?: boolean
  /** Called with the stage-1 rows (already joined) while later stages are still loading. */
  onPartial?: (partial: BoardBundle) => void
}

/** Counters the perf gate reads (G7). Not state the app depends on. */
export const boardStats = { stage2Ids: 0, stage2Fetched: 0 }

const emptyBundle = (): BoardBundle => ({ shipments: [], orders: [], loads: [], loadCarriers: [], loadFinancials: [] })

const WORKING_CACHE: CacheOpts = { ttlMs: 30_000, staleMs: 300_000 }
const WINDOW_CACHE: CacheOpts = { ttlMs: 300_000 }
const DEFAULT_CACHE: CacheOpts = { ttlMs: 30_000 }
const MEMO_TTL_MS = 300_000

function hashIds(ids: readonly string[]): string {
  let h = 5381
  for (const id of ids) for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0
  return `${ids.length}:${h.toString(36)}`
}

/** The `listCache` key of a view. Equal views (month order, id order) share a key. */
export function boardViewKey(view: BoardView): string {
  switch (view.kind) {
    case 'working': return 'board:working'
    case 'window': return `board:window:${[...new Set(view.months)].sort().join(',')}${view.includeVoided ? ':voided' : ''}`
    case 'ids': return `board:ids:${hashIds([...new Set(view.ids)].sort())}`
    case 'status': return `board:status:${view.status}`
    case 'customer': return `board:customer:${view.customerId}`
    case 'month': return `board:month:${view.month}`
    case 'all': return 'board:all'
  }
}

function cacheFor(view: BoardView): CacheOpts {
  if (view.kind === 'working') return WORKING_CACHE
  if (view.kind === 'window') return WINDOW_CACHE
  return DEFAULT_CACHE
}

/** What is cached for a view right now (any age), to seed a first render. */
export function peekBoardBundle(view: BoardView): BoardBundle | undefined {
  return peekList<BoardBundle>(boardViewKey(view))
}

/**
 * Cache-aware read: `value` is usable right now (fresh or stale; a stale hit refreshes in the
 * background), `fresh` resolves with a bundle no older than the view's ttl.
 */
export function readBoardBundle(view: BoardView, opts?: LoadBoardOpts): { value: BoardBundle | undefined; fresh: Promise<BoardBundle> } {
  return readList(boardViewKey(view), () => fetchBundle(view, opts?.onPartial), { ...cacheFor(view), force: opts?.force })
}

export function loadBoardBundle(view: BoardView, opts?: LoadBoardOpts): Promise<BoardBundle> {
  return readBoardBundle(view, opts).fresh
}

/** The tables joined to a set of shipments: aliased batches by shipment id, then financials by load id. */
async function joinShipments(shipments: ShipmentRecord[]): Promise<BoardBundle> {
  if (shipments.length === 0) return emptyBundle()
  const ids = shipments.map((s) => s.id)
  const [orders, loads, loadCarriers] = await Promise.all([
    listOrdersByShipmentIds(ids),
    listLoadSummariesByShipmentIds(ids),
    listLoadCarriersByShipmentIds(ids),
  ])
  const loadFinancials = await listLoadFinancialsByLoadIds(loads.map((l) => l.id))
  return { shipments, orders, loads, loadCarriers, loadFinancials }
}

function concatBundles(a: BoardBundle, b: BoardBundle): BoardBundle {
  return {
    shipments: mergeShipmentSets(a.shipments, b.shipments),
    orders: [...a.orders, ...b.orders],
    loads: [...a.loads, ...b.loads],
    loadCarriers: [...a.loadCarriers, ...b.loadCarriers],
    loadFinancials: [...a.loadFinancials, ...b.loadFinancials],
  }
}

const deadKey = (id: string) => `board:dead:${id}`

/**
 * Stage 2 of the working set: delivered shipments whose order still waits for documents. The
 * ids not already in the open set go through a narrow getShipment batch; voided/deleted ones are
 * remembered (5 min, cleared by any write) so the next call does not ask again. Survivors are
 * not voided, not deleted, not canceled — fetched in full. That is DELIVERED rows, and also any
 * open-status row the status index cannot see (an undated draft has no `pickupAppt`, the index's
 * sort key, so it is absent from stage 1).
 */
async function deliveredAwaitingRelease(
  openIds: ReadonlySet<string>,
  docsNeeded: Promise<DocsNeededOrder[]>,
): Promise<ShipmentRecord[]> {
  const orders = await docsNeeded
  const wanted = new Set<string>()
  for (const o of orders) {
    // Released orders (invoice id, ready-to-invoice stamp) are not on any open list.
    if (!o.shipmentId || o.readyToInvoiceAt || o.invoiceId) continue
    if (openIds.has(o.shipmentId)) continue
    if (peekFresh(deadKey(o.shipmentId), MEMO_TTL_MS)) continue
    wanted.add(o.shipmentId)
  }
  boardStats.stage2Ids = wanted.size
  if (wanted.size === 0) return []
  const narrow = await getShipmentsByIds([...wanted], true) // memoised: the AR/AP worklists ask for these same ids next
  const survivors: string[] = []
  for (const [id, s] of narrow) {
    if (s.voidedAt || s.deletedAt) putList(deadKey(id), true)
    else if (s.status !== 'CANCELED') survivors.push(id)
  }
  boardStats.stage2Fetched = survivors.length
  if (survivors.length === 0) return []
  return [...(await getShipmentsByIds(survivors, false)).values()]
}

async function fetchBundle(view: BoardView, onPartial?: (b: BoardBundle) => void): Promise<BoardBundle> {
  switch (view.kind) {
    case 'working': {
      // Stage 1: the open statuses and the DOCS_NEEDED order list read in parallel.
      const docsNeeded = listDocsNeededOrdersNarrow()
      docsNeeded.catch(() => {}) // surfaced where it is awaited; never an unhandled rejection
      const open = mergeShipmentSets(await listShipmentsByStatusesFiltered(OPEN_SHIPMENT_STATUSES))
      // Stage 2 (narrow checks of the delivered backlog) runs while the open rows join.
      const stage2 = deliveredAwaitingRelease(new Set(open.map((s) => s.id)), docsNeeded)
      stage2.catch(() => {})
      const openBundle = await joinShipments(open)
      onPartial?.(openBundle)
      return concatBundles(openBundle, await joinShipments(await stage2))
    }
    case 'window': {
      const sets = await Promise.all([...new Set(view.months)].map((m) => listShipmentsByMonthFiltered(m, { includeVoided: view.includeVoided })))
      return joinShipments(mergeShipmentSets(...sets))
    }
    case 'ids':
      return joinShipments([...(await getShipmentsBatch(view.ids, false)).values()])
    case 'status':
      return joinShipments(await listShipmentsByStatus(view.status))
    case 'customer':
      return joinShipments(await listShipmentsByCustomer(view.customerId))
    case 'month':
      return joinShipments(await listShipmentsByMonth(view.month))
    case 'all': {
      const [shipments, orders, loads, loadCarriers, loadFinancials] = await Promise.all([
        listShipments(), listOrders(), listLoadSummaries(), listLoadCarriers(), listLoadFinancials(),
      ])
      return { shipments, orders, loads, loadCarriers, loadFinancials }
    }
  }
}

const shipKey = (id: string, narrow: boolean) => `board:ship:${narrow ? 'n' : 'f'}:${id}`

/**
 * Shipments by id with a per-id memo (5 min, cleared by any write) shared by every caller. A
 * full row also serves a narrow request. `narrow` reads `id number status customerId deliveredAt
 * voidedAt deletedAt` only. Ids that do not exist are absent.
 */
export async function getShipmentsByIds(ids: readonly string[], narrow = false): Promise<Map<string, ShipmentRecord>> {
  const out = new Map<string, ShipmentRecord>()
  const missing: string[] = []
  for (const id of new Set(ids)) {
    const hit = peekFresh<ShipmentRecord>(shipKey(id, false), MEMO_TTL_MS)
      ?? (narrow ? peekFresh<ShipmentRecord>(shipKey(id, true), MEMO_TTL_MS) : undefined)
    if (hit) out.set(id, hit)
    else missing.push(id)
  }
  if (missing.length > 0) {
    const fetched = await getShipmentsBatch(missing, narrow)
    for (const [id, row] of fetched) {
      putList(shipKey(id, narrow), row)
      out.set(id, row)
    }
  }
  return out
}
