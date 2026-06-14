import type { FleetGroup } from '@/types/equipment'

export const FLEET_GROUPS: FleetGroup[] = ['LOCAL', 'AMAZON']

export const FLEET_GROUP_LABELS: Record<FleetGroup, string> = {
  LOCAL:  'Local (Ivan)',
  AMAZON: 'Amazon',
}

/**
 * TEMPORARY BRIDGE — Motive-only trucks that belong to a fleet group but have NO
 * Equipment record yet, so they cannot carry `Equipment.fleetGroup` (the real source
 * of truth). Their per-day miles arrive from Motive keyed as `motive:<unitNumber>`.
 *
 * The profitability view includes these units (miles only; fuel/revenue blank) and
 * flags them as "not in truck details". The permanent fix is to create an Equipment
 * record for each with fleetGroup set — at which point it should be removed from here.
 *
 * Units 890 and 89510 are Local but lack Equipment records and fuel cards (June 2026).
 */
export const ORPHAN_UNITS_BY_GROUP: Record<FleetGroup, string[]> = {
  LOCAL:  ['890', '89510'],
  AMAZON: [],
}

/** The synthetic truckId the Motive mileage sync assigns to an un-matched unit. */
export function orphanTruckId(unitNumber: string): string {
  return `motive:${unitNumber}`
}
