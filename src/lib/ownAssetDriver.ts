// Step W: an Ivan Cartage (own-asset) load must carry a driver.
//
// Pure decisions shared by the TMS UI and the tms-shipment-actions Lambda (bundled by path:
// relative imports only). Nothing here computes pay; it only decides whether a driver is
// present/usable and whether re-assigning one would move delivered history between pay weeks.
import { weekStartOfISO } from '../features/driver-pay/week'

export const OWN_ASSET_MESSAGES = {
  driverNotFound: (id: string) => `Driver not found: ${id}`,
  driverBroker: (name: string) => `${name} is a placeholder for brokered freight, not one of Ivan Cartage's drivers`,
  driverInactive: (name: string) => `${name} is inactive. Reactivate the driver or pick another one.`,
  driverInactiveDispatch: (name: string) => `${name} is inactive: pick an active driver before dispatching.`,
  needDriverDispatch: 'Ivan Cartage load: pick the driver before dispatching (Carrier/Driver tab → Assign driver).',
  needDriverDelivered: 'Ivan Cartage load: pick the driver before marking it delivered (Carrier/Driver tab → Assign driver).',
  needDeliveryDriver: 'Ivan Cartage load: the delivery stop has no driver, so no settlement would pick it up. Re-assign the driver on the Carrier/Driver tab.',
  releaseNoDriver: 'Missing driver: this Ivan Cartage load has no driver (Carrier/Driver tab → Assign driver)',
  releaseNoDeliveryDriver: 'Missing driver on the delivery stop: re-assign the driver on the Carrier/Driver tab',
  relay: (a: string, b: string) => `This load runs as a relay (${a} → ${b}). Booking one driver puts them on every stop. Confirm to continue.`,
  typedIvanCartage: 'Ivan Cartage is our own fleet. Use "Book Ivan Cartage (own fleet)" and pick the driver.',
  batchMultiLeg: 'Batch driver assignment handles one-leg shipments; open this shipment to assign each leg.',
  batchCovered: (carrier: string) => `This load is covered by ${carrier}. Bounce the carrier on the shipment first.`,
  payClosedWeek: (date: string, oldName: string, newName: string) =>
    `Delivered ${date}: that pay week has closed. Changing the driver would move this load between ${oldName}'s and ${newName}'s settlements. An owner or ADMIN can do it with a reason.`,
  payReasonRequired: 'Give a reason (at least 10 characters) to change the driver on a load in a closed pay week.',
  payBoxTrip: (driver: string, periodStart: string) =>
    `This load is already on ${driver}'s box-truck settlement (period starting ${periodStart}). Remove it from that settlement first, then change the driver.`,
} as const

export interface OwnAssetLoadFacts {
  assignmentType?: string | null; status?: string | null; voidedAt?: string | null
  /** Imported Aljex history carries no driver fields and is exempt from Step W (DECIDED-5). */
  legacyImported?: boolean | null
  pickupDriverId?: string | null; deliveryDriverId?: string | null; deliveryAppt?: string | null
  stops?: Array<{ driverId?: string | null; truckId?: string | null; colorKey?: string | null }> | null
}
export interface OwnAssetLegFacts { kind?: string | null; status?: string | null; driverId?: string | null }
export interface RosterDriverFacts { id: string; name?: string | null; active?: boolean | null; type?: string | null }

const blank = (v: string | null | undefined): boolean => v == null || String(v).trim() === ''

export function isBrokerDriver(d: { type?: string | null } | null | undefined): boolean {
  return (d?.type ?? '').toLowerCase() === 'broker'
}

/** §2.1: an Ivan Cartage load is defined by kind, never by name; voided/canceled shipments and imported legacy history are exempt. */
export function isOwnAssetLoad(load: OwnAssetLoadFacts, activeLeg: OwnAssetLegFacts | null): boolean {
  if (!blank(load.voidedAt)) return false
  if (load.status === 'CANCELED') return false
  if (load.legacyImported === true) return false
  return load.assignmentType === 'OWN_ASSET' || activeLeg?.kind === 'OWN_ASSET'
}

export type OwnAssetGapCode = 'NO_DRIVER' | 'NO_DELIVERY_DRIVER' | 'DRIVER_UNKNOWN' | 'DRIVER_BROKER' | 'DRIVER_INACTIVE'

/**
 * null = fine (also for loads that are not Ivan Cartage loads).
 * `driver` is the roster row for activeLeg.driverId (null = looked up, absent; undefined = not looked up,
 * presence-only check). DELIVERED only needs a driver to be present; DISPATCH also needs a usable one.
 */
