/**
 * Every AI run whose exception is still open — the AI agents column of the Errors tab.
 *
 * The sparse `exceptionOpen` index means this reads only the rows that are actually
 * unresolved, so the sixty-second poll the rest of the Errors tab runs at costs one small
 * query. It only ticks while the tab is visible.
 */
import { useCallback, useEffect, useState } from 'react'
import { listWorkflowExceptions } from '@/lib/apiClient'
import type { WorkflowRunRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface WorkflowExceptions {
  runs: WorkflowRunRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useWorkflowExceptions(): WorkflowExceptions {
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useIntegrations` uses.
  const load = useCallback(() => listWorkflowExceptions()
    .then((next) => {
      setRuns(next)
      setError(null)
    })
    .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Workflow exceptions failed to load') })
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

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { runs, loading, error, refresh }
}
