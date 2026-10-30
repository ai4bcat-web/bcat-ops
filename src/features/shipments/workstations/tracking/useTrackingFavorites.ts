import { useCallback, useMemo, useState } from 'react'

const storageKey = (email: string) => `tms:tracking:favorites:${email ?? 'anon'}`

function read(email: string): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(storageKey(email))
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function write(email: string, ids: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(email), JSON.stringify(ids))
  } catch {
    // localStorage may be unavailable or full; favorites are not load-bearing.
  }
}

export function useTrackingFavorites(email?: string | null) {
  const [ids, setIds] = useState<string[]>(() => read(email ?? 'anon'))

  // Favorites are keyed by the signed-in email: when the account changes, swap
  // in that account's list during render rather than in an effect.
  const [prevEmail, setPrevEmail] = useState(email)
  if (prevEmail !== email) {
    setPrevEmail(email)
    setIds(read(email ?? 'anon'))
  }

  const toggle = useCallback(
    (id: string) => {
      setIds((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        write(email ?? 'anon', next)
        return next
      })
    },
    [email],
  )

  const favorites = useMemo(() => new Set(ids), [ids])

  return { favorites, toggleFavorite: toggle }
}
