import { describe, it, expect } from 'vitest'
import { placeOf, whereaboutsLine, whereaboutsOf, statusLine, trailerOnDriver, unitLine } from './driverWhereabouts'
import type { Driver, Load } from '@/types'
import type { TruckLocation } from '@/lib/apiClient'

describe('whereabouts', () => {
  it('reads City, ST out of a Motive description, falling back to coordinates', () => {
    expect(placeOf({ description: '4.5 mi NE of Schaumburg, IL', lat: 42, lon: -88 })).toBe('Schaumburg, IL')
    expect(placeOf({ description: null, lat: 42.0039, lon: -87.9703 })).toBe('42.004, -87.970')
    expect(placeOf(null)).toBeNull()
  })
  it('combines the truck fix with the pending delivery ETA', () => {
    const now = Date.parse('2026-10-10T17:00:00Z')
    const driver = { id: 'd1', name: 'Jason', phone: '+1', active: true, assignedTruckId: 'eq-1', createdAt: '', updatedAt: '' } as Driver
    const load = {
      id: 'l1', aljexId: '14578', status: 'In Transit', pickupDate: '2026-10-10', deliveryDate: '2026-10-10',
      stops: [
        { id: 'p', type: 'pickup', sequence: 1, name: 'Batory', driverId: 'd1', arrivedAt: '2026-10-10T14:00:00Z', departedAt: '2026-10-10T15:00:00Z' },
        { id: 'd', type: 'delivery', sequence: 2, name: 'Jewel DC', driverId: 'd1', etaAt: '2026-10-10T19:45:00Z', etaBasis: 'motive' },
      ],
    } as unknown as Load
    const loc = { truckId: 'eq-1', unitNumber: '3114', lat: 42, lon: -88, description: 'Elk Grove Village, IL', locatedAt: '2026-10-10T16:55:00Z' } as TruckLocation
    const w = whereaboutsOf(driver, [load], [{ id: 'eq-1', unitNumber: '3114' }], [loc], now)
    expect(w?.place).toBe('Elk Grove Village, IL')
    expect(w?.lastEvent?.label).toBe('Departed pickup')
    expect(w?.eta).toEqual({ at: '2026-10-10T19:45:00Z', stopName: 'Jewel DC', basis: 'motive' })
    expect(whereaboutsLine(w)).toBe('Elk Grove Village, IL · ETA 2:45 PM Jewel DC')
  })
  it('says nothing for a conversation with no driver, and marks a stale fix', () => {
    expect(whereaboutsOf(null, [], [], [], 0)).toBeNull()
    expect(whereaboutsLine(null)).toBeNull()
    expect(whereaboutsLine({ place: 'Gary, IN', fixAgeMin: 600, lastEvent: null, eta: null, truck: null, trailer: null })).toBe('Gary, IN (10h ago)')
  })
  it('names the truck on file and the trailer riding with the load under way', () => {
    const driver = { id: 'd1', assignedTruckId: 'eq-1', assignedTrailerId: 'tr-9' } as Driver
    const equipment = [{ id: 'eq-1', unitNumber: '3114' }, { id: 'tr-9', unitNumber: '9001' }]
    const hauling = { id: 'l1', trailerNumber: '5302', stops: [
      { id: 'p', type: 'pickup', sequence: 1, driverId: 'd1', departedAt: '2026-10-12T14:00:00Z' },
      { id: 'd', type: 'delivery', sequence: 2, driverId: 'd1' },
    ] } as unknown as Load
    const delivered = { id: 'l0', trailerNumber: '4471', stops: [
      { id: 'p', type: 'pickup', sequence: 1, driverId: 'd1', departedAt: '2026-10-12T12:00:00Z' },
      { id: 'd', type: 'delivery', sequence: 2, driverId: 'd1', departedAt: '2026-10-12T13:30:00Z' },
    ] } as unknown as Load
    expect(trailerOnDriver(driver, [delivered, hauling], equipment)).toBe('5302')
    // Nothing under way: the trailer on their file.
    expect(trailerOnDriver(driver, [delivered], equipment)).toBe('9001')
    expect(trailerOnDriver({ id: 'd1', assignedTrailerId: null }, [delivered], equipment)).toBeNull()
    const w = whereaboutsOf(driver, [hauling], equipment, [], Date.parse('2026-10-12T15:00:00Z'))
    expect(unitLine(w)).toBe('Truck 3114 · Trailer 5302')
    expect(unitLine({ place: null, fixAgeMin: null, lastEvent: null, eta: null, truck: null, trailer: '5302' })).toBe('Trailer 5302')
    expect(unitLine(null)).toBeNull()
  })
})

describe('statusLine', () => {
  it('prefers the conversation’s own status, falls back to the load’s last event, else nothing', () => {
    expect(statusLine({ lastStatusText: 'Departed pickup · Batory', lastStatusAt: '2026-10-10T19:14:00Z' }, null)).toBe('Departed pickup · Batory · Oct 10, 2:14 PM')
    expect(statusLine({}, { place: null, fixAgeMin: null, lastEvent: { label: 'On site at pickup', at: '2026-10-10T18:00:00Z' }, eta: null })).toBe('On site at pickup · Oct 10, 1:00 PM')
    expect(statusLine({}, null)).toBeNull()
  })
})
