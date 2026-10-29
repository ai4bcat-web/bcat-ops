/**
 * Every integration row, for the Integrations tab and the provider pages.
 *
 * `LIST_INTEGRATIONS` creates the missing rows from the registry on its first call, so
 * this hook is also what seeds them — there is no migration. The list is as still as
 * the staff list (a health check moves one row), so the poll is five minutes rather
 * than the boards' sixty seconds, and it only ticks while the tab is actually visible.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listIntegrations } from '@/lib/apiClient'
import type { IntegrationRecord } from '@/lib/integrations/types'

const POLL_MS = 300_000

export interface Integrations {
  rows: IntegrationRecord[]
  /** Provider rows by provider key. API clients and webhook receipts are not in here. */
  byKey: Record<string, IntegrationRecord>
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useIntegrations(): Integrations {
  const [rows, setRows] = useState<IntegrationRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useStaff` uses.
  const load = useCallback(() => listIntegrations()
    .then((next) => {
      setRows(next)
      setError(null)
    })
    .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Integrations failed to load') })
    .finally(() => setLoading(false)), [])

  useEffect(() => {
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [load])

  const byKey = useMemo(() => {
    const map: Record<string, IntegrationRecord> = {}
    for (const row of rows) if (row.kind === 'PROVIDER') map[row.provider] = row
    return map
  }, [rows])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { rows, byKey, loading, error, refresh }
}
