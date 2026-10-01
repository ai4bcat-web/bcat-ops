/**
 * Which drivers' loads the calendar shows.
 *
 * The board has two kinds of driver on it and they are planned differently. Ivan's own
 * drivers are dispatched from this calendar — that is what it is for. Owner-operators
 * (the Amazon fleet) bring their own work and are settled from the owner-operator page;
 * their loads on the calendar are noise most of the time and signal occasionally, so
 * they are hidden by default and can be switched on per driver.
 *
 * "Ivan driver" is not a stored flag. It is everyone who is not an owner-operator, and
 * two fields can say someone is: `fleetGroup: 'AMAZON'` and
 * `driverType: 'OWNER_OPERATOR'`. Either is enough — they are meant to agree, and when
 * they disagree the safer read is the one that hides the load, because a stray
 * owner-operator load on the dispatch board is less confusing than an Ivan load
 * silently missing from it.
 *
 * Pure: no store, no storage, no clock.
 */
import { getStops } from './stops'
import type { Driver, Load, Stop } from '../types'

export type DriverGroup = 'IVAN' | 'OWNER_OP'

export const DRIVER_GROUP_LABEL: Record<DriverGroup, string> = {
  IVAN: 'Ivan drivers',
  OWNER_OP: 'Owner operators',
}

/** Enough of a driver to classify and list one. */
export type FilterableDriver = Pick<
  Driver,
  'id' | 'name' | 'active' | 'type' | 'fleetGroup' | 'driverType' | 'colorKey'
>

export function driverGroupOf(driver: Pick<Driver, 'fleetGroup' | 'driverType'>): DriverGroup {
  if (driver.fleetGroup === 'AMAZON') return 'OWNER_OP'
  if (driver.driverType === 'OWNER_OPERATOR') return 'OWNER_OP'
  return 'IVAN'
}

/**
 * The drivers worth offering in the picker: real, active people.
 *
 * `type: 'broker'` entries are pseudo-drivers like BROKER COVERED that carry loads but
 * are nobody; listing them would imply you could filter to "that person's" work.
 * Inactive drivers are dropped too — a list with every driver who ever worked here is a
 * list nobody scrolls.
 */
export function selectableDrivers<T extends FilterableDriver>(drivers: T[]): T[] {
  return drivers
    .filter((d) => d.active !== false && d.type !== 'broker')
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Drivers in one group, already filtered and sorted. */
export function driversInGroup<T extends FilterableDriver>(drivers: T[], group: DriverGroup): T[] {
  return selectableDrivers(drivers).filter((d) => driverGroupOf(d) === group)
}

/** The default selection: Ivan's own drivers, because this is their dispatch board. */
export function defaultVisibleDriverIds(drivers: FilterableDriver[]): string[] {
  return driversInGroup(drivers, 'IVAN').map((d) => d.id)
}

/** Every driver id on a load, across its stops and the legacy mirrored fields. */
export function loadDriverIds(load: Load): string[] {
  const ids = new Set<string>()
  for (const stop of getStops(load) as Stop[]) {
    if (stop.driverId) ids.add(stop.driverId)
  }
  if (load.pickupDriverId) ids.add(load.pickupDriverId)
  if (load.deliveryDriverId) ids.add(load.deliveryDriverId)
  return [...ids]
}

/**
 * Is this load on the board?
 *
 * A load with nobody on it is ALWAYS shown. It has no driver to filter by, and an
 * unassigned load is the one most needing attention — making it vanish behind a driver
 * filter would hide exactly the work someone opened the calendar to find. There is a
 * separate Unassigned chip for people who want only those.
 *
 * A split load shows when either driver is visible: half of it is still work on the
 * board, and hiding it would lose the other half's appointment too.
 */
export function loadVisibleForDrivers(load: Load, visibleDriverIds: Set<string>): boolean {
  const ids = loadDriverIds(load)
  if (ids.length === 0) return true
  return ids.some((id) => visibleDriverIds.has(id))
}

/** How the toolbar button summarises the current selection. */
export function driverFilterSummary(
  drivers: FilterableDriver[],
  visibleDriverIds: Set<string>,
): string {
  const all = selectableDrivers(drivers)
  const shown = all.filter((d) => visibleDriverIds.has(d.id))
  if (shown.length === 0) return 'No drivers'
  if (shown.length === all.length) return 'All drivers'

  const ivan = driversInGroup(drivers, 'IVAN')
  const ownerOps = driversInGroup(drivers, 'OWNER_OP')
  const allIvan = ivan.length > 0 && ivan.every((d) => visibleDriverIds.has(d.id))
  const noOwnerOps = ownerOps.every((d) => !visibleDriverIds.has(d.id))
  // The default deserves its own words; a bare count would read as an odd custom state.
  if (allIvan && noOwnerOps && shown.length === ivan.length) return 'Ivan drivers'

  if (shown.length === 1) return shown[0].name
  return `${shown.length} drivers`
}
