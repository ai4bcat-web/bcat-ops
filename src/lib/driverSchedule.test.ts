import { describe, it, expect } from 'vitest'
import { ivanDaySchedule, ownerOperatorWeek, stopState, loadState } from './driverSchedule'
import type { Load } from '@/types'

const stop = (over: Record<string, unknown>) => ({ id: Math.random().toString(), type: 'pickup', sequence: 0, driverId: 'd1', appt: '2026-10-11T14:00:00Z', ...over })
const load = (id: string, stops: unknown[], over: Record<string, unknown> = {}) => ({ id, aljexId: id, pickupDriverId: 'd1', stops, ...over } as unknown as Load)

describe('stopState / loadState', () => {
  it('reads done, on site, upcoming', () => {
    expect(stopState({ departedAt: 'x' })).toBe('DONE')
    expect(stopState({ arrivedAt: 'x', departedAt: null })).toBe('IN_PROGRESS')
    expect(stopState({})).toBe('UPCOMING')
  })
  it('calls a shipment complete when its last delivery is departed', () => {
    expect(loadState(load('a', [stop({ departedAt: 'x' }), stop({ type: 'delivery', sequence: 1, departedAt: 'y' })]))).toBe('COMPLETED')
    expect(loadState(load('b', [stop({ departedAt: 'x' }), stop({ type: 'delivery', sequence: 1 })]))).toBe('IN_PROGRESS')
    expect(loadState(load('c', [stop({}), stop({ type: 'delivery', sequence: 1 })]))).toBe('UPCOMING')
  })
})

describe('ivanDaySchedule', () => {
  it('lists today’s stops for the driver in order with progress', () => {
    const loads = [
      load('14578', [stop({ appt: '2026-10-11T13:00:00Z', departedAt: '2026-10-11T13:40:00Z' }), stop({ type: 'delivery', sequence: 1, appt: '2026-10-11T18:00:00Z', arrivedAt: '2026-10-11T17:50:00Z' })]),
      load('14579', [stop({ appt: '2026-10-11T20:00:00Z' })]),
      load('14580', [stop({ appt: '2026-10-12T13:00:00Z' })]),                       // tomorrow
      load('14581', [stop({ appt: '2026-10-11T15:00:00Z', driverId: 'd2' })]),       // someone else
    ]
    const d = ivanDaySchedule(loads, 'd1', '2026-10-11')
    expect(d.stops.map((s) => [s.load.aljexId, s.state])).toEqual([['14578', 'DONE'], ['14578', 'IN_PROGRESS'], ['14579', 'UPCOMING']])
    expect([d.done, d.inProgress, d.total]).toEqual([1, 1, 3])
  })
})

describe('ownerOperatorWeek', () => {
  it('lists the week’s shipments with their state', () => {
    const loads = [
      load('1', [stop({ appt: '2026-10-12T13:00:00Z', departedAt: 'x' }), stop({ type: 'delivery', sequence: 1, appt: '2026-10-13T13:00:00Z', departedAt: 'y' })]),
      load('2', [stop({ appt: '2026-10-14T13:00:00Z', arrivedAt: 'x' }), stop({ type: 'delivery', sequence: 1, appt: '2026-10-15T13:00:00Z' })]),
      load('3', [stop({ appt: '2026-10-17T13:00:00Z' }), stop({ type: 'delivery', sequence: 1, appt: '2026-10-19T13:00:00Z' })]),   // starts Saturday: in
      load('4', [stop({ appt: '2026-10-19T13:00:00Z' })]),                                                                           // next week
      load('5', [stop({ appt: '2026-10-12T13:00:00Z', driverId: 'd2' })], { pickupDriverId: 'd2' }),                               // not theirs
    ]
    // d1 is on the stops of loads 1-3 (stop.driverId), and pickupDriverId mirrors it.
    const w = ownerOperatorWeek(loads, 'd1', '2026-10-11')
    expect(w.loads.map((l) => [l.load.aljexId, l.state])).toEqual([['1', 'COMPLETED'], ['2', 'IN_PROGRESS'], ['3', 'UPCOMING']])
    expect([w.completed, w.inProgress, w.upcoming]).toEqual([1, 1, 1])
    expect(w.loads[1].stopsDone).toBe(0)
  })
})
