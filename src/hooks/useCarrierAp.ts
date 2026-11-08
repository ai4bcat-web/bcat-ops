/**
 * One carrier's AP: every bill we have recorded against them and every row of money that
 * has gone out, with the two numbers the carrier profile leads with.
 *
 * `openCents` is what we still owe — the balance of their IN_REVIEW, TO_BE_PAID and
 * PARTIAL bills. `unappliedCents` is a credit we hold and have not spent: a TONU
 * adjustment, a claim, or an overpayment kept back. The second is deliberately NOT netted
 * against the first — the office decides which bill a credit comes off, and a netted
 * total would hide the choice.
 *
 * Polled on the 60 s TMS clock; neither model has subscriptions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listApPaymentsByCarrier, listBillsByCarrier } from '@/lib/apiClient'
import type { ApPaymentRecord, CarrierBillRecord, CarrierBillStatus } from '@/types/tms'

const POLL_MS = 60_000

/** Bills that still owe money. VOID and PAID are not open AP. */
const OPEN_STATUS: Partial<Record<CarrierBillStatus, true>> = { IN_REVIEW: true, TO_BE_PAID: true, PARTIAL: true }

export interface CarrierAp {
  /** Newest recorded first. VOID bills are included — the history is the point. */
  bills: CarrierBillRecord[]
  /** Newest paid first: payments, credit memos and reversals. */
  payments: ApPaymentRecord[]
  openCents: number
  unappliedCents: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useCarrierAp(carrierId: string | null): CarrierAp {
  const enabled = !!carrierId
  const [bills, setBills] = useState<CarrierBillRecord[]>([])
  const [payments, setPayments] = useState<ApPaymentRecord[]>([])
  // A drawer with no carrier open never fetches, so it reports "not loading" from the
  // start rather than writing state inside the effect.
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    if (!carrierId) return Promise.resolve()
    return Promise.all([listBillsByCarrier(carrierId), listApPaymentsByCarrier(carrierId)])
      .then(([billRows, paymentRows]) => {
        setBills(billRows)
        setPayments(paymentRows)
        setError(null)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Carrier AP failed to load') })
      .finally(() => setLoading(false))
  }, [carrierId])

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
    () => bills.reduce((sum, bill) => (OPEN_STATUS[bill.status] ? sum + bill.balanceCents : sum), 0),
    [bills],
  )

  // A reversed row's credit no longer exists: the REVERSAL took it back and the server
  // zeroes `unappliedCents` on the way. A stale poll can still show the old figure, and
  // money that cannot be spent must never be counted as money in hand.
  const unappliedCents = useMemo(
    () => payments.reduce((sum, p) => (p.reversedByPaymentId ? sum : sum + (p.unappliedCents ?? 0)), 0),
    [payments],
  )

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { bills, payments, openCents, unappliedCents, loading, error, refresh }
}
