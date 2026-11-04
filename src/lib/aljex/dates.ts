/**
 * Aljex dates: `MM/DD/YY` (two-digit year, no zone) and `HH:MM` times.
 *
 * Storage conventions (plan §4.2, ALJEX_MAPPING.md §4.1):
 *  - date-only business dates (invoice, paid, bill) are `YYYY-MM-DD` strings;
 *  - an appointment day without a time is **Chicago midnight** (the app's `fromDateInput`);
 *  - ledger timestamps made from a date-only source (`receivedAt`, `paidAt`, `issuedAt`) are noon UTC.
 */
import { fromDateInput, fromDateTimeInput } from '../date'
import type { CanonicalRow } from './canonical'

/** Two-digit years below this pivot are 20yy, the rest 19yy (so `70` is 1970: flagged junk, never coerced). */
export const YEAR_PIVOT = 70
/** A calendar-valid date outside this year range is junk (mapping doc §4.1). */
export const MIN_PLAUSIBLE_YEAR = 2000
export const MAX_PLAUSIBLE_YEAR = 2035

export interface DateParse {
  /** Calendar-valid date (even if junk), else null. */
  parsed: string | null
  /** Parsed date inside the plausible year range, else null: the value to use. */
  date: string | null
  /** True when the cell was non-blank but not a usable date. */
  junk: boolean
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function calendarValid(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return d <= dim[m - 1]
}

/** Parse `MM/DD/YY`, `MM/DD/YYYY` or `YYYY-MM-DD`. Blank is not junk. */
export function parseAljexDate(text: string | null | undefined): DateParse {
  const s = String(text ?? '').trim()
  if (s === '') return { parsed: null, date: null, junk: false }
  let y: number
  let m: number
  let d: number
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s)
  if (match) {
    m = Number(match[1])
    d = Number(match[2])
    y = Number(match[3])
    if (match[3].length === 2) y += y < YEAR_PIVOT ? 2000 : 1900
  } else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
    y = Number(match[1])
    m = Number(match[2])
    d = Number(match[3])
  } else return { parsed: null, date: null, junk: true }
  if (!calendarValid(y, m, d)) return { parsed: null, date: null, junk: true }
  const iso = `${pad(y, 4)}-${pad(m)}-${pad(d)}`
  const plausible = y >= MIN_PLAUSIBLE_YEAR && y <= MAX_PLAUSIBLE_YEAR
  return { parsed: iso, date: plausible ? iso : null, junk: !plausible }
}

/** `HH:MM`, `H:MM`, `HHMM`, `H:MM AM/PM` -> `HH:MM` (24h), else null. */
export function parseAljexTime(text: string | null | undefined): string | null {
  const s = String(text ?? '').trim().toUpperCase()
  if (!s) return null
  const m = /^(\d{1,2}):?(\d{2})(?::\d{2})?\s*(AM|PM)?$/.exec(s)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2])
  if (m[3] === 'PM' && h < 12) h += 12
  if (m[3] === 'AM' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return `${pad(h)}:${pad(min)}`
}

/** Chicago midnight of a `YYYY-MM-DD` day as an ISO instant (not the UTC-midnight shift of the old importer). */
export function chicagoMidnightIso(date: string): string {
  return fromDateInput(date)
}

/** `YYYY-MM-DD` + `HH:MM` local Chicago time as an ISO instant. */
export function chicagoDateTimeIso(date: string, time: string): string {
  return fromDateTimeInput(`${date}T${time}`)
}

/** 12:00:00Z of the day: the ledger convention for timestamps built from a date-only source. */
export function noonUtcIso(date: string): string {
  return `${date}T12:00:00.000Z`
}

export interface DateWindow {
  start: string
  end: string
}

/** Lexicographic compare is exact for YYYY-MM-DD. */
export function isPlausibleDate(date: string | null | undefined, window: DateWindow | null): boolean {
  if (!date) return false
  if (!window) return true
  return date >= window.start && date <= window.end
}

/** Add whole months to a YYYY-MM-DD (day clamped to the month length). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${pad(ny, 4)}-${pad(nm)}-${pad(Math.min(d, dim))}`
}

/** Add whole days (UTC calendar arithmetic) to a YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Window derived from the file itself: min/max Created Date +- 1 year. No wall clock, no cutoff. Null when there is no created date. */
export function derivedWindow(createdDates: Iterable<string | null | undefined>): DateWindow | null {
  let min: string | null = null
  let max: string | null = null
  for (const d of createdDates) {
    if (!d) continue
    if (min === null || d < min) min = d
    if (max === null || d > max) max = d
  }
  return min && max ? { start: addMonths(min, -12), end: addMonths(max, 12) } : null
}

export type PickupDateSource = 'SHIP_DATE' | 'DELIVERED' | 'DELIVERY_APPT' | 'CREATED' | 'NONE'

/**
 * The load's pickup day: a plausible `Ship Date`, else (in order) the plausible Delivered Date,
 * Delivery Appt Date, Created Date; none -> undated (`date: null`, so the date index keys are
 * omitted rather than written empty).
 */
export function resolvePickupDate(
  row: Pick<CanonicalRow, 'dates'>,
  window: DateWindow | null,
): { date: string | null; source: PickupDateSource } {
  const chain: Array<[string | null, PickupDateSource]> = [
    [row.dates.ship, 'SHIP_DATE'],
    [row.dates.delivered, 'DELIVERED'],
    [row.dates.deliveryAppt, 'DELIVERY_APPT'],
    [row.dates.created, 'CREATED'],
  ]
  for (const [date, source] of chain) if (isPlausibleDate(date, window)) return { date, source }
  return { date: null, source: 'NONE' }
}
