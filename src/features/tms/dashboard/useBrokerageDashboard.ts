/**
 * The one read behind `/tms/dashboard`.
 *
 * Ten reads, in parallel, once per pickup window: the window's shipments (month index, voided
 * filtered server-side) and the open-work set with their orders, board loads and carrier legs
 * joined by id, the window's priced samples and quotes (by month, through `reportsClient`'s
 * month cache), the outstanding AR and AP, the staff profiles for rep names and the division tree
 * for division names. The bundle is memoised for five minutes per window, so changing a division
 * chip or a group-by is instant — those filters are applied in `applyFilters`, not re-fetched.
 *
 * A month the backend refuses is reported, never faked: `failedMonths` is non-empty and
 * the page says which months are missing from the numbers on screen.
 */
import { useCallback, useEffect, useState } from 'react'
import { listOpenBills, listOpenInvoices, listOwnershipDivisions, listUserProfiles } from '@/lib/apiClient'
import { loadBoardBundle, type BoardBundle } from '@/lib/boardData'
import { cachedList, invalidateLists } from '@/lib/listCache'
import { monthsCovering, mergeShipmentSets } from '@/lib/shipmentWindows'
import { clearReportCache, loadQuotes, loadSamples, type FailedMonth } from '@/lib/reportsClient'
import { hydrateLoads } from '@/lib/dashboardCharts'
import type { DashboardData, DashboardFilters } from './types'

const TTL_MS = 5 * 60 * 1000
const CACHE_PREFIX = 'board:dashboard:'

export interface DashboardBundle {
  data: DashboardData
  failedMonths: FailedMonth[]
}

/** Drop every memoised window. The refresh button and the tests are the callers. */
export function clearDashboardCache(): void {
  invalidateLists(CACHE_PREFIX)
}

/** The rows of every set, one per id (the first set that holds an id wins; the sets read the same rows). */
function unionById<T extends { id: string }>(...sets: T[][]): T[] {
  const byId = new Map<string, T>()
  for (const set of sets) for (const row of set) if (!byId.has(row.id)) byId.set(row.id, row)
  return [...byId.values()]
}

/**
 * One window's data: the shipments picking up in the window (±1 month, the UTC-vs-local month edge;
 * `applyFilters` then cuts to the exact days) plus the open-work set, which the live strips read
 * whatever the window is. Joined tables come with them by id, so the work grows with the window and
 * with open work, never with the table.
 */
async function readWindow(from: string, to: string, onPartial: (b: DashboardBundle) => void): Promise<DashboardBundle> {
  const months = monthsCovering(from, to, 1)
  // The working set lands in two steps (open rows joined, then the delivered backlog). The first
  // step is enough to draw the page; the second replaces it. A loader that never reports a partial
  // resolves this with its final bundle.
  let firstWorking!: (b: BoardBundle) => void
  const workingFirst = new Promise<BoardBundle>((resolve) => { firstWorking = resolve })
  const workingFinal = loadBoardBundle({ kind: 'working' }, { onPartial: (b) => firstWorking(b) })
  let finished = false
  workingFinal.then((b) => { finished = true; firstWorking(b) }, () => {})
  const [windowed, samples, quotes, openInvoices, openBills, profiles, divisions] = await Promise.all([
    loadBoardBundle({ kind: 'window', months }),
    loadSamples(from, to),
    loadQuotes(from, to),
    listOpenInvoices(),
    listOpenBills(),
    listUserProfiles(),
    listOwnershipDivisions(),
  ])
  const rest = { samples, quotes, openInvoices, openBills, profiles, divisions }
  const first = await workingFirst
  if (finished) return assemble(windowed, await workingFinal, rest) // final already landed: nothing partial to show
  onPartial(assemble(windowed, first, rest))
  return assemble(windowed, await workingFinal, rest)
}

interface WindowRest {
  samples: Awaited<ReturnType<typeof loadSamples>>
  quotes: Awaited<ReturnType<typeof loadQuotes>>
  openInvoices: Awaited<ReturnType<typeof listOpenInvoices>>
  openBills: Awaited<ReturnType<typeof listOpenBills>>
  profiles: Awaited<ReturnType<typeof listUserProfiles>>
  divisions: Awaited<ReturnType<typeof listOwnershipDivisions>>
}

function assemble(windowed: BoardBundle, working: BoardBundle, { samples, quotes, openInvoices, openBills, profiles, divisions }: WindowRest): DashboardBundle {
  const shipments = mergeShipmentSets(windowed.shipments, working.shipments)
  const loadCarriers = unionById(windowed.loadCarriers, working.loadCarriers)
  const data: DashboardData = {
    shipments,
    orders: unionById(windowed.orders, working.orders),
    loads: hydrateLoads(unionById(windowed.loads, working.loads), shipments, loadCarriers, samples.rows),
    loadCarriers,
    samples: samples.rows,
    openInvoices,
    openBills,
    quotes: quotes.rows,
    profiles,
    divisions,
    now: new Date().toISOString(),
  }
  return { data, failedMonths: [...samples.failedMonths, ...quotes.failedMonths] }
}

/** Mounted readers waiting on a window's first, partial bundle (the cache only keeps the final one). */
const partialListeners = new Map<string, Set<(b: DashboardBundle) => void>>()

function bundleFor(from: string, to: string): Promise<DashboardBundle> {
  const key = `${CACHE_PREFIX}${from}|${to}`
  return cachedList(key, () => readWindow(from, to, (b) => partialListeners.get(key)?.forEach((fn) => fn(b))), { ttlMs: TTL_MS })
}

export interface BrokerageDashboard {
  data: DashboardData | null
  loading: boolean
  error: string | null
  failedMonths: FailedMonth[]
  refresh: () => void
}

export function useBrokerageDashboard(filters: DashboardFilters): BrokerageDashboard {
  const { from, to } = filters
  const [reloadToken, setReloadToken] = useState(0)
  const key = `${from}|${to}|${reloadToken}`
  // What the last settled read produced, tagged with the key it answered; a key that
  // has not settled yet IS the loading state, so no effect writes state up front.
  const [settled, setSettled] = useState<{ key: string; bundle: DashboardBundle | null; error: string | null }>({
    key: '', bundle: null, error: null,
  })

  useEffect(() => {
    let live = true
    const listenKey = `${CACHE_PREFIX}${from}|${to}`
    const onPartial = (next: DashboardBundle) => { if (live) setSettled({ key, bundle: next, error: null }) }
    const listeners = partialListeners.get(listenKey) ?? new Set()
    listeners.add(onPartial)
    partialListeners.set(listenKey, listeners)
    bundleFor(from, to).then(
      (next) => { if (live) setSettled({ key, bundle: next, error: null }) },
      (err: unknown) => {
        if (!live) return
        setSettled({ key, bundle: null, error: err instanceof Error && err.message ? err.message : 'The dashboard could not be loaded' })
      },
    )
    return () => {
      live = false
      listeners.delete(onPartial)
      if (listeners.size === 0) partialListeners.delete(listenKey)
    }
  }, [from, to, key])

  const loading = settled.key !== key
  const bundle = settled.bundle
  const error = loading ? null : settled.error

  const refresh = useCallback(() => {
    invalidateLists('board:')
    clearReportCache()
    setReloadToken((token) => token + 1)
  }, [])

  return {
    data: bundle?.data ?? null,
    loading,
    error,
    failedMonths: bundle?.failedMonths ?? [],
    refresh,
  }
}
