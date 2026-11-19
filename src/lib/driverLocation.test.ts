import { describe, it, expect } from 'vitest'
import { driverLocationOf, ageLabel, locationTitle, nearestKnownCity, STALE_FIX_MIN } from './driverLocation'
import type { TruckLocation } from '@/lib/apiClient'
import type { Load } from '@/types'

const NOW = Date.parse('2026-11-18T18:00:00Z')
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

const driver = { id: 'd1', assignedTruckId: 'eq-3114' }
const equipment = [{ id: 'eq-3114', unitNumber: '3114' }]

const fix = (over: Partial<TruckLocation> = {}): TruckLocation => ({
  truckId: 'eq-3114', unitNumber: '3114', lat: 41.5934, lon: -87.3464, bearing: null, speed: 0,
  locatedAt: minAgo(4), description: '2.1 mi NE of Gary, IN', motion: 'STATIONARY', motionSince: null, odometer: null,
  source: 'motive', syncedAt: minAgo(3), createdAt: minAgo(3), updatedAt: minAgo(3), ...over,
})

/** A load whose only stop for d1 has the given facility event. */
const loadWithStop = (event: { arrivedAt?: string; departedAt?: string }, city: string | null = 'Joliet, IL'): Load => ({
  id: 'L1',
  stops: [{ id: 's1', type: 'delivery', name: 'Batory Joliet', city: city ?? undefined, appt: minAgo(300), driverId: 'd1', sequence: 0, ...event }],
}) as unknown as Load

describe('driverLocationOf', () => {
  it('reads the truck ELD fix as City, ST with its age', () => {
    const loc = driverLocationOf(driver, [], equipment, [fix()], NOW)
    expect(loc).toMatchObject({ place: 'Gary, IN', source: 'ELD', state: 'STOPPED', ageMin: 4, approximate: false })
  })

  it('marks a moving truck as moving', () => {
    expect(driverLocationOf(driver, [], equipment, [fix({ motion: 'MOVING' })], NOW)?.state).toBe('MOVING')
  })

  it('uses the freshest fix when a truck has two rows, and matches an aliased unit number', () => {
    const rows = [fix({ locatedAt: minAgo(50), description: '1 mi of Hammond, IN' }), fix({ locatedAt: minAgo(6), description: '3 mi S of Merrillville, IN' })]
    expect(driverLocationOf(driver, [], equipment, rows, NOW)?.place).toBe('Merrillville, IN')
    const alias = driverLocationOf({ id: 'd1', assignedTruckId: 'eq-890' }, [], [{ id: 'eq-890', unitNumber: '3890' }], [fix({ truckId: 'motive:890', unitNumber: '890' })], NOW)
    expect(alias?.place).toBe('Gary, IN')
  })

  it('falls back to the nearest known city when the fix has coordinates only, and says so', () => {
    const loc = driverLocationOf(driver, [], equipment, [fix({ description: null, lat: 41.88, lon: -87.63 })], NOW)
    expect(loc?.place).toMatch(/^near Chicago, IL$/)
    expect(loc?.approximate).toBe(true)
    expect(locationTitle(loc!)).toMatch(/nearest known city/)
  })

  it('keeps a stale signal as the place but flags it stale', () => {
    const loc = driverLocationOf(driver, [], equipment, [fix({ locatedAt: minAgo(STALE_FIX_MIN + 60) })], NOW)
    expect(loc).toMatchObject({ place: 'Gary, IN', source: 'ELD', state: 'STALE' })
  })

  it('prefers the driver’s own newer stop event over a stale ELD fix', () => {
    const load = loadWithStop({ departedAt: minAgo(20) })
    const loc = driverLocationOf(driver, [load], equipment, [fix({ locatedAt: minAgo(STALE_FIX_MIN + 90) })], NOW)
    expect(loc).toMatchObject({ place: 'Joliet, IL', source: 'LAST_STOP', state: 'LAST_STOP', ageMin: 20 })
  })

  it('keeps a fresh ELD fix even when a stop event is a little newer', () => {
    const load = loadWithStop({ arrivedAt: minAgo(2) })
    expect(driverLocationOf(driver, [load], equipment, [fix()], NOW)?.source).toBe('ELD')
  })

  it('falls back to the last stop the driver reported when the truck has no fix', () => {
    const load = loadWithStop({ arrivedAt: minAgo(75) })
    const loc = driverLocationOf(driver, [load], equipment, [], NOW)
    expect(loc).toMatchObject({ place: 'Joliet, IL', source: 'LAST_STOP', ageMin: 75 })
  })

  it('uses the facility name when the stop has no city', () => {
    const loc = driverLocationOf({ id: 'd1', assignedTruckId: null }, [loadWithStop({ arrivedAt: minAgo(5) }, null)], equipment, [], NOW)
    expect(loc?.place).toBe('Batory Joliet')
  })

  it('shows nothing for a driver with no truck and no stop, or no driver at all', () => {
    expect(driverLocationOf({ id: 'd1', assignedTruckId: null }, [], equipment, [fix()], NOW)).toBeNull()
    expect(driverLocationOf(undefined, [], equipment, [fix()], NOW)).toBeNull()
  })

  it('ignores another driver’s stops', () => {
    const other = { id: 'L2', stops: [{ id: 's9', type: 'delivery', city: 'Omaha, NE', appt: minAgo(300), driverId: 'someone-else', sequence: 0, arrivedAt: minAgo(5) }] } as unknown as Load
    expect(driverLocationOf({ id: 'd1', assignedTruckId: null }, [other], equipment, [], NOW)).toBeNull()
  })
})

describe('formatting', () => {
  it('words the age', () => {
    expect([0, 1, 4, 59, 60, 180, 60 * 48, 60 * 24 * 5].map(ageLabel)).toEqual(['just now', 'just now', '4 min ago', '59 min ago', '1 h ago', '3 h ago', '2 d ago', '5 d ago'])
  })
  it('finds the nearest known city', () => {
    expect(nearestKnownCity(41.88, -87.63)?.place).toBe('Chicago, IL')
    expect(nearestKnownCity(Number.NaN, 0)).toBeNull()
  })
  it('puts the time, source and motion in the hover text', () => {
    const t = locationTitle({ place: 'Gary, IN', source: 'ELD', state: 'MOVING', ageMin: 4, at: minAgo(4), approximate: false })
    expect(t).toMatch(/Gary, IN · Truck GPS\/ELD · .*Central · moving/)
    const stop = locationTitle({ place: 'Joliet, IL', source: 'LAST_STOP', state: 'LAST_STOP', ageMin: 20, at: minAgo(20), approximate: false })
    expect(stop).toMatch(/Last stop the driver reported/)
  })
})
