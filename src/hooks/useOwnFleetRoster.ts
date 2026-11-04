/**
 * Step AQ: the Ivan Cartage roster (active drivers with their resolved truck, trailer and work
 * phone) for every own-fleet driver picker. `source` lets a caller that already holds the lists
 * (AssignDriverDialog's props) feed them in; otherwise the app store is read.
 */
import { useMemo } from 'react'
import { useDrivers } from '@/hooks/useDrivers'
import { useTrucks } from '@/hooks/useTrucks'
import { useTruckConfigs } from '@/hooks/useTruckConfigs'
import { buildOwnFleetRoster, type OwnFleetDriverOption, type OwnFleetDriverSource, type OwnFleetUnit } from '@/lib/ownFleetDrivers'

export function useOwnFleetRoster(source?: {
  drivers?: readonly OwnFleetDriverSource[]
  trucks?: readonly OwnFleetUnit[]
  trailers?: readonly OwnFleetUnit[]
}): OwnFleetDriverOption[] {
  const { drivers } = useDrivers()
  const { equipment } = useTrucks()
  const { byId } = useTruckConfigs()
  return useMemo(
    () => buildOwnFleetRoster({
      drivers: source?.drivers ?? drivers,
      trucks: source?.trucks ?? equipment.filter((e) => e.type === 'truck'),
      trailers: source?.trailers ?? equipment.filter((e) => e.type === 'trailer'),
      truckConfig: (id) => byId.get(id),
    }),
    [source?.drivers, source?.trucks, source?.trailers, drivers, equipment, byId],
  )
}
