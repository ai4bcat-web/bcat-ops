// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AuthContext } from '@/hooks/useAuth'
import { TrackingSection } from './TrackingSection'
import type { ShipmentActions } from '../useShipmentActions'
import type {
  LoadCarrierRecord, ShipmentBundle, ShipmentLoad, ShipmentMessageRecord, ShipmentRecord,
} from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const listShipmentMessages = vi.hoisted(() => vi.fn(async () => [] as ShipmentMessageRecord[]))
const sendShipmentMessage = vi.hoisted(() => vi.fn(async () => ({ message: {} })))
const runCheckCallPlan = vi.hoisted(() => vi.fn(async () => ({ action: 'CADENCE', reason: 'Load is IN_TRANSIT and due for a check call', messages: [], nextDueAt: null })))
const requestPod = vi.hoisted(() => vi.fn(async () => ({ messages: [] })))

vi.mock('@/lib/apiClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/apiClient')>('@/lib/apiClient')
  return {
    ...actual,
    getTmsSettings: vi.fn(async () => ({ defaultCheckCallPlan: null })),
    listDivisions: vi.fn(async () => []),
    listCheckCallsByLoad: vi.fn(async () => []),
    listTrackingLinksByShipment: vi.fn(async () => []),
    listTruckPositions: vi.fn(async () => []),
    listShipmentMessages,
    sendShipmentMessage,
    runCheckCallPlan,
    requestPod,
    saveLoadCheckCallPlan: vi.fn(async () => ({ plan: null })),
  }
})

const load: ShipmentLoad = {
  id: 'load-1', shipmentId: 'S1', loadNumber: 'S000001-1', status: 'IN_TRANSIT',
  trackingProvider: 'LINK', nextCheckCallAt: '2000-01-01T00:00:00.000Z',
  lastKnownAt: '2026-03-02T19:10:00.000Z', lastKnownCity: 'Joliet', lastKnownState: 'IL',
  lastKnownSource: 'LINK', updatedAt: '2026-03-02T19:10:00.000Z',
} as ShipmentLoad

const loadCarrier: LoadCarrierRecord = {
  id: 'lc-1', loadId: 'load-1', shipmentId: 'S1', kind: 'CARRIER', status: 'ACTIVE',
  carrierName: 'Acme Trucking', driverName: 'Dale', driverPhone: '+13125550101',
  deliveryEtaAt: '2026-03-03T12:00:00.000Z',
  createdBy: 'rep@bcatcorp.com', updatedAt: '2026-03-02T13:00:00.000Z',
} as LoadCarrierRecord

const shipment = {
  id: 'S1', number: 'S000001', status: 'IN_TRANSIT', customerId: 'c1', customerName: 'Acme Freight',
  mode: 'FTL', source: 'MANUAL', version: 4, createdBy: 'a@b.c', updatedBy: 'a@b.c',
  createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T19:10:00.000Z',
} as ShipmentRecord

const bundle: ShipmentBundle = {
  shipment, orders: [], loads: [load], loadCarriers: [loadCarrier], charges: [], financials: [],
}

const actions = {
  busy: false,
  tracking: {
    logCheckCall: vi.fn(async () => {}),
    resolveIncident: vi.fn(async () => {}),
    setNextCheckCall: vi.fn(async () => {}),
    setEta: vi.fn(async () => {}),
  },
  reload: vi.fn(async () => {}),
} as unknown as ShipmentActions

function renderTab(withUser = false) {
  const value = withUser
    ? ({ user: { userId: 'u1', email: 'maria.gomez@bcatcorp.com', groups: [] }, loading: false, needsNewPassword: false, isAdmin: false } as never)
    : null
  return render(
    <AuthContext.Provider value={value}>
      <TrackingSection bundle={bundle} customer={null} catalog={[]} actions={actions} />
    </AuthContext.Provider>,
  )
}

describe('TrackingSection delivery ETA', () => {
  it('renders the stored delivery ETA from the active load carrier', async () => {
    renderTab()
    const eta = await screen.findByTestId('delivery-eta')
    expect(eta.textContent).toContain('ETA to delivery')
    expect(eta.textContent).toContain('Mar 3, 2026')
  })

  it('does not render a zero or placeholder ETA when the carrier has none stored', async () => {
    const noEtaCarrier = { ...loadCarrier, deliveryEtaAt: null }
    const noEtaBundle = { ...bundle, loadCarriers: [noEtaCarrier] }
    render(
      <AuthContext.Provider value={null}>
        <TrackingSection bundle={noEtaBundle} customer={null} catalog={[]} actions={actions} />
      </AuthContext.Provider>,
    )
    await waitFor(() => expect(screen.getByTestId('last-known')).toBeInTheDocument())
    expect(screen.queryByTestId('delivery-eta')).not.toBeInTheDocument()
  })
})

