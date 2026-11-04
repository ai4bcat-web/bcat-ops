import { getShipmentsByIds } from '@/lib/boardData'
import { listDocsNeededOrdersNarrow, listOrdersByShipmentIds } from '@/lib/apiClient'
import { isShipmentVoided } from '@/lib/shipmentVoid'
import type { OrderRecord, ShipmentRecord } from '@/types/tms'

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

/**
 * The DOCS_NEEDED tab: its orders and their shipments, without reading the debris in full. The
 * tab holds thousands of orders (dev: 2,575, nearly all of voided shipments) and the worklist drops
 * an order whose shipment is voided, so the full order rows are read only for the live shipments:
 * a narrow order list, the narrow shipment check, then the full orders of the survivors by id.
 */
export async function loadDocsNeededWorklist(): Promise<{ orders: OrderRecord[]; shipments: ShipmentRecord[] }> {
  const narrow = await listDocsNeededOrdersNarrow()
  const shipments = await loadWorklistShipments(narrow.map((o) => o.shipmentId).filter((id): id is string => !!id))
  const liveIds = shipments.filter((s) => !isShipmentVoided(s)).map((s) => s.id)
  const orders = (await listOrdersByShipmentIds(liveIds)).filter((o) => o.arStatus === 'DOCS_NEEDED')
  return { orders, shipments }
}
