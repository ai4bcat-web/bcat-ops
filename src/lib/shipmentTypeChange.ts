/**
 * When a shipment's type (and with it the stored mode) may still be changed. Pure, so the Freight
 * card, the save pipeline and SET_SHIPMENT_TYPE read one rule.
 *
 * A draft takes the type through the form's own save. After that the type can still be fixed while
 * the load is open (Sourcing or Booked) and nothing downstream has been built on it: no invoice, no
 * frozen financials. Booked carriers are only a problem when the change moves the load between
 * truckload and non-truckload, because the two use different workflow ladders.
 */
import type { ShipmentMode } from '../types/tms'
import { isTruckloadMode } from './shipmentStatus'

/** Load statuses in which the type can still be corrected. */
export const TYPE_EDITABLE_LOAD_STATUSES: readonly string[] = ['SOURCING', 'BOOKED']

export interface TypeChangeFacts {
  shipmentStatus: string | null | undefined
  loadStatus: string | null | undefined
  hasInvoice: boolean
  financialsFrozen: boolean
}

/** Why the type is fixed now, or null when it can be changed. A draft is never locked here. */
export function typeLockReason(f: TypeChangeFacts): string | null {
  if (f.shipmentStatus === 'DRAFT') return null
  if (f.hasInvoice) return 'This order is invoiced, so the shipment type is fixed.'
  if (f.financialsFrozen) return 'The numbers are frozen, so the shipment type is fixed.'
  const status = f.loadStatus ?? ''
  if (!TYPE_EDITABLE_LOAD_STATUSES.includes(status)) {
    return `The load is ${status ? status.toLowerCase().replace(/_/g, ' ') : 'past booking'}; the shipment type can only be changed while it is Sourcing or Booked.`
  }
  return null
}

/** Why a booked carrier blocks moving from `from` to `to`, or null. */
export function typeCarrierBlock(from: ShipmentMode | null | undefined, to: ShipmentMode, hasActiveCarrier: boolean): string | null {
  if (!hasActiveCarrier) return null
  if (isTruckloadMode(from ?? 'FTL') === isTruckloadMode(to)) return null
  return 'A carrier is booked. Remove the carrier before moving this load between truckload and non-truckload types.'
}
