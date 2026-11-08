import { describe, it, expect } from 'vitest'
import {
  checkCallState,
  incidentChargeLines,
  nextCheckCallDefault,
  stampStopEvent,
  statusAfterCheckCall,
  stopEventId,
  sweepCheckCalls,
} from './checkCalls'
import type { CheckCallSweepLoad } from './checkCalls'
import type { Stop, StopType } from '../types'

const MINUTE = 60_000

function stop(id: string, type: StopType, sequence: number, times: Partial<Stop> = {}): Stop {
  return { id, type, sequence, appt: '2026-03-02T12:00:00.000Z', driverId: null, ...times }
}

/** Pickup, intermediate delivery, intermediate pickup, final delivery. */
function multiStop(times: Record<string, Partial<Stop>> = {}): Stop[] {
  return [
    stop('pu1', 'pickup', 0, times.pu1),
    stop('de1', 'delivery', 1, times.de1),
    stop('pu2', 'pickup', 2, times.pu2),
    stop('de2', 'delivery', 3, times.de2),
  ]
}

describe('stopEventId', () => {
  it('derives the same id for the same stamp, whoever reports it', () => {
    expect(stopEventId('load-1', 'stop-7', 'ARRIVED')).toBe('evt:load-1:stop-7:ARRIVED')
    expect(stopEventId('load-1', 'stop-7', 'DEPARTED')).toBe('evt:load-1:stop-7:DEPARTED')
  })
})

describe('stampStopEvent', () => {
  it('stamps a blank time and says so', () => {
    const stops = multiStop()
    const result = stampStopEvent(stops, 'pu1', 'ARRIVED', '2026-03-02T11:40:00.000Z')
    expect(result.stamped).toBe(true)
    expect(result.stops[0].arrivedAt).toBe('2026-03-02T11:40:00.000Z')
    expect(stops[0].arrivedAt).toBeUndefined()
  })

  it('never overwrites a time somebody already reported', () => {
    const stops = multiStop({ pu1: { arrivedAt: '2026-03-02T11:00:00.000Z' } })
    const result = stampStopEvent(stops, 'pu1', 'ARRIVED', '2026-03-02T11:40:00.000Z')
    expect(result.stamped).toBe(false)
    expect(result.stops[0].arrivedAt).toBe('2026-03-02T11:00:00.000Z')
  })

  it('stamps nothing for a stop that is not on the load', () => {
    const result = stampStopEvent(multiStop(), 'gone', 'DEPARTED', '2026-03-02T11:40:00.000Z')
    expect(result.stamped).toBe(false)
  })
})

describe('statusAfterCheckCall', () => {
  it('climbs the ladder from the first pickup and the last delivery', () => {
    expect(statusAfterCheckCall(multiStop({ pu1: { arrivedAt: '2026-03-02T11:00:00.000Z' } }), 'DISPATCHED')).toBe('LOADING')
    expect(statusAfterCheckCall(multiStop({ pu1: { arrivedAt: '2026-03-02T11:00:00.000Z', departedAt: '2026-03-02T13:00:00.000Z' } }), 'LOADING')).toBe('IN_TRANSIT')
    expect(statusAfterCheckCall(multiStop({ de2: { arrivedAt: '2026-03-03T09:00:00.000Z' } }), 'IN_TRANSIT')).toBe('UNLOADING')
    expect(statusAfterCheckCall(multiStop({ de2: { arrivedAt: '2026-03-03T09:00:00.000Z', departedAt: '2026-03-03T11:00:00.000Z' } }), 'UNLOADING')).toBe('DELIVERED')
  })

  it('leaves the status alone for an intermediate stop', () => {
    const stops = multiStop({
      de1: { arrivedAt: '2026-03-02T18:00:00.000Z', departedAt: '2026-03-02T19:00:00.000Z' },
      pu2: { arrivedAt: '2026-03-02T20:00:00.000Z', departedAt: '2026-03-02T21:00:00.000Z' },
    })
    expect(statusAfterCheckCall(stops, 'IN_TRANSIT')).toBeNull()
  })

  it('never moves backwards', () => {
    const stops = multiStop({ pu1: { arrivedAt: '2026-03-02T11:00:00.000Z' } })
    expect(statusAfterCheckCall(stops, 'DELIVERED')).toBeNull()
  })

  it('leaves a canceled load canceled', () => {
    const stops = multiStop({
      pu1: { arrivedAt: '2026-03-02T11:00:00.000Z', departedAt: '2026-03-02T13:00:00.000Z' },
      de2: { arrivedAt: '2026-03-03T09:00:00.000Z', departedAt: '2026-03-03T11:00:00.000Z' },
    })
    expect(statusAfterCheckCall(stops, 'CANCELED')).toBeNull()
  })
})

describe('nextCheckCallDefault', () => {
  it('schedules the interval ahead, four hours by default', () => {
    expect(nextCheckCallDefault('2026-03-02T08:00:00.000Z')).toBe('2026-03-02T12:00:00.000Z')
    expect(nextCheckCallDefault('2026-03-02T08:00:00.000Z', 6)).toBe('2026-03-02T14:00:00.000Z')
  })
})

