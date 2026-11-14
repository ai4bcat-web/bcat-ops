/**
 * "Delivered, not ready": loads that have delivered but are still in Load Review (order
 * DOCS_NEEDED), for the Ready to invoice card. The cheapest read there is: the narrow
 * DOCS_NEEDED order index, then the narrow shipment rows (status, deliveredAt, voidedAt) —
 * no full orders or shipments. Kept for five minutes, and read only while the tab is open.
 */
import { useEffect, useState } from 'react'
import { getShipmentsByIds } from '@/lib/boardData'
import { listDocsNeededOrdersNarrow } from '@/lib/apiClient'
import { cachedList } from '@/lib/listCache'
import { isShipmentVoided } from '@/lib/shipmentVoid'
import type { ShipmentRecord } from '@/types/tms'

const KEY = 'ar:deliveredNotReady'

export function isDeliveredNotReady(s: Pick<ShipmentRecord, 'status' | 'deliveredAt' | 'voidedAt' | 'deletedAt'>): boolean {
  if (isShipmentVoided(s as ShipmentRecord) || s.deletedAt) return false
  return Boolean(s.deliveredAt) || String(s.status ?? '').toUpperCase() === 'DELIVERED'
}

/** Null until the read lands (or when it fails): the card shows a dash, never a made-up zero. */
export function useDeliveredNotReady(enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    cachedList(KEY, async () => {
      const orders = await listDocsNeededOrdersNarrow()
      const ids = [...new Set(orders.map((o) => o.shipmentId).filter((id): id is string => !!id))]
      const shipments = await getShipmentsByIds(ids, true)
      return [...shipments.values()].filter(isDeliveredNotReady).map((s) => s.id)
    }, { ttlMs: 300_000 })
      .then((ids) => { if (live) setCount(ids.length) })
      .catch(() => { /* the card keeps its dash */ })
    return () => { live = false }
  }, [enabled])
  return count
}
