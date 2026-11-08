import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { monthsCovering } from '@/lib/shipmentWindows'
import { chicagoDateStr } from '@/lib/date'
import { readRollupRows, ROLLUP_MAX_AGE_MS, ROLLUP_STALE_MS, type RawRollupRow } from '@/lib/dashboardRollupClient'
import { ROLLUP_SCHEMA_VERSION } from '@/lib/dashboardRollup'
import { reduceLegacy, type LegacyKpis, type LegacyMonthPayload } from '@/lib/dashboardRollupLegacy'
import { legacyKpisFromLoads, legacyWindow, type DateRangeKey } from './legacyKpiMath'

export type { DateRangeKey }
export type LegacyKpiState = 'loading' | 'ready' | 'stale'
export type LegacyKpiSource = 'cache' | 'rollup' | 'live'

export interface LegacyKpiResult {
  /** `null` until the numbers are real: the page paints skeletons, never zeros. */
  kpis: LegacyKpis | null
  state: LegacyKpiState
  source: LegacyKpiSource | null
  /** ISO time of the oldest hot month row behind the numbers (rollup/cache paints only). */
  asOf: string | null
  /** Times the painted numbers changed after the first paint (the gate wants 0). */
  flips: number
}

const SEED_MAX_AGE_MS = 30 * 60_000
const SEED_PREFIX = 'bcat.dash.legacy.v1:'

interface Seed { from: string; kpis: LegacyKpis; asOf: string | null; savedAt: number }

const isStale = (asOf: string | null, now: number) => asOf !== null && now - Date.parse(asOf) > ROLLUP_STALE_MS

function readSeed(key: DateRangeKey, from: string, now: number): Seed | null {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SEED_PREFIX + key)
    if (!raw) return null
    const seed = JSON.parse(raw) as Seed
    return seed.from === from && now - seed.savedAt <= SEED_MAX_AGE_MS ? seed : null
  } catch { return null }
}

function writeSeed(key: DateRangeKey, seed: Seed): void {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SEED_PREFIX + key, JSON.stringify(seed)) } catch { /* private mode / quota: no seed */ }
}

