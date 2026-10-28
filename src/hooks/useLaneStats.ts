/**
 * What a lane has actually paid: the Historical Rates panel's one source.
 *
 * Two index reads, in parallel: this exact lane, and the ZIP3 neighbourhood it sits in.
 * `laneFallback` then decides which set is the evidence — the exact lane whenever it has
 * any history at all, the neighbourhood only when it does not — so the badge above the
 * numbers can never let a ZIP3 average pass for the lane itself.
 *
 * The window is pushed into the query as a floor on the sort key rather than filtered in
 * the browser: a 90-day panel is 90 days off the wire, not the lane's whole life. The
 * other filters (equipment, rate type, own-fleet cost) are cheap and stay client-side,
 * so changing them re-renders without re-reading.
 *
 * Not polled. A lane's history is what has already delivered; nothing moves it while
 * somebody is pricing against it, and `refresh()` is there for the cases that do.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listLaneSamples, listLaneSamplesByZip3 } from '@/lib/apiClient'
import { laneFallback, laneStats } from '@/lib/laneStats'
import type { LaneRateSampleRecord, LaneStats, LaneStatsFilters, LaneStatsWindow, RateType } from '@/types/tms'

export interface LaneStatsData {
  stats: LaneStats
  /** Which set of samples the numbers came from. 'NONE' is an empty lane. */
  basis: 'EXACT' | 'ZIP3' | 'NONE'
  /** What the panel prints above the numbers, so nobody mistakes the basis. */
  badge: string
  /** The samples the statistics were computed over — the rows the panel lists. */
  samples: LaneRateSampleRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/** The sort-key floor for a window, in the samples' own 'YYYY-MM-DD' shape. */
function windowFloor(windowDays: LaneStatsWindow | undefined, nowMs: number): string | undefined {
  const window = windowDays ?? 'ALL'
  if (window === 'ALL') return undefined
  return new Date(nowMs - window * 86_400_000).toISOString().slice(0, 10)
}

export function useLaneStats(
  laneKey: string | null,
  laneKey3: string | null,
  filters: LaneStatsFilters = {},
): LaneStatsData {
  // Keyed on the filter fields, never on the object's identity: the panel passes a
  // literal, and an effect keyed on that would re-read on every render.
  const windowDays: LaneStatsWindow | undefined = filters.windowDays
  const equipmentType: string | null = filters.equipmentType ?? null
  const rateType: RateType | null = filters.rateType ?? null
  const includeOwnFleetCost = filters.includeOwnFleetCost ?? false

  const enabled = !!laneKey || !!laneKey3
  const [exact, setExact] = useState<LaneRateSampleRecord[]>([])
  const [zip3, setZip3] = useState<LaneRateSampleRecord[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain. Both
  // reads go out together — the fallback is decided once both have landed, and a lane
  // with history still pays for the ZIP3 read, which is the price of never flickering
  // from "no history" to a neighbourhood average as the second response arrives.
  const load = useCallback(() => {
    if (!laneKey && !laneKey3) return Promise.resolve()
    const from = windowFloor(windowDays, Date.now())
    return Promise.all([
      laneKey ? listLaneSamples(laneKey, from) : Promise.resolve<LaneRateSampleRecord[]>([]),
      laneKey3 ? listLaneSamplesByZip3(laneKey3, from) : Promise.resolve<LaneRateSampleRecord[]>([]),
    ])
      .then(([exactRows, zipRows]) => { setExact(exactRows); setZip3(zipRows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Lane history failed to load') })
      .finally(() => setLoading(false))
  }, [laneKey, laneKey3, windowDays])

  useEffect(() => {
    if (!enabled) return
    load()
  }, [enabled, load])

  const fallback = useMemo(
    () => laneFallback(exact, zip3, laneKey, laneKey3),
    [exact, zip3, laneKey, laneKey3],
  )

  // Computed against the moment of the render, not a fixed mount time: a panel left
  // open overnight must not keep reporting yesterday's window.
  const stats = useMemo(
    () => laneStats(fallback.samples, { windowDays, equipmentType, rateType, includeOwnFleetCost }, new Date().toISOString()),
    [fallback, windowDays, equipmentType, rateType, includeOwnFleetCost],
  )

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return {
    stats,
    basis: fallback.basis,
    badge: fallback.badge,
    samples: fallback.samples,
    loading,
    error,
    refresh,
  }
}
