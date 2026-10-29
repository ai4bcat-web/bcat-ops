import { RELEASE_GATE_ERROR_PREFIX } from '@/lib/releaseGate'
import type { ArStatus, OrderRecord, ShipmentRecord } from '@/types/tms'

/** Past delivery on either axis: the movement status, or an AR rung beyond Docs needed. */
const RELEASED_AR_STATUSES: ArStatus[] = ['UNBILLED', 'UNPAID', 'PAID', 'LEGACY']

export function isDeliveredOrLater(shipment: ShipmentRecord, order: OrderRecord | null): boolean {
  if (shipment.status === 'DELIVERED') return true
  return order?.arStatus != null && RELEASED_AR_STATUSES.includes(order.arStatus)
}

/**
 * The refusal the routers throw — `Not ready for accounting: a; b` — split back into the
 * reasons it was joined from, so a button error renders as the same checklist the card
 * draws. `null` when the message is some other failure and must be shown as written.
 */
export function releaseGateMessages(message: string): string[] | null {
  if (!message.startsWith(RELEASE_GATE_ERROR_PREFIX)) return null
  const body = message.slice(RELEASE_GATE_ERROR_PREFIX.length).replace(/^[:\s]+/, '')
  const parts = body.split(';').map((part) => part.trim()).filter(Boolean)
  return parts.length > 0 ? parts : null
}
