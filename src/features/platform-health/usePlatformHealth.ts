/**
 * Everything the Platform health page reads, composed from the hooks the integrations
 * and Errors pages already use — plus the two freshness reads that have no hook
 * (Motive truck locations, OTR factoring status). A failed freshness read is "no
 * data", never an error banner: the page's own contract is to say what it cannot see.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listFactoringItems, listTruckLocations, validateIntegration } from '@/lib/apiClient'
import { useAppUpdate } from '@/hooks/useAppUpdate'
import { useIntegrations } from '@/hooks/useIntegrations'
import { useWorkflowExceptions } from '@/hooks/useWorkflowExceptions'
import { PROVIDERS } from '@/lib/integrations/registry'
import { latestOf, summarizeIntegrations, syncRows } from '@/lib/platformHealth'
import { BUILD } from '@/lib/buildInfo'
import type { BuildInfo } from '@/lib/buildInfo'
import type { IntegrationSummary, SyncRow } from '@/lib/platformHealth'
import type { WorkflowRunRecord } from '@/types/tms'

const TICK_MS = 60_000

export interface ErrorGroup {
  agent: string
  count: number
}

export interface PlatformHealthData {
  build: BuildInfo
  nowMs: number
  summary: IntegrationSummary
  sync: SyncRow[]
  integrationsLoading: boolean
  integrationsError: string | null
  errorRuns: WorkflowRunRecord[]
  errorsNewest: WorkflowRunRecord[]
  errorGroups: ErrorGroup[]
  errorsLoading: boolean
  errorsError: string | null
  updateAvailable: boolean
  reload: () => void
  recheckingKey: string | null
  recheckError: string | null
  recheck: (provider: string) => Promise<void>
  refresh: () => Promise<void>
}

export function usePlatformHealth(): PlatformHealthData {
  const integrations = useIntegrations()
  const exceptions = useWorkflowExceptions()
  const update = useAppUpdate()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [truckLocationAt, setTruckLocationAt] = useState<string | null>(null)
  const [otrSyncedAt, setOtrSyncedAt] = useState<string | null>(null)
  const [recheckingKey, setRecheckingKey] = useState<string | null>(null)
  const [recheckError, setRecheckError] = useState<string | null>(null)

  // Non-async on purpose (`react-hooks/set-state-in-effect`): state writes sit in an
  // explicit promise chain, the same shape `useIntegrations` uses.
  const loadSources = useCallback(() => Promise.allSettled([listTruckLocations(), listFactoringItems()])
    .then(([locations, factoring]) => {
      setTruckLocationAt(locations.status === 'fulfilled' ? latestOf(locations.value.map((l) => l.updatedAt)) : null)
      setOtrSyncedAt(factoring.status === 'fulfilled' ? latestOf(factoring.value.map((i) => i.otrStatusSyncedAt)) : null)
      setNowMs(Date.now())
    }), [])

  useEffect(() => {
    void loadSources()
    const t = setInterval(() => setNowMs(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [loadSources])

  const summary = useMemo(
    () => summarizeIntegrations(integrations.rows, PROVIDERS),
    [integrations.rows],
  )
  const sync = useMemo(() => syncRows({
    nowMs,
    devPaused: BUILD.isDev,
    integrations: integrations.rows,
    descriptors: PROVIDERS,
    truckLocationAt,
    otrSyncedAt,
  }), [nowMs, integrations.rows, truckLocationAt, otrSyncedAt])

  const { newest, groups } = useMemo(() => {
    const stamp = (r: WorkflowRunRecord) => Date.parse(r.receivedAt ?? r.updatedAt ?? r.createdAt ?? '') || 0
    const sorted = [...exceptions.runs].sort((a, b) => stamp(b) - stamp(a))
    const counts = new Map<string, number>()
    for (const r of sorted) counts.set(r.agent, (counts.get(r.agent) ?? 0) + 1)
    return {
      newest: sorted.slice(0, 5),
      groups: [...counts].map(([agent, count]): ErrorGroup => ({ agent, count })).sort((a, b) => b.count - a.count),
    }
  }, [exceptions.runs])

  const { refresh: refreshIntegrations } = integrations
  const { refresh: refreshExceptions } = exceptions
  const refresh = useCallback(
    () => Promise.all([refreshIntegrations(), refreshExceptions(), loadSources()]).then(() => undefined),
    [refreshIntegrations, refreshExceptions, loadSources],
  )

  /** The existing live credential check; performs a real call, so only a click starts it. */
  const recheck = useCallback(async (provider: string) => {
    setRecheckingKey(provider)
    setRecheckError(null)
    try {
      await validateIntegration(provider)
      await refreshIntegrations()
    } catch (err) {
      setRecheckError(err instanceof Error ? err.message : 'Re-check failed')
    } finally {
      setRecheckingKey(null)
    }
  }, [refreshIntegrations])

  return {
    build: BUILD,
    nowMs,
    summary,
    sync,
    integrationsLoading: integrations.loading,
    integrationsError: integrations.error,
    errorRuns: exceptions.runs,
    errorsNewest: newest,
    errorGroups: groups,
    errorsLoading: exceptions.loading,
    errorsError: exceptions.error,
    updateAvailable: update.available,
    reload: update.reload,
    recheckingKey,
    recheckError,
    recheck,
    refresh,
  }
}
