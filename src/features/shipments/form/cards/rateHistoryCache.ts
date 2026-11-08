/** One read per key for 60 s, shared by every mount of the Rate history card. */
const CACHE_MS = 60_000

const entries = new Map<string, { at: number; value: Promise<unknown> }>()

/** Forget one key (Retry) or, with no key, every read (tests). */
export function clearRateHistoryCache(key?: string): void {
  if (key === undefined) entries.clear()
  else entries.delete(key)
}

export function cachedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>
  const value = load()
  entries.set(key, { at: Date.now(), value })
  // A failed read is never remembered: Retry and the next change must ask again.
  value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key) })
  return value
}
