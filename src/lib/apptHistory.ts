import { getStops } from './stops'
import { apptHasTime, apptTimeLabel, formatDateShort } from './date'
import type { ApptType, AuditLogEntry, Load, Stop, StopType } from '@/types'

/**
 * The booking history of a shipment's appointments, read back out of the audit log.
 *
 * Every load save already writes an AuditLog entry carrying the before/after of each
 * changed field — including the whole `stops` array and the legacy pickup/delivery
 * mirror fields. This does not add a second store of "appointment events" that could
 * disagree with the first; it derives the timeline from what the audit log already holds,
 * so history exists for loads booked long before this page learned to show it.
 *
 * One event per (save, stop end) whose appointment actually moved: a different date, a
 * different time, a different window end, or a different status (NEED → Exact is the
 * booking itself). Saves that touched only the driver or the notes produce nothing —
 * the audit log records the `stops` array on every save because array identity changes,
 * so the comparison has to be on the appointment fields, not on "was `stops` in changes".
 */

export type ApptHistoryEventKind =
  | 'appt'            // the appointment itself was set, booked, or changed
  | 'move-requested'  // someone flagged the booked appt NEEDS TO BE MOVED
  | 'move-withdrawn'  // the flag was cleared by hand, without a rebooking
  | 'proof-added'     // a confirmation screenshot (E2Open / email) was uploaded
  | 'proof-removed'   // a confirmation screenshot was taken off

export interface ApptHistoryEvent {
  /** ISO instant of the save. */
  at: string
  user: string
  stopKind: StopType
  kind: ApptHistoryEventKind
  /** For proof events: which screenshot. */
  proofLabel?: string
  /** Before, as a person reads it — "Aug 20, 2026 · NEED"; "—" when there was none. */
  from: string
  /** After, same format. */
  to: string
  /** True when this save is the one that booked it (unbooked → booked). */
  booked: boolean
  /** True when a time that was already booked got moved or unbooked. */
  changed: boolean
  /** True when this appt change is the one that RESOLVED an open move request. */
  resolvedMove?: boolean
}

interface ApptSnap {
  appt: string; apptType: ApptType; apptEnd: string
  moveRequested: boolean
  /** S3 keys (not booleans): a REPLACED screenshot is a new confirmation and must show. */
  e2open: string; email: string
}

const snapKey = (s: ApptSnap) => `${s.appt}|${s.apptType}|${s.apptEnd}`

const describe = (s: ApptSnap | null): string => {
  if (!s || !s.appt) return '—'
  const time = apptTimeLabel(s.appt, s.apptType, s.apptEnd || undefined)
  return `${formatDateShort(s.appt)} · ${time}`
}

/** A booked appointment is one that needs no further call — the inverse of apptNeedKind. */
function isBooked(s: ApptSnap | null): boolean {
  if (!s || !s.appt) return false
  if (s.apptType === 'tbd') return false
  if (s.apptType === 'fcfs' || s.apptType === 'range') return true
  return apptHasTime(s.appt)
}

/** Audit `changes` may hold `stops` as an array or as a (possibly double-encoded) JSON string. */
function unwrap(raw: unknown): unknown {
  let v = raw
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { break }
  }
  return v
}

/**
 * The pickup/delivery appointment as of one side (from/to) of an audit entry.
 *
 * Reconstructs a partial Load from the fields the entry recorded, overlaid on the current
 * load for anything it didn't, then reads the first pickup / last delivery through the
 * same getStops + first/last rule the queue and the calendar use.
 */
