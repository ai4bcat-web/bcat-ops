import { describe, it, expect } from 'vitest'
import { outsideCarrierLoadPatch, ownFleetLoadPatch, uncoveredLoadPatch } from './loadMirror'
import type { MirrorStop } from './loadMirror'

const stop = (patch: Partial<MirrorStop> & Pick<MirrorStop, 'id' | 'type' | 'sequence'>): MirrorStop => ({
  name: undefined,
  city: undefined,
  appt: '',
  driverId: null,
  ...patch,
})

const ROUTE: MirrorStop[] = [
  stop({ id: 's0', type: 'pickup', sequence: 0, name: 'Acme Dock 4', city: 'Chicago, IL', appt: '2026-05-13T13:00:00.000Z', apptType: 'exact', address: { line1: '1 Dock Rd' } as MirrorStop['address'], driverId: null }),
  stop({ id: 's1', type: 'delivery', sequence: 1, name: 'Midwest DC', city: 'Danville, IL', appt: '2026-05-14T15:00:00.000Z', apptType: 'fcfs', driverId: null }),
  stop({ id: 's2', type: 'delivery', sequence: 2, name: 'Second stop', city: 'Peoria, IL', appt: '2026-05-14T20:00:00.000Z', driverId: null }),
]

describe('ownFleetLoadPatch', () => {
  it('writes exactly the fields every own-fleet reader needs, and nothing else', () => {
    const patch = ownFleetLoadPatch(ROUTE, { driverId: 'drv-7', truckId: 'trk-3', trailerNumber: '5512' })
    expect(Object.keys(patch).sort()).toEqual([
      'assignmentType', 'carrierName', 'deliveryAppt', 'deliveryDriverId',
      'pickupAppt', 'pickupDriverId', 'stops', 'trackingProvider', 'trailerNumber', 'truckId',
    ])
    expect(patch.pickupDriverId).toBe('drv-7')
    expect(patch.deliveryDriverId).toBe('drv-7')
    expect(patch.truckId).toBe('trk-3')
    expect(patch.trailerNumber).toBe('5512')
    expect(patch.assignmentType).toBe('OWN_ASSET')
    expect(patch.trackingProvider).toBe('DRIVER_APP')
    expect(patch.carrierName).toBeNull()
    expect(patch.stops.every((s) => s.driverId === 'drv-7' && s.truckId === 'trk-3')).toBe(true)
  })

  it('derives the legacy dates from the first pickup and the LAST delivery', () => {
    const patch = ownFleetLoadPatch(ROUTE, { driverId: 'drv-7' })
    expect(patch.pickupAppt).toBe('2026-05-13T13:00:00.000Z')
    expect(patch.deliveryAppt).toBe('2026-05-14T20:00:00.000Z')
  })

  it('reads the route by sequence, not by array order', () => {
    const shuffled = [ROUTE[2], ROUTE[0], ROUTE[1]]
    const patch = ownFleetLoadPatch(shuffled, { driverId: 'drv-7' })
    expect(patch.pickupAppt).toBe('2026-05-13T13:00:00.000Z')
    expect(patch.deliveryAppt).toBe('2026-05-14T20:00:00.000Z')
  })

  it('leaves a required date column alone when the stop carries no appointment', () => {
    const undated = ROUTE.map((s) => ({ ...s, appt: '' }))
    const patch = ownFleetLoadPatch(undated, { driverId: 'drv-7' })
    expect('pickupAppt' in patch).toBe(false)
    expect('deliveryAppt' in patch).toBe(false)
  })

  it('leaves the truck off the stops when the booking names none', () => {
    const patch = ownFleetLoadPatch(ROUTE, { driverId: 'drv-7' })
    expect(patch.truckId).toBeNull()
    expect(patch.stops.every((s) => !('truckId' in s))).toBe(true)
  })

  it('never touches the load fields that are not about who is pulling it', () => {
    const patch = ownFleetLoadPatch(ROUTE, { driverId: 'drv-7', truckId: 'trk-3' })
    for (const key of ['rate', 'readyToInvoice', 'aljexId', 'customer', 'status', 'notes']) {
      expect(key in patch).toBe(false)
    }
    expect(patch.stops[0].name).toBe('Acme Dock 4')
    expect(patch.stops[0].appt).toBe('2026-05-13T13:00:00.000Z')
    expect(patch.stops[0].address).toEqual({ line1: '1 Dock Rd' })
  })

  it('is idempotent on a re-book of the same driver', () => {
    const once = ownFleetLoadPatch(ROUTE, { driverId: 'drv-7', truckId: 'trk-3', trailerNumber: '5512' })
    const twice = ownFleetLoadPatch(once.stops, { driverId: 'drv-7', truckId: 'trk-3', trailerNumber: '5512' })
    expect(twice).toEqual(once)
  })

  it('moves the whole load when the driver changes', () => {
    const first = ownFleetLoadPatch(ROUTE, { driverId: 'drv-7', truckId: 'trk-3' })
    const second = ownFleetLoadPatch(first.stops, { driverId: 'drv-9', truckId: 'trk-8' })
    expect(second.pickupDriverId).toBe('drv-9')
    expect(second.deliveryDriverId).toBe('drv-9')
    expect(second.stops.every((s) => s.driverId === 'drv-9' && s.truckId === 'trk-8')).toBe(true)
  })
})

