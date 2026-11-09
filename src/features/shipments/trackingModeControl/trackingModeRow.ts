/** The edit form field the chip lands on: the Carrier & Tracking card (dispatcher, or driver, truck and trailer). */
export const TRACKING_SET_PATH = (shipmentId: string): string => `/tms/shipments/${shipmentId}/edit?focus=tracking`

/** A covered load: a carrier or our own truck has it and it is still live (not delivered, canceled or void). */
export function isCoveredAndLive(row: { assignmentType?: string | null; status?: string | null; voidedAt?: string | null; revDivision?: string | null }): boolean {
  if (row.voidedAt) return false
  // Ivan Cartage (ASSETS) loads are followed by the assigned driver's own GPS, so no tracking link is asked for (Ryne 2026-11-09).
  if (row.revDivision === 'ASSETS') return false
  if (row.status === 'DELIVERED' || row.status === 'CANCELED') return false
  return row.assignmentType === 'CARRIER' || row.assignmentType === 'OWN_ASSET'
}

