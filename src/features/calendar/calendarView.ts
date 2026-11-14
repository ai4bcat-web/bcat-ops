import type { ViewMode } from '@/types'

/** The calendar's views: the three boards, plus List, a phone-only card list of one day. */
export type CalendarView = ViewMode | 'list'

// v2: Ryne 2026-11-14 wants phones to open on Day; the new key drops the remembered List from before.
const PHONE_VIEW_KEY = 'calendar.phoneView.v2'
const VIEWS: readonly CalendarView[] = ['list', 'day', 'week', 'month']

/**
 * The view a phone opens on: the one last picked on a phone, else Day. A desktop always opens on Day, and a desktop never shows List
 * (it reads as Day there).
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

/** What actually renders: List outside a phone falls back to Day. */
export function effectiveCalendarView(view: CalendarView, phone: boolean): CalendarView {
  return view === 'list' && !phone ? 'day' : view
}

function safeStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}
