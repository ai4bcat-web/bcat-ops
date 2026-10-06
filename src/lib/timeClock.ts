/**
 * The employee time clock: weeks, paid holidays, and what a day is worth.
 *
 * Shared by the driver app, the staff hours page and the API, so all three agree about
 * which week a day falls in and what a week totals — three copies of that arithmetic is
 * three different answers to "how many hours did I work".
 *
 * NO OVERTIME. Hours are hours: a week is the plain sum of its days with no multiplier and
 * no 40-hour threshold. This is deliberate and was specified; if that ever changes it
 * changes here and nowhere else.
 *
 * Weeks run MONDAY to SUNDAY, matching the owner-operator settlement week already in BCAT
 * Ops so the hours page and the pay pages line up.
 *
 * Days are Chicago calendar days. A driver who clocks in at 23:30 and out at 00:30 worked
 * an hour on the day they started — the workDate on the row decides, not the timestamp.
 */

export type TimeClockKind = 'WORK' | 'HOLIDAY' | 'PTO'

export interface TimeClockRow {
  id: string
  driverId: string
  /** Chicago calendar day, YYYY-MM-DD. */
  workDate: string
  kind: TimeClockKind
  clockInAt?: string | null
  clockOutAt?: string | null
  minutes?: number | null
  note?: string | null
  source?: 'DRIVER' | 'STAFF' | null
  correctedBy?: string | null
  correctedAt?: string | null
  originalMinutes?: number | null
}

/** A standard paid day when someone takes a holiday or PTO. */
export const STANDARD_DAY_MINUTES = 8 * 60

/**
 * The paid holidays, as agreed: the standard six.
 *
 * Fixed-date holidays are a month/day; the floating ones are computed. Offered as a list a
 * driver picks from rather than a free-text box, so "Thanksgiving", "thanksgiving" and
 * "Turkey day" cannot become three different holidays on one payroll.
 */
export const PAID_HOLIDAYS = [
  { key: 'NEW_YEARS', label: "New Year's Day" },
  { key: 'MEMORIAL', label: 'Memorial Day' },
  { key: 'JULY_4', label: 'Independence Day' },
  { key: 'LABOR', label: 'Labor Day' },
  { key: 'THANKSGIVING', label: 'Thanksgiving' },
  { key: 'CHRISTMAS', label: 'Christmas Day' },
] as const

export type PaidHolidayKey = (typeof PAID_HOLIDAYS)[number]['key']

