import { describe, expect, it } from 'vitest'
import {
  buildOwnFleetRoster, isIvanCartageName, ownFleetDriverByName, ownFleetFill, ownFleetOptionLabel, resolveOwnFleetDriver,
} from './ownFleetDrivers'

const drivers = [
  { id: 'z', name: 'Zed Last', phone: '+13125550102', active: true, assignedTruckId: 't9', assignedTrailerId: 'r1' },
  { id: 'a', name: 'Amy First', phone: '+13125550101', active: true, assignedTruckId: 't1', assignedTrailerId: 'r1' },
  { id: 'b', name: 'BROKER COVERED', type: 'broker', active: true },
  { id: 'x', name: 'Gone', active: false, assignedTruckId: 't1' },
  { id: 'n', name: 'No Truck', phone: '3125550103', active: true },
]
const trucks = [{ id: 't1', unitNumber: '12', active: true }, { id: 't9', unitNumber: '99', active: false }]
const trailers = [{ id: 'r1', unitNumber: 'R-7', active: true }]
const truckConfig = (id: string) => (id === 't1' ? { truckId: 't1', unitNumber: '12', phone: '+13125550100' } : null)

describe('buildOwnFleetRoster', () => {
  const roster = buildOwnFleetRoster({ drivers, trucks, trailers, truckConfig })

  it('lists active, non-broker drivers by name', () => {
    expect(roster.map((d) => d.name)).toEqual(['Amy First', 'No Truck', 'Zed Last'])
  })

  it('prefers the truck work phone over the driver\'s own number (Step AK)', () => {
    const amy = roster.find((d) => d.id === 'a')!
    expect(amy).toMatchObject({ phone: '+13125550100', workPhone: '+13125550100', truckNumber: '12', trailerNumber: 'R-7' })
  })

  it('falls back to the driver\'s own number when the truck has no work phone or there is no truck', () => {
    expect(roster.find((d) => d.id === 'n')).toMatchObject({ phone: '+13125550103', workPhone: '', truckId: null, truckNumber: '' })
  })

  it('never fills a parked truck', () => {
    expect(roster.find((d) => d.id === 'z')).toMatchObject({ truckId: null, truckNumber: '', trailerNumber: 'R-7', phone: '+13125550102' })
  })

  it('labels with only the parts the record has, and fills the four driver-info fields', () => {
    expect(ownFleetOptionLabel(roster.find((d) => d.id === 'a')!)).toBe('Amy First · Truck 12 · Trailer R-7 · (312) 555-0100')
    expect(ownFleetOptionLabel({ ...roster[1], phone: '' })).toBe('No Truck')
    expect(ownFleetFill(roster.find((d) => d.id === 'a')!)).toEqual({
      driverId: 'a', driverName: 'Amy First', driverPhone: '+13125550100', truckId: 't1', truckNumber: '12', trailerId: 'r1', trailerNumber: 'R-7',
    })
  })

  it('finds a driver by stored name only when exactly one active driver has it', () => {
    expect(ownFleetDriverByName(roster, ' amy first ')?.id).toBe('a')
    expect(ownFleetDriverByName(roster, 'Gone')).toBeNull()
    expect(ownFleetDriverByName(roster, '')).toBeNull()
    expect(ownFleetDriverByName([roster[0], { ...roster[0], id: 'dup' }], 'Amy First')).toBeNull()
  })
})

describe('isIvanCartageName', () => {
  it('matches the own-fleet carrier however it is typed, and nothing else', () => {
    for (const name of ['Ivan Cartage', ' IVAN CARTAGE LLC', 'ivancartage']) expect(isIvanCartageName(name)).toBe(true)
    for (const name of ['Ivanhoe Trucking', 'Acme Cartage', '', null, undefined]) expect(isIvanCartageName(name)).toBe(false)
  })
})

describe('resolveOwnFleetDriver', () => {
  const units = (id: string) => ({ t1: '12', r1: 'R-7' } as Record<string, string>)[id] ?? null
  const amy = { id: 'a', name: 'Amy First', phone: '+13125550101', active: true, assignedTruckId: 't1', assignedTrailerId: 'r1' }

  it('fills phone, truck and trailer from the record when omitted', () => {
    expect(resolveOwnFleetDriver('a', amy, {}, units)).toEqual({
      driverId: 'a', driverName: 'Amy First', driverPhone: '+13125550101', truckId: 't1', truckNumber: '12', trailerId: 'r1', trailerNumber: 'R-7',
    })
  })

  it('keeps what the caller sent', () => {
    expect(resolveOwnFleetDriver('a', amy, { truckId: 't2', truckNumber: '77', driverPhone: '+13125550199' }, units))
      .toMatchObject({ truckId: 't2', truckNumber: '77', driverPhone: '+13125550199', trailerNumber: 'R-7' })
  })

  it('refuses a missing, inactive or broker driver with a sentence', () => {
    expect(() => resolveOwnFleetDriver('q', null, {}, units)).toThrow(/Driver not found/)
    expect(() => resolveOwnFleetDriver('a', { ...amy, active: false }, {}, units)).toThrow(/inactive/)
    expect(() => resolveOwnFleetDriver('a', { ...amy, type: 'broker' }, {}, units)).toThrow(/placeholder/)
  })
})
