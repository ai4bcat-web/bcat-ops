/** Our own fleet is Ivan Cartage (MC 274623): it needs no MyCarrierPackets setup packet, and its directory record is always Active. */
export const OWN_FLEET_MCS: readonly string[] = ['274623']

/** Whether an MC number (with or without the MC prefix) is our own fleet. */
export function isOwnFleetMc(mcNumber: unknown): boolean {
  const digits = String(mcNumber ?? '').replace(/^MC/i, '').replace(/\D/g, '')
  return digits !== '' && OWN_FLEET_MCS.includes(digits)
}
