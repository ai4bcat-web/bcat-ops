/**
 * The two status axes of a shipment, and the rules that move them.
 *
 * A shipment has ONE customer-facing status. Each load under it has its own, with
 * two extra states the buy side owns: SOURCING (nobody is hauling it yet) and
 * INVOICING (delivered, the carrier's invoice is in review). The shipment's status
 * is never typed in — it is derived from its loads, so a two-leg shipment says
 * Dispatched only once both legs are.
 *
 * Which ladder a load climbs depends on the mode. Truckload goes Booked → Loading →
 * Unloading; LTL and forwarding go Planned → Picked Up → Recovered → OFD. Both share
 * Dispatched, In Transit and Delivered. Short labels are MVMNT's, verbatim (§6.8).
 *
 * Imports are relative and type-only: the tmsShipmentActions Lambda bundles this
 * file by path, so a `@/` alias would break the function build.
 */
import type {
  LoadCarrierStatus,
  LoadWorkflowStatus,
  ShipmentMode,
  ShipmentStatus,
} from '../types/tms'

export const SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'DRAFT',
  'TENDER_PENDING',
  'TENDER_REJECTED',
  'OPEN',
  'ON_HOLD',
  'BOOKED',
  'PLANNED',
  'DISPATCHED',
  'LOADING',
  'PICKED_UP',
  'IN_TRANSIT',
  'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL',
  'OUT_FOR_DELIVERY',
  'UNLOADING',
  'DELIVERED',
  'CANCELED',
]

export const LOAD_WORKFLOW_STATUSES: readonly LoadWorkflowStatus[] = [
  'SOURCING',
  'BOOKED',
  'PLANNED',
  'DISPATCHED',
  'LOADING',
  'PICKED_UP',
  'IN_TRANSIT',
  'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL',
  'OUT_FOR_DELIVERY',
  'UNLOADING',
  'DELIVERED',
  'INVOICING',
  'CANCELED',
]

/** Board column labels, verbatim from MVMNT's glossary (spec §6.8). */
export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  DRAFT: 'DRAFT',
  TENDER_PENDING: 'TEND PNDG',
  TENDER_REJECTED: 'TEND REJ',
  OPEN: 'OPEN',
  ON_HOLD: 'HOLD',
  BOOKED: 'BKD',
  PLANNED: 'PLND',
  DISPATCHED: 'DISP',
  LOADING: 'LDG',
  PICKED_UP: 'PKD UP',
  IN_TRANSIT: 'INTRAN',
  RECOVERED: 'RECVRD',
  ARRIVED_AT_DELIVERY_TERMINAL: 'ARVD @ DEL',
  OUT_FOR_DELIVERY: 'OFD',
  UNLOADING: 'UNL',
  DELIVERED: 'DEL',
  CANCELED: 'CXLD',
}

export const LOAD_WORKFLOW_STATUS_LABELS: Record<LoadWorkflowStatus, string> = {
  SOURCING: 'SRCNG',
  BOOKED: 'BKD',
  PLANNED: 'PLND',
  DISPATCHED: 'DISP',
  LOADING: 'LDG',
  PICKED_UP: 'PKD UP',
  IN_TRANSIT: 'INTRAN',
  RECOVERED: 'RECVRD',
  ARRIVED_AT_DELIVERY_TERMINAL: 'ARVD @ DEL',
  OUT_FOR_DELIVERY: 'OFD',
  UNLOADING: 'UNL',
  DELIVERED: 'DEL',
  INVOICING: 'INVCNG',
  CANCELED: 'CXLD',
}

/**
 * Modes that move on a truck we book whole. RLTL is an LTL variant and rides the
 * LTL ladder; air, ocean and rail are forwarding and get their editors in H/I.
 */
const TRUCKLOAD_MODES: readonly ShipmentMode[] = ['FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL']

export function isTruckloadMode(mode: ShipmentMode | null | undefined): boolean {
  return mode != null && TRUCKLOAD_MODES.includes(mode)
}

/** Booked → Loading → Unloading: one carrier, one trailer, door to door. */
export const TRUCKLOAD_LOAD_LADDER: readonly LoadWorkflowStatus[] = [
  'SOURCING',
  'BOOKED',
  'DISPATCHED',
  'LOADING',
  'IN_TRANSIT',
  'UNLOADING',
  'DELIVERED',
  'INVOICING',
]

