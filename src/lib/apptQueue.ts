import { getStops } from './stops'
import { apptHasTime } from './date'
import type { Load, Stop, StopType } from '@/types'

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
