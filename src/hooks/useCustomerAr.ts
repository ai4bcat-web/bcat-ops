/**
 * One customer's AR: every bill they have been sent and every cash row posted against
 * them, with the two numbers the profile leads with.
 *
 * `openCents` is what they still owe — the balance of their ISSUED and PARTIAL invoices,
 * which is the same money `creditExposure` counts. `unappliedCents` is money already in
 * hand that nothing has been applied to: an overpayment kept as credit, or a credit memo
 * nobody has spent. The second is deliberately NOT netted against the first — the office
 * decides which invoice a credit goes against, and a netted total would hide the choice.
 *
 * Polled on the 60 s TMS clock; neither model has subscriptions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listArPaymentsByCustomer, listInvoicesByCustomer } from '@/lib/apiClient'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'

const POLL_MS = 60_000

export interface CustomerAr {
  /** Newest issued first. VOID invoices are included — the history is the point. */
  invoices: InvoiceRecord[]
  /** Newest received first: receipts, credit memos, write-offs and reversals. */
  payments: ArPaymentRecord[]
  openCents: number
  unappliedCents: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useCustomerAr(customerId: string | null): CustomerAr {
  const enabled = !!customerId
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([])
  const [payments, setPayments] = useState<ArPaymentRecord[]>([])
  // A drawer with no customer open never fetches, so it reports "not loading" from the
  // start rather than writing state inside the effect.
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    if (!customerId) return Promise.resolve()
    return Promise.all([listInvoicesByCustomer(customerId), listArPaymentsByCustomer(customerId)])
      .then(([invoiceRows, paymentRows]) => {
        setInvoices(invoiceRows)
        setPayments(paymentRows)
        setError(null)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Customer AR failed to load') })
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

  const openCents = useMemo(
    () => invoices.reduce((sum, inv) => (inv.status === 'ISSUED' || inv.status === 'PARTIAL' ? sum + inv.balanceCents : sum), 0),
    [invoices],
  )

  // A reversed row's credit no longer exists: the REVERSAL took it back and the server
  // zeroes `unappliedCents` on the way. A stale poll can still show the old figure, and
  // money that cannot be spent must never be counted as money in hand.
  const unappliedCents = useMemo(
    () => payments.reduce((sum, p) => (p.reversedByPaymentId ? sum : sum + (p.unappliedCents ?? 0)), 0),
    [payments],
  )

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { invoices, payments, openCents, unappliedCents, loading, error, refresh }
}
