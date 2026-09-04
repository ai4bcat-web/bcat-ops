import { getStops } from './stops'
import { apptHasTime, chicagoDateStr } from './date'
import type { ApptType, Load, Stop } from '@/types'

/**
 * Why a stop is in the queue.
 *  - `need`    — someone explicitly flagged it NEED. A human has decided this must be booked.
 *  - `pending` — no time has been set yet. Usually a freshly created load.
 *  - `move`    — booked, but flagged as NEEDS TO BE MOVED; the booking must be redone.
 *
 * FCFS and range stops are NOT in the queue: first-come-first-serve means any arrival time
 * is fine, and a range already has an agreed window. Neither needs a call.
 */
export type ApptNeedKind = 'need' | 'pending' | 'move'

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
  /** Null means the pickup stop doesn't need an appointment. */
  pickupKind: ApptNeedKind | null
  /** Null means the delivery stop doesn't need an appointment. */
  deliveryKind: ApptNeedKind | null
  /** Pro # */
  aljexId: string
  pickupNumber: string
  customer: string
  /** Pickup facility and/or city, joined for display. */
  location: string
  /** Delivery facility and/or city, joined for display. */
  deliveryLocation: string
  /** ISO date of the (unscheduled) pickup appointment — grouping key. */
  appt: string
  driverId: string | null
  deliveryDriverId: string | null
  /** Booked AND both screenshots (E2Open + email) uploaded. */
  pickupConfirmed: boolean
  deliveryConfirmed: boolean
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
  // A booked appointment flagged for rescheduling is open work again.
  if (stop.apptMoveRequested) return 'move'
  // FCFS and range are settled by definition.
  if (type === 'fcfs' || type === 'range') return null
  return apptHasTime(stop.appt) ? null : 'pending'
}

/** True when at least one of the shipment's two appointments is still unbooked. */
export const rowOutstanding = (r: ApptQueueRow): boolean => !!(r.pickupKind || r.deliveryKind)

/**
 * A booked appointment counts as CONFIRMED only once BOTH proof screenshots are on
 * file — the E2Open update and the email confirmation. Booked without them is merely
 * "we typed a time in"; the proofs are what make it real to everyone downstream.
 */
export const stopConfirmed = (stop: Stop): boolean =>
  apptNeedKind(stop) === null && !!stop.apptProofs?.e2open && !!stop.apptProofs?.email

/**
 * EVERY load, one row per shipment, with the pickup and delivery booking state on it.
 *
 * Booked shipments used to drop off the page the moment both times were set. Dispatch
 * asked for the opposite: keep every shipment visible so the page reads as "here is the
 * day, green is done, red is not" — and so a booking that later gets changed is still
 * somewhere a person can see it, next to its history (see apptHistory.ts).
 *
 * Derived from load state rather than from an event firing, so it is self-healing: a load
 * that is flagged, missed, and re-flagged still shows exactly once, and nothing can fall
 * through a notification that didn't send.
 *
 * Ordered: loads with at least one NEED first, then pending, then fully booked; within
 * each, the soonest pickup date first — a load whose date has already passed sorts to
 * the very top, because that is the one now hurting.
 */
export function apptQueue(loads: Load[]): ApptQueueRow[] {
  const rows: ApptQueueRow[] = []

  for (const load of loads) {
    const refs = loadApptRefs(load)
    const stops = getStops(load)

    const pickupStop = stops.find((s) => s.type === 'pickup')
    const deliveryStop = [...stops].reverse().find((s) => s.type === 'delivery')

    const pickupKind = pickupStop ? apptNeedKind(pickupStop) : null
    const deliveryKind = deliveryStop ? apptNeedKind(deliveryStop) : null

    rows.push({
      loadId: load.id,
      pickupKind,
      deliveryKind,
      aljexId: load.aljexId ?? '',
      pickupNumber: load.pickupNumber ?? '',
      customer: load.customer ?? '',
      location: pickupStop ? [pickupStop.name, pickupStop.city].filter(Boolean).join(', ') : '',
      deliveryLocation: deliveryStop ? [deliveryStop.name, deliveryStop.city].filter(Boolean).join(', ') : '',
      appt: pickupStop?.appt ?? '',
      driverId: pickupStop?.driverId ?? null,
      deliveryDriverId: deliveryStop?.driverId ?? null,
      pickupConfirmed: pickupStop ? stopConfirmed(pickupStop) : false,
      deliveryConfirmed: deliveryStop ? stopConfirmed(deliveryStop) : false,
      pickup: refs.pickup,
      delivery: refs.delivery,
    })
  }

  const rank = (r: ApptQueueRow) =>
    r.pickupKind === 'need' || r.deliveryKind === 'need' ? 0 : rowOutstanding(r) ? 1 : 2

  return rows.sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    // Blank dates last — they carry no urgency signal at all.
    if (!a.appt) return 1
    if (!b.appt) return -1
    return a.appt.localeCompare(b.appt)
  })
}

/** Only the shipments still waiting on at least one appointment. */
export const apptOutstanding = (loads: Load[]): ApptQueueRow[] => apptQueue(loads).filter(rowOutstanding)

/** Outstanding shipment count, for the sidebar badge — booked shipments don't count. */
export const apptQueueCount = (loads: Load[]): number => apptOutstanding(loads).length

/* ── past appointments ──────────────────────────────────────────────────────── */

/**
 * A load whose pickup appointment date has already passed.
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
  | 'aljexId' | 'pickupNumber' | 'customer' | 'location' | 'appt' | 'driver'
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
    // ISO instants, so a string compare orders them chronologically.
    : key === 'pickupTime' ? r.pickup.appt
    : key === 'deliveryTime' ? r.delivery.appt
    : key === 'location' ? (r.location || r.deliveryLocation)
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
 * The appointment type to save after an edit: exactly what the user picked.
 *
 * This used to "graduate" a NEED stop to Exact the moment a time was typed into it. That
 * meant the status on screen and the status saved could disagree — pick NEED, add the
 * requested time, and the stop quietly came back as Exact, dropped off the Appts queue,
 * and never pinged Slack. The rule now is the one dispatch expects: status and time are
 * saved as selected, every time. Booking a NEED stop is done by choosing Exact yourself.
 *
 * Kept as a function (rather than inlined) so the three editors keep one seam if a rule
 * ever needs to come back; `value`/`prev` are accepted and ignored for that reason.
 */
export function apptTypeAfterEdit(
  chosen: ApptType,
  _value?: string,
  _prev?: { type?: ApptType; value?: string },
): ApptType {
  return chosen
}

/* ── grouping by pickup date ─────────────────────────────────────────────────── */

export interface ApptDateSection {
  /** Chicago calendar date 'YYYY-MM-DD', or '' for rows with no pickup date. */
  key: string
  rows: ApptQueueRow[]
}

/**
 * Group the queue by the LOAD's pickup date. A dispatcher works a day by the trucks
 * rolling that morning, and a delivery is chased in the context of the pickup that
 * feeds it.
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