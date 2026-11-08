import { useState } from 'react'

export interface RecentShipment {
  id: string
  number: string
  at: string
}

const KEY = (email: string) => `tms:tracking:recent:${email ?? 'anon'}`
const MAX = 10

function read(email: string): RecentShipment[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY(email))
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed)
      ? parsed.filter((r): r is RecentShipment => r && typeof r.id === 'string' && typeof r.number === 'string')
      : []
  } catch {
    return []
  }
}

function write(email: string, rows: RecentShipment[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY(email), JSON.stringify(rows.slice(0, MAX)))
  } catch {
    // Recent items are a convenience, not a requirement.
  }
}

export function useRecentlyViewed(email?: string | null) {
  const [recent, setRecent] = useState<RecentShipment[]>(() => read(email ?? 'anon'))

  // The list is keyed by the signed-in email: when the account changes, swap in
  // that account's list during render rather than in an effect.
  const [prevEmail, setPrevEmail] = useState(email)
  if (prevEmail !== email) {
    setPrevEmail(email)
    setRecent(read(email ?? 'anon'))
  }

  return {
    recent,
    push: (id: string, number: string) => {
      const next = [{ id, number, at: new Date().toISOString() }, ...read(email ?? 'anon').filter((r) => r.id !== id)]
      write(email ?? 'anon', next)
      setRecent(next)
    },
    remove: (id: string) => {
      const next = read(email ?? 'anon').filter((r) => r.id !== id)
      write(email ?? 'anon', next)
      setRecent(next)
    },
  }
}
