import { describe, it, expect } from 'vitest'
import {
  applyStopEvent, estimateEta, delivererOf, nextDeliveryAfter, planDeliveryEta, withEta,
  ETA_MIN_MINUTES,
} from './stopEvents'
import type { Load, Stop } from '../types'

const ME = 'drv-jason'
const OTHER = 'drv-chuck'

const stop = (over: Partial<Stop> & { id: string; type: Stop['type']; sequence: number }): Stop =>
  ({ appt: '2026-10-08T17:00:00.000Z', driverId: null, ...over } as Stop)

/** A load picking up this morning (Chicago) with the delivery at `deliveryAppt`. */
function load(deliveryAppt: string, deliveryDriver: string | null = ME, pickupDriver: string | null = ME): { load: Load; stops: Stop[] } {
  const stops = [
    stop({ id: 'pu', type: 'pickup', sequence: 0, appt: '2026-10-08T13:00:00.000Z', driverId: pickupDriver }),
    stop({ id: 'de', type: 'delivery', sequence: 1, appt: deliveryAppt, driverId: deliveryDriver }),
  ]
  return { load: { id: 'L', stops, pickupDriverId: null, deliveryDriverId: null } as unknown as Load, stops }
}

const NOW = '2026-10-08T15:30:00.000Z' // 10:30 am Chicago, 8 Oct

describe('applyStopEvent', () => {
  it('stamps arrival and departure on the one stop', () => {
    const { stops } = load('2026-10-08T20:00:00.000Z')
    const arrived = applyStopEvent(stops, 'pu', 'ARRIVED', NOW)
    expect(arrived[0].arrivedAt).toBe(NOW)
    expect(arrived[1].arrivedAt).toBeUndefined()
    const departed = applyStopEvent(arrived, 'pu', 'DEPARTED', '2026-10-08T16:00:00.000Z')
    expect(departed[0]).toMatchObject({ arrivedAt: NOW, departedAt: '2026-10-08T16:00:00.000Z' })
  })

  it('a departure does not invent an arrival time', () => {
    const { stops } = load('2026-10-08T20:00:00.000Z')
    expect(applyStopEvent(stops, 'pu', 'DEPARTED', NOW)[0].arrivedAt).toBeUndefined()
  })
})

describe('estimateEta', () => {
  it('runs the road distance at local speed from the departure time', () => {
    // Pleasant Prairie → Waukegan is ~11 air miles: ×1.3 road / 38 mph ≈ 23 minutes.
    const eta = estimateEta({ lat: 42.5185, lng: -87.9149 }, { lat: 42.3636, lng: -87.8448 }, NOW)
    const minutes = (Date.parse(eta) - Date.parse(NOW)) / 60_000
    expect(minutes).toBeGreaterThan(20)
    expect(minutes).toBeLessThan(28)
  })

  it('never promises less than the floor', () => {
    const eta = estimateEta({ lat: 42.5, lng: -87.9 }, { lat: 42.5, lng: -87.9 }, NOW)
    expect((Date.parse(eta) - Date.parse(NOW)) / 60_000).toBe(ETA_MIN_MINUTES)
  })
})

describe('who delivers', () => {
  it("reads the delivery stop's driver, then the legacy field, then the only driver on the load", () => {
    const a = load('2026-10-08T20:00:00.000Z', OTHER)
    expect(delivererOf(a.load, a.stops, a.stops[1])).toBe(OTHER)
    const b = load('2026-10-08T20:00:00.000Z', null)
    expect(delivererOf({ ...b.load, deliveryDriverId: OTHER } as Load, b.stops, b.stops[1])).toBe(OTHER)
    expect(delivererOf(b.load, b.stops, b.stops[1])).toBe(ME) // only Jason is on the load
    const c = load('2026-10-08T20:00:00.000Z', null, null)
    expect(delivererOf(c.load, c.stops, c.stops[1])).toBeNull()
  })

  it('finds the next undelivered delivery after the pickup', () => {
    const { stops } = load('2026-10-08T20:00:00.000Z')
    expect(nextDeliveryAfter(stops, stops[0])?.id).toBe('de')
    expect(nextDeliveryAfter(applyStopEvent(stops, 'de', 'DEPARTED', NOW), stops[0])).toBeNull()
  })
})

describe('planDeliveryEta — whose ETA, from what', () => {
  it('same driver delivering today: from the truck (Motive)', () => {
    const { load: l, stops } = load('2026-10-08T20:00:00.000Z', ME)
    expect(planDeliveryEta(l, stops, stops[0], ME, NOW)).toMatchObject({ kind: 'motive', stop: { id: 'de' } })
  })

  it('a different driver delivering today or tomorrow: the appointment time', () => {
    const today = load('2026-10-08T20:00:00.000Z', OTHER)
    expect(planDeliveryEta(today.load, today.stops, today.stops[0], ME, NOW).kind).toBe('appt')
    const tomorrow = load('2026-10-09T13:00:00.000Z', OTHER)
    expect(planDeliveryEta(tomorrow.load, tomorrow.stops, tomorrow.stops[0], ME, NOW).kind).toBe('appt')
  })

  it('the same driver delivering tomorrow is also the appointment — nobody is rolling to it today', () => {
    const { load: l, stops } = load('2026-10-09T13:00:00.000Z', ME)
    expect(planDeliveryEta(l, stops, stops[0], ME, NOW).kind).toBe('appt')
  })

  it('a delivery later than tomorrow gets no estimate', () => {
    const { load: l, stops } = load('2026-10-10T13:00:00.000Z', OTHER)
    expect(planDeliveryEta(l, stops, stops[0], ME, NOW)).toMatchObject({ kind: 'none' })
  })

  it('judges today on the Chicago calendar, like the appointments', () => {
    // 11pm Chicago on the 8th is 04:00Z on the 9th; a delivery at 02:00Z on the 9th (9pm the 8th) is still today.
    const { load: l, stops } = load('2026-10-09T02:00:00.000Z', ME)
    expect(planDeliveryEta(l, stops, stops[0], ME, '2026-10-09T03:30:00.000Z').kind).toBe('motive')
  })
})

describe('withEta', () => {
  it('stamps the estimate and its basis on the one stop', () => {
    const { stops } = load('2026-10-08T20:00:00.000Z')
    const out = withEta(stops, 'de', '2026-10-08T16:05:00.000Z', 'motive', NOW)
    expect(out[1]).toMatchObject({ etaAt: '2026-10-08T16:05:00.000Z', etaBasis: 'motive', etaUpdatedAt: NOW })
    expect(out[0].etaAt).toBeUndefined()
  })
})
