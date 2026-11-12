/**
 * Pure logic behind the Tracking table: who owns a row, which lifecycle bucket it is in,
 * and the three computed cells (ETA, next check call, POD state). No React, no I/O —
 * the board and the workstation both lean on it so the rules live once.
 */
import { checkCallState } from '@/lib/checkCalls'
import { isRateConSent } from '@/lib/trackingAutomation'
import { trackingEtaEstimate } from '@/lib/trackingEta'
import type { Stop } from '@/types'
import { pastDeliveryOf, scheduledDeliveryLateOf } from '../../boardChips'
import { boardStatusOf, type ShipmentRow } from '../../shipmentViews'
import type { TrackingAssigneeTab, TrackingLifecycle } from './types'

export { isRateConSent }

export const UNASSIGNED_KEY = 'unassigned'

// ── Lifecycle ────────────────────────────────────────────────────────────────

export type PodState = 'NOT_DUE' | 'NEEDED' | 'REQUESTED' | 'IN_REVIEW' | 'RECEIVED' | 'UNKNOWN'

/**
 * Where the proof of delivery stands. `docsMissing` null = documents never checked.
 * `pendingDocReviewCount` counts any carrier upload awaiting review, not only PODs —
 * accepted as the proxy for "a POD is in review".
 * RECEIVED means the POD is really on file: the order's document gate ran with POD on its list
 * and POD is not missing, or the documents were signed off by hand. Car shipping chases no POD,
 * so it counts as received. A cached gate whose list leaves POD off says nothing about a POD
 * being on file (Ryne 2026-11-12: POD is always required), so that reads UNKNOWN.
 */
export function podStateOf(row: ShipmentRow): PodState {
  if (boardStatusOf(row) !== 'DELIVERED') return 'NOT_DUE'
  if (row.revDivision === 'CAR_SHIPPING' || row.docsOverrideAt) return 'RECEIVED'
  if (row.docsMissing == null) return 'UNKNOWN'
  if (!row.docsMissing.includes('POD')) {
    return Array.isArray(row.docsRequired) && !row.docsRequired.includes('POD') ? 'UNKNOWN' : 'RECEIVED'
  }
  if ((row.pendingDocReviewCount ?? 0) > 0) return 'IN_REVIEW'
  if (row.podRequestedAt) return 'REQUESTED'
  return 'NEEDED'
}

/**
 * Active = still moving; pod = delivered, POD not confirmed received; closed = the rest.
 * A load leaves Tracking only once it is delivered AND its POD is on file (Ryne 2026-11-12).
 */
export function lifecycleOf(row: ShipmentRow): TrackingLifecycle {
  const status = boardStatusOf(row)
  if (status === 'VOIDED' || status === 'CANCELED') return 'closed'
  if (status === 'DELIVERED') return podStateOf(row) === 'RECEIVED' ? 'closed' : 'pod'
  return 'active'
}

/**
 * The rows the Tracking desk lists for a lifecycle: a sent rate con (or any, with `includeUnsent`)
 * in that lifecycle. Active lists everything still on Tracking — moving loads and delivered loads
 * whose POD is not on file yet; POD due is the delivered-awaiting-POD slice of it. A pure filter,
 * so the rows it keeps from the working set equal the rows it would keep from every shipment ever
 * (the working set holds every non-terminal and every delivered-awaiting-POD shipment).
 */
export function lifecycleRows(
  rows: readonly ShipmentRow[],
  lifecycle: TrackingLifecycle,
  includeUnsent: boolean,
): ShipmentRow[] {
  return rows.filter((r) => {
    if (!includeUnsent && !isRateConSent(r)) return false
    const own = lifecycleOf(r)
    return lifecycle === 'active' ? own === 'active' || own === 'pod' : own === lifecycle
  })
}

export interface DeliveryOverdue {
  /** PAST_DELIVERY = not delivered yet; NO_POD = delivered, POD not on file. */
  kind: 'PAST_DELIVERY' | 'NO_POD'
  daysLate: number
  label: string
  tooltip: string
}

/**
 * A load on Tracking whose scheduled delivery day has passed (the board's #371 rule: last delivery
 * stop's appointment or window end, Chicago day-level) and whose POD is not on file. Not delivered
 * yet reads "Past delivery date"; delivered without a POD reads "No POD — delivery date passed".
 * Voided, canceled, draft and POD-received loads are never flagged.
 */
