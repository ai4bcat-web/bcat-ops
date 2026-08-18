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

/**
 * A pointer to one editable appointment on a load — enough to both display it and write
 * back to the right place. `stopId` is null for a legacy load with no stops array, where
 * the write targets the load's mirror fields instead.
 */
export interface ApptRef {
  stopId: string | null
  appt: string
  apptType?: ApptType
  apptEnd?: string
}

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
  /** The load's scheduled pickup and delivery — the same two the calendar shows. */
  pickup: ApptRef
  delivery: ApptRef
}

/**
 * The load's pickup and delivery appointments.
 *
 * First pickup and last delivery, matching deriveLegacyFields — so the Appts page, the
 * calendar, and the legacy mirror fields all name the same two stops on a multi-stop load
 * rather than each picking a different one.
 */
export function loadApptRefs(load: Load): { pickup: ApptRef; delivery: ApptRef } {
  const stops = getStops(load)
  const first = stops.find((s) => s.type === 'pickup')
  const last = [...stops].reverse().find((s) => s.type === 'delivery')
  const ref = (s: Stop | undefined, appt: string, type?: ApptType, end?: string): ApptRef =>
    s ? { stopId: s.id, appt: s.appt, apptType: s.apptType, apptEnd: s.apptEnd }
      : { stopId: null, appt, apptType: type, apptEnd: end }
  return {
    pickup: ref(first, load.pickupAppt, load.pickupApptType, load.pickupApptEnd ?? undefined),
    delivery: ref(last, load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd ?? undefined),
  }
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
    const refs = loadApptRefs(load)
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
        pickup: refs.pickup,
        delivery: refs.delivery,
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
  | 'pickupTime' | 'deliveryTime'
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
    // ISO instants, so a string compare orders them chronologically.
    : key === 'pickupTime' ? r.pickup.appt
    : key === 'deliveryTime' ? r.delivery.appt
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
 * The appointment type to save after an edit.
 *
 * Adding a time to a stop that is already flagged NEED is how it gets booked, so that
 * case graduates to Exact and drops off the Appts queue.
 *
 * Everything else keeps the type the user picked. That distinction matters: the editors
 * seed their time input from the *existing* appointment, so the field is usually already
 * populated. Graduating on "there is a time in the box" made it impossible to flag an
 * already-booked stop as NEED — the selection silently reverted to Exact, and because no
 * stop ever reached the NEED state, the #appts-ivan alert could never fire either.
 *
 * `value` is a datetime-local string: "2026-08-20" or "2026-08-20T09:30". Midnight is how
 * the input represents "no time chosen", so it does not count as booked. `prev` is the
 * stop's state before this edit; with none (a brand-new stop) the pick is taken as intent.
 */
export function apptTypeAfterEdit(
  chosen: ApptType,
  value: string,
  prev?: { type?: ApptType; value?: string },
): ApptType {
  const hasTime = (v: string) => v.length > 10 && v.slice(11, 16) !== '00:00'
  if (chosen !== 'tbd') return chosen
  // The user just switched TO NEED — that is a deliberate request to book it.
  if (!prev || (prev.type ?? 'exact') !== 'tbd') return 'tbd'
  // Already NEED, and a time has just appeared: someone booked it.
  return hasTime(value) && !hasTime(prev.value ?? '') ? 'exact' : 'tbd'
}

/* ── grouping by pickup date ─────────────────────────────────────────────────── */

export interface ApptDateSection {
  /** Chicago calendar date 'YYYY-MM-DD', or '' for rows with no pickup date. */
  key: string
  rows: ApptQueueRow[]
}

/**
 * Group the queue by the LOAD's pickup date — including rows that are delivery stops,
 * because a dispatcher works a day by the trucks rolling that morning, and a delivery is
 * chased in the context of the pickup that feeds it.
 *
 * Chronological, with undated rows last: they carry no scheduling signal, so putting them
 * first would push the actionable days below the fold.
 */
export function groupByPickupDate(rows: ApptQueueRow[]): ApptDateSection[] {
  const buckets = new Map<string, ApptQueueRow[]>()
  for (const r of rows) {
    const key = r.pickup.appt ? chicagoDateStr(r.pickup.appt) : ''
    const list = buckets.get(key)
    if (list) list.push(r)
    else buckets.set(key, [r])
  }
  return [...buckets.entries()]
    .map(([key, rows]) => ({ key, rows }))
    .sort((a, b) => {
      if (!a.key) return 1
      if (!b.key) return -1
      return a.key.localeCompare(b.key)
    })
}
