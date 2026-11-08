/**
 * The Load patch a carrier assignment writes.
 *
 * Ryne, 2026-10-28: "loads and shipments are the same exact thing." The user sees
 * one record, but the legacy `Load` row is what the calendar, dispatch, the driver
 * app, box-truck and owner-operator settlements, employee stats, the fleet
 * dashboards, PODs and factoring all read — and none of them is changing. So when
 * a shipment is booked to our own fleet, the mirrored Load has to come out looking
 * exactly like a load booked on the calendar today; when an outside carrier takes
 * it, the Load has to stop looking like one, or it stays on the calendar and in
 * that driver's settlement forever.
 *
 * Which fields that means is NOT a guess: ownership of a load is `stops[].driverId`
 * plus the `pickupDriverId` / `deliveryDriverId` mirrors, the truck is `truckId`,
 * the trailer is `trailerNumber`, and the dates are `pickupAppt` / `deliveryAppt`
 * derived from the stops. Nothing here touches `rate`, `readyToInvoice`, `aljexId`,
 * the addresses or the appointments — those belong to the load, not to who is
 * pulling it.
 *
 * Both patches are idempotent: applying one twice is the same as applying it once.
 *
 * Imports are relative and type-only: the tmsShipmentActions Lambda bundles this
 * file by path, so a `@/` alias would break the function build.
 */
import type { Stop } from '../types'
import type { AssignmentType, TrackingProvider } from '../types/tms'

/**
 * A stop as the own-fleet writers leave it: `Stop` plus the truck the dispatch
 * drawer stamps on it (`stops` is an `a.json()` column, so the truck rides along
 * without a schema change).
 */
export type MirrorStop = Stop & { truckId?: string | null }

/** Who is pulling it, as the driver/truck picker hands it over. */
export interface OwnFleetAssignment {
  driverId: string
  /** Already resolved by the caller (new truck ?? the load's truck ?? null). */
  truckId?: string | null
  /** Likewise resolved by the caller — a blank booking must not erase the trailer. */
  trailerNumber?: string | null
}

/** The own-fleet patch: everything an own-fleet reader needs to see the load. */
export interface OwnFleetLoadPatch {
  stops: MirrorStop[]
  pickupDriverId: string | null
  deliveryDriverId: string | null
  /** Omitted when the stops carry no appointment — the column is required. */
  pickupAppt?: string
  deliveryAppt?: string
  truckId: string | null
  trailerNumber: string | null
  assignmentType: AssignmentType
  trackingProvider: TrackingProvider
  carrierName: string | null
}

/** The clear patch: the load leaves every own-fleet view. */
export interface ClearedLoadPatch {
  stops: MirrorStop[]
  pickupDriverId: null
  deliveryDriverId: null
  truckId: null
  trailerNumber: null
  assignmentType: AssignmentType
  carrierName: string | null
}

const bySequence = (stops: MirrorStop[]): MirrorStop[] =>
  [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))

/**
 * Put the driver (and truck) on every stop, the way the dispatch drawer does. One
 * driver pulls the whole load; a per-leg split is a stop-level edit afterwards.
 */
export function ownFleetLoadPatch(stops: MirrorStop[], assignment: OwnFleetAssignment): OwnFleetLoadPatch {
  const { driverId, truckId = null, trailerNumber = null } = assignment
  const next = stops.map((s) => ({ ...s, driverId, ...(truckId ? { truckId } : {}) }))

  // The legacy mirrors, derived exactly the way the router's deriveLegacyFields
  // does it: the first pickup and the last delivery by sequence, falling back to
  // the ends of the route when a load has only one kind of stop.
  const ordered = bySequence(next)
  const pickups = ordered.filter((s) => s.type === 'pickup')
  const deliveries = ordered.filter((s) => s.type === 'delivery')
  const firstPickup = pickups[0] ?? ordered[0] ?? null
  const lastDelivery = deliveries[deliveries.length - 1] ?? ordered[ordered.length - 1] ?? null

  return {
    stops: next,
    pickupDriverId: firstPickup ? firstPickup.driverId : null,
    deliveryDriverId: lastDelivery ? lastDelivery.driverId : null,
    // `pickupAppt`/`deliveryAppt` are required columns: a blank one is left alone
    // rather than written empty over a date the load already has.
    ...(firstPickup?.appt ? { pickupAppt: firstPickup.appt } : {}),
    ...(lastDelivery?.appt ? { deliveryAppt: lastDelivery.appt } : {}),
    truckId,
    trailerNumber,
    assignmentType: 'OWN_ASSET',
    // Our drivers report through the Ivan app; nothing else is asked of them.
    trackingProvider: 'DRIVER_APP',
    carrierName: null,
  }
}

/**
 * Strip our fleet off the stops without touching anything else on them — the
 * appointments, addresses, references and actual arrival times all stay.
 */
function clearedStops(stops: MirrorStop[]): MirrorStop[] {
  return stops.map((s) => {
    const { truckId: _truckId, ...rest } = s
    return { ...rest, driverId: null }
  })
}

/** An outside carrier took the load: it leaves the calendar, dispatch and settlements. */
export function outsideCarrierLoadPatch(stops: MirrorStop[], carrier: { carrierName: string | null }): ClearedLoadPatch {
  return {
    stops: clearedStops(stops),
    pickupDriverId: null,
    deliveryDriverId: null,
    truckId: null,
    trailerNumber: null,
    assignmentType: 'CARRIER',
    carrierName: carrier.carrierName,
  }
}

/** The carrier bounced, or nobody is on it yet: same clear, no carrier name. */
export function uncoveredLoadPatch(stops: MirrorStop[]): ClearedLoadPatch {
  return {
    stops: clearedStops(stops),
    pickupDriverId: null,
    deliveryDriverId: null,
    truckId: null,
    trailerNumber: null,
    assignmentType: 'NEED_TO_COVER',
    carrierName: null,
  }
}
