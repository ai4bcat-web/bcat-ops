/**
 * What a driver pulls: dry van, flatbed or power only.
 *
 * Ivan's local drivers are all dry van, so nobody has to say so; box trucks are their own
 * thing. Owner operators are set per driver (toggled from Dispatch or the driver file)
 * and show as "set unit type" until someone does.
 */
import type { Driver, UnitType } from '@/types'

export const UNIT_TYPES: UnitType[] = ['DRY_VAN', 'FLATBED', 'POWER_ONLY']

export const UNIT_TYPE_LABEL: Record<UnitType, string> = {
  DRY_VAN: 'Dry van',
  FLATBED: 'Flatbed',
  POWER_ONLY: 'Power only',
}

export type UnitKind = UnitType | 'BOX_TRUCK' | null

export function unitTypeOf(driver: Pick<Driver, 'unitType' | 'fleetGroup'> | null | undefined): UnitKind {
  if (!driver) return null
  if (driver.unitType) return driver.unitType
  if (driver.fleetGroup === 'BOX_TRUCK') return 'BOX_TRUCK'
  if (driver.fleetGroup === 'LOCAL') return 'DRY_VAN'
  return null
}

export function unitKindLabel(kind: UnitKind): string {
  if (!kind) return 'Set unit type'
  if (kind === 'BOX_TRUCK') return 'Box truck'
  return UNIT_TYPE_LABEL[kind]
}

/** Can this driver's unit type be toggled? Everyone outside Ivan local and box trucks. */
export function unitTypeEditable(driver: Pick<Driver, 'fleetGroup'> | null | undefined): boolean {
  if (!driver) return false
  return driver.fleetGroup !== 'LOCAL' && driver.fleetGroup !== 'BOX_TRUCK'
}

/** The next type in the cycle, for a one-tap toggle. */
export function nextUnitType(current: UnitType | null | undefined): UnitType {
  const i = current ? UNIT_TYPES.indexOf(current) : -1
  return UNIT_TYPES[(i + 1) % UNIT_TYPES.length]
}
