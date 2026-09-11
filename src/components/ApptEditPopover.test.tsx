// @vitest-environment jsdom
/**
 * The shared appointment editor — used by the calendar, the Appts queue, and reachable
 * from the Loads page. These cover the states it can be opened in, because a select that
 * misreports the stored type is worse than no editor: it tells a dispatcher a three-hour
 * window is an exact time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { fromDateTimeInput, fromDateInput } from '@/lib/date'
import type { Load, Stop } from '@/types'

const updateLoad = vi.fn().mockResolvedValue(undefined)
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ updateLoad }) }))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ currentUserEmail: 'ryne@bcatcorp.com' }),
}))
vi.mock('@/lib/apiClient', () => ({
  notifyApptNeeded: vi.fn().mockResolvedValue(null),
  createApptMoveTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
  updateIntakeItem: vi.fn().mockResolvedValue({}),
}))

import { ApptEditPopover } from './ApptEditPopover'

const mkStop = (over: Partial<Stop> = {}): Stop => ({
  id: 'p', type: 'pickup', appt: fromDateTimeInput('2026-08-20T08:00'),
  apptType: 'exact', driverId: null, sequence: 0, ...over,
})

const mkLoad = (stop: Stop): Load => ({
  id: 'l1', aljexId: '12345', tmsId: '', pickupNumber: 'PU-1', customer: 'Acme',
  pickupAppt: stop.appt, pickupApptType: stop.apptType, pickupApptEnd: stop.apptEnd,
  deliveryAppt: '', readyToInvoice: false,
  createdBy: '', updatedBy: '', createdAt: '', updatedAt: '',
  stops: [stop],
} as unknown as Load)

const open = (stop: Stop) => {
  const load = mkLoad(stop)
  render(<ApptEditPopover load={load} stop={stop} apptField="pickupAppt"
                          typeField="pickupApptType" onClose={() => {}} />)
  return load
}

const savedStop = () => updateLoad.mock.calls[0][1].stops[0] as Stop
const typeSelect = () => screen.getByLabelText('Appointment type') as HTMLSelectElement

beforeEach(() => { updateLoad.mockClear() })

describe('the type select tells the truth about the stored type', () => {
  it('shows Window for a range stop rather than claiming Exact Time', () => {
    open(mkStop({ apptType: 'range', apptEnd: fromDateTimeInput('2026-08-20T12:00') }))
    expect(typeSelect().value).toBe('range')
  })

  it('shows Pending for an exact appointment with no time yet', () => {
    open(mkStop({ appt: fromDateInput('2026-08-20') }))
    expect(typeSelect().value).toBe('pending')
  })

  it('shows NEED for a flagged stop', () => {
    open(mkStop({ apptType: 'tbd' }))
    expect(typeSelect().value).toBe('tbd')
  })
})

describe('editing a window', () => {
  it('seeds both ends of an existing window', () => {
    open(mkStop({ apptType: 'range', apptEnd: fromDateTimeInput('2026-08-20T12:00') }))
    expect((screen.getByLabelText('Window end time') as HTMLInputElement).value).toBe('12:00')
    expect((screen.getByLabelText('Window end date') as HTMLInputElement).value).toBe('2026-08-20')
  })

  it('saves a changed window end', async () => {
    open(mkStop({ apptType: 'range', apptEnd: fromDateTimeInput('2026-08-20T12:00') }))
    fireEvent.change(screen.getByLabelText('Window end time'), { target: { value: '15:30' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    expect(savedStop().apptEnd).toBe(fromDateTimeInput('2026-08-20T15:30'))
    expect(savedStop().apptType).toBe('range')
  })

  it('preserves a MULTI-DAY window, which a time-only field would have collapsed', () => {
    // Real data: Pro 13686 carries 3-day windows. The end is a full date, not just a time.
    open(mkStop({ apptType: 'range', apptEnd: fromDateTimeInput('2026-08-23T16:00') }))
    expect((screen.getByLabelText('Window end date') as HTMLInputElement).value).toBe('2026-08-23')
  })

  it('hides the window fields for every other type', () => {
    open(mkStop())
    expect(screen.queryByLabelText('Window end time')).toBeNull()
  })

  it('refuses a window that ends before it starts', () => {
    open(mkStop({ apptType: 'range', apptEnd: fromDateTimeInput('2026-08-20T12:00') }))
    fireEvent.change(screen.getByLabelText('Window end time'), { target: { value: '06:00' } })

    expect(screen.getByRole('alert').textContent).toMatch(/end after it starts/)
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('drops a stale window end when the type changes away from range', async () => {
    // Otherwise apptTimeLabel would keep rendering a window that no longer applies.
    open(mkStop({ apptType: 'range', apptEnd: fromDateTimeInput('2026-08-20T12:00') }))
    fireEvent.change(typeSelect(), { target: { value: 'exact' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    expect(savedStop().apptEnd).toBeUndefined()
    expect(savedStop().apptType).toBe('exact')
  })

  it('leaves a range untouched when saved without edits', async () => {
    open(mkStop({ apptType: 'range', apptEnd: fromDateTimeInput('2026-08-20T12:00') }))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    expect(savedStop().apptType).toBe('range')
    expect(savedStop().apptEnd).toBe(fromDateTimeInput('2026-08-20T12:00'))
  })
})

describe('Pending clears the time', () => {
  it('saves a date-only appointment so it reads as Pending everywhere', async () => {
    open(mkStop({ appt: fromDateTimeInput('2026-08-20T08:00') }))
    fireEvent.change(typeSelect(), { target: { value: 'pending' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    expect(savedStop().appt).toBe(fromDateInput('2026-08-20'))
    expect(savedStop().apptType).toBe('exact')
  })
})

const mkDeliveryStop = (over: Partial<Stop> = {}): Stop => ({
  id: 'd', type: 'delivery', appt: fromDateInput('2026-08-21'),
  apptType: 'tbd', driverId: null, sequence: 1, ...over,
})

const mkDeliveryLoad = (stop: Stop): Load => ({
  id: 'l1', aljexId: '12345', tmsId: '', pickupNumber: 'PU-1', customer: 'Batory Foods',
  pickupAppt: fromDateTimeInput('2026-08-20T08:00'), pickupApptType: 'exact',
  deliveryAppt: stop.appt, deliveryApptType: stop.apptType, deliveryApptEnd: stop.apptEnd,
  readyToInvoice: false,
  createdBy: '', updatedBy: '', createdAt: '', updatedAt: '',
  stops: [stop],
} as unknown as Load)

const openHandoff = (stop: Stop) => {
  const load = mkDeliveryLoad(stop)
  render(<ApptEditPopover load={load} stop={stop} apptField="deliveryAppt"
                          typeField="deliveryApptType" intent="handoff" onClose={() => {}} />)
  return load
}

describe('NEED RUBEN handoff from the calendar', () => {
  it('prefills the date and leaves the time blank', () => {
    openHandoff(mkDeliveryStop({ apptStatus: 'need_book' }))
    expect((screen.getByLabelText('Appointment date') as HTMLInputElement).value).toBe('2026-08-21')
    expect((screen.getByLabelText('Appointment time') as HTMLInputElement).value).toBe('')
    expect(screen.queryByLabelText('Appointment type')).toBeNull()
  })

  it('saves NEED DENNIS with the chosen date+time and clears the booking cycle', async () => {
    openHandoff(mkDeliveryStop({
      apptStatus: 'need_book',
      apptProofs: { request: 'x', e2open: 'x', email: 'x' },
    }))
    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '14:30' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    const saved = savedStop()
    expect(saved.apptStatus).toBe('need_request')
    expect(saved.appt).toBe(fromDateTimeInput('2026-08-21T14:30'))
    expect(saved.apptType).toBe('exact')
    expect(saved.apptProofs).toEqual({ request: null, e2open: null, email: null })
    expect(saved.apptRequestedFor).toBeNull()
    expect(saved.apptMoveRequested).toBe(false)
    expect(saved.apptChangeTo).toBeNull()
  })

  it('rejects a blank time and keeps the popover open', async () => {
    openHandoff(mkDeliveryStop({ apptStatus: 'need_book' }))
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true)
    expect(updateLoad).not.toHaveBeenCalled()

    // Filling the time should then allow the save.
    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '09:00' } })
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    expect(savedStop().apptStatus).toBe('need_request')
  })

  it('does not submit on Enter when the time is blank', () => {
    openHandoff(mkDeliveryStop({ apptStatus: 'need_book' }))
    fireEvent.keyDown(screen.getByLabelText('Appointment date'), { key: 'Enter' })
    expect(updateLoad).not.toHaveBeenCalled()
  })

  it('does not double-submit while saving', async () => {
    // Node 20 jsdom lacks Promise.withResolvers; a never-resolving promise is enough.
    updateLoad.mockReturnValue(new Promise(() => {}))
    openHandoff(mkDeliveryStop({ apptStatus: 'need_book' }))
    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '10:00' } })
    fireEvent.click(screen.getByText('Save'))
    fireEvent.keyDown(screen.getByLabelText('Appointment date'), { key: 'Enter' })
    expect(updateLoad).toHaveBeenCalledTimes(1)
  })
})

describe('Send to Dennis for an already-timed delivery', () => {
  it('prefills the existing time and resets proofs for a new booking cycle', async () => {
    openHandoff(mkDeliveryStop({
      apptStatus: 'confirmed',
      apptType: 'exact',
      appt: fromDateTimeInput('2026-08-21T11:00'),
      apptProofs: { request: 'r', e2open: 'e', email: 'm' },
      apptRequestedFor: fromDateTimeInput('2026-08-21T11:00'),
    }))
    expect((screen.getByLabelText('Appointment time') as HTMLInputElement).value).toBe('11:00')

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    const saved = savedStop()
    expect(saved.apptStatus).toBe('need_request')
    expect(saved.appt).toBe(fromDateTimeInput('2026-08-21T11:00'))
    expect(saved.apptType).toBe('exact')
    expect(saved.apptProofs).toEqual({ request: null, e2open: null, email: null })
    expect(saved.apptRequestedFor).toBeNull()
  })
})

describe('normal editing graduates a NEED RUBEN stop when a time is entered', () => {
  it('does not retain need_book or drop the typed time', async () => {
    const stop = mkDeliveryStop({ apptStatus: 'need_book' })
    const load = mkDeliveryLoad(stop)
    render(<ApptEditPopover load={load} stop={stop} apptField="deliveryAppt"
                            typeField="deliveryApptType" onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '16:45' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    expect(savedStop().apptStatus).toBe('need_request')
    expect(savedStop().appt).toBe(fromDateTimeInput('2026-08-21T16:45'))
    expect(savedStop().apptType).toBe('exact')
  })
})

describe('typing a time while the select reads Pending keeps the time', () => {
  it('saves Exact Time, not a date-only Pending appointment', async () => {
    open(mkStop({ appt: fromDateInput('2026-08-20') }))
    expect(typeSelect().value).toBe('pending')

    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '13:15' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    expect(savedStop().appt).toBe(fromDateTimeInput('2026-08-20T13:15'))
    expect(savedStop().apptType).toBe('exact')
  })
})

describe('legacy synthetic stops persist status through the stops array', () => {
  it('writes a stops array for a handoff on a legacy load', async () => {
    const load: Load = {
      id: 'legacy', aljexId: 'LEG', tmsId: '', pickupNumber: 'PU-1', customer: 'Batory Foods',
      pickupAppt: fromDateTimeInput('2026-08-20T08:00'), pickupApptType: 'exact',
      deliveryAppt: fromDateInput('2026-08-21'), deliveryApptType: 'tbd',
      readyToInvoice: false,
      createdBy: '', updatedBy: '', createdAt: '', updatedAt: '',
      stops: null,
    } as unknown as Load

    render(<ApptEditPopover load={load} apptField="deliveryAppt"
                            typeField="deliveryApptType" intent="handoff" onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '15:00' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    const patch = updateLoad.mock.calls[0][1] as { stops: Stop[] }
    expect(patch.stops).toBeDefined()
    const delivery = patch.stops.find((s) => s.type === 'delivery')
    expect(delivery?.apptStatus).toBe('need_request')
    expect(delivery?.appt).toBe(fromDateTimeInput('2026-08-21T15:00'))
    expect(delivery?.apptType).toBe('exact')
  })
})
