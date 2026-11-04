// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const api = vi.hoisted(() => ({
  listShipmentPostings: vi.fn(),
  postQuoteLoad: vi.fn(),
  unpostQuoteLoad: vi.fn(),
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { PushToDatCard } from './PushToDatCard'

const row = (over: Record<string, unknown> = {}) => ({
  id: 'post:quote:Q1:DAT', shipmentId: 'quote:Q1', provider: 'DAT', status: 'POSTED', mode: 'STUB',
  message: 'STUB — no DAT call was made', postedAt: '2026-11-04T12:00:00Z', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.listShipmentPostings.mockResolvedValue([])
})

describe('PushToDatCard', () => {
  it('pushes a quote to DAT and then shows the recorded posting, labelled STUB, with Unpost', async () => {
    api.postQuoteLoad.mockImplementation(async () => { api.listShipmentPostings.mockResolvedValue([row()]); return { postings: [row()] } })
    render(<PushToDatCard quoteId="Q1" spotRequestId="sr:u1:m1" />)
    expect(await screen.findByText('Not posted to DAT.')).toBeInTheDocument()
    expect(screen.queryByTestId('push-dat-unpost')).toBeNull()

    fireEvent.click(screen.getByTestId('push-dat-post'))
    await waitFor(() => expect(api.postQuoteLoad).toHaveBeenCalledWith({ quoteId: 'Q1', spotRequestId: 'sr:u1:m1', providers: ['DAT'] }))
    expect(await screen.findByTestId('push-dat-stub')).toHaveTextContent('STUB')
    expect(screen.getByTestId('push-dat-status')).toHaveTextContent('POSTED')
    expect(screen.getByTestId('push-dat-unpost')).toBeInTheDocument()
  })

  it('unposts the quote\'s row and shows UNPOSTED', async () => {
    api.listShipmentPostings.mockResolvedValue([row()])
    api.unpostQuoteLoad.mockImplementation(async () => { api.listShipmentPostings.mockResolvedValue([row({ status: 'UNPOSTED', unpostedAt: '2026-11-04T13:00:00Z' })]); return {} })
    render(<PushToDatCard quoteId="Q1" />)
    fireEvent.click(await screen.findByTestId('push-dat-unpost'))
    await waitFor(() => expect(api.unpostQuoteLoad).toHaveBeenCalledWith({ quoteId: 'Q1', spotRequestId: null, providers: ['DAT'] }))
    await waitFor(() => expect(screen.getByTestId('push-dat-status')).toHaveTextContent('UNPOSTED'))
    expect(screen.queryByTestId('push-dat-unpost')).toBeNull()
  })

  it('labels a live posting LIVE', async () => {
    api.listShipmentPostings.mockResolvedValue([row({ mode: 'LIVE', message: 'posted' })])
    render(<PushToDatCard quoteId="Q1" />)
    expect(await screen.findByTestId('push-dat-live')).toBeInTheDocument()
    expect(screen.queryByTestId('push-dat-stub')).toBeNull()
  })

  it('posts a spot request with no quote from its own lane', async () => {
    api.postQuoteLoad.mockResolvedValue({ postings: [] })
    render(<PushToDatCard spotRequestId="sr:u1:m2" load={{ originCity: 'Joliet', originState: 'IL', destinationCity: 'Austin', destinationState: 'TX', equipmentType: 'VAN' }} />)
    fireEvent.click(await screen.findByTestId('push-dat-post'))
    await waitFor(() => expect(api.postQuoteLoad).toHaveBeenCalledWith(expect.objectContaining({ quoteId: null, spotRequestId: 'sr:u1:m2', originCity: 'Joliet', equipmentType: 'VAN' })))
    expect(api.listShipmentPostings).toHaveBeenCalledWith('spot:sr:u1:m2')
  })

  it('will not post when the page says it cannot, and says why', async () => {
    render(<PushToDatCard quoteId="Q1" disabled disabledReason="A closed quote cannot be posted." />)
    expect(await screen.findByText('A closed quote cannot be posted.')).toBeInTheDocument()
    expect(screen.getByTestId('push-dat-post')).toBeDisabled()
  })
})
