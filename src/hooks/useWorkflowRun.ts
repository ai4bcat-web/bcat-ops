/**
 * One run, for the trace page.
 *
 * A run that is still working redraws its step rail from this poll, so it ticks every three
 * seconds while the status is IN_PROGRESS and drops back to thirty once it has settled —
 * a finished run only changes when a person dismisses it or leaves feedback. Both timers
 * only run while the tab is visible.
 */
import { useCallback, useEffect, useState } from 'react'
import { getWorkflowRun } from '@/lib/apiClient'
import type { WorkflowRunRecord } from '@/types/tms'

const LIVE_POLL_MS = 3_000
const SETTLED_POLL_MS = 30_000

export interface WorkflowRunState {
  run: WorkflowRunRecord | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/** `id` is null while the route has no run selected; nothing is read until it has one. */
export function useWorkflowRun(id: string | null): WorkflowRunState {
  const [run, setRun] = useState<WorkflowRunRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useIntegrations` uses.
  const load = useCallback(() => {
    if (!id) {
      // Deferred rather than written here: `load()` is called straight from an effect
      // body, and a synchronous setState there is a cascading render.
      return Promise.resolve().then(() => {
        setRun(null)
        setError(null)
        setLoading(false)
      })
    }
    return getWorkflowRun(id)
      .then((next) => {
        setRun(next)
        setError(null)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Workflow run failed to load') })
      .finally(() => setLoading(false))
  }, [id])

  // The cadence is part of the timer's dependency list so the interval re-arms the moment
  // a run starts or finishes, instead of staying on whichever cadence the page opened
  // with. That is also why the first read is its own effect: re-arming the timer must not
  // fire a second read of a run that was just fetched.
  const pollMs = run?.status === 'IN_PROGRESS' ? LIVE_POLL_MS : SETTLED_POLL_MS

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!id) return
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    const t = setInterval(() => { if (alive) tick() }, pollMs)
    return () => { alive = false; clearInterval(t) }
  }, [load, pollMs, id])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { run, loading, error, refresh }
}
