/**
 * One rung of the AP ladder, as a worklist the office can act on.
 *
 * Each tab is one sparse-index read — `listOpenApAssignments` — joined to the shipment it
 * belongs to, because an assignment alone cannot say which shipment number it is or when
 * it delivered. The shipments come from one `listShipments()` indexed by id rather than a
 * `getShipment` per row: the tabs are bounded working sets, but they are still dozens of
 * rows, and dozens of round trips to colour a list is the pattern this codebase keeps
 * paying for elsewhere.
 *
 * `reasons` here is the cheap, cached-field verdict — what the board can say without
 * opening five tables. The authoritative refusal list is the server's `billReadiness`,
 * which comes back from `previewBill` when somebody actually goes to record.
 *
 * Polled on the same 60 s clock as the rest of the TMS surface: LoadCarrier has no
 * subscriptions, and a bill recorded three desks away moves a row between tabs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listOpenApAssignments, listShipments } from '@/lib/apiClient'
import { isShipmentVoided } from '@/lib/shipmentVoid'
import type { LoadCarrierRecord, ShipmentRecord } from '@/types/tms'

const POLL_MS = 60_000

/** The three rungs that are worklists. PAID is read through CarrierBill, never here. */
export type ApWorklistTab = 'AWAITING_INVOICE' | 'IN_REVIEW' | 'TO_BE_PAID'

export interface ApWorklistRow {
  assignment: LoadCarrierRecord
  /** Null only while the shipment read has not landed; voided shipments are dropped. */
  shipment: ShipmentRecord | null
  loadCarrierId: string
  loadId: string
  shipmentId: string
  shipmentNumber: string | null
  carrierId: string | null
  carrierName: string
  /** `LoadCarrier.invoiceId` is the recorded bill; null until Record lands one. */
  billId: string | null
  deliveredAt: string | null
  apStatusChangedAt: string | null
  /** What this assignment's CARRIER charge lines come to, cached on the row. */
  costCents: number
  apBalanceCents: number | null
  docsMissing: string[]
  /** The carrier-scope paperwork cache is clean. Approval re-evaluates it live. */
  docsReady: boolean
  rateConSigned: boolean
  /** What the cached fields alone can say is standing in the way. */
  reasons: string[]
}

export interface ApWorklist {
  /** Oldest change first: the queue is worked in the order it aged. */
  rows: ApWorklistRow[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useApWorklist(tab: ApWorklistTab): ApWorklist {
  const [assignments, setAssignments] = useState<LoadCarrierRecord[]>([])
  const [shipments, setShipments] = useState<ShipmentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() => {
    return Promise.all([listOpenApAssignments(tab), listShipments()])
      .then(([assignmentRows, shipmentRows]) => {
        setAssignments(assignmentRows)
        setShipments(shipmentRows)
        setError(null)
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'AP worklist failed to load') })
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

    const built = assignments
      .map((assignment): ApWorklistRow | null => {
        const shipment = byId.get(assignment.shipmentId) ?? null
        // A voided shipment is out of every working set — its leg does not sit on a tab.
        // `voidedAt` is the R marker; a pre-R `deletedAt` is the same thing.
        if (isShipmentVoided(shipment)) return null
        const docsMissing = assignment.docsMissing ?? []
        const docsReady = docsMissing.length === 0
        const rateConSigned = assignment.rateConStatus === 'SIGNED'
        const costCents = assignment.costCents ?? 0

        const reasons: string[] = []
        if (!docsReady) reasons.push(`Missing ${docsMissing.join(', ')}`)
        if (costCents <= 0) reasons.push('No carrier charges')
        if (!rateConSigned) reasons.push('Rate con not signed')
        if (shipment?.status === 'CANCELED') reasons.push('Shipment canceled')
        else if (!shipment?.deliveredAt) reasons.push('Not delivered')

        return {
          assignment,
          shipment,
          loadCarrierId: assignment.id,
          loadId: assignment.loadId,
          shipmentId: assignment.shipmentId,
          shipmentNumber: shipment?.number ?? null,
          carrierId: assignment.carrierId ?? null,
          carrierName: assignment.carrierName ?? '',
          billId: assignment.invoiceId ?? null,
          deliveredAt: shipment?.deliveredAt ?? null,
          apStatusChangedAt: assignment.apStatusChangedAt ?? null,
          costCents,
          apBalanceCents: assignment.apBalanceCents ?? null,
          docsMissing,
          docsReady,
          rateConSigned,
          reasons,
        }
      })
      .filter((row): row is ApWorklistRow => row !== null)

    return built.sort((a, b) => {
      const at = a.apStatusChangedAt ?? ''
      const bt = b.apStatusChangedAt ?? ''
      if (at !== bt) return at < bt ? -1 : 1
      return a.loadCarrierId.localeCompare(b.loadCarrierId)
    })
  }, [assignments, shipments])

  const refresh = useCallback(async () => { setLoading(true); await load() }, [load])

  return { rows, loading, error, refresh }
}
