/**
 * The shipment facts the Payables rows need (PRO, PO, delivery), read by id for the bills on hand:
 * the shipments through `loadWorklistShipments` and their orders in one batched index read, never a
 * full board read. Re-read when the set of shipments changes, not on every poll of the bills.
 */
import { useEffect, useMemo, useState } from 'react'
import { listOrdersByShipmentIds } from '@/lib/apiClient'
import { loadWorklistShipments } from '@/lib/worklistShipments'
import { billFactsIndex, type BillShipmentFacts } from './apQueue'
import type { CarrierBillRecord } from '@/types/tms'

export function useBillFacts(bills: readonly CarrierBillRecord[]): { facts: Map<string, BillShipmentFacts>; loading: boolean } {
  const key = useMemo(() => [...new Set(bills.map((b) => b.shipmentId))].sort().join(','), [bills])
  const [state, setState] = useState<{ key: string; facts: Map<string, BillShipmentFacts> }>({ key: '', facts: new Map() })

  useEffect(() => {
    if (!key) return
    let alive = true
    const ids = key.split(',')
    Promise.all([loadWorklistShipments(ids), listOrdersByShipmentIds(ids)])
      .then(([shipments, orders]) => { if (alive) setState({ key, facts: billFactsIndex(shipments, orders) }) })
      .catch(() => { if (alive) setState((prev) => ({ ...prev, key })) })
    return () => { alive = false }
  }, [key])

  return { facts: state.facts, loading: key !== '' && state.key !== key }
}
