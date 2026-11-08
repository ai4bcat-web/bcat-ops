/**
 * The AI agents' run log, newest first — the Agents tab and the per-party panels read it.
 *
 * A run only moves while the agent is working one, so sixty seconds is the same cadence the
 * boards poll at, and the timer only ticks while the tab is actually visible: a parked
 * Workflows tab must not keep a Lambda busy all afternoon.
 */
import { useCallback, useEffect, useState } from 'react'
import { listWorkflowRuns } from '@/lib/apiClient'
import type { WorkflowAgentKey, WorkflowRunRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface WorkflowRuns {
  runs: WorkflowRunRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/** Without an agent the server merges every agent's index into one newest-first list. */
export function useWorkflowRuns(agent?: WorkflowAgentKey): WorkflowRuns {
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useIntegrations` uses.
  const load = useCallback(() => listWorkflowRuns(agent)
    .then((next) => {
      setRuns(next)
      setError(null)
    })
    .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Workflow runs failed to load') })
    .finally(() => setLoading(false)), [agent])

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