export function ownAssetDriverGap(i: {
  load: OwnAssetLoadFacts; activeLeg: OwnAssetLegFacts | null
  driver?: RosterDriverFacts | null
  phase: 'DISPATCH' | 'DELIVERED'
  deliveryDriverId?: string | null
}): { code: OwnAssetGapCode; message: string } | null {
  const { load, activeLeg, driver, phase } = i
  if (!isOwnAssetLoad(load, activeLeg)) return null
  if (blank(activeLeg?.driverId)) {
    return {
      code: 'NO_DRIVER',
      message: phase === 'DISPATCH' ? OWN_ASSET_MESSAGES.needDriverDispatch : OWN_ASSET_MESSAGES.needDriverDelivered,
    }
  }
  const delivery = i.deliveryDriverId !== undefined ? i.deliveryDriverId : load.deliveryDriverId
  if (blank(delivery)) return { code: 'NO_DELIVERY_DRIVER', message: OWN_ASSET_MESSAGES.needDeliveryDriver }
  if (phase === 'DISPATCH' && driver !== undefined) {
    const id = String(activeLeg?.driverId)
    if (driver === null) return { code: 'DRIVER_UNKNOWN', message: OWN_ASSET_MESSAGES.driverNotFound(id) }
    const name = driver.name || id
    if (isBrokerDriver(driver)) return { code: 'DRIVER_BROKER', message: OWN_ASSET_MESSAGES.driverBroker(name) }
    if (driver.active === false) return { code: 'DRIVER_INACTIVE', message: OWN_ASSET_MESSAGES.driverInactiveDispatch(name) }
  }
  return null
}

/** Assign-time roster check (exists, not a broker placeholder, active). null = fine. */
export function driverProblem(driverId: string, driver: RosterDriverFacts | null | undefined): string | null {
  if (!driver) return OWN_ASSET_MESSAGES.driverNotFound(driverId)
  const name = driver.name || driverId
  if (isBrokerDriver(driver)) return OWN_ASSET_MESSAGES.driverBroker(name)
  if (driver.active === false) return OWN_ASSET_MESSAGES.driverInactive(name)
  return null
}

export function distinctStopDrivers(stops: OwnAssetLoadFacts['stops']): string[] {
  const seen: string[] = []
  for (const s of stops ?? []) {
    const id = s?.driverId
    if (blank(id)) continue
    const v = String(id).trim()
    if (!seen.includes(v)) seen.push(v)
  }
  return seen
}

/** Blank stops inherit the leg's driver/truck; stops that already name someone are never overwritten. */
export function fillBlankStopDrivers<T extends { driverId?: string | null; truckId?: string | null }>(
  stops: T[], driverId: string, truckId: string | null,
): T[] {
  return stops.map((s) => ({
    ...s,
    driverId: blank(s.driverId) ? driverId : s.driverId,
    truckId: blank(s.truckId) ? truckId : s.truckId,
  }))
}

export function clearStopColors<T extends { colorKey?: string | null }>(stops: T[]): T[] {
  return stops.map((s) => ({ ...s, colorKey: null }))
}

/**
 * 'YYYY-MM-DD' when the delivery date is before the current Sun–Sat pay week, else null.
 * Same UTC `slice(0,10)` semantics as ownerOpTripsFor / useBoxTruckPay; status is deliberately ignored.
 */
export function closedPayWeek(deliveryAppt: string | null | undefined, todayUtc: string): string | null {
  if (blank(deliveryAppt)) return null
  const date = String(deliveryAppt).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return date < weekStartOfISO(todayUtc) ? date : null
}

export type PayLockResult =
  | { state: 'OPEN' }
  | { state: 'CLOSED_WEEK_OVERRIDE'; deliveryDate: string; reason: string }
  | { state: 'REFUSED'; code: 'BOX_TRUCK_TRIP' | 'CLOSED_WEEK' | 'REASON_REQUIRED'; message: string }

export const PAY_OVERRIDE_REASON_MIN = 10

export function evaluatePayLock(i: {
  deliveryAppt?: string | null; todayUtc: string
  boxTrip?: { periodStart: string; driverName?: string | null } | null
  oldDriverName: string; newDriverName: string; isAdmin: boolean; reason?: string | null
}): PayLockResult {
  if (i.boxTrip) {
    return {
      state: 'REFUSED', code: 'BOX_TRUCK_TRIP',
      message: OWN_ASSET_MESSAGES.payBoxTrip(i.boxTrip.driverName || i.oldDriverName, i.boxTrip.periodStart),
    }
  }
  const deliveryDate = closedPayWeek(i.deliveryAppt, i.todayUtc)
  if (!deliveryDate) return { state: 'OPEN' }
  if (!i.isAdmin) {
    return {
      state: 'REFUSED', code: 'CLOSED_WEEK',
      message: OWN_ASSET_MESSAGES.payClosedWeek(deliveryDate, i.oldDriverName, i.newDriverName),
    }
  }
  const reason = (i.reason ?? '').trim()
  if (reason.length < PAY_OVERRIDE_REASON_MIN) {
    return { state: 'REFUSED', code: 'REASON_REQUIRED', message: OWN_ASSET_MESSAGES.payReasonRequired }
  }
  return { state: 'CLOSED_WEEK_OVERRIDE', deliveryDate, reason }
}
