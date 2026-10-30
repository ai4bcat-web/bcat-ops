import { useCallback, useEffect, useState } from 'react'
import { previewInvoice, readyToInvoice } from '@/lib/apiClient'
import type { ArWorklistRow } from '@/hooks/useArWorklist'
import type { ReleaseGateResult } from '@/lib/releaseGate'

export interface ReadyRow extends ArWorklistRow {
  gate?: ReleaseGateResult | null
}

export interface UseReadyForBillingResult {
  rows: ReadyRow[]
  loading: boolean
  releasingId: string | null
  refusal: { orderId: string; message: string } | null
  release: (row: ArWorklistRow, onDone: () => void) => Promise<void>
  clearRefusal: () => void
}

/**
 * P10 — the accounting view's data: every DOCS_NEEDED shipment that looks complete,
 * cross-checked with the same Step F gate the release path will run. The gate is
 * authoritative; this hook only reads it, never recomputes it.
 */
export function useReadyForBilling(rows: ArWorklistRow[]): UseReadyForBillingResult {
  // `null` means the gates for the current row set have not landed yet — that is
  // the loading flag, so no state is ever set synchronously to mark a refetch.
  const [gates, setGates] = useState<Record<string, ReleaseGateResult | null> | null>(null)
  const [releasingId, setReleasingId] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ orderId: string; message: string } | null>(null)

  const rowIds = rows.map((r) => r.orderId).sort().join(',')

  // A new row set invalidates the gates already read; reset during render so the
  // list never paints a gate that belongs to the previous set.
  const [prevRowIds, setPrevRowIds] = useState(rowIds)
  if (prevRowIds !== rowIds) {
    setPrevRowIds(rowIds)
    setGates(null)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all(
      rows.map(async (row) => {
        try {
          const p = await previewInvoice({ orderId: row.orderId })
          return { orderId: row.orderId, gate: p.releaseGate }
        } catch {
          return { orderId: row.orderId, gate: null }
        }
      }),
    ).then((results) => {
      if (cancelled) return
      const map: Record<string, ReleaseGateResult | null> = {}
      for (const r of results) map[r.orderId] = r.gate
      setGates(map)
    })
    return () => {
      cancelled = true
    }
  }, [rowIds])

  const release = useCallback(async (row: ArWorklistRow, onDone: () => void) => {
    setReleasingId(row.orderId)
    setRefusal(null)
    try {
      await readyToInvoice({ orderId: row.orderId, expectedUpdatedAt: row.order.updatedAt })
      onDone()
    } catch (err) {
      setRefusal({
        orderId: row.orderId,
        message: err instanceof Error ? err.message : 'Release failed',
      })
    } finally {
      setReleasingId(null)
    }
  }, [])

  const clearRefusal = useCallback(() => setRefusal(null), [])

  const rowsWithGate: ReadyRow[] = rows.map((r) => ({ ...r, gate: gates?.[r.orderId] }))

  return { rows: rowsWithGate, loading: gates === null && rows.length > 0, releasingId, refusal, release, clearRefusal }
}
