import { describe, it, expect } from 'vitest'
import { apptHistory } from './apptHistory'
import { fromDateInput, fromDateTimeInput } from './date'
import type { AuditLogEntry, Load, Stop } from '@/types'

const stop = (over: Partial<Stop> = {}): Stop => ({
  id: 'p', type: 'pickup', appt: fromDateInput('2026-08-20'),
  apptType: 'exact', driverId: null, sequence: 0, ...over,
})
const del = (over: Partial<Stop> = {}): Stop =>
  stop({ id: 'd', type: 'delivery', sequence: 1, appt: fromDateTimeInput('2026-08-21T14:00'), ...over })

const load = (stops: Stop[]): Load => ({
  id: 'l1', aljexId: '1', tmsId: '', pickupNumber: '', pickupAppt: '', deliveryAppt: '',
  readyToInvoice: false, createdBy: '', updatedBy: '', createdAt: '', updatedAt: '', stops,
} as Load)

const entry = (changes: AuditLogEntry['changes'], at = '2026-08-28T15:00:00.000Z', user = 'ryne'): AuditLogEntry =>
  ({ id: at, entityType: 'Load', entityId: 'l1', action: 'update', user, changes, createdAt: at })

describe('apptHistory', () => {
  it('records the booking of a NEED stop', () => {
    const before = [stop({ apptType: 'tbd' }), del()]
    const after = [stop({ appt: fromDateTimeInput('2026-08-20T09:30') }), del()]
    const ev = apptHistory(load(after), [entry({ stops: { from: before, to: after } })])
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({
      stopKind: 'pickup', user: 'ryne', booked: true, changed: false,
      from: 'Aug 20, 2026 · NEED', to: 'Aug 20, 2026 · 09:30',
    })
  })

  it('flags a move AFTER booking as changed', () => {
    const before = [stop({ appt: fromDateTimeInput('2026-08-20T09:30') })]
    const after = [stop({ appt: fromDateTimeInput('2026-08-20T13:00') })]
    const ev = apptHistory(load(after), [entry({ stops: { from: before, to: after } })])
    expect(ev[0]).toMatchObject({ booked: false, changed: true, to: 'Aug 20, 2026 · 13:00' })
  })

  it('ignores a save that only touched the driver, even though stops was in the diff', () => {
    const before = [stop({ driverId: 'a' })]
    const after = [stop({ driverId: 'b' })]
    expect(apptHistory(load(after), [entry({ stops: { from: before, to: after } })])).toEqual([])
  })

  it('reads stops that the audit log stored as a JSON string', () => {
    const before = [stop({ apptType: 'tbd' })]
    const after = [stop({ appt: fromDateTimeInput('2026-08-20T09:30') })]
    const ev = apptHistory(load(after), [entry({ stops: { from: JSON.stringify(before), to: JSON.stringify(after) } })])
    expect(ev).toHaveLength(1)
  })

  it('reads legacy mirror-field changes on loads without a stops array', () => {
    const legacy = { ...load([]), stops: undefined, pickupAppt: fromDateTimeInput('2026-08-20T09:30'), pickupApptType: 'exact' } as Load
    const ev = apptHistory(legacy, [entry({
      pickupApptType: { from: 'tbd', to: 'exact' },
      pickupAppt: { from: fromDateInput('2026-08-20'), to: fromDateTimeInput('2026-08-20T09:30') },
    })])
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ stopKind: 'pickup', booked: true })
  })

  it('reports pickup and delivery separately and newest first', () => {
    const s1 = [stop({ apptType: 'tbd' }), del({ apptType: 'tbd' })]
    const s2 = [stop({ appt: fromDateTimeInput('2026-08-20T09:30') }), del({ apptType: 'tbd' })]
    const s3 = [stop({ appt: fromDateTimeInput('2026-08-20T09:30') }), del()]
    const ev = apptHistory(load(s3), [
      entry({ stops: { from: s1, to: s2 } }, '2026-08-28T10:00:00.000Z'),
      entry({ stops: { from: s2, to: s3 } }, '2026-08-28T11:00:00.000Z'),
    ])
    expect(ev.map((e) => e.stopKind)).toEqual(['delivery', 'pickup'])
  })

  it('leaves other loads and non-appointment saves alone', () => {
    const ev = apptHistory(load([stop()]), [
      { ...entry({ notes: { from: 'a', to: 'b' } }) },
      { ...entry({ stops: { from: [], to: [stop()] } }), entityId: 'other' },
    ])
    expect(ev).toEqual([])
  })
})
