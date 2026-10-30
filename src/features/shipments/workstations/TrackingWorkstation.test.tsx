// @vitest-environment jsdom
/** P8-UI: the tracking workstation renders real data across Inbox, Tracking and Booking tabs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { TrackingWorkstation } from './TrackingWorkstation'
import * as useBoardFiltersModule from '../board/useBoardFilters'
import type { UseBoardFiltersOptions } from '../board/useBoardFilters'
import type { ShipmentRow } from '../shipmentViews'
import type { ShipmentBundle, ShipmentMessageRecord, ShipmentPostingRecord, ShipmentViewRecord, TrackingLinkRecord, CustomerRecord } from '@/types/tms'
import * as useStaffModule from '@/hooks/useStaff'

const now = Date.parse('2026-10-29T12:00:00Z')
const mocks = vi.hoisted(() => ({ customers: [] as CustomerRecord[] }))
const api = vi.hoisted(() => ({
  getShipmentBundle: vi.fn(),
  getTmsSettings: vi.fn(),
  listCarrierPingLinks: vi.fn(),
  listTrackingLinksByShipment: vi.fn(),
  listShipmentMessages: vi.fn(),
  listCarrierOffers: vi.fn(),
  listActivePostings: vi.fn(),
  assignCarrier: vi.fn(),
  sendSetupPacket: vi.fn(),
  logCheckCall: vi.fn(),
  textDriver: vi.fn(),
  saveShipmentView: vi.fn(),
  archiveShipmentView: vi.fn(),
  sendTrackingLink: vi.fn(),
  revokeTrackingLink: vi.fn(),
  sendCustomerLink: vi.fn(),
  revokeCustomerLink: vi.fn(),
  sendShipmentMessage: vi.fn(),
  saveLoadCheckCallPlan: vi.fn(),
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
})

const moving = row('S-MOVING', {
  lastUpdateAt: '2026-10-29T11:55:00Z',
  lastUpdatePlace: 'Waco, TX',
  previousUpdateAt: '2026-10-29T11:30:00Z',
  previousUpdatePlace: 'Hillsboro, TX',
})

const stopped = row('S-STOPPED', {
  lastUpdateAt: '2026-10-29T11:55:00Z',
  lastUpdatePlace: 'Waco, TX',
  previousUpdateAt: '2026-10-29T11:30:00Z',
  previousUpdatePlace: 'Waco, TX',
})

const noSignal = row('S-NOSIGNAL', {
  lastUpdateAt: '2026-10-29T06:00:00Z',
  lastUpdatePlace: 'Waco, TX',
})

const flagged = row('S-FLAGGED', {
  trackingFlaggedAt: '2026-10-29T11:00:00Z',
  trackingFlagReason: 'Driver did not reply to escalation SMS',
})

const delivered = row('S002', { status: 'DELIVERED', deliveredAt: '2026-10-29T10:00:00Z' })
const liveLink = {
  id: 'link-1',
  shipmentId: active.id,
  kind: 'CARRIER_PING',
  status: 'ACTIVE',
  expiresAt: '2026-10-30T12:00:00Z',
  loadId: 'load-1',
  loadCarrierId: 'carrier-1',
} as TrackingLinkRecord

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

const note = (id: string): ShipmentMessageRecord => message(id, { kind: 'NOTE', channel: 'EMAIL', party: 'INTERNAL', body: 'Internal note' })

const offer = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  side: 'BUY',
  status: 'OPEN',
  quoteDate: '2026-10-29',
  quoteMonth: '2026-10',
  shipmentId: active.id,
  shipmentNumber: active.number,
  carrierName: 'Pronto Trucking',
  carrierMc: '123456',
  carrierEmail: 'dispatch@pronto.test',
  amountCents: 120000,
  equipmentType: 'Van',
  commodity: 'Widgets',
  pickupAppt: '2026-10-29T14:00:00Z',
  rounds: 1,
  vetting: { known: true, bookable: true, blockers: [], warnings: [], status: 'Active', mcpStatus: null },
  ...over,
})

function Destination() {
  const location = useLocation()
  return <p>{location.pathname}{location.search}</p>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tms/tracking']}>
      <Routes>
        <Route path="/tms/tracking" element={<TrackingWorkstation />} />
        <Route path="/tms/shipments/:id" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.setSystemTime(now)
  localStorage.clear()
  mocks.customers = []
  shipments = [active, moving, stopped, noSignal, flagged, delivered]
  api.getTmsSettings.mockResolvedValue(null)
  api.listCarrierPingLinks.mockResolvedValue([liveLink])
  api.listTrackingLinksByShipment.mockResolvedValue([liveLink])
  api.getShipmentBundle.mockResolvedValue(bundle)
  api.listShipmentMessages.mockResolvedValue([message('m1'), message('m2', { direction: 'IN', body: 'In Dallas' }), note('n1')])
  api.listCarrierOffers.mockResolvedValue({ offers: [offer('o1')] })
  api.listActivePostings.mockResolvedValue([{ id: 'post-1', shipmentId: active.id, provider: 'DAT', status: 'POSTED', postedAt: '2026-10-29T10:00:00Z' }] as ShipmentPostingRecord[])
  api.assignCarrier.mockResolvedValue(bundle)
  api.sendSetupPacket.mockResolvedValue({})
  api.saveShipmentView.mockResolvedValue({ slug: 'evening-desk' })
  api.sendShipmentMessage.mockResolvedValue({ message: message('sent') })
  api.saveLoadCheckCallPlan.mockResolvedValue({ plan: { intervalHours: 4, channels: ['SMS', 'EMAIL'], milestones: ['DISPATCHED', 'AT_PICKUP', 'DEPARTED_PICKUP', 'AT_DELIVERY', 'DELIVERED'], escalateAfterMinutes: 30, emailDispatcher: true, requestPodOnDelivery: true } })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('TrackingWorkstation tabs', () => {
  it('switches between Inbox, Tracking and Booking tabs', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())

    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }))
    await waitFor(() => expect(api.listShipmentMessages).toHaveBeenCalled())
    expect(screen.getByText('All messages')).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: 'Booking' }))
    await waitFor(() => expect(api.listCarrierOffers).toHaveBeenCalled())
    expect(screen.getByText('Carrier offers')).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: 'Tracking' }))
    expect(screen.getByRole('button', { name: 'S001' })).toBeVisible()
  })
})

describe('TrackingWorkstation board', () => {
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

  it('selects a shipment and opens its detail pane on row click', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'S001' })).toBeVisible())
    await waitFor(() => expect(screen.getByTestId('tracking-detail')).toBeInTheDocument())

    fireEvent.click(screen.getByText('S-MOVING').closest('tr')!)
    await waitFor(() => expect(api.getShipmentBundle).toHaveBeenCalledWith(moving.id))
    await waitFor(() => expect(screen.getByTestId('tracking-detail')).toBeInTheDocument())
  })
})

describe('TrackingWorkstation inbox', () => {
  it('lists thread messages for the selected shipment', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }))
    await waitFor(() => expect(api.listShipmentMessages).toHaveBeenCalledWith(active.id))
    await waitFor(() => expect(screen.getByText('Where are you?')).toBeVisible())
    expect(screen.getByText('In Dallas')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Team notes' }))
    await waitFor(() => expect(screen.getByText('Internal note')).toBeVisible())
    expect(screen.queryByText('Where are you?')).not.toBeInTheDocument()
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

describe('TrackingWorkstation booking', () => {
  it('lists offers with their vetting state', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Booking' }))
    await waitFor(() => expect(api.listCarrierOffers).toHaveBeenCalledWith(active.id))
    expect(screen.getByText('Pronto Trucking')).toBeVisible()
    expect(screen.getByText('Bookable')).toBeVisible()
    expect(screen.getByText('MC 123456')).toBeVisible()
  })
})

describe('TrackingWorkstation detail pane', () => {
  it('renders the detail pane for the selected row with map, ETA, cadence and thread', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('tracking-detail')).toBeInTheDocument())
    await waitFor(() => expect(api.getShipmentBundle).toHaveBeenCalledWith(active.id))
    await waitFor(() => expect(api.listShipmentMessages).toHaveBeenCalledWith(active.id))

    expect(screen.getByText('Map & ETA')).toBeVisible()
    expect(screen.getByText(/Map not configured/i)).toBeInTheDocument()
    expect(screen.getByText('Check-call plan')).toBeVisible()
    expect(screen.getByText('Thread — S001')).toBeVisible()
    expect(screen.getByTestId('detail-thread')).toBeInTheDocument()
  })

  it('shows the delivery ETA from the stored value', async () => {
    const etaBundle = {
      ...bundle,
      loadCarriers: [{ ...bundle.loadCarriers[0], deliveryEtaAt: '2026-10-30T09:30:00Z' }],
    }
    api.getShipmentBundle.mockResolvedValue(etaBundle)

    renderPage()
    await waitFor(() => expect(screen.getByTestId('detail-eta')).toHaveTextContent('Oct 30, 2026'))
  })

  it('labels a thread row as agent vs person with the person name', async () => {
    api.listShipmentMessages.mockResolvedValue([
      message('m-agent', { authorKind: 'AGENT', body: 'Auto check call' }),
      message('m-person', { authorKind: 'PERSON', authorName: 'Maria Lopez', body: 'Driver called me' }),
    ])

    renderPage()
    await waitFor(() => expect(screen.getByTestId('detail-thread')).toBeInTheDocument())
    const authors = screen.getAllByTestId('thread-author')
    expect(authors[0]).toHaveTextContent('Agent')
    expect(authors[1]).toHaveTextContent('Person — Maria')
  })

  it('sends a manual SMS to the driver', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('thread-composer')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Message body'), { target: { value: 'Where are you?' } })
    fireEvent.click(screen.getByRole('button', { name: /Send/i }))

    await waitFor(() => expect(api.sendShipmentMessage).toHaveBeenCalledWith({
      shipmentId: active.id,
      channel: 'SMS',
      to: '+1-555-0101',
      subject: null,
      body: 'Where are you?',
    }))
  })

  it('sends a manual e-mail to the dispatcher', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('thread-composer')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'dispatcher' } })
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'EMAIL' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Update needed' } })
    fireEvent.change(screen.getByLabelText('Message body'), { target: { value: 'Please send location' } })
    fireEvent.click(screen.getByRole('button', { name: /Send/i }))

    await waitFor(() => expect(api.sendShipmentMessage).toHaveBeenCalledWith({
      shipmentId: active.id,
      channel: 'EMAIL',
      to: 'dispatch@pronto.test',
      subject: 'Update needed',
      body: 'Please send location',
    }))
  })

  it('greys out VOICE with the deferred reason', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Channel')).toBeInTheDocument())
    const voice = screen.getByRole('option', { name: /voice is not switched on yet/i })
    expect(voice).toBeDisabled()
  })

  it('shows the exception banner for a flagged shipment in both panes', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Tracking flag')).toBeVisible())

    fireEvent.click(screen.getByText(flagged.number).closest('tr')!)
    await waitFor(() => expect(api.getShipmentBundle).toHaveBeenCalledWith(flagged.id))
    await waitFor(() => expect(screen.getByTestId('detail-flag')).toBeInTheDocument())
    expect(screen.getByTestId('detail-flag')).toHaveTextContent('Driver did not reply to escalation SMS')
  })

  it('saves the cadence and shows its inheritance source', async () => {
    mocks.customers = [{
      id: active.customerId,
      name: 'Acme Freight',
      checkCallPlan: { intervalHours: 2, channels: ['SMS'], milestones: ['DISPATCHED'], escalateAfterMinutes: 15, emailDispatcher: false, requestPodOnDelivery: false },
    } as CustomerRecord]

    renderPage()
    await waitFor(() => expect(screen.getByTestId('plan-source')).toHaveTextContent('Inherited from Acme Freight'))

    fireEvent.change(screen.getByLabelText('Interval (hours)'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: /Save plan/i }))

    await waitFor(() => expect(api.saveLoadCheckCallPlan).toHaveBeenCalledWith(expect.objectContaining({
      loadId: 'load-1',
      plan: expect.objectContaining({ intervalHours: 6 }),
    })))
  })
})
