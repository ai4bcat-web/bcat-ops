import { describe, it, expect } from 'vitest'

import {
  OWN_ASSET_MESSAGES as M,
  clearStopColors,
  closedPayWeek,
  distinctStopDrivers,
  driverProblem,
  evaluatePayLock,
  fillBlankStopDrivers,
  isOwnAssetLoad,
  ownAssetDriverGap,
} from './ownAssetDriver'

const ownLeg = (driverId: string | null) => ({ kind: 'OWN_ASSET', status: 'ACTIVE', driverId })

describe('isOwnAssetLoad', () => {
  it('counts an OWN_ASSET load with no leg (duplicate / old backfill leftovers)', () => {
    expect(isOwnAssetLoad({ assignmentType: 'OWN_ASSET' }, null)).toBe(true)
  })
  it('counts an ACTIVE own leg even when the load row says otherwise', () => {
    expect(isOwnAssetLoad({ assignmentType: 'NEED_TO_COVER' }, ownLeg('d'))).toBe(true)
  })
  it('exempts voided and canceled loads even though void keeps assignmentType', () => {
    expect(isOwnAssetLoad({ assignmentType: 'OWN_ASSET', voidedAt: '2026-10-01T00:00:00Z' }, ownLeg('d'))).toBe(false)
    expect(isOwnAssetLoad({ assignmentType: 'OWN_ASSET', status: 'CANCELED' }, null)).toBe(false)
  })
  it('does not count brokered or uncovered loads', () => {
    expect(isOwnAssetLoad({ assignmentType: 'CARRIER' }, { kind: 'CARRIER', status: 'ACTIVE' })).toBe(false)
    expect(isOwnAssetLoad({ assignmentType: 'NEED_TO_COVER' }, null)).toBe(false)
  })
})

describe('ownAssetDriverGap', () => {
  const load = { assignmentType: 'OWN_ASSET', deliveryDriverId: 'd1' }
  it('flags a blank leg driver per phase, with the phase sentence', () => {
    expect(ownAssetDriverGap({ load, activeLeg: ownLeg(null), phase: 'DISPATCH' }))
      .toEqual({ code: 'NO_DRIVER', message: M.needDriverDispatch })
    expect(ownAssetDriverGap({ load, activeLeg: null, phase: 'DELIVERED' }))
      .toEqual({ code: 'NO_DRIVER', message: M.needDriverDelivered })
  })
  it('flags a leg driver with nobody on the delivery stop', () => {
    expect(ownAssetDriverGap({ load: { assignmentType: 'OWN_ASSET' }, activeLeg: ownLeg('d1'), phase: 'DELIVERED' })?.code)
      .toBe('NO_DELIVERY_DRIVER')
  })
  it('passes a relay: leg driver differs from the delivery driver', () => {
    expect(ownAssetDriverGap({ load: { ...load, deliveryDriverId: 'd2' }, activeLeg: ownLeg('d1'), phase: 'DISPATCH' })).toBeNull()
  })
  it('the post-edit deliveryDriverId override wins over the stored mirror', () => {
    expect(ownAssetDriverGap({ load, activeLeg: ownLeg('d1'), phase: 'DELIVERED', deliveryDriverId: null })?.code)
      .toBe('NO_DELIVERY_DRIVER')
    expect(ownAssetDriverGap({ load: { assignmentType: 'OWN_ASSET' }, activeLeg: ownLeg('d1'), phase: 'DELIVERED', deliveryDriverId: 'd1' }))
      .toBeNull()
  })
  it('dispatch rejects an inactive driver while delivered accepts the same one', () => {
    const driver = { id: 'd1', name: 'Dee', active: false }
    expect(ownAssetDriverGap({ load, activeLeg: ownLeg('d1'), driver, phase: 'DISPATCH' }))
      .toEqual({ code: 'DRIVER_INACTIVE', message: M.driverInactiveDispatch('Dee') })
    expect(ownAssetDriverGap({ load, activeLeg: ownLeg('d1'), driver, phase: 'DELIVERED' })).toBeNull()
  })
  it('dispatch rejects a broker placeholder and a driver that was looked up and is gone', () => {
    expect(ownAssetDriverGap({ load, activeLeg: ownLeg('d1'), driver: { id: 'd1', name: 'Broker', type: 'Broker' }, phase: 'DISPATCH' })?.code)
      .toBe('DRIVER_BROKER')
    expect(ownAssetDriverGap({ load, activeLeg: ownLeg('d1'), driver: null, phase: 'DISPATCH' })?.code).toBe('DRIVER_UNKNOWN')
  })
  it('presence-only when the roster row was not looked up', () => {
    expect(ownAssetDriverGap({ load, activeLeg: ownLeg('d1'), phase: 'DISPATCH' })).toBeNull()
  })
  it('asks nothing of a brokered load', () => {
    expect(ownAssetDriverGap({ load: { assignmentType: 'CARRIER' }, activeLeg: { kind: 'CARRIER', status: 'ACTIVE' }, phase: 'DELIVERED' })).toBeNull()
  })
})

