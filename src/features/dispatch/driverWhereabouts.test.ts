import { describe, it, expect } from 'vitest'
import { placeOf, whereaboutsLine, whereaboutsOf } from './driverWhereabouts'
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
    expect(whereaboutsLine({ place: 'Gary, IN', fixAgeMin: 600, lastEvent: null, eta: null })).toBe('Gary, IN (10h ago)')
  })
})
