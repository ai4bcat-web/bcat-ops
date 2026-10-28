// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { TrackingSection } from './components/TrackingSection'
import { LogCheckCallDialog } from './components/LogCheckCallDialog'
import type { ShipmentActions } from './useShipmentActions'
import type {
  LoadCarrierRecord, LoadCheckCallRecord, ShipmentBundle, ShipmentLoad, ShipmentRecord, TrackingLinkRecord,
} from '@/types/tms'
import type { Stop } from '@/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

// The map pulls US boundaries over the network; the tab's own content is what is tested.
vi.mock('@/features/dashboard/FleetMiniMap', () => ({
  FleetMiniMap: ({ locations }: { locations: { truckId: string }[] }) => (
    <div data-testid="mini-map">{locations.map((l) => l.truckId).join(',')}</div>
  ),
}))

const events: LoadCheckCallRecord[] = [
  {
    id: 'cc-1', loadId: 'load-1', shipmentId: 'S1', at: '2026-03-02T15:00:00.000Z',
    type: 'DEPARTED', source: 'MANUAL', statusBefore: 'LOADING', statusAfter: 'IN_TRANSIT',
    city: 'Joliet', state: 'IL', note: 'Rolling, 40 min late', createdBy: 'rep@bcatcorp.com',
  },
  {
    id: 'cc-2', loadId: 'load-1', shipmentId: 'S1', at: '2026-03-02T18:30:00.000Z',
    type: 'INCIDENT', source: 'MANUAL', incidentType: 'BREAKDOWN', incidentOpen: 'OPEN',
    note: 'Blown tyre on I-80', createdBy: 'rep@bcatcorp.com',
  },
  {
    id: 'cc-3', loadId: 'load-1', shipmentId: 'S1', at: '2026-03-02T19:10:00.000Z',
    type: 'TRACKING_PING', source: 'LINK', lat: 41.5, lng: -88.1, createdBy: 'link:abcd1234',
  },
]

const links: TrackingLinkRecord[] = [{
  id: 'tok'.padEnd(32, 'x'), kind: 'CARRIER_PING', shipmentId: 'S1', loadId: 'load-1',
  status: 'ACTIVE', expiresAt: '2026-03-09T00:00:00.000Z', sentAt: '2026-03-02T14:00:00.000Z',
  sentTo: '+13125550101', sentVia: 'SMS', openCount: 2, createdBy: 'rep@bcatcorp.com',
}]

vi.mock('@/lib/apiClient', () => ({
  getTmsSettings: vi.fn(async () => null),
  listDivisions: vi.fn(async () => []),
  listCheckCallsByLoad: vi.fn(async () => events),
  listTrackingLinksByShipment: vi.fn(async () => links),
  listTruckPositions: vi.fn(async () => []),
  textDriver: vi.fn(async () => ({ messageId: null, smsStatus: 'NOT_CONFIGURED', smsError: null })),
  sendTrackingLink: vi.fn(),
  revokeTrackingLink: vi.fn(),
  sendCustomerLink: vi.fn(),
  revokeCustomerLink: vi.fn(),
}))

const stops: Stop[] = [
  { id: 's1', type: 'pickup', sequence: 0, appt: '2026-03-02T12:00:00.000Z', driverId: null, city: 'Chicago, IL' },
  { id: 's2', type: 'delivery', sequence: 1, appt: '2026-03-03T12:00:00.000Z', driverId: null, city: 'Dallas, TX' },
]

const load: ShipmentLoad = {
  id: 'load-1', shipmentId: 'S1', loadNumber: 'S000001-1', status: 'IN_TRANSIT',
  trackingProvider: 'LINK', nextCheckCallAt: '2000-01-01T00:00:00.000Z',
  lastKnownAt: '2026-03-02T19:10:00.000Z', lastKnownCity: 'Joliet', lastKnownState: 'IL',
  lastKnownSource: 'LINK', openIncidentCount: 1, stops, updatedAt: '2026-03-02T19:10:00.000Z',
}

const loadCarrier: LoadCarrierRecord = {
  id: 'lc-1', loadId: 'load-1', shipmentId: 'S1', kind: 'CARRIER', status: 'ACTIVE',
  carrierName: 'Acme Trucking', driverName: 'Dale', driverPhone: '+13125550101',
  dispatchedAt: '2026-03-02T13:00:00.000Z', createdBy: 'rep@bcatcorp.com', updatedAt: '2026-03-02T13:00:00.000Z',
} as LoadCarrierRecord