/** Noon UTC, so a date never slips a day under any timezone arithmetic. */
function atNoon(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00Z`)
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * The Monday of the week containing this date.
 *
 * getUTCDay() is 0 for Sunday, so Sunday belongs to the week that STARTED six days earlier
 * rather than the one about to begin — the off-by-one that puts a Sunday shift on the wrong
 * paycheck.
 */
export function weekStartOf(dateStr: string): string {
  const d = atNoon(dateStr)
  const dow = d.getUTCDay()
  const backToMonday = dow === 0 ? 6 : dow - 1
  d.setUTCDate(d.getUTCDate() - backToMonday)
  return toDateStr(d)
}

/** The Sunday that closes the week this date is in. */
export function weekEndOf(dateStr: string): string {
  const d = atNoon(weekStartOf(dateStr))
  d.setUTCDate(d.getUTCDate() + 6)
  return toDateStr(d)
}

/** The seven days of a week, Monday first. */
export function weekDays(weekStart: string): string[] {
  const start = atNoon(weekStart)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setUTCDate(d.getUTCDate() + i)
    return toDateStr(d)
  })
}

/** The N most recent week starts, newest first, including the one `today` is in. */
export function recentWeekStarts(today: string, count: number): string[] {
  const start = atNoon(weekStartOf(today))
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    const d = new Date(start)
    d.setUTCDate(d.getUTCDate() - i * 7)
    return toDateStr(d)
  })
}

/**
 * Paid minutes on one row.
 *
 * The stored `minutes` wins whenever it is present, because a staff correction may set
 * hours the raw timestamps no longer explain — a missed clock-out, a break taken off — and
 * the corrected figure is the one payroll uses. Falling back to the timestamps is only for
 * a row that has never been totalled.
 *
 * An open shift (clocked in, not yet out) is worth NOTHING rather than counting up to now.
 * A running total that grows while a driver is at lunch is a number nobody can reconcile,
 * and a forgotten clock-out would otherwise quietly bill a 14-hour day.
 */
export function rowMinutes(row: TimeClockRow): number {
  if (typeof row.minutes === 'number' && Number.isFinite(row.minutes)) {
    return Math.max(0, Math.round(row.minutes))
  }
  if (row.kind === 'HOLIDAY' || row.kind === 'PTO') return STANDARD_DAY_MINUTES
  if (!row.clockInAt || !row.clockOutAt) return 0
  const start = Date.parse(row.clockInAt)
  const end = Date.parse(row.clockOutAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.round((end - start) / 60_000)
}

/** True while a shift is running — clocked in with no clock-out yet. */
export function isOpenShift(row: TimeClockRow): boolean {
  return row.kind === 'WORK' && !!row.clockInAt && !row.clockOutAt
}

export interface DayTotal {
  date: string
  workedMinutes: number
  holidayMinutes: number
  ptoMinutes: number
  totalMinutes: number
  /** A shift is still running on this day. */
  open: boolean
  rows: TimeClockRow[]
}

export interface WeekTotal {
  weekStart: string
  weekEnd: string
  days: DayTotal[]
  workedMinutes: number
  holidayMinutes: number
  ptoMinutes: number
  /** Everything paid, which with no overtime is simply the sum. */
  totalMinutes: number
  open: boolean
}

/** A week's worth of rows, bucketed by day. Days with nothing on them are still present. */
export function summarizeWeek(weekStart: string, rows: TimeClockRow[]): WeekTotal {
  const start = weekStartOf(weekStart)
  const dates = weekDays(start)
  const inWeek = new Set(dates)

  const days: DayTotal[] = dates.map((date) => {
    const dayRows = rows.filter((r) => r.workDate === date)
    let worked = 0
    let holiday = 0
    let pto = 0
    for (const r of dayRows) {
      const m = rowMinutes(r)
      if (r.kind === 'HOLIDAY') holiday += m
      else if (r.kind === 'PTO') pto += m
      else worked += m
    }
    return {
      date,
      workedMinutes: worked,
      holidayMinutes: holiday,
      ptoMinutes: pto,
      totalMinutes: worked + holiday + pto,
      open: dayRows.some(isOpenShift),
      rows: dayRows,
    }
  })

  // Rows outside the week are ignored rather than quietly folded into it.
  void inWeek

  return {
    weekStart: start,
    weekEnd: weekEndOf(start),
    days,
    workedMinutes: days.reduce((n, d) => n + d.workedMinutes, 0),
    holidayMinutes: days.reduce((n, d) => n + d.holidayMinutes, 0),
    ptoMinutes: days.reduce((n, d) => n + d.ptoMinutes, 0),
    totalMinutes: days.reduce((n, d) => n + d.totalMinutes, 0),
    open: days.some((d) => d.open),
  }
}

/** "8h 15m". Zero reads "0h 0m" rather than blank — a zero day is a fact, not a gap. */
export function minutesLabel(total: number): string {
  const m = Math.max(0, Math.round(total))
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Decimal hours for payroll. Two places, which is what a pay rate multiplies cleanly. */
export function decimalHours(minutes: number): number {
  return Math.round((Math.max(0, minutes) / 60) * 100) / 100
}


/* ── Motive cross-check ────────────────────────────────────────────────────── */

export interface MotiveDayWindow {
  /** First time the driver went on duty that day, ISO. */
  firstOnDutyAt: string | null
  /** Last time they came off it, ISO. Null while the day is still running. */
  lastOffDutyAt: string | null
  /** Driving + on-duty seconds Motive recorded. */
  workedSeconds: number
}

export type MotiveCheck =
  /** Motive and the time card agree within tolerance. */
  | { state: 'MATCH'; diffMinutes: number }
  /** They differ by more than tolerance — a human should look. */
  | { state: 'GAP'; diffMinutes: number }
  /** Nothing from Motive for that day, or the driver is not linked. */
  | { state: 'NO_DATA' }
  /** The shift has not been closed yet, so there is nothing to compare. */
  | { state: 'OPEN' }

/** Beyond this much difference the day is worth a human's attention. */
export const MOTIVE_TOLERANCE_MINUTES = 60

/**
 * Compare one day's time card against what the truck's ELD recorded.
 *
 * A cross-check, deliberately NOT a correction. The two measure different things: a driver
 * doing paperwork or waiting at a dock is on the clock while the truck records nothing, and
 * a truck left idling records time nobody worked. So a difference is surfaced for somebody
 * to look at and never used to overwrite a card — the card is what payroll pays, and only a
 * person may change it.
 *
 * An open shift compares to nothing, because the card has no total yet.
 */
export function compareToMotive(
  day: DayTotal,
  motive: MotiveDayWindow | null | undefined,
): MotiveCheck {
  if (day.open) return { state: 'OPEN' }
  if (!motive || (!motive.firstOnDutyAt && motive.workedSeconds <= 0)) return { state: 'NO_DATA' }

  const motiveMinutes = Math.round(motive.workedSeconds / 60)
  const diff = day.totalMinutes - motiveMinutes
  return Math.abs(diff) > MOTIVE_TOLERANCE_MINUTES
    ? { state: 'GAP', diffMinutes: diff }
    : { state: 'MATCH', diffMinutes: diff }
}
