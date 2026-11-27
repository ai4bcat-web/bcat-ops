/** A page chunk that no longer exists because the app was deployed while this tab was open. */
const CHUNK_ERROR = /dynamically imported module|importing a module script failed|failed to fetch dynamically|ChunkLoadError|Loading chunk .* failed|error loading dynamically/i
const RELOAD_KEY = 'bcat:chunkReloadAt'
const RELOAD_GUARD_MS = 60_000

export function isChunkLoadError(error: unknown): boolean {
  return CHUNK_ERROR.test(String((error as { message?: string } | null)?.message ?? error ?? ''))
}

/** Reload once for a stale chunk. False when it already did within the guard window (then the caller shows the message). */
export function reloadForStaleChunk(now: number = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (last && now - last < RELOAD_GUARD_MS) return false
    window.sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch { /* storage blocked: still reload once; the browser keeps the loop short */ }
  window.location.reload()
  return true
}
