/**
 * "Delivered, POD not on file" — the one definition.
 *
 * A shipment only waits on a POD once it is DELIVERED (the last rung of the shipment
 * ladder; CANCELED is not "later"). When the load has a rate sample, the sample's
 * `podReceivedAt` is the fact; with no sample the order's `docsMissing` list is.
 *
 * Moved verbatim out of `tms/dashboard/businessStrips.ts` so the dashboard strips, the
 * Financial operations page and the notification bell cannot disagree.
 */

/** A shipment that has reached delivery (shared with "Shipments completed"). */
export function isDeliveredStatus(shipmentStatus: string | null | undefined): boolean {
  return shipmentStatus === 'DELIVERED'
}

/**
 * @param sampleHasPod `true`/`false` when the load has a rate sample (whether its POD
 *   arrived); `null` when there is no sample, so `docsMissing` decides.
 */
export function isPodMissing(
  shipmentStatus: string | null | undefined,
  docsMissing: readonly string[] | null | undefined,
  sampleHasPod: boolean | null,
): boolean {
  if (!isDeliveredStatus(shipmentStatus)) return false
  if (sampleHasPod !== null) return !sampleHasPod
  return (docsMissing ?? []).includes('POD')
}
