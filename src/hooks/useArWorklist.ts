/**
 * One rung of the AR ladder, as a worklist the office can act on.
 *
 * Each tab is one sparse-index read — `listOrdersByArStatus` — joined to the shipment
 * it belongs to, because an order alone cannot say which shipment number it is, when it
 * delivered or whether the customer ever got it. The shipments come from one
 * `listShipments()` indexed by id rather than a `getShipment` per row: the three tabs
 * are bounded working sets, but they are still dozens of rows, and dozens of round
 * trips to colour a list is the pattern this codebase keeps paying for elsewhere.
 *
 * `reasons` here is the cheap, cached-field verdict — what the board can say without
 * opening five tables. The authoritative refusal list is the server's `invoiceReadiness`,
 * which comes back from `previewInvoice` when somebody actually goes to bill.
 *
 * Polled on the same 60 s clock as the rest of the TMS surface: Order has no
 * subscriptions, and a document review three desks away moves a row between tabs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listOrdersByArStatus, listShipments } from '@/lib/apiClient'
import { isShipmentVoided } from '@/lib/shipmentVoid'
import type { OrderRecord, ShipmentRecord } from '@/types/tms'

const POLL_MS = 60_000

/** The three rungs that are worklists. PAID is read through Invoice, never here. */
export type ArWorklistTab = 'DOCS_NEEDED' | 'UNBILLED' | 'UNPAID'

export interface ArWorklistRow {
  order: OrderRecord
  /** Null only while the shipment read has not landed; voided shipments are dropped. */
  shipment: ShipmentRecord | null
  orderId: string
  shipmentId: string
  shipmentNumber: string | null
  customerId: string
  customerName: string
  /** `Customer.billToParties[].id`; resolving it to a name needs the customer record. */
  billToId: string | null
  deliveredAt: string | null
  arStatusChangedAt: string | null
  revenueCents: number
  docsRequired: string[]
  docsMissing: string[]
  /** Nothing the customer's invoice settings ask for is missing. */
  docsReady: boolean
  invoiceNumber: string | null
  invoicedAt: string | null
  arBalanceCents: number | null
  /** What the cached fields alone can say is standing in the way. */
  reasons: string[]
}

export interface ArWorklist {
  /** Oldest change first: the queue is worked in the order it aged. */
  rows: ArWorklistRow[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useArWorklist(tab: ArWorklistTab): ArWorklist {
  const [orders, setOrders] = useState<OrderRecord[]>([])
  const [shipments, setShipments] = useState<ShipmentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    return Promise.all([listOrdersByArStatus(tab), listShipments()])
      .then(([orderRows, shipmentRows]) => {
        setOrders(orderRows)
        setShipments(shipmentRows)
        setError(null)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'AR worklist failed to load') })
      .finally(() => setLoading(false))
  }, [tab])

  useEffect(() => {
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [load])

  const rows = useMemo(() => {
    const byId = new Map<string, ShipmentRecord>()
    for (const s of shipments) byId.set(s.id, s)

    const built = orders
      .map((order): ArWorklistRow | null => {
        const shipment = byId.get(order.shipmentId) ?? null
        // A voided shipment is out of every working set — its order does not sit on a
        // tab. `voidedAt` is the R marker; a pre-R `deletedAt` is the same thing.
        if (isShipmentVoided(shipment)) return null
        const docsRequired = order.docsRequired ?? []
        const docsMissing = order.docsMissing ?? []
        const docsReady = docsMissing.length === 0
        const revenueCents = order.revenueCents ?? 0

        const reasons: string[] = []
        if (!docsReady) reasons.push(`Missing ${docsMissing.join(', ')}`)
        if (revenueCents <= 0) reasons.push('No customer charges')
        if (shipment?.status === 'CANCELED') reasons.push('Shipment canceled')
        else if (!shipment?.deliveredAt) reasons.push('Not delivered')

        return {
          order,
          shipment,
          orderId: order.id,
          shipmentId: order.shipmentId,
          shipmentNumber: shipment?.number ?? null,
          customerId: order.customerId,
          customerName: order.customerName ?? shipment?.customerName ?? '',
          billToId: order.billToId ?? null,
          deliveredAt: shipment?.deliveredAt ?? null,
          arStatusChangedAt: order.arStatusChangedAt ?? null,
          revenueCents,
          docsRequired,
          docsMissing,
          docsReady,
          invoiceNumber: order.invoiceNumber ?? null,
          invoicedAt: order.invoicedAt ?? null,
          arBalanceCents: order.arBalanceCents ?? null,
          reasons,
        }
      })
      .filter((row): row is ArWorklistRow => row !== null)

    return built.sort((a, b) => {
      const at = a.arStatusChangedAt ?? ''
      const bt = b.arStatusChangedAt ?? ''
      if (at !== bt) return at < bt ? -1 : 1
      return a.orderId.localeCompare(b.orderId)
    })
  }, [orders, shipments])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { rows, loading, error, refresh }
}
