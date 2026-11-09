import { describe, expect, it } from 'vitest'
import { boxTruckSettlementMembers } from './boxTruckSettlement'
import { truckInFleet } from './fleetGroups'
import { driverProgramOf } from './driverProgram'
import { isOwnerOperatorGroup } from './ownerOperatorTrips'

// Zak Pace as stored: Driver.fleetGroup BOX_TRUCK, assigned truck 3890, DriverPaySetting.payGroup BOX_TRUCK.
const zak = { id: 'zak', type: 'driver', name: 'Zak Pace', fleetGroup: 'BOX_TRUCK', assignedTruckId: 'truck-3890' }
const zakPay = { driverId: 'zak', payGroup: 'BOX_TRUCK', active: true }

describe('Box Truck settlement membership (Zak keeps his settlements when his truck moves to the BOX_TRUCK fleet)', () => {
  it('Zak is in the run: the pay setting decides, and the truck fleet is not an input', () => {
    expect(boxTruckSettlementMembers([zakPay], [zak]).map((m) => m.driver.id)).toEqual(['zak'])
    // the same driver + setting give the same answer whatever fleet his truck carries (the helper never sees Equipment)
    expect(boxTruckSettlementMembers([zakPay], [{ ...zak, assignedTruckId: 'any-other-truck' }]).length).toBe(1)
  })

  it('he is still NOT in the owner-operator settlement and still on the Ivan paperwork app', () => {
    expect(isOwnerOperatorGroup(zakPay.payGroup)).toBe(false)
    expect(driverProgramOf({ fleetGroup: zak.fleetGroup, payGroup: zakPay.payGroup })).toBe('PAPERWORK')
  })

  it('still excludes inactive pay settings, other pay groups, brokers and settings with no driver', () => {
    const settings = [
      { driverId: 'zak', payGroup: 'BOX_TRUCK', active: false },
      { driverId: 'oo', payGroup: 'AMAZON', active: true },
      { driverId: 'b', payGroup: 'BOX_TRUCK', active: true },
      { driverId: 'ghost', payGroup: 'BOX_TRUCK', active: true },
    ]
    const drivers = [zak, { id: 'oo', type: 'driver' }, { id: 'b', type: 'broker' }]
    expect(boxTruckSettlementMembers(settings, drivers)).toEqual([])
  })
})

describe('truckInFleet: the box truck rides inside the LOCAL view', () => {
  it('LOCAL view takes LOCAL and BOX_TRUCK trucks; BOX_TRUCK view only box trucks; AMAZON only Amazon', () => {
    expect(truckInFleet('LOCAL', 'LOCAL')).toBe(true)
    expect(truckInFleet('BOX_TRUCK', 'LOCAL')).toBe(true)
    expect(truckInFleet('AMAZON', 'LOCAL')).toBe(false)
    expect(truckInFleet(null, 'LOCAL')).toBe(false)
    expect(truckInFleet('BOX_TRUCK', 'BOX_TRUCK')).toBe(true)
    expect(truckInFleet('LOCAL', 'BOX_TRUCK')).toBe(false)
    expect(truckInFleet('BOX_TRUCK', 'AMAZON')).toBe(false)
  })
})
