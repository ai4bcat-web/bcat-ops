import { describe, expect, it } from 'vitest'
import { departedLabel, stopTimesOf } from './stopActualTimes'
import { applyStopEvent } from './stopEvents'
import { stampStopEvent } from './checkCalls'
import type { Stop } from '../types'

const stop = (over: Partial<Stop>): Stop => ({ id: 's', type: 'pickup', appt: '', driverId: null, sequence: 0, ...over }) as Stop

describe('stopTimesOf', () => {
  it('lists every stop in route order with its times and sources; the last delivery is the final one', () => {
    const out = stopTimesOf({ loads: [{ id: 'l1', stops: [
      stop({ id: 'd', type: 'delivery', sequence: 1, arrivedAt: '2026-11-10T19:00:00Z', arrivedSource: 'DRIVER_APP' }),
      stop({ id: 'p', type: 'pickup', sequence: 0, arrivedAt: '2026-11-10T13:00:00Z', arrivedSource: 'MANUAL', departedAt: '2026-11-10T14:00:00Z' }),
    ] }] })
    expect(out.map((t) => t.stopId)).toEqual(['p', 'd'])
    expect(out[0]).toMatchObject({ arrivedSource: 'MANUAL', departedAt: '2026-11-10T14:00:00Z', departedSource: null, isFinalDelivery: false })
    expect(out[1]).toMatchObject({ arrivedSource: 'DRIVER_APP', departedAt: null, isFinalDelivery: true })
    expect(departedLabel(out[1]!)).toBe('Delivered')
    expect(departedLabel(out[0]!)).toBe('Departed')
  })
  it('has no source for a time that is not there, and handles an empty bundle', () => {
    expect(stopTimesOf(null)).toEqual([])
    expect(stopTimesOf({ loads: [{ id: 'l', stops: [stop({ arrivedSource: 'MANUAL' })] }] })[0]).toMatchObject({ arrivedAt: null, arrivedSource: null })
  })
})

describe('a manual time wins over ingest', () => {
  const manual = [stop({ arrivedAt: '2026-11-10T13:00:00Z', arrivedSource: 'MANUAL' })]
  it('the driver app tap does not overwrite a manual time, but does fill an empty or non-manual one', () => {
    expect(applyStopEvent(manual, 's', 'ARRIVED', '2026-11-10T13:30:00Z')[0]).toMatchObject({ arrivedAt: '2026-11-10T13:00:00Z', arrivedSource: 'MANUAL' })
    expect(applyStopEvent([stop({})], 's', 'ARRIVED', '2026-11-10T13:30:00Z')[0]).toMatchObject({ arrivedAt: '2026-11-10T13:30:00Z', arrivedSource: 'DRIVER_APP' })
    const prior = [stop({ arrivedAt: '2026-11-10T13:00:00Z', arrivedSource: 'TRACKING_LINK' })]
    expect(applyStopEvent(prior, 's', 'ARRIVED', '2026-11-10T13:30:00Z')[0]).toMatchObject({ arrivedAt: '2026-11-10T13:30:00Z', arrivedSource: 'DRIVER_APP' })
  })
  it('a tracking-link check call never overwrites any existing time and records its own source on an empty one', () => {
    expect(stampStopEvent(manual, 's', 'ARRIVED', '2026-11-10T13:30:00Z', 'TRACKING_LINK').stamped).toBe(false)
    const r = stampStopEvent([stop({})], 's', 'DEPARTED', '2026-11-10T14:30:00Z', 'TRACKING_LINK')
    expect(r.stops[0]).toMatchObject({ departedAt: '2026-11-10T14:30:00Z', departedSource: 'TRACKING_LINK' })
  })
})
