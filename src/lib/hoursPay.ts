/**
 * Hourly pay for the Ivan drivers' time cards. Staff-side only.
 *
 * NO PAY RATE MAY REACH THE DRIVER APP. This module, `hourlyRate` and `hourlyRateHistory`
 * are read only by the staff Employee Hours page and the driver pay settings modal; the
 * driver API never reads them (a test fails the build if the names appear under
 * src/features/driver-app or amplify/functions/driver-app-api).
 *
 * A rate is dollars per hour. `hourlyRate` is the CURRENT rate and `hourlyRateHistory` holds
 * the windows that came before it, half-open [from, until) like rateHistory, so a raise
 * never rewrites a period already paid: a day takes the window that contains it, else the
 * current rate. A window with a null rate is time before any rate was entered.
 *
 * No overtime: a day's pay is its paid minutes (worked + PTO + holiday) at that day's rate.
 */

export interface HourlyRateWindow {
  /** First day the rate applied, YYYY-MM-DD. */
  from: string
  /** First day it no longer applied (the day the next rate began). */
  until: string
  /** Null: no rate had been entered yet. */
  hourlyRate: number | null
  /** Who ended this window and when, for the audit trail. */
  endedBy?: string
  endedAt?: string
}

export interface HourlyRateSetting {
  hourlyRate?: number | null
  hourlyRateHistory?: HourlyRateWindow[] | null
}

const EPOCH = '1970-01-01'

const validRate = (r: unknown): r is number => typeof r === 'number' && Number.isFinite(r) && r > 0

function windows(setting: HourlyRateSetting): HourlyRateWindow[] {
  return [...(setting.hourlyRateHistory ?? [])].sort((a, b) => a.from.localeCompare(b.from))
}

/** The rate in effect on a day, or null when none had been set. */
export function rateOn(setting: HourlyRateSetting, date: string): number | null {
  const hit = windows(setting).find((w) => w.from <= date && date < w.until)
  const rate = hit ? hit.hourlyRate : (setting.hourlyRate ?? null)
  return validRate(rate) ? rate : null
}

/** The day the current rate began: where the last past window ended, or null when it has no start. */
export function currentRateFrom(setting: HourlyRateSetting): string | null {
  const w = windows(setting)
  return w.length ? w[w.length - 1].until : null
}

/**
 * The fields to save for a new current rate effective from a day. The old rate's window is
 * closed on that day (kept, with who and when); a rate may not start on or before a day that
 * a past window already covers, since that would rewrite paid time. Re-entering the date the
 * current rate began corrects it in place. The first rate alone may move to any date, since
 * nothing was paid before it.
 */
export function withRateChange(
  setting: HourlyRateSetting,
  newRate: number,
  effectiveFrom: string,
  by: string,
  at: string,
): { hourlyRate: number; hourlyRateHistory: HourlyRateWindow[] } {
  if (!validRate(newRate)) throw new Error('Enter a rate above $0 an hour.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new Error('Pick the date the rate starts.')
  const history = windows(setting)
  const began = currentRateFrom(setting)
  // The FIRST rate has nothing paid before it (its only window is the unrated stretch), so its
  // start date can be moved either way: a mistyped first date must be fixable from the editor.
  // Same rate on another date, or any rate on or before where it began, is that correction;
  // a different rate from a later date is a raise like any other.
  const onlyUnrated = history.length === 1 && history[0].from === EPOCH && history[0].hourlyRate === null
  if (onlyUnrated && validRate(setting.hourlyRate) && (newRate === setting.hourlyRate || effectiveFrom <= history[0].until)) {
    return { hourlyRate: newRate, hourlyRateHistory: [{ ...history[0], until: effectiveFrom, endedBy: by, endedAt: at }] }
  }
  if (began !== null && effectiveFrom < began) {
    throw new Error(`The current rate began ${began}; a new one cannot start before that without rewriting paid time.`)
  }
  if (began !== null && effectiveFrom === began) return { hourlyRate: newRate, hourlyRateHistory: history }
  const old = validRate(setting.hourlyRate) ? setting.hourlyRate : null
  return {
    hourlyRate: newRate,
    hourlyRateHistory: [...history, { from: began ?? EPOCH, until: effectiveFrom, hourlyRate: old, endedBy: by, endedAt: at }],
  }
}

export interface DayPaid {
  date: string
  /** Paid minutes that day: worked + PTO + holiday. */
  minutes: number
}

export interface PeriodPay {
  totalMinutes: number
  /** Dollars, rounded to cents once over the whole period. Null when no paid minute had a rate. */
  pay: number | null
  /** The rate on the period's last day (what the table shows), null if none. */
  rate: number | null
  /** More than one rate applied inside the period. */
  mixedRates: boolean
  /** Some paid minutes had no rate, so pay covers only the rated ones. */
  partial: boolean
}

/** A period's pay: each day's minutes at the rate in effect that day, summed, rounded once. */
export function payForPeriod(days: readonly DayPaid[], setting: HourlyRateSetting): PeriodPay {
  let cents = 0
  let rated = 0
  let unrated = 0
  const seen = new Set<number>()
  for (const d of days) {
    if (d.minutes <= 0) continue
    const rate = rateOn(setting, d.date)
    if (rate === null) { unrated += d.minutes; continue }
    cents += (d.minutes / 60) * rate * 100
    rated += d.minutes
    seen.add(rate)
  }
  const last = days.length ? days[days.length - 1].date : null
  return {
    totalMinutes: rated + unrated,
    pay: rated > 0 ? Math.round(cents) / 100 : null,
    rate: last ? rateOn(setting, last) : null,
    mixedRates: seen.size > 1,
    partial: rated > 0 && unrated > 0,
  }
}

/** "$1,234.50", or an em dash for no figure (never "$0.00" for a missing rate). */
export function money(amount: number | null): string {
  return amount === null ? '—' : amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
