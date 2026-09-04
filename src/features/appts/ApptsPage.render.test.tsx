// @vitest-environment jsdom
/**
 * Smoke tests that the Appts queue RENDERS and shows shipments correctly.
 *
 * apptQueue.test.ts proves the derivation. This proves the page mounts and puts the
 * urgent things where a dispatcher will see them — one row per shipment, with pickup
 * and delivery status on each row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { fromDateInput, fromDateTimeInput } from '@/lib/date'
import type { AuditLogEntry, Load } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const loads = vi.fn<() => Load[]>(() => [])
const updateLoad = vi.fn().mockResolvedValue(undefined)
vi.mock('@/hooks/useLoads', () => ({ useLoads: () => ({ loads: loads(), updateLoad }) }))
vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({ drivers: [{ id: 'd1', name: 'Zak Pace' }] }),
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
const auditLog = vi.fn<() => AuditLogEntry[]>(() => [])
vi.mock('@/hooks/useAuditLog', () => ({ useAuditLog: () => ({ entries: auditLog() }) }))
// The drawer pulls in the whole load-editing tree; the queue is what's under test.
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))

const setSelectedLoad = vi.fn()
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({ setSelectedLoad, currentUserEmail: 'ryne@bcatcorp.com' }),
}))

const notifyApptNeeded = vi.fn().mockResolvedValue('1699999999.000100')
vi.mock('@/lib/apiClient', () => ({
  notifyApptNeeded: (a: unknown) => notifyApptNeeded(a),
  uploadApptProof: vi.fn().mockResolvedValue('appt-proofs/x'),
  getApptProofUrl: vi.fn().mockResolvedValue('https://example.com/x.jpg'),
  deleteApptProof: vi.fn().mockResolvedValue(undefined),
  createApptMoveTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
  updateIntakeItem: vi.fn().mockResolvedValue({}),
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
  auditLog.mockReturnValue([])
})

describe('ApptsPage', () => {
  it('mounts and sections the queue by pickup day', async () => {
    loads.mockReturnValue([pair({ id: 'l1' })])
    render(<ApptsPage />)
    expect(await screen.findByRole('heading', { name: 'Appts' })).toBeTruthy()
    // 2099-01-01 is a Thursday; the section is titled by weekday because that is how a
    // dispatcher scans the page.
    expect(screen.getByText(/Thu, Jan 1, 2099/)).toBeTruthy()
  })

  it('groups two loads picking up the same day into ONE section', () => {
    loads.mockReturnValue([pair({ id: 'l1' }), pair({ id: 'l2' })])
    render(<ApptsPage />)
    expect(screen.getAllByRole('table')).toHaveLength(1)
  })

  it('gives each pickup day its own section', () => {
    loads.mockReturnValue([
      pair({ id: 'l1' }),
      load({ id: 'l2', stops: [stop({ id: 'p', appt: fromDateInput('2099-02-02') })] }),
    ])
    render(<ApptsPage />)
    expect(screen.getAllByRole('table')).toHaveLength(2)
  })

  it('says so plainly when there is nothing to show', () => {
    render(<ApptsPage />)
    expect(screen.getByText(/No shipments yet/i)).toBeTruthy()
  })

  it('lists a shipment with the detail needed to make the call', () => {
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
  })

  it('shows NEED and Pending chips per row — PU and Del status separately', () => {
    // One row per shipment. PU chip in first column, Del chip in second.
    loads.mockReturnValue([
      load({ id: 'l1', aljexId: 'NEEDED', stops: [stop()] }),
      load({ id: 'l2', aljexId: 'NOTIME', stops: [stop({ apptType: 'exact' })] }),
    ])
    render(<ApptsPage />)

    const table = screen.getAllByRole('table')[0]
    // PU status is children[0], Del status is children[1].
    // children[0] is the history toggle; PU status is children[1], Del status children[2].
    const puOf = (pro: string) =>
      within(table).getByText(pro).closest('tr')!.children[1].textContent
    expect(puOf('NEEDED')).toBe('NEED')
    expect(puOf('NOTIME')).toBe('Pending')
  })

  it('a booked Batory stop without screenshots shows as Pending confirmation', () => {
    loads.mockReturnValue([pair({ customer: 'Batory Foods' })])
    render(<ApptsPage />)
    const table = screen.getAllByRole('table')[0]
    const row = within(table).getByText('12345').closest('tr')!
    expect(row.children[2].textContent).toBe('Pending')
    expect(row.children[2].querySelector('[data-state]')!.getAttribute('data-state')).toBe('booked-pending')
    // Pickup still NEED, so the shipment as a whole is outstanding (red edge).
    expect(row.getAttribute('data-outstanding')).toBe('true')
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

    const toggle = screen.getByText('Show 1 past shipment')
    fireEvent.click(toggle)
    expect(screen.getByText('OLD')).toBeTruthy()
    expect(screen.getByText(/d overdue/)).toBeTruthy()
  })

  it('sorts a column on click and reverses it on a second click', () => {
    const row = (id: string, aljexId: string) =>
      load({ id, aljexId, stops: [stop({ appt: fromDateInput('2099-01-01') })] })
    loads.mockReturnValue([row('l1', '300'), row('l2', '100'), row('l3', '200')])
    render(<ApptsPage />)

    // history, PU, Del, Pro #, ... → Pro # is children[3].
    const proIds = () =>
      within(screen.getAllByRole('table')[0]).getAllByRole('row').slice(1)
        .map((r) => r.children[3].textContent)

    fireEvent.click(screen.getAllByLabelText('Sort by Pro #')[0])
    expect(proIds()).toEqual(['100', '200', '300'])

    fireEvent.click(screen.getAllByLabelText('Sort by Pro #')[0])
    expect(proIds()).toEqual(['300', '200', '100'])
  })

  it('keeps a fully booked shipment on the page as a green row', () => {
    loads.mockReturnValue([load({
      aljexId: 'BOOKED',
      stops: [stop({ apptType: 'exact', appt: fromDateTimeInput('2099-01-01T09:30') })],
    })])
    render(<ApptsPage />)
    const row = screen.getByText('BOOKED').closest('tr')!
    expect(row.getAttribute('data-outstanding')).toBe('false')
    // Booked but no confirmation screenshot yet — Pending for every customer.
    expect(row.children[1].textContent).toBe('Pending')
  })

  it('a non-Batory booking is Confirmed by its single appt screenshot', () => {
    loads.mockReturnValue([load({
      aljexId: 'ONESHOT', customer: 'Acme Freight',
      stops: [stop({ apptType: 'exact', appt: fromDateTimeInput('2099-01-01T09:30'),
                     apptProofs: { email: 'appt-proofs/a' } })],
    })])
    render(<ApptsPage />)
    expect(screen.getByText('ONESHOT').closest('tr')!.children[1].textContent).toBe('Confirmed')
  })

  it('non-Batory shipments show ONE upload slot per stop — Appt confirmation', () => {
    loads.mockReturnValue([pair({ id: 'l7b', aljexId: 'ONESLOT', customer: 'Acme Freight' })])
    render(<ApptsPage />)
    fireEvent.click(screen.getByLabelText('Show booking screenshots for ONESLOT'))
    const panel = screen.getByTestId('appt-proofs')
    expect(within(panel).getAllByText('Appt confirmation')).toHaveLength(2)
    expect(within(panel).queryByText('E2Open update')).toBeNull()
  })

  it('Batory flips to Confirmed once BOTH screenshots are on file', () => {
    loads.mockReturnValue([load({
      aljexId: 'PROVEN', customer: 'Batory Foods',
      stops: [stop({ apptType: 'exact', appt: fromDateTimeInput('2099-01-01T09:30'),
                     apptProofs: { e2open: 'appt-proofs/a', email: 'appt-proofs/b' } })],
    })])
    render(<ApptsPage />)
    const row = screen.getByText('PROVEN').closest('tr')!
    expect(row.children[1].textContent).toBe('Confirmed')
    expect(row.children[1].querySelector('[data-state]')!.getAttribute('data-state')).toBe('confirmed')
  })

  it('one screenshot is not enough for Batory — still Pending', () => {
    loads.mockReturnValue([load({
      aljexId: 'HALFPROOF', customer: 'Batory Foods',
      stops: [stop({ apptType: 'exact', appt: fromDateTimeInput('2099-01-01T09:30'),
                     apptProofs: { e2open: 'appt-proofs/a' } })],
    })])
    render(<ApptsPage />)
    expect(screen.getByText('HALFPROOF').closest('tr')!.children[1].textContent).toBe('Pending')
  })

  it('"Open only" hides the booked rows and shows the open count', () => {
    loads.mockReturnValue([
      load({ id: 'l1', aljexId: 'BOOKED', stops: [stop({ apptType: 'exact', appt: fromDateTimeInput('2099-01-01T09:30') })] }),
      pair({ id: 'l2', aljexId: 'OPEN' }),
    ])
    render(<ApptsPage />)
    expect(screen.getByText('BOOKED')).toBeTruthy()
    fireEvent.click(screen.getByText(/All shipments · 1 open/))
    expect(screen.queryByText('BOOKED')).toBeNull()
    expect(screen.getByText('OPEN')).toBeTruthy()
    expect(screen.getByText('Open only (1)')).toBeTruthy()
  })

  it('opens a booking history row from the audit log', () => {
    const booked = load({
      id: 'l9', aljexId: 'HIST',
      stops: [stop({ id: 'p', apptType: 'exact', appt: fromDateTimeInput('2099-01-01T09:30') })],
    })
    loads.mockReturnValue([booked])
    auditLog.mockReturnValue([{
      id: 'a1', entityType: 'Load', entityId: 'l9', action: 'update', user: 'ryne@bcatcorp.com',
      createdAt: '2026-08-28T15:00:00.000Z',
      changes: { stops: {
        from: [stop({ id: 'p', apptType: 'tbd', appt: fromDateInput('2099-01-01') })],
        to: booked.stops,
      } },
    }])
    render(<ApptsPage />)
    fireEvent.click(screen.getByLabelText('Show appointment history for HIST'))
    const hist = screen.getByTestId('appt-history')
    expect(hist.textContent).toContain('Jan 1, 2099 · NEED')
    expect(hist.textContent).toContain('Jan 1, 2099 · 09:30')
    expect(hist.textContent).toContain('booked')
    expect(hist.textContent).toContain('ryne@bcatcorp.com')
  })

  it('shows the scheduled pickup and delivery times as the last two columns', () => {
    loads.mockReturnValue([pair()])
    render(<ApptsPage />)

    const headers = screen.getAllByRole('table')[0].querySelectorAll('th')
    // Columns: PU, Del, Pro #, PU #, Customer, Location, Date, Driver, PU time, Delivery time
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
    // Status is saved as selected: the row was NEED and nobody changed that, so adding a
    // requested time keeps it NEED (and on the queue). Booking is choosing Exact.
    expect(written.apptType).toBe('tbd')
  })

  it('books the stop when Exact is chosen with the time', async () => {
    loads.mockReturnValue([pair({ id: 'l6' })])
    render(<ApptsPage />)

    fireEvent.click(screen.getAllByTitle(/Set this time/)[0])
    fireEvent.change(screen.getByLabelText('Appointment date'), { target: { value: '2099-03-04' } })
    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '09:15' } })
    fireEvent.change(screen.getByLabelText('Appointment type'), { target: { value: 'exact' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(updateLoad).toHaveBeenCalled())
    const [, patch] = updateLoad.mock.calls[0]
    const written = patch.stops.find((st: { id: string }) => st.id === 'p')
    expect(written.appt).toBe(fromDateTimeInput('2099-03-04T09:15'))
    expect(written.apptType).toBe('exact')
  })

  it('posts to #appts-ivan when a time cell flags NEED — the calendar path used to be silent', async () => {
    loads.mockReturnValue([pair({ id: 'l9' })])
    render(<ApptsPage />)

    // The pickup on `pair` is already NEED; move the DELIVERY (exact, 14:30) to NEED.
    fireEvent.click(screen.getAllByTitle(/Set this time/)[1])
    fireEvent.change(screen.getByLabelText('Appointment type'), { target: { value: 'tbd' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(notifyApptNeeded).toHaveBeenCalled())
    const arg = notifyApptNeeded.mock.calls[0][0]
    expect(arg.stopKind).toBe('delivery')
    expect(arg.kind).toBe('needed')
    expect(arg.actorName).toBe('ryne@bcatcorp.com')
  })

  it('replies in the thread when a time changes on a stop already asked about', async () => {
    loads.mockReturnValue([load({ id: 'l10', stops: [
      stop({ id: 'p', type: 'pickup', apptType: 'tbd', apptThreadTs: 'TS-123',
             appt: fromDateInput('2099-01-01') }),
    ] })])
    render(<ApptsPage />)

    fireEvent.click(screen.getAllByTitle(/Set this time/)[0])
    fireEvent.change(screen.getByLabelText('Appointment time'), { target: { value: '09:15' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(notifyApptNeeded).toHaveBeenCalled())
    const arg = notifyApptNeeded.mock.calls[0][0]
    expect(arg.kind).toBe('updated')
    expect(arg.threadTs).toBe('TS-123')
    expect(arg.apptLabel).toContain('09:15')
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
describe('booking screenshots', () => {
  it('opens the proof panel with E2Open + email slots for both stops (Batory)', () => {
    loads.mockReturnValue([pair({ id: 'l7', aljexId: 'PROOFS', customer: 'Batory Foods' })])
    render(<ApptsPage />)
    fireEvent.click(screen.getByLabelText('Show booking screenshots for PROOFS'))
    const panel = screen.getByTestId('appt-proofs')
    expect(within(panel).getByText('Pickup')).toBeTruthy()
    expect(within(panel).getByText('Delivery')).toBeTruthy()
    expect(within(panel).getAllByText('E2Open update')).toHaveLength(2)
    expect(within(panel).getAllByText('Email confirmation')).toHaveLength(2)
  })

  it('shows the completeness count once screenshots exist', () => {
    loads.mockReturnValue([load({
      id: 'l8', aljexId: 'HALF', customer: 'Batory Foods',
      stops: [
        stop({ id: 'p', apptType: 'exact', appt: fromDateTimeInput('2099-01-01T09:30'),
               apptProofs: { e2open: 'appt-proofs/a', email: 'appt-proofs/b' } }),
        stop({ id: 'd', type: 'delivery', sequence: 1, apptType: 'exact', appt: fromDateTimeInput('2099-01-02T14:30') }),
      ],
    })])
    render(<ApptsPage />)
    expect(screen.getByLabelText('Show booking screenshots for HALF').textContent).toContain('2/4')
  })
})