export function deliveryOverdueOf(row: ShipmentRow, nowMs: number): DeliveryOverdue | null {
  if (row.status === 'DRAFT') return null
  const status = boardStatusOf(row)
  if (status === 'VOIDED' || status === 'CANCELED') return null
  if (status !== 'DELIVERED') {
    const past = pastDeliveryOf(row, nowMs)
    return past ? { kind: 'PAST_DELIVERY', daysLate: past.daysLate, label: 'Past delivery date', tooltip: past.tooltip } : null
  }
  if (podStateOf(row) === 'RECEIVED') return null
  const late = scheduledDeliveryLateOf(row, nowMs)
  if (!late) return null
  const days = `${late.daysLate} ${late.daysLate === 1 ? 'day' : 'days'}`
  return {
    kind: 'NO_POD',
    daysLate: late.daysLate,
    label: 'No POD — delivery date passed',
    tooltip: `Scheduled delivery ${late.label} — delivered, no POD on file (${days})`,
  }
}

// ── Assignees ────────────────────────────────────────────────────────────────

/** My loads (when the viewer is known) · All · Unassigned. Anyone else is a Tracker header filter. */
export function assigneeTabs(rows: readonly ShipmentRow[], myId: string | null): TrackingAssigneeTab[] {
  const unassigned = rows.filter((r) => !r.trackerId).length
  const tabs: TrackingAssigneeTab[] = []
  if (myId) {
    tabs.push({ key: 'me', label: 'My loads', count: rows.filter((r) => r.trackerId === myId).length })
  }
  tabs.push({ key: 'all', label: 'All', count: rows.length })
  tabs.push({ key: UNASSIGNED_KEY, label: 'Unassigned', count: unassigned, ...(unassigned > 0 ? { tone: 'warn' as const } : {}) })
  return tabs
}

/** Land on My loads when the viewer has any, else on everyone. */
export function defaultAssignee(rows: readonly ShipmentRow[], myId: string | null): string {
  return myId && rows.some((r) => r.trackerId === myId) ? 'me' : 'all'
}

/** The rows one assignee key selects. An unknown id selects nothing. */
export function rowsForAssignee(rows: readonly ShipmentRow[], key: string, myId: string | null): ShipmentRow[] {
  if (key === 'all') return [...rows]
  if (key === UNASSIGNED_KEY) return rows.filter((r) => !r.trackerId)
  const id = key === 'me' ? myId : key
  return id ? rows.filter((r) => r.trackerId === id) : []
}

// ── Computed cells ───────────────────────────────────────────────────────────

/** The stop the shipment drives at next: delivery once it is rolling, pickup before. */
export function nextStopOf(row: ShipmentRow): Stop | null {
  const stops = row.stops ?? []
  if (stops.length === 0) return null
  const status = boardStatusOf(row)
  const wantDelivery = status === 'DEPARTED' || status === 'ARRIVED'
  const typed = stops.filter((s) => (wantDelivery ? s.type === 'delivery' : s.type === 'pickup'))
  const pending = typed.filter((s) => !s.arrivedAt && !s.departedAt)
  return pending[0] ?? typed[0] ?? null
}

/** Miles + ETA from the last ping to the next stop; null without a fix to work from. */
export function nextStopEstimate(row: ShipmentRow, nowMs: number) {
  const lat = row.lastKnownLat
  const lng = row.lastKnownLng
  if (lat == null || lng == null) return null
  const stop = nextStopOf(row)
  const stopLat = stop?.address?.lat
  const stopLng = stop?.address?.lng
  if (!stop || stopLat == null || stopLng == null) return null
  const pingAt = row.lastUpdateAt ?? row.lastKnownAt
  if (!pingAt) return null
  try {
    return trackingEtaEstimate(
      { lat, lng },
      { lat: stopLat, lng: stopLng, appt: stop.appt ?? null },
      pingAt,
      new Date(nowMs).toISOString(),
    )
  } catch {
    return null
  }
}

