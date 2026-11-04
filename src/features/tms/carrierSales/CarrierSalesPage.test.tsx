// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierSalesPage } from './CarrierSalesPage'
import { needsCoverCount } from './carrierSalesQueue'

const mocks = vi.hoisted(() => ({
  listActivePostings: vi.fn(),
  unpostQuoteLoad: vi.fn(),
  shipments: vi.fn(),
  worklist: vi.fn(),
  hasPageAccess: vi.fn(),
}))

vi.mock('@/lib/apiClient', () => ({
  listActivePostings: mocks.listActivePostings,
  unpostQuoteLoad: mocks.unpostQuoteLoad,
  graphqlErrorText: (e: unknown) => String(e),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/carriers/cover/CoverCarrierDialog', () => ({
  CoverCarrierDialog: ({ shipmentId, shipmentNumber, onClose }: { shipmentId: string; shipmentNumber?: string; onClose: () => void }) => (
    <div data-testid="cover-dialog" data-shipment={shipmentId}>{shipmentNumber}<button onClick={onClose}>close</button></div>
  ),
}))
vi.mock('@/hooks/useShipments', () => ({ useShipments: mocks.shipments }))
vi.mock('@/hooks/useQuoteWorklist', () => ({ useQuoteWorklist: mocks.worklist }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: mocks.hasPageAccess }) }))

function shipment(id: string, over: Record<string, unknown> = {}) {
  return {
    id, number: id.toUpperCase(), status: 'BOOKED', customerName: 'Acme', assignmentType: null, loadStatus: null,
    equipmentType: 'Van', customerRateCents: 150_000, carrierName: null, carrierMc: null, mcpStatus: null,
    rateConStatus: null, rateConSentAt: null, rateConSignedAt: null, dispatchedAt: null, pickupAppt: null,
    ...over,
  }
}

const ROWS = [
  shipment('s-1'),
  shipment('s-2'),
  shipment('s-3', { status: 'DRAFT' }),
  shipment('s-4', { assignmentType: 'CARRIER', carrierName: 'Hauler', carrierMc: '123' }),
]

function renderPage() {
  return render(<MemoryRouter><CarrierSalesPage /></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listActivePostings.mockResolvedValue([])
  mocks.shipments.mockReturnValue({ shipments: ROWS, loading: false, error: null, refresh: vi.fn() })
  mocks.worklist.mockReturnValue({ open: [], loading: false, error: null, refresh: vi.fn() })
  mocks.hasPageAccess.mockImplementation((key: string) => key === 'loads' || key === 'quotes')
})

describe('CarrierSalesPage', () => {
  it('Needs cover tab count equals the badge count and every Cover action opens the Cover dialog for its own shipment', () => {
    renderPage()
    const tab = screen.getByRole('tab', { name: /Needs cover/ })
    expect(within(tab).getByText(String(needsCoverCount(ROWS as never)))).toBeTruthy()
    const covers = screen.getAllByRole('button', { name: /^Cover / })
    expect(covers).toHaveLength(2)
    fireEvent.click(covers[1]!)
    expect(screen.getByTestId('cover-dialog').getAttribute('data-shipment')).toBe('s-2')
  })

  it('the Covered tab shows each load’s carrier-assignment rung and filters by it', () => {
    mocks.shipments.mockReturnValue({
      shipments: [
        shipment('s-5', { assignmentType: 'CARRIER', carrierName: 'Hauler', carrierMc: '1', carrierAssignmentStatus: 'ASSIGNED_SETUP_PENDING' }),
        shipment('s-6', { assignmentType: 'CARRIER', carrierName: 'Other', carrierMc: '2', carrierAssignmentStatus: 'RATE_CON_SENT', rateConStatus: 'SENT' }),
      ],
      loading: false, error: null, refresh: vi.fn(),
    })
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Covered/ }))
    expect(screen.getAllByTestId('assignment-chip').map((c) => c.textContent)).toEqual([
      'Carrier assigned - waiting for carrier setup', 'Rate con sent',
    ])
    fireEvent.change(screen.getByLabelText('Carrier status filter'), { target: { value: 'RATE_CON_SENT' } })
    expect(screen.getAllByTestId('assignment-chip').map((c) => c.textContent)).toEqual(['Rate con sent'])
  })

  it('shows the Step T card as an inert notice, with no button inside it', () => {
    renderPage()
    const card = screen.getByText(/backburnered \(Step T\)/).closest('section')!
    expect(card.querySelector('button, a, input')).toBeNull()
  })

  it('without the Quotes grant the Offers tab says so instead of erroring', () => {
    mocks.hasPageAccess.mockImplementation((key: string) => key === 'loads')
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Offers/ }))
    expect(screen.getByText('Needs the Quotes grant')).toBeTruthy()
    expect(mocks.worklist).not.toHaveBeenCalled()
  })

  it('launches Find & invite from Carrier Sales on every tab', () => {
    renderPage()
    expect(screen.getByTestId('launch-find-invite').getAttribute('href')).toBe('/tms/carriers/find?from=carrier-sales')
    fireEvent.click(screen.getByRole('tab', { name: /Offers/ }))
    expect(screen.getByTestId('launch-find-invite')).toBeTruthy()
  })

  it('lists loads pushed to DAT from a quote (STUB-labelled) beside the queue, and unposts one', async () => {
    mocks.listActivePostings.mockResolvedValue([
      { id: 'post:quote:Q7:DAT', shipmentId: 'quote:Q7', provider: 'DAT', status: 'POSTED', mode: 'STUB', originCity: 'Chicago', originState: 'IL', destinationCity: 'Dallas', destinationState: 'TX', equipmentType: 'VAN', postedAt: '2026-11-04T12:00:00Z' },
      { id: 'post:s-1:DAT', shipmentId: 's-1', provider: 'DAT', status: 'POSTED', mode: 'LIVE' },
    ])
    mocks.unpostQuoteLoad.mockResolvedValue({ postings: [] })
    renderPage()
    const card = await screen.findByTestId('quote-postings')
    expect(within(card).getByText('Q7')).toBeTruthy()
    expect(within(card).getByText('STUB')).toBeTruthy()
    expect(card.textContent).not.toContain('s-1') // a shipment's own posting is not listed here
    fireEvent.click(within(card).getByTestId('quote-unpost-post:quote:Q7:DAT'))
    await waitFor(() => expect(mocks.unpostQuoteLoad).toHaveBeenCalledWith({ quoteId: 'Q7', spotRequestId: null, providers: ['DAT'] }))
    await waitFor(() => expect(screen.queryByTestId('quote-postings')).toBeNull())
  })
})
