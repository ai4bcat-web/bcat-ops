/**
 * Pure logic behind the Tracking table: who owns a row, which lifecycle bucket it is in,
 * and the three computed cells (ETA, next check call, POD state). No React, no I/O —
 * the board and the workstation both lean on it so the rules live once.
 */
import { isRateConSent } from '@/lib/trackingAutomation'
import { trackingEtaEstimate } from '@/lib/trackingEta'
import type { Stop } from '@/types'
import { boardStatusOf, type ShipmentRow } from '../../shipmentViews'
import type { TrackingAssigneeTab, TrackingGroup, TrackingLifecycle } from './types'

export { isRateConSent }

export const UNASSIGNED_KEY = 'unassigned'
/** Assignee tabs shown before the rest fold into a "More assignees" select. */
export const MAX_ASSIGNEE_TABS = 8

// ── Lifecycle ────────────────────────────────────────────────────────────────

export type PodState = 'NOT_DUE' | 'NEEDED' | 'REQUESTED' | 'IN_REVIEW' | 'RECEIVED' | 'UNKNOWN'

/**
 * Where the proof of delivery stands. `docsMissing` null = documents never checked.
 * `pendingDocReviewCount` counts any carrier upload awaiting review, not only PODs —
 * accepted as the proxy for "a POD is in review".
 */
export function podStateOf(row: ShipmentRow): PodState {
  if (boardStatusOf(row) !== 'DELIVERED') return 'NOT_DUE'
  if (row.docsMissing == null) return 'UNKNOWN'
  if (!row.docsMissing.includes('POD')) return 'RECEIVED'
  if ((row.pendingDocReviewCount ?? 0) > 0) return 'IN_REVIEW'
  if (row.podRequestedAt) return 'REQUESTED'
  return 'NEEDED'
}

/** Active = still moving; pod = delivered, POD not confirmed received; closed = the rest. */
export function lifecycleOf(row: ShipmentRow): TrackingLifecycle {
  const status = boardStatusOf(row)
  if (status === 'VOIDED' || status === 'CANCELED') return 'closed'
  if (status === 'DELIVERED') return podStateOf(row) === 'RECEIVED' ? 'closed' : 'pod'
  return 'active'
}

// ── Assignees ────────────────────────────────────────────────────────────────

/** Unassigned first (when any), then people A→Z by the name shown. */
export function groupByAssignee(
  rows: readonly ShipmentRow[],
  nameOf: (id: string) => string,
): TrackingGroup[] {
  const unassigned: ShipmentRow[] = []
  const byTracker = new Map<string, ShipmentRow[]>()
  for (const row of rows) {
    if (!row.trackerId) {
      unassigned.push(row)
      continue
    }
    const list = byTracker.get(row.trackerId)
    if (list) list.push(row)
    else byTracker.set(row.trackerId, [row])
  }
  const people: TrackingGroup[] = [...byTracker.entries()]
    .map(([trackerId, list]) => ({
      key: trackerId,
      label: list.find((r) => r.trackerName)?.trackerName ?? nameOf(trackerId),
      trackerId,
      rows: list,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
  return unassigned.length > 0
    ? [{ key: UNASSIGNED_KEY, label: 'Unassigned', trackerId: null, rows: unassigned }, ...people]
    : people
}

/** My loads (when the viewer is known) · All · Unassigned · one tab per other assignee. */
export function assigneeTabs(
  rows: readonly ShipmentRow[],
  myId: string | null,
  nameOf: (id: string) => string,
): TrackingAssigneeTab[] {
  const groups = groupByAssignee(rows, nameOf)
  const unassigned = groups.find((g) => g.trackerId === null)?.rows.length ?? 0
  const tabs: TrackingAssigneeTab[] = []
  if (myId) {
    tabs.push({ key: 'me', label: 'My loads', count: rows.filter((r) => r.trackerId === myId).length })
  }
  tabs.push({ key: 'all', label: 'All', count: rows.length })
  tabs.push({ key: UNASSIGNED_KEY, label: 'Unassigned', count: unassigned, ...(unassigned > 0 ? { tone: 'warn' as const } : {}) })
  for (const g of groups) {
    if (g.trackerId === null || g.trackerId === myId) continue
    tabs.push({ key: g.key, label: g.label, count: g.rows.length })
  }
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
