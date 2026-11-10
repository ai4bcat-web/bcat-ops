import { describe, it, expect } from 'vitest'
import type { Load, Driver, Stop } from '@/types'
import { stopsForDriverOnDay, buildStopSmsText, loadsForDriverOnDay } from './sms'

function mkLoad(over: Partial<Load> = {}): Load {
  return {
    id: 'L1', aljexId: 'A-1', tmsId: 'T-1', pickupNumber: 'PU-1',
    pickupAppt: '2026-06-15T13:00:00Z', pickupApptType: 'exact',
    deliveryAppt: '2026-06-15T20:00:00Z', deliveryApptType: 'exact',
    originName: 'Shipper', originCity: 'Chicago, IL',
    destinationName: 'Consignee', destinationCity: 'Columbus, OH',
    pickupDriverId: 'drvA', deliveryDriverId: 'drvB',
    readyToInvoice: false,
    createdAt: '', updatedAt: '', createdBy: 'x', updatedBy: 'x',
    ...over,
  }
}

const driver = (id: string, name: string): Driver => ({ id, name, active: true } as Driver)

// 3-stop load on 2026-06-15: PU(drvA) → DE(drvB, middle) → DE(drvC).
const stops: Stop[] = [
  { id: 's0', type: 'pickup',   name: 'PU A', city: 'Chicago, IL',      appt: '2026-06-15T13:00:00Z', apptType: 'exact', driverId: 'drvA', sequence: 0 },
  { id: 's1', type: 'delivery', name: 'DE B', city: 'Indianapolis, IN', appt: '2026-06-15T16:00:00Z', apptType: 'exact', driverId: 'drvB', sequence: 1 },
  { id: 's2', type: 'delivery', name: 'DE C', city: 'Columbus, OH',     appt: '2026-06-15T20:00:00Z', apptType: 'exact', driverId: 'drvC', sequence: 2 },
]

describe('stopsForDriverOnDay (per-stop SMS selection)', () => {
  it('gives a middle-delivery driver ONLY their stop, not the whole load', () => {
    const load = mkLoad({ stops })
    const forB = stopsForDriverOnDay([load], 'drvB', '2026-06-15')
    expect(forB).toHaveLength(1)
    expect(forB[0].stop.id).toBe('s1')
    expect(forB[0].stop.type).toBe('delivery')
  })

  it('selects only the stops on the requested day', () => {
    const load = mkLoad({ stops: stops.map((s, i) => i === 2 ? { ...s, appt: '2026-06-16T20:00:00Z' } : s) })
    expect(stopsForDriverOnDay([load], 'drvC', '2026-06-15')).toHaveLength(0)
    expect(stopsForDriverOnDay([load], 'drvC', '2026-06-16')).toHaveLength(1)
  })

  it('run sheet: the load is on the sheet of every driver who has a stop of it that day (pickup driver and delivery driver of a split load)', () => {
    const load = mkLoad()
    expect(loadsForDriverOnDay([load], 'drvA', '2026-06-15')).toHaveLength(1)
    expect(loadsForDriverOnDay([load], 'drvB', '2026-06-15')).toHaveLength(1)
    expect(loadsForDriverOnDay([load], 'drvB', '2026-06-16')).toHaveLength(0)
    expect(loadsForDriverOnDay([load], 'drvZ', '2026-06-15')).toHaveLength(0)
  })

  it('a load that starts at the yard (no pickup appointment) is still on the driver\'s sheet for the day it delivers, and one assigned only on its stops is found', () => {
    const yard = mkLoad({ id: 'L2', pickupAppt: '', pickupDriverId: 'drvA', deliveryDriverId: 'drvA', deliveryAppt: '2026-11-11T14:00:00Z' })
    expect(loadsForDriverOnDay([yard], 'drvA', '2026-11-11').map((l) => l.id)).toEqual(['L2'])
    const stopOnly = mkLoad({ id: 'L3', pickupDriverId: null, deliveryDriverId: null, stops: stops.map((s) => ({ ...s, appt: s.appt.replace('2026-06-15', '2026-11-11') })) })
    expect(loadsForDriverOnDay([stopOnly], 'drvC', '2026-11-11').map((l) => l.id)).toEqual(['L3'])
  })

  it('sorts by the driver\'s first appointment of the day', () => {
    const late = mkLoad({ id: 'late', pickupAppt: '2026-11-11T20:00:00Z', pickupDriverId: 'drvA', deliveryDriverId: null, deliveryAppt: '2026-11-12T20:00:00Z' })
    const early = mkLoad({ id: 'early', pickupAppt: '2026-11-11T13:00:00Z', pickupDriverId: 'drvA', deliveryDriverId: null, deliveryAppt: '2026-11-12T20:00:00Z' })
    expect(loadsForDriverOnDay([late, early], 'drvA', '2026-11-11').map((l) => l.id)).toEqual(['early', 'late'])
  })
})

describe('buildStopSmsText', () => {
  it('phrases a pickup-only stop as a pickup', () => {
    const sms = buildStopSmsText(driver('drvA', 'Alex Smith'), stopsForDriverOnDay([mkLoad({ stops })], 'drvA', '2026-06-15'), '2026-06-15')
    expect(sms).toContain('Hi Alex!')
    expect(sms).toContain('1 stop today')
    expect(sms).toMatch(/First, pick up at PU A in Chicago, IL at .+ \(Load: A-1, PU#: PU-1\)\./)
    expect(sms).not.toContain('deliver to')
  })

  it('phrases a delivery-only stop as a delivery (no PU# noise)', () => {
    const sms = buildStopSmsText(driver('drvB', 'Bo Jones'), stopsForDriverOnDay([mkLoad({ stops })], 'drvB', '2026-06-15'), '2026-06-15')
    expect(sms).toMatch(/First, deliver to DE B in Indianapolis, IN by .+ \(Load: A-1\)\./)
    expect(sms).not.toContain('pick up at')
    expect(sms).not.toContain('PU#')
  })

  it('empty schedule yields the no-stops message', () => {
    expect(buildStopSmsText(driver('drvX', 'Xander Poe'), [], '2026-06-15')).toContain('No stops scheduled')
  })
})