export interface TrackingEta {
  at: string
  /** True when computed from the last ping rather than reported by the carrier. */
  estimated: boolean
  /** Minutes past the delivery appointment; null when on time or no appointment. */
  lateMinutes: number | null
}

/** Carrier-reported delivery ETA wins; otherwise the estimate from the last ping. */
export function etaOf(row: ShipmentRow, nowMs: number): TrackingEta | null {
  const status = boardStatusOf(row)
  if (status === 'DELIVERED' || status === 'VOIDED' || status === 'CANCELED') return null
  if (row.deliveryEtaAt) {
    const eta = Date.parse(row.deliveryEtaAt)
    const appt = Date.parse(row.deliveryAppt ?? '')
    const late = Number.isFinite(eta) && Number.isFinite(appt) ? Math.round((eta - appt) / 60_000) : 0
    return { at: row.deliveryEtaAt, estimated: false, lateMinutes: late > 0 ? late : null }
  }
  const estimate = nextStopEstimate(row, nowMs)
  if (!estimate) return null
  return { at: estimate.etaAt, estimated: true, lateMinutes: estimate.lateBy != null && estimate.lateBy > 0 ? estimate.lateBy : null }
}

export type NextCheckCall =
  | { kind: 'NONE' }
  | { kind: 'UPCOMING' | 'OVERDUE'; at: string; minutes: number }

/** When the next check call is due, relative to now; `minutes` is always positive. */
export function nextCheckCallStateOf(row: ShipmentRow, nowMs: number): NextCheckCall {
  if (lifecycleOf(row) === 'closed' || boardStatusOf(row) === 'DELIVERED' || !row.nextCheckCallAt) return { kind: 'NONE' }
  const at = Date.parse(row.nextCheckCallAt)
  if (!Number.isFinite(at)) return { kind: 'NONE' }
  const diff = Math.round((at - nowMs) / 60_000)
  return diff >= 0
    ? { kind: 'UPCOMING', at: row.nextCheckCallAt, minutes: diff }
    : { kind: 'OVERDUE', at: row.nextCheckCallAt, minutes: -diff }
}

/** "35 m" / "1 h 20 m" / "2 d". */
export function durationText(minutes: number): string {
  if (minutes < 60) return `${minutes} m`
  if (minutes < 1440) {
    const m = minutes % 60
    return m === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${m} m`
  }
  return `${Math.round(minutes / 1440)} d`
}

// ── Focus (the old Check calls / Document review worklists, as filters of the same rows) ──

export type TrackingFocus = 'checkcalls' | 'docs' | 'exceptions' | 'overdue'

/** The `?focus=` URL value as a focus; anything else is "All". */
export function parseFocus(value: string | null): TrackingFocus | null {
  return value === 'checkcalls' || value === 'docs' || value === 'exceptions' || value === 'overdue' ? value : null
}

/**
 * A reminder on the clock that has come due or is overdue: the same `checkCallState` the sidebar
 * badge, the notifier and the retired worklist read. Finished loads carry no reminder.
 */
export function isCheckCallDue(row: ShipmentRow, nowMs: number, graceMinutes?: number | null): boolean {
  if (nextCheckCallStateOf(row, nowMs).kind === 'NONE') return false
  const state = checkCallState(row, nowMs, graceMinutes)
  return state === 'DUE' || state === 'OVERDUE'
}

/** A carrier upload nobody has accepted or refused yet. */
export function hasDocsToReview(row: ShipmentRow): boolean {
  return (row.pendingDocReviewCount ?? 0) > 0
}

/** An open exception (breakdown, delay) nobody has closed out. */
export function hasException(row: ShipmentRow): boolean {
  return (row.openIncidentCount ?? 0) > 0
}

export function focusRows(
  rows: readonly ShipmentRow[],
  focus: TrackingFocus | null,
  nowMs: number,
  graceMinutes?: number | null,
): ShipmentRow[] {
  switch (focus) {
    case 'checkcalls': return rows.filter((r) => isCheckCallDue(r, nowMs, graceMinutes))
    case 'docs': return rows.filter(hasDocsToReview)
    case 'exceptions': return rows.filter(hasException)
    case 'overdue': return rows.filter((r) => deliveryOverdueOf(r, nowMs) != null)
    default: return [...rows]
  }
}
