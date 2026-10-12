import { describe, it, expect } from 'vitest'
import { routeProgress, legFraction, routeFromStops } from './routeProgress'
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
