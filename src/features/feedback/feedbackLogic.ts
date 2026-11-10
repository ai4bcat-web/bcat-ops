export type FeedbackStatus = 'NEW' | 'IN_PROGRESS' | 'DONE'
export type SortKey = 'createdAt' | 'page' | 'status' | 'priority'
/** 1 = blocking me from working, 2 = need to fix but not ASAP, 3 = nice to have. */
export type FeedbackPriority = 1 | 2 | 3

export interface FeedbackItem {
  id: string
  page: string
  summary: string
  details?: string | null
  screenshotKeys?: (string | null)[] | null
  status?: FeedbackStatus | null
  priority?: number | null
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
export const PRIORITIES: FeedbackPriority[] = [1, 2, 3]
export const PRIORITY_LABEL: Record<FeedbackPriority, string> = {
  1: '1 · Blocking me from working',
  2: '2 · Need to fix, not ASAP',
  3: '3 · Nice to have',
}
export const PRIORITY_SHORT: Record<FeedbackPriority, string> = { 1: 'P1 Blocking', 2: 'P2 Fix soon', 3: 'P3 Nice to have' }

/** The report's priority, or null on a report from before priorities existed. */
export function priorityOf(f: FeedbackItem): FeedbackPriority | null {
  return f.priority === 1 || f.priority === 2 || f.priority === 3 ? f.priority : null
}

export const STATUSES: FeedbackStatus[] = ['NEW', 'IN_PROGRESS', 'DONE']
const STATUS_RANK: Record<FeedbackStatus, number> = { NEW: 0, IN_PROGRESS: 1, DONE: 2 }

export function statusOf(f: FeedbackItem): FeedbackStatus {
  return f.status ?? 'NEW'
}

export function screenshotsOf(f: FeedbackItem): string[] {
  return (f.screenshotKeys ?? []).filter((k): k is string => !!k)
}

/**
 * Fields to write when moving a row to `next`. Status only: the API refuses writes to `resolvedAt`
 * ("Unauthorized on [resolvedAt]"), which made every status button fail, and nothing reads it (updatedAt dates the change).
 */
export function statusPatch(next: FeedbackStatus): { status: FeedbackStatus } {
  return { status: next }
}

/** Whoever submitted a report may close it themselves ("I got it done") and reopen it; everyone else's stays read-only unless they are an admin. */
export function isOwnFeedback(f: FeedbackItem, email: string | null | undefined): boolean {
  const mine = (email ?? '').trim().toLowerCase()
  return mine !== '' && (f.submittedBy ?? '').trim().toLowerCase() === mine
}

export function sortFeedback(items: FeedbackItem[], key: SortKey, dir: 'asc' | 'desc'): FeedbackItem[] {
  const sign = dir === 'asc' ? 1 : -1
  const val = (f: FeedbackItem): string | number =>
    key === 'createdAt' ? (f.createdAt ?? '') : key === 'page' ? f.page.toLowerCase() : key === 'priority' ? (priorityOf(f) ?? 9) : STATUS_RANK[statusOf(f)]
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
  opts: { status: FeedbackStatus | 'ALL'; page: string; query: string; priority?: FeedbackPriority | 'ALL' },
): FeedbackItem[] {
  const q = opts.query.trim().toLowerCase()
  return items.filter((f) => {
    if (opts.status !== 'ALL' && statusOf(f) !== opts.status) return false
    if (opts.page !== 'ALL' && f.page !== opts.page) return false
    if (opts.priority && opts.priority !== 'ALL' && priorityOf(f) !== opts.priority) return false
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
