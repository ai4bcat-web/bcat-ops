// @vitest-environment jsdom
/**
 * Render test for the Dispatch workstation body.
 *
 * The data-fetching shell is mocked away; these tests exercise the coverage queue,
 * chip rendering and pane selection with realistic row shapes.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

import { DispatchBody } from './DispatchWorkstation'
import type { CarrierRecord, CustomerRecord, LoadCarrierRecord, ShipmentBundle, ShipmentRow, TmsSettings } from '@/types/tms'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub

const customers: CustomerRecord[] = [
  { id: 'cust-1', name: 'Acme Freight', status: 'ACTIVE', createdBy: 'test', updatedBy: 'test', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

const activeLegsByShipment: Record<string, LoadCarrierRecord> = {
  'ship-2': {
    id: 'lc-2',
    loadId: 'load-2',
    shipmentId: 'ship-2',
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierId: 'carrier-2',
    carrierName: 'Beta Trucking',
    carrierMc: 'MC654321',
    carrierRateCents: 175_000,
    rateConStatus: 'NOT_SENT',
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: '2026-10-28T12:00:00Z',
    updatedAt: '2026-10-28T12:00:00Z',
  },
  'ship-3': {
    id: 'lc-3',
    loadId: 'load-3',
    shipmentId: 'ship-3',
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierId: 'carrier-3',
    carrierName: 'Gamma Lines',
    carrierMc: 'MC987654',
    carrierRateCents: 200_000,
    dispatchedAt: '2026-10-28T06:00:00Z',
    rateConStatus: 'SIGNED',
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: '2026-10-28T06:00:00Z',
    updatedAt: '2026-10-28T06:00:00Z',
  },
}

const rows: ShipmentRow[] = [
  {
    id: 'ship-1',
    number: 'PRO-001',
    status: 'OPEN',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'TL',
    source: 'MANUAL',
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: '2026-10-28T08:00:00Z',
    updatedAt: '2026-10-28T08:00:00Z',
    originCity: 'Dallas',
    destinationCity: 'Phoenix',
    fromState: 'TX',
    toState: 'AZ',
    shipDate: '2026-10-30T08:00:00Z',
    equipmentType: 'Van',
    commodity: 'Widgets',
    revenueCents: 250_000,
  } as ShipmentRow,
  {
    id: 'ship-2',
    number: 'PRO-002',
    status: 'BOOKED',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'TL',
    source: 'MANUAL',
    assignmentType: 'CARRIER',
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: '2026-10-28T08:00:00Z',
    updatedAt: '2026-10-28T08:00:00Z',
    originCity: 'Houston',
    destinationCity: 'Denver',
    fromState: 'TX',
    toState: 'CO',
    shipDate: '2026-10-29T08:00:00Z',
    equipmentType: 'Reefer',
    commodity: 'Produce',
    revenueCents: 300_000,
  } as ShipmentRow,
  {
    id: 'ship-3',
    number: 'PRO-003',
    status: 'DISPATCHED',
    customerId: 'cust-1',
    customerName: 'Acme Freight',
    mode: 'TL',
    source: 'MANUAL',
    assignmentType: 'CARRIER',
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: '2026-10-28T08:00:00Z',
    updatedAt: '2026-10-28T08:00:00Z',
    originCity: 'Austin',
    destinationCity: 'Seattle',
    fromState: 'TX',
    toState: 'WA',
    shipDate: '2026-10-29T12:00:00Z',
    equipmentType: 'Flatbed',
    commodity: 'Steel',
    revenueCents: 400_000,
  } as ShipmentRow,
]

const carriers: CarrierRecord[] = [
  {
    id: 'carrier-1',
    name: 'Alpha Freight',
    type: 'TL',
    status: 'ACTIVE',
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as CarrierRecord,
]

const settings: TmsSettings | null = null

function refreshAll() {
  return Promise.resolve()
}

const emptyBundle: ShipmentBundle = {
  shipment: rows[0] as ShipmentRow,
  orders: [],
  loads: [],
  loadCarriers: [],
  charges: [],
  financials: [],
  documents: [],
  checkCalls: [],
  incidents: [],
  trackingLinks: [],
  uploads: [],
}

vi.mock('@/features/tms/useShipmentViews', () => ({
  useShipmentViews: vi.fn(() => ({ views: [], loading: false, error: null, refresh: vi.fn() })),
}))

vi.mock('@/lib/apiClient', () => ({
  getCarrierBundle: vi.fn(() => Promise.resolve({ carrier: {}, contacts: [], paymentMethods: [], documents: [], loadCarriers: [] })),
  getShipmentBundle: vi.fn(() => Promise.resolve(emptyBundle)),
  getTmsSettings: vi.fn(),
  listCarriers: vi.fn(),
  listDivisions: vi.fn(() => Promise.resolve([])),
  listLoadCarriers: vi.fn(),
}))

vi.mock('@/features/shipments/useShipmentActions', () => ({
  useShipmentActions: vi.fn(() => ({
    busy: false,
    bookCarrier: vi.fn(),
    sendRateCon: vi.fn(),
    reload: vi.fn(),
  })),
}))

vi.mock('@/features/shipments/board/BoardFilterPanel', () => ({
  BoardFilterPanel: vi.fn(() => <div data-testid="filter-panel" />),
}))

describe('DispatchWorkstation body', () => {
  it('lists the queue with the right coverage chips', () => {
    render(
      <DispatchBody
        rows={rows}
        allRows={rows}
        customers={customers}
        activeLegsByShipment={activeLegsByShipment}
        carriers={carriers}
        settings={settings}
        refreshAll={refreshAll}
      />,
    )

    const cards = screen.getAllByTestId('coverage-card')
    expect(cards).toHaveLength(3)

    expect(screen.getByText('Needs coverage')).toBeInTheDocument()
    expect(screen.getByText('Covered')).toBeInTheDocument()
    expect(screen.getByText('Dispatched')).toBeInTheDocument()
  })

  it('opens the Find coverage pane when a card is selected', async () => {
    render(
      <DispatchBody
        rows={rows}
        allRows={rows}
        customers={customers}
        activeLegsByShipment={activeLegsByShipment}
        carriers={carriers}
        settings={settings}
        refreshAll={refreshAll}
      />,
    )

    const cards = screen.getAllByTestId('coverage-card')
    fireEvent.click(cards[0])

    await waitFor(() => {
      expect(screen.getByText('Covering now')).toBeInTheDocument()
    })
    expect(screen.getByText('Suggested carriers')).toBeInTheDocument()
    expect(
      screen.getByText('Carrier offers parsed from e-mail and text arrive with Step P.'),
    ).toBeInTheDocument()
  })
})
