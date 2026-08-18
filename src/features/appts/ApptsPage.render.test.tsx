// @vitest-environment jsdom
/**
 * Smoke tests that the Appts queue RENDERS and shows the right stops.
 *
 * apptQueue.test.ts proves the derivation. This proves the page mounts and puts the
 * urgent things where a dispatcher will see them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { fromDateInput, fromDateTimeInput } from '@/lib/date'
import type { Load } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const loads = vi.fn<() => Load[]>(() => [])
const updateLoad = vi.fn().mockResolvedValue(undefined)
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: loads(), updateLoad }) }))
vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({ drivers: [{ id: 'd1', name: 'Zak Pace' }] }),
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
// The drawer pulls in the whole load-editing tree; the queue is what's under test.
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))

const setSelectedLoad = vi.fn()
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ setSelectedLoad }),
}))

import { ApptsPage } from './ApptsPage'

const load = (over: Partial<Load>): Load => ({
  id: 'l1', aljexId: '12345', tmsId: 'T1', pickupNumber: 'PU-1',
  pickupAppt: '', deliveryAppt: '', readyToInvoice: false,
  createdBy: '', updatedBy: '', createdAt: '', updatedAt: '',
  ...over,
} as Load)

const stop = (over = {}) => ({
  id: 's1', type: 'pickup' as const, appt: fromDateInput('2099-01-01'),
  apptType: 'tbd' as const, driverId: null, sequence: 0, ...over,
})

/** A NEED pickup plus a booked delivery — the ordinary shape of a queued row. */
const pair = (over: Partial<Load> = {}) => load({
  stops: [
    stop({ id: 'p', type: 'pickup', apptType: 'tbd', appt: fromDateInput('2099-01-01') }),
    stop({ id: 'd', type: 'delivery', apptType: 'exact', sequence: 1,
           appt: fromDateTimeInput('2099-01-02T14:30') }),
  ],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  loads.mockReturnValue([])
})

describe('ApptsPage', () => {
  it('mounts and shows both groups', async () => {
    render(<ApptsPage />)
    expect(await screen.findByRole('heading', { name: 'Appts' })).toBeTruthy()
    expect(screen.getByText('Needs booking')).toBeTruthy()
    expect(screen.getByText('No time set')).toBeTruthy()
  })

  it('says so plainly when nothing needs booking', () => {
    render(<ApptsPage />)
    expect(screen.getAllByText(/every appointment in this group is booked/i).length).toBe(2)
  })

  it('lists a NEED stop with the detail needed to make the call', () => {
    loads.mockReturnValue([load({
      customer: 'Acme Freight',
      stops: [stop({ name: 'Dock 4', city: 'Joliet, IL', driverId: 'd1' })],
    })])
    render(<ApptsPage />)

    expect(screen.getByText('12345')).toBeTruthy()
    expect(screen.getByText('PU-1')).toBeTruthy()
    expect(screen.getByText('Acme Freight')).toBeTruthy()
    expect(screen.getByText('Dock 4, Joliet, IL')).toBeTruthy()
    expect(screen.getByText('Zak Pace')).toBeTruthy()
    expect(screen.getByText('Pickup')).toBeTruthy()
  })

  it('separates an explicit NEED from a stop with no time set', () => {
    loads.mockReturnValue([
      load({ id: 'l1', aljexId: 'NEEDED', stops: [stop()] }),
      load({ id: 'l2', aljexId: 'NOTIME', stops: [stop({ apptType: 'exact' })] }),
    ])
    render(<ApptsPage />)

    const tables = screen.getAllByRole('table')
    expect(within(tables[0]).getByText('NEEDED')).toBeTruthy()
    expect(within(tables[1]).getByText('NOTIME')).toBeTruthy()
  })

  it('hides an appointment whose date has already gone by', () => {
    // Hundreds of historical loads would otherwise bury the stops still worth calling about.
    loads.mockReturnValue([load({ aljexId: 'OLD', stops: [stop({ appt: fromDateInput('2020-01-01') })] })])
    render(<ApptsPage />)
    expect(screen.queryByText('OLD')).toBeNull()
  })

  it('offers to show the past ones rather than dropping them silently', () => {
    loads.mockReturnValue([load({ aljexId: 'OLD', stops: [stop({ appt: fromDateInput('2020-01-01') })] })])
    render(<ApptsPage />)

    const toggle = screen.getByText('Show 1 past appointment')
    fireEvent.click(toggle)
    expect(screen.getByText('OLD')).toBeTruthy()
    expect(screen.getByText(/d overdue/)).toBeTruthy()
  })

  it('sorts a column on click and reverses it on a second click', () => {
    const row = (id: string, aljexId: string) =>
      load({ id, aljexId, stops: [stop({ appt: fromDateInput('2099-01-01') })] })
    loads.mockReturnValue([row('l1', '300'), row('l2', '100'), row('l3', '200')])
    render(<ApptsPage />)

    const proIds = () =>
      within(screen.getAllByRole('table')[0]).getAllByRole('row').slice(1)
        .map((r) => r.children[1].textContent)

    fireEvent.click(screen.getAllByLabelText('Sort by Pro #')[0])
    expect(proIds()).toEqual(['100', '200', '300'])

    fireEvent.click(screen.getAllByLabelText('Sort by Pro #')[0])
    expect(proIds()).toEqual(['300', '200', '100'])
  })

  it('leaves booked appointments out of the queue entirely', () => {
    loads.mockReturnValue([load({
      aljexId: 'BOOKED',
      stops: [stop({ apptType: 'exact', appt: fromDateTimeInput('2099-01-01T09:30') })],
    })])
    render(<ApptsPage />)
    expect(screen.queryByText('BOOKED')).toBeNull()
  })

  it('shows the scheduled pickup and delivery times as the last two columns', () => {
    loads.mockReturnValue([pair()])
    render(<ApptsPage />)

    const headers = screen.getAllByRole('table')[0].querySelectorAll('th')
    expect(headers[headers.length - 2].textContent).toContain('PU time')
    expect(headers[headers.length - 1].textContent).toContain('Delivery time')

    // The delivery has a real time (24h, as everywhere else in the app).
    expect(screen.getByText('14:30')).toBeTruthy()
  })

  it('sets a time in place and writes it to the right stop', async () => {
    loads.mockReturnValue([pair({ id: 'l5' })])
    render(<ApptsPage />)

    fireEvent.click(screen.getAllByTitle(/Set this time/)[0])
    fireEvent.change(screen.getByLabelText('Appointment date'), { target: { value: '2099-03-04' } })
    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '09:15' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    const [id, patch] = updateLoad.mock.calls[0]
    expect(id).toBe('l5')
    const written = patch.stops.find((st: { id: string }) => st.id === 'p')
    expect(written.appt).toBe(fromDateTimeInput('2099-03-04T09:15'))
    // Booking the time is what takes it off the queue.
    expect(written.apptType).toBe('exact')
  })

  it('does not open the drawer when a time cell is clicked', () => {
    loads.mockReturnValue([pair()])
    render(<ApptsPage />)

    fireEvent.click(screen.getAllByTitle(/Set this time/)[0])
    expect(setSelectedLoad).not.toHaveBeenCalled()
  })

  it('opens the load for editing when a row is clicked', () => {
    loads.mockReturnValue([load({ id: 'l7', stops: [stop()] })])
    render(<ApptsPage />)

    screen.getByText('12345').closest('tr')!.click()
    // 'edit' — booking the time is the whole reason the row was clicked.
    expect(setSelectedLoad).toHaveBeenCalledWith('l7', 'edit')
  })
})
