/**
 * tms-dashboard-rollup Lambda (Step AF). Keeps the DashboardRollup table current.
 *
 * Refresh is an idempotent RECOMPUTE of whole rows from the source tables (never an
 * incremental counter), so a duplicated, late, lost or out-of-order event cannot corrupt a
 * figure; the worst case is a row that is a few minutes old until the next sweep.
 *
 *  1. DynamoDB stream batch (Shipment, Order, Load, LaneRateSample, Invoice, CarrierBill):
 *     `dirtyKeysForRecord` keeps only changes to fields a figure reads; the keys it returns
 *     are marked `D:<rowId>` (idempotent UpdateItem), then this invocation recomputes the
 *     ones it can lease. The `D:` row is cleared conditionally on the `dirtyAt` it read, so a
 *     write that lands during the recompute leaves it dirty for the next pass.
 *  2. `{ sweep: true }` from DashboardRollupSweepRule (every 5 minutes): every dirty key, the
 *     live row, the previous / current / next month, then a progressive backfill of missing or
 *     old-schema months, newest first, inside the time budget.
 *  3. `{ backfill: { from: 'YYYY-MM', to: 'YYYY-MM' } }`: force-recompute that month range.
 */
import {
  computeLive,
  computeMonth,
  dirtyKeysForRecord,
  ROLLUP_SCHEMA_VERSION,
  type LivePayload,
  type MonthPayload,
  type RollupSourceTable,
} from '../../../src/lib/dashboardRollup'
import { computeLegacyMonth, type LegacyMonthPayload } from '../../../src/lib/dashboardRollupLegacy'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import {
  documentClient,
  kindOf,
  periodKeyOf,
  rollupSource,
  rollupStore,
  type RollupRow,
  type RollupSource,
  type RollupStore,
} from './store'

/** Above this the row is not written: DynamoDB caps an item at 400 KB. */
export const MAX_PAYLOAD_BYTES = 300_000
/** A key recomputed this recently stays dirty for the next batch or sweep (stream storms). */
export const MIN_RECOMPUTE_INTERVAL_MS = 15_000
export const LEASE_SECONDS = 120
/** Months (with their LG twin) one stream invocation recomputes; the rest wait for the sweep. */
export const STREAM_MAX_MONTHS = 3
export const STREAM_BUDGET_MS = 100_000
export const SWEEP_BUDGET_MS = 240_000
/** The progressive backfill walks back to here. */
export const BACKFILL_FLOOR = '2024-01'
/** What one recompute is expected to cost at most; a key is not started when less time is left. */
const KEY_RESERVE_MS = 12_000

export type RecomputeOutcome = 'written' | 'too-large' | 'throttled' | 'leased'

interface StreamRecord {
  eventSourceARN?: string
  dynamodb?: {
    SequenceNumber?: string
    OldImage?: Record<string, AttributeValue>
    NewImage?: Record<string, AttributeValue>
  }
}
export interface StreamEvent { Records?: StreamRecord[] }
export interface StreamResponse { batchItemFailures: Array<{ itemIdentifier: string }> }

export interface SweepEvent { sweep: true }
export interface BackfillEvent { backfill: { from: string; to: string } }

export interface RollupSummary {
  written: string[]
  skipped: Array<{ key: string; why: RecomputeOutcome }>
  failed: Array<{ key: string; error: string }>
  /** Backfill only: keys not reached before the budget ran out. */
  remaining: string[]
}

/** The three pure computes, injectable so the engine is testable without the real lib. */
export interface Computes {
  month(src: RollupSource, month: string): Promise<MonthPayload>
  live(src: RollupSource): Promise<LivePayload>
  legacy(src: RollupSource, month: string): Promise<LegacyMonthPayload>
}

export interface RollupDeps {
  store: RollupStore
  source: RollupSource
  computes: Computes
  /** Source table name (from the stream ARN) → RollupSourceTable. */
  tableByName: Record<string, RollupSourceTable>
  now(): Date
  /** Waits between retries of a throttled / leased key (injectable so tests do not sleep). */
  sleep(ms: number): Promise<void>
}

export const libComputes: Computes = {
  month: (src, month) => computeMonth(src, month),
  live: (src) => computeLive(src),
  legacy: (src, month) => computeLegacyMonth(src, month),
}

const emptySummary = (): RollupSummary => ({ written: [], skipped: [], failed: [], remaining: [] })

// ── Month arithmetic (UTC; the dashboards' window is the UTC calendar month) ──────────