describe('outsideCarrierLoadPatch', () => {
  const booked = ownFleetLoadPatch(ROUTE, { driverId: 'drv-7', truckId: 'trk-3', trailerNumber: '5512' })

  it('clears every driver and truck field so the load leaves the own-fleet views', () => {
    const patch = outsideCarrierLoadPatch(booked.stops, { carrierName: 'Pine Transport' })
    expect(Object.keys(patch).sort()).toEqual([
      'assignmentType', 'carrierName', 'deliveryDriverId', 'pickupDriverId',
      'stops', 'trailerNumber', 'truckId',
    ])
    expect(patch.pickupDriverId).toBeNull()
    expect(patch.deliveryDriverId).toBeNull()
    expect(patch.truckId).toBeNull()
    expect(patch.trailerNumber).toBeNull()
    expect(patch.assignmentType).toBe('CARRIER')
    expect(patch.carrierName).toBe('Pine Transport')
    expect(patch.stops.every((s) => s.driverId === null && !('truckId' in s))).toBe(true)
  })

  it('leaves the appointments, addresses and actual stop times intact', () => {
    const withTimes = booked.stops.map((s, i) => (i === 0 ? { ...s, arrivedAt: '2026-05-13T12:40:00.000Z' } : s))
    const patch = outsideCarrierLoadPatch(withTimes, { carrierName: 'Pine Transport' })
    expect(patch.stops.map((s) => s.appt)).toEqual(ROUTE.map((s) => s.appt))
    expect(patch.stops.map((s) => s.city)).toEqual(ROUTE.map((s) => s.city))
    expect(patch.stops[0].address).toEqual({ line1: '1 Dock Rd' })
    expect(patch.stops[0].arrivedAt).toBe('2026-05-13T12:40:00.000Z')
    // The dates on the load itself are never rewritten by a carrier change.
    expect('pickupAppt' in patch).toBe(false)
    expect('deliveryAppt' in patch).toBe(false)
  })

  it('is idempotent', () => {
    const once = outsideCarrierLoadPatch(booked.stops, { carrierName: 'Pine Transport' })
    const twice = outsideCarrierLoadPatch(once.stops, { carrierName: 'Pine Transport' })
    expect(twice).toEqual(once)
  })
})

describe('uncoveredLoadPatch', () => {
  it('clears the same fields and names no carrier', () => {
    const booked = ownFleetLoadPatch(ROUTE, { driverId: 'drv-7', truckId: 'trk-3' })
    const patch = uncoveredLoadPatch(booked.stops)
    expect(patch.assignmentType).toBe('NEED_TO_COVER')
    expect(patch.carrierName).toBeNull()
    expect(patch.stops.every((s) => s.driverId === null && !('truckId' in s))).toBe(true)
    expect(uncoveredLoadPatch(patch.stops)).toEqual(patch)
  })

  it('matches the outside-carrier clear everywhere but the assignment and the name', () => {
    const bounced = uncoveredLoadPatch(ROUTE)
    const booked = outsideCarrierLoadPatch(ROUTE, { carrierName: 'Pine Transport' })
    expect({ ...bounced, assignmentType: 'CARRIER', carrierName: 'Pine Transport' }).toEqual(booked)
  })
})