/** Planned → Picked Up → Recovered → OFD: terminals and line-haul in between. */
export const LTL_LOAD_LADDER: readonly LoadWorkflowStatus[] = [
  'SOURCING',
  'PLANNED',
  'DISPATCHED',
  'PICKED_UP',
  'IN_TRANSIT',
  'RECOVERED',
  'ARRIVED_AT_DELIVERY_TERMINAL',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'INVOICING',
]

/**
 * How far along a status is, across both ladders, so progress can be compared
 * without knowing the mode. Statuses that are alternatives rather than successors
 * share a rank: a truckload load at LOADING and an LTL load at PICKED_UP are both
 * "left the shipper". CANCELED is outside the ladder and ranks below everything.
 */
export const MOVEMENT_RANK: Record<LoadWorkflowStatus, number> = {
  CANCELED: -1,
  SOURCING: 0,
  BOOKED: 1,
  PLANNED: 1,
  DISPATCHED: 2,
  LOADING: 3,
  PICKED_UP: 3,
  IN_TRANSIT: 4,
  RECOVERED: 5,
  ARRIVED_AT_DELIVERY_TERMINAL: 6,
  OUT_FOR_DELIVERY: 7,
  UNLOADING: 8,
  DELIVERED: 9,
  INVOICING: 10,
}

/**
 * Where a load may go next from where it is.
 *
 * Any forward step on its ladder is allowed — dispatch skips states all the time,
 * and refusing that only teaches people to lie about the previous one. What is
 * never allowed: going backwards, and setting INVOICING by hand (the AP review flow
 * owns it). Canceling is possible until the freight is delivered. A load comes back
 * to SOURCING by bouncing its carrier, not through this table.
 */
export function nextLoadStatuses(
  current: LoadWorkflowStatus | null | undefined,
  mode?: ShipmentMode | null,
): LoadWorkflowStatus[] {
  const from = current ?? 'SOURCING'
  if (from === 'CANCELED' || from === 'INVOICING') return []

  const ladder = isTruckloadMode(mode ?? 'FTL') ? TRUCKLOAD_LOAD_LADDER : LTL_LOAD_LADDER
  const rank = MOVEMENT_RANK[from]
  const next = ladder.filter((s) => s !== 'INVOICING' && MOVEMENT_RANK[s] > rank)
  if (from !== 'DELIVERED') next.push('CANCELED')
  return next
}

/**
 * `mode` is optional because the Lambda validates loads whose shipment mode it has
 * not read yet; without it, a transition legal on either ladder is accepted.
 */
export function canTransitionLoadStatus(
  from: LoadWorkflowStatus | null | undefined,
  to: LoadWorkflowStatus,
  mode?: ShipmentMode | null,
): boolean {
  if (mode != null) return nextLoadStatuses(from, mode).includes(to)
  return nextLoadStatuses(from, 'FTL').includes(to) || nextLoadStatuses(from, 'LTL').includes(to)
}

/**
 * Where a user may move a shipment from where it is.
 *
 * Only the states a person sets: the movement ladder (Booked…Delivered) is derived
 * from the loads, so it never appears here. Un-cancel returns a shipment to OPEN and
 * lets the load derivation take over again from the next status change.
 */
export function nextShipmentStatuses(current: ShipmentStatus): ShipmentStatus[] {
  switch (current) {
    case 'DRAFT':
      return ['OPEN', 'CANCELED']
    case 'TENDER_PENDING':
      return ['OPEN', 'TENDER_REJECTED', 'CANCELED']
    case 'TENDER_REJECTED':
      return ['TENDER_PENDING', 'CANCELED']
    case 'OPEN':
      return ['ON_HOLD', 'CANCELED']
    case 'ON_HOLD':
      return ['OPEN', 'CANCELED']
    case 'CANCELED':
      return ['OPEN']
    case 'DELIVERED':
      return []
    default:
      // In motion: it can be paused or killed, but not driven by hand.
      return ['ON_HOLD', 'CANCELED']
  }
}

