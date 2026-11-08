/**
 * The open book: every invoice still carrying a balance, with its aging.
 *
 * `arOpen` is a sparse index key — only ISSUED and PARTIAL invoices carry it — so this
 * is one query for the whole outstanding book however many invoices have ever been
 * issued. The buckets come from `ageInvoices`, the same pure function the aging CSV and
 * the dashboard strip read, so no two surfaces can disagree about what is 60 days late.
 *
 * Polled on the 60 s TMS clock: Invoice has no subscriptions, and a payment posted at
 * another desk silently empties a row out of this list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listOpenInvoices } from '@/lib/apiClient'
import { ageInvoices, type AgingSummary } from '@/lib/arAging'
import type { InvoiceRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface OpenInvoices {
  /** Oldest due date first — the order the collections list is worked in. */
  invoices: InvoiceRecord[]
  aging: AgingSummary
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useOpenInvoices(): OpenInvoices {
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    return listOpenInvoices()
      .then((rows) => { setInvoices(rows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Open invoices failed to load') })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [load])

  // Aged against the moment of the read, not a fixed mount time: a page left open
  // overnight must not keep reporting yesterday's buckets.
  const aging = useMemo(() => ageInvoices(invoices, new Date().toISOString()), [invoices])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { invoices, aging, loading, error, refresh }
}
