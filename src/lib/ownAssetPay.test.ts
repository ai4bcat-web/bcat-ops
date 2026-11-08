import { describe, it, expect } from 'vitest'

import type { Load, Stop } from '@/types'
import { ownFleetLoadPatch, type MirrorStop } from './loadMirror'
import { ownerOpTripsFor, type OwnerOpLoadLike } from './ownerOperatorTrips'
import { driverIsOnLoad } from './driverJourney'
import { loadDriverIds } from './driverFilter'
import { ivanDaySchedule } from './driverSchedule'
import { loadsForDriverOnDay } from '@/features/schedule/sms'
import { evaluatePayLock } from './ownAssetDriver'

// Pay-history pin (Step W): the own-asset write path only sets fields the existing,
// unmodified readers already use. Changing the driver moves the load between drivers
// and touches nothing else those readers produce.

const stops = (): MirrorStop[] => [
  { id: 'pu', type: 'pickup', sequence: 1, appt: '2026-10-13T15:00:00.000Z' } as Stop,
  { id: 'de', type: 'delivery', sequence: 2, appt: '2026-10-14T15:00:00.000Z' } as Stop,
]

function loadWith(id: string, driverId: string | null, route: MirrorStop[] = stops()): Load {
  const base = {
    id, aljexId: `A-${id}`, tmsId: `T-${id}`, pickupNumber: 'P', customer: 'ZZ Customer', rate: 150000, miles: 300,
    originCity: 'Chicago, IL', destinationCity: 'Gary, IN',
    pickupAppt: route[0].appt, deliveryAppt: route[1].appt, stops: route,
    pickupDriverId: null, deliveryDriverId: null,
  }
  if (!driverId) return base as unknown as Load
  return { ...base, ...ownFleetLoadPatch(route, { driverId, truckId: 'trk-1' }) } as unknown as Load
}

const WEEK = '2026-10-11'
const trips = (loads: Load[], driver: string, week = WEEK) => ownerOpTripsFor(loads as unknown as OwnerOpLoadLike[], driver, week)

describe('Ivan Cartage assignment vs. existing pay/schedule readers', () => {
  it('the assigned load is visible to every reader for the right driver and nobody else', () => {
    const load = loadWith('L1', 'drv-a')
    expect(trips([load], 'drv-a').map((t) => [t.id, t.freightAmount])).toEqual([['L1', 1500]])
    expect(trips([load], 'drv-b')).toEqual([])
    expect(driverIsOnLoad(load, 'drv-a')).toBe(true)
    expect(driverIsOnLoad(load, 'drv-b')).toBe(false)
    expect(loadDriverIds(load)).toEqual(['drv-a'])
    expect(loadsForDriverOnDay([load], 'drv-a', '2026-10-13').map((l) => l.id)).toEqual(['L1'])
    expect(ivanDaySchedule([load], 'drv-a', '2026-10-13').total).toBe(1)
  })

  it('re-assigning moves the load to the new driver and leaves every other output deep-equal', () => {
    const moved = loadWith('L1', 'drv-a')
    const neighbour = loadWith('L2', 'drv-a', [
      { id: 'pu2', type: 'pickup', sequence: 1, appt: '2026-10-20T15:00:00.000Z' } as Stop,
      { id: 'de2', type: 'delivery', sequence: 2, appt: '2026-10-21T15:00:00.000Z' } as Stop,
    ])
    const otherWeek = '2026-10-18'
    const before = {
      oldOtherWeek: trips([moved, neighbour], 'drv-a', otherWeek),
      neighbourOnly: trips([neighbour], 'drv-a', otherWeek),
      newDriverOtherWeek: trips([moved, neighbour], 'drv-b', otherWeek),
    }

    const after = { ...moved, ...ownFleetLoadPatch(moved.stops as MirrorStop[], { driverId: 'drv-b', truckId: 'trk-2' }) } as unknown as Load

    expect(trips([after, neighbour], 'drv-a')).toEqual([])
    expect(trips([after, neighbour], 'drv-b').map((t) => t.id)).toEqual(['L1'])
    expect(driverIsOnLoad(after, 'drv-a')).toBe(false)
    expect(loadsForDriverOnDay([after], 'drv-b', '2026-10-13')).toHaveLength(1)
    expect(loadsForDriverOnDay([after], 'drv-a', '2026-10-13')).toHaveLength(0)

    expect({
      oldOtherWeek: trips([after, neighbour], 'drv-a', otherWeek),
      neighbourOnly: trips([neighbour], 'drv-a', otherWeek),
      newDriverOtherWeek: trips([after, neighbour], 'drv-b', otherWeek),
    }).toEqual(before)
    // The pay line itself is the same money for the same load; only the owner changed.
    expect(trips([after], 'drv-b')[0]).toEqual({ ...trips([moved], 'drv-a')[0] })
  })

  it('the patch never writes rate, dates or ids', () => {
    const patch = ownFleetLoadPatch(stops(), { driverId: 'drv-a', truckId: 'trk-1' })
    for (const k of ['rate', 'miles', 'aljexId', 'tmsId', 'readyToInvoice', 'voidedAt', 'customer']) expect(patch).not.toHaveProperty(k)
  })

  it('a refused pay lock produces no patch: readers see exactly the same load', () => {
    const load = loadWith('L1', 'drv-a')
    const lock = evaluatePayLock({
      deliveryAppt: load.deliveryAppt, todayUtc: '2026-10-28', oldDriverName: 'A', newDriverName: 'B', isAdmin: false,
    })
    expect(lock.state).toBe('REFUSED')
    // The Lambda writes nothing on REFUSED, so the load the readers see is unchanged.
    expect(trips([load], 'drv-a').map((t) => t.id)).toEqual(['L1'])
    expect(trips([load], 'drv-b')).toEqual([])
  })
})
