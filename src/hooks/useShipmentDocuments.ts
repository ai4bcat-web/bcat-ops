/**
 * One shipment's documents, and what the required-document gate makes of them.
 *
 * The rows come off the `shipmentId` index newest first; the two gates are derived
 * here with `evaluateDocGate`, over the loads `gateLoadIds` picks — the same two pure
 * functions the Lambda runs before it lets an order go Ready to invoice, so the tab
 * and the server cannot disagree either about what is missing or about which loads
 * have to supply it. The caller passes the bundle it already holds (orders, loads,
 * assignments) plus the customer and the settings, because the required list is the
 * customer's when they have one and the org default otherwise.
 *
 * Polled on the same 60 s clock as the rest of the TMS surface: ShipmentDocument has
 * no subscriptions, and a carrier's upload lands without anything telling the page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listShipmentDocuments } from '@/lib/apiClient'
import { evaluateDocGate, gateLoadIds } from '@/lib/shipmentDocuments'
import type { CustomerRecord, DocGateResult, ShipmentBundle, ShipmentDocumentRecord, TmsSettings } from '@/types/tms'

const POLL_MS = 60_000

/** What the gate needs beyond the documents themselves. The page already has all of it. */
export interface ShipmentDocumentsContext {
  bundle?: Pick<ShipmentBundle, 'orders' | 'loads' | 'loadCarriers'> | null
  customer?: Pick<CustomerRecord, 'requiredDocsForInvoice'> | null
  settings?: Pick<TmsSettings, 'defaultRequiredDocs' | 'requiredCarrierUploadTypes'> | null
  enabled?: boolean
}

export interface ShipmentDocuments {
  /** Oldest first, the order `ShipmentBundle.documents` uses. */
  documents: ShipmentDocumentRecord[]
  /** The Ready-to-invoice gate, per order id. Empty until the bundle is passed in. */
  orderGates: Record<string, DocGateResult>
  /** The carrier-paperwork gate, per ACTIVE assignment id. */
  carrierGates: Record<string, DocGateResult>
  /** Carrier-portal uploads on this shipment still waiting on a person. */
  pendingCount: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useShipmentDocuments(
  shipmentId: string | null | undefined,
  ctx?: ShipmentDocumentsContext,
): ShipmentDocuments {
  const enabled = (ctx?.enabled ?? true) && !!shipmentId
  const bundle = ctx?.bundle ?? null
  const customer = ctx?.customer ?? null
  const settings = ctx?.settings ?? null
  const [documents, setDocuments] = useState<ShipmentDocumentRecord[]>([])
  // A disabled caller (a drawer with no shipment open) never fetches, so the hook
  // reports "not loading" from the start rather than writing state inside the effect.
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain — the
  // same shape `useOpenIncidents` uses.
  const load = useCallback(() => {
    if (!enabled || !shipmentId) return Promise.resolve()
    return listShipmentDocuments(shipmentId)
      .then((rows) => { setDocuments(rows); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Documents failed to load') })
      .finally(() => setLoading(false))
  }, [enabled, shipmentId])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    load()
    const t = setInterval(() => { if (alive) tick() }, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [enabled, load])

  const orderGates = useMemo(() => {
    const gates: Record<string, DocGateResult> = {}
    for (const order of bundle?.orders ?? []) {
      gates[order.id] = evaluateDocGate({
        order,
        // `gateLoadIds` is the shared rule: a load that names this order always
        // counts, and an unattributed load counts only on a single-order shipment.
        // Using it here keeps the strip and the Lambda's READY_TO_INVOICE check
        // from reaching different answers on a multi-order shipment.
        loadIds: gateLoadIds(bundle?.loads ?? [], bundle?.orders ?? [], order.id),
        loadCarriers: bundle?.loadCarriers ?? [],
        documents,
        customer,
        settings,
        scope: 'CUSTOMER',
      })
    }
    return gates
  }, [bundle, documents, customer, settings])

  const carrierGates = useMemo(() => {
    const gates: Record<string, DocGateResult> = {}
    for (const assignment of bundle?.loadCarriers ?? []) {
      if (assignment.status !== 'ACTIVE') continue
      gates[assignment.id] = evaluateDocGate({
        loadCarriers: bundle?.loadCarriers ?? [],
        documents,
        settings,
        scope: 'CARRIER',
        loadCarrierId: assignment.id,
      })
    }
    return gates
  }, [bundle, documents, settings])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return {
    documents,
    orderGates,
    carrierGates,
    pendingCount: documents.filter((d) => d.status === 'ACTIVE' && d.reviewStatus === 'PENDING').length,
    loading,
    error,
    refresh,
  }
}
