/**
 * One read, re-run on the 60 s TMS clock while the tab is visible. State writes live in an
 * explicit promise chain (`react-hooks/set-state-in-effect` cannot see through `async`).
 */
import { useCallback, useEffect, useState } from 'react'

const POLL_MS = 60_000

export interface Polled<T> {
  data: T | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/** `read` must be stable (useCallback); `null` disables the read. */
export function usePolled<T>(read: (() => Promise<T>) | null): Polled<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(read !== null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!read) return Promise.resolve()
    return read()
      .then((v) => { setData(v); setError(null) })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : 'Could not load') })
      .finally(() => setLoading(false))
  }, [read])

  useEffect(() => {
    if (!read) return
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, POLL_MS)
    return () => clearInterval(t)
  }, [read, load])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])
  return { data: read ? data : null, loading, error, refresh }
}
