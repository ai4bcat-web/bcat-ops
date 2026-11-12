/**
 * Whether a shipment is car-shipping work (Best Care Auto Transport).
 *
 * The revenue division is the one signal every car-shipping load carries: the ownership
 * rules put the Auto Shipper customer and Aljex Rev Type A loads in CAR_SHIPPING, and a
 * hand tag can put any other load there. Customer name, equipment or mode would each miss
 * some of them. The division is mirrored onto the Load, so either row works here.
 */
export const CAR_SHIPPING_DIVISION = 'CAR_SHIPPING'

export function isCarShipperLoad(row: { revDivision?: string | null } | null | undefined): boolean {
  return (row?.revDivision ?? '').trim().toUpperCase() === CAR_SHIPPING_DIVISION
}
