export type FeedbackStatus = 'NEW' | 'IN_PROGRESS' | 'DONE'
export type SortKey = 'createdAt' | 'page' | 'status'

export interface FeedbackItem {
  id: string
  page: string
  summary: string
  details?: string | null
  screenshotKeys?: (string | null)[] | null
  status?: FeedbackStatus | null
  submittedBy?: string | null
  submittedByName?: string | null
  adminNotes?: string | null
  resolvedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export const STATUS_LABEL: Record<FeedbackStatus, string> = {
  NEW: 'New',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
}
export const STATUSES: FeedbackStatus[] = ['NEW', 'IN_PROGRESS', 'DONE']
const STATUS_RANK: Record<FeedbackStatus, number> = { NEW: 0, IN_PROGRESS: 1, DONE: 2 }

export function statusOf(f: FeedbackItem): FeedbackStatus {
  return f.status ?? 'NEW'
}

export function screenshotsOf(f: FeedbackItem): string[] {
  return (f.screenshotKeys ?? []).filter((k): k is string => !!k)
}

/** Fields to write when moving a row to `next`: resolvedAt is set on DONE, cleared otherwise. */
export function statusPatch(next: FeedbackStatus, now = new Date()): { status: FeedbackStatus; resolvedAt: string | null } {
  return { status: next, resolvedAt: next === 'DONE' ? now.toISOString() : null }
}

/** Whoever submitted a report may close it themselves ("I got it done") and reopen it; everyone else's stays read-only unless they are an admin. */
export function isOwnFeedback(f: FeedbackItem, email: string | null | undefined): boolean {
  const mine = (email ?? '').trim().toLowerCase()
  return mine !== '' && (f.submittedBy ?? '').trim().toLowerCase() === mine
}

export function sortFeedback(items: FeedbackItem[], key: SortKey, dir: 'asc' | 'desc'): FeedbackItem[] {
  const sign = dir === 'asc' ? 1 : -1
  const val = (f: FeedbackItem): string | number =>
    key === 'createdAt' ? (f.createdAt ?? '') : key === 'page' ? f.page.toLowerCase() : STATUS_RANK[statusOf(f)]
  return [...items].sort((a, b) => {
    const av = val(a)
    const bv = val(b)
    const c = av < bv ? -1 : av > bv ? 1 : 0
    // Newest first as the tiebreak regardless of direction, so ties are stable.
    return c !== 0 ? c * sign : (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  })
}

export function filterFeedback(
  items: FeedbackItem[],
  opts: { status: FeedbackStatus | 'ALL'; page: string; query: string },
): FeedbackItem[] {
  const q = opts.query.trim().toLowerCase()
  return items.filter((f) => {
    if (opts.status !== 'ALL' && statusOf(f) !== opts.status) return false
    if (opts.page !== 'ALL' && f.page !== opts.page) return false
    if (!q) return true
    return [f.summary, f.details, f.page, f.submittedBy, f.submittedByName, f.adminNotes]
      .some((s) => (s ?? '').toLowerCase().includes(q))
  })
}

export function groupByPage(items: FeedbackItem[]): { page: string; items: FeedbackItem[] }[] {
  const map = new Map<string, FeedbackItem[]>()
  for (const f of items) {
    const list = map.get(f.page)
    if (list) list.push(f)
    else map.set(f.page, [f])
  }
  return [...map.entries()].map(([page, list]) => ({ page, items: list })).sort((a, b) => a.page.localeCompare(b.page))
}
