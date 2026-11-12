/**
 * PTO allowance by length of service, counted in calendar years.
 *
 * A driver's PTO starts on January 1 of the first calendar year after they finish a year with us:
 * 5 days that year. It rises to 10 on January 1 of the first calendar year after they finish two years,
 * and stays 10. Hired 2025-06-10: one year is up 2026-06-10, so 5 days from 2027-01-01; two years are
 * up 2027-06-10, so 10 days from 2028-01-01. Nothing in 2026. A Feb 29 hire has the Feb 28 as the
 * anniversary in years without one.
 */
export const PTO_MINUTES_PER_DAY = 480

export interface PtoBalance {
  /** Calendar year the balance is for. */
  year: string
  allowance: number
  /** January 1 and December 31 of that year. */
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

/**
 * A driver whose file still needs a hire date: active, not a broker, no usable date, and one who earns PTO
 * (an employee on the Ivan roster, fleetGroup LOCAL, or anyone marked PTO eligible). Contractors
 * (Amazon, owner operator, box truck) do not earn PTO, so they are never flagged unless marked eligible.
 */
export function needsHireDate(d: { active?: boolean | null; type?: string | null; fleetGroup?: string | null; ptoEligible?: boolean | null; hireDate?: string | null }): boolean {
  if (d.active === false || d.type === 'broker') return false
  if (validHireDate(d.hireDate)) return false
  return d.fleetGroup === 'LOCAL' || d.ptoEligible === true
}

/** First calendar year with 5 days and first with 10, or null without a usable hire date. */
export function ptoStartYears(hire: string | null | undefined): { five: number; ten: number } | null {
  if (!validHireDate(hire)) return null
  return { five: Number(anniversary(hire, 1).slice(0, 4)) + 1, ten: Number(anniversary(hire, 2).slice(0, 4)) + 1 }
}

/** Days of PTO a driver has in a calendar year; 0 before they qualify or without a hire date. */
export function ptoAllowanceForYear(hire: string | null | undefined, year: number | string): number {
  const s = ptoStartYears(hire)
  const y = Number(year)
  if (!s) return 0
  return y >= s.ten ? 10 : y >= s.five ? 5 : 0
}

/** The January 1 their PTO first starts, or null without a usable hire date. */
export function ptoStartDate(hire: string | null | undefined): string | null {
  const s = ptoStartYears(hire)
  return s ? `${s.five}-01-01` : null
}

/** Rough "in 6 days", "in 7 weeks", "in 5 months" from `from` to `to` (both YYYY-MM-DD). */
export function untilLabel(from: string, to: string): string {
  const days = Math.max(0, Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000))
  if (days < 14) return `in ${days} ${days === 1 ? 'day' : 'days'}`
  if (days < 70) return `in ${Math.round(days / 7)} weeks`
  const months = Math.round(days / 30.44)
  return months < 24 ? `in ${months} months` : `in ${Math.round(months / 12)} years`
}

/**
 * Days used in the calendar year holding `date` against that year's allowance; half a day counts as 0.5.
 * `rows` are any PTO rows for the driver. Null without a usable hire date.
 */
export function ptoBalance(
  hire: string | null | undefined,
  date: string,
  rows: ReadonlyArray<{ workDate: string; minutes: number }>,
): PtoBalance | null {
  if (!validHireDate(hire)) return null
  const year = date.slice(0, 4)
  const start = `${year}-01-01`
  const end = `${year}-12-31`
  const allowance = ptoAllowanceForYear(hire, year)
  const used = Math.round(rows.filter((r) => r.workDate >= start && r.workDate <= end).reduce((sum, r) => sum + r.minutes / PTO_MINUTES_PER_DAY, 0) * 100) / 100
  return { year, allowance, start, end, used, remaining: Math.round((allowance - used) * 100) / 100 }
}

export function formatDays(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}`
}
