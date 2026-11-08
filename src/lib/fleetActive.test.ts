import { describe, it, expect } from 'vitest'
import { activeUnits, driversHoldingTrailer, fleetCounts, inactiveChanges, unitsInTab } from './fleetActive'
import { computeInsuranceAllocation, insuranceRangeByTruckDated, type InsItem } from './insuranceAllocation'
import { trailerOnDriver } from '@/features/dispatch/driverWhereabouts'
import type { Driver, Load } from '@/types'

const unit = (id: string, type: 'truck' | 'trailer', active?: boolean) => ({ id, unitNumber: id, type, active })
const fleet = [unit('t1', 'truck', true), unit('t2', 'truck', false), unit('r1', 'trailer', true), unit('r2', 'trailer', false), unit('r3', 'trailer')]

describe('fleet active selector', () => {
  it('pickers and counts see active units only; a missing flag counts as active', () => {
    expect(activeUnits(fleet, 'trailer').map((e) => e.id)).toEqual(['r1', 'r3'])
    expect(fleetCounts(fleet)).toEqual({ total: 3, trucks: 1, trailers: 2, inactive: 2 })
  })

  it('the Inactive tab lists parked trucks and trailers; the other tabs never do', () => {
    expect(unitsInTab(fleet, 'inactive').map((e) => e.id)).toEqual(['t2', 'r2'])
    expect(unitsInTab(fleet, 'all').map((e) => e.id)).toEqual(['t1', 'r1', 'r3'])
    expect(unitsInTab(fleet, 'truck').map((e) => e.id)).toEqual(['t1'])
  })

  it('finds the drivers still holding a trailer', () => {
    const drivers = [{ id: 'a', assignedTrailerId: 'r1' }, { id: 'b', assignedTrailerId: null }, { id: 'c' }]
    expect(driversHoldingTrailer('r1', drivers).map((d) => d.id)).toEqual(['a'])
    expect(driversHoldingTrailer('r9', drivers)).toEqual([])
  })

  it('audits only real changes to the inactive fields', () => {
    const live = { active: true, inactiveSince: null }
    expect(inactiveChanges(live, { active: false, inactiveSince: '2026-10-20' })).toEqual({
      active: { from: true, to: false }, inactiveSince: { from: null, to: '2026-10-20' },
    })
    expect(inactiveChanges({ active: false, inactiveSince: '2026-10-20' }, { active: true, inactiveSince: null })).toEqual({
      active: { from: false, to: true }, inactiveSince: { from: '2026-10-20', to: null },
    })
    expect(inactiveChanges(live, { active: true })).toEqual({})
    expect(inactiveChanges(live, { active: true, inactiveSince: null })).toEqual({})
  })
})

describe('inactive trailers and insurance', () => {
  const trucks = [{ id: 't1', active: true }, { id: 't2', active: true }]
  const items: InsItem[] = [
    { kind: 'TRAILER', equipmentId: 'r1', annualCents: 1_000_00 },
    { kind: 'TRAILER', equipmentId: 'r2', annualCents: 3_000_00 },
  ]

  it('a parked trailer leaves the shared trailer total', () => {
    const all = computeInsuranceAllocation(items, trucks, [])
    expect(all.trailerTotal).toBe(4000)
    const parked = computeInsuranceAllocation(items, trucks, [], [{ id: 'r1', active: true }, { id: 'r2', active: false }])
    expect(parked.trailerTotal).toBe(1000)
    expect(parked.trailerSharePerTruck).toBe(500)
  })

  it('counts a trailer\'s days only up to its inactive date', () => {
    const one: InsItem[] = [{ kind: 'TRAILER', equipmentId: 'r1', annualCents: 365_00 }]
    const trailers = [{ id: 'r1', active: false, inactiveSince: '2026-10-20' }]
    const t = [{ id: 't1', active: true }]
    const sum = (range: { start: string; end: string }) =>
      Object.values(insuranceRangeByTruckDated(one, t, [], range, trailers)).reduce((s, v) => s + v, 0)
    // $365/yr = $1/day, all of it landing on the one running truck.
    expect(sum({ start: '2026-10-01', end: '2026-10-31' })).toBeCloseTo(19)
    expect(sum({ start: '2026-11-01', end: '2026-11-30' })).toBe(0)
    expect(sum({ start: '2026-09-01', end: '2026-09-30' })).toBeCloseTo(30)
  })
})

describe('inactive trailer on the fleet map line', () => {
  it('does not name an inactive trailer left on the driver\'s file', () => {
    const driver = { id: 'd1', assignedTrailerId: 'r1' } as Driver
    expect(trailerOnDriver(driver, [] as Load[], [{ id: 'r1', unitNumber: '501', active: true }])).toBe('501')
    expect(trailerOnDriver(driver, [] as Load[], [{ id: 'r1', unitNumber: '501', active: false }])).toBeNull()
  })
})
