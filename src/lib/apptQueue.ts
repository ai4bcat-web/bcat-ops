import { getStops } from './stops'
import { apptHasTime, chicagoDateStr } from './date'
import type { ApptType, Load, Stop, StopType } from '@/types'

/**
 * Why a stop is in the queue.
 *  - `need`    — someone explicitly flagged it NEED. A human has decided this must be booked.
 *  - `pending` — no time has been set yet. Usually a freshly created load.
 *
 * FCFS and range stops are NOT in the queue: first-come-first-serve means any arrival time
 * is fine, and a range already has an agreed window. Neither needs a call.
 */
export type ApptNeedKind = 'need' | 'pending'

export interface ApptQueueRow {
  loadId: string
  stopId: string
  kind: ApptNeedKind
  stopType: StopType
  /** Pro # */
  aljexId: string
  pickupNumber: string
  customer: string
  /** Facility and/or city, already joined for display. */
  location: string
  /** ISO date of the (unscheduled) appointment. */
  appt: string
  driverId: string | null
  sequence: number
}

/** Which queue bucket a stop belongs to, or null when it needs nothing. */
export function apptNeedKind(stop: Stop): ApptNeedKind | null {
  const type = stop.apptType ?? 'exact'
  if (type === 'tbd') return 'need'
  // FCFS and range are settled by definition.
  if (type === 'fcfs' || type === 'range') return null
  return apptHasTime(stop.appt) ? null : 'pending'
}

/**
 * Every stop across every load that still needs an appointment booked.
 *
 * Derived from load state rather than from an event firing, so it is self-healing: a load
 * that is flagged, missed, and re-flagged still shows exactly once, and nothing can fall
 * through a notification that didn't send.
 *
 * Ordered NEED first (a person asked for these), then soonest date first — a stop whose
 * date has already passed sorts to the very top, because that is the one now hurting.
 */
export function apptQueue(loads: Load[]): ApptQueueRow[] {
  const rows: ApptQueueRow[] = []

  for (const load of loads) {
    for (const stop of getStops(load)) {
      const kind = apptNeedKind(stop)
      if (!kind) continue
      rows.push({
        loadId: load.id,
        stopId: stop.id,
        kind,
        stopType: stop.type,
        aljexId: load.aljexId ?? '',
        pickupNumber: load.pickupNumber ?? '',
        customer: load.customer ?? '',
        location: [stop.name, stop.city].filter(Boolean).join(', '),
        appt: stop.appt,
        driverId: stop.driverId,
        sequence: stop.sequence,
      })
    }
  }

  return rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'need' ? -1 : 1
    // Blank dates last — they carry no urgency signal at all.
    if (!a.appt) return 1
    if (!b.appt) return -1
    return a.appt.localeCompare(b.appt)
  })
}

/** Queue size, for the sidebar badge. */
export const apptQueueCount = (loads: Load[]): number => apptQueue(loads).length

/** Split for display — the two groups are acted on differently. */
export function splitApptQueue(rows: ApptQueueRow[]) {
  return {
    need: rows.filter((r) => r.kind === 'need'),
    pending: rows.filter((r) => r.kind === 'pending'),
  }
}


/* ── past appointments ──────────────────────────────────────────────────────── */

/**
 * A stop whose appointment date has already passed.
 *
 * These are almost always historical loads that were never going to be booked — with
 * hundreds of loads on file they swamp the queue and bury the work that can still be
 * done. They're filtered out of the default view rather than deleted, because "hidden
 * forever with no way to look" is how real backlogs get lost.
 *
 * Compared as Chicago calendar dates, so a stop later today is never treated as past.
 */
export function isPastAppt(appt: string, todayIso: string = new Date().toISOString()): boolean {
  if (!appt) return false            // no date carries no urgency, and no staleness either
  const day = chicagoDateStr(appt)
  const today = chicagoDateStr(todayIso)
  if (!day || !today) return false
  return day < today
}

/** Split the queue into what can still be actioned and what has already gone by. */
export function splitPastAppts(rows: ApptQueueRow[], todayIso?: string) {
  return {
    current: rows.filter((r) => !isPastAppt(r.appt, todayIso)),
    past: rows.filter((r) => isPastAppt(r.appt, todayIso)),
  }
}

/* ── sorting ────────────────────────────────────────────────────────────────── */

export type ApptSortKey =
  | 'stopType' | 'aljexId' | 'pickupNumber' | 'customer' | 'location' | 'appt' | 'driver'
export type SortDir = 'asc' | 'desc'

/**
 * Sort by one column. `driverName` resolves the id so the Driver column sorts by the name
 * people actually read rather than by a uuid.
 *
 * Blanks always sink to the bottom regardless of direction — a row with no customer is
 * not "before A" or "after Z", it's just missing, and floating those to the top on a
 * descending sort would push the real data off-screen.
 */
export function sortApptRows(
  rows: ApptQueueRow[],
  key: ApptSortKey,
  dir: SortDir,
  driverName: (id: string | null) => string,
): ApptQueueRow[] {
  const value = (r: ApptQueueRow): string =>
    key === 'driver' ? driverName(r.driverId)
    : key === 'stopType' ? r.stopType
    : String(r[key] ?? '')

  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    if (!av && !bv) return 0
    if (!av) return 1                 // blanks last, both directions
    if (!bv) return -1
    // Dates are ISO, so a plain string compare is chronological.
    return sign * av.localeCompare(bv, undefined, { numeric: true })
  })
}

/* ── booking from the calendar ──────────────────────────────────────────────── */

/**
 * The appointment type to save when someone sets a time on the calendar.
 *
 * Entering a real time IS booking the appointment, so a stop still marked NEED graduates
 * to Exact. Without this it would keep asking to be booked on the Appts page even though
 * the person looking at it just booked it.
 *
 * `value` is a datetime-local string: "2026-08-20" (date only) or "2026-08-20T09:30".
 * Midnight is how the input represents "no time chosen", so it does not count as booked.
 */
export function apptTypeAfterEdit(chosen: ApptType, value: string): ApptType {
  const hasTime = value.length > 10 && value.slice(11, 16) !== '00:00'
  return chosen === 'tbd' && hasTime ? 'exact' : chosen
}
