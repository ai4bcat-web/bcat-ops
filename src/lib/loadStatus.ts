/**
 * Where a load actually is, right now, in one word.
 *
 * The grid had no such column, which is why it could not be the source of truth: a
 * dispatcher reading it had to assemble the answer themselves out of a driver name, two
 * appointment times and a paperwork tick, and two people reading the same row could
 * reasonably disagree. Every TMS worth the name — Aljex, McLeod, TMW — puts one status on
 * the row and filters by it, because that is the question people actually ask of a board.
 *
 * Nothing new is stored. The status is DERIVED from facts the system already keeps, which
 * is the point: a stored status is a second truth that drifts from the first the moment
 * somebody forgets to set it. The facts, in the order they are trusted:
 *
 *  1. `readyToInvoice` — a human said so. Nothing derived overrules a human.
 *  2. `arrivedAt` / `departedAt` on stops — real facility events, never inferred from an
 *     appointment. A truck that is late is not "in transit" because the clock says so.
 *  3. POD on file — the load is done and the paperwork is in.
 *  4. Appointments booked — `apptNeedKind`, the same rule the Appts queue uses, so the two
 *     pages cannot disagree about whether a time exists.
 *  5. A driver assigned.
 *
 * Deliberately NOT here: anything about money. Factored, funded and paid live in the
 * factoring queue against an invoice, not against a load, and folding them in would make
 * this column answer two questions at once.
 *
 * Pure: no store, no clock, no network. Time is never used to advance a status, so this
 * returns the same answer whenever it is asked.
 */
import { getStops } from './stops'
import { apptNeedKind } from './apptQueue'
import type { Load, Stop } from '../types'

export type LoadStatusId =
  | 'unassigned'
  | 'needs_appt'
  | 'planned'
  | 'at_pickup'
  | 'in_transit'
  | 'at_delivery'
  | 'delivered'
  | 'pod_in'
  | 'ready'

export interface LoadStatusMeta {
  id: LoadStatusId
  label: string
  /** What the colour means, so the board reads at a glance rather than as decoration. */
  tone: 'neutral' | 'info' | 'active' | 'warn' | 'good'
  /** One line, shown on hover — says what has to happen next, not what the word means. */
  hint: string
}

/*
 * Order is the lifecycle order, and the UI relies on it: the filter bar, the legend and
 * the sort all read this array top to bottom. A status that cannot be reached in sequence
 * is a bug in the derivation, not an extra row here.
 */
export const LOAD_STATUSES: LoadStatusMeta[] = [
  { id: 'unassigned', label: 'Unassigned', tone: 'warn',
    hint: 'Nobody is on this load yet — assign a driver.' },
  { id: 'needs_appt', label: 'Needs appt', tone: 'warn',
    hint: 'A driver is on it, but a stop still has no booked time.' },
  { id: 'planned', label: 'Planned', tone: 'info',
    hint: 'Driver assigned and every stop booked — not started yet.' },
  { id: 'at_pickup', label: 'At pickup', tone: 'active',
    hint: 'Arrived at a pickup and still there.' },
  { id: 'in_transit', label: 'In transit', tone: 'active',
    hint: 'Loaded and rolling — not yet at the delivery.' },
  { id: 'at_delivery', label: 'At delivery', tone: 'active',
    hint: 'Arrived at the delivery and still there.' },
  { id: 'delivered', label: 'Delivered', tone: 'warn',
    hint: 'Delivered, but no POD on file — chase the paperwork.' },
  { id: 'pod_in', label: 'POD in', tone: 'good',
    hint: 'Delivered with the POD on file — mark it ready to invoice.' },
  { id: 'ready', label: 'Ready to invoice', tone: 'good',
    hint: 'Marked ready — it goes to the factoring queue from here.' },
]

export const LOAD_STATUS_BY_ID: Record<LoadStatusId, LoadStatusMeta> =
  Object.fromEntries(LOAD_STATUSES.map((s) => [s.id, s])) as Record<LoadStatusId, LoadStatusMeta>

/** Enough of a load to derive a status from. */
export interface StatusLoadLike extends Pick<Load, 'id' | 'readyToInvoice'> {
  stops?: Stop[] | null
  pickupDriverId?: string | null
  deliveryDriverId?: string | null
}

const stamped = (v: string | null | undefined): boolean => !!(v ?? '').trim()

/**
 * The status of one load.
 *
 * `hasPod` comes from the paperwork index rather than the load, because a POD can live in
 * three different stores and none of them is a column on Load. Passing `null` means "not
 * known yet" and is treated as "no POD" for ordering only — a load that is delivered shows
 * Delivered until the index can say otherwise, which is the honest answer while it loads.
 */
export function loadStatus(load: StatusLoadLike, hasPod: boolean | null = null): LoadStatusId {
  // A human marking it ready outranks everything derived.
  if (load.readyToInvoice) return 'ready'

  const stops = getStops(load as Load)
  const pickups = stops.filter((s) => s.type === 'pickup')
  const deliveries = stops.filter((s) => s.type === 'delivery')

  const anyDriver =
    stops.some((s) => stamped(s.driverId)) ||
    stamped(load.pickupDriverId) ||
    stamped(load.deliveryDriverId)

  /*
   * Facility events first, and before the driver check on purpose. A load that has been
   * picked up IS under way whatever the roster says, and showing it as Unassigned because
   * somebody cleared the driver afterwards would hide a truck that is carrying freight.
   */
  const lastDelivery = deliveries[deliveries.length - 1]
  const deliveredDeparted = !!lastDelivery && stamped(lastDelivery.departedAt)
  /*
   * A departure implies the arrival, even when nobody stamped one.
   *
   * Drivers mark "departed" and skip "arrived" all the time — the app asks for both but
   * the dock does not wait. Reading only arrivedAt sent a load that had demonstrably been
   * loaded back to Planned, which is the one answer that cannot be true.
   */
  const touched = (s: Stop) => stamped(s.arrivedAt) || stamped(s.departedAt)
  const deliveryArrived = deliveries.some(touched)
  const pickupArrived = pickups.some(touched)
  const allPickupsDeparted = pickups.length > 0 && pickups.every((s) => stamped(s.departedAt))

  if (deliveredDeparted) return hasPod ? 'pod_in' : 'delivered'
  if (deliveryArrived) return 'at_delivery'
  if (allPickupsDeparted) return 'in_transit'
  if (pickupArrived) return 'at_pickup'

  if (!anyDriver) return 'unassigned'
  // Same rule the Appts queue uses, so a stop it calls open is open here too.
  if (stops.some((s) => apptNeedKind(s) !== null)) return 'needs_appt'
  return 'planned'
}

/**
 * Statuses that mean the load still needs somebody to do something.
 *
 * `pod_in` counts: the paperwork has arrived but nobody has marked it ready to invoice,
 * so it is one click from billable and exactly the work a dispatcher wants surfaced.
 * Only `ready` is finished as far as this board is concerned — what happens after that
 * belongs to the factoring queue.
 */
export const OPEN_STATUSES: LoadStatusId[] = [
  'unassigned', 'needs_appt', 'planned', 'at_pickup',
  'in_transit', 'at_delivery', 'delivered', 'pod_in',
]

export function isOpenStatus(id: LoadStatusId): boolean {
  return OPEN_STATUSES.includes(id)
}
