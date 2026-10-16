/**
 * Driver leaderboard math — who ran the most hours (Ivan local) and who grossed the most
 * (owner-operators, box truck) in a period. Pure, so the dashboard widget stays a renderer.
 *
 * Each program keeps its OWN calendar, because that is how the pay pages already cut time:
 *   • Ivan local hours — Monday→Sunday time-clock weeks (src/lib/timeClock.ts)
 *   • Owner-operators  — Sunday→Saturday settlement weeks (src/features/driver-pay/week.ts)
 *   • Box truck        — 14-day Wednesday→Tuesday pay periods (src/lib/biweekly.ts)
 * "This week" on the leaderboard is the period of each kind that contains the reference day.
 */
import { rowMinutes, decimalHours, type TimeClockRow } from './timeClock'
import { getStops } from './stops'
import { chicagoDateStr } from './date'
import type { Load, Stop } from '@/types'

export interface LeaderRow {
  driverId: string
  name: string
  colorKey?: string | null
  /** Hours (local) or gross dollars (settlement programs). */
  value: number
  /** Loads settled (gross boards) or days worked (hours board). */
  count: number
}

interface DriverLike { id: string; name: string; colorKey?: string | null }

/** Rank descending by value; ties keep name order so the board is stable between renders. */
export function rankLeaders(rows: LeaderRow[]): LeaderRow[] {
  return rows
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
}

/** The ranked board plus a zero row for every driver in the group who has nothing yet, so the
 *  whole roster is always on the dashboard — nobody disappears for having a quiet week. */
export function withWholeRoster(ranked: LeaderRow[], drivers: DriverLike[]): LeaderRow[] {
  const seen = new Set(ranked.map((r) => r.driverId))
  const rest = drivers
    .filter((d) => !seen.has(d.id))
    .map((d) => ({ driverId: d.id, name: d.name, colorKey: d.colorKey ?? null, value: 0, count: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...ranked, ...rest]
}

/**
 * Hours clocked per driver over the given rows. WORK rows only — a paid holiday or PTO
 * day is on the paycheck but nobody "ran" those hours. Open shifts count for nothing
 * (rowMinutes), so a driver still on the clock does not lead on hours he has not worked yet.
 */
export function hoursLeaders(rows: TimeClockRow[], drivers: DriverLike[]): LeaderRow[] {
  const byId = new Map(drivers.map((d) => [d.id, d]))
  const acc = new Map<string, { minutes: number; days: Set<string> }>()
  for (const row of rows) {
    if (row.kind !== 'WORK') continue
    const m = rowMinutes(row)
    if (m <= 0) continue
    const cur = acc.get(row.driverId) ?? { minutes: 0, days: new Set<string>() }
    cur.minutes += m
    cur.days.add(row.workDate)
    acc.set(row.driverId, cur)
  }
  const out: LeaderRow[] = []
  for (const [driverId, { minutes, days }] of acc) {
    const d = byId.get(driverId)
    if (!d) continue // a row for a deleted driver has no name to put on a board
    out.push({ driverId, name: d.name, colorKey: d.colorKey ?? null, value: decimalHours(minutes), count: days.size })
  }
  return rankLeaders(out)
}

/**
 * Gross booked per driver: the rate on every load whose delivery falls in [start, end]
 * (Chicago dates), POD or no POD — settlement rows only count loads already papered,
 * which hid most of the week until Friday. A load is the delivering driver's: the
 * delivery stop's driver, else the load's delivery driver.
 */
export function bookedGrossLeaders(loads: readonly Load[], drivers: DriverLike[], start: string, end: string): LeaderRow[] {
  const byId = new Map(drivers.map((d) => [d.id, d]))
  const acc = new Map<string, { gross: number; loads: number }>()
  for (const load of loads) {
    const day = load.deliveryAppt ? chicagoDateStr(load.deliveryAppt) : ''
    if (!day || day < start || day > end) continue
    const delivery = getStops(load).find((s) => s.type === 'delivery')
    const driverId = delivery?.driverId ?? load.deliveryDriverId
    if (!driverId || !byId.has(driverId)) continue
    const cur = acc.get(driverId) ?? { gross: 0, loads: 0 }
    cur.gross += (load.rate ?? 0) / 100
    cur.loads += 1
    acc.set(driverId, cur)
  }
  return rankLeaders([...acc].map(([driverId, { gross, loads: n }]) => {
    const d = byId.get(driverId)!
    return { driverId, name: d.name, colorKey: d.colorKey ?? null, value: Math.round(gross * 100) / 100, count: n }
  }))
}

/** Gross pay per driver from settlement rows (owner-operator or box truck). */
export function grossLeaders(rows: Array<{ driver: DriverLike; statement: { gross: number }; trips: unknown[] }>): LeaderRow[] {
  return rankLeaders(rows.map((r) => ({
    driverId: r.driver.id,
    name: r.driver.name,
    colorKey: r.driver.colorKey ?? null,
    value: Math.round(r.statement.gross * 100) / 100,
    count: r.trips.length,
  })))
}

export interface LastAppointment {
  loadId: string
  stopType: Stop['type']
  /** ISO UTC of the appointment (window start for a range). */
  at: string
  apptType?: Stop['apptType']
  apptEnd?: string
  city: string | null
}

/**
 * The driver's LAST scheduled stop across every load on the board — when and where the
 * truck goes empty. Stops are matched by their own driverId (one driver per stop); a legacy
 * stop with no driver falls back to the load's pickup/delivery driver. Appointments without
 * a parseable time (TBD placeholders are still dated) are skipped, so the answer is always
 * a real point on the calendar.
 */
export function lastAppointment(loads: Load[], driverId: string): LastAppointment | null {
  let best: LastAppointment | null = null
  for (const load of loads) {
    for (const stop of getStops(load)) {
      const owner = stop.driverId ?? (stop.type === 'pickup' ? load.pickupDriverId : load.deliveryDriverId)
      if (owner !== driverId) continue
      const t = Date.parse(stop.appt)
      if (!Number.isFinite(t)) continue
      if (!best || t > Date.parse(best.at)) {
        best = { loadId: load.id, stopType: stop.type, at: stop.appt, apptType: stop.apptType, apptEnd: stop.apptEnd, city: stop.city?.trim() || null }
      }
    }
  }
  return best
}

/** YYYY-MM-DD shifted by whole days (UTC noon so DST never moves the date). */
export function shiftDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
