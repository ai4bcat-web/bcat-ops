/**
 * Which shipments are still operations' work, for counts that are read off loads or documents
 * rather than shipment rows (the Track tab's check calls due and driver PODs to review).
 *
 * A load is only ever in one place (Ryne 2026-11-16): once it is pushed into Load Review,
 * released to invoicing, invoiced or factored it has left operations, and nothing on it counts
 * as Tracking work. Voided and canceled loads never count either. The rule is
 * `hasLeftOperations`, the same one the board's Active list and Tracking's lifecycle use.
 */
import { hasLeftOperations, type ListRow } from './shipmentLists'
import { boardStatusOf } from './shipmentViewDefs'

export interface OperationsRow extends ListRow {
  id: string
  orderIds?: readonly string[] | null
  loadIds?: readonly string[] | null
}

export interface OperationsIndex {
  shipmentIds: ReadonlySet<string>
  orderIds: ReadonlySet<string>
  loadIds: ReadonlySet<string>
}

/** The ids of every shipment, order and load still in operations. */
export function operationsIndex(rows: readonly OperationsRow[]): OperationsIndex {
  const shipmentIds = new Set<string>()
  const orderIds = new Set<string>()
  const loadIds = new Set<string>()
  for (const row of rows) {
    const status = boardStatusOf(row)
    if (status === 'VOIDED' || status === 'CANCELED') continue
    if (hasLeftOperations(row)) continue
    shipmentIds.add(row.id)
    for (const id of row.orderIds ?? []) orderIds.add(id)
    for (const id of row.loadIds ?? []) loadIds.add(id)
  }
  return { shipmentIds, orderIds, loadIds }
}

/** A document (or anything carrying shipment/order/load ids) that belongs to a load still in operations. */
export function isOperationsWork(
  item: { shipmentId?: string | null; orderId?: string | null; loadId?: string | null },
  index: OperationsIndex,
): boolean {
  return (item.shipmentId != null && index.shipmentIds.has(item.shipmentId))
    || (item.orderId != null && index.orderIds.has(item.orderId))
    || (item.loadId != null && index.loadIds.has(item.loadId))
}
