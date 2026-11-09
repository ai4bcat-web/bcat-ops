import { describe, expect, it } from 'vitest'
import { driversOnLoad, isRateconOwnerOperator, newlyAssigned, type LoadImage } from './handler'

const OO = new Set(['lee', 'roy'])
const isOO = (id: string) => OO.has(id)

describe('driversOnLoad', () => {
  it('reads the legacy fields and every stop, with stops stored as JSON text', () => {
    const load: LoadImage = { pickupDriverId: 'a', deliveryDriverId: 'b', stops: JSON.stringify([{ driverId: 'c' }, { driverId: null }, {}]) }
    expect([...driversOnLoad(load)].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('newlyAssigned', () => {
  it('texts an owner operator on a new load built from a rate con', () => {
    expect(newlyAssigned({ id: '1', deliveryDriverId: 'lee', rateConfirmKey: 'rc.pdf' }, undefined, isOO)).toEqual(['lee'])
  })

  it('texts nobody until the load has a rate con', () => {
    expect(newlyAssigned({ id: '1', deliveryDriverId: 'lee' }, undefined, isOO)).toEqual([])
  })

  it('texts when the rate con is uploaded after the driver was assigned', () => {
    expect(newlyAssigned({ id: '1', deliveryDriverId: 'lee', rateConfirmKey: 'rc.pdf' }, { id: '1', deliveryDriverId: 'lee' }, isOO)).toEqual(['lee'])
  })

  it('texts the new driver when a load with a rate con is reassigned', () => {
    expect(newlyAssigned({ id: '1', deliveryDriverId: 'roy', rateConfirmKey: 'rc.pdf' }, { id: '1', deliveryDriverId: 'lee', rateConfirmKey: 'rc.pdf' }, isOO)).toEqual(['roy'])
  })

  it('does not text again on later edits or a replaced rate con', () => {
    expect(newlyAssigned({ id: '1', deliveryDriverId: 'lee', rateConfirmKey: 'rc2.pdf' }, { id: '1', deliveryDriverId: 'lee', rateConfirmKey: 'rc.pdf' }, isOO)).toEqual([])
  })

  it('does not text a driver already stamped on the load', () => {
    expect(newlyAssigned({ id: '1', deliveryDriverId: 'lee', rateConfirmKey: 'rc.pdf', rateconTextedTo: ['lee'] }, { id: '1' }, isOO)).toEqual([])
  })

  it('ignores company drivers', () => {
    expect(newlyAssigned({ id: '1', deliveryDriverId: 'company', rateConfirmKey: 'rc.pdf' }, undefined, isOO)).toEqual([])
  })

  it('texts an owner operator added on a stop', () => {
    const stops = JSON.stringify([{ driverId: 'company' }, { driverId: 'roy' }])
    expect(newlyAssigned({ id: '1', stops, rateConfirmKey: 'rc.pdf' }, { id: '1', stops: JSON.stringify([{ driverId: 'company' }]), rateConfirmKey: 'rc.pdf' }, isOO)).toEqual(['roy'])
  })
})

describe('isRateconOwnerOperator: the fleet group decides, as on the profile Type column', () => {
  it.each([
    ['Chad: fleet OWNER_OPERATOR, driverType COMPANY', { fleetGroup: 'OWNER_OPERATOR', driverType: 'COMPANY' }, false, true],
    ['Michael: fleet OWNER_OPERATOR, no driverType', { fleetGroup: 'OWNER_OPERATOR', driverType: null }, false, true],
    ['legacy AMAZON fleet', { fleetGroup: 'AMAZON' }, false, true],
    ['Ivan local with a stray OWNER_OPERATOR type', { fleetGroup: 'LOCAL', driverType: 'OWNER_OPERATOR' }, false, false],
    ['Ivan local even when settled as an owner operator', { fleetGroup: 'LOCAL' }, true, false],
    ['box truck', { fleetGroup: 'BOX_TRUCK' }, false, false],
    ['no fleet, driverType OWNER_OPERATOR', { driverType: 'OWNER_OPERATOR' }, false, true],
    ['no fleet, settled as an owner operator', {}, true, true],
    ['no fleet, nothing else', {}, false, false],
  ])('%s', (_name, driver, settled, texted) => {
    expect(isRateconOwnerOperator(driver, settled)).toBe(texted)
  })
})
