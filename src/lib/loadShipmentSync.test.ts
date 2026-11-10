import { describe, expect, it } from 'vitest'
import { apptChangesOfWrite, changedApptStops, changedStopDrivers, driverChangesOfWrite, loadWideDriverChange, takesRosterDriver } from './loadShipmentSync'
import type { Stop } from '@/types'

const stop = (id: string, appt: string, extra: Partial<Stop> = {}): Stop => ({ id, sequence: 0, type: 'pickup', appt, ...extra }) as Stop

describe('changedApptStops', () => {
  it('lists only stops whose appointment start, end or type changed', () => {
    const before = [stop('a', '2026-11-10T10:00:00Z'), stop('b', '2026-11-11T10:00:00Z', { apptType: 'exact' }), stop('c', '2026-11-12T10:00:00Z')]
    const next = [stop('a', '2026-11-10T12:00:00Z'), stop('b', '2026-11-11T10:00:00Z', { apptType: 'range' }), stop('c', '2026-11-12T10:00:00Z'), stop('d', '2026-11-13T10:00:00Z')]
    expect(changedApptStops(before, next).map((c) => c.stopId)).toEqual(['a', 'b'])
    expect(changedApptStops(before, undefined)).toEqual([])
  })
})

describe('loadWideDriverChange', () => {
  it('reports a new driver on the whole load, nothing when unchanged or split', () => {
    expect(loadWideDriverChange({ pickupDriverId: null, deliveryDriverId: null }, { pickupDriverId: 'd1', deliveryDriverId: 'd1' })).toBe('d1')
    expect(loadWideDriverChange({ pickupDriverId: 'd1', deliveryDriverId: 'd1' }, { pickupDriverId: 'd1', deliveryDriverId: 'd1' })).toBeNull()
    expect(loadWideDriverChange({}, { pickupDriverId: 'd1', deliveryDriverId: 'd2' })).toBeNull()
    expect(loadWideDriverChange({ pickupDriverId: 'd1' }, { pickupDriverId: null, deliveryDriverId: null })).toBeNull()
  })
})

describe('takesRosterDriver', () => {
  it('is for own-fleet and unassigned loads, not a brokered carrier load', () => {
    expect(takesRosterDriver({ assignmentType: 'OWN_ASSET' })).toBe(true)
    expect(takesRosterDriver({ assignmentType: 'NEED_TO_COVER' })).toBe(true)
    expect(takesRosterDriver({})).toBe(true)
    expect(takesRosterDriver({ assignmentType: 'CARRIER' })).toBe(false)
  })
})

describe('changedStopDrivers', () => {
  const stop = (id: string, driverId: string | null) => ({ id, driverId } as never)
  it('reports a driver put on, changed or taken off, and ignores new stops and unchanged ones', () => {
    const before = [stop('a', null), stop('b', 'd1'), stop('c', 'd2')]
    const next = [stop('a', 'd9'), stop('b', null), stop('c', 'd2'), stop('new', 'd3')]
    expect(changedStopDrivers(before, next)).toEqual([{ stopId: 'a', driverId: 'd9' }, { stopId: 'b', driverId: null }])
    expect(changedStopDrivers(before, null)).toEqual([])
  })
})

describe('driverChangesOfWrite', () => {
  const stop = (id: string, type: 'pickup' | 'delivery', sequence: number, driverId: string | null) => ({ id, type, sequence, driverId } as never)
  const stops = [stop('pu', 'pickup', 0, null), stop('de', 'delivery', 1, 'd1')]
  it('reads a mirror-only write onto the first pickup and the last delivery', () => {
    expect(driverChangesOfWrite(stops, { pickupDriverId: 'd2', deliveryDriverId: 'd1' })).toEqual([{ stopId: 'pu', driverId: 'd2' }])
    expect(driverChangesOfWrite(stops, { pickupDriverId: null, deliveryDriverId: null })).toEqual([{ stopId: 'de', driverId: null }])
  })
  it('reads a stops write by the stops themselves', () => {
    expect(driverChangesOfWrite(stops, { stops: [stop('pu', 'pickup', 0, 'd3'), stop('de', 'delivery', 1, 'd1')] } as never)).toEqual([{ stopId: 'pu', driverId: 'd3' }])
  })
})

describe('apptChangesOfWrite', () => {
  const stops = [
    { id: 'a', sequence: 0, type: 'pickup', appt: '2026-11-12T14:00:00.000Z', apptType: 'exact' },
    { id: 'b', sequence: 1, type: 'delivery', appt: '2026-11-12T22:00:00.000Z', apptType: 'exact' },
  ] as Stop[]

  it('a write of only the pickup/delivery mirrors (the calendar date editor) lands on the first pickup and last delivery', () => {
    expect(apptChangesOfWrite(stops, { pickupAppt: '2026-11-13T15:00:00.000Z' } as never)).toEqual([{ stopId: 'a', appt: '2026-11-13T15:00:00.000Z', apptEnd: null, apptType: 'exact' }])
    expect(apptChangesOfWrite(stops, { deliveryAppt: '2026-11-13T20:00:00.000Z', deliveryApptType: 'fcfs' } as never)).toEqual([{ stopId: 'b', appt: '2026-11-13T20:00:00.000Z', apptEnd: null, apptType: 'fcfs' }])
  })

  it('a changed type or window end alone counts, and an unchanged value is not a change', () => {
    expect(apptChangesOfWrite(stops, { pickupApptType: 'range', pickupApptEnd: '2026-11-12T18:00:00.000Z' } as never)).toEqual([{ stopId: 'a', appt: '2026-11-12T14:00:00.000Z', apptEnd: '2026-11-12T18:00:00.000Z', apptType: 'range' }])
    expect(apptChangesOfWrite(stops, { pickupAppt: '2026-11-12T14:00:00.000Z' } as never)).toEqual([])
  })

  it('with a stops array it is the stop-by-stop diff', () => {
    expect(apptChangesOfWrite(stops, { stops: [{ ...stops[0], appt: '2026-11-14T14:00:00.000Z' }, stops[1]] } as never).map((c) => c.stopId)).toEqual(['a'])
  })
})
