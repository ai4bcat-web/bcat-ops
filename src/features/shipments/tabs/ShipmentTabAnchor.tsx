import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useShipmentTabs } from './shipmentTabsContext'

export function ShipmentTabAnchor() {
  const { id } = useParams()
  const api = useShipmentTabs()
  const open = api?.open
  useEffect(() => { if (id && open) open(id) }, [id, open])
  return null
}
