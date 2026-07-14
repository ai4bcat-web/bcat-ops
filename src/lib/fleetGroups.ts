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
 * Their Motive mileage arrives keyed `motive:<unitNumber>`, so the unit number here must
 * exactly match Motive's vehicle number (leading zeros included).
 *
 * Only list units that have NO Equipment record. Once a unit gets an Equipment record,
 * its `fleetGroup` is the source of truth — remove it from here (e.g. 0012 was moved to
 * the Amazon fleet via its Equipment record, so it's no longer bridged as a Local orphan).
 */
export const ORPHAN_UNITS_BY_GROUP: Record<FleetGroup, string[]> = {
  LOCAL:  ['89510'],
  AMAZON: [],
}

/**
 * Some trucks report to Motive/BIT under more than one vehicle number (e.g. a legacy
 * profile that was never removed). Map each alias number → the canonical fleet unit so
 * the truck collapses to ONE row everywhere (locations, mileage, rev/fuel per mile).
 * `890` is the same physical truck as `3890`.
 */
export const UNIT_ALIASES: Record<string, string> = { '890': '3890' }

/** Canonical fleet unit number for a (possibly aliased) unit number. */
export function canonicalUnit(unit: string): string {
  return UNIT_ALIASES[unit] ?? unit
}

/** Alias unit numbers that map TO the given canonical unit (reverse of UNIT_ALIASES). */
export function aliasUnitsFor(canonical: string): string[] {
  return Object.entries(UNIT_ALIASES).filter(([, c]) => c === canonical).map(([a]) => a)
}

/** The synthetic truckId the Motive mileage sync assigns to an un-matched unit. */
export function orphanTruckId(unitNumber: string): string {
  return `motive:${unitNumber}`
}

/**
 * Sentinel driverId for a single combined driver-pay entry covering ALL of a fleet's
 * drivers (rather than one DriverPayPeriod per driver). The profitability engine adds
 * it straight to the fleet's driver cost instead of attributing it to a truck.
 */
const COMBINED_PAY_PREFIX = 'fleet-combined:'
export const combinedPayDriverId = (group: FleetGroup): string => `${COMBINED_PAY_PREFIX}${group}`
export const isCombinedPayDriverId = (driverId: string): boolean => driverId.startsWith(COMBINED_PAY_PREFIX)