/** `YYYY-MM` of the Chicago month before `month`. */
function prevMonth(month: string): string {
  const [y = 0, m = 1] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

interface Usable { payloads: LegacyMonthPayload[]; asOf: string | null; stale: boolean }

/**
 * The `LG:` rows for `months`, or `null` when any is missing, has another schema, carries no
 * payload, or (current/previous month only: the sweep keeps those fresh, older months change on
 * events) is older than 30 minutes. A month after the current one (a quarter or week reaching
 * into next month) has no row yet and counts nothing.
 */
export function usableLegacyRows(rows: RawRollupRow[], months: string[], now: number): Usable | null {
  const current = chicagoDateStr(new Date(now)).slice(0, 7)
  const hotFrom = prevMonth(current)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const payloads: LegacyMonthPayload[] = []
  let asOf: string | null = null
  for (const month of months) {
    if (month > current && !byId.has(`LG:${month}`)) continue
    const row = byId.get(`LG:${month}`)
    if (!row || row.schemaVersion !== ROLLUP_SCHEMA_VERSION) return null
    const p = row.payload as Partial<LegacyMonthPayload> | null
    if (!p || p.v !== 1 || typeof p.days !== 'object' || p.days === null) return null
    if (month >= hotFrom) {
      const at = row.computedAt ? Date.parse(row.computedAt) : NaN
      if (!Number.isFinite(at) || now - at > ROLLUP_MAX_AGE_MS) return null
      if (asOf === null || row.computedAt! < asOf) asOf = row.computedAt
    }
    payloads.push(p as LegacyMonthPayload)
  }
  return { payloads, asOf, stale: isStale(asOf, now) }
}

/**
 * The legacy dashboard's Loads / Revenue / Broker-covered figures. First paint from the
 * cached `LG:` rollup rows (one aliased read, no load window); the exact arithmetic over the
 * store (`legacyKpisFromLoads`) runs, after `ensureLoadRange`, only when the rollup is
 * unusable. Numbers are never painted as zeros while unknown.
 */
export function useLegacyDashboardKpis(rangeKey: DateRangeKey): LegacyKpiResult {
  const [now0] = useState(() => new Date())
  const win = useMemo(() => legacyWindow(rangeKey, now0), [rangeKey, now0])
  const drivers = useAppStore((s) => s.drivers)
  const allLoads = useAppStore((s) => s.loads)
  const loadedMonths = useAppStore((s) => s.loadedMonths)
  const isLoading = useAppStore((s) => s.isLoading)
  const ensureLoadRange = useAppStore((s) => s.ensureLoadRange)
  const loadReferenceData = useAppStore((s) => s.loadReferenceData)

  // Rollup months by Chicago day: pad 0, the rows hold whole Chicago months.
  const months = useMemo(() => monthsCovering(win.prevFrom, win.to, 0), [win])

  // undefined = still reading; null = unusable (exact path); Usable = rollup rows.
  const [read, setRead] = useState<{ key: DateRangeKey; value: Usable | null }>()
  // Reload seed for the first range only; a later range chip has no seed.
  const [seedBox] = useState(() => {
    const at = Date.now()
    const seed = readSeed(rangeKey, win.from, at)
    return { key: rangeKey, seed, stale: seed ? isStale(seed.asOf, at) : false }
  })

  useEffect(() => { void loadReferenceData() }, [loadReferenceData])

  useEffect(() => {
    let live = true
    const apply = (rows: RawRollupRow[]) => { if (live) setRead({ key: rangeKey, value: usableLegacyRows(rows, months, Date.now()) }) }
    const { value, fresh } = readRollupRows(months.map((m) => `LG:${m}`))
    if (value) {
      const usable = usableLegacyRows(value, months, Date.now())
      if (usable) void Promise.resolve().then(() => { if (live) setRead({ key: rangeKey, value: usable }) })
    }
    fresh.then(apply).catch((err: unknown) => {
      console.warn('[legacy dashboard] rollup read failed, using the exact path', err)
      if (live) setRead((cur) => (cur?.key === rangeKey && cur.value ? cur : { key: rangeKey, value: null }))
    })
    return () => { live = false }
  }, [rangeKey, months])

  const rollup = read?.key === rangeKey ? read.value : undefined
  const exactNeeded = rollup === null

  useEffect(() => {
    if (!exactNeeded) return
    ensureLoadRange(win.prevFrom, win.to).catch((err: unknown) => console.warn('[legacy dashboard] ensureLoadRange failed', err))
  }, [exactNeeded, ensureLoadRange, win.prevFrom, win.to])

  const driversReady = drivers.length > 0
  const rollupKpis = useMemo(
    () => (rollup && driversReady ? reduceLegacy(rollup.payloads, win, drivers) : null),
    [rollup, driversReady, drivers, win],
  )
  const exactReady = exactNeeded && driversReady && !isLoading && monthsCovering(win.prevFrom, win.to, 1).every((m) => loadedMonths.has(m))
  const exactKpis = useMemo(
    () => (exactReady ? legacyKpisFromLoads(allLoads, drivers, win) : null),
    [exactReady, allLoads, drivers, win],
  )

  const usableSeed = seedBox.key === rangeKey ? seedBox.seed : null
  const kpis = rollupKpis ?? exactKpis ?? (rollup === null ? null : usableSeed?.kpis ?? null)
  const source: LegacyKpiSource | null = rollupKpis ? 'rollup' : exactKpis ? 'live' : kpis ? 'cache' : null
  const asOf = rollupKpis ? rollup?.asOf ?? null : source === 'cache' ? usableSeed?.asOf ?? null : null

  useEffect(() => {
    if (rollupKpis) writeSeed(rangeKey, { from: win.from, kpis: rollupKpis, asOf: rollup?.asOf ?? null, savedAt: Date.now() })
  }, [rollupKpis, rollup, rangeKey, win.from])

  const lastJson = useRef<{ key: DateRangeKey; json: string } | null>(null)
  const [flips, setFlips] = useState(0)
  useEffect(() => {
    if (!kpis) return
    const json = JSON.stringify(kpis)
    const prev = lastJson.current
    lastJson.current = { key: rangeKey, json }
    if (prev && prev.key === rangeKey && prev.json !== json) setFlips((n) => n + 1)
  }, [kpis, rangeKey])

  const stale = rollupKpis ? rollup?.stale === true : source === 'cache' && usableSeed ? seedBox.stale : false
  const state: LegacyKpiState = !kpis ? 'loading' : stale ? 'stale' : 'ready'
  return { kpis, state, source, asOf, flips }
}
