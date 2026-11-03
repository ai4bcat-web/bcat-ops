/**
 * The ownership divisions every TMS surface needs: the sections the sidebar groups by.
 *
 * Both sidebars (the legacy BCAT rail and the MVMNT shell) mount at once, so the fetch
 * is shared in module scope: one request per 60 s poll however many components ask.
 * The read is not allowed to break the app — the table may not be deployed yet, so a
 * failure leaves divisions `null` (the caller falls back to the seeds).
 */
import { useCallback, useEffect, useReducer } from 'react'
import { listOwnershipDivisions } from '@/lib/apiClient'
import type { OwnershipDivisionRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface OwnershipDivisionsResult {
  /** `null` until the first read lands, and after a failed one. */
  divisions: OwnershipDivisionRecord[] | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

interface Shared {
  data: OwnershipDivisionRecord[] | null
  error: string | null
  loaded: boolean
  inflight: Promise<void> | null
  timer: number | null
  listeners: Set<() => void>
}

const store: Shared = { data: null, error: null, loaded: false, inflight: null, timer: null, listeners: new Set() }

function load(): Promise<void> {
  if (store.inflight) return store.inflight
  const run = listOwnershipDivisions()
    .then((rows) => { store.data = rows; store.error = null })
    .catch((err: unknown) => { store.error = err instanceof Error ? err.message : 'Divisions failed to load' })
    .finally(() => {
      store.inflight = null
      store.loaded = true
      for (const listener of store.listeners) listener()
    })
  store.inflight = run
  return run
}

/** Joins the shared fetch: first subscriber starts it and the 60 s poll behind it. */
function subscribe(listener: () => void): void {
  store.listeners.add(listener)
  if (!store.loaded && !store.inflight) void load()
  if (store.timer === null) {
    store.timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void load()
    }, POLL_MS)
  }
}

/** Last subscriber out stops the poll; a page with no TMS rail does not keep fetching. */
function unsubscribe(listener: () => void): void {
  store.listeners.delete(listener)
  if (store.listeners.size === 0 && store.timer !== null) {
    window.clearInterval(store.timer)
    store.timer = null
  }
}

/**
 * The ownership divisions. `null` means "not known yet" — the sidebar renders the seed
 * divisions in that case rather than an empty rail. An empty table says the same thing:
 * before the seed action has run (or before the model is deployed) the read answers with
 * no rows, and a sidebar with no sections is not what that means.
 */
export function useOwnershipDivisions(): OwnershipDivisionsResult {
  const [, bump] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    subscribe(bump)
    return () => unsubscribe(bump)
  }, [bump])

  const refresh = useCallback(() => load(), [])
  const { data } = store
  return { divisions: data && data.length > 0 ? data : null, loading: !store.loaded, error: store.error, refresh }
}
