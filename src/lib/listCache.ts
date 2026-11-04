// Module-level, per-tab-session list cache. One fetch per key: concurrent callers share
// the in-flight promise, fresh entries are returned as-is, stale-but-usable entries are
// returned immediately while exactly one background refresh runs. A rejected load is
// never cached. Any write by this tab clears the cache (see the apiClient mutation wrapper).

export interface CacheOpts {
  /** Fresh window: the cached value is returned without a request. */
  ttlMs: number
  /** Extra window after ttlMs in which the cached value is served now and refreshed in the background. */
  staleMs?: number
  /** Skip the cache and re-read (the in-flight promise is still shared). */
  force?: boolean
}

interface Entry {
  value: unknown
  hasValue: boolean
  at: number
  inflight: Promise<unknown> | null
}

const entries = new Map<string, Entry>()

function entryFor(key: string): Entry {
  let e = entries.get(key)
  if (!e) {
    e = { value: undefined, hasValue: false, at: 0, inflight: null }
    entries.set(key, e)
  }
  return e
}

function start<T>(key: string, e: Entry, load: () => Promise<T>): Promise<T> {
  if (e.inflight) return e.inflight as Promise<T>
  const p = load().then(
    (v) => {
      // invalidateLists deletes the entry, so a load that started before the write cannot repopulate it; a load for a key the
      // write did NOT match keeps its entry and is stored (a prefixed invalidation must not make unrelated reads refetch).
      if (entries.get(key) === e) {
        e.value = v
        e.hasValue = true
        e.at = Date.now()
      }
      if (e.inflight === p) e.inflight = null
      return v
    },
    (err) => {
      if (e.inflight === p) e.inflight = null
      throw err
    },
  )
  e.inflight = p
  return p
}

/**
 * `value` is the cached value when one is usable right now (fresh or stale); `fresh`
 * resolves with a value no older than ttlMs (the cached one when fresh, else the load).
 * A stale hit starts the background refresh itself; its rejection is swallowed there
 * (callers that await `fresh` still see it).
 */
export function readList<T>(
  key: string,
  load: () => Promise<T>,
  opts: CacheOpts,
): { value: T | undefined; fresh: Promise<T> } {
  const e = entryFor(key)
  const age = Date.now() - e.at
  if (!opts.force && e.hasValue && age < opts.ttlMs) {
    return { value: e.value as T, fresh: Promise.resolve(e.value as T) }
  }
  const usable = e.hasValue && (age < opts.ttlMs + (opts.staleMs ?? 0))
  const fresh = start(key, e, load)
  if (usable && !opts.force) {
    fresh.catch(() => {})
    return { value: e.value as T, fresh }
  }
  return { value: undefined, fresh }
}

/** The value, from cache when fresh or stale (stale refreshes in the background). */
export function cachedList<T>(key: string, load: () => Promise<T>, opts: CacheOpts): Promise<T> {
  const r = readList(key, load, opts)
  return r.value !== undefined ? Promise.resolve(r.value) : r.fresh
}

/** Drop entries whose key starts with `prefix` (all when omitted). In-flight loads are orphaned. */
export function invalidateLists(prefix?: string): void {
  for (const [key] of entries) {
    if (!prefix || key.startsWith(prefix)) entries.delete(key)
  }
}

/** Whatever is cached under `key` (any age), for `useState(() => peekList(key))`. */
export function peekList<T>(key: string): T | undefined {
  const e = entries.get(key)
  return e && e.hasValue ? (e.value as T) : undefined
}

/** Whatever is cached under `key` if it is younger than `ttlMs`; undefined otherwise. */
export function peekFresh<T>(key: string, ttlMs: number): T | undefined {
  const e = entries.get(key)
  return e && e.hasValue && Date.now() - e.at < ttlMs ? (e.value as T) : undefined
}

/** Seed `key` with a value produced elsewhere (a batch fetch). Cleared by `invalidateLists` like any entry. */
export function putList<T>(key: string, value: T): void {
  const e = entryFor(key)
  e.value = value
  e.hasValue = true
  e.at = Date.now()
}

/** Key prefix of the driver submission + document lists; a pod write (scan, assign, review) clears it with the rest. */
export const SUBMISSION_CACHE_PREFIX = 'driverSubmissions:'