describe('checkCallState', () => {
  const due = Date.parse('2026-03-02T12:00:00.000Z')
  const load = { nextCheckCallAt: '2026-03-02T12:00:00.000Z' }

  it('is NONE without a reminder', () => {
    expect(checkCallState({}, due, 15)).toBe('NONE')
    expect(checkCallState({ nextCheckCallAt: null }, due, 15)).toBe('NONE')
  })

  it('is SCHEDULED right up to the due time', () => {
    expect(checkCallState(load, due - 1, 15)).toBe('SCHEDULED')
  })

  it('is DUE on the due time and through the grace', () => {
    expect(checkCallState(load, due, 15)).toBe('DUE')
    expect(checkCallState(load, due + 15 * MINUTE - 1, 15)).toBe('DUE')
  })

  it('is OVERDUE the moment the grace is spent', () => {
    expect(checkCallState(load, due + 15 * MINUTE, 15)).toBe('OVERDUE')
    expect(checkCallState(load, due, 0)).toBe('OVERDUE')
  })
})

describe('sweepCheckCalls', () => {
  const due = '2026-03-02T12:00:00.000Z'
  const now = Date.parse('2026-03-02T12:10:00.000Z')
  const base: CheckCallSweepLoad = { id: 'load-1', nextCheckCallAt: due, carrierRepId: 'rep@example.com' }

  it('reports the loads that need a nudge, and how late they are', () => {
    expect(sweepCheckCalls([base], now, 15)).toEqual([
      { loadId: 'load-1', state: 'DUE', carrierRepId: 'rep@example.com', minutesLate: 10 },
    ])
  })

  it('leaves alone the loads with nothing scheduled or not yet due', () => {
    const rows = sweepCheckCalls(
      [{ id: 'a' }, { id: 'b', nextCheckCallAt: '2026-03-02T16:00:00.000Z' }],
      now,
      15,
    )
    expect(rows).toEqual([])
  })

  it('does not notify twice for the same schedule', () => {
    const notified = { ...base, checkCallDueNotifiedAt: '2026-03-02T12:05:00.000Z' }
    expect(sweepCheckCalls([notified], now, 15)).toEqual([])
  })

  it('re-arms when the check call is rescheduled', () => {
    const rescheduled: CheckCallSweepLoad = {
      ...base,
      checkCallDueNotifiedAt: '2026-03-02T12:05:00.000Z',
      nextCheckCallAt: '2026-03-02T12:06:00.000Z',
    }
    expect(sweepCheckCalls([rescheduled], now, 15).map((r) => r.state)).toEqual(['DUE'])
  })

  it('still reports a load that went overdue after its due notice', () => {
    const notified = { ...base, checkCallDueNotifiedAt: '2026-03-02T12:05:00.000Z' }
    const later = Date.parse('2026-03-02T12:20:00.000Z')
    expect(sweepCheckCalls([notified], later, 15)).toEqual([
      { loadId: 'load-1', state: 'OVERDUE', carrierRepId: 'rep@example.com', minutesLate: 20 },
    ])
  })
})

describe('incidentChargeLines', () => {
  const ctx = {
    orderId: 'order-1',
    loadId: 'load-1',
    loadCarrierId: 'lc-1',
    codes: [{ code: 'DET', label: 'Detention', calculatedBy: 'FLAT' as const }],
  }

  it('bills the customer and pays the carrier from one BOTH line', () => {
    const lines = incidentChargeLines({
      ...ctx,
      charges: [{ side: 'BOTH', code: 'det', rateCents: 7500, count: 2 }],
    })
    expect(lines.map((l) => l.side)).toEqual(['CUSTOMER', 'CARRIER'])
    expect(lines.every((l) => l.code === 'DET' && l.label === 'Detention')).toBe(true)
    expect(lines.every((l) => l.calculatedBy === 'FLAT' && !l.isRate)).toBe(true)
    expect(lines.map((l) => l.amountCents)).toEqual([15000, 15000])
    expect(lines.map((l) => l.loadCarrierId)).toEqual([null, 'lc-1'])
  })

  it('appends after the charges already on the shipment', () => {
    const lines = incidentChargeLines({
      ...ctx,
      existing: [{ sortOrder: 0 }, { sortOrder: 4 }, { sortOrder: 2 }],
      charges: [{ side: 'BOTH', code: 'DET', rateCents: 5000 }],
    })
    expect(lines.map((l) => l.sortOrder)).toEqual([5, 6])
  })

  it('refuses to charge a carrier that is not on the load', () => {
    expect(() =>
      incidentChargeLines({
        ...ctx,
        loadCarrierId: null,
        charges: [{ side: 'CARRIER', code: 'DET', rateCents: 5000 }],
      }),
    ).toThrow(/active carrier/i)
  })

  it('refuses a negative carrier charge', () => {
    expect(() =>
      incidentChargeLines({ ...ctx, charges: [{ side: 'CARRIER', code: 'DET', rateCents: -5000 }] }),
    ).toThrow(/cannot be negative/i)
  })
})
