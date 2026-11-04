// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CarrierSalesPage } from './CarrierSalesPage'
import { needsCoverCount } from './carrierSalesQueue'

const mocks = vi.hoisted(() => ({
  shipments: vi.fn(),
  worklist: vi.fn(),
  hasPageAccess: vi.fn(),
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
  mocks.shipments.mockReturnValue({ shipments: ROWS, loading: false, error: null, refresh: vi.fn() })
  mocks.worklist.mockReturnValue({ open: [], loading: false, error: null, refresh: vi.fn() })
  mocks.hasPageAccess.mockImplementation((key: string) => key === 'loads' || key === 'quotes')
})

describe('CarrierSalesPage', () => {
  it('Needs cover tab count equals the badge count and every Cover action links to the Carrier tab', () => {
    renderPage()
    const tab = screen.getByRole('tab', { name: /Needs cover/ })
    expect(within(tab).getByText(String(needsCoverCount(ROWS as never)))).toBeTruthy()
    const covers = screen.getAllByRole('link', { name: /^Cover / })
    expect(covers).toHaveLength(2)
    for (const a of covers) expect(a.getAttribute('href')).toMatch(/^\/tms\/shipments\/s-\d\?tab=carrier$/)
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
})
