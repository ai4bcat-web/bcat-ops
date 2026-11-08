/**
 * Every carrier offer ever made on one leg, newest first — the Carrier tab's offers card.
 *
 * One index read on `loadId`, open and closed rows together: the card shows the round
 * that booked beside the ones that passed, and a load that is already covered still has
 * to be able to say who else was asked and what they wanted.
 *
 * Polled on the 60 s TMS clock: a carrier answering their link changes a row here
 * without anybody in the office touching it.
 */
import { useCallback, useEffect, useState } from 'react'
import { listOffersByLoad } from '@/lib/apiClient'
import type { QuoteRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface LoadOffers {
  /** Newest first; both open and closed rounds. */
  offers: QuoteRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useLoadOffers(loadId: string | null): LoadOffers {
  const enabled = !!loadId
  const [offers, setOffers] = useState<QuoteRecord[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    if (!loadId) return Promise.resolve()
    return listOffersByLoad(loadId)
      .then((rows) => { setOffers(rows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Offers failed to load') })
      .finally(() => setLoading(false))
  }, [loadId])

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

  return { offers, loading, error, refresh }
}
