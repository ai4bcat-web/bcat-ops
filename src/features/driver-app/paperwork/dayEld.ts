/**
 * The day's ELD answer, from its loads. Pure, so the rule can be pinned without a page.
 */
import type { PaperworkLoad } from '../driverApi'

export type DayEldState = 'REQUIRED' | 'UNKNOWN' | 'NOT_REQUIRED' | 'NO_DATA'

/** The day's answer: required if any stop is out, unknown if any could not be placed. */
export function dayEldState(loads: PaperworkLoad[]): DayEldState {
  if (loads.length === 0) return 'NOT_REQUIRED'
  // An API that predates the field tells us nothing; say nothing rather than "no logs".
  if (loads.some((l) => !l.eld)) return 'NO_DATA'
  if (loads.some((l) => l.eld?.status === 'REQUIRED')) return 'REQUIRED'
  if (loads.some((l) => l.eld?.status === 'UNKNOWN')) return 'UNKNOWN'
  return 'NOT_REQUIRED'
}

