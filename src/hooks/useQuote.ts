/**
 * One quote, as its detail page renders it.
 *
 * The id *is* the quote number, so this is a GetItem — no index, no scan, and a staff
 * URL that carries no secret. Everything else the page shows (the thread, the sends, the
 * responses) lives on the row itself.
 *
 * Polled on the 60 s TMS clock: Quote has no subscriptions, and an accept or a counter
 * arriving on the public link changes this row without anybody here touching it.
 */
import { useCallback, useEffect, useState } from 'react'
import { getQuote } from '@/lib/apiClient'
import type { QuoteRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface QuoteDetailData {
  quote: QuoteRecord | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useQuote(id: string | null): QuoteDetailData {
  const enabled = !!id
  const [quote, setQuote] = useState<QuoteRecord | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    if (!id) return Promise.resolve()
    return getQuote(id)
      .then((row) => {
        setQuote(row)
        setError(row ? null : 'Quote not found')
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Quote failed to load') })
      .finally(() => setLoading(false))
  }, [id])

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

  return { quote, loading, error, refresh }
}
