// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { toast } from 'sonner'
import { CarrierOffersSection } from './CarrierOffersSection'
import type { CarrierOfferVetting, QuoteRecord, ShipmentBundle } from '@/types/tms'

const listCarrierOffers = vi.hoisted(() => vi.fn())
const sendSetupPacket = vi.hoisted(() => vi.fn())
const recordCarrierOffer = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({
  listCarrierOffers,
  sendSetupPacket,
  recordCarrierOffer,
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))

vi.mock('@/features/quotes/components/AcceptOfferDialog', () => ({
  AcceptOfferDialog: ({ open, quote }: { open: boolean; quote: QuoteRecord }) => (
    open ? <div data-testid="accept-offer-dialog">{quote.carrierName}</div> : null
  ),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const WHEN = '2026-04-03T12:00:00.000Z'

function vetting(over: Partial<CarrierOfferVetting> = {}): CarrierOfferVetting {
  return {
    known: true,
    bookable: true,
    blockers: [],
    warnings: [],
    status: 'ACTIVE',
    mcpStatus: 'VERIFIED',
    ...over,
  }
}

function offer(over: Partial<QuoteRecord> = {}, v: Partial<CarrierOfferVetting> = {}): QuoteRecord & { vetting: CarrierOfferVetting } {
  return {
    id: 'q-1',
    side: 'BUY',
    status: 'OPEN',
    quoteDate: WHEN,
    quoteMonth: '2026-04',
    amountCents: 150_000,
    rounds: 1,
    carrierName: 'Blue Sky Trucking',
    carrierMc: '123456',
    carrierEmail: 'dispatch@bluesky.example',
    offerSource: 'EMAIL',
    offerAvailableAt: WHEN,
    equipmentType: 'VAN',
    ...over,
    vetting: vetting(v),
  } as QuoteRecord & { vetting: CarrierOfferVetting }
}

function bundle(): ShipmentBundle {
  return {
    shipment: { id: 'shp-1', number: 'S000001', status: 'OPEN', customerId: 'cust-1', customerName: 'Acme', mode: 'FTL', source: 'MANUAL', createdBy: 'a', updatedBy: 'a', createdAt: WHEN, updatedAt: WHEN },
    orders: [],
    loads: [{ id: 'load-1', orderId: 'ord-1', stops: [], status: 'OPEN', loadNumber: 'S000001-1', leg: 1 }],
    loadCarriers: [],
    charges: [],
    financials: [],
    documents: [],
  } as unknown as ShipmentBundle
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CarrierOffersSection', () => {
  it('shows the blocker and offers setup packet for an unvetted carrier', async () => {
    listCarrierOffers.mockResolvedValue({
      offers: [offer({ carrierName: 'Red Hill Transit' }, { known: false, bookable: false, blockers: ['Insurance has lapsed'] })],
    })
    render(<CarrierOffersSection shipmentId="shp-1" bundle={bundle()} onReload={vi.fn()} />)
    const row = await screen.findByText('Red Hill Transit')
    expect(row).toBeInTheDocument()
    expect(screen.getByText('Insurance has lapsed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Assign to load/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Send setup packet/i })).toBeInTheDocument()
  })

  it('offers Assign to load for a bookable carrier', async () => {
    listCarrierOffers.mockResolvedValue({ offers: [offer({ carrierName: 'Green Valley' })] })
    render(<CarrierOffersSection shipmentId="shp-1" bundle={bundle()} onReload={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Green Valley')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Assign to load/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Send setup packet/i })).toBeNull()
  })

  it('renders a PHONE-sourced offer as a logged call', async () => {
    listCarrierOffers.mockResolvedValue({
      offers: [offer({ carrierName: 'Caller Dispatch', offerSource: 'PHONE', offerContactName: 'Jim', offerContactPhone: '555-0100' })],
    })
    render(<CarrierOffersSection shipmentId="shp-1" bundle={bundle()} onReload={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Caller Dispatch')).toBeInTheDocument())
    expect(screen.getByText('Logged call')).toBeInTheDocument()
  })

  it('sends a setup packet when the button is pressed', async () => {
    listCarrierOffers.mockResolvedValue({
      offers: [offer({ carrierName: 'New Carrier LLC' }, { known: false, bookable: false, blockers: ['Not in directory'] })],
    })
    sendSetupPacket.mockResolvedValue({ sent: true, mode: 'STUB' as const, message: 'Setup packet sent (stub)' })
    render(<CarrierOffersSection shipmentId="shp-1" bundle={bundle()} onReload={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('New Carrier LLC')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Send setup packet/i }))
    await waitFor(() => expect(sendSetupPacket).toHaveBeenCalledWith({ shipmentId: 'shp-1', quoteId: 'q-1', email: 'dispatch@bluesky.example' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Setup packet sent (stub)'))
  })
})
