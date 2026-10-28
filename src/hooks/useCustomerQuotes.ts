/**
 * One customer's quotes, newest first — the Quotes tab of the customer profile.
 *
 * One index read on `customerId`, open and closed rows together: the tab is a history as
 * much as a worklist, and a win rate cannot be computed from the open ones alone.
 *
 * Polled on the 60 s TMS clock, like the rest of the TMS surface.
 */
import { useCallback, useEffect, useState } from 'react'
import { listQuotesByCustomer } from '@/lib/apiClient'
import type { QuoteRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface CustomerQuotes {
  /** Newest quote date first, won and lost included. */
  quotes: QuoteRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useCustomerQuotes(customerId: string | null): CustomerQuotes {
  const enabled = !!customerId
  const [quotes, setQuotes] = useState<QuoteRecord[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    if (!customerId) return Promise.resolve()
    return listQuotesByCustomer(customerId)
      .then((rows) => { setQuotes(rows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Quotes failed to load') })
      .finally(() => setLoading(false))
  }, [customerId])

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

  return { quotes, loading, error, refresh }
}
