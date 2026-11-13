import { describe, expect, it } from 'vitest'
import type { TruckLocation } from '@/lib/apiClient'
import type { LoadCarrierRecord, LoadCheckCallRecord, ShipmentLoad, TrackingLinkRecord } from '@/types/tms'
import { agoText, checkInsOf, freshnessOf, railTracking, type RailTrackingInput } from './railTracking'

const NOW = new Date('2026-11-13T18:00:00.000Z')
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()

const load = (over: Partial<ShipmentLoad> = {}) => ({
  id: 'l-1', status: 'IN_TRANSIT',
  stops: [
    { id: 's1', type: 'pickup', name: 'WHIMSY', city: 'CHICAGO', arrivedAt: ago(200), arrivedSource: 'DRIVER_APP', departedAt: ago(150), departedSource: 'DRIVER_APP' },
    { id: 's2', type: 'delivery', name: 'GENERAC', city: 'OSHKOSH' },
  ],
  ...over,
}) as unknown as ShipmentLoad

const ownLeg = (over: Partial<LoadCarrierRecord> = {}) =>
  ({ id: 'lc-1', loadId: 'l-1', kind: 'OWN_ASSET', status: 'ACTIVE', driverId: 'd-1', truckId: 'eq-9', ...over }) as unknown as LoadCarrierRecord
const brokerLeg = (over: Partial<LoadCarrierRecord> = {}) =>
  ({ id: 'lc-2', loadId: 'l-1', kind: 'CARRIER', status: 'ACTIVE', carrierName: 'LANDSTAR RANGER INC', trackingLinkId: 'tl-1', ...over }) as unknown as LoadCarrierRecord

const fix = (over: Partial<TruckLocation> = {}) =>
  ({ truckId: 'eq-9', unitNumber: '309', lat: 43.1, lon: -88.5, speed: 61, motion: 'MOVING', locatedAt: ago(5), description: '4 mi N of Waukesha, WI' , ...over }) as TruckLocation

const link = (over: Partial<TrackingLinkRecord> = {}) =>
  ({ id: 'tl-1', kind: 'CARRIER_PING', loadCarrierId: 'lc-2', status: 'ACTIVE', expiresAt: ago(-600), sentAt: ago(90), ...over }) as unknown as TrackingLinkRecord

const input = (over: Partial<RailTrackingInput> = {}): RailTrackingInput => ({
  load: load(),
  loadCarriers: [ownLeg()],
  drivers: [{ id: 'd-1', name: 'Manuel', fleetGroup: 'LOCAL', type: 'driver' }] as RailTrackingInput['drivers'],
  equipment: [{ id: 'eq-9', type: 'truck', unitNumber: '309' }],
  truckLocations: [fix()],
  checkCalls: [],
  trackingLinks: [],
  now: NOW,
  ...over,
})

