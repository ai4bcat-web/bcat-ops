/**
 * The two taxonomy reads every TMS surface needs: the divisions the sidebar groups by,
 * and the saved Shipment views it lists.
 *
 * Both sidebars (the legacy BCAT rail and the MVMNT shell) mount at once, so the fetch
 * is shared in module scope: one request per 60 s poll however many components ask.
 * Neither read is allowed to break the app — the tables may not be deployed yet, so a
 * failure leaves divisions `null` (the caller falls back to the seeds) and views empty.
 */
import { useCallback, useEffect, useReducer } from 'react'
import { listOwnershipDivisions, listShipmentViews } from '@/lib/apiClient'
import type { OwnershipDivisionRecord, ShipmentViewRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface ShipmentViewsResult {
  views: ShipmentViewRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export interface OwnershipDivisionsResult {
  /** `null` until the first read lands, and after a failed one. */
  divisions: OwnershipDivisionRecord[] | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

interface SharedResult<T> {
  data: T[] | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

interface Shared<T> {
  data: T[] | null
  error: string | null
  loaded: boolean
  inflight: Promise<void> | null
  timer: number | null
  listeners: Set<() => void>
  fetcher: () => Promise<T[]>
  failure: string
}

const divisionsStore: Shared<OwnershipDivisionRecord> = {
  data: null, error: null, loaded: false, inflight: null, timer: null, listeners: new Set(),
  fetcher: listOwnershipDivisions, failure: 'Divisions failed to load',
}

const viewsStore: Shared<ShipmentViewRecord> = {
  data: null, error: null, loaded: false, inflight: null, timer: null, listeners: new Set(),
  fetcher: listShipmentViews, failure: 'Shipment views failed to load',
}

function load<T>(store: Shared<T>): Promise<void> {
  if (store.inflight) return store.inflight
  const run = store.fetcher()
    .then((rows) => { store.data = rows; store.error = null })
    .catch((err: unknown) => { store.error = err instanceof Error ? err.message : store.failure })
    .finally(() => {
      store.inflight = null
      store.loaded = true
      for (const listener of store.listeners) listener()
    })
  store.inflight = run
  return run
}

/** Joins the shared fetch: first subscriber starts it and the 60 s poll behind it. */
function subscribe<T>(store: Shared<T>, listener: () => void): void {
  store.listeners.add(listener)
  if (!store.loaded && !store.inflight) void load(store)
  if (store.timer === null) {
    store.timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void load(store)
    }, POLL_MS)
  }
}

/** Last subscriber out stops the poll; a page with no TMS rail does not keep fetching. */
function unsubscribe<T>(store: Shared<T>, listener: () => void): void {
  store.listeners.delete(listener)
  if (store.listeners.size === 0 && store.timer !== null) {
    window.clearInterval(store.timer)
    store.timer = null
  }
}

function useShared<T>(store: Shared<T>): SharedResult<T> {
  const [, bump] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    subscribe(store, bump)
    return () => unsubscribe(store, bump)
  }, [store, bump])

  const refresh = useCallback(() => load(store), [store])
  return { data: store.data, loading: !store.loaded, error: store.error, refresh }
}

/** The saved Shipment views, newest server state; empty until they load or if they fail. */
export function useShipmentViews(): ShipmentViewsResult {
  const { data, loading, error, refresh } = useShared(viewsStore)
  return { views: data ?? [], loading, error, refresh }
}

/**
 * The ownership divisions. `null` means "not known yet" — the sidebar renders the seed
 * divisions in that case rather than an empty rail. An empty table says the same thing:
 * before the seed action has run (or before the model is deployed) the read answers with
 * no rows, and a sidebar with no sections is not what that means.
 */
export function useOwnershipDivisions(): OwnershipDivisionsResult {
  const { data, loading, error, refresh } = useShared(divisionsStore)
  return { divisions: data && data.length > 0 ? data : null, loading, error, refresh }
}
