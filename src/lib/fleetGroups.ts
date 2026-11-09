import type { FleetGroup } from '@/types/equipment'
import { SEED_DIVISIONS } from '@/lib/ownership'

export const FLEET_GROUPS: FleetGroup[] = ['LOCAL', 'AMAZON', 'BOX_TRUCK']

/**
 * Driver types ARE the subsidiaries of Ivan Cartage (OwnershipDivision rows whose parent is
 * ASSETS): the stored `Driver.fleetGroup` equals the division id, and the label is the division
 * name, so renaming a division relabels Files, the type selects and the dashboards together.
 * Nothing here hard-codes a label; `SEED_DIVISIONS` is only the fallback before divisions load.
 */
export const DRIVER_TYPE_PARENT_ID = 'ASSETS'

/** The slice of an OwnershipDivision this module needs (record and seed rows both satisfy it). */
export interface DriverTypeDivision {
  id: string
  name: string
  parentId: string | null
  sortOrder: number
  active: boolean
}

export interface DriverTypeOption {
  /** The value stored in Driver.fleetGroup (the division id). */
  value: string
  /** The division name. */
  label: string
}

/**
 * Does a truck whose Equipment.fleetGroup is `truckFleet` belong to the `group` view? The Ivan LOCAL view
 * includes the BOX_TRUCK truck (unit 3890): the box truck rides inside the LOCAL P&L, PM list and fixed-cost
 * split — the same rule drivers already follow (a BOX_TRUCK driver counts as LOCAL). The BOX_TRUCK view is its own.
 */
export const truckInFleet = (truckFleet: string | null | undefined, group: FleetGroup): boolean =>
  truckFleet === group || (group === 'LOCAL' && truckFleet === 'BOX_TRUCK')

/** Legacy fleet value that means the owner-operator type (see driverOwnershipKind). */
const LEGACY_DRIVER_TYPE_ALIAS: Record<string, string> = { AMAZON: 'OWNER_OPERATOR' }

function driverTypeDivisions(divisions?: readonly DriverTypeDivision[] | null): DriverTypeDivision[] {
  const pick = (rows: readonly DriverTypeDivision[]) =>
    rows.filter((d) => d.parentId === DRIVER_TYPE_PARENT_ID && d.active).sort((a, b) => a.sortOrder - b.sortOrder)
  const loaded = divisions ? pick(divisions) : []
  return loaded.length > 0 ? loaded : pick(SEED_DIVISIONS)
}

/** The selectable driver types: the active subsidiaries of Ivan Cartage, in division order. */
export function driverTypeOptions(divisions?: readonly DriverTypeDivision[] | null): DriverTypeOption[] {
  return driverTypeDivisions(divisions).map((d) => ({ value: d.id, label: d.name }))
}

/**
 * The options for a select whose current value may not be a division (a legacy AMAZON driver, or
 * an id whose division was deactivated): that value is appended so the form never blanks it.
 */
export function driverTypeOptionsFor(current: string | null | undefined, divisions?: readonly DriverTypeDivision[] | null): DriverTypeOption[] {
  const options = driverTypeOptions(divisions)
  if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: driverTypeLabel(current, divisions) })
  return options
}

/** Display name for a stored driver fleetGroup. Legacy AMAZON reads as the owner-operator type; an unknown value is shown raw. */
export function driverTypeLabel(value: string, divisions?: readonly DriverTypeDivision[] | null): string {
  const id = LEGACY_DRIVER_TYPE_ALIAS[value] ?? value
  return driverTypeDivisions(divisions).find((d) => d.id === id)?.name ?? value
}

/**
 * Display name for a TRUCK's fleet group. LOCAL and BOX_TRUCK are divisions and follow their
 * names. AMAZON is a truck-only fleet (profitability, Amazon pay) with no division of its own,
 * so it keeps its name.
 */
export function fleetGroupLabel(group: string, divisions?: readonly DriverTypeDivision[] | null): string {
  return group === 'AMAZON' ? 'Amazon' : driverTypeLabel(group, divisions)
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
  LOCAL:     ['89510'],
  AMAZON:    [],
  BOX_TRUCK: [],
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
