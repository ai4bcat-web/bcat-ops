import { useEffect, useState } from 'react'
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { getLoads } from '@/lib/apiClient'
import { normalizePro } from '@/lib/proNumber'
import { modelAvailable } from '@/lib/modelAvailability'

const SHIPMENTS = '/tms/shipments'

/** What a Load resolves to: its Shipment, else the board searched by PRO, else the board. */
function loadShipmentTarget(
  load: { shipmentId?: string | null; aljexId?: string | null } | null | undefined,
  search = '',
): string {
  const carried = new URLSearchParams(search)
  carried.delete('id')
  if (load?.shipmentId) {
    const qs = carried.toString()
    return `${SHIPMENTS}/${encodeURIComponent(load.shipmentId)}${qs ? `?${qs}` : ''}`
  }
  const pro = normalizePro(load?.aljexId)
  if (pro) carried.set('q', pro)
  const qs = carried.toString()
  return `${SHIPMENTS}${qs ? `?${qs}` : ''}`
}

/**
 * A bookmarked `/loads/:id` (or `/loads?id=`): the Load now lives on its Shipment. Reads the
 * Load, follows `shipmentId`; a Load not yet linked lands on the board searched by its PRO;
 * an unknown id lands on the board with a toast. Other query params ride along.
 */
function ResolveLoadRedirect() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const { search, hash } = useLocation()
  const loadId = params.id ?? searchParams.get('id')
  const [target, setTarget] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const settle = (to: string, message?: string) => {
      if (!live) return
      if (message) toast.error(message)
      setTarget(to)
    }
    const board = loadShipmentTarget(null, search)
    if (!loadId) {
      settle(board)
      return () => { live = false }
    }
    getLoads([loadId]).then(
      ([load]) => (load ? settle(loadShipmentTarget(load, search)) : settle(board, 'That load no longer exists.')),
      () => settle(board, 'Could not open that load; showing the shipments list.'),
    )
    return () => { live = false }
  }, [loadId, search])

  if (!target) return null
  const [path, query] = target.split('?')
  return <Navigate to={{ pathname: path, search: query ? `?${query}` : '', hash }} replace />
}

/** Production's `/loads` page was the loads grid; before the shipment tables exist the Calendar is where its loads live. */
const PRE_SHIPMENT_LANDING = '/calendar'

export function LoadRedirect() {
  if (!modelAvailable('Shipment')) return <Navigate to={PRE_SHIPMENT_LANDING} replace />
  return <ResolveLoadRedirect />
}
