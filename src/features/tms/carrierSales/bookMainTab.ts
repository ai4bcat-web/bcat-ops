/**
 * The Book page's two main tabs (Ryne 2026-11-28): Assets (the Capacity board, first and the default) and Brokerage (everything
 * the page held before). The URL owns the choice: `?main=assets|brokerage`. An older link that carries the brokerage page's own
 * `?tab=` or `?load=` has no `main`, and it must still land on Brokerage, so those win over the remembered choice.
 */
export type BookMainTab = 'assets' | 'brokerage'

export const BOOK_MAIN_TABS: readonly BookMainTab[] = ['assets', 'brokerage']

export function bookMainStorageKey(email: string | null | undefined): string {
  return `tms:book:main:${(email ?? '').trim().toLowerCase() || 'anon'}`
}

export function readBookMainTab(email: string | null | undefined): BookMainTab | null {
  try {
    const v = window.localStorage.getItem(bookMainStorageKey(email))
    return v === 'assets' || v === 'brokerage' ? v : null
  } catch {
    return null
  }
}

export function rememberBookMainTab(email: string | null | undefined, tab: BookMainTab): void {
  try {
    window.localStorage.setItem(bookMainStorageKey(email), tab)
  } catch {
    /* private window or blocked site data: the tab still works, it just isn't remembered */
  }
}

/**
 * Which main tab shows. Someone without the Capacity board always gets Brokerage. Otherwise: an explicit `main`, then a link made
 * for the brokerage page (`tab` or `load`), then the tab they last used, then Assets.
 */
export function chooseBookMainTab(input: {
  capacityAllowed: boolean
  mainParam: string | null
  hasBrokerageParams: boolean
  remembered: BookMainTab | null
}): BookMainTab {
  if (!input.capacityAllowed) return 'brokerage'
  if (input.mainParam === 'assets' || input.mainParam === 'brokerage') return input.mainParam
  if (input.hasBrokerageParams) return 'brokerage'
  return input.remembered ?? 'assets'
}
