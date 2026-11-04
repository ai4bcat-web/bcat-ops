// Reader of the DashboardRollup rows (Step AF). Plain AppSync `getDashboardRollup` by id, one
// aliased request for every row a window needs: no Lambda on the read path. Reads only; the
// shared graphql runner is installed by apiClient, so this module never imports it.
import { batchGet } from '@/lib/aliasBatch'
import { peekList, readList } from '@/lib/listCache'
import {
  LIVE_ROW_ID, ROLLUP_SCHEMA_VERSION, rollupMonthsFor,
  type DivisionInput, type LivePayload, type MonthPayload, type RollupRow, type RollupWindow,
} from '@/lib/dashboardRollup'

/** A row older than this (live row, current and previous month) is not trusted: exact path. */
export const ROLLUP_MAX_AGE_MS = 30 * 60 * 1000
/** Older than this the figures are labelled stale (amber). */
export const ROLLUP_STALE_MS = 10 * 60 * 1000

const CACHE_OPTS = { ttlMs: 60_000, staleMs: 600_000 }
const FIELDS = 'id kind periodKey schemaVersion payload computedAt'

/** One stored row as read: the payload already parsed, nothing validated. */
export interface RawRollupRow {
  id: string
  kind: string
  periodKey: string
  schemaVersion: number | null
  payload: unknown
  computedAt: string | null
}

type WireRow = Omit<RawRollupRow, 'payload'> & { payload: unknown }

/** AWSJSON arrives as a JSON string, and the Lambda stores a string already: decode until an object comes out. */
function parsePayload(payload: unknown): unknown {
  let value = payload
  for (let depth = 0; typeof value === 'string' && depth < 3; depth++) {
    try { value = JSON.parse(value) } catch { return null }
  }
  return value
}

const rowsKey = (ids: readonly string[]) => `rollup:rows:${ids.join(',')}`
const sortedIds = (ids: readonly string[]) => [...new Set(ids)].sort()

async function fetchRows(ids: string[]): Promise<RawRollupRow[]> {
  const rows = await batchGet<WireRow>({ query: 'getDashboardRollup', fields: FIELDS }, ids)
  // 'DASH:' rows are conversational-dashboard specs (Step AI) sharing this table: never rollup data.
  return [...rows.values()].filter((row) => !row.id.startsWith('DASH:')).map((row) => ({ ...row, payload: parsePayload(row.payload) }))
}

/**
 * The rows for `ids` in one request (cached 60 s, served stale for 10 more minutes while one
 * refresh runs). An id with no row is absent from the array. Nothing is filtered by schema
 * version here: callers decide with `isUsableRow`.
 */
export function readRollupRows(ids: string[]): { value?: RawRollupRow[]; fresh: Promise<RawRollupRow[]> } {
  const sorted = sortedIds(ids)
  return readList(rowsKey(sorted), () => fetchRows(sorted), CACHE_OPTS)
}

/** Known schema, a payload and a parseable `computedAt` no older than 30 minutes. */
export function isUsableRow(row: RawRollupRow, now = Date.now()): boolean {
  if (row.schemaVersion !== ROLLUP_SCHEMA_VERSION || !row.payload || typeof row.payload !== 'object') return false
  const at = row.computedAt ? Date.parse(row.computedAt) : NaN
  return Number.isFinite(at) && now - at <= ROLLUP_MAX_AGE_MS
}

const monthOfNow = (now: number) => new Date(now).toISOString().slice(0, 7)

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/**
 * The window the rows describe, or `null` when it cannot be trusted. Trusted means: the live row
 * and every month the window reads (touched months plus one either side) are present with a
 * known schema, except months after the current one, which legitimately have no row yet; the
 * live row and the current and previous month (the rows the sweep always refreshes) are
 * younger than 30 minutes. History months are exact until a write marks them dirty, so their
 * age does not matter.
 */
