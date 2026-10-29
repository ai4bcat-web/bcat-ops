/**
 * Every staff login, for the rep and team pickers.
 *
 * `UserProfile` is readable by any authenticated user precisely because this hook feeds
 * the pickers on the order, customer and carrier forms. The list barely moves, so the
 * poll is five minutes rather than the boards' sixty seconds, and a backend that
 * predates step I's deploy answers with no staff instead of failing the page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listUserProfiles } from '@/lib/apiClient'
import { displayName } from '@/lib/roles'
import type { UserProfileRecord } from '@/types/tms'

const POLL_MS = 300_000

export interface Staff {
  staff: UserProfileRecord[]
  byId: Record<string, UserProfileRecord>
  /** The name to print for a rep id, falling back to the id's own e-mail rule. */
  nameOf: (id: string | null | undefined) => string
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useStaff(): Staff {
  const [staff, setStaff] = useState<UserProfileRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useOpenIncidents` uses.
  const load = useCallback(() => listUserProfiles()
    .then((rows) => {
      setStaff([...rows].sort((a, b) => displayName(a).localeCompare(displayName(b))))
      setError(null)
    })
    .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Staff failed to load') })
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

  const byId = useMemo(() => {
    const map: Record<string, UserProfileRecord> = {}
    for (const p of staff) map[p.id] = p
    return map
  }, [staff])

  // A rep field may hold a username nobody has a profile for (a free-text value typed
  // before step I, or a deleted login): print the e-mail rule rather than nothing.
  const nameOf = useCallback(
    (id: string | null | undefined) => (id ? displayName(byId[id] ?? id) : '—'),
    [byId],
  )

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { staff, byId, nameOf, loading, error, refresh }
}
