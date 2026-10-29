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
      id: 'BROKERAGE', code: 'BROKERAGE', name: 'BCAT Logistics', brand: null, parentId: null, color: null,
      sortOrder: 0, active: true, owners: null, flows: null, createdBy: 't', updatedBy: 't', version: 1,
      createdAt: PICKUP, updatedAt: PICKUP,
    },
    {
      id: 'ASSETS', code: 'ASSETS', name: 'Ivan Cartage', brand: null, parentId: null, color: null,
      sortOrder: 1, active: true, owners: null, flows: null, createdBy: 't', updatedBy: 't', version: 1,
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

describe('the Brokerage dashboard', () => {
  it('draws every chart, Classic first, in MVMNT order', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(titles().length).toBe(ALL.length))
    expect(titles()).toEqual(ALL.map((chart) => chart.title))
  })

  it('opens on BCAT Logistics and this month', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText(/Division is BCAT Logistics/)).toBeInTheDocument())
    const nowIso = new Date().toISOString()
    expect(screen.getByText(`Pick Up ${dateChipLabel(defaultFilters(nowIso), nowIso)}`)).toBeInTheDocument()
  })

  it('reads the window\'s facts into the KPI tiles', async () => {
    render(<DashboardPage />)
    await waitFor(() => expect(titles().length).toBe(ALL.length))
    const card = screen.getByText('Basic KPIs').closest('.tms-chart-card') as HTMLElement
    // One BROKERAGE shipment in the window, priced at $1,500 revenue / $300 profit.
    expect(within(card).getByText('1')).toBeInTheDocument()
    expect(within(card).getByText('$1,500.00')).toBeInTheDocument()
    expect(within(card).getByText('$1,200.00')).toBeInTheDocument()
    expect(within(card).getByText('$300.00')).toBeInTheDocument()
    expect(within(card).getByText('20.0%')).toBeInTheDocument()
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
    expect(saved[0].filters.divisions).toEqual(['BROKERAGE'])
    expect(within(screen.getByLabelText('Views')).getByRole('option', { name: 'Month end' })).toBeInTheDocument()
  })
})
