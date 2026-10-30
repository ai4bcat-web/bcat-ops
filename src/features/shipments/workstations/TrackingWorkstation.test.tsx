// @vitest-environment jsdom
/** P8-UI rebuild: Inbox · Tracking tabs — Chaine table on Tracking, conversations on Inbox. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { TrackingWorkstation } from './TrackingWorkstation'
import * as useBoardFiltersModule from '../board/useBoardFilters'
import type { UseBoardFiltersOptions } from '../board/useBoardFilters'
import type { ShipmentRow } from '../shipmentViews'
import type { ShipmentBundle, ShipmentMessageRecord, ShipmentViewRecord, CustomerRecord } from '@/types/tms'
import * as useStaffModule from '@/hooks/useStaff'

const now = Date.parse('2026-10-29T12:00:00Z')
const mocks = vi.hoisted(() => ({ customers: [] as CustomerRecord[] }))
const api = vi.hoisted(() => ({
  getShipmentBundle: vi.fn(),
  getTmsSettings: vi.fn(),
  listTrackingLinksByShipment: vi.fn(),
  listShipmentMessages: vi.fn(),
  saveShipmentView: vi.fn(),
  archiveShipmentView: vi.fn(),
  sendCustomerLink: vi.fn(),
  revokeCustomerLink: vi.fn(),
  sendShipmentMessage: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
const refresh = vi.fn(async () => {})
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))
let shipments: ShipmentRow[] = []
const views: ShipmentViewRecord[] = []
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { email: 'rep@bcatcorp.com', userId: 'rep@bcatcorp.com', groups: ['ADMIN'] },
    isAdmin: true,
    isOwner: false,
  }),
}))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: mocks.customers, locations: [] }) }))
vi.mock('@/hooks/useShipments', () => ({ useShipments: () => ({ shipments, loading: false, error: null, refresh }) }))
vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ nameOf: () => 'Dana Carr', me: null }) }))
vi.mock('@/features/tms/useShipmentViews', () => ({ useShipmentViews: () => ({ views, refresh }) }))

function row(id: string, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id,
    number: id,
    status: 'DISPATCHED',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'FTL',
    source: 'MANUAL',
    originCity: 'Austin, TX',
    destinationCity: 'Dallas, TX',
    pickupAppt: '2026-10-29T14:00:00Z',
    deliveryAppt: '2026-10-30T10:00:00Z',
    createdBy: 'rep@bcatcorp.com',
    updatedBy: 'rep@bcatcorp.com',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...patch,
  }
}

const active = row('S001', {
  lastUpdateAt: '2026-10-29T11:00:00Z',
  lastUpdatePlace: 'Waco, TX',
  trackingProvider: 'LINK',
  nextCheckCallAt: '2026-10-29T09:00:00Z',
  dispatcherAssignedId: 'rep-1',
  carrierName: 'Pronto Trucking',
  carrierMc: '123456',
  carrierDot: '998877',
  dispatcherAssignedName: 'Dana Carr',
  salesRepName: 'Ryne',
  customerRepName: 'Maria',
})

const moving = row('S-MOVING', {
  status: 'IN_TRANSIT',
  lastUpdateAt: '2026-10-29T11:55:00Z',
  lastUpdatePlace: 'Waco, TX',
  previousUpdateAt: '2026-10-29T11:30:00Z',
  previousUpdatePlace: 'Hillsboro, TX',
  carrierName: 'Pronto Trucking',
  carrierMc: '123456',
  stops: [
    { id: 'pu', type: 'pickup', appt: '2026-10-29T14:00:00Z', address: { city: 'Austin', state: 'TX', lat: 30.2672, lng: -97.7431 } },
    { id: 'de', type: 'delivery', appt: '2026-10-30T10:00:00Z', address: { city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.797 } },
  ],
  // Ping coordinates land with the data projection; cast until ShipmentRow types them.
  ...({ lastKnownLat: 31.5493, lastKnownLng: -97.1467 } as Partial<ShipmentRow>),
})

const stopped = row('S-STOPPED', {
  status: 'IN_TRANSIT',
  lastUpdateAt: '2026-10-29T11:55:00Z',
  lastUpdatePlace: 'Waco, TX',
  previousUpdateAt: '2026-10-29T11:30:00Z',
  previousUpdatePlace: 'Waco, TX',
})

const noSignal = row('S-NOSIGNAL', {
  status: 'IN_TRANSIT',
  lastUpdateAt: '2026-10-29T06:00:00Z',
  lastUpdatePlace: 'Waco, TX',
})

const flagged = row('S-FLAGGED', {
  status: 'IN_TRANSIT',
  trackingFlaggedAt: '2026-10-29T11:00:00Z',
  trackingFlagReason: 'Driver did not reply to escalation SMS',
})

const delivered = row('S002', { status: 'DELIVERED', deliveredAt: '2026-10-29T10:00:00Z' })

const bundle: ShipmentBundle = {
  shipment: active,
  loads: [{
    id: 'load-1',
    shipmentId: active.id,
    loadNumber: 'S001-1',
    status: 'DISPATCHED',
    updatedAt: '2026-10-29T11:00:00Z',
    stops: [
      { id: 'stop-pu', type: 'pickup', appt: '2026-10-29T14:00:00Z', sequence: 0, driverId: null, address: { city: 'Austin', state: 'TX', lat: 30.2672, lng: -97.7431 } },
      { id: 'stop-de', type: 'delivery', appt: '2026-10-30T10:00:00Z', sequence: 1, driverId: null, address: { city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.7970 } },
    ],
  }],
  orders: [],
  loadCarriers: [{
    id: 'carrier-1',
    loadId: 'load-1',
    shipmentId: active.id,
    status: 'ACTIVE',
    kind: 'CARRIER',
    driverName: 'Jake',
    driverPhone: '+1-555-0101',
    dispatcherEmail: 'dispatch@pronto.test',
    dispatcherPhone: '+1-555-0200',
  }],
  charges: [],
  financials: [],
  documents: [],
}

const message = (id: string, over: Partial<ShipmentMessageRecord> = {}): ShipmentMessageRecord => ({
  id,
  shipmentId: active.id,
  threadKey: 'thread-1',
  direction: 'OUT',
  channel: 'SMS',
  kind: 'CHECK_CALL',
  status: 'SENT',
  body: 'Where are you?',
  at: '2026-10-29T11:00:00Z',
  createdBy: 'system',
  createdAt: '2026-10-29T11:00:00Z',
  updatedAt: '2026-10-29T11:00:00Z',
  ...over,
})

function Destination() {
  const location = useLocation()
  return <p>{location.pathname}{location.search}</p>
}

function Probe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output data-testid="location">{location.pathname}{location.search}</output>
      <button type="button" data-testid="go-back" onClick={() => navigate(-1)}>back</button>
    </>
  )
}

function renderPage(initial = '/tms/tracking') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/tms/tracking" element={<><TrackingWorkstation /><Probe /></>} />
        <Route path="/tms/tracking/links" element={<Destination />} />
        <Route path="/tms/shipments/:id" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  )
}

function trackingRow(id: string): HTMLElement {
  const el = document.querySelector(`[data-testid="tracking-row"][data-shipment-id="${id}"]`)
  if (!el) throw new Error(`tracking row ${id} not rendered`)
  return el as HTMLElement
}

function inboxRow(id: string): HTMLElement {
  const el = document.querySelector(`[data-testid="inbox-thread-row"][data-shipment-id="${id}"]`)
  if (!el) throw new Error(`inbox conversation ${id} not rendered`)
  return el as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.setSystemTime(now)
  localStorage.clear()
  mocks.customers = []
  shipments = [active, moving, stopped, noSignal, flagged, delivered]
  api.getTmsSettings.mockResolvedValue(null)
  api.listTrackingLinksByShipment.mockResolvedValue([])
  api.getShipmentBundle.mockResolvedValue(bundle)
  api.listShipmentMessages.mockResolvedValue([message('m1'), message('m2', { direction: 'IN', body: 'In Dallas' })])
  api.saveShipmentView.mockResolvedValue({ slug: 'evening-desk' })
  api.sendShipmentMessage.mockResolvedValue({ message: message('sent') })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('TrackingWorkstation tabs', () => {
  it('keeps Inbox · Tracking tabs and drops Booking', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())
    expect(screen.getByRole('tab', { name: 'Inbox' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Tracking' })).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Booking' })).not.toBeInTheDocument()
  })

  it('opens the Inbox from ?tab=inbox and the table from ?tab=tracking', async () => {
    renderPage('/tms/tracking?tab=inbox')
    await waitFor(() => expect(screen.getByTestId('inbox-thread-row')).toBeInTheDocument())
    cleanup()

    renderPage('/tms/tracking?tab=tracking')
    await waitFor(() => expect(screen.getAllByTestId('tracking-row').length).toBeGreaterThan(0))
  })
})

describe('TrackingWorkstation table', () => {
  it('renders Chaine columns with stable verification attributes', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())

    for (const header of ['Shipment #', 'Origin', 'Destination', 'Status', 'Tracking & Last Location', 'Motion', 'Next Stop', 'Team Members', 'Carrier DOT/MC']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeVisible()
    }
    const rows = document.querySelectorAll('[data-testid="tracking-row"]')
    // The delivered row is Closed; the Active set shows the other five.
    expect(rows).toHaveLength(5)
    rows.forEach((el) => {
      expect(el).toHaveAttribute('data-status')
      expect(el).toHaveAttribute('data-shipment-id')
    })
    // In-transit statuses surface as DEPARTED for verification.
    const departed = document.querySelectorAll('[data-testid="tracking-row"][data-status="DEPARTED"]')
    expect(departed.length).toBeGreaterThanOrEqual(4)
  })

  it('toggles Active and Closed row sets', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())
    expect(screen.queryByRole('button', { name: 'S002' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Closed', exact: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'S002' })).toBeVisible())
    expect(screen.queryByRole('button', { name: 'S001' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Active', exact: true }))
    expect(screen.getByRole('button', { name: 'S001' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'S002' })).not.toBeInTheDocument()
  })

  it('computes Motion from two pings: Moving, Stopped and No signal', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Moving')).toBeVisible())
    expect(screen.getByText('Stopped')).toBeVisible()
    expect(screen.getAllByText('No signal').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the next event relative to the appointment', async () => {
    renderPage()
    await waitFor(() => expect(screen.getAllByText('Pickup starts in 2 h').length).toBeGreaterThanOrEqual(1))
  })

  it('shows a tracking escalation flag on a flagged shipment', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Tracking flag')).toBeVisible())
  })

  it('projects next-stop miles and ETA from the last ping', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())
    const cell = within(trackingRow(moving.id)).getByText(/mi · ETA/)
    expect(cell).toBeVisible()
  })

  it('shows team members and carrier DOT/MC', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())
    const s001 = within(trackingRow('S001'))
    expect(s001.getByText('Dana Carr · Ryne · Maria')).toBeInTheDocument()
    expect(s001.getByText('Pronto Trucking')).toBeInTheDocument()
    expect(s001.getByText(/DOT 998877 · MC 123456/)).toBeInTheDocument()
  })

  it('sorts by a column header', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())
    fireEvent.click(screen.getByRole('columnheader', { name: 'Shipment #' }))
    // Ascending: letters collate before digits, so S-FLAGGED leads.
    expect(document.querySelectorAll('[data-testid="tracking-row"]')[0]).toHaveAttribute('data-shipment-id', 'S-FLAGGED')
    fireEvent.click(screen.getByRole('columnheader', { name: 'Shipment #' }))
    // Descending reverses the set.
    expect(document.querySelectorAll('[data-testid="tracking-row"]')[0]).toHaveAttribute('data-shipment-id', 'S001')
  })

  it('opens the shipment Tracking tab on row click', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())
    fireEvent.click(trackingRow(moving.id))
    await waitFor(() => expect(screen.getByText(`/tms/shipments/${moving.id}?tab=tracking`)).toBeInTheDocument())
  })

  it('navigates Manage links to the Customer Links page', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: /Manage links/i }))
    await waitFor(() => expect(screen.getByText('/tms/tracking/links')).toBeInTheDocument())
  })
})

describe('TrackingWorkstation inbox', () => {
  it('lists conversations with shipment ids, previews and counts', async () => {
    renderPage('/tms/tracking?tab=inbox')
    await waitFor(() => expect(screen.getAllByTestId('inbox-thread-row').length).toBe(5))
    const s001 = inboxRow('S001')
    expect(within(s001).getByText('Acme Freight')).toBeInTheDocument()
    expect(within(s001).getByText('In Dallas')).toBeInTheDocument()
    expect(within(s001).getByText('2')).toBeInTheDocument()
  })

  it('selects a conversation into ?shipment= and frames the shared thread', async () => {
    renderPage('/tms/tracking?tab=inbox')
    await waitFor(() => expect(screen.getAllByTestId('inbox-thread-row').length).toBe(5))
    // Landing without a deep link falls back to the first conversation in the URL.
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=inbox&shipment=S001'))

    fireEvent.click(inboxRow(moving.id))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`?tab=inbox&shipment=${moving.id}`))
    expect(inboxRow(moving.id)).toHaveClass('tms-active')
    await waitFor(() => expect(screen.getByTestId('inbox-conversation')).toBeInTheDocument())
    expect(screen.getByText('Where are you?')).toBeVisible()
  })

  it('honours the ?tab=inbox&shipment= deep link', async () => {
    renderPage(`/tms/tracking?tab=inbox&shipment=${stopped.id}`)
    await waitFor(() => expect(screen.getAllByTestId('inbox-thread-row').length).toBe(5))
    expect(inboxRow(stopped.id)).toHaveClass('tms-active')
    await waitFor(() => expect(api.getShipmentBundle).toHaveBeenCalledWith(stopped.id))
  })

  it('sends a manual SMS to the driver from the composer', async () => {
    renderPage('/tms/tracking?tab=inbox')
    await waitFor(() => expect(screen.getByTestId('inbox-composer')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Message body'), { target: { value: 'Where are you?' } })
    fireEvent.click(screen.getByRole('button', { name: /Send/i }))

    await waitFor(() => expect(api.sendShipmentMessage).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: active.id,
      channel: 'SMS',
      to: '+1-555-0101',
      subject: null,
      body: 'Where are you?',
      party: 'DRIVER',
    })))
  })
})

describe('TrackingWorkstation board filter viewer', () => {
  it('passes the signed-in viewer to useBoardFilters', async () => {
    const calls: UseBoardFiltersOptions[] = []
    const actual = useBoardFiltersModule.useBoardFilters
    const spy = vi.spyOn(useBoardFiltersModule, 'useBoardFilters').mockImplementation((options: UseBoardFiltersOptions) => {
      calls.push(options)
      return actual(options)
    })

    const me = { id: 'rep@bcatcorp.com', email: 'rep@bcatcorp.com', teamKeys: ['trackers'] }
    const team = { key: 'trackers', name: 'Tracking', memberIds: ['rep@bcatcorp.com', 'morgan@bcatcorp.com'] }
    vi.spyOn(useStaffModule, 'useStaff').mockReturnValue({
      staff: [me],
      byId: { 'rep@bcatcorp.com': me },
      loading: false,
      error: null,
      refresh: vi.fn(),
      nameOf: (id: string | null) => (id ? String(id).split('@')[0] : '—'),
      me,
    })
    api.getTmsSettings.mockResolvedValue({ teams: [team] })

    renderPage()
    await waitFor(() => {
      expect(calls.at(-1)?.viewer?.userId).toBe('rep@bcatcorp.com')
      expect(calls.at(-1)?.viewer?.teamRepIds).toContain('morgan@bcatcorp.com')
    })

    spy.mockRestore()
  })
})
