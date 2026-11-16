/** The merged Needs review list's rows (Ryne 2026-11-16): flagged shipments and open questions. Pure. */
import type { FinanceReviewShipment } from '@/lib/apiClient'
import { filterQuestions, questionOnSide, type OpenQuestion, type OpenQuestionFilter } from '@/features/openQuestions/openQuestions'

/** One row of the merged list: a flagged shipment or an open question. */
export type ReviewItem =
  | { kind: 'flag'; key: string; at: string; row: FinanceReviewShipment }
  | { kind: 'question'; key: string; at: string; question: OpenQuestion }

/**
 * The rows one side shows for a status filter: flags (always open) and that side's questions, open first,
 * then oldest first. Search covers PRO, customer/party, reason or question, notes and the carrier note (AP).
 */
export function reviewItems(
  rows: readonly FinanceReviewShipment[], questions: readonly OpenQuestion[], side: 'AR' | 'AP',
  status: OpenQuestionFilter, search: string,
): ReviewItem[] {
  const q = search.trim().toLowerCase()
  const flags: ReviewItem[] = status === 'RESOLVED' ? [] : rows
    .filter((row) => !q || [row.number, row.customerName, row.financeReviewReason, side === 'AP' ? row.financeReviewApNote : null]
      .some((v) => v != null && String(v).toLowerCase().includes(q)))
    .map((row) => ({ kind: 'flag', key: `flag:${row.id}`, at: row.financeReviewAt ?? '', row }))
  const qs: ReviewItem[] = filterQuestions(questions.filter((it) => questionOnSide(it, side)), { status, area: 'ALL', query: search })
    .map((question) => ({ kind: 'question', key: `q:${question.id}`, at: question.createdAt ?? '', question }))
  const open = (it: ReviewItem) => (it.kind === 'flag' || it.question.status === 'OPEN' ? 0 : 1)
  return [...flags, ...qs].sort((a, b) => open(a) - open(b) || a.at.localeCompare(b.at) || a.key.localeCompare(b.key))
}

