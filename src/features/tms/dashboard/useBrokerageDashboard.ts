/**
 * The one read behind `/tms/dashboard`.
 *
 * Ten reads, in parallel, once per pickup window: the shipments and their orders, the
 * board loads and every carrier leg, the window's priced samples and quotes (by month,
 * through `reportsClient`'s month cache), the outstanding AR and AP, the staff profiles
 * for rep names and the division tree for division names. The bundle is memoised for
 * five minutes per window, so changing a division chip or a group-by is instant — those
 * filters are applied in `applyFilters`, not re-fetched.
 *
 * A month the backend refuses is reported, never faked: `failedMonths` is non-empty and
 * the page says which months are missing from the numbers on screen.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  listLoadCarriers,
  listLoadSummaries,
  listOpenBills,
  listOpenInvoices,
  listOrders,
  listOwnershipDivisions,
  listShipments,
  listUserProfiles,
} from '@/lib/apiClient'
import { clearReportCache, loadQuotes, loadSamples, type FailedMonth } from '@/lib/reportsClient'
import { hydrateLoads } from '@/lib/dashboardCharts'
import type { DashboardData, DashboardFilters } from './types'

const TTL_MS = 5 * 60 * 1000

export interface DashboardBundle {
  data: DashboardData
  failedMonths: FailedMonth[]
}

interface CacheEntry {
  at: number
  pending: Promise<DashboardBundle>
}

const windowCache = new Map<string, CacheEntry>()

/** Drop every memoised window. The refresh button and the tests are the callers. */
export function clearDashboardCache(): void {
  windowCache.clear()
}

async function readWindow(from: string, to: string): Promise<DashboardBundle> {
  const [shipments, orders, summaries, loadCarriers, samples, quotes, openInvoices, openBills, profiles, divisions] =
    await Promise.all([
      listShipments(),
      listOrders(),
      listLoadSummaries(),
      listLoadCarriers(),
      loadSamples(from, to),
      loadQuotes(from, to),
      listOpenInvoices(),
      listOpenBills(),
      listUserProfiles(),
      listOwnershipDivisions(),
    ])
  const data: DashboardData = {
    shipments,
    orders,
    loads: hydrateLoads(summaries, shipments, loadCarriers, samples.rows),
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

function bundleFor(from: string, to: string): Promise<DashboardBundle> {
  const key = `${from}|${to}`
  const cached = windowCache.get(key)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.pending
  const pending = readWindow(from, to).catch((err: unknown) => {
    windowCache.delete(key)
    throw err
  })
  windowCache.set(key, { at: Date.now(), pending })
  return pending
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
    bundleFor(from, to).then(
      (next) => { if (live) setSettled({ key, bundle: next, error: null }) },
      (err: unknown) => {
        if (!live) return
        setSettled({ key, bundle: null, error: err instanceof Error && err.message ? err.message : 'The dashboard could not be loaded' })
      },
    )
    return () => { live = false }
  }, [from, to, key])

  const loading = settled.key !== key
  const bundle = settled.bundle
  const error = loading ? null : settled.error

  const refresh = useCallback(() => {
    windowCache.delete(`${from}|${to}`)
    clearReportCache()
    setReloadToken((token) => token + 1)
  }, [from, to])

  return {
    data: bundle?.data ?? null,
    loading,
    error,
    failedMonths: bundle?.failedMonths ?? [],
    refresh,
  }
}
