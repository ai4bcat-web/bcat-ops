import { describe, it, expect } from 'vitest'
import { apptQueue, apptNeedKind, apptQueueCount, splitApptQueue } from './apptQueue'
import { fromDateInput, fromDateTimeInput } from './date'
import type { ApptType, Load, Stop } from '@/types'

const stop = (over: Partial<Stop> = {}): Stop => ({
  id: 's1', type: 'pickup', appt: fromDateTimeInput('2026-08-20T09:00'),
  apptType: 'exact', driverId: null, sequence: 0, ...over,
})

const load = (over: Partial<Load> = {}): Load => ({
  id: 'l1', aljexId: '12345', tmsId: 'T1', pickupNumber: 'PU-1',
  pickupAppt: fromDateTimeInput('2026-08-20T09:00'),
  deliveryAppt: fromDateTimeInput('2026-08-21T09:00'),
  readyToInvoice: false, createdBy: '', updatedBy: '',
  createdAt: '', updatedAt: '',
  ...over,
} as Load)

describe('apptNeedKind', () => {
  it('flags an explicit NEED', () => {
    expect(apptNeedKind(stop({ apptType: 'tbd' }))).toBe('need')
  })

  it('flags an appointment with no time set as pending', () => {
    expect(apptNeedKind(stop({ appt: fromDateInput('2026-08-20') }))).toBe('pending')
  })

  it('treats a legacy stop with no apptType the same as exact', () => {
    const legacy = { ...stop({ appt: fromDateInput('2026-08-20') }), apptType: undefined }
    expect(apptNeedKind(legacy as Stop)).toBe('pending')
  })

  it('leaves a booked time alone', () => {
    expect(apptNeedKind(stop())).toBeNull()
  })

  it('leaves FCFS and range alone — neither needs a call', () => {
    // FCFS: any arrival time works. Range: a window is already agreed.
    expect(apptNeedKind(stop({ apptType: 'fcfs', appt: fromDateInput('2026-08-20') }))).toBeNull()
    expect(apptNeedKind(stop({
      apptType: 'range' as ApptType,
      apptEnd: fromDateTimeInput('2026-08-20T12:00'),
    }))).toBeNull()
  })
})

describe('apptQueue', () => {
  it('is empty when every appointment is booked', () => {
    expect(apptQueue([load({ stops: [stop(), stop({ id: 's2', type: 'delivery' })] })])).toEqual([])
  })

  it('picks up both stops of a load independently', () => {
    const rows = apptQueue([load({ stops: [
      stop({ id: 's1', apptType: 'tbd' }),
      stop({ id: 's2', type: 'delivery', apptType: 'tbd' }),
    ] })])
    expect(rows.map((r) => r.stopType)).toEqual(['pickup', 'delivery'])
  })

  it('carries the load reference a dispatcher needs to make the call', () => {
    const [row] = apptQueue([load({
      customer: 'Acme Freight',
      stops: [stop({ apptType: 'tbd', name: 'Dock 4', city: 'Joliet, IL' })],
    })])
    expect(row).toMatchObject({
      loadId: 'l1', aljexId: '12345', pickupNumber: 'PU-1',
      customer: 'Acme Freight', location: 'Dock 4, Joliet, IL',
    })
  })

  it('puts explicit NEED above pending', () => {
    const rows = apptQueue([
      load({ id: 'l1', stops: [stop({ appt: fromDateInput('2026-08-01') })] }),           // pending, earlier
      load({ id: 'l2', stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-09-01') })] }), // need, later
    ])
    expect(rows.map((r) => r.kind)).toEqual(['need', 'pending'])
  })

  it('sorts soonest first within a group, so an overdue stop is at the top', () => {
    const rows = apptQueue([
      load({ id: 'l1', stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-09-10') })] }),
      load({ id: 'l2', stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-07-01') })] }),
      load({ id: 'l3', stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-08-15') })] }),
    ])
    expect(rows.map((r) => r.loadId)).toEqual(['l2', 'l3', 'l1'])
  })

  it('pushes a stop with no date at all to the end — no urgency signal', () => {
    const rows = apptQueue([
      load({ id: 'l1', stops: [stop({ apptType: 'tbd', appt: '' })] }),
      load({ id: 'l2', stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-09-01') })] }),
    ])
    expect(rows.map((r) => r.loadId)).toEqual(['l2', 'l1'])
  })

  it('works on legacy loads with no stops array', () => {
    // getStops synthesises stops from the legacy pickup/delivery fields; a date-only
    // legacy appointment is exactly the "nobody set a time" case.
    const legacy = load({ id: 'l9', stops: undefined, pickupAppt: fromDateInput('2026-08-20') })
    const rows = apptQueue([legacy])
    expect(rows.some((r) => r.loadId === 'l9' && r.stopType === 'pickup')).toBe(true)
  })
})

describe('apptQueueCount / splitApptQueue', () => {
  const loads = [
    load({ id: 'l1', stops: [stop({ apptType: 'tbd' })] }),
    load({ id: 'l2', stops: [stop({ appt: fromDateInput('2026-08-20') })] }),
    load({ id: 'l3', stops: [stop()] }),   // booked — not in the queue
  ]

  it('counts everything awaiting an appointment', () => {
    expect(apptQueueCount(loads)).toBe(2)
  })

  it('splits the two groups for display', () => {
    const { need, pending } = splitApptQueue(apptQueue(loads))
    expect(need).toHaveLength(1)
    expect(pending).toHaveLength(1)
    expect(need[0].loadId).toBe('l1')
    expect(pending[0].loadId).toBe('l2')
  })
})
