// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShipmentBundle } from '@/types/tms'

const grant = vi.hoisted(() => ({ value: true }))
vi.mock('@/features/ar/useBillingGrant', () => ({ useBillingGrant: () => grant.value, BILLING_GRANT_MESSAGE: 'needs invoicing' }))
const api = vi.hoisted(() => ({
  createSquareInvoice: vi.fn(async () => ({})),
  sendSquareInvoice: vi.fn(async () => ({})),
  syncSquareInvoice: vi.fn(async () => ({})),
  cancelSquareInvoice: vi.fn(async () => ({})),
  reissueSquareInvoice: vi.fn(async () => ({})),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() } }))

import { SquareCard } from './SquareCard'

const PAYER = { name: 'Pat Example', email: 'pat@example.com', phone: '(847) 555-0100' }
const VEHICLE = { year: '2018', make: 'Honda', model: 'Civic' }

function bundle(square?: Record<string, unknown>, amountCents = 120_900): ShipmentBundle {
  return {
    shipment: { id: 'shp-1', carShipping: { payer: PAYER, vehicle: VEHICLE, ...(square ? { square } : {}) } },
    orders: [{ id: 'ord-1', customerRateCents: amountCents, revenueCents: amountCents }],
  } as unknown as ShipmentBundle
}

beforeEach(() => { grant.value = true; Object.values(api).forEach((f) => f.mockClear()) })

describe('SquareCard', () => {
  it('never breaks the page on odd car-shipping data: a string, an empty object, or details with no payer or vehicle', () => {
    for (const odd of ['{"payer":{}}', {}, { square: { status: 'DRAFT' } }, 'null']) {
      const b = { shipment: { id: 'shp-1', carShipping: odd }, orders: [{ id: 'ord-1', customerRateCents: 120900 }] } as unknown as ShipmentBundle
      expect(() => render(<SquareCard bundle={b} onReload={() => {}} />)).not.toThrow()
    }
  })

  it('draws nothing for a shipment that is not an auto shipper, or for someone without the Invoicing grant', () => {
    const plain = { shipment: { id: 'shp-1' }, orders: [] } as unknown as ShipmentBundle
    const { container } = render(<SquareCard bundle={plain} onReload={() => {}} />)
    expect(container).toBeEmptyDOMElement()
    grant.value = false
    const hidden = render(<SquareCard bundle={bundle()} onReload={() => {}} />)
    expect(hidden.container).toBeEmptyDOMElement()
  })

  it('shows the payer, vehicle and amount, and offers to make the draft when none exists', async () => {
    render(<SquareCard bundle={bundle()} onReload={() => {}} />)
    expect(screen.getByTestId('square-status')).toHaveTextContent('Square: not created')
    expect(screen.getByTestId('square-card')).toHaveTextContent('Pat Example · pat@example.com')
    expect(screen.getByTestId('square-card')).toHaveTextContent('2018 Honda Civic')
    expect(screen.getByTestId('square-card')).toHaveTextContent('$1,209.00')
    fireEvent.click(screen.getByRole('button', { name: 'Create Square draft' }))
    await waitFor(() => expect(api.createSquareInvoice).toHaveBeenCalledWith({ shipmentId: 'shp-1' }))
  })

  it('shows why Square failed and offers Retry', () => {
    render(<SquareCard bundle={bundle({ lastError: 'Square did not answer in time; try again' })} onReload={() => {}} />)
    expect(screen.getByTestId('square-error')).toHaveTextContent('did not answer in time')
    expect(screen.getByRole('button', { name: 'Retry Square draft' })).toBeInTheDocument()
  })

  it('a draft is sent only after a confirmation that says it reaches the payer', async () => {
    render(<SquareCard bundle={bundle({ invoiceId: 'INV1', status: 'DRAFT', environment: 'SANDBOX', invoiceNumber: '14730', amountCents: 120_900 })} onReload={() => {}} />)
    expect(screen.getByTestId('square-status')).toHaveTextContent('Square draft')
    expect(screen.getByTestId('square-env')).toHaveTextContent('Sandbox')
    fireEvent.click(screen.getByRole('button', { name: 'Send invoice' }))
    expect(api.sendSquareInvoice).not.toHaveBeenCalled()
    expect(await screen.findByText(/This reaches the payer/)).toBeInTheDocument()
    expect(screen.getByText(/no real e-mail is sent/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Send invoice' }).at(-1)!)
    await waitFor(() => expect(api.sendSquareInvoice).toHaveBeenCalledWith({ shipmentId: 'shp-1' }))
  })

  it('says when the price moved since the draft was made and offers to rebuild it', () => {
    render(<SquareCard bundle={bundle({ invoiceId: 'INV1', status: 'DRAFT', amountCents: 120_900 }, 130_000)} onReload={() => {}} />)
    expect(screen.getByTestId('square-price-changed')).toHaveTextContent('Rebuild the draft')
    expect(screen.getByRole('button', { name: 'Rebuild draft' })).toBeInTheDocument()
  })

  it('a sent invoice offers Sync, Cancel and a pay link; Reissue only when the price moved', () => {
    render(<SquareCard bundle={bundle({ invoiceId: 'INV1', status: 'UNPAID', publicUrl: 'https://pay.example/abc', amountCents: 120_900 })} onReload={() => {}} />)
    expect(screen.getByTestId('square-status')).toHaveTextContent('Sent · unpaid')
    expect(screen.getByRole('button', { name: 'Sync from Square' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel invoice' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy pay link' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reissue at new price' })).toBeNull()
  })

  it('opening a sent invoice asks Square once for its latest status, but not again within a minute', async () => {
    const sent = { invoiceId: 'INV1', status: 'UNPAID', amountCents: 120_900 }
    const { unmount } = render(<SquareCard bundle={bundle(sent)} onReload={() => {}} />)
    await waitFor(() => expect(api.syncSquareInvoice).toHaveBeenCalledTimes(1))
    unmount()
    api.syncSquareInvoice.mockClear()
    render(<SquareCard bundle={bundle({ ...sent, lastSyncAt: new Date().toISOString() })} onReload={() => {}} />)
    // A draft or a paid invoice has nothing to ask either.
    render(<SquareCard bundle={bundle({ invoiceId: 'INV2', status: 'DRAFT' })} onReload={() => {}} />)
    render(<SquareCard bundle={bundle({ invoiceId: 'INV3', status: 'PAID' })} onReload={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(api.syncSquareInvoice).not.toHaveBeenCalled()
  })

  it('shows a refund or failed payment as a review note, in red, and never offers to reverse anything', () => {
    render(<SquareCard bundle={bundle({ invoiceId: 'INV1', status: 'REFUNDED', reviewFlag: 'Square shows a refund on this invoice.' })} onReload={() => {}} />)
    expect(screen.getByTestId('square-review')).toHaveTextContent('refund')
    expect(screen.queryByRole('button', { name: /reverse/i })).toBeNull()
  })
})
