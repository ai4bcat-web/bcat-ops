import { describe, it, expect } from 'vitest'
import {
  computeInsuranceAllocation, insuranceRangeByTruck, inclusiveDays,
  type InsItem, type TruckLite, type DriverLite,
} from './insuranceAllocation'

const trucks: TruckLite[] = [
  { id: 't1', active: true },
  { id: 't2', active: true },
  { id: 't3', active: false }, // inactive — excluded from live allocation
]
const drivers: DriverLite[] = [
  { id: 'd1', assignedTruckId: 't1', active: true },
  { id: 'd2', assignedTruckId: 't2', active: true },
]

describe('computeInsuranceAllocation', () => {
  it('attributes each truck its own premium', () => {
    const items: InsItem[] = [
      { kind: 'TRUCK', equipmentId: 't1', annualCents: 1_200_00 }, // $1,200
      { kind: 'TRUCK', equipmentId: 't2', annualCents: 2_400_00 }, // $2,400
    ]
    const a = computeInsuranceAllocation(items, trucks, drivers)
    expect(a.perTruckPremium.t1).toBe(1200)
    expect(a.perTruckPremium.t2).toBe(2400)
    expect(a.truckTotal).toBe(3600)
    expect(a.byTruck.t1).toBe(1200)
    expect(a.byTruck.t2).toBe(2400)
  })

  it('splits trailer insurance evenly across ACTIVE trucks only', () => {
    const items: InsItem[] = [
      { kind: 'TRAILER', equipmentId: 'r1', annualCents: 1_000_00 }, // $1,000 across 2 active trucks
    ]
    const a = computeInsuranceAllocation(items, trucks, drivers)
    expect(a.trailerSharePerTruck).toBe(500)
    expect(a.byTruck.t1).toBe(500)
    expect(a.byTruck.t2).toBe(500)
    expect(a.byTruck.t3).toBeUndefined() // inactive truck gets nothing
  })

  it('splits workmans comp per active driver onto their assigned truck', () => {
    const items: InsItem[] = [{ kind: 'WORKMANS_COMP', annualCents: 2_000_00 }] // $2,000 / 2 drivers = $1,000 each
    const a = computeInsuranceAllocation(items, trucks, drivers)
    expect(a.wcByTruck.t1).toBe(1000)
    expect(a.wcByTruck.t2).toBe(1000)
    expect(a.byTruck.t1).toBe(1000)
    expect(a.byTruck.t2).toBe(1000)
  })

  it('spreads WC for drivers without an active truck across active trucks (total preserved)', () => {
    const d: DriverLite[] = [
      { id: 'd1', assignedTruckId: 't1', active: true },
      { id: 'd2', assignedTruckId: null, active: true }, // no truck → their WC is spread
    ]
    const items: InsItem[] = [{ kind: 'WORKMANS_COMP', annualCents: 2_000_00 }] // $1,000/driver
    const a = computeInsuranceAllocation(items, trucks, d)
    // d1 → t1 gets $1,000; d2's $1,000 spread over 2 active trucks = $500 each
    expect(a.byTruck.t1).toBeCloseTo(1500)
    expect(a.byTruck.t2).toBeCloseTo(500)
    // Fleet total across trucks equals the WC total.
    expect(a.byTruck.t1 + a.byTruck.t2).toBeCloseTo(2000)
  })

  it('combines premium + trailer + WC and reports the fleet total', () => {
    const items: InsItem[] = [
      { kind: 'TRUCK', equipmentId: 't1', annualCents: 1_000_00 },
      { kind: 'TRUCK', equipmentId: 't2', annualCents: 1_000_00 },
      { kind: 'TRAILER', equipmentId: 'r1', annualCents: 1_000_00 },
      { kind: 'WORKMANS_COMP', annualCents: 2_000_00 },
    ]
    const a = computeInsuranceAllocation(items, trucks, drivers)
    expect(a.fleetAnnual).toBe(5000)
    // t1: 1000 premium + 500 trailer + 1000 wc = 2500; same for t2.
    expect(a.byTruck.t1).toBeCloseTo(2500)
    expect(a.byTruck.t2).toBeCloseTo(2500)
    // Everything is accounted for across trucks.
    expect(a.byTruck.t1 + a.byTruck.t2).toBeCloseTo(a.fleetAnnual)
  })
})

describe('box-truck drivers share the split (recouped via settlements)', () => {
  const withBox: DriverLite[] = [
    { id: 'd1', assignedTruckId: 't1', active: true },
    { id: 'd2', assignedTruckId: 't2', active: true },
    { id: 'b1', assignedTruckId: null, active: true, boxTruck: true },
    { id: 'b2', assignedTruckId: null, active: true, boxTruck: true },
  ]

  it('counts box trucks in the trailer denominator (real trucks get a smaller share)', () => {
    const items: InsItem[] = [{ kind: 'TRAILER', equipmentId: 'r1', annualCents: 1_000_00 }] // $1,000
    const a = computeInsuranceAllocation(items, trucks, withBox)
    expect(a.boxTruckCount).toBe(2)
    // 2 active trucks + 2 box trucks = 4 units → $250 each on the real trucks.
    expect(a.trailerSharePerTruck).toBe(250)
    expect(a.byTruck.t1).toBe(250)
    expect(a.byTruck.t2).toBe(250)
    // Box trucks' $500 is NOT added to any P&L truck (recouped from settlements).
    expect(a.byTruck.t1 + a.byTruck.t2).toBe(500)
  })

  it('counts box-truck drivers in the WC headcount and attributes their WC like any driver', () => {
    const items: InsItem[] = [{ kind: 'WORKMANS_COMP', annualCents: 2_000_00 }] // $2,000 / 4 drivers = $500 each
    const a = computeInsuranceAllocation(items, trucks, withBox)
    // Ivan drivers' $500 lands on their trucks; the two unassigned box drivers' $1,000
    // spreads over the 2 active trucks ($500 each) — nothing is dropped.
    expect(a.byTruck.t1).toBeCloseTo(1000)
    expect(a.byTruck.t2).toBeCloseTo(1000)
    expect(a.byTruck.t1 + a.byTruck.t2).toBeCloseTo(2000)
  })

  it('lands a box-truck driver WC share on their assigned truck', () => {
    const withAssignedBox: DriverLite[] = [
      { id: 'd1', assignedTruckId: 't1', active: true },
      { id: 'b1', assignedTruckId: 't2', active: true, boxTruck: true },
    ]
    const items: InsItem[] = [{ kind: 'WORKMANS_COMP', annualCents: 2_000_00 }] // $1,000/driver
    const a = computeInsuranceAllocation(items, trucks, withAssignedBox)
    expect(a.wcByTruck.t1).toBeCloseTo(1000)
    expect(a.wcByTruck.t2).toBeCloseTo(1000)
    expect(a.byTruck.t2).toBeCloseTo(1000)
  })
})

describe('insuranceRangeByTruck / inclusiveDays', () => {
  it('counts inclusive days', () => {
    expect(inclusiveDays('2026-01-01', '2026-01-31')).toBe(31)
    expect(inclusiveDays('2026-01-01', '2026-01-07')).toBe(7)
    expect(inclusiveDays('2026-01-01', '2026-01-01')).toBe(1)
  })
  it('prorates a full month to ~annual/12', () => {
    const r = insuranceRangeByTruck({ t1: 1200 }, { start: '2026-01-01', end: '2026-01-31' })
    // 1200 * 31/365 ≈ 101.9 (≈ 100/mo)
    expect(r.t1).toBeCloseTo(1200 * 31 / 365, 5)
  })
})
