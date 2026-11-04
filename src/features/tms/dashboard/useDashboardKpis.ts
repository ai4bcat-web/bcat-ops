/**
 * The KPI strip's state machine (Step AF).
 *
 *   mount → memory / sessionStorage seed  → paint            data-source="cache"
 *         → rollup read (one AppSync call) → paint            data-source="rollup"
 *         → unusable rollup, facet filter or Refresh → exact  data-source="live"
 *
 * The rollup is usable only while it is complete, current and of a known schema (see
 * `windowFromRows`); a facet filter (mode, status, customer, carrier, rep) is not in it at all.
 * Once the rollup has painted, the exact bundle landing later never changes the numbers: the
 * charts below show live data and the page says so. Only Refresh, a filter change or a window
 * change re-derives them. `ready` means the numbers are final for the filters on screen.
 */
import { useEffect, useMemo, useState } from 'react'
import { listOwnershipDivisions } from '@/lib/apiClient'
import { cachedList } from '@/lib/listCache'
import { SEED_DIVISIONS } from '@/lib/ownership'
import { stripsFromRollup, type DivisionInput, type RollupWindow } from '@/lib/dashboardRollup'
import {
  ROLLUP_STALE_MS, fetchRollup, peekRollup, peekRollupDivisions, rollupAsOfMs, saveRollupDivisions,
} from '@/lib/dashboardRollupClient'
import { buildBusinessStrips, buildCompanyTotals, rollupBusinessStrips, type BusinessStrip, type CompanyTotals } from './businessStrips'
import type { DashboardData, DashboardFilters } from './types'

export type KpiSource = 'cache' | 'rollup' | 'live'
export type KpiState = 'loading' | 'ready' | 'stale'

export interface DashboardKpis {
  state: KpiState
  source: KpiSource | null
  /** ISO time of the oldest row the figures stand for (`rollup` and `cache` only). */
  asOf: string | null
  strips: BusinessStrip[]
  totals: CompanyTotals | null
  /** The division tree the strips were built from (seeded, so the chip has options before the charts load). */
  divisions: DivisionInput[] | null
}

/** Facets the rollup does not carry: any of them set means the exact path. */
export function hasFacetFilter(f: Pick<DashboardFilters, 'mode' | 'status' | 'customerId' | 'carrierId' | 'repId'>): boolean {
  return Boolean(f.mode || f.status || f.customerId || f.carrierId || f.repId)
}

const EMPTY: DashboardKpis = { state: 'loading', source: null, asOf: null, strips: [], totals: null, divisions: null }

function fromRollup(window: RollupWindow, filters: DashboardFilters, divisions: DivisionInput[]): Pick<DashboardKpis, 'strips' | 'totals'> {
  const { strips, totals } = stripsFromRollup(window, filters, divisions)
  return { strips: strips as BusinessStrip[], totals }
}

interface ExactRead {
  data: DashboardData | null
  /** The final bundle (a partial first draw does not count). */
  final: boolean
  error: string | null
}

export function useDashboardKpis(filters: DashboardFilters, exact: ExactRead, forceLive: boolean): DashboardKpis {
  const { from, to } = filters
  const eligible = !forceLive && !hasFacetFilter(filters)
  const key = `${from}|${to}`
  // The stale label follows the clock; the figures never do.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const peeked = useMemo(
    () => (eligible ? peekRollup(from, to) : null),
    [eligible, from, to],
  )
  const seededDivisions = useMemo(() => peekRollupDivisions(), [])

  const [fetched, setFetched] = useState<{ key: string; window: RollupWindow | null } | null>(null)
  const [fetchedDivisions, setFetchedDivisions] = useState<DivisionInput[] | null>(null)

  useEffect(() => {
    if (!eligible) return
    let live = true
    fetchRollup(from, to).then(
      (window) => { if (live) setFetched({ key, window }) },
      () => { if (live) setFetched({ key, window: null }) },
    )
    cachedList('rollup:divisions', () => listOwnershipDivisions(), { ttlMs: 60_000, staleMs: 600_000 }).then(
      (rows) => {
        if (!live) return
        const divisions = rows.length > 0 ? rows : SEED_DIVISIONS
        saveRollupDivisions(rows)
        setFetchedDivisions(divisions)
      },
      () => { if (live) setFetchedDivisions(SEED_DIVISIONS) },
    )
    return () => { live = false }
  }, [eligible, from, to, key])

  const rollupWindow = fetched?.key === key ? fetched.window : undefined // undefined: still reading
  const window = rollupWindow ?? (rollupWindow === undefined ? peeked : null)
  const windowSource: KpiSource = rollupWindow ? 'rollup' : 'cache'
  const divisions = fetchedDivisions ?? seededDivisions ?? (exact.data && exact.data.divisions.length > 0 ? exact.data.divisions : null)

  return useMemo<DashboardKpis>(() => {
    if (eligible && window) {
      if (!divisions) return EMPTY
      const asOfMs = rollupAsOfMs(window)
      return {
        state: now - asOfMs > ROLLUP_STALE_MS ? 'stale' : 'ready',
        source: windowSource,
        asOf: new Date(asOfMs).toISOString(),
        divisions,
        ...fromRollup(window, filters, divisions),
      }
    }
    // Exact path: only when the rollup cannot serve (facet, refresh, unusable) and only once final.
    const rollupGaveUp = !eligible || rollupWindow === null
    if (!rollupGaveUp) return EMPTY
    if (exact.error && !exact.data) return { state: 'ready', source: 'live', asOf: null, strips: [], totals: null, divisions }
    if (!exact.data || !exact.final) return EMPTY
    const exactDivisions = exact.data.divisions.length > 0 ? exact.data.divisions : SEED_DIVISIONS
    return {
      state: 'ready',
      source: 'live',
      asOf: null,
      strips: rollupBusinessStrips(buildBusinessStrips(exact.data, filters, exactDivisions)),
      totals: buildCompanyTotals(exact.data, filters),
      divisions: exactDivisions,
    }
  }, [eligible, window, windowSource, rollupWindow, divisions, exact.data, exact.final, exact.error, filters, now])
}
