// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { LaneRateSampleRecord, OrderRecord, ShipmentRecord } from '@/types/tms'
import { DashboardPage } from './DashboardPage'
import { CLASSIC_CHARTS } from './classicCharts'
import { BROKERAGE_CHARTS } from './brokerageCards'
import { clearDashboardCache } from './useBrokerageDashboard'
import { dateChipLabel, defaultFilters } from './dashboardViews'

/**
 * The page against a fixture window: the cards it draws, the chip it opens on, the
 * picker that hides one, and the CSV the export icon writes.
 *
 * The fixture rows are dated inside the current month, because the page opens on "this
 * month" from the real clock — the dashboard must still be right next March.
 */

const NOW = new Date()
const MONTH = `${NOW.getUTCFullYear()}-${String(NOW.getUTCMonth() + 1).padStart(2, '0')}`
const DAY = `${MONTH}-02`
const PICKUP = `${DAY}T12:00:00.000Z`

const shipments: ShipmentRecord[] = [
  {
    id: 's1', number: 'P1001', status: 'DELIVERED', customerId: 'cust-a', customerName: 'Acme',
    mode: 'TRUCKLOAD', source: 'MANUAL', pickupAppt: PICKUP,
    revDivision: 'BROKERAGE', salesRepId: 'rep-1',
    createdBy: 't', updatedBy: 't', createdAt: PICKUP, updatedAt: PICKUP,
  },
  {
    id: 's2', number: 'P1002', status: 'IN_TRANSIT', customerId: 'cust-b', customerName: 'Globex',
    mode: 'TRUCKLOAD', source: 'MANUAL', pickupAppt: PICKUP,
    revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', salesRepId: 'rep-2',
    createdBy: 't', updatedBy: 't', createdAt: PICKUP, updatedAt: PICKUP,
  },
]

const orders: OrderRecord[] = shipments.map((s) => ({
  id: `o-${s.id}`, shipmentId: s.id, customerId: s.customerId, mode: 'TRUCKLOAD',
  createdBy: 't', updatedBy: 't', createdAt: PICKUP, updatedAt: PICKUP,
}))

const samples: LaneRateSampleRecord[] = [
  {
    id: 'lrs-1', laneKey: 'A>B', date: DAY, loadId: 'load-s1', shipmentId: 's1',
    customerId: 'cust-a', customerName: 'Acme', carrierId: 'car-1', carrierName: 'Fast Freight',
    revDivision: 'BROKERAGE', salesRepId: 'rep-1',
    revenueCents: 150_000, costCents: 120_000, profitCents: 30_000,
    source: 'LOAD', sampledAt: PICKUP, version: 1,
  },
]

