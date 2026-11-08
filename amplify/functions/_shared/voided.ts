/**
 * Void is the only way a shipment leaves the working set.
 *
 * Ryne, 2026-10-28 — "the most important thing": a PRO number is permanent. No
 * delete mutation, no delete action, no delete button, anywhere. A voided shipment
 * keeps its number, its legs, its charges, its documents and its history; it is
 * simply refused by every write path from then on.
 *
 * `deletedAt` is the marker Step B's removed soft delete wrote. Rows that already
 * carry it are voided too — the field stays in the schema (additive rule), and a
 * reader that only looked at `voidedAt` would put those shipments back on the board.
 */
import type { Row } from './shipmentStore'

/** The shape every caller actually has: a shipment row, however it was read. */
export type VoidableShipment = Pick<Row, never> & {
  id?: unknown
  number?: unknown
  voidedAt?: unknown
  deletedAt?: unknown
}

/** `voidedAt ?? deletedAt` — either marker means the shipment is out of the working set. */
export function isVoided(shipment: VoidableShipment | null | undefined): boolean {
  if (!shipment) return false
  return shipment.voidedAt != null || shipment.deletedAt != null
}

/**
 * The guard every write action runs before it touches a shipment, its order, its
 * load or its assignment. One sentence, naming the shipment the way a person does.
 */
export function assertNotVoided(shipment: VoidableShipment): void {
  if (!isVoided(shipment)) return
  const label = typeof shipment.number === 'string' && shipment.number ? shipment.number : String(shipment.id ?? '')
  throw new Error(`Shipment ${label} is voided`)
}
