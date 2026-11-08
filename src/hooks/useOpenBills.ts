/**
 * The open AP book: every carrier bill still carrying a balance, with its aging.
 *
 * `apOpen` is a sparse index key — only IN_REVIEW, TO_BE_PAID and PARTIAL bills carry it
 * — so this is one query for everything outstanding however many bills have ever been
 * recorded. The buckets come from `ageOpenItems`, the same pure function the AR book ages
 * through, so the two sides of the ledger cannot disagree about what 60 days late means.
 *
 * Polled on the 60 s TMS clock: CarrierBill has no subscriptions, and a payment posted at
 * another desk silently empties a row out of this list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listOpenBills } from '@/lib/apiClient'
import { ageOpenItems, type AgingPartySummary } from '@/lib/arAging'
import type { CarrierBillRecord, CarrierBillStatus } from '@/types/tms'

const POLL_MS = 60_000

/** Bills that still owe money. VOID and PAID are not open AP. */
const OPEN_STATUS: Partial<Record<CarrierBillStatus, true>> = { IN_REVIEW: true, TO_BE_PAID: true, PARTIAL: true }

export interface OpenBills {
  /** Oldest due date first — the order the pay run is worked in. */
  bills: CarrierBillRecord[]
  /** Aged by carrier: each `byParty` row is one carrier we owe. */
  aging: AgingPartySummary
  /** What is approved and waiting on cash — TO_BE_PAID and PARTIAL, not IN_REVIEW. */
  approvedCents: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useOpenBills(): OpenBills {
  const [bills, setBills] = useState<CarrierBillRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    return listOpenBills()
      .then((rows) => { setBills(rows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Open bills failed to load') })
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
  // overnight must not keep reporting yesterday's buckets. A row that was paid or voided
  // between the query and the render is dropped here rather than aged as money owed.
  const aging = useMemo(() => ageOpenItems(
    bills.filter((b) => OPEN_STATUS[b.status]).map((b) => ({
      partyId: b.carrierId,
      partyName: b.carrierName,
      dueAt: b.dueAt,
      balanceCents: b.balanceCents,
    })),
    new Date().toISOString(),
  ), [bills])

  // IN_REVIEW money is not payable yet — nobody has approved it — so the pay-run total
  // the page leads with must not include it.
  const approvedCents = useMemo(
    () => bills.reduce((sum, b) => (b.status === 'TO_BE_PAID' || b.status === 'PARTIAL' ? sum + b.balanceCents : sum), 0),
    [bills],
  )

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { bills, aging, approvedCents, loading, error, refresh }
}
