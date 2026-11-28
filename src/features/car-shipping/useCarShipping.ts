/**
 * The auto shipper details (payer, vehicle, Square state) of some shipments, by shipment id: one narrow read, re-read when `version`
 * changes. A shipment with no details is absent. `loaded` is false until the first answer, so a caller that must not treat an
 * auto shipper like any other shipment can wait for it.
 */
import { useEffect, useState } from 'react'
import { listCarShippingByShipmentIds } from '@/lib/apiClient'
import type { CarShippingData } from '@/lib/squareInvoicing'

export function useCarShipping(shipmentIds: readonly string[], version = 0): { byShipment: ReadonlyMap<string, CarShippingData>; loaded: boolean } {
  const key = shipmentIds.join('|')
  const [state, setState] = useState<{ key: string; version: number; map: ReadonlyMap<string, CarShippingData> } | null>(null)
  useEffect(() => {
    if (shipmentIds.length === 0) return undefined
    let live = true
    void listCarShippingByShipmentIds([...shipmentIds])
      .then((got) => {
        const map = new Map<string, CarShippingData>()
        for (const [id, data] of got) if (data) map.set(id, data)
        if (live) setState({ key, version, map })
      })
      .catch(() => { if (live) setState({ key, version, map: new Map() }) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
  if (shipmentIds.length === 0) return { byShipment: new Map(), loaded: true }
  return { byShipment: state?.map ?? new Map(), loaded: state != null && state.key === key }
}
