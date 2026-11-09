import { useEffect, useMemo, useState } from 'react'
import { listOwnershipDivisions, listUserProfiles } from '@/lib/apiClient'
import { fetchRollup } from '@/lib/dashboardRollupClient'
import { fetchBrokerageRepRollup } from '@/lib/brokerageRepRollupClient'
import type { MonthPayload, RollupRow } from '@/lib/dashboardRollup'
import { SEED_DIVISIONS } from '@/lib/ownership'
import { displayName } from '@/lib/roles'
import type { DivisionShape, RepMonth, RepNames } from '@/lib/brokerageRevenue'

export type BrokerageState = 'loading' | 'ready' | 'unavailable' | 'error'

export interface BrokerageData {
  state: BrokerageState
  /** ALL = every rep (company figures); OWN = the caller's own rep row only (the server filtered the rest out). */
  scope: 'ALL' | 'OWN'
  /** The DashboardRollup month rows read (company totals; used for the month view when scope is ALL). */
  rows: RollupRow<MonthPayload>[]
  /** The private per-rep months from the Brokerage action, already filtered for the caller by the server. */
  repMonths: RepMonth[]
  divisions: DivisionShape[]
  names: RepNames
  /** ISO time of the oldest hot row behind the figures. */
  asOf: string | null
}

const EMPTY_NAMES: RepNames = { byId: new Map() }

interface Loaded {
  key: string
  state: BrokerageState
  scope: 'ALL' | 'OWN'
  rows: RollupRow<MonthPayload>[]
  repMonths: RepMonth[]
  asOf: string | null
}

/**
 * The Brokerage figures for `from`..`to` (`YYYY-MM`): the DashboardRollup month rows (company totals), the per-rep
 * months from the caller-filtered action, the division tree and the staff names. A caller whose scope is OWN never
 * reads the company rows: their month view is summed from their own rep rows.
 * `unavailable` = the rollup cannot be trusted right now (a row missing, empty, stale or of another schema: the
 * same guard the other dashboards use), so the page says so instead of drawing zeros.
 */
export function useBrokerageDashboard(from: string, to: string): BrokerageData {
  const [result, setResult] = useState<Loaded | null>(null)
  const [divisions, setDivisions] = useState<DivisionShape[]>(SEED_DIVISIONS)
  const [names, setNames] = useState<RepNames>(EMPTY_NAMES)
  const key = `${from}|${to}`

  useEffect(() => {
    let alive = true
    const done = (r: Omit<Loaded, 'key'>) => { if (alive) setResult({ key, ...r }) }
    fetchBrokerageRepRollup(from, to)
      .then(async (rep) => {
        const repMonths = rep.months.map((m) => ({ month: m.month, rep: m.rep }))
        const stamps = rep.months.map((m) => Date.parse(m.computedAt)).filter(Number.isFinite)
        const asOf = stamps.length ? new Date(Math.min(...stamps)).toISOString() : null
        if (rep.scope === 'OWN') { done({ state: 'ready', scope: 'OWN', rows: [], repMonths, asOf }); return }
        const window = await fetchRollup(`${from}-01`, `${to}-28`)
        if (!window) { done({ state: 'unavailable', scope: 'ALL', rows: [], repMonths: [], asOf: null }); return }
        done({ state: 'ready', scope: 'ALL', rows: window.months, repMonths, asOf })
      })
      .catch(() => done({ state: 'error', scope: 'ALL', rows: [], repMonths: [], asOf: null }))
    return () => { alive = false }
  }, [from, to, key])

  useEffect(() => {
    let alive = true
    listOwnershipDivisions()
      .then((rows) => { if (alive && rows.length > 0) setDivisions(rows) })
      .catch(() => { /* seeded tree stays */ })
    listUserProfiles()
      .then((rows) => { if (alive) setNames({ byId: new Map(rows.map((p) => [p.id, displayName(p)])) }) })
      .catch(() => { /* ids are shown until the names arrive */ })
    return () => { alive = false }
  }, [])

  return useMemo(() => {
    const current = result && result.key === key ? result : null
    return {
      state: current?.state ?? 'loading', scope: current?.scope ?? 'ALL', rows: current?.rows ?? [],
      repMonths: current?.repMonths ?? [], divisions, names, asOf: current?.asOf ?? null,
    }
  }, [result, key, divisions, names])
}
