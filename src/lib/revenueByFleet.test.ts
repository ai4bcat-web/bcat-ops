/**
 * The breakdown has to reconcile to the headline and has to agree with the rest of the app
 * about whose load is whose. Those are the two ways a split like this goes quietly wrong.
 */
import { describe, it, expect } from 'vitest'
import { revenueByFleet, fleetBucketOf, loadFleetBucket, type FleetDriver } from './revenueByFleet'
import { driverGroupOf } from './driverFilter'
import type { Driver, Load } from '../types'

const drv = (id: string, over: Partial<Driver> = {}): FleetDriver =>
  ({ id, type: 'driver', ...over }) as FleetDriver

const IVAN = drv('ivan', { fleetGroup: 'LOCAL' })
const AMZ = drv('amz', { fleetGroup: 'AMAZON' })
const OO = drv('oo', { driverType: 'OWNER_OPERATOR' })
const BOX = drv('box', { fleetGroup: 'BOX_TRUCK' })
const BROKER = drv('bk', { type: 'broker' })
const DRIVERS = [IVAN, AMZ, OO, BOX, BROKER]

const load = (rate: number | null, pickup: string | null, delivery: string | null = null) =>
  ({ rate, pickupDriverId: pickup, deliveryDriverId: delivery }) as Load

const bucket = (s: ReturnType<typeof revenueByFleet>, id: string) =>
  s.byBucket.find((b) => b.bucket === id)!

describe('fleetBucketOf', () => {
  it('places each fleet', () => {
    expect(fleetBucketOf(IVAN)).toBe('IVAN')
    expect(fleetBucketOf(AMZ)).toBe('OWNER_OP')
    expect(fleetBucketOf(OO)).toBe('OWNER_OP')
    expect(fleetBucketOf(BOX)).toBe('BOX_TRUCK')
    expect(fleetBucketOf(BROKER)).toBe('BROKER')
    expect(fleetBucketOf(undefined)).toBe('UNASSIGNED')
  })

  it('keeps box trucks out of both neighbours — they are the question being asked', () => {
    expect(fleetBucketOf(drv('x', { fleetGroup: 'BOX_TRUCK', driverType: 'OWNER_OPERATOR' })))
      .toBe('BOX_TRUCK')
  })

  it('reads AMAZON + COMPANY as an owner operator, same as the driver filter does', () => {
    // One driver on file says both at once. The two rules must not disagree.
    const both = drv('both', { fleetGroup: 'AMAZON', driverType: 'COMPANY' })
    expect(fleetBucketOf(both)).toBe('OWNER_OP')
    expect(driverGroupOf(both as Driver)).toBe('OWNER_OP')
  })

  it('agrees with driverGroupOf on every ordinary driver', () => {
    for (const d of [IVAN, AMZ, OO]) {
      const mine = fleetBucketOf(d) === 'OWNER_OP' ? 'OWNER_OP' : 'IVAN'
      expect(mine).toBe(driverGroupOf(d as Driver))
    }
  })
})

describe('loadFleetBucket — attribution', () => {
  const byId = new Map(DRIVERS.map((d) => [d.id, d]))

  it('attributes to the pickup driver', () => {
    expect(loadFleetBucket(load(100, 'ivan', 'amz'), byId)).toBe('IVAN')
  })

  it('falls back to the delivery driver when nobody picked it up', () => {
    expect(loadFleetBucket(load(100, null, 'box'), byId)).toBe('BOX_TRUCK')
  })

  it('is UNASSIGNED with nobody on it at all', () => {
    expect(loadFleetBucket(load(100, null, null), byId)).toBe('UNASSIGNED')
  })

  it('is UNASSIGNED when the driver id does not resolve', () => {
    expect(loadFleetBucket(load(100, 'deleted'), byId)).toBe('UNASSIGNED')
  })
})

describe('revenueByFleet', () => {
  it('splits revenue three ways and counts the loads', () => {
    const s = revenueByFleet([
      load(100000, 'ivan'), load(50000, 'ivan'),
      load(200000, 'amz'), load(25000, 'oo'),
      load(75000, 'box'),
    ], DRIVERS)

    expect(bucket(s, 'IVAN')).toMatchObject({ revenue: 150000, loads: 2 })
    expect(bucket(s, 'OWNER_OP')).toMatchObject({ revenue: 225000, loads: 2 })
    expect(bucket(s, 'BOX_TRUCK')).toMatchObject({ revenue: 75000, loads: 1 })
  })

  it('RECONCILES — the parts add up to the total, with nothing dropped', () => {
    // A breakdown that silently omits a category is one somebody tries to subtract from
    // and cannot. Broker and driverless loads get buckets rather than disappearing.
    const s = revenueByFleet([
      load(100000, 'ivan'), load(200000, 'amz'), load(75000, 'box'),
      load(30000, 'bk'), load(40000, null),
    ], DRIVERS)
    const sum = s.byBucket.reduce((n, b) => n + b.revenue, 0)
    expect(sum).toBe(s.total)
    expect(s.total).toBe(445000)
  })

  it('counts rateless loads separately instead of as zero revenue', () => {
    const s = revenueByFleet([load(100000, 'ivan'), load(null, 'ivan'), load(0, 'amz')], DRIVERS)
    expect(s.unrated).toBe(2)
    expect(s.total).toBe(100000)
    expect(bucket(s, 'IVAN').loads).toBe(1)
  })

  it('keeps empty buckets so the list does not reorder itself week to week', () => {
    const s = revenueByFleet([load(100000, 'ivan')], DRIVERS)
    expect(s.byBucket).toHaveLength(5)
    expect(bucket(s, 'BOX_TRUCK')).toMatchObject({ revenue: 0, loads: 0 })
  })

  it('lists the three fleets that were asked for first', () => {
    const s = revenueByFleet([], DRIVERS)
    expect(s.byBucket.slice(0, 3).map((b) => b.bucket)).toEqual(['OWNER_OP', 'IVAN', 'BOX_TRUCK'])
  })

  it('returns zeroes rather than NaN for an empty month', () => {
    const s = revenueByFleet([], [])
    expect(s.total).toBe(0)
    expect(s.unrated).toBe(0)
  })
})
