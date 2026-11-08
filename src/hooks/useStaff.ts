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
  /**
   * The row of the e-mail passed in, or null when none was passed or the list has not
   * landed. The signed-in user's own profile carries settings a page needs about the
   * person at the keyboard — the divisions a saved Shipment view is matched against —
   * and this hook already holds every row, so there is nothing to fetch for it. The
   * e-mail is an argument rather than a context read because the pickers that built
   * this hook render in places that have no auth context at all.
   */
  me: UserProfileRecord | null
  /** The name to print for a rep id, falling back to the id's own e-mail rule. */
  nameOf: (id: string | null | undefined) => string
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useStaff(myEmail?: string | null): Staff {
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

  // The row id IS the Cognito username, which is the e-mail for everybody invited
  // through the Users page — but a login created before that is matched on its e-mail
  // too, and case never decides whether somebody finds their own profile.
  const myKey = (myEmail ?? '').trim().toLowerCase()
  const me = useMemo(() => {
    if (myKey === '') return null
    return staff.find((p) => p.id.toLowerCase() === myKey || (p.email ?? '').toLowerCase() === myKey) ?? null
  }, [staff, myKey])

  // A rep field may hold a username nobody has a profile for (a free-text value typed
  // before step I, or a deleted login): print the e-mail rule rather than nothing.
  const nameOf = useCallback(
    (id: string | null | undefined) => (id ? displayName(byId[id] ?? id) : '—'),
    [byId],
  )

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { staff, byId, me, nameOf, loading, error, refresh }
}
