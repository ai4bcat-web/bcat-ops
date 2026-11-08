import { describe, expect, it } from 'vitest'
import { descriptorOf } from './registry'
import { stubTrackingPort, trackingPortFor, type TrackingProviderPort, type TrackingSubscription } from './trackingProvider'
import type { ProviderDescriptor } from './types'

const macropoint = descriptorOf('MACROPOINT') as ProviderDescriptor
// What the registry would say the day a live MacroPoint port exists.
const macropointLiveCapable: ProviderDescriptor = { ...macropoint, liveCapabilities: ['track'] }
const fullCreds = { partnerId: 'p-1', apiPassword: 'hunter2hunter2' }

const livePort: TrackingProviderPort = {
  key: 'MACROPOINT',
  mode: 'LIVE',
  subscribe: async () => ({ mode: 'LIVE', ok: true, message: 'started', providerRef: 'mp-1' }),
  unsubscribe: async () => ({ mode: 'LIVE', ok: true, message: 'stopped', providerRef: null }),
  parseDelivery: () => null,
}

const sub: TrackingSubscription = {
  reference: 'abcdefghijklmnop', loadId: 'L1', loadCarrierId: 'LC1', shipmentId: 'S1',
  carrier: { name: 'Acme', dot: '123', mc: null }, driverPhone: null,
  origin: { city: 'Joliet', state: 'IL' }, destination: { city: 'Toledo', state: 'OH' },
  pickupAppt: null, deliveryAppt: null,
}

describe('trackingPortFor', () => {
  it('stays on the stub with full credentials when no live port was supplied', () => {
    expect(trackingPortFor(macropointLiveCapable, fullCreds).mode).toBe('STUB')
  })

  it('stays on the stub with a live port when the registry has no live capability', () => {
    expect(trackingPortFor(macropoint, fullCreds, livePort).mode).toBe('STUB')
  })

  it('stays on the stub with a live port and neutered credentials', () => {
    expect(trackingPortFor(macropointLiveCapable, { ...fullCreds, apiPassword: 'disabled-on-dev' }, livePort).mode).toBe('STUB')
    expect(trackingPortFor(macropointLiveCapable, { partnerId: 'p-1' }, livePort).mode).toBe('STUB')
  })

  it('goes live only with a live port and complete credentials', () => {
    expect(trackingPortFor(macropointLiveCapable, fullCreds, livePort)).toBe(livePort)
  })
})

describe('stub port', () => {
  const port = stubTrackingPort(macropoint)

  it('says STUB and fabricates no provider id', async () => {
    const r = await port.subscribe(sub)
    expect(r.message.startsWith('STUB — ')).toBe(true)
    expect(r.mode).toBe('STUB')
    expect(r.providerRef).toBe('stub:abcdefgh')
  })

  it('accepts the SIM delivery and drops unusable fixes', () => {
    const body = JSON.stringify({
      reference: 'tok', status: 'ACTIVE',
      fixes: [
        { refId: 'a', at: '2026-11-04T14:00:00Z', lat: 41.5, lng: -88.1, accuracyM: 30, speedMph: 54 },
        { refId: 'b', at: '2026-11-04T14:05:00Z', lat: 99, lng: -88.1 },
        { at: '2026-11-04T14:05:00Z', lat: 41.5, lng: -88.1 },
      ],
    })
    const parsed = port.parseDelivery({ headers: {}, body })
    expect(parsed?.reference).toBe('tok')
    expect(parsed?.status).toBe('ACTIVE')
    expect(parsed?.fixes.map((f) => f.refId)).toEqual(['a'])
  })

  it('rejects a body that does not look like the SIM shape', () => {
    const mp = JSON.stringify({ orderId: 'x', locations: [{ latitude: 41.5, longitude: -88.1, timestamp: 1 }] })
    expect(port.parseDelivery({ headers: {}, body: mp })).toBeNull()
    expect(port.parseDelivery({ headers: {}, body: 'not json' })).toBeNull()
  })
})
