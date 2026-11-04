import { useCallback, useEffect, useState } from 'react'
import { dashboardPreview, type DashboardRunTarget } from '@/lib/apiClient'
import type { DashRunResult } from '@/lib/dashboards/types'

export interface DashboardRun {
  result: DashRunResult | null
  loading: boolean
  error: string | null
  reload: () => void
}

interface Done { req: string; result: DashRunResult | null; error: string | null }

/** Runs a dashboard on the server (the caller's own visibility applies there). `null` target = idle. */
export function useDashboardRun(target: DashboardRunTarget | null): DashboardRun {
  const key = target ? JSON.stringify(target) : null
  const [tick, setTick] = useState(0)
  const [done, setDone] = useState<Done | null>(null)
  const req = `${key}#${tick}`

  useEffect(() => {
    if (key === null) return
    let live = true
    dashboardPreview(JSON.parse(key) as DashboardRunTarget).then(
      (result) => { if (live) setDone({ req, result, error: null }) },
      (e: unknown) => { if (live) setDone({ req, result: null, error: e instanceof Error ? e.message : 'Could not run the dashboard.' }) },
    )
    return () => { live = false }
  }, [key, req])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  // An answer belongs to one (target, reload) pair: anything else is "still loading", never a stale grid.
  const current = done?.req === req ? done : null
  return { result: current?.result ?? null, loading: key !== null && current === null, error: current?.error ?? null, reload }
}