vi.mock('@/lib/apiClient', () => ({
  listShipments: vi.fn(async () => shipments),
  listOrders: vi.fn(async () => orders),
  listLoadSummaries: vi.fn(async () => [{ id: 'load-s1', shipmentId: 's1', status: 'DELIVERED' }]),
  listLoadCarriers: vi.fn(async () => []),
  listOpenInvoices: vi.fn(async () => []),
  listOpenBills: vi.fn(async () => []),
  listUserProfiles: vi.fn(async () => [
    { id: 'rep-1', email: 'dana@bcatcorp.com', name: 'Dana Reyes', createdBy: 't', updatedBy: 't', version: 1 },
  ]),
  listOwnershipDivisions: vi.fn(async () => [
    {
      id: 'BROKERAGE', code: 'BROKERAGE', name: 'BCAT Logistics', brand: 'BCAT Logistics', parentId: null, color: null,
      sortOrder: 10, active: true, owners: null, flows: null, createdBy: 't', updatedBy: 't', version: 1,
      createdAt: PICKUP, updatedAt: PICKUP,
    },
    {
      id: 'ASSETS', code: 'ASSETS', name: 'Ivan Cartage', brand: 'Ivan Cartage', parentId: null, color: null,
      sortOrder: 20, active: true, owners: null, flows: null, createdBy: 't', updatedBy: 't', version: 1,
      createdAt: PICKUP, updatedAt: PICKUP,
    },
    {
      id: 'OWNER_OPERATOR', code: 'OWNER_OPERATOR', name: 'Owner Operators', brand: null, parentId: 'ASSETS', color: null,
      sortOrder: 21, active: true, owners: null, flows: null, createdBy: 't', updatedBy: 't', version: 1,
      createdAt: PICKUP, updatedAt: PICKUP,
    },
    {
      id: 'BOX_TRUCK', code: 'BOX_TRUCK', name: 'Box Trucks', brand: null, parentId: 'ASSETS', color: null,
      sortOrder: 22, active: true, owners: null, flows: null, createdBy: 't', updatedBy: 't', version: 1,
      createdAt: PICKUP, updatedAt: PICKUP,
    },
    {
      id: 'LOCAL', code: 'LOCAL', name: 'Local Drivers', brand: null, parentId: 'ASSETS', color: null,
      sortOrder: 23, active: true, owners: null, flows: null, createdBy: 't', updatedBy: 't', version: 1,
      createdAt: PICKUP, updatedAt: PICKUP,
    },
    {
      id: 'CAR_SHIPPING', code: 'CAR_SHIPPING', name: 'Best Care Auto Transport', brand: 'Best Care Auto Transport', parentId: null, color: null,
      sortOrder: 30, active: true, owners: null, flows: null, createdBy: 't', updatedBy: 't', version: 1,
      createdAt: PICKUP, updatedAt: PICKUP,
    },
    {
      id: 'COMPANY', code: 'COMPANY', name: 'Company', brand: null, parentId: null, color: null,
      sortOrder: 40, active: true, owners: null, flows: null, createdBy: 't', updatedBy: 't', version: 1,
      createdAt: PICKUP, updatedAt: PICKUP,
    },
  ]),
}))

vi.mock('@/lib/reportsClient', () => ({
  loadSamples: vi.fn(async () => ({ rows: samples, months: [MONTH], failedMonths: [] })),
  loadQuotes: vi.fn(async () => ({ rows: [], months: [MONTH], failedMonths: [] })),
  clearReportCache: vi.fn(),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { userId: 'u1', email: 'ryne@bcatcorp.com', groups: ['ADMIN'] }, isAdmin: true, isOwner: true }),
}))

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  clearDashboardCache()
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

const titles = () => Array.from(document.querySelectorAll('.tms-chart-title')).map((element) => element.textContent)

const ALL = [...CLASSIC_CHARTS, ...BROKERAGE_CHARTS]

