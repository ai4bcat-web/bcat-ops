/** The AuditLog index keys of one shipment: used by the History tab and the form rail's Activity block. */
import type { ShipmentBundle } from '@/types/tms'

/**
 * The (entityType, entityId) keys the AuditLog index is read by. The Lambda writers stamp the
 * upper-case names and the browser writers the model names, so both spellings are asked for;
 * `SHIPMENT_POSTING` rows are keyed by the shipment id (POST_LOAD / UNPOST_LOAD).
 */
export function auditEntitiesFor(bundle: ShipmentBundle): Array<{ entityType: string; entityId: string }> {
  const keyed = (types: string[], ids: string[]) => ids.flatMap((entityId) => types.map((entityType) => ({ entityType, entityId })))
  return [
    ...keyed(['SHIPMENT', 'Shipment', 'SHIPMENT_POSTING'], [bundle.shipment.id]),
    ...keyed(['ORDER', 'Order'], bundle.orders.map((o) => o.id)),
    ...keyed(['LOAD', 'Load'], bundle.loads.map((l) => l.id)),
    ...keyed(['LOAD_CARRIER', 'LoadCarrier'], bundle.loadCarriers.map((c) => c.id)),
  ]
}
