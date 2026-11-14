// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const financeAction = vi.fn()
const setDeliveredDate = vi.fn()
vi.mock('@/lib/apiClient', () => ({
  financeAction: (...a: unknown[]) => financeAction(...a),
  setDeliveredDate: (...a: unknown[]) => setDeliveredDate(...a),
  listFinanceReviewShipments: vi.fn(async () => []),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { NeedsReviewList } from './NeedsReview'
import { sortReview } from './useNeedsReview'

const rows = [
  { id: 'shp-2', number: '14433', customerName: 'BATORY FOODS', status: 'DELIVERED', financeReviewAt: '2026-11-13T20:00:00Z', financeReviewReason: 'AR sheet carrier CES DEVELOPMENT INC owed; no carrier on shipment', financeReviewApNote: 'AR sheet: $700.00 owed to CES DEVELOPMENT INC' },
  { id: 'shp-1', number: '13823', customerName: 'SPOT', status: 'DELIVERED', financeReviewAt: '2026-11-13T19:00:00Z', financeReviewReason: 'AR sheet: conflict — on paid and outstanding lists', financeReviewApNote: null },
]

describe('NeedsReviewList', () => {
  beforeEach(() => financeAction.mockReset())

  it('shows the reason on AR but keeps the carrier note (carrier pay) to AP', () => {
    const { unmount } = render(<MemoryRouter><NeedsReviewList side="AR" rows={rows} error={null} onCleared={() => {}} /></MemoryRouter>)
    expect(screen.getByText(/no carrier on shipment/)).toBeTruthy()
    expect(screen.queryByText(/\$700\.00/)).toBeNull()
    unmount()
    render(<MemoryRouter><NeedsReviewList side="AP" rows={rows} error={null} onCleared={() => {}} /></MemoryRouter>)
    expect(screen.getByText(/\$700\.00 owed/)).toBeTruthy()
  })

  it('clears a flag through CLEAR_FINANCE_REVIEW and refreshes', async () => {
    financeAction.mockResolvedValue({ cleared: true })
    const onCleared = vi.fn()
    render(<MemoryRouter><NeedsReviewList side="AR" rows={[rows[1]]} error={null} onCleared={onCleared} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    await waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(financeAction).toHaveBeenCalledWith('CLEAR_FINANCE_REVIEW', { shipmentId: 'shp-1' })
  })

  it('adds a missing delivered date through SET_DELIVERED_DATE and refreshes', async () => {
    setDeliveredDate.mockResolvedValue({ shipmentId: 'shp-1', deliveredAt: '2026-10-13T17:00:00.000Z', reviewCleared: true, reviewReason: null, redatedBills: 1 })
    const onCleared = vi.fn()
    render(<MemoryRouter><NeedsReviewList side="AP" rows={[{ ...rows[1], financeReviewReason: 'Missing delivered date', deliveredAt: null }]} error={null} onCleared={onCleared} /></MemoryRouter>)
    expect(screen.getByText('Missing')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit delivered date for PRO 13823' }))
    fireEvent.change(screen.getByLabelText('Delivered date for PRO 13823'), { target: { value: '2026-10-13' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(setDeliveredDate).toHaveBeenCalledWith({ shipmentId: 'shp-1', deliveredDate: '2026-10-13' })
  })

  it('searches its own rows by PRO, customer or reason', () => {
    render(<MemoryRouter><NeedsReviewList side="AR" rows={rows} error={null} onCleared={() => {}} /></MemoryRouter>)
    fireEvent.change(screen.getByTestId('needs-review-search-ar'), { target: { value: 'spot' } })
    expect(screen.queryByText('BATORY FOODS')).toBeNull()
    expect(screen.getByText('1 of 2 rows')).toBeTruthy()
    fireEvent.change(screen.getByTestId('needs-review-search-ar'), { target: { value: '14433' } })
    expect(screen.getByText('BATORY FOODS')).toBeTruthy()
  })

  it('lists the oldest flag first', () => {
    expect(sortReview(rows).map((r) => r.number)).toEqual(['13823', '14433'])
  })

  // Ryne 2026-11-14: on AR, the PRO opens the invoice when there is one; no invoice keeps the shipment link.
  it('opens the invoice from the PRO when the shipment has one, else links the shipment', () => {
    const invoice = { id: 'inv-9', shipmentId: 'shp-2', number: '14433' } as never
    const onOpenInvoice = vi.fn()
    render(
      <MemoryRouter>
        <NeedsReviewList side="AR" rows={rows} error={null} onCleared={() => {}}
          invoiceFor={(id) => (id === 'shp-2' ? invoice : undefined)} onOpenInvoice={onOpenInvoice} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open invoice for PRO 14433' }))
    expect(onOpenInvoice).toHaveBeenCalledWith(invoice)
    expect(screen.getByRole('link', { name: '13823' })).toBeTruthy()
  })
})