const shipment = {
  id: 'S1', number: 'S000001', status: 'IN_TRANSIT', customerId: 'c1', customerName: 'Acme Freight',
  mode: 'FTL', source: 'MANUAL', version: 4, createdBy: 'a@b.c', updatedBy: 'a@b.c',
  createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T19:10:00.000Z',
} as ShipmentRecord

const bundle: ShipmentBundle = {
  shipment, orders: [], loads: [load], loadCarriers: [loadCarrier], charges: [], financials: [],
}

const setNextCheckCall = vi.fn(async () => {})
const actions = {
  busy: false,
  tracking: {
    logCheckCall: vi.fn(async () => {}),
    resolveIncident: vi.fn(async () => {}),
    setNextCheckCall,
    setEta: vi.fn(async () => {}),
  },
  reload: vi.fn(async () => {}),
} as unknown as ShipmentActions

describe('TrackingSection', () => {
  it('renders every source on one timeline, newest first, with status and incident rows', async () => {
    render(<TrackingSection bundle={bundle} customer={null} catalog={[]} actions={actions} />)

    const timeline = await screen.findByTestId('tracking-timeline')
    await waitFor(() => expect(within(timeline).getAllByRole('listitem').length).toBe(4))

    const rows = within(timeline).getAllByRole('listitem')
    // Newest first: the ping, then the incident, then the departure, then the link send.
    expect(rows[0].textContent).toContain('Driver ping')
    expect(rows[1].textContent).toContain('Breakdown')
    expect(rows[2].textContent).toContain('Departed')
    expect(rows[3].textContent).toContain('Tracking link sent to the driver')

    // The call that moved the load shows what it moved it from and to.
    expect(rows[2].textContent).toContain('LDG')
    expect(rows[2].textContent).toContain('INTRAN')

    // An unresolved incident is the only row that offers Resolve.
    expect(within(timeline).getAllByRole('button', { name: /Resolve/ }).length).toBe(1)
  })

  it('colours an overdue check call and schedules a snooze from the reminder it read', async () => {
    render(<TrackingSection bundle={bundle} customer={null} catalog={[]} actions={actions} />)

    const banner = await screen.findByTestId('check-call-banner')
    expect(banner.textContent).toContain('Check call overdue since')
    expect(banner.className).toContain('text-destructive')

    fireEvent.click(within(banner).getByRole('button', { name: 'Snooze 1 h' }))
    await waitFor(() => expect(setNextCheckCall).toHaveBeenCalledTimes(1))
    expect(typeof setNextCheckCall.mock.calls[0][0]).toBe('string')
  })

  it('drops the position pins it knows onto the map', async () => {
    render(<TrackingSection bundle={bundle} customer={null} catalog={[]} actions={actions} />)
    await waitFor(() => expect(screen.getByTestId('mini-map').textContent).toContain('ping-cc-3'))
  })
})

describe('LogCheckCallDialog status preview', () => {
  const renderDialog = () => render(
    <LogCheckCallDialog
      load={{ ...load, status: 'DISPATCHED', stops }}
      loadCarrier={loadCarrier}
      catalog={[]}
      busy={false}
      onClose={vi.fn()}
      onSubmit={vi.fn(async () => {})}
      onTextDriver={vi.fn(async () => {})}
    />,
  )

  it('says nothing moves for a plain location update', () => {
    renderDialog()
    expect(screen.getByTestId('check-call-preview').textContent).toContain('Does not change the load status')
  })

  it('names the status an arrival at the first pickup would prove', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Check call type'), { target: { value: 'ARRIVED' } })
    await waitFor(() => expect(screen.getByLabelText('Check call stop')).toBeTruthy())

    expect(screen.getByTestId('check-call-preview').textContent).toContain('Moves the load to')
    expect(screen.getByTestId('check-call-preview').textContent).toContain('LOADING')
  })

  it('names IN_TRANSIT once the truck has left that pickup', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Check call type'), { target: { value: 'DEPARTED' } })
    await waitFor(() => expect(screen.getByLabelText('Check call stop')).toBeTruthy())

    expect(screen.getByTestId('check-call-preview').textContent).toContain('IN_TRANSIT')
  })
})
