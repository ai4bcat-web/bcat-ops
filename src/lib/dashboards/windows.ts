/** Step AI §5/D9 — window presets resolved on the UTC calendar (no fiscal year, no time zones). */
import type { DashboardWindow } from './types'

export const MAX_CUSTOM_DAYS = 400
const DAY_MS = 86_400_000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export interface ResolvedWindow {
  /** `YYYY-MM-DD`, inclusive. */
  from: string
  to: string
  /** `YYYY-MM` for every month the window touches, ascending. */
  months: string[]
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Parses a strict `YYYY-MM-DD` to UTC ms, or null (also rejects 2026-02-31). */
export function parseDay(day: string): number | null {
  if (!DAY_RE.test(day)) return null
  const ms = Date.parse(`${day}T00:00:00.000Z`)
  return Number.isNaN(ms) || ymd(ms) !== day ? null : ms
}

/** Inclusive day count between two valid days. */
export function daySpan(from: string, to: string): number {
  return Math.round(((parseDay(to) ?? 0) - (parseDay(from) ?? 0)) / DAY_MS) + 1
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let y = Number(from.slice(0, 4))
  let m = Number(from.slice(5, 7))
  const endY = Number(to.slice(0, 4))
  const endM = Number(to.slice(5, 7))
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${pad(m)}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

const monthStart = (y: number, m0: number) => Date.UTC(y, m0, 1)
const monthEnd = (y: number, m0: number) => Date.UTC(y, m0 + 1, 0)

/** Resolve a window against `nowIso` (any ISO string; only its UTC date is read). Throws on an invalid CUSTOM window. */
export function resolveWindow(window: DashboardWindow, nowIso: string): ResolvedWindow {
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nowMs)) throw new Error('Invalid date')
  const now = new Date(nowMs)
  const y = now.getUTCFullYear()
  const m0 = now.getUTCMonth()
  const today = Date.UTC(y, m0, now.getUTCDate())
  const q0 = Math.floor(m0 / 3) * 3
  let from: number
  let to: number
  switch (window.preset) {
    case 'THIS_MONTH':
      from = monthStart(y, m0)
      to = monthEnd(y, m0)
      break
    case 'LAST_MONTH':
      from = monthStart(y, m0 - 1)
      to = monthEnd(y, m0 - 1)
      break
    case 'THIS_QUARTER':
      from = monthStart(y, q0)
      to = monthEnd(y, q0 + 2)
      break
    case 'LAST_QUARTER':
      from = monthStart(y, q0 - 3)
      to = monthEnd(y, q0 - 1)
      break
    case 'LAST_30_DAYS':
      from = today - 29 * DAY_MS
      to = today
      break
    case 'LAST_90_DAYS':
      from = today - 89 * DAY_MS
      to = today
      break
    case 'YEAR_TO_DATE':
      from = Date.UTC(y, 0, 1)
      to = today
      break
    case 'CUSTOM': {
      const f = parseDay(window.from)
      const t = parseDay(window.to)
      if (f == null || t == null || f > t) throw new Error('Invalid custom window')
      from = f
      to = t
      break
    }
  }
  const f = ymd(from)
  const t = ymd(to)
  return { from: f, to: t, months: monthsBetween(f, t) }
}
