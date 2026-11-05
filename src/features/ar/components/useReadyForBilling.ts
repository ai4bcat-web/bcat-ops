import { useEffect, useRef, useState } from 'react'
import { previewInvoice } from '@/lib/apiClient'
import type { ArWorklistRow } from '@/hooks/useArWorklist'
import type { ReleaseGateResult } from '@/lib/releaseGate'

export interface ReadyRow extends ArWorklistRow {
  gate?: ReleaseGateResult | null
}

export interface UseReadyForBillingResult {
  rows: ReadyRow[]
  loading: boolean
}

/**
 * The accounting view's data: every DOCS_NEEDED shipment that looks complete,
 * cross-checked with the same Step F gate the release path will run. The gate is
 * authoritative; this hook only reads it, never recomputes it. It releases nothing:
 * release to billing happens in Load Review alone.
 *
 * One PREVIEW_INVOICE per row, so the gates are read only while `enabled` (the tab is open) and
 * once per row set: a page that merely shows the tab's count does not pay a request per order.
 */
export function useReadyForBilling(rows: ArWorklistRow[], enabled = true): UseReadyForBillingResult {
  // `null` means the gates for the current row set have not landed yet — that is
  // the loading flag, so no state is ever set synchronously to mark a refetch.
  const [gates, setGates] = useState<Record<string, ReleaseGateResult | null> | null>(null)

  const rowIds = rows.map((r) => r.orderId).sort().join(',')

  // A new row set invalidates the gates already read; reset during render so the
  // list never paints a gate that belongs to the previous set.
  const [prevRowIds, setPrevRowIds] = useState(rowIds)
  if (prevRowIds !== rowIds) {
    setPrevRowIds(rowIds)
    setGates(null)
  }

  const readFor = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || readFor.current === rowIds) return
    let cancelled = false
    let settled = false
    readFor.current = rowIds
    Promise.all(
      rowIds.split(',').filter(Boolean).map(async (orderId) => {
        try {
          const p = await previewInvoice({ orderId })
          return { orderId, gate: p.releaseGate }
        } catch {
          return { orderId, gate: null }
        }
      }),
    ).then((results) => {
      if (cancelled) return
      settled = true
      const map: Record<string, ReleaseGateResult | null> = {}
      for (const r of results) map[r.orderId] = r.gate
      setGates(map)
    })
    return () => {
      cancelled = true
      if (readFor.current === rowIds && !settled) readFor.current = null
    }
  }, [rowIds, enabled])

  const rowsWithGate: ReadyRow[] = rows.map((r) => ({ ...r, gate: gates?.[r.orderId] }))

  return { rows: rowsWithGate, loading: enabled && gates === null && rows.length > 0 }
}
