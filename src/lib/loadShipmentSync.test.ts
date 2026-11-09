import { describe, expect, it } from 'vitest'
import { changedApptStops, loadWideDriverChange, takesRosterDriver } from './loadShipmentSync'
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
