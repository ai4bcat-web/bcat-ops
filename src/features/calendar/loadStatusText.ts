import { boardStatusOf } from '@/lib/shipmentViewDefs'
import type { Load } from '@/types'

/**
 * The shipment's current status as the Active Shipments board words it (OPEN, COVERED, DISPATCHED, DEPARTED, ARRIVED, DELIVERED, HOLD,
 * CANCELED). A load that predates the shipment layer has no status: it shows nothing rather than a guess. Load-only rungs map onto the
 * shipment ladder: sourcing is still open; invoicing means delivered.
 */
export function loadStatusText(load: Pick<Load, 'status' | 'assignmentType'>): string {
  if (!load.status) return ''
  const status = load.status === 'SOURCING' ? 'OPEN' : load.status === 'INVOICING' ? 'DELIVERED' : load.status
  return boardStatusOf({ status, assignmentType: load.assignmentType ?? null })
}