export const monthOf = (d: Date): string => d.toISOString().slice(0, 7)

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) + delta
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

/** Newest first. */
export function monthsDescending(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = to; m >= from; m = addMonths(m, -1)) out.push(m)
  return out
}

const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

// ── Recompute one row ─────────────────────────────────────────────────────────────────

/** Which compute inputs `sourceCounts` reports, under the names the equivalence gate reads. */
const TALLY_LABEL: Record<string, string> = {
  shipments: 'shipments',
  samples: 'samples',
  loadsOf: 'loads',
  deliveredOrders: 'orders',
  openInvoices: 'invoices',
  openBills: 'bills',
}

function counted<T extends object>(src: T, tally: Record<string, number>): T {
  return new Proxy(src, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      const label = typeof prop === 'string' && Object.prototype.hasOwnProperty.call(TALLY_LABEL, prop) ? TALLY_LABEL[prop] : undefined
      if (typeof value !== 'function' || !label) return value
      return async (...args: unknown[]) => {
        const out = (await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)) as unknown
        if (Array.isArray(out)) tally[label] = (tally[label] ?? 0) + out.length
        return out
      }
    },
  })
}

/**
 * Recompute `rowId` ('M:2026-11' | 'LG:2026-11' | 'L:CURRENT') and replace it. One recompute
 * per key at a time (`K:` lease); the `D:` marker it read before reading the sources is
 * cleared only if it has not been touched since.
 */
export async function recomputeKey(
  deps: RollupDeps,
  rowId: string,
  opts: { respectMinInterval: boolean },
): Promise<RecomputeOutcome> {
  const { store } = deps
  const kind = kindOf(rowId)
  const period = periodKeyOf(rowId)
  const existing = await store.get(rowId)
  if (opts.respectMinInterval && existing?.computedAt) {
    if (deps.now().getTime() - Date.parse(existing.computedAt) < MIN_RECOMPUTE_INTERVAL_MS) return 'throttled'
  }
  const nowSec = Math.floor(deps.now().getTime() / 1000)
  if (!(await store.acquireLease(rowId, nowSec, LEASE_SECONDS))) return 'leased'
  try {
    // Read the marker before the sources: anything written after this read bumps dirtyAt.
    const seenDirty = (await store.get(`D:${rowId}`))?.dirtyAt
    const started = deps.now()
    const tally: Record<string, number> = {}
    const src = counted(deps.source, tally)
    let payload: MonthPayload | LivePayload | LegacyMonthPayload
    if (kind === 'M') payload = await deps.computes.month(src, period)
    else if (kind === 'LG') payload = await deps.computes.legacy(src, period)
    else if (kind === 'L') payload = await deps.computes.live(src)
    else throw new Error(`not a computable rollup key: ${rowId}`)

    const json = JSON.stringify(payload)
    const stamp = deps.now().toISOString()
    const tooLarge = json.length > MAX_PAYLOAD_BYTES
    if (tooLarge) console.error(`ROLLUP_TOO_LARGE ${rowId} ${json.length}`)
    const row: RollupRow = {
      __typename: 'DashboardRollup',
      id: rowId,
      kind,
      periodKey: period,
      // A too-large payload is replaced by an empty marker row: the client reads "no payload"
      // as unusable and falls back to the exact path; a stale old payload must not linger.
      schemaVersion: ROLLUP_SCHEMA_VERSION,
      payload: tooLarge ? null : json,
      computedAt: started.toISOString(),
      computeMs: deps.now().getTime() - started.getTime(),
      sourceCounts: JSON.stringify(tooLarge ? { ...tally, tooLarge: true } : tally),
      version: (existing?.version ?? 0) + 1,
      createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : stamp,
      updatedAt: stamp,
    }
    await store.put(row)
    if (seenDirty) await store.clearDirty(rowId, seenDirty)
    return tooLarge ? 'too-large' : 'written'
  } finally {
    await store.releaseLease(rowId).catch((err: unknown) => console.error('[rollup] lease release failed', rowId, err))
  }
}