function sideSnaps(
  load: Load,
  changes: AuditLogEntry['changes'],
  side: 'from' | 'to',
): { pickup: ApptSnap | null; delivery: ApptSnap | null } {
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(changes)) {
    if (k === '_snapshot') continue
    patch[k] = k === 'stops' ? unwrap(v[side]) : v[side]
  }
  // A create entry records the whole load under _snapshot.
  const snap = changes._snapshot?.[side]
  const base = snap && typeof snap === 'object' ? (snap as Load) : load
  const merged = { ...base, ...patch } as Load
  if (merged.stops != null && !Array.isArray(merged.stops)) merged.stops = undefined
  if (side === 'from' && changes._snapshot && changes._snapshot.from == null) {
    return { pickup: null, delivery: null }
  }
  const stops = getStops(merged)
  const toSnap = (s: Stop | undefined): ApptSnap | null =>
    s ? {
      appt: s.appt ?? '', apptType: s.apptType ?? 'exact', apptEnd: s.apptEnd ?? '',
      moveRequested: !!s.apptMoveRequested,
      e2open: s.apptProofs?.e2open ?? '', email: s.apptProofs?.email ?? '',
    } : null
  return {
    pickup: toSnap(stops.find((s) => s.type === 'pickup')),
    delivery: toSnap([...stops].reverse().find((s) => s.type === 'delivery')),
  }
}

const APPT_KEYS = new Set([
  'stops', '_snapshot',
  'pickupAppt', 'pickupApptType', 'pickupApptEnd',
  'deliveryAppt', 'deliveryApptType', 'deliveryApptEnd',
])

/** Newest first. */
export function apptHistory(load: Load, entries: AuditLogEntry[]): ApptHistoryEvent[] {
  const out: ApptHistoryEvent[] = []
  const mine = entries
    .filter((e) => e.entityType === 'Load' && e.entityId === load.id)
    .filter((e) => Object.keys(e.changes ?? {}).some((k) => APPT_KEYS.has(k)))

  for (const e of mine) {
    let before: ReturnType<typeof sideSnaps>
    let after: ReturnType<typeof sideSnaps>
    try {
      before = sideSnaps(load, e.changes, 'from')
      after = sideSnaps(load, e.changes, 'to')
    } catch {
      continue // a malformed legacy entry is not worth breaking the page over
    }
    for (const kind of ['pickup', 'delivery'] as const) {
      const a = before[kind], b = after[kind]
      if (!a && !b) continue
      const base = { at: e.createdAt, user: e.user, stopKind: kind }

      // The appointment itself moved.
      if (b && (!a || snapKey(a) !== snapKey(b)) && !(!a && !b.appt)) {
        const wasBooked = isBooked(a), nowBooked = isBooked(b)
        out.push({
          ...base, kind: 'appt',
          from: describe(a), to: describe(b),
          booked: !wasBooked && nowBooked,
          changed: !!a && wasBooked,
          // A rebooking on a flagged stop is the resolution the move request waited for.
          resolvedMove: !!a?.moveRequested,
        })
      }

      // Move-request lifecycle: who asked, and a by-hand withdrawal. (Resolution via a
      // rebooking is carried on the appt event above rather than duplicated.)
      if (a && b && !a.moveRequested && b.moveRequested) {
        out.push({ ...base, kind: 'move-requested', from: describe(a), to: describe(b), booked: false, changed: false })
      } else if (a && b && a.moveRequested && !b.moveRequested && snapKey(a) === snapKey(b)) {
        out.push({ ...base, kind: 'move-withdrawn', from: describe(a), to: describe(b), booked: false, changed: false })
      }

      // Confirmation screenshots — each slot's own add/remove line, so "did we get the
      // screenshots for THIS booking" is answerable from the order of events alone.
      for (const [slot, label] of [['e2open', 'E2Open update'], ['email', 'Email confirmation']] as const) {
        const had = a?.[slot] ?? '', has = b?.[slot] ?? ''
        if (had === has || !b) continue
        // A replaced screenshot (different key) counts as a fresh confirmation added.
        out.push({
          ...base, kind: has ? 'proof-added' : 'proof-removed', proofLabel: label,
          from: describe(a), to: describe(b), booked: false, changed: false,
        })
      }
    }
  }

  return out.sort((x, y) => y.at.localeCompare(x.at))
}
