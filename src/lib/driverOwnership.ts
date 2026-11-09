/**
 * What kind of driver this is, derived ONE way for every consumer.
 *
 * `Driver.fleetGroup` is the source of truth (Files > Drivers shows it as Type; Ryne
 * maintains it). `Driver.driverType` is an older, coarser label that drifted: Chad is
 * COMPANY on a fleet of OWNER_OPERATOR, Michael has no driverType at all. So the fleet
 * decides, and driverType is read only when the fleet is empty (a driver nobody has
 * classified into a fleet yet, e.g. an old owner-operator record).
 *
 * AMAZON is the legacy name of the owner-operator fleet and means the same thing here.
 *
 * Pure and dependency-free: imported by the browser, the shipment/driver-app Lambdas and
 * the ownership resolver, so the rule cannot be copied and drift again.
 */
export type DriverOwnershipKind = 'OWNER_OPERATOR' | 'BOX_TRUCK' | 'LOCAL' | 'COMPANY'

export interface DriverOwnershipInputs {
  fleetGroup?: string | null
  driverType?: string | null
}

/** Null when the record states neither a fleet nor a driverType. */
export function driverOwnershipKind(driver: DriverOwnershipInputs): DriverOwnershipKind | null {
  switch (driver.fleetGroup) {
    case 'OWNER_OPERATOR':
    case 'AMAZON':
      return 'OWNER_OPERATOR'
    case 'BOX_TRUCK':
      return 'BOX_TRUCK'
    case 'LOCAL':
      return 'LOCAL'
  }
  if (driver.driverType === 'OWNER_OPERATOR') return 'OWNER_OPERATOR'
  if (driver.driverType === 'COMPANY') return 'COMPANY'
  return null
}

export const isOwnerOperator = (driver: DriverOwnershipInputs): boolean => driverOwnershipKind(driver) === 'OWNER_OPERATOR'

/**
 * The driverType the ownership rules see: what the fleet implies when there is one, else the stored value.
 * Keeps a rule keyed on driverType from outranking the fleet (a LOCAL driver with a stray OWNER_OPERATOR type).
 */
export function effectiveDriverType(driver: DriverOwnershipInputs): 'COMPANY' | 'OWNER_OPERATOR' | null {
  const kind = driverOwnershipKind(driver)
  if (kind === null) return null
  return kind === 'OWNER_OPERATOR' ? 'OWNER_OPERATOR' : 'COMPANY'
}
