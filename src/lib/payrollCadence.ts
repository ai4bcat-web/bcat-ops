/**
 * Payroll cadence — a LABEL, never pay math. BCAT pays every Wednesday for the Sunday–Saturday week
 * that closed four days earlier. Nothing here feeds a settlement, a pay period or a pay history row.
 * All calendar arithmetic runs on YYYY-MM-DD at UTC noon so neither the viewer's time zone nor a
 * DST change can move a date; "today" is the America/Chicago calendar day.
 */
import { chicagoDateStr } from './date'

/** 0 = Sunday … 3 = Wednesday. */
export const PAY_WEEKDAY = 3
/** The paid week ends (Saturday) this many days before the pay date. */
export const PAY_LAG_DAYS = 4

export interface PayCadence {
  /** Next Wednesday on or after today, YYYY-MM-DD. */
  nextPayDate: string
  isToday: boolean
  /** The Sunday that opens the week this pay date covers. */
  periodStart: string
  /** The Saturday that closes it. */
  periodEnd: string
  label: string
}

const atNoon = (ymd: string) => new Date(`${ymd}T12:00:00Z`)
const ymdOf = (d: Date) => d.toISOString().slice(0, 10)
const shift = (ymd: string, days: number) => ymdOf(new Date(atNoon(ymd).getTime() + days * 86_400_000))

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const dayLabel = (ymd: string) => `${WEEKDAY.format(atNoon(ymd))} ${MONTH_DAY.format(atNoon(ymd))}`

export function payCadence(now: Date): PayCadence {
  const today = chicagoDateStr(now)
  const ahead = (PAY_WEEKDAY - atNoon(today).getUTCDay() + 7) % 7
  const nextPayDate = shift(today, ahead)
  const periodEnd = shift(nextPayDate, -PAY_LAG_DAYS)
  const periodStart = shift(periodEnd, -6)
  const isToday = ahead === 0
  const label = [
    'Payroll runs every Wednesday',
    isToday ? 'Pay date is today' : `Next pay date ${dayLabel(nextPayDate)}`,
    `Covers ${dayLabel(periodStart)} – ${dayLabel(periodEnd)}`,
  ].join(' · ')
  return { nextPayDate, isToday, periodStart, periodEnd, label }
}
