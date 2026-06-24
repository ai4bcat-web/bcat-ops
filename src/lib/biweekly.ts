/**
 * Box-truck pay periods: biweekly 14-day windows, Wednesday → Tuesday.
 *
 * Anchored on 2026-06-10 (a Wednesday), which the owner defined as a period start
 * (Jun 10 – Jun 23, 2026). Every period is exactly 14 days from that anchor, so the
 * cadence is deterministic for any past/future date.
 */

const ANCHOR_MS = Date.UTC(2026, 5, 10) // 2026-06-10 (Wednesday) — biweekly cycle anchor
const DAY_MS = 86_400_000
export const PERIOD_DAYS = 14

function periodStartForMs(ms: number): string {
  // floor() handles dates before the anchor correctly (negative indices).
  const idx = Math.floor((ms - ANCHOR_MS) / (PERIOD_DAYS * DAY_MS))
  return new Date(ANCHOR_MS + idx * PERIOD_DAYS * DAY_MS).toISOString().slice(0, 10)
}

/** Period start (a Wednesday) for "now" (or a given Date). */
export function currentPeriodStart(ref: Date = new Date()): string {
  return periodStartForMs(Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate()))
}

/** Period start (Wednesday) for a YYYY-MM-DD date string. */
export function periodStartOfISO(dateStr: string): string {
  return periodStartForMs(Date.parse(`${dateStr}T12:00:00Z`))
}

/** Inclusive 14-day window end (the Tuesday) for a period start. */
export function periodEnd(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + PERIOD_DAYS - 1)
  return d.toISOString().slice(0, 10)
}

/** Shift a period start by N periods (±14 days each). */
export function shiftPeriod(periodStart: string, periods: number): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + periods * PERIOD_DAYS)
  return d.toISOString().slice(0, 10)
}

function fmtRange(periodStart: string, opts: Intl.DateTimeFormatOptions): string {
  const s = new Date(`${periodStart}T12:00:00Z`)
  const e = new Date(s)
  e.setUTCDate(e.getUTCDate() + PERIOD_DAYS - 1)
  const fmt = (x: Date) => x.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' })
  return `${fmt(s)} – ${fmt(e)}`
}

export function periodLabel(periodStart: string): string {
  return fmtRange(periodStart, { month: 'numeric', day: 'numeric' })
}

export function periodLabelLong(periodStart: string): string {
  return fmtRange(periodStart, { month: 'short', day: 'numeric', year: 'numeric' })
}
