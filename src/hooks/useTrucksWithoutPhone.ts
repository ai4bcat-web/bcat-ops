/**
 * Step AK — the one definition of "trucks without a work phone", shared by Fleet's chip and the
 * Settings card so the two can never disagree. `loading` stays true until BOTH inputs are final
 * (the session's fleet read and the TruckConfig list); a count read earlier would be computed from
 * the persisted/seed fleet or a half-loaded phone list.
 */
import { useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { trucksWithoutPhone } from '@/lib/workPhone'
import { useTruckConfigs } from './useTruckConfigs'

export function useTrucksWithoutPhone() {
  const equipment = useAppStore((s) => s.equipment)
  const fleetLoaded = useAppStore((s) => s.fleetLoaded)
  const { byId, loading: configsLoading } = useTruckConfigs()
  const missing = useMemo(() => trucksWithoutPhone({ equipment, configs: byId }), [equipment, byId])
  const ids = useMemo(() => new Set(missing.map((t) => t.truckId)), [missing])
  return { missing, ids, byId, loading: !fleetLoaded || configsLoading }
}
