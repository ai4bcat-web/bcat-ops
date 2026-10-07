/**
 * Whose loads a board shows.
 *
 * Two kinds of driver run here and they are planned and paid differently. Ivan's own
 * drivers are dispatched from the calendar — that is what it is for. Owner-operators
 * (the Amazon fleet) bring their own work and are settled from the owner-operator page.
 *
 * "Ivan driver" is not a stored flag. It is everyone who is not an owner-operator, and
 * two fields can say someone is: `fleetGroup: 'AMAZON'` and
 * `driverType: 'OWNER_OPERATOR'`. Either is enough — they are meant to agree, and when
 * they disagree the safer read is OWNER_OP, because a stray owner-operator load on the
 * dispatch board is less confusing than an Ivan load silently missing from it.
 *
 * Both pages that filter by this now open on EVERYBODY. The calendar used to open on
 * Ivan's drivers alone — reasoned from what dispatch does most — and that kept producing
 * "why isn't this load on the calendar?" from anyone who did not know a filter was on. A
 * board that hides freight by default is one people learn not to trust; narrowing it is a
 * single click on a group header, which is the cheap direction.
 *
 * Pure: no store, no clock. The one exception is the localStorage pair at the bottom,
 * which is guarded and falls back to "nothing chosen".
 */
import { getStops } from './stops'
import type { Driver, Load, Stop } from '../types'

export type DriverGroup = 'IVAN' | 'OWNER_OP' | 'BROKER'

export const DRIVER_GROUP_LABEL: Record<DriverGroup, string> = {
  IVAN: 'Ivan drivers',
  OWNER_OP: 'Owner operators',
  BROKER: 'Brokered',
}

/** Enough of a driver to classify and list one. */
export type FilterableDriver = Pick<
  Driver,
  'id' | 'name' | 'active' | 'type' | 'fleetGroup' | 'driverType' | 'colorKey'
>

export function driverGroupOf(driver: Pick<Driver, 'fleetGroup' | 'driverType' | 'type'>): DriverGroup {
  // BROKER COVERED / BROKER NEED TO COVER are pseudo-drivers, not people. They are still
  // the only thing carrying these loads, so they get a group rather than being discarded.
  if (driver.type === 'broker') return 'BROKER'
  if (driver.fleetGroup === 'AMAZON') return 'OWNER_OP'
  if (driver.driverType === 'OWNER_OPERATOR') return 'OWNER_OP'
  return 'IVAN'
}

/**
 * The drivers worth offering in the picker.
 *
 * Broker pseudo-drivers USED to be excluded here, on the reasoning that BROKER COVERED is
 * nobody and listing it would imply you could filter to "that person's" work. That was
 * wrong in the way that matters: a load assigned to one still carries its id, so it
 * matched no visible driver and vanished from the board entirely. 98 loads were invisible
 * — 95 covered, 3 still needing cover — including freight nobody had picked up yet, which
 * is the single thing a dispatcher most needs to see.
 *
 * They are their own group now. Inactive drivers are still dropped: a list with every
 * driver who ever worked here is a list nobody scrolls.
 */
export function selectableDrivers<T extends FilterableDriver>(drivers: T[]): T[] {
  return drivers
    .filter((d) => d.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Drivers in one group, already filtered and sorted. */
export function driversInGroup<T extends FilterableDriver>(drivers: T[], group: DriverGroup): T[] {
  return selectableDrivers(drivers).filter((d) => driverGroupOf(d) === group)
}

/**
 * The default selection: EVERY driver.
 *
 * It used to open on Ivan's drivers and the brokered loads, with owner-operators switched
 * off. That was reasoned from what dispatch does most, and it kept producing the same
 * support question — "why isn't PRO X on the calendar?" — from anyone who did not know a
 * filter was on. A board that hides freight by default is a board people learn not to
 * trust, and the one-click group toggles make narrowing it cheap for anyone who wants to.
 * So the calendar now opens showing everything, the same as the loads page.
 */
export function defaultVisibleDriverIds(drivers: FilterableDriver[]): string[] {
  return allSelectableDriverIds(drivers)
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
  const brokers = driversInGroup(drivers, 'BROKER')
  const ownerOps = driversInGroup(drivers, 'OWNER_OP')
  const allIvan = ivan.length > 0 && ivan.every((d) => visibleDriverIds.has(d.id))
  const allBrokers = brokers.every((d) => visibleDriverIds.has(d.id))
  const noOwnerOps = ownerOps.every((d) => !visibleDriverIds.has(d.id))
  // The dispatch-only view deserves its own words; a bare count would read as an odd
  // custom state to the person who chose it.
  if (allIvan && allBrokers && noOwnerOps && shown.length === ivan.length + brokers.length) {
    return 'Ivan + brokered'
  }

  if (shown.length === 1) return shown[0].name
  return `${shown.length} drivers`
}


/** Everyone the picker offers — the Loads page default, where omitting a fleet would lie. */
export function allSelectableDriverIds(drivers: FilterableDriver[]): string[] {
  return selectableDrivers(drivers).map((d) => d.id)
}

/*
 * Whose loads are shown is a working preference, not data: it lives in this browser so
 * someone who hid the owner-operators does not have to hide them again after a refresh.
 * Each page keeps its own key, because the calendar and the loads page are answering
 * different questions and a shared selection would surprise on both.
 *
 * Every access is guarded. A private window or blocked site data simply falls back to
 * null — "nothing chosen" — and the page applies its own default.
 */
export const DRIVER_FILTER_KEYS = {
  calendar: 'bcat.calendar.visibleDrivers',
  loads: 'bcat.loads.visibleDrivers',
} as const

export function readStoredDriverIds(key: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null
  } catch {
    return null
  }
}

export function writeStoredDriverIds(key: string, ids: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // Nothing to do: the filter still works for this session.
  }
}