describe('driverProblem', () => {
  it('uses the exact messages; a missing active flag counts as active', () => {
    expect(driverProblem('x', null)).toBe('Driver not found: x')
    expect(driverProblem('x', { id: 'x', name: 'Bro', type: 'broker' }))
      .toBe("Bro is a placeholder for brokered freight, not one of Ivan Cartage's drivers")
    expect(driverProblem('x', { id: 'x', name: 'Ann', active: false })).toBe('Ann is inactive. Reactivate the driver or pick another one.')
    expect(driverProblem('x', { id: 'x', name: 'Ann' })).toBeNull()
  })
})

describe('stop helpers', () => {
  it('distinctStopDrivers ignores blanks and dedupes in order', () => {
    expect(distinctStopDrivers([{ driverId: 'a' }, { driverId: ' ' }, { driverId: null }, { driverId: 'b' }, { driverId: 'a' }])).toEqual(['a', 'b'])
    expect(distinctStopDrivers(null)).toEqual([])
  })
  it('fillBlankStopDrivers fills blanks and never overwrites an explicit driver or truck', () => {
    const out = fillBlankStopDrivers([{ driverId: null, truckId: null }, { driverId: 'b', truckId: 't2' }], 'a', 't1')
    expect(out).toEqual([{ driverId: 'a', truckId: 't1' }, { driverId: 'b', truckId: 't2' }])
  })
  it('clearStopColors drops every stop colour override', () => {
    expect(clearStopColors([{ colorKey: 'red' }, { colorKey: null }])).toEqual([{ colorKey: null }, { colorKey: null }])
  })
})

describe('closedPayWeek (today = Wed 2026-10-14, week starts Sun 2026-10-11)', () => {
  const today = '2026-10-14'
  it('Saturday before the current Sunday is closed; the Sunday itself is open', () => {
    expect(closedPayWeek('2026-10-10T23:00:00.000Z', today)).toBe('2026-10-10')
    expect(closedPayWeek('2026-10-11T00:00:00.000Z', today)).toBeNull()
  })
  it('future and blank delivery dates are open', () => {
    expect(closedPayWeek('2026-11-01T12:00:00Z', today)).toBeNull()
    expect(closedPayWeek(null, today)).toBeNull()
    expect(closedPayWeek('', today)).toBeNull()
  })
})

describe('evaluatePayLock', () => {
  const base = { todayUtc: '2026-10-14', oldDriverName: 'Old', newDriverName: 'New' }
  it('is open for a current-week load for anybody', () => {
    expect(evaluatePayLock({ ...base, deliveryAppt: '2026-10-13T12:00:00Z', isAdmin: false })).toEqual({ state: 'OPEN' })
  })
  it('refuses a non-admin on a closed week with the exact sentence', () => {
    expect(evaluatePayLock({ ...base, deliveryAppt: '2026-10-05T12:00:00Z', isAdmin: false })).toEqual({
      state: 'REFUSED', code: 'CLOSED_WEEK', message: M.payClosedWeek('2026-10-05', 'Old', 'New'),
    })
  })
  it('admin needs a 10+ character reason (trimmed); with one it is an audited override', () => {
    const args = { ...base, deliveryAppt: '2026-10-05T12:00:00Z', isAdmin: true }
    expect(evaluatePayLock({ ...args, reason: '  short  ' })).toMatchObject({ state: 'REFUSED', code: 'REASON_REQUIRED' })
    expect(evaluatePayLock({ ...args, reason: '  driver was wrong  ' }))
      .toEqual({ state: 'CLOSED_WEEK_OVERRIDE', deliveryDate: '2026-10-05', reason: 'driver was wrong' })
  })
  it('a box-truck settlement row refuses even an admin with a reason, and even in an open week', () => {
    const r = evaluatePayLock({
      ...base, deliveryAppt: '2026-10-13T12:00:00Z', isAdmin: true, reason: 'a perfectly good reason',
      boxTrip: { periodStart: '2026-10-07', driverName: 'Bo' },
    })
    expect(r).toEqual({ state: 'REFUSED', code: 'BOX_TRUCK_TRIP', message: M.payBoxTrip('Bo', '2026-10-07') })
  })
})