export function canTransitionShipmentStatus(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return nextShipmentStatuses(from).includes(to)
}

/** One load as the derivation sees it: how far it got, and who is on it. */
export interface ShipmentLoadLike {
  status?: LoadWorkflowStatus | null
  /** Every assignment row's status, live and historic. */
  carrierStatuses?: LoadCarrierStatus[] | null
}

/**
 * States a person or a workflow put the shipment in, which no amount of load
 * movement may overwrite. A held shipment whose truck keeps rolling stays held.
 */
const STICKY_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'DRAFT',
  'TENDER_PENDING',
  'TENDER_REJECTED',
  'ON_HOLD',
  'CANCELED',
]

/**
 * The shipment's status, from its loads.
 *
 * The shipment is only as far along as its least advanced leg: Dispatched and
 * Delivered appear only once every load is. Canceled loads drop out of the
 * reckoning, and a shipment whose every load is canceled is canceled. A load that
 * had carriers and has no ACTIVE one left — all bounced, all TONU'd, or a mix — has
 * nobody on it whatever its stored status says, so it counts as sourcing again;
 * that is what MVMNT shows as TONU when every carrier was a TONU.
 */
export function shipmentStatusFromLoads(
  loads: ShipmentLoadLike[],
  current?: ShipmentStatus | null,
): ShipmentStatus {
  if (current && STICKY_SHIPMENT_STATUSES.includes(current)) return current
  if (loads.length === 0) return current ?? 'OPEN'

  let least: LoadWorkflowStatus | null = null
  for (const load of loads) {
    const status = effectiveLoadStatus(load)
    if (status === 'CANCELED') continue
    if (least == null || MOVEMENT_RANK[status] < MOVEMENT_RANK[least]) least = status
  }
  if (least == null) return 'CANCELED'

  // The shipment has no SOURCING of its own — it is simply still Open — and no
  // INVOICING either; to the customer, invoicing is delivered.
  if (least === 'SOURCING') return 'OPEN'
  if (least === 'INVOICING') return 'DELIVERED'
  return least
}

function effectiveLoadStatus(load: ShipmentLoadLike): LoadWorkflowStatus {
  const status = load.status ?? 'SOURCING'
  if (status === 'CANCELED' || status === 'SOURCING') return status
  const carriers = load.carrierStatuses ?? []
  if (carriers.length > 0 && !carriers.includes('ACTIVE')) return 'SOURCING'
  return status
}

/** A stop, as the status derivation reads it. */
export interface StopTimesLike {
  type: 'pickup' | 'delivery'
  sequence?: number | null
  arrivedAt?: string | null
  departedAt?: string | null
}

/**
 * The status the stop clock proves.
 *
 * In and out times at the first pickup and the last delivery are the only evidence
 * used: arrived at the shipper is Loading, left it is In Transit, arrived at the
 * consignee is Unloading, left it is Delivered. Everything in between is somebody's
 * claim, not a fact, and is left to whatever status was already set.
 *
 * It never goes backwards. Deleting a mistaken in-time does not un-deliver a load,
 * and a canceled load stays canceled; only a deliberate status change moves either.
 */
export function loadStatusFromStopTimes(
  stops: StopTimesLike[],
  current?: LoadWorkflowStatus | null,
): LoadWorkflowStatus {
  const from = current ?? 'SOURCING'
  if (from === 'CANCELED') return 'CANCELED'

  const ordered = [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const firstPickup = ordered.find((s) => s.type === 'pickup')
  const deliveries = ordered.filter((s) => s.type === 'delivery')
  const lastDelivery = deliveries[deliveries.length - 1]

  let derived: LoadWorkflowStatus | null = null
  if (stamped(lastDelivery?.departedAt)) derived = 'DELIVERED'
  else if (stamped(lastDelivery?.arrivedAt)) derived = 'UNLOADING'
  else if (stamped(firstPickup?.departedAt)) derived = 'IN_TRANSIT'
  else if (stamped(firstPickup?.arrivedAt)) derived = 'LOADING'

  if (derived == null) return from
  return MOVEMENT_RANK[derived] > MOVEMENT_RANK[from] ? derived : from
}

const stamped = (v: string | null | undefined): boolean => !!(v ?? '').trim()
