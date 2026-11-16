import { useCallback, useEffect, useState } from 'react'
import { listUnlinkedShipments, type UnlinkedShipment } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'

/**
 * Unlinked shipments, read once and shared. The read scans the Shipment table, so the result is kept for a minute across
 * every place that asks (the profile tab, the Directory view, Needs review) and dropped the moment something is linked.
 */
const STALE_MS = 60_000
let cache: { at: number; rows: UnlinkedShipment[]; total: number } | null = null
let inflight: Promise<{ rows: UnlinkedShipment[]; total: number }> | null = null

export function invalidateUnlinkedShipments(): void { cache = null }

async function load(force: boolean): Promise<{ rows: UnlinkedShipment[]; total: number }> {
  if (!force && cache && Date.now() - cache.at < STALE_MS) return cache
  inflight ??= listUnlinkedShipments().then((r) => { cache = { at: Date.now(), ...r }; return r }).finally(() => { inflight = null })
  return inflight
}

export function useUnlinkedShipments(enabled = true) {
  const [rows, setRows] = useState<UnlinkedShipment[]>(() => cache?.rows ?? [])
  const [total, setTotal] = useState(() => cache?.total ?? 0)
  const [loading, setLoading] = useState(enabled && !cache)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(Boolean(cache))

  const refresh = useCallback((force = true) => {
    return load(force)
      .then((r) => { setRows(r.rows); setTotal(r.total); setError(null); setLoaded(true) })
      .catch((e: unknown) => { setError(errorText(e) || 'Could not load unlinked loads') })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { if (enabled) void refresh(false) }, [enabled, refresh])

  /** Drop linked rows at once, so the list answers before the next read. */
  const dropLinked = useCallback((ids: readonly string[]) => {
    invalidateUnlinkedShipments()
    const gone = new Set(ids)
    setRows((p) => p.filter((r) => !gone.has(r.id)))
    setTotal((p) => Math.max(0, p - gone.size))
  }, [])

  return { rows, total, loading, error, loaded, refresh, dropLinked }
}
