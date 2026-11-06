/**
 * Pure pieces of the Employee Hours view: how hours read on screen, what the summary bar and
 * footer total, which days earn a warning chip, and the payroll CSV.
 */
import { decimalHours, clockEdges, type DayTotal, type TruckDayWindow, type PayPeriodTotal } from './timeClock'
import type { PeriodPay } from './hoursPay'

/** How far a time card may differ from the truck's first/last move before the day is flagged. */
export const MOTIVE_GAP_TOLERANCE_MIN = 60

/** Minutes as clock hours: 495 -> "8:15", 0 -> "0:00". The decimal sits beneath it on screen. */
export function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/** What is wrong with a day, for the warning chip: still on the clock, or clock far from the truck. */
export function dayWarning(day: DayTotal, truck: TruckDayWindow | null | undefined): 'open' | 'gap' | null {
  if (day.open) return 'open'
  const e = clockEdges(day, truck)
  const far = (m: number | null) => m != null && m > MOTIVE_GAP_TOLERANCE_MIN
  return far(e.earlyInMinutes) || far(e.lateOutMinutes) ? 'gap' : null
}

export interface DriverHoursRow {
  driverId: string
  name: string
  period: PayPeriodTotal
  /** Null when the viewer may not see pay. */
  pay: PeriodPay | null
}

export interface HoursTotals {
  drivers: number
  workedMinutes: number
  ptoMinutes: number
  holidayMinutes: number
  totalMinutes: number
  /** Dollars across drivers that have a rate; null when none do (or pay is hidden). */
  totalPay: number | null
}

/** The summary bar and the footer row: the same sums, so the two can never disagree. */
export function totalsOf(rows: readonly DriverHoursRow[]): HoursTotals {
  const rated = rows.filter((r) => r.pay?.pay != null)
  return {
    drivers: rows.length,
    workedMinutes: rows.reduce((n, r) => n + r.period.workedMinutes, 0),
    ptoMinutes: rows.reduce((n, r) => n + r.period.ptoMinutes, 0),
    holidayMinutes: rows.reduce((n, r) => n + r.period.holidayMinutes, 0),
    totalMinutes: rows.reduce((n, r) => n + r.period.totalMinutes, 0),
    // Summed in cents so ten drivers never accumulate float dust.
    totalPay: rated.length ? Math.round(rated.reduce((n, r) => n + Math.round((r.pay!.pay as number) * 100), 0)) / 100 : null,
  }
}

const csvCell = (v: string | number | null): string => {
  const s = v === null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The period summary for payroll: one line per driver, decimal hours, and pay when allowed. */
export function periodCsv(rows: readonly DriverHoursRow[], showPay: boolean): string {
  const head = ['Driver', 'Worked hrs', 'PTO hrs', 'Holiday hrs', 'Total hrs', ...(showPay ? ['Rate ($/hr)', '2-week pay'] : [])]
  const lines = rows.map((r) => [
    r.name,
    decimalHours(r.period.workedMinutes),
    decimalHours(r.period.ptoMinutes),
    decimalHours(r.period.holidayMinutes),
    decimalHours(r.period.totalMinutes),
    ...(showPay ? [r.pay?.rate ?? null, r.pay?.pay ?? null] : []),
  ])
  return [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\n') + '\n'
}
