import { describe, expect, it } from 'vitest'
import { stopForDriverStatus } from './driverStatusStop'

const stops = [
  { id: 'p1', type: 'pickup', arrivedAt: '2026-11-10T08:00:00Z', departedAt: null },
  { id: 'p2', type: 'pickup' },
  { id: 'd1', type: 'delivery' },
]
describe('stopForDriverStatus', () => {
  it('arrivals go to the first stop of that type not yet arrived at', () => {
    expect(stopForDriverStatus(stops, 'ON_SITE_PICKUP')).toEqual({ stopId: 'p2', event: 'ARRIVED' })
    expect(stopForDriverStatus(stops, 'ON_SITE_DELIVERY')).toEqual({ stopId: 'd1', event: 'ARRIVED' })
  })
  it('departures go to the stop the truck is at, else the first not departed', () => {
    expect(stopForDriverStatus(stops, 'DEPARTED_PICKUP')).toEqual({ stopId: 'p1', event: 'DEPARTED' })
    expect(stopForDriverStatus([{ id: 'd1', type: 'delivery', arrivedAt: 'x' }], 'DELIVERED')).toEqual({ stopId: 'd1', event: 'DEPARTED' })
  })
  it('en route and a status with no stop left name no stop', () => {
    expect(stopForDriverStatus(stops, 'EN_ROUTE')).toBeNull()
    expect(stopForDriverStatus([{ id: 'p1', type: 'pickup', arrivedAt: 'a', departedAt: 'b' }], 'DEPARTED_PICKUP')).toBeNull()
  })
})
