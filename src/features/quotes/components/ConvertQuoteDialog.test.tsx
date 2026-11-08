// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConvertQuoteDialog } from './ConvertQuoteDialog'
import type { QuoteRecord, UserProfileRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

// The rep field is a RepPicker, so the dialog reads the staff directory.
const staff = vi.hoisted(() => [
  {
    id: 'dana@bcatcorp.com', email: 'dana@bcatcorp.com', name: 'Dana Carr', role: 'CUSTOMER_REP',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1,
  },
] as UserProfileRecord[])
const { checkCredit, convertQuote, listDivisions } = vi.hoisted(() => ({
  checkCredit: vi.fn(),
  convertQuote: vi.fn(),
  listDivisions: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => ({
  checkCredit,
  convertQuote,
  listDivisions,
  listUserProfiles: vi.fn(async () => staff),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'ryne@bcatcorp.com' }) }))

/** A quote on a convertible rung, carrying the free text a rep typed before step I. */
function quote(patch: Partial<QuoteRecord> = {}): QuoteRecord {
  return {
    id: 'Q1', side: 'SELL', status: 'QUOTED', customerId: 'cust-1', customerName: 'Acme Freight',
    amountCents: 150000, version: 3, customerRepId: 'legacy.rep@nowhere.test',
    stops: [], lines: [],
    createdBy: 'a@b.c', updatedBy: 'a@b.c',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  } as QuoteRecord
}

beforeEach(() => {
  vi.clearAllMocks()
  listDivisions.mockResolvedValue([])
  checkCredit.mockResolvedValue(null)
  convertQuote.mockResolvedValue({ bundle: { shipment: { id: 'shp-1', number: 'S000001' } } })
})

function renderDialog(row = quote()) {
  return render(
    <ConvertQuoteDialog quote={row} open onOpenChange={vi.fn()} onDone={vi.fn()} />,
  )
}

describe('ConvertQuoteDialog', () => {
  it('converts with the rep the quote already names, free text and all', async () => {
    renderDialog()

    expect(await screen.findByText('legacy.rep@nowhere.test')).toBeTruthy()
    expect(screen.getByText('not a user')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Convert to shipment' }))
    await waitFor(() => expect(convertQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: 'Q1', customerRepId: 'legacy.rep@nowhere.test' }),
    ))
  })

  it('converts with the username of a rep picked from the directory', async () => {
    renderDialog()

    fireEvent.click(await screen.findByText('legacy.rep@nowhere.test'))
    fireEvent.click(await screen.findByRole('option', { name: /Dana Carr/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Convert to shipment' }))
    await waitFor(() => expect(convertQuote).toHaveBeenCalledWith(
      expect.objectContaining({ customerRepId: 'dana@bcatcorp.com' }),
    ))
  })
})
