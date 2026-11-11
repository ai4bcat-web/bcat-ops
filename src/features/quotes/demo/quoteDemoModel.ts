/** Pure helpers for the Quote tab demo panel (no React, no API). */
import { DEMO_QUOTES } from '../demoQuotes'
import type { DemoQuote } from '../demoQuotes'

export const DEMO_TITLE = 'Demo data'

/** Pure: the headline numbers, derived from the rows (never stored). */
export function demoTotals(quotes: readonly DemoQuote[] = DEMO_QUOTES): { received: number; won: number; winRate: number; wonCents: number; open: number } {
  const won = quotes.filter((q) => q.outcome === 'won')
  return {
    received: quotes.length,
    won: won.length,
    winRate: quotes.length === 0 ? 0 : won.length / quotes.length,
    wonCents: won.reduce((sum, q) => sum + (q.finalCents ?? 0), 0),
    open: quotes.filter((q) => q.outcome === 'pending').length,
  }
}

/** Newest first. */
export const demoRows = (): DemoQuote[] => [...DEMO_QUOTES].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
