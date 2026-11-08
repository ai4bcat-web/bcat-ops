// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const api = vi.hoisted(() => ({
  markQuoteWon: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { MarkWonDialog } from './MarkWonDialog'
import type { QuoteRecord } from '@/types/tms'

describe('MarkWonDialog', () => {
  it('records the win by hand with the note, so the lane win rate counts it', async () => {
    api.markQuoteWon.mockResolvedValue({ quote: {} })
    const onDone = vi.fn()
    const quote = { id: 'Q000012', side: 'SELL', status: 'QUOTED', version: 4 } as unknown as QuoteRecord
    render(<MarkWonDialog open quote={quote} onOpenChange={() => {}} onDone={onDone} />)

    fireEvent.change(screen.getByLabelText('Anything worth remembering'), { target: { value: 'booked by phone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark the quote won' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(api.markQuoteWon).toHaveBeenCalledWith({ quoteId: 'Q000012', expectedVersion: 4, note: 'booked by phone' })
  })

  it('shows the server refusal and does not finish', async () => {
    api.markQuoteWon.mockRejectedValue(new Error('That quote is already WON'))
    const onDone = vi.fn()
    const quote = { id: 'Q1', side: 'SELL', status: 'QUOTED', version: 1 } as unknown as QuoteRecord
    render(<MarkWonDialog open quote={quote} onOpenChange={() => {}} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark the quote won' }))
    expect(await screen.findByText('That quote is already WON')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
  })
})
