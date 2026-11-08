/**
 * Every unresolved incident, newest first.
 *
 * `incidentOpen` is a sparse GSI key — literally `'OPEN'` while an incident is open and
 * absent once it is resolved — so this query reads the exceptions and nothing else. Same
 * 60 s poll as the rest of the tracking surface.
 */
import { useCallback, useEffect, useState } from 'react'
import { listOpenIncidents } from '@/lib/apiClient'
import type { LoadCheckCallRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface OpenIncidents {
  incidents: LoadCheckCallRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useOpenIncidents(opts?: { enabled?: boolean }): OpenIncidents {
  const enabled = opts?.enabled ?? true
  const [incidents, setIncidents] = useState<LoadCheckCallRecord[]>([])
  // Same as the worklist: a disabled caller never fetches, so it starts "not loading"
  // instead of writing state inside the effect.
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useDirectory` uses.
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve()
    return listOpenIncidents()
      .then((rows) => { setIncidents(rows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Exceptions failed to load') })
      .finally(() => setLoading(false))
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [enabled, load])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { incidents, loading, error, refresh }
}
