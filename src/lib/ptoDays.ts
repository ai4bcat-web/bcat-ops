/**
 * Staff-entered PTO days (Employee hours page).
 *
 * A PTO day is ONE TimeClockEntry (kind PTO, minutes) that already flows into the period's
 * hours and pay, plus ONE APPROVED DriverAvailability row (type PTO) so the calendar and the
 * driver's own Time Off view agree. These helpers only decide WHICH days to write and how to
 * total them; they never change how hours turn into pay.
 */
import { addDaysISO } from './timeOff'
import { STANDARD_DAY_MINUTES, rowMinutes, type TimeClockRow } from './timeClock'

/** The most days one "Add PTO days" save may write, so a typo in a year cannot create hundreds. */
export const MAX_PTO_BATCH = 62

export interface PtoDayInput {
  /** Inclusive range; a single day has from === to. */
  from: string
  to: string
  /** Extra individual days (the backfill list), in addition to the range. */
  extraDates?: string[]
  includeWeekends: boolean
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** 0 = Sunday … 6 = Saturday for a YYYY-MM-DD day (calendar maths, no time zone involved). */
export function weekdayOf(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay()
}

export function isWeekend(iso: string): boolean {
  const d = weekdayOf(iso)
  return d === 0 || d === 6
}

/** Sorted, de-duplicated days the input stands for; weekends only when asked. Bad dates are dropped. */
export function expandPtoDates(input: PtoDayInput): string[] {
  const days = new Set<string>()
  if (ISO.test(input.from) && ISO.test(input.to) && input.from <= input.to) {
    let guard = 0
    for (let d = input.from; d <= input.to && guard < 400; d = addDaysISO(d, 1), guard += 1) {
      if (input.includeWeekends || !isWeekend(d)) days.add(d)
    }
  }
  for (const d of input.extraDates ?? []) if (ISO.test(d)) days.add(d)
  return [...days].sort()
}

export interface PtoPlan {
  /** Days that will be written. */
  add: string[]
  /** Days the driver already has a PTO row on: never paid twice. */
  skipped: string[]
  /** Set when the batch is too large to write in one go. */
  error: string | null
}

/** Which of the requested days are new for this driver, given their existing PTO days. */
export function planPtoDays(requested: readonly string[], existingPtoDates: ReadonlySet<string>): PtoPlan {
  const add = requested.filter((d) => !existingPtoDates.has(d))
  const skipped = requested.filter((d) => existingPtoDates.has(d))
  if (add.length > MAX_PTO_BATCH) return { add: [], skipped, error: `That is ${add.length} days. Add at most ${MAX_PTO_BATCH} at a time.` }
  return { add, skipped, error: null }
}

/** Minutes for an hours-per-day entry, quarter-hour precise, never negative, capped at a day. */
export function ptoMinutesFor(hoursPerDay: number): number {
  if (!Number.isFinite(hoursPerDay) || hoursPerDay <= 0) return 0
  return Math.round(Math.min(24, hoursPerDay) * 4) * 15
}

export const DEFAULT_PTO_MINUTES = STANDARD_DAY_MINUTES

export interface PtoRow {
  id: string
  driverId: string
  workDate: string
  minutes: number
  note: string
  enteredBy: string
  corrected: boolean
}

/** The PTO rows among time clock rows, newest day first, as the table shows them. */
export function ptoRowsOf(rows: ReadonlyArray<TimeClockRow & { id: string; correctedBy?: string | null; note?: string | null }>): PtoRow[] {
  return rows
    .filter((r) => r.kind === 'PTO')
    .map((r) => ({
      id: r.id,
      driverId: r.driverId,
      workDate: r.workDate,
      minutes: rowMinutes(r),
      note: r.note ?? '',
      enteredBy: r.correctedBy ?? (typeof r.note === 'string' ? (/(?:entered|approved) by (\S+@\S+?)(?=\s|$|\))/.exec(r.note)?.[1] ?? '') : ''),
      corrected: Boolean(r.correctedBy),
    }))
    .sort((a, b) => (a.workDate === b.workDate ? a.driverId.localeCompare(b.driverId) : a.workDate < b.workDate ? 1 : -1))
}

export interface PtoFilter {
  driverId?: string
  /** YYYY-MM. */
  month?: string
  /** A day inside the wanted Monday-to-Sunday week. */
  weekOf?: string
}

export function mondayOf(iso: string): string {
  const d = weekdayOf(iso)
  return addDaysISO(iso, d === 0 ? -6 : 1 - d)
}

export function filterPtoRows(rows: readonly PtoRow[], f: PtoFilter): PtoRow[] {
  const weekStart = f.weekOf ? mondayOf(f.weekOf) : null
  const weekEnd = weekStart ? addDaysISO(weekStart, 6) : null
  return rows.filter((r) =>
    (!f.driverId || r.driverId === f.driverId) &&
    (!f.month || r.workDate.startsWith(f.month)) &&
    (!weekStart || (r.workDate >= weekStart && r.workDate <= weekEnd!)),
  )
}

export interface PtoTotal { driverId: string; days: number; minutes: number }

/** Days and hours per driver for one calendar year. */
export function ptoTotalsByDriver(rows: readonly PtoRow[], year: string): PtoTotal[] {
  const map = new Map<string, PtoTotal>()
  for (const r of rows) {
    if (!r.workDate.startsWith(year)) continue
    const t = map.get(r.driverId) ?? { driverId: r.driverId, days: 0, minutes: 0 }
    t.days += 1
    t.minutes += r.minutes
    map.set(r.driverId, t)
  }
  return [...map.values()]
}

/** PTO-eligible drivers first, then the rest, each A to Z. */
export function sortDriversForPto<T extends { name: string; ptoEligible?: boolean | null }>(drivers: readonly T[]): T[] {
  return [...drivers].sort((a, b) => Number(b.ptoEligible === true) - Number(a.ptoEligible === true) || a.name.localeCompare(b.name))
}
