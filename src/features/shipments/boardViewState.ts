/**
 * Where a person left the shipments board: header filters, quick flags, the typed search, how far down
 * they had loaded and scrolled, and the shipment they last opened. Kept per signed-in user (Cognito sub,
 * so two people on one computer never share it), per pane and per list, in localStorage, until they
 * press Clear filters. Sort and density already persist per user through useDenseGridPrefs.
 */
import type { DenseFilters } from '@/features/tms/grid/denseGridModel'
import type { BoardFlag } from './boardChips'

export interface BoardViewState {
  filters: DenseFilters
  flags: BoardFlag[]
  query: string
  pageSize: number
  scrollTop: number
  lastOpenedId: string | null
}

const VERSION = 1

export function boardViewKey(userId: string | null | undefined, pane: string, list: string): string {
  return `tms:board-view:${userId || 'anon'}:${pane}:${list}:v${VERSION}`
}

/** The list (Active / All / …) a person last had open, so coming back without one in the URL lands there. */
export function boardListKey(userId: string | null | undefined): string {
  return `tms:board-list:${userId || 'anon'}:v${VERSION}`
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readBoardView(key: string): Partial<BoardViewState> {
  try {
    const raw = storage()?.getItem(key)
    if (!raw) return {}
    const v = JSON.parse(raw) as Partial<BoardViewState>
    return {
      filters: v.filters && typeof v.filters === 'object' ? v.filters : undefined,
      flags: Array.isArray(v.flags) ? v.flags : undefined,
      query: typeof v.query === 'string' ? v.query : undefined,
      pageSize: typeof v.pageSize === 'number' && v.pageSize > 0 ? v.pageSize : undefined,
      scrollTop: typeof v.scrollTop === 'number' && v.scrollTop >= 0 ? v.scrollTop : undefined,
      lastOpenedId: typeof v.lastOpenedId === 'string' ? v.lastOpenedId : null,
    }
  } catch {
    return {}
  }
}

export function writeBoardView(key: string, state: BoardViewState): void {
  try {
    storage()?.setItem(key, JSON.stringify(state))
  } catch {
    // Storage full or blocked: the board still works, it just won't remember.
  }
}

export function clearBoardView(key: string): void {
  try {
    storage()?.removeItem(key)
  } catch {
    // ignore
  }
}

export function readText(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeText(key: string, value: string): void {
  try {
    storage()?.setItem(key, value)
  } catch {
    // ignore
  }
}
