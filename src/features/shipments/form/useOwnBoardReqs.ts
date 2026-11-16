/**
 * The REQS list (boardReqs.ts) for the shipment the editor has open, read from its own board row, so the rail's
 * What's missing matches the board's chip however the editor was opened. Re-reads the row whenever `bundle`
 * changes (a save hands the editor a new one), so fixed items drop off. Undefined until the row is in.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useShipments } from '@/hooks/useShipments'
import { boardReqsOf, type BoardReq, type BoardReqSources } from '../boardReqs'

export function useOwnBoardReqs(shipmentId: string | null | undefined, enabled: boolean, sources: BoardReqSources, bundle: unknown): BoardReq[] | undefined {
  const { shipments, refresh } = useShipments({ kind: 'ids', ids: enabled && shipmentId ? [shipmentId] : [] })
  const row = shipments.find((r) => r.id === shipmentId) ?? null
  const seen = useRef(bundle)
  useEffect(() => {
    if (seen.current === bundle) return
    seen.current = bundle
    if (enabled && shipmentId) void refresh()
  }, [bundle, enabled, shipmentId, refresh])
  const { customers, orgDefault } = sources
  return useMemo(() => (row ? boardReqsOf(row, { customers, orgDefault }) : undefined), [row, customers, orgDefault])
}
