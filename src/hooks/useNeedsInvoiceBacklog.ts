import { useEffect, useState } from 'react'
import { listDocsNeededOrdersNarrow, listLoadsByShipmentIds } from '@/lib/apiClient'
import { cachedList, peekList } from '@/lib/listCache'
import type { Load } from '@/types'

const KEY = 'legacy:needsInvoiceBacklog'
const NONE: Load[] = []

/**
 * The legacy "needs invoice" backlog, whatever its age: non-voided loads not yet marked
 * `readyToInvoice`, found through the shipments whose order is still DOCS_NEEDED (the
 * Order arStatus index) instead of a Load-table scan, now that the store only holds a
 * window of loads. The caller applies its own delivered-before-today test to them.
 *
 * Exactly the old all-history count except for one legacy class: a load whose own
 * `readyToInvoice` is false while its order is NOT DOCS_NEEDED (released, billed or
 * LEGACY arStatus) is not found here — the order is the system of record for release and
 * such a load is not owed an invoice.
 */
export function useNeedsInvoiceBacklog(): Load[] {
  const [rows, setRows] = useState<Load[]>(() => peekList<Load[]>(KEY) ?? NONE)
  useEffect(() => {
    let live = true
    cachedList(KEY, async () => {
      const orders = await listDocsNeededOrdersNarrow()
      const ids = [...new Set(orders.map((o) => o.shipmentId).filter((id): id is string => !!id))]
      const loads = await listLoadsByShipmentIds(ids)
      return loads.filter((l) => !l.readyToInvoice && !l.voidedAt)
    }, { ttlMs: 300_000 })
      .then((r) => { if (live) setRows(r) })
      .catch((err: unknown) => console.warn('[useNeedsInvoiceBacklog] could not read the backlog', err))
    return () => { live = false }
  }, [])
  return rows
}
