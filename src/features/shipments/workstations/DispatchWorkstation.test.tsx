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

import { DispatchBody, DispatchWorkstation } from './DispatchWorkstation'
import * as useBoardFiltersModule from '../board/useBoardFilters'
import type { UseBoardFiltersOptions } from '../board/useBoardFilters'
import {
  getTmsSettings,
  listActivePostings,
  listCarrierOffers,
  listCarriers,
  listLoadCarriers,
  listShipmentPostings,
  postLoad,
} from '@/lib/apiClient'
import * as useStaffModule from '@/hooks/useStaff'
import type {
  CarrierRecord,
  CustomerRecord,
  LoadCarrierRecord,
  QuoteRecord,
  ShipmentBundle,
  ShipmentPostingRecord,
  ShipmentRow,
  TmsSettings,
} from '@/types/tms'
import type { CarrierOfferVetting } from '@/lib/apiClient'

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

const refreshAll = () => Promise.resolve()

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

const basePostings: ShipmentPostingRecord[] = [
  {
    id: 'post-1',
    shipmentId: 'ship-1',
    provider: 'DAT',
    status: 'POSTED',
    mode: 'STUB',
    boardPostingId: 'dat-123',
    postedAt: '2026-10-29T10:00:00Z',
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z',
  },
]

const baseOffers: (QuoteRecord & { vetting: CarrierOfferVetting })[] = [
  {
    id: 'offer-1',
    side: 'BUY',
    status: 'QUOTED',
    quoteDate: '2026-10-29',
    quoteMonth: '2026-10',
    amountCents: 1_800_00,
    rounds: 1,
    carrierId: 'carrier-1',
    carrierName: 'Vetted Carrier',
    carrierMc: 'MC111111',
    carrierEmail: 'vetted@example.com',
    equipmentType: 'Van',
    offerSource: 'EMAIL',
    offerContactName: 'Bob',
    quoteOpen: 'OPEN',
    createdBy: 'test',
    updatedBy: 'test',
    version: 1,
    vetting: { known: true, bookable: true, blockers: [], warnings: [], status: 'VETTED', mcpStatus: 'APPROVED' },
  } as QuoteRecord & { vetting: CarrierOfferVetting },
]

vi.mock('@/features/tms/useShipmentViews', () => ({
  useShipmentViews: vi.fn(() => ({ views: [], loading: false, error: null, refresh: vi.fn() })),
}))

vi.mock('@/lib/apiClient', () => ({
  getCarrierBundle: vi.fn(() => Promise.resolve({ carrier: {}, contacts: [], paymentMethods: [], documents: [], loadCarriers: [] })),
  getShipmentBundle: vi.fn(() => Promise.resolve(emptyBundle)),
  getTmsSettings: vi.fn(),
  listActivePostings: vi.fn(() => Promise.resolve(basePostings)),
  listCarriers: vi.fn(),
  listCarrierOffers: vi.fn(() => Promise.resolve({ offers: baseOffers })),
  listDivisions: vi.fn(() => Promise.resolve([])),
  listLoadCarriers: vi.fn(),
  listShipmentPostings: vi.fn(() => Promise.resolve(basePostings)),
  postLoad: vi.fn(() => Promise.resolve({ postings: basePostings })),
  unpostLoad: vi.fn(() => Promise.resolve({ postings: [] })),
  sendSetupPacket: vi.fn(() => Promise.resolve({ sent: true, mode: 'STUB', message: 'STUB — setup packet sent' })),
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

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({
    user: { email: 'dispatch@bcatcorp.com', userId: 'dispatch@bcatcorp.com', groups: ['page-tms'] },
    isAdmin: false,
    isOwner: false,
  })),
}))

vi.mock('@/hooks/useShipments', () => ({
  useShipments: vi.fn(() => ({ shipments: rows, loading: false, error: null, refresh: vi.fn() })),
}))

vi.mock('@/hooks/useDirectory', () => ({
  useDirectory: vi.fn(() => ({ customers, locations: [] })),
}))

