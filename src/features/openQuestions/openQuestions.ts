/**
 * Accounting → Open questions (Ryne 2026-11-15: "Add another tab in the accounting area that has all the
 * open questions you need me to look into").
 *
 * Each question is a `Feedback` row with `page` = OPEN_QUESTION_PAGE, so no new table or stack resource:
 * `summary` is the question, `details` is the JSON below (the records it is about and what each system
 * says), `status` NEW is Open and DONE is Resolved, and `adminNotes` holds Ryne's answers, each one
 * stamped with who and when so they can be read back later (scripts/readOpenQuestions.mjs). The
 * Feedback page leaves these rows out.
 *
 * Pure: no store, no network.
 */
import type { FeedbackItem, FeedbackStatus } from '@/features/feedback/feedbackLogic'

export const OPEN_QUESTION_PAGE = 'accounting-open-question'

export type OpenQuestionArea = 'AP' | 'AR' | 'DOCS' | 'LOAD' | 'OTHER'

export const AREA_LABEL: Record<OpenQuestionArea, string> = {
  AP: 'Payables',
  AR: 'Receivables',
  DOCS: 'Documents',
  LOAD: 'Load setup',
  OTHER: 'Other',
}

/** One record a question is about: a PRO and, when we have them, the rows to open. */
export interface OpenQuestionRef {
  pro: string
  shipmentId?: string | null
  billId?: string | null
  invoiceId?: string | null
  /** Carrier or customer. */
  party?: string | null
  amount?: string | null
  note?: string | null
}

export interface OpenQuestionDetails {
  area: OpenQuestionArea
  refs: OpenQuestionRef[]
  aljex?: string | null
  bcat?: string | null
  context?: string | null
  /** Where the question came from (a report, a reconciliation). */
  source?: string | null
}

export interface OpenQuestion {
  id: string
  question: string
  status: 'OPEN' | 'RESOLVED'
  details: OpenQuestionDetails
  notes: string
  createdAt: string | null
  updatedAt: string | null
}

const AREAS: readonly OpenQuestionArea[] = ['AP', 'AR', 'DOCS', 'LOAD', 'OTHER']

export function parseDetails(raw: string | null | undefined): OpenQuestionDetails {
  let v: unknown
  try {
    v = raw ? JSON.parse(raw) : null
  } catch {
    return { area: 'OTHER', refs: [], context: raw ?? null }
  }
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const area = AREAS.includes(o.area as OpenQuestionArea) ? (o.area as OpenQuestionArea) : 'OTHER'
  const refs = Array.isArray(o.refs)
    ? o.refs.filter((r): r is OpenQuestionRef => !!r && typeof r === 'object' && typeof (r as OpenQuestionRef).pro === 'string')
    : []
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null)
  return { area, refs, aljex: str('aljex'), bcat: str('bcat'), context: str('context'), source: str('source') }
}

export function isOpenQuestion(f: Pick<FeedbackItem, 'page'>): boolean {
  return f.page === OPEN_QUESTION_PAGE
}

export function toOpenQuestion(f: FeedbackItem): OpenQuestion {
  return {
    id: f.id,
    question: f.summary,
    status: f.status === 'DONE' ? 'RESOLVED' : 'OPEN',
    details: parseDetails(f.details),
    notes: f.adminNotes ?? '',
    createdAt: f.createdAt ?? null,
    updatedAt: f.updatedAt ?? null,
  }
}

export function statusFor(resolved: boolean): FeedbackStatus {
  return resolved ? 'DONE' : 'NEW'
}

/** Adds one answer to the notes, stamped "2026-11-15 · Ryne: …"; the earlier answers stay. */
export function appendNote(existing: string, text: string, who: string, at: Date = new Date()): string {
  const body = text.trim()
  if (!body) return existing
  const line = `${at.toISOString().slice(0, 10)} · ${who}: ${body}`
  return existing.trim() ? `${existing.trim()}\n${line}` : line
}

/** The person's first name from an e-mail ("ryne@bcatcorp.com" → "Ryne"). */
export function whoFromEmail(email: string | null | undefined): string {
  const local = (email ?? '').split('@')[0] ?? ''
  const first = local.split(/[._-]+/).find(Boolean) ?? ''
  return first ? first[0]!.toUpperCase() + first.slice(1) : 'Someone'
}

export type OpenQuestionFilter = 'OPEN' | 'RESOLVED' | 'ALL'

export function filterQuestions(
  items: OpenQuestion[],
  { status, area, query }: { status: OpenQuestionFilter; area: OpenQuestionArea | 'ALL'; query: string },
): OpenQuestion[] {
  const q = query.trim().toLowerCase()
  return items.filter((it) => {
    if (status !== 'ALL' && it.status !== status) return false
    if (area !== 'ALL' && it.details.area !== area) return false
    if (!q) return true
    const hay = [
      it.question, it.notes, it.details.aljex, it.details.bcat, it.details.context,
      ...it.details.refs.flatMap((r) => [r.pro, r.party, r.note]),
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  })
}

/** Open first; then by area, then by the first PRO, oldest first. */
export function sortQuestions(items: OpenQuestion[]): OpenQuestion[] {
  const pro = (it: OpenQuestion) => Number(it.details.refs[0]?.pro) || Number.MAX_SAFE_INTEGER
  return [...items].sort((a, b) =>
    (a.status === b.status ? 0 : a.status === 'OPEN' ? -1 : 1)
    || AREAS.indexOf(a.details.area) - AREAS.indexOf(b.details.area)
    || pro(a) - pro(b)
    || a.id.localeCompare(b.id),
  )
}

export function countByStatus(items: OpenQuestion[]): { open: number; resolved: number } {
  let open = 0
  for (const it of items) if (it.status === 'OPEN') open++
  return { open, resolved: items.length - open }
}
