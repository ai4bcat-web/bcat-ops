import { describe, it, expect } from 'vitest'
import type { Load, Stop } from '@/types'
import { getStops, deriveLegacyFields, withDerivedLegacy, makeStop, updateStop, reorderStops } from './stops'

function legacyLoad(over: Partial<Load> = {}): Load {
  return {
    id: 'load-1', aljexId: 'A-1', tmsId: 'T-1', pickupNumber: 'PU-1',
    pickupAppt: '2026-06-15T08:00:00Z', pickupApptType: 'exact',
    deliveryAppt: '2026-06-16T17:00:00Z', deliveryApptType: 'exact',
    originName: 'Shipper', originCity: 'Chicago, IL',
    destinationName: 'Consignee', destinationCity: 'Indianapolis, IN',
    pickupDriverId: 'drv-1', deliveryDriverId: 'drv-2',
    readyToInvoice: false,
    createdAt: '', updatedAt: '', createdBy: 'x', updatedBy: 'x',
    ...over,
  }
}

describe('getStops', () => {
  it('synthesizes 2 stops from a legacy load (no stops array)', () => {
    const stops = getStops(legacyLoad())
    expect(stops).toHaveLength(2)
    expect(stops[0]).toMatchObject({ type: 'pickup', name: 'Shipper', city: 'Chicago, IL', appt: '2026-06-15T08:00:00Z', driverId: 'drv-1', sequence: 0 })
    expect(stops[1]).toMatchObject({ type: 'delivery', name: 'Consignee', city: 'Indianapolis, IN', appt: '2026-06-16T17:00:00Z', driverId: 'drv-2', sequence: 1 })
    expect(stops[0].id).toBe('load-1:pu')
    expect(stops[1].id).toBe('load-1:de')
  })

  it('returns the real stops array (sorted by sequence) when present', () => {
    const stops: Stop[] = [
      { id: 'b', type: 'delivery', appt: '2026-06-16T00:00:00Z', driverId: null, sequence: 1 },
      { id: 'a', type: 'pickup', appt: '2026-06-15T00:00:00Z', driverId: null, sequence: 0 },
    ]
    const out = getStops(legacyLoad({ stops }))
    expect(out.map((s) => s.id)).toEqual(['a', 'b'])
  })
})

describe('deriveLegacyFields', () => {
  it('maps first pickup → pickup*, last delivery → delivery* (1 pickup + 1 delivery)', () => {
    const stops = getStops(legacyLoad())
    const legacy = deriveLegacyFields(stops)
    expect(legacy.pickupAppt).toBe('2026-06-15T08:00:00Z')
    expect(legacy.deliveryAppt).toBe('2026-06-16T17:00:00Z')
    expect(legacy.originName).toBe('Shipper')
    expect(legacy.destinationCity).toBe('Indianapolis, IN')
    expect(legacy.pickupDriverId).toBe('drv-1')
    expect(legacy.deliveryDriverId).toBe('drv-2')
  })

  it('uses FIRST pickup and LAST delivery across 3+ stops', () => {
    const stops: Stop[] = [
      { id: 'p1', type: 'pickup',   name: 'PU A', appt: '2026-06-10T08:00:00Z', driverId: 'd1', sequence: 0 },
      { id: 'p2', type: 'pickup',   name: 'PU B', appt: '2026-06-11T08:00:00Z', driverId: 'd1', sequence: 1 },
      { id: 'd1', type: 'delivery', name: 'DE C', appt: '2026-06-13T08:00:00Z', driverId: 'd2', sequence: 2 },
      { id: 'd2', type: 'delivery', name: 'DE D', appt: '2026-06-14T08:00:00Z', driverId: 'd3', sequence: 3 },
    ]
    const legacy = deriveLegacyFields(stops)
    expect(legacy.pickupAppt).toBe('2026-06-10T08:00:00Z')   // first pickup
    expect(legacy.originName).toBe('PU A')
    expect(legacy.pickupDriverId).toBe('d1')
    expect(legacy.deliveryAppt).toBe('2026-06-14T08:00:00Z') // last delivery
    expect(legacy.destinationName).toBe('DE D')
    expect(legacy.deliveryDriverId).toBe('d3')
  })

  it('is total: all-pickups still yields non-null pickupAppt AND deliveryAppt', () => {
    const stops: Stop[] = [
      { id: 'p1', type: 'pickup', appt: '2026-06-10T08:00:00Z', driverId: null, sequence: 0 },
      { id: 'p2', type: 'pickup', appt: '2026-06-11T08:00:00Z', driverId: null, sequence: 1 },
    ]
    const legacy = deriveLegacyFields(stops)
    expect(legacy.pickupAppt).toBe('2026-06-10T08:00:00Z')   // first pickup
    expect(legacy.deliveryAppt).toBe('2026-06-11T08:00:00Z') // fallback: last stop
    expect(typeof legacy.pickupAppt).toBe('string')
    expect(typeof legacy.deliveryAppt).toBe('string')
  })
})

describe('withDerivedLegacy', () => {
  it('merges derived legacy fields when patch has stops', () => {
    const stops = getStops(legacyLoad())
    const patch = withDerivedLegacy({ stops, notes: 'hi' })
    expect(patch.notes).toBe('hi')
    expect(patch.pickupAppt).toBe('2026-06-15T08:00:00Z')
    expect(patch.deliveryAppt).toBe('2026-06-16T17:00:00Z')
  })

  it('is a no-op when patch has no stops', () => {
    const patch = withDerivedLegacy({ notes: 'hi' })
    expect(patch).toEqual({ notes: 'hi' })
  })
})

describe('updateStop / reorderStops / makeStop', () => {
  it('updateStop patches a single stop immutably', () => {
    const load = legacyLoad()
    const next = updateStop(load, 'load-1:pu', { driverId: 'drv-9' })
    expect(next.find((s) => s.id === 'load-1:pu')?.driverId).toBe('drv-9')
    expect(next.find((s) => s.id === 'load-1:de')?.driverId).toBe('drv-2')
  })

  it('reorderStops renumbers sequence 0..n', () => {
    const stops: Stop[] = [
      { id: 'a', type: 'pickup', appt: '', driverId: null, sequence: 5 },
      { id: 'b', type: 'delivery', appt: '', driverId: null, sequence: 9 },
    ]
    expect(reorderStops(stops).map((s) => s.sequence)).toEqual([0, 1])
  })

  it('makeStop assigns a unique id and the given sequence', () => {
    const s = makeStop({ type: 'pickup' }, 3)
    expect(s.type).toBe('pickup')
    expect(s.sequence).toBe(3)
    expect(s.id).toBeTruthy()
    expect(s.apptType).toBe('exact')
    expect(s.driverId).toBeNull()
  })
})
