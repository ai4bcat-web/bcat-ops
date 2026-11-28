import { describe, it, expect } from 'vitest'
import type { Driver, Load } from '@/types'
import type { TruckLocation } from '@/lib/apiClient'
import { ageText, computeGps, filterGps, gpsCountsLine, currentOpenLoad, fixState, lastSeenText, NOT_REPORTING_MINUTES } from './gps'

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
    expect(r.counts).toEqual({ onLoad: 0, empty: 1, notReporting: 0, noGps: 2, total: 3 })
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

const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 3_600_000

describe('GPS: a fix more than 24 hours old gets no pin', () => {
  it('keeps the threshold at 24 hours', () => {
    expect(NOT_REPORTING_MINUTES).toBe(24 * 60)
  })

  it('is fresh at 2 h, faded at 3 h 1 min and 23 h 59 min, and still pinned at exactly 24 h', () => {
    expect(fixState(2 * 60)).toBe('FRESH')
    expect(fixState(3 * 60)).toBe('FRESH')
    expect(fixState(3 * 60 + 1)).toBe('STALE')
    expect(fixState(23 * 60 + 59)).toBe('STALE')
    expect(fixState(24 * 60)).toBe('STALE')
  })

  it('is not reporting one minute past 24 h and at 3 days', () => {
    expect(fixState(24 * 60 + 1)).toBe('NOT_REPORTING')
    expect(fixState(3 * 24 * 60)).toBe('NOT_REPORTING')
  })

  it('pins the drivers at each age and lists the 3 day old one as not reporting, without a pin row', () => {
    const ds = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => driver(id))
    const fixes = [
      fix('a', { locatedAt: ago(2 * HOUR) }),
      fix('b', { locatedAt: ago(3 * HOUR) }),
      fix('c', { locatedAt: ago(23 * HOUR + 59 * MIN) }),
      fix('d', { locatedAt: ago(24 * HOUR) }),
      fix('e', { locatedAt: ago(24 * HOUR + MIN) }),
      fix('f', { locatedAt: ago(3 * 24 * HOUR + 8 * HOUR), description: '5.2 mi SE of Lake Charles, LA' }),
    ]
    const r = run(ds, [], fixes)
    expect(r.located.map((x) => [x.driverId, x.stale])).toEqual([['a', false], ['b', false], ['c', true], ['d', true]])
    expect(r.notReporting.map((x) => x.driverId)).toEqual(['e', 'f'])
    expect(r.notReporting.every((x) => x.notReporting && x.stale)).toBe(true)
    expect(r.counts).toEqual({ onLoad: 0, empty: 4, notReporting: 2, noGps: 0, total: 6 })
    expect(gpsCountsLine(r.counts)).toBe('0 on a load · 4 empty · 2 not reporting')
  })

  it('keeps the last known place on a not-reporting driver and words the age', () => {
    const r = run([driver('m')], [], [fix('m', { locatedAt: ago(3 * 24 * HOUR + 8 * HOUR), description: '5.2 mi SE of Lake Charles, LA' })])
    expect(r.notReporting[0]).toMatchObject({ place: 'Lake Charles, LA', fixAgeMin: 3 * 24 * 60 + 8 * 60, lat: 41.9, lng: -87.9 })
    expect(lastSeenText(r.notReporting[0])).toBe('last seen 3 d ago near Lake Charles, LA')
    expect(lastSeenText({ fixAgeMin: 26 * 60, place: null })).toBe('last seen 26 h ago')
    expect(ageText(26 * 60)).toBe('26 h ago')
    expect(ageText(3 * 24 * 60)).toBe('3 d ago')
  })

  it('counts a not-reporting driver who is on a load as not reporting, never on a load or empty', () => {
    const open = load('14200', 'm', [pu({ arrivedAt: '2026-11-28T13:00:00Z' }), de()])
    const r = run([driver('m'), driver('x')], [open], [fix('m', { locatedAt: ago(4 * 24 * HOUR) }), fix('x')])
    expect(r.located.map((d) => d.driverId)).toEqual(['x'])
    expect(r.notReporting[0]).toMatchObject({ driverId: 'm', status: 'LOAD', load: { pro: '14200' } })
    expect(r.counts).toMatchObject({ onLoad: 0, empty: 1, notReporting: 1 })
    expect(filterGps(r.located, 'LOAD')).toEqual([])
    expect(filterGps(r.located, 'NOT_REPORTING')).toEqual([])
  })

  it('leaves the match alone: a driver with no truck or no fix is still under No GPS', () => {
    const r = run([driver('n', { assignedTruckId: null } as unknown as Partial<Driver>), driver('f')], [], [])
    expect(r.noGps.map((d) => d.noGpsReason)).toEqual(['NO_FIX', 'NO_TRUCK'])
    expect(r.notReporting).toEqual([])
  })
})
