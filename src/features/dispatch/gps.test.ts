import { describe, it, expect } from 'vitest'
import type { Driver, Load } from '@/types'
import type { TruckLocation } from '@/lib/apiClient'
import { ageText, computeGps, filterGps, gpsCountsLine, currentOpenLoad } from './gps'

const NOW = Date.parse('2026-11-28T18:00:00Z')
const driver = (id: string, extra: Partial<Driver> = {}) => ({ id, name: id.toUpperCase(), phone: '+1', active: true, assignedTruckId: `eq-${id}`, createdAt: '', updatedAt: '', ...extra }) as unknown as Driver
const eq = (id: string) => ({ id: `eq-${id}`, unitNumber: `3${id.length}${id.charCodeAt(0)}` })
const fix = (id: string, extra: Partial<TruckLocation> = {}) => ({ truckId: `eq-${id}`, unitNumber: eq(id).unitNumber, lat: 41.9, lon: -87.9, description: '3 mi N of Chicago, IL', motion: 'STATIONARY', speed: 0, locatedAt: '2026-11-28T17:50:00Z', ...extra }) as unknown as TruckLocation
const load = (id: string, driverId: string, stops: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  id, aljexId: id, originCity: 'Joliet, IL', destinationCity: 'Dallas, TX',
  stops: stops.map((s, i) => ({ id: `${id}:${i}`, sequence: i, driverId, appt: '2026-11-28T12:00:00Z', ...s })), ...extra,
}) as unknown as Load
const pu = (extra: Record<string, unknown> = {}) => ({ type: 'pickup', appt: '2026-11-28T12:00:00Z', ...extra })
const de = (extra: Record<string, unknown> = {}) => ({ type: 'delivery', appt: '2026-11-29T12:00:00Z', ...extra })

const run = (drivers: Driver[], loads: Load[], locations: TruckLocation[]) =>
  computeGps({ drivers, loads, equipment: drivers.map((d) => eq(d.id)), locations, now: NOW })

describe('GPS classification', () => {
  it('is on a load once the driver has been at a pickup and not left the last delivery', () => {
    const r = run([driver('a')], [load('14001', 'a', [pu({ arrivedAt: '2026-11-28T13:00:00Z' }), de()])], [fix('a')])
    expect(r.located[0].status).toBe('LOAD')
    expect(r.located[0].load).toMatchObject({ pro: '14001', lane: 'Joliet, IL → Dallas, TX', basis: 'stops' })
    expect(gpsCountsLine(r.counts)).toBe('1 on a load · 0 empty')
  })

  it('is empty after the last delivery is left, and with no load at all', () => {
    const done = load('14002', 'a', [pu({ departedAt: '2026-11-28T13:00:00Z' }), de({ departedAt: '2026-11-28T16:00:00Z' })])
    const r = run([driver('a'), driver('b')], [done], [fix('a'), fix('b')])
    expect(r.located.map((x) => x.status)).toEqual(['EMPTY', 'EMPTY'])
    expect(gpsCountsLine(r.counts)).toBe('0 on a load · 2 empty')
  })

  it('is empty before the pickup time of a future load, and while the driver has only tapped a later stop', () => {
    const future = load('14003', 'a', [pu({ appt: '2026-11-29T08:00:00Z' }), de({ appt: '2026-11-30T08:00:00Z' })])
    expect(run([driver('a')], [future], [fix('a')]).located[0].status).toBe('EMPTY')
  })

  it('counts an untapped load as under way per its schedule, but not long after it should have finished', () => {
    const untapped = load('14004', 'a', [pu({ appt: '2026-11-28T08:00:00Z' }), de({ appt: '2026-11-28T20:00:00Z' })])
    const r = run([driver('a')], [untapped], [fix('a')])
    expect(r.located[0].status).toBe('LOAD')
    expect(r.located[0].load?.basis).toBe('schedule')
    const stale = load('14005', 'a', [pu({ appt: '2026-11-25T08:00:00Z' }), de({ appt: '2026-11-26T08:00:00Z' })])
    expect(run([driver('a')], [stale], [fix('a')]).located[0].status).toBe('EMPTY')
  })

  it('only looks at the driver\'s own stops on a shared load', () => {
    const shared = load('14006', 'a', [pu({ driverId: 'b', arrivedAt: '2026-11-28T13:00:00Z' }), de({ driverId: 'a' })])
    // b picked up; a only delivers later and has not been anywhere yet, and the load is untapped for a
    const r = run([driver('a'), driver('b')], [shared], [fix('a'), fix('b')])
    expect(r.located.find((x) => x.driverId === 'b')?.status).toBe('EMPTY') // b has no delivery on it
    expect(r.located.find((x) => x.driverId === 'a')?.status).toBe('EMPTY') // a's schedule says the delivery is tomorrow, no pickup of a's
  })

  it('picks the load with the soonest delivery when two are open', () => {
    const l1 = load('14007', 'a', [pu({ arrivedAt: 'x' }), de({ appt: '2026-11-30T12:00:00Z' })])
    const l2 = load('14008', 'a', [pu({ arrivedAt: 'x' }), de({ appt: '2026-11-29T12:00:00Z' })])
    expect(currentOpenLoad([l1, l2], 'a', NOW)?.pro).toBe('14008')
  })
})

describe('GPS locations and the No GPS list', () => {
  it('lists a driver with no truck, a truck with no fix, and a retired driver is left out', () => {
    const noTruck = driver('n', { assignedTruckId: null } as unknown as Partial<Driver>)
    const noFix = driver('f')
    const gone = driver('g', { active: false })
    const r = run([noTruck, noFix, gone, driver('a')], [], [fix('a')])
    expect(r.located.map((x) => x.driverId)).toEqual(['a'])
    expect(r.noGps.map((x) => [x.driverId, x.noGpsReason])).toEqual([['f', 'NO_FIX'], ['n', 'NO_TRUCK']])
    expect(r.counts).toEqual({ onLoad: 0, empty: 1, noGps: 2, total: 3 })
    expect(gpsCountsLine(r.counts)).toBe('0 on a load · 1 empty · 2 no GPS')
  })

  it('uses the newest fix, reads the place and flags an old fix', () => {
    const old = fix('a', { locatedAt: '2026-11-28T17:00:00Z', lat: 30, lon: -90 })
    const newest = fix('a', { locatedAt: '2026-11-28T10:00:00Z', description: '1 mi E of Joliet, IL' })
    const r = run([driver('a')], [], [newest, old])
    expect(r.located[0]).toMatchObject({ lat: 30, lng: -90, stale: false, fixAgeMin: 60 })
    const r2 = run([driver('a')], [], [newest])
    expect(r2.located[0]).toMatchObject({ place: 'Joliet, IL', stale: true })
  })

  it('filters by status and words the age', () => {
    const r = run([driver('a'), driver('b')], [load('14009', 'a', [pu({ arrivedAt: 'x' }), de()])], [fix('a'), fix('b')])
    expect(filterGps(r.located, 'LOAD').map((x) => x.driverId)).toEqual(['a'])
    expect(filterGps(r.located, 'EMPTY').map((x) => x.driverId)).toEqual(['b'])
    expect(filterGps(r.located, 'ALL')).toHaveLength(2)
    expect([ageText(0), ageText(10), ageText(300), ageText(3000), ageText(null)]).toEqual(['just now', '10 min ago', '5 h ago', '2 d ago', 'unknown'])
  })
})
