/** The Needs review list's data (Ryne 2026-11-13); the list itself is NeedsReview.tsx. */
import { useCallback, useEffect, useState } from 'react'
import { listFinanceReviewShipments, type FinanceReviewShipment } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'

export function useNeedsReview() {
  const [rows, setRows] = useState<FinanceReviewShipment[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    // Through a resolved promise so a missing read (an older backend, a test mock) lands in `error`, not a crash.
    Promise.resolve().then(() => listFinanceReviewShipments())
      .then((list) => { setRows(sortReview(list)); setError(null) })
      .catch((e: unknown) => setError(errorText(e) || 'Could not load Needs review'))
  }, [])
  useEffect(() => { refresh() }, [refresh])
  return { rows, error, refresh }
}

/** Oldest flag first, then by PRO. */
export function sortReview(rows: readonly FinanceReviewShipment[]): FinanceReviewShipment[] {
  return [...rows].sort((a, b) => String(a.financeReviewAt ?? '').localeCompare(String(b.financeReviewAt ?? ''))
    || String(a.number ?? '').localeCompare(String(b.number ?? ''), undefined, { numeric: true }))
}
