/**
 * The open quote board: every live quote and carrier offer, soonest to expire first.
 *
 * `quoteOpen` is a sparse index key — carried from DRAFT through RECEIVED_COUNTER and
 * REMOVEd the moment a quote closes — so this is one query for everything still in play
 * however many quotes have ever been priced. Both sides come back together; the page
 * splits them into its tabs, which is cheaper than a read per tab.
 *
 * Expiry is lazy: nothing on a timer closes a quote whose clock ran out, so the board
 * sweeps once per mount before its first read. The sweep is idempotent and conditioned
 * server-side, so two desks opening the page at once cannot double-close anything — and
 * a sweep that fails is swallowed, because an unswept board is still a board.
 *
 * Polled on the 60 s TMS clock: Quote has no subscriptions, and an answer landing on the
 * public link silently moves a row from Sent to Replies.
 */
import { useCallback, useEffect, useState } from 'react'
import { listOpenQuotes, sweepExpiredQuotes } from '@/lib/apiClient'
import type { QuoteRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface QuoteWorklist {
  /** Both sides, soonest expiry first — the order the board reads down. */
  open: QuoteRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useQuoteWorklist(): QuoteWorklist {
  const [open, setOpen] = useState<QuoteRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    return listOpenQuotes()
      .then((rows) => { setOpen(rows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Quotes failed to load') })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    // One sweep per mount, then the read: a quote that expired overnight must show as
    // Lost the first time somebody looks, not after the first poll. A refused sweep
    // (no `page-quotes`, backend not deployed) still leaves the board readable.
    void sweepExpiredQuotes().catch(() => {}).then(() => { if (alive) void load() })
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [load])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { open, loading, error, refresh }
}