vi.mock('@/hooks/useStaff', () => ({
  useStaff: vi.fn(() => ({
    staff: [],
    byId: {},
    loading: false,
    error: null,
    refresh: vi.fn(),
    nameOf: (id: string | null) => (id ? `Rep ${id}` : '—'),
    me: null,
  })),
}))

function renderBody(props: Partial<Parameters<typeof DispatchBody>[0]> = {}) {
  return render(
    <DispatchBody
      rows={rows}
      allRows={rows}
      customers={customers}
      activeLegsByShipment={activeLegsByShipment}
      carriers={carriers}
      settings={settings}
      refreshAll={refreshAll}
      {...props}
    />,
  )
}

describe('DispatchWorkstation body', () => {
  it('lists the queue with the right coverage chips', () => {
    renderBody()

    const cards = screen.getAllByTestId('coverage-card')
    expect(cards).toHaveLength(3)

    expect(screen.getByText('Needs coverage')).toBeInTheDocument()
    expect(screen.getByText('Covered')).toBeInTheDocument()
    expect(screen.getByText('Dispatched')).toBeInTheDocument()
  })

  it('opens the Find coverage pane when a card is selected', async () => {
    renderBody()

    const cards = screen.getAllByTestId('coverage-card')
    fireEvent.click(cards[0])

    await waitFor(() => {
      expect(screen.getByText('Covering now')).toBeInTheDocument()
    })
    expect(screen.getByText('Suggested carriers')).toBeInTheDocument()
    expect(screen.getByText('Postings')).toBeInTheDocument()
    expect(screen.queryByText(/Carrier offers parsed from e-mail and text arrive with Step P/)).not.toBeInTheDocument()
  })

  it('shows posting pills per board with a STUB label', async () => {
    vi.mocked(listShipmentPostings).mockResolvedValueOnce([
      {
        id: 'post-dat',
        shipmentId: 'ship-1',
        provider: 'DAT',
        status: 'POSTED',
        mode: 'STUB',
        boardPostingId: 'dat-999',
        postedAt: '2026-10-29T10:00:00Z',
        createdBy: 'test',
        updatedBy: 'test',
        createdAt: '2026-10-29T10:00:00Z',
        updatedAt: '2026-10-29T10:00:00Z',
      },
      {
        id: 'post-truckstop',
        shipmentId: 'ship-1',
        provider: 'TRUCKSTOP',
        status: 'UNPOSTED',
        mode: 'STUB',
        createdBy: 'test',
        updatedBy: 'test',
        createdAt: '2026-10-29T10:00:00Z',
        updatedAt: '2026-10-29T10:00:00Z',
      },
    ])

    renderBody()

    const cards = screen.getAllByTestId('coverage-card')
    fireEvent.click(cards[2])
    await waitFor(() => expect(screen.getByText('Postings')).toBeInTheDocument())

    const postingRows = screen.getAllByTestId('posting-row')
    expect(postingRows).toHaveLength(2)

    const datRow = postingRows.find((r) => r.getAttribute('data-provider') === 'DAT')
    expect(datRow).toHaveTextContent('POSTED')
    expect(datRow).toHaveTextContent('STUB')
    expect(datRow).toHaveTextContent('dat-999')

    const tsRow = postingRows.find((r) => r.getAttribute('data-provider') === 'TRUCKSTOP')
    expect(tsRow).toHaveTextContent('UNPOSTED')
  })

  it('calls postLoad with the chosen provider when Post is clicked', async () => {
    vi.mocked(listShipmentPostings).mockResolvedValueOnce([])
    renderBody()

    const cards = screen.getAllByTestId('coverage-card')
    fireEvent.click(cards[2])
    await waitFor(() => expect(screen.getByText('Postings')).toBeInTheDocument())

    fireEvent.click(screen.getAllByTestId('post-button')[0])

    await waitFor(() => {
      expect(postLoad).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 'ship-1', providers: ['DAT'] }))
    })
  })

  it('surfaces a server refusal verbatim', async () => {
    vi.mocked(listShipmentPostings).mockResolvedValueOnce([])
    vi.mocked(postLoad).mockRejectedValueOnce(new Error('Shipment is still BUILDING'))

    renderBody()

    const cards = screen.getAllByTestId('coverage-card')
    fireEvent.click(cards[2])
    await waitFor(() => expect(screen.getByText('Postings')).toBeInTheDocument())

    fireEvent.click(screen.getAllByTestId('post-button')[0])

    await waitFor(() => {
      expect(screen.getByTestId('posting-error')).toHaveTextContent('Shipment is still BUILDING')
    })
  })

  it('sorts offers open-first then by rate', async () => {
    vi.mocked(listCarrierOffers).mockImplementation(async (shipmentId: string) =>
      shipmentId === 'ship-1'
        ? {
            offers: [
              {
                id: 'offer-closed',
                side: 'BUY',
                status: 'LOST',
                quoteDate: '2026-10-29',
                quoteMonth: '2026-10',
                amountCents: 1_000_00,
                rounds: 1,
                carrierName: 'Closed Cheap',
                carrierMc: 'MC000001',
                vetting: { known: false, bookable: false, blockers: ['Unknown MC'], warnings: [], status: 'UNKNOWN', mcpStatus: null },
                createdBy: 'test',
                updatedBy: 'test',
                version: 1,
              } as QuoteRecord & { vetting: CarrierOfferVetting },
              {
                id: 'offer-open-expensive',
                side: 'BUY',
                status: 'QUOTED',
                quoteDate: '2026-10-29',
                quoteMonth: '2026-10',
                amountCents: 2_000_00,
                rounds: 1,
                carrierName: 'Open Expensive',
                carrierMc: 'MC000002',
                quoteOpen: 'OPEN',
                vetting: { known: false, bookable: false, blockers: ['Unknown MC'], warnings: [], status: 'UNKNOWN', mcpStatus: null },
                createdBy: 'test',
                updatedBy: 'test',
                version: 1,
              } as QuoteRecord & { vetting: CarrierOfferVetting },
              {
                id: 'offer-open-cheap',
                side: 'BUY',
                status: 'QUOTED',
                quoteDate: '2026-10-29',
                quoteMonth: '2026-10',
                amountCents: 1_500_00,
                rounds: 1,
                carrierName: 'Open Cheap',
                carrierMc: 'MC000003',
                quoteOpen: 'OPEN',
                vetting: { known: false, bookable: false, blockers: ['Unknown MC'], warnings: [], status: 'UNKNOWN', mcpStatus: null },
                createdBy: 'test',
                updatedBy: 'test',
                version: 1,
              } as QuoteRecord & { vetting: CarrierOfferVetting },
            ],
          }
        : { offers: [] },
    )

    renderBody()

    const cards = screen.getAllByTestId('coverage-card')
    fireEvent.click(cards[2])
    await waitFor(() => expect(screen.getByText(/Carrier offers \(3\)/)).toBeInTheDocument())

    const offerRows = screen.getAllByTestId('offer-row')
    expect(offerRows[0]).toHaveTextContent('Open Cheap')
    expect(offerRows[1]).toHaveTextContent('Open Expensive')
    expect(offerRows[2]).toHaveTextContent('Closed Cheap')
  })

  it('shows Send setup packet for an unvetted MC and Assign carrier for a vetted one', async () => {
    vi.mocked(listCarrierOffers).mockImplementation(async (shipmentId: string) =>
      shipmentId === 'ship-1'
        ? {
            offers: [
              {
                id: 'offer-unknown',
                side: 'BUY',
                status: 'QUOTED',
                quoteDate: '2026-10-29',
                quoteMonth: '2026-10',
                amountCents: 1_800_00,
                rounds: 1,
                carrierName: 'Unknown Carrier',
                carrierMc: 'MC222222',
                carrierEmail: 'unknown@example.com',
                quoteOpen: 'OPEN',
                vetting: { known: false, bookable: false, blockers: ['Unknown MC'], warnings: [], status: 'UNKNOWN', mcpStatus: null },
                createdBy: 'test',
                updatedBy: 'test',
                version: 1,
              } as QuoteRecord & { vetting: CarrierOfferVetting },
              {
                id: 'offer-vetted',
                side: 'BUY',
                status: 'QUOTED',
                quoteDate: '2026-10-29',
                quoteMonth: '2026-10',
                amountCents: 1_900_00,
                rounds: 1,
                carrierId: 'carrier-1',
                carrierName: 'Vetted Carrier',
                carrierMc: 'MC111111',
                carrierEmail: 'vetted@example.com',
                quoteOpen: 'OPEN',
                vetting: { known: true, bookable: true, blockers: [], warnings: [], status: 'VETTED', mcpStatus: 'APPROVED' },
                createdBy: 'test',
                updatedBy: 'test',
                version: 1,
              } as QuoteRecord & { vetting: CarrierOfferVetting },
            ],
          }
        : { offers: [] },
    )

    renderBody()

    const cards = screen.getAllByTestId('coverage-card')
    fireEvent.click(cards[2])
    await waitFor(() => expect(screen.getByText(/Carrier offers \(2\)/)).toBeInTheDocument())

    expect(screen.getByTestId('setup-packet-button')).toHaveTextContent('Send setup packet')
    expect(screen.getByTestId('assign-offer-button')).toHaveTextContent('Assign carrier + send rate con')
  })

  it('passes the signed-in viewer to useBoardFilters', async () => {
    const calls: UseBoardFiltersOptions[] = []
    const actual = useBoardFiltersModule.useBoardFilters
    const spy = vi.spyOn(useBoardFiltersModule, 'useBoardFilters').mockImplementation((options: UseBoardFiltersOptions) => {
      calls.push(options)
      return actual(options)
    })

    const me = { id: 'dispatch@bcatcorp.com', email: 'dispatch@bcatcorp.com', teamKeys: ['dispatchers'] }
    const team = { key: 'dispatchers', name: 'Dispatch', memberIds: ['dispatch@bcatcorp.com', 'dana@bcatcorp.com'] }
    vi.spyOn(useStaffModule, 'useStaff').mockReturnValue({
      staff: [me],
      byId: { 'dispatch@bcatcorp.com': me },
      loading: false,
      error: null,
      refresh: vi.fn(),
      nameOf: (id: string | null) => (id ? String(id).split('@')[0] : '—'),
      me,
    })
    const settings = { teams: [team] } as TmsSettings
    vi.mocked(getTmsSettings).mockResolvedValue(settings)
    vi.mocked(listLoadCarriers).mockResolvedValue([])
    vi.mocked(listCarriers).mockResolvedValue([])

    render(<DispatchWorkstation />)
    await waitFor(() => {
      expect(calls.at(-1)?.viewer?.userId).toBe('dispatch@bcatcorp.com')
      expect(calls.at(-1)?.viewer?.teamRepIds).toContain('dana@bcatcorp.com')
    })

    spy.mockRestore()
  })

  it('shows the queue Posted indicator and offer count', async () => {
    vi.mocked(listActivePostings).mockResolvedValueOnce([
      {
        id: 'post-ship-1',
        shipmentId: 'ship-1',
        provider: 'DAT',
        status: 'POSTED',
        mode: 'LIVE',
        postedAt: '2026-10-29T10:00:00Z',
        createdBy: 'test',
        updatedBy: 'test',
        createdAt: '2026-10-29T10:00:00Z',
        updatedAt: '2026-10-29T10:00:00Z',
      },
    ])
    vi.mocked(listCarrierOffers).mockImplementation(async (shipmentId: string) => ({
      offers: shipmentId === 'ship-1'
        ? [baseOffers[0], { ...baseOffers[0], id: 'offer-2' }]
        : [],
    }))

    renderBody()

    await waitFor(() => {
      const cards = screen.getAllByTestId('coverage-card')
      expect(cards[2]).toHaveTextContent('DAT')
      expect(screen.getAllByTestId('offer-count')[0]).toHaveTextContent('Offers (2)')
    })
  })
})
