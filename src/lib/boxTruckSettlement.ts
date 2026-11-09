/**
 * Who is in the Box Truck settlement run. The pay setting decides, nothing else: an active BOX_TRUCK
 * DriverPaySetting whose driver exists and is not a broker/3PL. Equipment.fleetGroup (the truck's fleet) is
 * deliberately NOT an input, so moving a driver's truck between fleets never adds or drops him here.
 */
export interface BoxTruckSettlementSetting { driverId: string; payGroup?: string | null; active?: boolean | null }
export interface BoxTruckSettlementDriver { id: string; type?: string | null }

export function boxTruckSettlementMembers<S extends BoxTruckSettlementSetting, D extends BoxTruckSettlementDriver>(
  settings: readonly S[],
  drivers: readonly D[],
): Array<{ setting: S; driver: D }> {
  const driverById = new Map(drivers.map((d) => [d.id, d]))
  const out: Array<{ setting: S; driver: D }> = []
  for (const setting of settings) {
    if (setting.payGroup !== 'BOX_TRUCK' || setting.active === false) continue
    const driver = driverById.get(setting.driverId)
    if (!driver || driver.type === 'broker') continue
    out.push({ setting, driver })
  }
  return out
}
