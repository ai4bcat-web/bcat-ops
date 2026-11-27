/**
 * The calendar's views: Day and Capacity, the same on a phone and a desktop. Week and Month were removed (Ryne 2026-11-27) and
 * List before them (2026-11-14); a view remembered from before reads as Day.
 */
export type CalendarView = 'day' | 'capacity'

const PHONE_VIEW_KEY = 'calendar.phoneView.v2'
const VIEWS: readonly CalendarView[] = ['day', 'capacity']

/**
 * The view a phone opens on: the one last picked on a phone, else Day. A desktop always opens on Day. A remembered 'list', 'week' or 'month'
 * is not a view any more, so it opens on Day.
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
