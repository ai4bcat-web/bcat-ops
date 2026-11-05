/**
 * "Five most recently used first" for the Customer and Location type-aheads (Step AR, Smart
 * entry). Ids only, per user, in localStorage; a blocked or full store just means no recents.
 */
export const RECENT_LIMIT = 5
export type RecentKind = 'customer' | 'location'

const key = (kind: RecentKind, email: string) => `tms:ship-form:recent:${kind}:${email}`

export function readRecents(kind: RecentKind, email: string): string[] {
  try {
    const raw = localStorage.getItem(key(kind, email))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

/** Puts `id` first, drops a repeat, keeps five. Returns the new list. */
export function pushRecent(kind: RecentKind, email: string, id: string): string[] {
  const next = [id, ...readRecents(kind, email).filter((x) => x !== id)].slice(0, RECENT_LIMIT)
  try { localStorage.setItem(key(kind, email), JSON.stringify(next)) } catch { /* storage full or blocked */ }
  return next
}

/** `items` with the recently used ones first (in recency order), then the rest in their given order. */
export function recentFirst<T extends { id: string }>(items: readonly T[], recent: readonly string[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const head = recent.flatMap((id) => { const r = byId.get(id); return r ? [r] : [] })
  const seen = new Set(head.map((i) => i.id))
  return [...head, ...items.filter((i) => !seen.has(i.id))]
}
