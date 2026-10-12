import { describe, it, expect } from 'vitest'
import { routeProgress, legFraction, routeFromStops, routeProgressForStops } from './routeProgress'
import { locateCity } from './eldRadius'
import type { Load } from '@/types'

const CHICAGO = locateCity('Chicago, IL')!
const ELK = locateCity('Elk Grove Village, IL')!
const load = (stops: unknown[]) => ({ id: 'l', aljexId: '1', stops } as unknown as Load)
const pickup = (over: Record<string, unknown> = {}) => ({ id: 'p', type: 'pickup', sequence: 0, name: 'Batory', city: 'Elk Grove Village, IL', appt: '2026-10-11T13:00:00Z', ...over })
const delivery = (over: Record<string, unknown> = {}) => ({ id: 'd', type: 'delivery', sequence: 1, name: 'Jewel DC', city: 'Chicago, IL', appt: '2026-10-11T18:00:00Z', ...over })

describe('routeProgress', () => {
  it('starts at zero, sits at a stop while on site, and completes when the last stop is left', () => {
    expect(routeProgress(load([pickup(), delivery()]), null)).toMatchObject({ percent: 0, position: 0, nextIndex: 0, complete: false })
    expect(routeProgress(load([pickup({ arrivedAt: 'x' }), delivery()]), null)).toMatchObject({ percent: 0, position: 0, nextIndex: 0, milesToNext: 0 })
    expect(routeProgress(load([pickup({ arrivedAt: 'x', departedAt: 'y' }), delivery({ arrivedAt: 'z' })]), null)).toMatchObject({ percent: 100, position: 1, nextIndex: 1 })
    expect(routeProgress(load([pickup({ departedAt: 'y' }), delivery({ departedAt: 'z' })]), null)).toMatchObject({ percent: 100, complete: true, nextIndex: null })
  })
  it('places the truck along the leg by distance once it has left a stop', () => {
    // Halfway between Elk Grove Village and Chicago.
    const mid = { lat: (CHICAGO.lat + ELK.lat) / 2, lng: (CHICAGO.lng + ELK.lng) / 2 }
    const r = routeProgress(load([pickup({ departedAt: 'y' }), delivery()]), mid)!
    expect(r.basis).toBe('taps+location')
    expect(r.percent).toBeGreaterThan(40)
    expect(r.percent).toBeLessThan(60)
    expect(r.milesToNext).toBeGreaterThan(5)
    expect(legFraction(CHICAGO, ELK, CHICAGO)).toBe(1)
  })
  it('reads an owner operator from position alone', () => {
    const r = routeProgress(load([pickup(), delivery()]), CHICAGO, { useTaps: false })!
    expect(r.basis).toBe('location')
    expect(r.percent).toBeGreaterThanOrEqual(95)
    const start = routeProgress(load([pickup(), delivery()]), ELK, { useTaps: false })!
    expect(start.percent).toBeLessThanOrEqual(5)
  })
  it('is null for a load with no stops', () => {
    expect(routeProgress(load([]), null)).toBeNull()
  })
})

describe('routeFromStops (driver app, no position)', () => {
  it('marks the strip from the taps alone', () => {
    const r = routeFromStops([
      { id: 'a', type: 'pickup', name: 'Batory', city: 'Elk Grove Village, IL', appt: null, departedAt: 'x' },
      { id: 'b', type: 'pickup', name: 'Pilot', city: 'Gurnee, IL', appt: null, arrivedAt: 'y' },
      { id: 'c', type: 'delivery', name: 'Jewel', city: 'Chicago, IL', appt: null },
    ])!
    expect(r.position).toBe(1)
    expect(r.percent).toBe(50)
    expect(r.nextIndex).toBe(1)
    expect(routeFromStops([])).toBeNull()
  })
})

describe('position beats a missed tap', () => {
  it('puts the truck at the delivery when it is parked there, even with no taps on the load', () => {
    const r = routeProgress(load([pickup(), delivery()]), CHICAGO)!
    expect(r.stops[1].state).toBe('IN_PROGRESS')
    expect(r.stops[0].state).toBe('DONE')
    expect(r.percent).toBe(100)
    expect(r.nextIndex).toBe(1)
    expect(r.milesToNext).toBe(0)
  })
  it('places an untapped Ivan driver along the route by position', () => {
    const mid = { lat: (CHICAGO.lat + ELK.lat) / 2, lng: (CHICAGO.lng + ELK.lng) / 2 }
    const r = routeProgress(load([pickup(), delivery()]), mid)!
    expect(r.basis).toBe('location')
    expect(r.percent).toBeGreaterThan(30)
    expect(r.percent).toBeLessThan(70)
  })
})

describe('a day across loads', () => {
  it('moves onto the leg to the next pickup once a delivery is done', () => {
    const stops = [
      { ...delivery({ id: 'd1', sequence: 0, name: 'Woodmans', city: 'Beloit, WI', departedAt: '2026-10-12T11:11:00Z' }) },
      { ...pickup({ id: 'p2', sequence: 1, name: 'Rust-Oleum', city: 'Pleasant Prairie, WI' }) },
      { ...delivery({ id: 'd2', sequence: 2, name: 'MPS', city: 'Chicago, IL' }) },
    ] as unknown as import('@/types').Stop[]
    const r = routeProgressForStops(stops, null)!
    expect(r.complete).toBe(false)
    expect(r.nextIndex).toBe(1)
    expect(r.position).toBe(0)
    expect(r.stops.map((s) => s.state)).toEqual(['DONE', 'UPCOMING', 'UPCOMING'])
    const r2 = routeProgressForStops(stops, { lat: 42.52, lng: -87.93 })!   // parked at Pleasant Prairie
    expect(r2.stops[1].state).toBe('IN_PROGRESS')
  })
})
