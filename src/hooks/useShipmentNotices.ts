/**
 * One shipment's e-mail history, newest first.
 *
 * Every notice step E tries to send is written before the send and patched with the
 * outcome, so a NOT_SENT row still carries the subject and the body somebody can copy
 * out by hand. Polled like the documents beside it: ShipmentNotice has no
 * subscriptions, and the delivery stream writes milestone rows on its own.
 */
import { useCallback, useEffect, useState } from 'react'
import { listShipmentNotices } from '@/lib/apiClient'
import type { ShipmentNoticeRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface ShipmentNotices {
  notices: ShipmentNoticeRecord[]
  /** Rows SES refused — what the tab warns about. */
  failedCount: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useShipmentNotices(
  shipmentId: string | null | undefined,
  opts?: { enabled?: boolean },
): ShipmentNotices {
  const enabled = (opts?.enabled ?? true) && !!shipmentId
  const [notices, setNotices] = useState<ShipmentNoticeRecord[]>([])
  // A disabled caller never fetches, so the hook starts "not loading" rather than
  // writing state inside the effect.
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useOpenIncidents` uses.
  const load = useCallback(() => {
    if (!enabled || !shipmentId) return Promise.resolve()
    return listShipmentNotices(shipmentId)
      .then((rows) => { setNotices(rows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Notices failed to load') })
      .finally(() => setLoading(false))
  }, [enabled, shipmentId])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [enabled, load])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return {
    notices,
    failedCount: notices.filter((n) => n.status === 'NOT_SENT' || n.status === 'FAILED').length,
    loading,
    error,
    refresh,
  }
}
