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
vi.mock('@/lib/apiClient', () => ({ notifyApptNeeded: vi.fn().mockResolvedValue(null) }))

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
