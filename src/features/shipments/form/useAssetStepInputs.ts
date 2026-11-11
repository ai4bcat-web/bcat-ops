/**
 * What an ASSETS load's progress needs beyond the bundle: the assigned driver's type (local driver or owner operator, from the driver
 * directory) and, optionally, the shipment's check calls (they say who tapped each driver-app update). Other loads read nothing.
 */
import { useEffect, useMemo, useState } from 'react'
import { useDrivers } from '@/hooks/useDrivers'
import { listCheckCallsByLoad } from '@/lib/apiClient'
import { isAssetShipment } from '@/lib/assetSteps'
import type { LoadCheckCallRecord, ShipmentBundle } from '@/types/tms'
import type { DriverType } from '@/types'

export function assetDriverTypeOf(bundle: ShipmentBundle | null, drivers: ReadonlyArray<{ id: string; driverType?: DriverType | null }>): DriverType | null {
  const lc = bundle?.loadCarriers.find((c) => c.status === 'ACTIVE' && c.driverId)
  if (!lc?.driverId) return null
  return drivers.find((d) => d.id === lc.driverId)?.driverType ?? null
}

export function useAssetStepInputs(bundle: ShipmentBundle | null, withCheckCalls: boolean): { driverType: DriverType | null; checkCalls: LoadCheckCallRecord[] } {
  const { drivers } = useDrivers()
  const driverType = useMemo(() => assetDriverTypeOf(bundle, drivers), [bundle, drivers])
  const asset = isAssetShipment(bundle)
  const loadIds = useMemo(() => (asset && withCheckCalls ? (bundle?.loads ?? []).map((l) => l.id).join(',') : ''), [asset, withCheckCalls, bundle])
  const [calls, setCalls] = useState<{ ids: string; rows: LoadCheckCallRecord[] }>({ ids: '', rows: [] })
  useEffect(() => {
    if (!loadIds) return undefined
    let live = true
    Promise.all(loadIds.split(',').map((id) => listCheckCallsByLoad(id).catch(() => [] as LoadCheckCallRecord[])))
      .then((all) => { if (live) setCalls({ ids: loadIds, rows: all.flat() }) })
    return () => { live = false }
  }, [loadIds])
  return { driverType, checkCalls: calls.ids === loadIds ? calls.rows : [] }
}
