// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'

const api = vi.hoisted(() => ({
  listActivePostings: vi.fn(),
  getQuote: vi.fn(),
  unpostQuoteLoad: vi.fn(),
  graphqlErrorText: (e: unknown) => String(e),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { QuotePostingsCard } from './QuotePostingsCard'

describe('QuotePostingsCard', () => {
  it('shows the outcome of each posted quote so a won or lost quote is not covered blind', async () => {
    api.listActivePostings.mockResolvedValue([
      { id: 'p1', shipmentId: 'quote:Q1', provider: 'DAT', status: 'POSTED', mode: 'STUB', originCity: 'Chicago', originState: 'IL', destinationCity: 'Dallas', destinationState: 'TX' },
      { id: 'p2', shipmentId: 'S9', provider: 'DAT', status: 'POSTED' },
    ])
    api.getQuote.mockResolvedValue({ id: 'Q1', side: 'SELL', status: 'WON', shipmentId: 'S1' })
    render(<MemoryRouter><QuotePostingsCard /></MemoryRouter>)
    expect(await screen.findByTestId('quote-outcome')).toHaveTextContent('Won')
    expect(api.getQuote).toHaveBeenCalledTimes(1)
  })
})