export function windowFromRows(rows: readonly RawRollupRow[], from: string, to: string, now = Date.now()): RollupWindow | null {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const current = monthOfNow(now)
  const recent = new Set([current, previousMonth(current)])
  const months: RollupRow<MonthPayload>[] = []
  for (const month of rollupMonthsFor(from, to, 1)) {
    const row = byId.get(`M:${month}`)
    if (!row) {
      if (month > current) continue
      return null
    }
    const known = row.schemaVersion === ROLLUP_SCHEMA_VERSION && !!row.payload && typeof row.payload === 'object'
    if (!known || (recent.has(month) && !isUsableRow(row, now)) || !row.computedAt) return null
    months.push({ id: row.id, schemaVersion: row.schemaVersion as number, computedAt: row.computedAt, payload: row.payload as MonthPayload })
  }
  const liveRow = byId.get(LIVE_ROW_ID)
  if (!liveRow || !isUsableRow(liveRow, now) || !liveRow.computedAt) return null
  if (months.length === 0) return null
  return {
    months,
    live: { id: liveRow.id, schemaVersion: liveRow.schemaVersion as number, computedAt: liveRow.computedAt, payload: liveRow.payload as LivePayload },
  }
}

/** The ids `windowFromRows` needs for a window. */
export function rollupIdsFor(from: string, to: string): string[] {
  return [...rollupMonthsFor(from, to, 1).map((m) => `M:${m}`), LIVE_ROW_ID]
}

/** `min(computedAt)` over the rows the label stands for (live row, current and previous month), ms epoch. */
export function rollupAsOfMs(window: RollupWindow, now = Date.now()): number {
  const current = monthOfNow(now)
  const recent = new Set([current, previousMonth(current)])
  const stamps = [window.live, ...window.months.filter((row) => recent.has(row.id.slice(2)))]
    .filter((row): row is RollupRow<MonthPayload> | RollupRow<LivePayload> => row != null)
    .map((row) => Date.parse(row.computedAt))
    .filter(Number.isFinite)
  return stamps.length > 0 ? Math.min(...stamps) : now
}

// ── sessionStorage seed (aggregates only; tab-scoped) ─────────────────────────────────────────

const SEED_PREFIX = 'bcat.dash.rollup.v1:'
const DIVISIONS_KEY = 'bcat.dash.rollup.v1:divisions'

interface Seed<T> { savedAt: number; value: T }

function storage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

function readSeed<T>(key: string, now: number): T | null {
  try {
    const raw = storage()?.getItem(key)
    if (!raw) return null
    const seed = JSON.parse(raw) as Seed<T>
    return typeof seed.savedAt === 'number' && now - seed.savedAt <= ROLLUP_MAX_AGE_MS ? seed.value : null
  } catch { return null }
}

function writeSeed<T>(key: string, value: T, now: number): void {
  try { storage()?.setItem(key, JSON.stringify({ savedAt: now, value } satisfies Seed<T>)) } catch { /* quota or private mode: the seed is an optimisation */ }
}

const seedKey = (from: string, to: string) => `${SEED_PREFIX}${rollupMonthsFor(from, to, 1).join(',')}`

/**
 * What can be painted right now with no network: the in-memory rows (any age, re-validated), else
 * the `sessionStorage` seed of this tab. Always re-validated, so an old seed never paints.
 */
export function peekRollup(from: string, to: string, now = Date.now()): RollupWindow | null {
  const memory = peekList<RawRollupRow[]>(rowsKey(sortedIds(rollupIdsFor(from, to))))
  const fromMemory = memory ? windowFromRows(memory, from, to, now) : null
  if (fromMemory) return fromMemory
  const seeded = readSeed<RawRollupRow[]>(seedKey(from, to), now)
  return seeded ? windowFromRows(seeded, from, to, now) : null
}

/** The window as the backend has it now: `null` when missing, old, wrong schema (exact path). Rejects on a failed read. */
export async function fetchRollup(from: string, to: string, now = Date.now()): Promise<RollupWindow | null> {
  const rows = await readRollupRows(rollupIdsFor(from, to)).fresh
  const window = windowFromRows(rows, from, to, now)
  if (window) writeSeed(seedKey(from, to), rows, now)
  return window
}

export function peekRollupDivisions(now = Date.now()): DivisionInput[] | null {
  return readSeed<DivisionInput[]>(DIVISIONS_KEY, now)
}

export function saveRollupDivisions(divisions: DivisionInput[], now = Date.now()): void {
  if (divisions.length > 0) writeSeed(DIVISIONS_KEY, divisions, now)
}
