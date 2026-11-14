import type { ViewMode } from '@/types'

/** The calendar's views: Day, Week and Month, the same boards on a phone and a desktop (List was removed, Ryne 2026-11-14). */
export type CalendarView = ViewMode

const PHONE_VIEW_KEY = 'calendar.phoneView.v2'
const VIEWS: readonly CalendarView[] = ['day', 'week', 'month']

/**
 * The view a phone opens on: the one last picked on a phone, else Day. A desktop always opens on Day. A remembered 'list' from before
 * the removal is not a view any more, so it opens on Day.
 */
export function initialCalendarView(phone: boolean, storage: Pick<Storage, 'getItem'> | null = safeStorage()): CalendarView {
  if (!phone) return 'day'
  let stored: string | null
  try { stored = storage?.getItem(PHONE_VIEW_KEY) ?? null } catch { stored = null }
  return VIEWS.includes(stored as CalendarView) ? (stored as CalendarView) : 'day'
}

/** Remember a view picked on a phone, so the next visit opens on it. */
export function rememberPhoneView(view: CalendarView, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(PHONE_VIEW_KEY, view) } catch { /* private mode: the default is fine */ }
}

function safeStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}
