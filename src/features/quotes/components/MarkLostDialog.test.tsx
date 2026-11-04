// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const api = vi.hoisted(() => ({
  markQuoteLost: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { MarkLostDialog } from './MarkLostDialog'
import type { QuoteRecord } from '@/types/tms'

describe('MarkLostDialog', () => {
  it('closes the quote with the chosen reason and note, so the lane history records a loss', async () => {
    api.markQuoteLost.mockResolvedValue({ quote: {} })
    const onDone = vi.fn()
    const quote = { id: 'Q000012', side: 'SELL', status: 'QUOTED', version: 4 } as unknown as QuoteRecord
    render(<MarkLostDialog open quote={quote} onOpenChange={() => {}} onDone={onDone} />)

    fireEvent.change(screen.getByLabelText('Why we did not get it'), { target: { value: 'TRUCK_NOT_AVAILABLE' } })
    fireEvent.change(screen.getByLabelText('Anything worth remembering'), { target: { value: 'went with Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark the quote lost' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(api.markQuoteLost).toHaveBeenCalledWith({ quoteId: 'Q000012', expectedVersion: 4, reason: 'TRUCK_NOT_AVAILABLE', note: 'went with Acme' })
  })
})