/** Runs `keys` in order until `budgetMs` runs short; records what happened per key. */
async function recomputeKeys(
  deps: RollupDeps,
  keys: string[],
  opts: { respectMinInterval: boolean; deadline: number },
  into: RollupSummary,
): Promise<void> {
  for (const [i, key] of keys.entries()) {
    if (deps.now().getTime() + KEY_RESERVE_MS > opts.deadline) {
      into.remaining.push(...keys.slice(i))
      return
    }
    try {
      let outcome = await recomputeKey(deps, key, { respectMinInterval: opts.respectMinInterval })
      // A stream event must not be left to the 5-minute sweep: while the key is throttled or
      // leased by another invocation and its D: marker is still there (a newer write bumped
      // it), wait and try again inside the budget.
      for (let attempt = 0; opts.respectMinInterval && (outcome === 'throttled' || outcome === 'leased') && attempt < 8; attempt++) {
        if (deps.now().getTime() + MIN_RECOMPUTE_INTERVAL_MS + KEY_RESERVE_MS > opts.deadline) break
        if (!(await deps.store.get(`D:${key}`))) break
        await deps.sleep(outcome === 'throttled' ? 2_000 : 1_500)
        outcome = await recomputeKey(deps, key, { respectMinInterval: true })
      }
      if (outcome === 'written' || outcome === 'too-large') into.written.push(key)
      if (outcome !== 'written') into.skipped.push({ key, why: outcome })
    } catch (err) {
      // The D: marker survives a failed recompute, so the sweep retries it.
      console.error('[rollup] recompute failed', key, err)
      into.failed.push({ key, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** Live row first, then months newest first (M and its LG twin together). */
export function priorityOrder(keys: Iterable<string>): string[] {
  const set = new Set(keys)
  const months = [...set].filter((k) => k.startsWith('M:') || k.startsWith('LG:')).map(periodKeyOf)
  const out: string[] = []
  if (set.has('L:CURRENT')) out.push('L:CURRENT')
  for (const month of [...new Set(months)].sort().reverse()) {
    for (const k of [`M:${month}`, `LG:${month}`]) if (set.has(k)) out.push(k)
  }
  return out
}

// ── Door 1: stream batch ──────────────────────────────────────────────────────────────

function tableOfArn(arn: string | undefined, byName: Record<string, RollupSourceTable>): RollupSourceTable | undefined {
  const name = arn?.match(/:table\/([^/]+)\/stream\//)?.[1]
  return name ? byName[name] : undefined
}

/** Plain objects for the pure diff: string sets become arrays, like the source reads. */
function image(raw: Record<string, AttributeValue> | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const out = unmarshall(raw)
  for (const [k, v] of Object.entries(out)) if (v instanceof Set) out[k] = [...v]
  return out
}

export async function processStream(
  deps: RollupDeps,
  event: StreamEvent,
  budgetMs = STREAM_BUDGET_MS,
): Promise<{ response: StreamResponse; summary: RollupSummary }> {
  const failures: StreamResponse['batchItemFailures'] = []
  const dirty = new Set<string>()
  for (const record of event.Records ?? []) {
    const table = tableOfArn(record.eventSourceARN, deps.tableByName)
    if (!table) continue
    try {
      for (const key of dirtyKeysForRecord(table, image(record.dynamodb?.OldImage), image(record.dynamodb?.NewImage))) dirty.add(key)
    } catch (err) {
      // A record that cannot be read is reported alone; the rest of the batch still counts.
      console.error('[rollup] poison record', record.dynamodb?.SequenceNumber, err)
      if (record.dynamodb?.SequenceNumber) failures.push({ itemIdentifier: record.dynamodb.SequenceNumber })
    }
  }
  const summary = emptySummary()
  if (dirty.size === 0) return { response: { batchItemFailures: failures }, summary }

  // Marking is the durable part; it throws (whole batch retries) rather than lose an event.
  const at = deps.now().toISOString()
  for (const key of dirty) await deps.store.markDirty(key, at)

  const ordered = priorityOrder(dirty)
  const months = new Set<string>()
  const todo = ordered.filter((k) => {
    if (k === 'L:CURRENT') return true
    months.add(periodKeyOf(k))
    return months.size <= STREAM_MAX_MONTHS
  })
  await recomputeKeys(deps, todo, { respectMinInterval: true, deadline: deps.now().getTime() + budgetMs }, summary)
  return { response: { batchItemFailures: failures }, summary }
}

// ── Door 2: sweep ─────────────────────────────────────────────────────────────────────

export async function runSweep(deps: RollupDeps, budgetMs = SWEEP_BUDGET_MS): Promise<RollupSummary> {
  const deadline = deps.now().getTime() + budgetMs
  const rows = await deps.store.scanAll()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const keys = new Set<string>()

  // 1. Everything a stream event marked and could not (or did not) finish.
  const dirtyKeys = rows.filter((r) => r.id.startsWith('D:')).map((r) => r.id.slice(2))
  for (const k of priorityOrder(dirtyKeys)) keys.add(k)
  // 2. Clock-driven: the live row and the months the dashboards read by default (±1 pad).
  const current = monthOf(deps.now())
  keys.add('L:CURRENT')
  for (const delta of [0, -1, 1]) keys.add(`M:${addMonths(current, delta)}`)
  for (const delta of [0, -1]) keys.add(`LG:${addMonths(current, delta)}`)
  // 3. Progressive backfill: absent or old-schema rows, newest first.
  for (const month of monthsDescending(BACKFILL_FLOOR, addMonths(current, 1))) {
    for (const k of [`M:${month}`, `LG:${month}`]) {
      if (byId.get(k)?.schemaVersion !== ROLLUP_SCHEMA_VERSION) keys.add(k)
    }
  }

  const summary = emptySummary()
  await recomputeKeys(deps, [...keys], { respectMinInterval: false, deadline }, summary)
  return summary
}

// ── Door 3: manual backfill ───────────────────────────────────────────────────────────

export async function runBackfill(deps: RollupDeps, range: { from: string; to: string }, budgetMs = SWEEP_BUDGET_MS): Promise<RollupSummary> {
  if (!isMonth(range.from) || !isMonth(range.to) || range.from > range.to) {
    throw new Error(`backfill needs { from: 'YYYY-MM', to: 'YYYY-MM' } with from <= to, got ${JSON.stringify(range)}`)
  }
  const keys = ['L:CURRENT', ...monthsDescending(range.from, range.to).flatMap((m) => [`M:${m}`, `LG:${m}`])]
  const summary = emptySummary()
  await recomputeKeys(deps, keys, { respectMinInterval: false, deadline: deps.now().getTime() + budgetMs }, summary)
  return summary
}

// ── Entry ─────────────────────────────────────────────────────────────────────────────

function envName(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

export function depsFromEnv(): RollupDeps {
  const db = documentClient()
  const tables = {
    shipment: envName('SHIPMENT_TABLE_NAME'),
    order: envName('ORDER_TABLE_NAME'),
    load: envName('LOAD_TABLE_NAME'),
    sample: envName('LANE_RATE_SAMPLE_TABLE_NAME'),
    invoice: envName('INVOICE_TABLE_NAME'),
    carrierBill: envName('CARRIER_BILL_TABLE_NAME'),
  }
  return {
    store: rollupStore(db, envName('DASHBOARD_ROLLUP_TABLE_NAME')),
    source: rollupSource(db, tables),
    computes: libComputes,
    tableByName: {
      [tables.shipment]: 'Shipment',
      [tables.order]: 'Order',
      [tables.load]: 'Load',
      [tables.sample]: 'LaneRateSample',
      [tables.invoice]: 'Invoice',
      [tables.carrierBill]: 'CarrierBill',
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

interface LambdaContext { getRemainingTimeInMillis?: () => number }

const isStream = (e: unknown): e is StreamEvent => Array.isArray((e as StreamEvent | null)?.Records)
const isSweep = (e: unknown): e is SweepEvent => (e as SweepEvent | null)?.sweep === true
const isBackfill = (e: unknown): e is BackfillEvent => typeof (e as BackfillEvent | null)?.backfill === 'object'

export const handler = async (event: unknown, context?: LambdaContext): Promise<StreamResponse | RollupSummary> => {
  const deps = depsFromEnv()
  // Leave the platform 20 s to return; never plan past the function timeout.
  const room = Math.max(0, (context?.getRemainingTimeInMillis?.() ?? SWEEP_BUDGET_MS + 20_000) - 20_000)
  if (isStream(event)) {
    const { response, summary } = await processStream(deps, event, Math.min(STREAM_BUDGET_MS, room))
    console.log('[tms-dashboard-rollup] stream', JSON.stringify(summary))
    return response
  }
  if (isSweep(event)) {
    const summary = await runSweep(deps, Math.min(SWEEP_BUDGET_MS, room))
    console.log('[tms-dashboard-rollup] sweep', JSON.stringify(summary))
    return summary
  }
  if (isBackfill(event)) {
    const summary = await runBackfill(deps, event.backfill, Math.min(SWEEP_BUDGET_MS, room))
    console.log('[tms-dashboard-rollup] backfill', JSON.stringify(summary))
    return summary
  }
  throw new Error('tms-dashboard-rollup: expected a DynamoDB stream batch, { sweep: true } or { backfill: { from, to } }')
}
