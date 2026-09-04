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

describe('apptHistory — move requests and confirmation screenshots', () => {
  const booked = (over: Partial<Stop> = {}) =>
    stop({ appt: fromDateTimeInput('2026-08-20T09:30'), ...over })

  it('shows WHO asked for the appointment to be moved', () => {
    const before = [booked()]
    const after = [booked({ apptMoveRequested: true })]
    const ev = apptHistory(load(after), [entry({ stops: { from: before, to: after } }, '2026-09-04T10:00:00.000Z', 'ryne')])
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ kind: 'move-requested', user: 'ryne', from: 'Aug 20, 2026 · 09:30' })
  })

  it('marks the rebooking that resolved the move request', () => {
    const before = [booked({ apptMoveRequested: true, apptMoveTaskId: 't1' })]
    const after = [booked({ appt: fromDateTimeInput('2026-08-21T14:00'), apptMoveRequested: false, apptMoveTaskId: null })]
    const ev = apptHistory(load(after), [entry({ stops: { from: before, to: after } })])
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ kind: 'appt', changed: true, resolvedMove: true, to: 'Aug 21, 2026 · 14:00' })
  })

  it('records each confirmation screenshot as its own event, with who uploaded it', () => {
    const s0 = [booked()]
    const s1 = [booked({ apptProofs: { e2open: 'k1' } })]
    const s2 = [booked({ apptProofs: { e2open: 'k1', email: 'k2' } })]
    const ev = apptHistory(load(s2), [
      entry({ stops: { from: s0, to: s1 } }, '2026-09-04T10:00:00.000Z', 'dennis'),
      entry({ stops: { from: s1, to: s2 } }, '2026-09-04T11:00:00.000Z', 'dennis'),
    ])
    expect(ev.map((e) => [e.kind, e.proofLabel])).toEqual([
      ['proof-added', 'Email confirmation'],
      ['proof-added', 'E2Open update'],
    ])
    expect(ev[0].user).toBe('dennis')
  })

  it('a removed screenshot is visible too — the confirmation is no longer on file', () => {
    const before = [booked({ apptProofs: { e2open: 'k1', email: 'k2' } })]
    const after = [booked({ apptProofs: { e2open: 'k1', email: null } })]
    const ev = apptHistory(load(after), [entry({ stops: { from: before, to: after } })])
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ kind: 'proof-removed', proofLabel: 'Email confirmation' })
  })

  it('withdrawing a move request by hand shows as its own line', () => {
    const before = [booked({ apptMoveRequested: true })]
    const after = [booked({ apptMoveRequested: false })]
    const ev = apptHistory(load(after), [entry({ stops: { from: before, to: after } })])
    expect(ev.map((e) => e.kind)).toEqual(['move-withdrawn'])
  })

  it('the full lifecycle reads in order: booked → move asked → rebooked → re-confirmed', () => {
    const s0 = [stop({ apptType: 'tbd' })]
    const s1 = [booked()]
    const s2 = [booked({ apptProofs: { e2open: 'a', email: 'b' } })]
    const s3 = [booked({ apptProofs: { e2open: 'a', email: 'b' }, apptMoveRequested: true, apptMoveTaskId: 't1' })]
    const s4 = [booked({ appt: fromDateTimeInput('2026-08-21T14:00'), apptProofs: { e2open: 'a', email: 'b' } })]
    const s5 = [booked({ appt: fromDateTimeInput('2026-08-21T14:00'), apptProofs: { e2open: 'c', email: 'd' } })]
    const hist = [
      entry({ stops: { from: s0, to: s1 } }, '2026-09-01T10:00:00.000Z', 'ryne'),
      entry({ stops: { from: s1, to: s2 } }, '2026-09-01T11:00:00.000Z', 'dennis'),
      entry({ stops: { from: s2, to: s3 } }, '2026-09-03T09:00:00.000Z', 'ryne'),
      entry({ stops: { from: s3, to: s4 } }, '2026-09-03T15:00:00.000Z', 'dennis'),
      entry({ stops: { from: s4, to: s5 } }, '2026-09-03T16:00:00.000Z', 'dennis'),
    ]
    const ev = apptHistory(load(s5), hist)
    // Newest first: fresh confirmations for the new time (replaced screenshots), the
    // resolving rebooking, the ask, the original confirmations, the booking.
    expect(ev.map((e) => e.kind)).toEqual([
      'proof-added', 'proof-added',
      'appt',
      'move-requested',
      'proof-added', 'proof-added',
      'appt',
    ])
    expect(ev.find((e) => e.kind === 'move-requested')!.user).toBe('ryne')
    expect(ev[2]).toMatchObject({ kind: 'appt', resolvedMove: true })
  })
})
