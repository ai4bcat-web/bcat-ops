/**
 * Every carrier-portal upload still waiting on a person, oldest first.
 *
 * `reviewStatus` is a sparse GSI key — only CARRIER_PORTAL rows ever carry PENDING —
 * so this reads exactly the queue however many documents the book holds. Nothing a
 * carrier sends satisfies a required-document gate until somebody accepts it here,
 * which is why the count is worth a badge. Same 60 s poll as the tracking surface.
 */
import { useCallback, useEffect, useState } from 'react'
import { listDocumentReviewQueue } from '@/lib/apiClient'
import type { ShipmentDocumentRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface DocumentReviewQueue {
  documents: ShipmentDocumentRecord[]
  /** What the sidebar badge counts. */
  pendingCount: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useDocumentReviewQueue(opts?: { enabled?: boolean }): DocumentReviewQueue {
  const enabled = opts?.enabled ?? true
  const [documents, setDocuments] = useState<ShipmentDocumentRecord[]>([])
  // Same as the worklist: a disabled caller never fetches, so it starts "not loading"
  // instead of writing state inside the effect.
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useOpenIncidents` uses.
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve()
    return listDocumentReviewQueue()
      .then((rows) => { setDocuments(rows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Document review failed to load') })
      .finally(() => setLoading(false))
  }, [enabled])

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

  return { documents, pendingCount: documents.length, loading, error, refresh }
}
