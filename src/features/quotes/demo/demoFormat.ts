import type { TmsTone } from '@/features/tms/kit'
import type { DemoOutcome } from '../demoQuotes'

export const DEMO_OUTCOME_LABEL: Record<DemoOutcome, string> = {
  won: 'Won', lost: 'Lost', pending: 'Pending', expired: 'Expired',
}
export const DEMO_OUTCOME_TONE: Record<DemoOutcome, TmsTone> = {
  won: 'green', lost: 'red', pending: 'blue', expired: 'gray',
}

/** `2026-09-04` as `Sep 4, 2026`, without any timezone shifting the day. */
export function demoDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(d)
}
