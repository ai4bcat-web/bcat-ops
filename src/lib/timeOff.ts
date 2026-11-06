/**
 * Time off, in hours, that a driver asks for and the office approves.
 *
 * One row per request in DriverAvailability. Rows the office typed in on /time-off are
 * APPROVED from the start; rows a driver sends from the app are PENDING until reviewed. A
 * row written before requests existed has no status and reads as APPROVED, so the calendar
 * keeps showing everything it always showed.
 *
 * PTO is the one type that also moves hours: approving it creates the day's 480-minute
 * TimeClockEntry (see ptoRowFor), and the year-to-date count is those rows.
 *
 * Shared by the driver API (which validates and writes), the phone form and the admin page.
 */
import { STANDARD_DAY_MINUTES } from './timeClock'

export type TimeOffType = 'FULL_DAY_OFF' | 'EARLY_START' | 'LATE_START' | 'PTO'
export type TimeOffStatus = 'PENDING' | 'APPROVED' | 'DENIED'

export const TIME_OFF_TYPES: readonly TimeOffType[] = ['FULL_DAY_OFF', 'EARLY_START', 'LATE_START', 'PTO']

/** A PTO day is always eight hours, whatever the form said. */
export const PTO_HOURS = STANDARD_DAY_MINUTES / 60
/** A PTO day can be asked for this far back and this far ahead of today. */
export const PTO_DAYS_BACK = 30
export const PTO_DAYS_AHEAD = 14
/** A single request covers at most this many calendar days. */
export const MAX_REQUEST_DAYS = 31

export interface TimeOffLike {
  type: string
  startDate: string
  endDate: string
  status?: string | null
}

/** Rows without a status predate requests: they are the office's own entries, so APPROVED. */
export function statusOf(r: { status?: string | null }): TimeOffStatus {
  return r.status === 'PENDING' || r.status === 'DENIED' ? r.status : 'APPROVED'
}

/** What the calendar, planner and fleet dashboard may show: approved days only. */
export function isApproved(r: { status?: string | null }): boolean {
  return statusOf(r) === 'APPROVED'
}

const DAY_MS = 86_400_000
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS)

export function addDaysISO(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

export function daysInRange(start: string, end: string): number {
  return dayNumber(end) - dayNumber(start) + 1
}

/** True when two inclusive date ranges share a day. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

/** "Nov 10" or "Nov 10 – Nov 12". */
export function describeRange(start: string, end: string): string {
  const fmt = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`
}

/** The PENDING or APPROVED row a new request would collide with, if any. DENIED rows never block. */
export function overlappingRequest<T extends TimeOffLike>(existing: readonly T[], start: string, end: string): T | null {
  return existing.find((r) => statusOf(r) !== 'DENIED' && rangesOverlap(r.startDate, r.endDate, start, end)) ?? null
}

/** Calendar days in the year the date falls in, as 'YYYY'. */
export const yearOf = (iso: string): string => iso.slice(0, 4)

/** How many PTO days a driver has used in a calendar year: one row is one day. */
export function ptoDaysUsed(rows: ReadonlyArray<{ kind: string; workDate: string }>, year: string): number {
  return rows.filter((r) => r.kind === 'PTO' && r.workDate.startsWith(year)).length
}

export interface TimeOffInput {
  type?: unknown
  startDate?: unknown
  endDate?: unknown
  hours?: unknown
  note?: unknown
}

export interface ValidTimeOff {
  type: TimeOffType
  startDate: string
  endDate: string
  hours: number
  note: string | null
}

/**
 * The one set of rules for a driver's request, applied by the form before it sends and
 * by the API before it writes. `today` is the Chicago day; `ptoEligible` is the driver's flag.
 */
export function validateTimeOffRequest(
  input: TimeOffInput,
  today: string,
  ptoEligible: boolean,
): { ok: true; value: ValidTimeOff } | { ok: false; error: string } {
  const type = TIME_OFF_TYPES.find((t) => t === input.type)
  if (!type) return { ok: false, error: 'Pick what you are asking for.' }
  if (type === 'PTO' && !ptoEligible) return { ok: false, error: 'PTO is not set up for you.' }

  const iso = /^\d{4}-\d{2}-\d{2}$/
  const startDate = typeof input.startDate === 'string' ? input.startDate : ''
  const endDate = typeof input.endDate === 'string' && input.endDate ? input.endDate : startDate
  if (!iso.test(startDate) || !iso.test(endDate)) return { ok: false, error: 'Pick the date.' }
  if (endDate < startDate) return { ok: false, error: 'The last day cannot be before the first day.' }

  let hours: number
  if (type === 'PTO') {
    if (startDate !== endDate) return { ok: false, error: 'PTO is one day at a time.' }
    if (startDate < addDaysISO(today, -PTO_DAYS_BACK) || startDate > addDaysISO(today, PTO_DAYS_AHEAD)) {
      return { ok: false, error: `PTO can be requested from ${PTO_DAYS_BACK} days back to ${PTO_DAYS_AHEAD} days ahead.` }
    }
    hours = PTO_HOURS
  } else {
    if (startDate < today) return { ok: false, error: 'Time off has to start today or later.' }
    const days = daysInRange(startDate, endDate)
    if (days > MAX_REQUEST_DAYS) return { ok: false, error: `Ask for ${MAX_REQUEST_DAYS} days or fewer at a time.` }
    hours = typeof input.hours === 'number' ? input.hours : Number(input.hours)
    if (!Number.isFinite(hours) || hours <= 0) return { ok: false, error: 'Say how many hours.' }
    if (hours > 24 * days) return { ok: false, error: 'That is more hours than the days hold.' }
    hours = Math.round(hours * 4) / 4
  }
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : null
  return { ok: true, value: { type, startDate, endDate, hours, note } }
}

/** The TimeClockEntry an approved PTO day becomes: 480 minutes on that day, staff-sourced. */
export function ptoRowFor(driverId: string, date: string, approvedBy: string, id: string, now: string) {
  return {
    id,
    driverId,
    workDate: date,
    kind: 'PTO' as const,
    clockInAt: null,
    clockOutAt: null,
    minutes: STANDARD_DAY_MINUTES,
    note: `PTO approved by ${approvedBy}`,
    source: 'STAFF' as const,
    __typename: 'TimeClockEntry',
    createdAt: now,
    updatedAt: now,
  }
}
