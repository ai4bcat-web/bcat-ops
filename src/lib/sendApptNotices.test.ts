// @vitest-environment jsdom
/**
 * sendApptNotices wires Slack alerts, move tasks, and Dennis booking tasks. These
 * tests guard the handoff path that the calendar popover relies on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendApptNotices } from './sendApptNotices'
import { fromDateInput, fromDateTimeInput } from './date'
import type { Load, Stop } from '@/types'

const notifyApptNeeded = vi.fn().mockResolvedValue('1699999999.000100')
const createApptTask = vi.fn().mockResolvedValue({ id: 'book-task-1' })
const createApptMoveTask = vi.fn().mockResolvedValue({ id: 'move-task-1' })
const updateIntakeItem = vi.fn().mockResolvedValue({})

vi.mock('@/lib/apiClient', () => ({
  notifyApptNeeded: (a: unknown) => notifyApptNeeded(a),
  createApptTask: (a: unknown) => createApptTask(a),
  createApptMoveTask: (a: unknown) => createApptMoveTask(a),
  updateIntakeItem: (a: unknown, b: unknown) => updateIntakeItem(a, b),
}))

const updateLoad = vi.fn().mockResolvedValue(undefined)

const stop = (over: Partial<Stop> = {}): Stop => ({
  id: 'd', type: 'delivery',
  appt: fromDateInput('2026-08-21'),
  apptType: 'tbd',
  driverId: null,
  sequence: 0,
  ...over,
})

const load = (): Load => ({
  id: 'l1', aljexId: 'SEND', tmsId: '', pickupNumber: 'PU-1', customer: 'Batory Foods',
  pickupAppt: '', deliveryAppt: '', readyToInvoice: false,
  createdBy: '', updatedBy: '', createdAt: '', updatedAt: '',
  stops: [stop()],
} as unknown as Load)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handoff to Dennis', () => {
  it('creates a book task and notifies even when no other notice was earned', async () => {
    const prev = [stop({ apptStatus: 'need_book' })]
    const next = [stop({
      apptStatus: 'need_request',
      apptType: 'exact',
      appt: fromDateTimeInput('2026-08-21T14:30'),
    })]

    await sendApptNotices({ load: load(), next, prev, actorName: 'ryne@bcatcorp.com', updateLoad })

    expect(createApptTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'book_delivery',
      assignee: 'dennis@bcatcorp.com',
    }))
    expect(notifyApptNeeded).toHaveBeenCalledWith(expect.objectContaining({ kind: 'book' }))
    // The ladder state and any stale move flags are persisted back to the stop.
    expect(updateLoad).toHaveBeenCalled()
    const patch = updateLoad.mock.calls[0][1] as { stops: Stop[] }
    expect(patch.stops[0].apptStatus).toBe('need_request')
    expect(patch.stops[0].apptMoveRequested).toBe(false)
  })

  it('fires for a manual confirmed -> need_request handoff', async () => {
    const prev = [stop({
      apptStatus: 'confirmed',
      apptType: 'exact',
      appt: fromDateTimeInput('2026-08-21T14:30'),
      apptProofs: { request: 'r', e2open: 'e', email: 'm' },
      apptThreadTs: '1699999999.000100',
    })]
    const next = [stop({
      apptStatus: 'need_request',
      apptType: 'exact',
      appt: fromDateTimeInput('2026-08-21T14:30'),
      apptProofs: { request: null, e2open: null, email: null },
      apptThreadTs: '1699999999.000100',
    })]

    await sendApptNotices({ load: load(), next, prev, actorName: 'ryne@bcatcorp.com', updateLoad })

    expect(createApptTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'book_delivery' }))
    expect(notifyApptNeeded).toHaveBeenCalledWith(expect.objectContaining({ kind: 'book' }))
  })

  it('does not duplicate the channel notice when a handoff also moves an appointment in a thread', async () => {
    const prev = [stop({
      apptStatus: 'need_book',
      apptType: 'tbd',
      appt: fromDateInput('2026-08-21'),
      apptThreadTs: '1699999999.000100',
    })]
    const next = [stop({
      apptStatus: 'need_request',
      apptType: 'exact',
      appt: fromDateTimeInput('2026-08-21T14:30'),
      apptThreadTs: '1699999999.000100',
    })]

    await sendApptNotices({ load: load(), next, prev, actorName: 'ryne@bcatcorp.com', updateLoad })

    const bookCalls = notifyApptNeeded.mock.calls.filter((c) => c[0].kind === 'book')
    const updatedCalls = notifyApptNeeded.mock.calls.filter((c) => c[0].kind === 'updated')
    expect(bookCalls).toHaveLength(1)
    expect(updatedCalls).toHaveLength(0)
  })
})
