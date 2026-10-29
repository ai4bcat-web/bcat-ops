/**
 * Where an own-fleet leg goes once Ivan Cartage is booked on it.
 *
 * Booking own fleet writes the mirrored Load, so the shipment is a load for every
 * existing feature: the calendar, dispatch, the driver app and the settlement run. The
 * settlement is the one that is not a single page — each fleet group is paid on its own
 * — so the link is resolved from the driver's fleet group rather than guessed.
 */
import type { DriverFleet } from '@/types/equipment'

export const OWN_FLEET_CALENDAR_PATH = '/calendar'
export const OWN_FLEET_DISPATCH_PATH = '/dispatch'

export function settlementPathFor(fleetGroup: DriverFleet | null | undefined): string {
  if (fleetGroup === 'BOX_TRUCK') return '/driver-pay-box-trucks'
  if (fleetGroup === 'OWNER_OPERATOR') return '/owner-operator-pay'
  return '/driver-pay'
}