describe('TrackingSection shared detail pane', () => {
  it('mounts the shared map, ETA, cadence and thread sections', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTestId('tracking-detail-map')).toBeInTheDocument())
    expect(screen.getByTestId('tracking-eta')).toBeInTheDocument()
    expect(screen.getByTestId('tracking-cadence')).toBeInTheDocument()
    expect(screen.getByTestId('tracking-thread')).toBeInTheDocument()
  })

  it('computes the ETA from the last ping against the delivery appointment and labels the basis', async () => {
    const pingLoad = {
      ...load,
      lastKnownLat: 41.525, lastKnownLng: -88.0817,
      stops: [{
        id: 'st-1', type: 'delivery', name: 'Consignee', city: 'Dallas, TX',
        address: { lat: 32.7767, lng: -96.797, line1: '', city: 'Dallas', state: 'TX', postalCode: '', country: 'US' },
        appt: '2026-03-03T15:00:00.000Z', apptType: 'exact', driverId: null, sequence: 1,
      }],
    } as unknown as ShipmentLoad
    render(
      <AuthContext.Provider value={null}>
        <TrackingSection bundle={{ ...bundle, loads: [pingLoad] }} customer={null} catalog={[]} actions={actions} />
      </AuthContext.Provider>,
    )

    const eta = await screen.findByTestId('tracking-eta')
    // The stored carrier ETA is deliberately not shown; the number comes from the ping.
    expect(eta.textContent).toContain('Estimate — straight-line × 1.15 at 50 mph from the last ping')
    expect(eta.textContent).toContain('887 mi')
    expect(eta.textContent).toContain('Appointment Tue, Mar 3, 2026, 09:00')
    // A ping that old can only be projected to the clamp, and it is honestly reported late
    // rather than back-dated to an arrival that never happened.
    expect(eta.textContent).toMatch(/\d+ min late/)
  })

  it('draws the last position and the route to the consignee with no Google key', async () => {
    const pingLoad = {
      ...load,
      lastKnownLat: 41.525, lastKnownLng: -88.0817,
      stops: [{
        id: 'st-1', type: 'delivery', name: 'Consignee', city: 'Dallas, TX',
        address: { lat: 32.7767, lng: -96.797, line1: '', city: 'Dallas', state: 'TX', postalCode: '', country: 'US' },
        appt: '2026-03-03T15:00:00.000Z', apptType: 'exact', driverId: null, sequence: 1,
      }],
    } as unknown as ShipmentLoad
    render(
      <AuthContext.Provider value={null}>
        <TrackingSection bundle={{ ...bundle, loads: [pingLoad] }} customer={null} catalog={[]} actions={actions} />
      </AuthContext.Provider>,
    )

    const map = await screen.findByTestId('tracking-detail-map')
    // The fallback carries the real geometry, not a "not configured" notice.
    await waitFor(() => expect(map.querySelector('svg')).toBeInTheDocument())
    expect(map.querySelector('line')).toBeInTheDocument()
    expect(map.textContent).not.toContain('Map not configured')
  })

  it('labels each thread row agent or person and previews the server signature', async () => {
    listShipmentMessages.mockResolvedValueOnce([
      { id: 'm1', shipmentId: 'S1', channel: 'SMS', direction: 'OUT', status: 'SENT', at: '2026-03-02T19:00:00.000Z', body: 'Check', authorKind: 'AGENT', authorName: 'BCAT Tracking Assistant' },
      { id: 'm2', shipmentId: 'S1', channel: 'SMS', direction: 'IN', status: 'RECEIVED', at: '2026-03-02T19:05:00.000Z', body: 'Rolling', authorKind: 'PERSON', authorName: 'Maria Gomez' },
    ] as ShipmentMessageRecord[])
    renderTab(true)

    await waitFor(() => expect(screen.getByTestId('detail-thread')).toBeInTheDocument())
    const authors = screen.getAllByTestId('thread-author')
    expect(authors[0]).toHaveTextContent('Agent')
    expect(authors[1]).toHaveTextContent('Person — Maria')
    expect(screen.getByTestId('signature-preview')).toHaveTextContent('— Maria, BCAT Tracking')
  })

  it('preserves Run check call now: the result is shown against the plan', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTestId('tracking-cadence')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Run check call now/i }))
    await waitFor(() => expect(screen.getByTestId('run-result')).toHaveTextContent('CADENCE'))
    expect(runCheckCallPlan).toHaveBeenCalledWith({ shipmentId: 'S1' })
  })

  it('preserves Request POD from the cadence card', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTestId('tracking-cadence')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Request POD/i }))
    await waitFor(() => expect(requestPod).toHaveBeenCalledWith({ shipmentId: 'S1' }))
  })
})
