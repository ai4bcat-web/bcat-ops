// @vitest-environment jsdom
/**
 * Duty logs on a load. The panel is READ ONLY by design — the FMCSA requires ELD edits to
 * go through the certified device — so the test that matters most is that it never offers
 * a way to change a status, only a way to get to Motive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const api = { fetchHosDay: vi.fn() }
vi.mock('../driverApi', () => api)

const { HosPanel } = await import('./HosPanel')

const DAY = {
  date: '2026-10-01',
  drivingSeconds: 23759,
  onDutySeconds: 7367,
  offDutySeconds: 55274,
  sleeperSeconds: 0,
  workedSeconds: 31126,
  totalMiles: 338,
  vehicleNumbers: ['89510'],
  firstOnDutyAt: '2026-10-01T11:55:05Z',
  lastOffDutyAt: '2026-10-01T14:28:22Z',
  segments: [
    { type: 'off_duty', startAt: '2026-10-01T05:00:00Z', endAt: '2026-10-01T11:55:05Z', location: null },
    { type: 'driving', startAt: '2026-10-01T12:00:00Z', endAt: '2026-10-01T12:50:01Z', location: 'Newton, IA' },
  ],
}

beforeEach(() => vi.clearAllMocks())

describe('the duty log panel', () => {
  it('shows the day’s hours and segments', async () => {
    api.fetchHosDay.mockResolvedValue({ date: '2026-10-01', linked: true, day: DAY })
    render(<HosPanel date="2026-10-01" />)
    await waitFor(() => expect(screen.getByText(/Your logs for 2026-10-01/)).toBeTruthy())
    expect(screen.getByText(/8h 38m worked/)).toBeTruthy()
    expect(screen.getByText(/338 mi/)).toBeTruthy()
    // 'Driving' appears twice on purpose: once as the day's total, once as a segment.
    expect(screen.getAllByText('Driving')).toHaveLength(2)
    expect(screen.getByText(/Newton, IA/)).toBeTruthy()
  })

  it('sends the driver to Motive to change anything, and offers no control of its own', async () => {
    api.fetchHosDay.mockResolvedValue({ date: '2026-10-01', linked: true, day: DAY })
    render(<HosPanel date="2026-10-01" />)
    await waitFor(() => expect(screen.getByText(/Change your duty status in Motive/)).toBeTruthy())
    // No on-duty / off-duty buttons: an ELD edit made here would not be a compliant record.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says "still on" while the last segment is running', async () => {
    api.fetchHosDay.mockResolvedValue({
      date: '2026-10-05', linked: true,
      day: { ...DAY, date: '2026-10-05', lastOffDutyAt: null },
    })
    render(<HosPanel date="2026-10-05" />)
    await waitFor(() => expect(screen.getByText('still on')).toBeTruthy())
  })

  it('names the reason when the driver has no Motive account linked', async () => {
    // Staff can fix this, so it is said out loud rather than hidden.
    api.fetchHosDay.mockResolvedValue({
      date: '2026-10-01', linked: false, day: null,
      reason: 'No Motive account is linked to this driver yet',
    })
    render(<HosPanel date="2026-10-01" />)
    await waitFor(() => expect(screen.getByText(/No Motive account is linked/)).toBeTruthy())
  })

  it('says so on a day with no activity', async () => {
    api.fetchHosDay.mockResolvedValue({ date: '2026-10-02', linked: true, day: null })
    render(<HosPanel date="2026-10-02" />)
    await waitFor(() => expect(screen.getByText(/No Motive activity recorded on 2026-10-02/)).toBeTruthy())
  })

  it('does not break the row when Motive cannot be reached', async () => {
    api.fetchHosDay.mockRejectedValue(new Error('offline'))
    render(<HosPanel date="2026-10-01" />)
    await waitFor(() => expect(screen.getByText(/Could not reach Motive just now/)).toBeTruthy())
  })

  it('asks for the day it was given', async () => {
    api.fetchHosDay.mockResolvedValue({ date: '2026-09-30', linked: true, day: null })
    render(<HosPanel date="2026-09-30" />)
    await waitFor(() => expect(api.fetchHosDay).toHaveBeenCalledWith('2026-09-30'))
  })
})

describe('when the panel is offered at all', () => {
  it('is not fetched until the driver asks for it', async () => {
    // One Motive call per load actually opened, not a dozen on every page load.
    const { PaperworkRows } = await import('./PaperworkRows')
    const load = {
      id: 'l1', reference: '14538', customer: 'C', deliveryAppt: '2026-10-01T15:00:00Z',
      pickupAppt: null, origin: 'A', destination: 'B', miles: null, trailerNumber: null,
      commodity: null, weight: null, pieces: null, notes: null, status: null, stops: [],
      pod: { present: true, pages: 1, legibility: 'OK', notes: null },
      pickupTimes: { timeIn: null, timeOut: null, notes: null, hours: null, billable: false },
      deliveryTimes: { timeIn: null, timeOut: null, notes: null, hours: null, billable: false },
      eld: { status: 'REQUIRED', required: true, farthestMiles: 201, farthestCity: 'X', label: 'ELD logs required' },
    }
    render(<PaperworkRows loads={[load as never]} onSendPod={vi.fn()} onRecordTimes={vi.fn()} />)
    expect(api.fetchHosDay).not.toHaveBeenCalled()

    api.fetchHosDay.mockResolvedValue({ date: '2026-10-01', linked: true, day: DAY })
    fireEvent.click(screen.getByText('Show my logs for this day'))
    await waitFor(() => expect(api.fetchHosDay).toHaveBeenCalledWith('2026-10-01'))
  })

  it('is not offered on a short-haul load', async () => {
    const { PaperworkRows } = await import('./PaperworkRows')
    const load = {
      id: 'l2', reference: '14539', customer: 'C', deliveryAppt: '2026-10-01T15:00:00Z',
      pickupAppt: null, origin: 'A', destination: 'B', miles: null, trailerNumber: null,
      commodity: null, weight: null, pieces: null, notes: null, status: null, stops: [],
      pod: { present: true, pages: 1, legibility: 'OK', notes: null },
      pickupTimes: { timeIn: null, timeOut: null, notes: null, hours: null, billable: false },
      deliveryTimes: { timeIn: null, timeOut: null, notes: null, hours: null, billable: false },
      eld: { status: 'NOT_REQUIRED', required: false, farthestMiles: 40, farthestCity: 'X', label: 'No ELD logs required' },
    }
    render(<PaperworkRows loads={[load as never]} onSendPod={vi.fn()} onRecordTimes={vi.fn()} />)
    // The exemption spares them the record; offering a log panel invites worry about
    // paperwork that does not exist.
    expect(screen.queryByText('Show my logs for this day')).toBeNull()
  })
})
