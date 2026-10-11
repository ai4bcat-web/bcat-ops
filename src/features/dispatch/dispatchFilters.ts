/**
 * Each person's own view of the Dispatch list: which driver types and which drivers they
 * want to see. Everything is on by default; the choice is kept per signed-in user in
 * this browser, so Jenny's filters never touch Ryne's.
 */
import type { FleetDriver } from '@/lib/revenueByFleet'
import { conversationTitle, type DispatchConversation } from '@/lib/dispatch'
import { fleetSectionOf, SECTION_ORDER, type FleetSectionKey } from './fleetSections'

export interface DispatchFilters {
  /** Section keys to show; empty array means none. */
  types: FleetSectionKey[]
  /** Conversation titles (driver names / labels / numbers) hidden by this user. */
  hiddenNames: string[]
}

export const ALL_FILTERS: DispatchFilters = { types: [...SECTION_ORDER], hiddenNames: [] }

const KEY = (email: string) => `bcat.dispatch.filters.${(email || 'anon').toLowerCase()}`

export function readFilters(email: string, storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): DispatchFilters {
  try {
    const raw = storage?.getItem(KEY(email))
    if (!raw) return ALL_FILTERS
    const v = JSON.parse(raw) as Partial<DispatchFilters>
    const types = Array.isArray(v.types) ? v.types.filter((t): t is FleetSectionKey => (SECTION_ORDER as string[]).includes(t)) : [...SECTION_ORDER]
    const hiddenNames = Array.isArray(v.hiddenNames) ? v.hiddenNames.filter((n): n is string => typeof n === 'string') : []
    return { types, hiddenNames }
  } catch {
    return ALL_FILTERS
  }
}

export function writeFilters(email: string, f: DispatchFilters, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try {
    if (isAllFilters(f)) storage?.removeItem(KEY(email))
    else storage?.setItem(KEY(email), JSON.stringify(f))
  } catch { /* storage can be off; the choice just lives for this page load */ }
}

export function isAllFilters(f: DispatchFilters): boolean {
  return f.types.length === SECTION_ORDER.length && f.hiddenNames.length === 0
}

/** How many things are filtered out, for the button badge. */
export function filterCount(f: DispatchFilters): number {
  return (SECTION_ORDER.length - f.types.length) + f.hiddenNames.length
}

export function applyFilters(rows: readonly DispatchConversation[], drivers: readonly FleetDriver[], f: DispatchFilters): DispatchConversation[] {
  const types = new Set(f.types)
  const hidden = new Set(f.hiddenNames.map((n) => n.toLowerCase()))
  return rows.filter((c) => types.has(fleetSectionOf(c, drivers)) && !hidden.has(conversationTitle(c).toLowerCase()))
}
