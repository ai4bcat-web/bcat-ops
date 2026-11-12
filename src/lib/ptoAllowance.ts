/**
 * PTO allowance by length of service: 5 days once a driver has a year with us, 10 once they have two.
 *
 * A benefit year runs from a hire anniversary to the day before the next one, and its allowance is the
 * tier reached on its first day. So the first year of service has none, the second has 5, and the third
 * onward has 10. A Feb 29 hire has the Feb 28 as the anniversary in years without one.
 */
import { addDaysISO } from './timeOff'

export const PTO_MINUTES_PER_DAY = 480

export interface PtoBalance {
  /** Whole benefit years since hire at the start of this one (0 = still in the first year of service). */
  serviceYears: number
  allowance: number
  /** First and last day of the benefit year. */
  start: string
  end: string
  used: number
  remaining: number
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

function anniversary(hire: string, n: number): string {
  const m = ISO.exec(hire)!
  const y = Number(m[1]) + n
  const month = m[2]
  let day = m[3]
  if (month === '02' && day === '29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) day = '28'
  return `${String(y).padStart(4, '0')}-${month}-${day}`
}

export function validHireDate(hire: string | null | undefined): hire is string {
  if (!hire || !ISO.test(hire)) return false
  return !Number.isNaN(new Date(`${hire}T12:00:00Z`).getTime())
}

export function allowanceForServiceYears(years: number): number {
  return years >= 2 ? 10 : years >= 1 ? 5 : 0
}

/** The benefit year holding `date`, or null with no usable hire date or a date before hire. */
export function benefitYearOf(hire: string | null | undefined, date: string): { serviceYears: number; allowance: number; start: string; end: string } | null {
  if (!validHireDate(hire) || date < hire) return null
  let n = Math.max(0, Number(date.slice(0, 4)) - Number(hire.slice(0, 4)))
  while (n > 0 && anniversary(hire, n) > date) n -= 1
  while (anniversary(hire, n + 1) <= date) n += 1
  return { serviceYears: n, allowance: allowanceForServiceYears(n), start: anniversary(hire, n), end: addDaysISO(anniversary(hire, n + 1), -1) }
}

/** Days used in the benefit year holding `date`; half a day counts as 0.5. `rows` are any PTO rows for the driver. */
export function ptoBalance(
  hire: string | null | undefined,
  date: string,
  rows: ReadonlyArray<{ workDate: string; minutes: number }>,
): PtoBalance | null {
  const by = benefitYearOf(hire, date)
  if (!by) return null
  const used = Math.round(rows.filter((r) => r.workDate >= by.start && r.workDate <= by.end).reduce((s, r) => s + r.minutes / PTO_MINUTES_PER_DAY, 0) * 100) / 100
  return { ...by, used, remaining: Math.round((by.allowance - used) * 100) / 100 }
}

export function formatDays(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}`
}