describe('railTracking: which case applies', () => {
  it('own-fleet company driver = Ivan: ELD fix and driver-app check-ins', () => {
    const t = railTracking(input())
    expect(t.kind).toBe('IVAN')
    expect(t.driverName).toBe('Manuel')
    expect(t.truckLabel).toBe('Truck 309')
    expect(t.fix).toMatchObject({ source: 'ELD', place: '4 mi N of Waukesha, WI', speedMph: 61, moving: true })
    expect(t.checkIns.map((c) => c.label)).toEqual(['Departed pickup', 'On site at pickup'])
  })

  it('own-fleet owner operator = OWNER_OP with the ELD fix', () => {
    const t = railTracking(input({ drivers: [{ id: 'd-1', name: 'Oscar', fleetGroup: 'OWNER_OPERATOR', type: 'driver' }] as RailTrackingInput['drivers'] }))
    expect(t.kind).toBe('OWNER_OP')
    expect(t.fix?.source).toBe('ELD')
  })

  it('matches the ELD by unit number when the truck id is not the Motive key', () => {
    const t = railTracking(input({ truckLocations: [fix({ truckId: 'motive:309' })] }))
    expect(t.fix).not.toBeNull()
  })

  it('own fleet with no ELD row says why', () => {
    const t = railTracking(input({ truckLocations: [] }))
    expect(t.fix).toBeNull()
    expect(t.emptyReason).toMatch(/Truck 309 has no ELD position/)
  })

  it('brokered, link accepted: last ping is the position', () => {
    const t = railTracking(input({
      loadCarriers: [brokerLeg()],
      trackingLinks: [link({ consentAt: ago(60), lastPingAt: ago(10), lastPingLat: 44, lastPingLng: -88 })],
    }))
    expect(t.kind).toBe('BROKERED')
    expect(t.carrierName).toBe('LANDSTAR RANGER INC')
    expect(t.link?.state).toBe('ACCEPTED')
    expect(t.fix).toMatchObject({ source: 'LINK', lat: 44, lng: -88 })
  })

  it('brokered, link sent but not accepted: waiting, no position', () => {
    const t = railTracking(input({ loadCarriers: [brokerLeg()], trackingLinks: [link()] }))
    expect(t.link?.state).toBe('SENT')
    expect(t.fix).toBeNull()
    expect(t.emptyReason).toMatch(/Waiting for the driver/)
  })

  it('brokered, no link: not sent; expired and revoked links say so', () => {
    expect(railTracking(input({ loadCarriers: [brokerLeg({ trackingLinkId: null })] })).link?.state).toBe('NOT_SENT')
    expect(railTracking(input({ loadCarriers: [brokerLeg()], trackingLinks: [link({ expiresAt: ago(5) })] })).link?.state).toBe('EXPIRED')
    expect(railTracking(input({ loadCarriers: [brokerLeg()], trackingLinks: [link({ status: 'REVOKED', revokedAt: ago(3) })] })).link?.state).toBe('STOPPED')
  })

  it('no carrier on the load: NONE with a reason', () => {
    const t = railTracking(input({ loadCarriers: [] }))
    expect(t.kind).toBe('NONE')
    expect(t.emptyReason).toMatch(/No carrier or driver/)
  })

  it('a delivered load keeps the last fix and the delivered time', () => {
    const t = railTracking(input({ load: load({ status: 'DELIVERED', deliveredAt: ago(30) } as Partial<ShipmentLoad>) }))
    expect(t.delivered).toBe(true)
    expect(t.deliveredAt).toBe(ago(30))
    expect(t.fix).not.toBeNull()
  })
})

describe('freshness and ages', () => {
  it('fresh ≤ 30 min, stale ≤ 2 h, old beyond', () => {
    expect(freshnessOf(ago(10), NOW)).toBe('fresh')
    expect(freshnessOf(ago(45), NOW)).toBe('stale')
    expect(freshnessOf(ago(180), NOW)).toBe('old')
  })
  it('agoText reads like the office talks', () => {
    expect(agoText(ago(0), NOW)).toBe('just now')
    expect(agoText(ago(12), NOW)).toBe('12 min ago')
    expect(agoText(ago(180), NOW)).toBe('3 h ago')
    expect(agoText(ago(60 * 72), NOW)).toBe('3 d ago')
  })
})

describe('checkInsOf', () => {
  it('only driver-app stop taps and app check calls, newest first, capped', () => {
    const stops = [{ id: 's', type: 'pickup', name: 'A', arrivedAt: ago(50), arrivedSource: 'MANUAL' }] as never
    const calls = [
      { at: ago(20), type: 'LOCATION_UPDATE', source: 'DRIVER_APP', city: 'Joliet', state: 'IL' },
      { at: ago(10), type: 'NOTE', source: 'MANUAL' },
    ] as unknown as LoadCheckCallRecord[]
    expect(checkInsOf(stops, calls)).toEqual([{ at: ago(20), label: 'Location update', place: 'Joliet, IL' }])
  })
})
