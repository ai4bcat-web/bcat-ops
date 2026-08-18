import { describe, it, expect } from 'vitest'
import {
  apptQueue, apptNeedKind, apptQueueCount, splitApptQueue,
  isPastAppt, splitPastAppts, sortApptRows, apptTypeAfterEdit, loadApptRefs,
} from './apptQueue'
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

describe('isPastAppt / splitPastAppts', () => {
  const TODAY = fromDateInput('2026-08-17')

  it('treats yesterday and earlier as past', () => {
    expect(isPastAppt(fromDateInput('2026-08-16'), TODAY)).toBe(true)
    expect(isPastAppt(fromDateInput('2025-01-01'), TODAY)).toBe(true)
  })

  it('does NOT treat today as past, even late in the day', () => {
    // A 5pm appointment today still needs booking this morning.
    expect(isPastAppt(fromDateInput('2026-08-17'), TODAY)).toBe(false)
    expect(isPastAppt(fromDateTimeInput('2026-08-17T17:00'), TODAY)).toBe(false)
  })

  it('keeps future appointments', () => {
    expect(isPastAppt(fromDateInput('2026-08-18'), TODAY)).toBe(false)
  })

  it('does not call a dateless stop past — it is unscheduled, not stale', () => {
    expect(isPastAppt('', TODAY)).toBe(false)
  })

  it('splits the queue without losing rows', () => {
    const rows = apptQueue([
      load({ id: 'old', stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-08-10') })] }),
      load({ id: 'now', stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-08-17') })] }),
      load({ id: 'fut', stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-09-01') })] }),
    ])
    const { current, past } = splitPastAppts(rows, TODAY)
    expect(current.map((r) => r.loadId).sort()).toEqual(['fut', 'now'])
    expect(past.map((r) => r.loadId)).toEqual(['old'])
    expect(current.length + past.length).toBe(rows.length)
  })
})

describe('sortApptRows', () => {
  const name = (id: string | null) => (id === 'd1' ? 'Zak Pace' : id === 'd2' ? 'Ana Ruiz' : '')
  const rows = apptQueue([
    load({ id: 'l1', aljexId: '300', customer: 'Zeta',  stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-09-03'), driverId: 'd1' })] }),
    load({ id: 'l2', aljexId: '100', customer: 'Alpha', stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-09-01'), driverId: 'd2' })] }),
    load({ id: 'l3', aljexId: '200', customer: '',      stops: [stop({ apptType: 'tbd', appt: fromDateInput('2026-09-02'), driverId: null })] }),
  ])

  it('sorts ascending and descending', () => {
    expect(sortApptRows(rows, 'aljexId', 'asc', name).map((r) => r.aljexId)).toEqual(['100', '200', '300'])
    expect(sortApptRows(rows, 'aljexId', 'desc', name).map((r) => r.aljexId)).toEqual(['300', '200', '100'])
  })

  it('sorts dates chronologically', () => {
    expect(sortApptRows(rows, 'appt', 'asc', name).map((r) => r.loadId)).toEqual(['l2', 'l3', 'l1'])
  })

  it('sorts drivers by name, not by id', () => {
    // d2 is "Ana", d1 is "Zak" — sorting by the raw id would invert this.
    const sorted = sortApptRows(rows, 'driver', 'asc', name)
    expect(sorted.map((r) => name(r.driverId))).toEqual(['Ana Ruiz', 'Zak Pace', ''])
  })

  it('sinks blanks to the bottom in BOTH directions', () => {
    // A missing customer isn't "before A" or "after Z" — floating it to the top on a
    // descending sort would push the real rows off-screen.
    expect(sortApptRows(rows, 'customer', 'asc', name).map((r) => r.customer)).toEqual(['Alpha', 'Zeta', ''])
    expect(sortApptRows(rows, 'customer', 'desc', name).map((r) => r.customer)).toEqual(['Zeta', 'Alpha', ''])
  })

  it('compares Pro numbers numerically, so 100 sorts before 20', () => {
    const nums = apptQueue([
      load({ id: 'a', aljexId: '100', stops: [stop({ apptType: 'tbd' })] }),
      load({ id: 'b', aljexId: '20',  stops: [stop({ apptType: 'tbd' })] }),
    ])
    expect(sortApptRows(nums, 'aljexId', 'asc', name).map((r) => r.aljexId)).toEqual(['20', '100'])
  })

  it('does not mutate the input', () => {
    const before = rows.map((r) => r.loadId)
    sortApptRows(rows, 'aljexId', 'desc', name)
    expect(rows.map((r) => r.loadId)).toEqual(before)
  })
})

describe('apptTypeAfterEdit', () => {
  it('graduates a NEED stop to exact once a real time is entered', () => {
    // The whole point: booking the time on the calendar takes it off the Appts queue.
    expect(apptTypeAfterEdit('tbd', '2026-08-20T09:30')).toBe('exact')
  })

  it('leaves it as NEED when only a date was picked', () => {
    expect(apptTypeAfterEdit('tbd', '2026-08-20')).toBe('tbd')
  })

  it('does not treat midnight as a booked time — that is the empty time input', () => {
    expect(apptTypeAfterEdit('tbd', '2026-08-20T00:00')).toBe('tbd')
  })

  it('never overrides a type the user chose deliberately', () => {
    expect(apptTypeAfterEdit('fcfs', '2026-08-20T09:30')).toBe('fcfs')
    expect(apptTypeAfterEdit('range', '2026-08-20T09:30')).toBe('range')
    expect(apptTypeAfterEdit('exact', '2026-08-20T09:30')).toBe('exact')
  })

  it('leaves a queued stop queued when the time is cleared', () => {
    expect(apptTypeAfterEdit('tbd', '')).toBe('tbd')
  })
})

describe('loadApptRefs', () => {
  it('reads the pickup and delivery off the stops', () => {
    const { pickup, delivery } = loadApptRefs(load({ stops: [
      stop({ id: 'p', type: 'pickup', appt: fromDateTimeInput('2026-08-20T09:00') }),
      stop({ id: 'd', type: 'delivery', sequence: 1, appt: fromDateTimeInput('2026-08-21T14:00') }),
    ] }))
    expect(pickup).toMatchObject({ stopId: 'p', appt: fromDateTimeInput('2026-08-20T09:00') })
    expect(delivery).toMatchObject({ stopId: 'd', appt: fromDateTimeInput('2026-08-21T14:00') })
  })

  it('takes the FIRST pickup and the LAST delivery on a multi-stop load', () => {
    // Same rule as deriveLegacyFields, so the Appts page names the same two stops the
    // calendar and the legacy mirror fields do.
    const { pickup, delivery } = loadApptRefs(load({ stops: [
      stop({ id: 'p1', type: 'pickup', sequence: 0 }),
      stop({ id: 'p2', type: 'pickup', sequence: 1 }),
      stop({ id: 'd1', type: 'delivery', sequence: 2 }),
      stop({ id: 'd2', type: 'delivery', sequence: 3 }),
    ] }))
    expect(pickup.stopId).toBe('p1')
    expect(delivery.stopId).toBe('d2')
  })

  it('falls back to the load fields on a legacy load, via synthesized stops', () => {
    const refs = loadApptRefs(load({ stops: undefined }))
    expect(refs.pickup.appt).toBe(fromDateTimeInput('2026-08-20T09:00'))
    expect(refs.delivery.appt).toBe(fromDateTimeInput('2026-08-21T09:00'))
  })

  it('is carried on every queue row so the columns can render without a second lookup', () => {
    const [row] = apptQueue([load({ stops: [
      stop({ id: 'p', type: 'pickup', apptType: 'tbd', appt: fromDateInput('2026-08-20') }),
      stop({ id: 'd', type: 'delivery', sequence: 1, appt: fromDateTimeInput('2026-08-21T14:00') }),
    ] })])
    expect(row.pickup.stopId).toBe('p')
    expect(row.delivery.appt).toBe(fromDateTimeInput('2026-08-21T14:00'))
  })
})

describe('sortApptRows — appointment time columns', () => {
  const name = () => ''
  it('sorts by pickup and delivery time chronologically', () => {
    const rows = apptQueue([
      load({ id: 'l1', stops: [
        stop({ id: 'p', type: 'pickup', apptType: 'tbd', appt: fromDateTimeInput('2026-09-03T08:00') }),
        stop({ id: 'd', type: 'delivery', sequence: 1, appt: fromDateTimeInput('2026-09-05T08:00') }),
      ] }),
      load({ id: 'l2', stops: [
        stop({ id: 'p', type: 'pickup', apptType: 'tbd', appt: fromDateTimeInput('2026-09-01T08:00') }),
        stop({ id: 'd', type: 'delivery', sequence: 1, appt: fromDateTimeInput('2026-09-09T08:00') }),
      ] }),
    ])
    expect(sortApptRows(rows, 'pickupTime', 'asc', name).map((r) => r.loadId)).toEqual(['l2', 'l1'])
    expect(sortApptRows(rows, 'deliveryTime', 'asc', name).map((r) => r.loadId)).toEqual(['l1', 'l2'])
  })
})
