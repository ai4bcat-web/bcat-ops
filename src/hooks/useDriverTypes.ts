import { useCallback, useMemo } from 'react'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { driverTypeLabel, driverTypeOptions, driverTypeOptionsFor, fleetGroupLabel } from '@/lib/fleetGroups'
import type { DriverTypeOption } from '@/lib/fleetGroups'

/** Driver-type options and labels derived from the loaded ownership divisions (seed fallback until they load). */
export function useDriverTypes() {
  const { divisions } = useOwnershipDivisions()
  const options = useMemo(() => driverTypeOptions(divisions), [divisions])
  const optionsFor = useCallback((current: string | null | undefined): DriverTypeOption[] => driverTypeOptionsFor(current, divisions), [divisions])
  const driverTypeText = useCallback((value: string) => driverTypeLabel(value, divisions), [divisions])
  const fleetLabel = useCallback((group: string) => fleetGroupLabel(group, divisions), [divisions])
  return { options, optionsFor, driverTypeLabel: driverTypeText, fleetGroupLabel: fleetLabel }
}