describe('the company dashboard', () => {
  it('draws every chart, Classic first, in MVMNT order', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(titles().length).toBe(ALL.length))
    expect(titles()).toEqual(ALL.map((chart) => chart.title))
  })

  it('opens on all divisions and this month', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText(/Division is All divisions/)).toBeInTheDocument())
    const nowIso = new Date().toISOString()
    expect(screen.getByText(`Pick Up ${dateChipLabel(defaultFilters(nowIso), nowIso)}`)).toBeInTheDocument()
  })

  it('reads the window\'s facts into the KPI tiles', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(titles().length).toBe(ALL.length))
    const card = screen.getByText('Basic KPIs').closest('.tms-chart-card') as HTMLElement
    // Two shipments in the window company-wide, one priced at $1,500 revenue / $300 profit.
    expect(within(card).getByText('2')).toBeInTheDocument()
    expect(within(card).getByText('$1,500.00')).toBeInTheDocument()
    expect(within(card).getByText('$1,200.00')).toBeInTheDocument()
    expect(within(card).getByText('$300.00')).toBeInTheDocument()
    expect(within(card).getByText('20.0%')).toBeInTheDocument()
  })

  it('does not call a card with real tiles empty', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(titles().length).toBe(ALL.length))
    const card = screen.getByText('Basic KPIs').closest('.tms-chart-card') as HTMLElement
    // Basic KPIs is a tiles-only card: it has no series rows by design, and the
    // figures above are the answer. "No data" underneath them is a lie.
    expect(within(card).queryByText('No data for these filters.')).toBeNull()
  })

  it('hides a chart from the picker and counts what is left', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(titles().length).toBe(ALL.length))

    fireEvent.click(screen.getByRole('button', { name: `${ALL.length} charts` }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Revenue' }))

    expect(screen.getByRole('button', { name: `${ALL.length - 1} charts` })).toBeInTheDocument()
    expect(titles()).not.toContain('Revenue')
    expect(titles()).toContain('Profit')
  })

  it('exports the visible cards as CSV', async () => {
    const blobs: Blob[] = []
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:csv' },
      revokeObjectURL: () => {},
    })
    render(<DashboardPage />)
    await waitFor(() => expect(titles().length).toBe(ALL.length))

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(blobs).toHaveLength(1)
    const csv = await blobs[0].text()
    expect(csv).toContain('Basic KPIs')
    expect(csv).toContain('Revenue')
    expect(csv).toContain('$1,500.00')
  })

  it('saves the current charts and filters as a view this browser remembers', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(titles().length).toBe(ALL.length))

    fireEvent.click(screen.getByRole('button', { name: `${ALL.length} charts` }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Margin' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }))
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Month end' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const saved = JSON.parse(localStorage.getItem('tms-dashboard-views:ryne@bcatcorp.com') ?? '[]')
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('Month end')
    expect(saved[0].chartKeys).not.toContain('margin')
    expect(saved[0].filters.divisions).toEqual([])
    expect(within(screen.getByLabelText('Views')).getByRole('option', { name: 'Month end' })).toBeInTheDocument()
  })

  it('renders one KPI strip per top-level division, company-wide by default', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /BCAT Logistics|Ivan Cartage|Best Care Auto Transport|Company/ })).toHaveLength(4))
    expect(screen.getByRole('button', { name: 'BCAT Logistics' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ivan Cartage' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Best Care Auto Transport' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Company' })).toBeInTheDocument()
  })

  it('counts an ASSETS/BOX_TRUCK shipment in the Assets strip and the Box Trucks sub-row', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ivan Cartage' })).toBeInTheDocument())

    const assets = screen.getByRole('button', { name: 'Ivan Cartage' }).closest('.tms-business-strip') as HTMLElement
    // The Assets top-level strip sees one IN_TRANSIT shipment.
    const topStatuses = assets.querySelector('.tms-strip-statuses') as HTMLElement
    expect(within(topStatuses).getByText('1 INTRAN')).toBeInTheDocument()

    // Box Trucks is the only Assets subdivision with data.
    const boxTrucks = within(assets).getByText('Box Trucks').closest('.tms-strip-sub') as HTMLElement
    expect(within(boxTrucks).getByText('1 INTRAN')).toBeInTheDocument()
  })

  it('sets the division filter when a strip heading is clicked, narrowing the charts too', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ivan Cartage' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Ivan Cartage' }))

    await waitFor(() => expect(screen.getByText(/Division is Ivan Cartage/)).toBeInTheDocument())

    const card = screen.getByText('Basic KPIs').closest('.tms-chart-card') as HTMLElement
    // Only the ASSETS shipment remains after narrowing.
    expect(within(card).getByText('1')).toBeInTheDocument()
  })

  it('renders empty figures, not zeros, for a division with no data', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Best Care Auto Transport' })).toBeInTheDocument())

    const carShipping = screen.getByRole('button', { name: 'Best Care Auto Transport' }).closest('.tms-business-strip') as HTMLElement
    // No status pills and no $0.00 for money figures.
    expect(within(carShipping).queryByText(/\$0\.00/)).not.toBeInTheDocument()
    expect(within(carShipping).queryByText('0')).not.toBeInTheDocument()
    expect(within(carShipping).queryByText('0.0%')).not.toBeInTheDocument()
  })

  it('clears the division filter when the active strip heading is clicked again', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ivan Cartage' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Ivan Cartage' }))
    await waitFor(() => expect(screen.getByText(/Division is Ivan Cartage/)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Ivan Cartage' }))
    await waitFor(() => expect(screen.getByText(/Division is All divisions/)).toBeInTheDocument())
  })
})
