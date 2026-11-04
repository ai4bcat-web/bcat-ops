import { getShipmentsByIds } from '@/lib/boardData'
import { isShipmentVoided } from '@/lib/shipmentVoid'
import type { ShipmentRecord } from '@/types/tms'

/**
 * The shipments an AR/AP worklist decorates its rows with, read by id instead of through a
 * full `listShipments()` (PERF R1). A DOCS_NEEDED tab holds thousands of orders, most of them
 * voided import debris, so the first pass is the narrow (id, status, void markers) read the
 * working-set loader already memoises; only the live ones are fetched in full. Voided ones
 * stay in the result as their narrow rows, because the worklists drop an order by finding its
 * shipment voided — a missing shipment would leave the row on the tab.
 */
export async function loadWorklistShipments(shipmentIds: readonly string[]): Promise<ShipmentRecord[]> {
  const ids = [...new Set(shipmentIds)]
  if (ids.length === 0) return []
  const narrow = await getShipmentsByIds(ids, true)
  const voided: ShipmentRecord[] = []
  const liveIds: string[] = []
  for (const id of ids) {
    const row = narrow.get(id)
    if (!row) continue
    if (isShipmentVoided(row)) voided.push(row)
    else liveIds.push(id)
  }
  const full = await getShipmentsByIds(liveIds, false)
  return [...voided, ...liveIds.flatMap((id) => full.get(id) ?? [])]
}
