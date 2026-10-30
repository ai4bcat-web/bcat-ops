// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TrackingSection } from './TrackingSection'
import type { ShipmentActions } from '../useShipmentActions'
import type {
  LoadCarrierRecord, ShipmentBundle, ShipmentLoad, ShipmentRecord,
} from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

vi.mock('@/features/dashboard/FleetMiniMap', () => ({
  FleetMiniMap: ({ locations }: { locations: { truckId: string }[] }) => (
    <div data-testid="mini-map">{locations.map((l) => l.truckId).join(',')}</div>
  ),
}))

vi.mock('@/lib/apiClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/apiClient')>('@/lib/apiClient')
  return {
    ...actual,
    getTmsSettings: vi.fn(async () => ({ defaultCheckCallPlan: null })),
    listDivisions: vi.fn(async () => []),
    listCheckCallsByLoad: vi.fn(async () => []),
    listTrackingLinksByShipment: vi.fn(async () => []),
    listTruckPositions: vi.fn(async () => []),
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

describe('TrackingSection delivery ETA', () => {
  it('renders the stored delivery ETA from the active load carrier', async () => {
    render(<TrackingSection bundle={bundle} customer={null} catalog={[]} actions={actions} />)
    const eta = await screen.findByTestId('delivery-eta')
    expect(eta.textContent).toContain('ETA to delivery')
    expect(eta.textContent).toContain('Mar 3, 2026')
  })

  it('does not render a zero or placeholder ETA when the carrier has none stored', async () => {
    const noEtaCarrier = { ...loadCarrier, deliveryEtaAt: null }
    const noEtaBundle = { ...bundle, loadCarriers: [noEtaCarrier] }
    render(<TrackingSection bundle={noEtaBundle} customer={null} catalog={[]} actions={actions} />)
    await waitFor(() => expect(screen.getByTestId('last-known')).toBeInTheDocument())
    expect(screen.queryByTestId('delivery-eta')).not.toBeInTheDocument()
  })
})
