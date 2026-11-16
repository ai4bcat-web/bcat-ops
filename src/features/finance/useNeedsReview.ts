/**
 * The Needs review list's data (Ryne 2026-11-13); the list itself is NeedsReview.tsx.
 *
 * Two kinds of item (Ryne 2026-11-16: "remove the open questions tab and move everything into the needs
 * review tab"): shipments flagged for a finance check, and the open questions Claude raised for Ryne
 * (Feedback rows, see openQuestions.ts). Questions are read for the owner and ADMINs only, as the old
 * Open questions page was; everyone else sees the shipment flags alone.
 */
import { useCallback, useEffect, useState } from 'react'
import { listFinanceReviewShipments, type FinanceReviewShipment } from '@/lib/apiClient'
import { listOpenQuestionRows } from '@/lib/openQuestionsClient'
import { errorText } from '@/lib/errorText'
import { useAuth } from '@/hooks/useAuth'
import { questionOnSide, toOpenQuestion, type OpenQuestion } from '@/features/openQuestions/openQuestions'

export function useNeedsReview() {
  const { isAdmin, isOwner } = useAuth()
  const seesQuestions = isAdmin || isOwner
  const [rows, setRows] = useState<FinanceReviewShipment[]>([])
  const [questions, setQuestions] = useState<OpenQuestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    // Through a resolved promise so a missing read (an older backend, a test mock) lands in `error`, not a crash.
    Promise.resolve().then(() => listFinanceReviewShipments())
      .then((list) => { setRows(sortReview(list)); setError(null) })
      .catch((e: unknown) => setError(errorText(e) || 'Could not load Needs review'))
    Promise.resolve().then(() => (seesQuestions ? listOpenQuestionRows() : []))
      .then((list) => setQuestions(list.map(toOpenQuestion)))
      .catch((e: unknown) => setError(errorText(e) || 'Could not load the open questions'))
  }, [seesQuestions])
  useEffect(() => { refresh() }, [refresh])
  const replaceQuestion = useCallback((next: OpenQuestion) => {
    setQuestions((prev) => prev.map((q) => (q.id === next.id ? next : q)))
  }, [])
  return { rows, questions, error, refresh, replaceQuestion }
}

/** Open items on one side's list: every flagged shipment plus that side's unresolved questions. */
export function openReviewCount(rows: readonly FinanceReviewShipment[], questions: readonly OpenQuestion[], side: 'AR' | 'AP'): number {
  return rows.length + questions.filter((q) => q.status === 'OPEN' && questionOnSide(q, side)).length
}

/** Oldest flag first, then by PRO. */
export function sortReview(rows: readonly FinanceReviewShipment[]): FinanceReviewShipment[] {
  return [...rows].sort((a, b) => String(a.financeReviewAt ?? '').localeCompare(String(b.financeReviewAt ?? ''))
    || String(a.number ?? '').localeCompare(String(b.number ?? ''), undefined, { numeric: true }))
}
