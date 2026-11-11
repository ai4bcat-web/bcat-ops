// @vitest-environment jsdom
/**
 * The board's job is to be believed about what is on the table.
 *
 * Two things are worth a test here: a row has to appear under the tab that describes what
 * is actually true of it — a quote sitting with a customer is not a draft and not a
 * reply — and the per-tab counts have to be the counts of the rows the tab draws, because
 * those counts are what somebody works down. The rest of the arithmetic is asserted in
 * `quoteViews.test.ts` without a browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QuotesPage } from './QuotesPage'
import type { QuoteRecord, QuoteStatus } from '@/types/tms'

const worklistMock = vi.hoisted(() => vi.fn())
const monthMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useQuoteWorklist', () => ({ useQuoteWorklist: worklistMock }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/apiClient', () => ({
  acceptCounter: vi.fn().mockResolvedValue({}),
  getTmsSettings: vi.fn().mockResolvedValue({ id: 'tms', marginFloorBps: 1_000 }),
  graphqlErrorText: (e: unknown) => String(e),
  listQuotesByMonth: monthMock,
  rejectOffer: vi.fn().mockResolvedValue({}),
  restoreQuote: vi.fn().mockResolvedValue({}),
}))
// The dialogs read their own context and have their own behaviour; here they would only
// drag the shipment Lambda into a test about the board.
vi.mock('./components/AcceptOfferDialog', () => ({ AcceptOfferDialog: () => null }))
vi.mock('./components/ConvertQuoteDialog', () => ({ ConvertQuoteDialog: () => null }))
vi.mock('./components/CounterDialog', () => ({ CounterDialog: () => null }))
vi.mock('./components/MarkLostDialog', () => ({ MarkLostDialog: () => null }))
vi.mock('./components/SendQuoteDialog', () => ({ SendQuoteDialog: () => null }))

const TOMORROW = new Date(Date.now() + 86_400_000).toISOString()
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString()

function quote(patch: Partial<QuoteRecord> & { id: string; status: QuoteStatus }): QuoteRecord {
  return {
    side: 'SELL',
    quoteDate: '2026-03-10',
    quoteMonth: '2026-03',
    customerName: 'Acme Freight',
    amountCents: 150_000,
    rounds: 1,
    createdBy: 'rep@bcat',
    updatedBy: 'rep@bcat',
    version: 1,
    ...patch,
  }
}

async function setup(options: { open?: QuoteRecord[]; month?: QuoteRecord[] } = {}) {
  worklistMock.mockReturnValue({
    open: options.open ?? [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
  monthMock.mockResolvedValue(options.month ?? [])
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(<MemoryRouter><QuotesPage /></MemoryRouter>) })
  return view
}

beforeEach(() => vi.clearAllMocks())

describe('the quote board', () => {
  it('offers every view of the pipeline, and each one renders', async () => {
    await setup({ open: [quote({ id: 'Q1', status: 'REQUESTED' })] })
    for (const label of ['To price', 'Sent', 'Replies', 'Drafts', 'Won / Lost', 'Carrier offers']) {
      // The MVMNT quick tab carries its count inside the button, so the accessible
      // name is "To price 1"; the tab is still identified by the label it leads with.
      const tab = screen.getByRole('tab', { name: new RegExp(`^${label.replace('/', '.')}`) })
      fireEvent.click(tab)
      expect(tab.getAttribute('aria-selected')).toBe('true')
    }
    // The last click landed on Carrier offers, whose empty state is its own sentence.
    expect(screen.getByText('No offer is out with a carrier.')).toBeTruthy()
  })

  it('counts each tab by the rows that tab actually draws', async () => {
    await setup({
      open: [
        quote({ id: 'Q1', status: 'REQUESTED' }),
        quote({ id: 'Q2', status: 'QUOTED', expiresAt: TOMORROW }),
        quote({ id: 'Q3', status: 'SENT_COUNTER', expiresAt: TOMORROW }),
        quote({ id: 'Q4', status: 'RECEIVED_COUNTER', counterCents: 140_000 }),
        quote({ id: 'Q5', status: 'DRAFT' }),
        quote({ id: 'Q6', status: 'REQUESTED', side: 'BUY', carrierName: 'Blue Line' }),
      ],
    })

    const counts: Record<string, string> = {
      'To price': '1', Sent: '2', Replies: '1', Drafts: '1', 'Carrier offers': '1',
    }
    for (const [label, count] of Object.entries(counts)) {
      expect(within(screen.getByRole('tab', { name: new RegExp(`^${label}`) })).getByText(count)).toBeTruthy()
    }

    // To price is the opening tab, and it draws the one REQUESTED sell quote.
    expect(screen.getByRole('link', { name: 'Price quote Q1' })).toBeTruthy()
  })

  /**
   * An expired quote is re-sendable, never convertible: the number went out with an hour
   * on it and that hour is gone. Both facts come off `quoteState`, so the row cannot
   * offer a verb the Lambda would refuse.
   */
  it('offers Re-send and not Convert on a quote whose link has lapsed', async () => {
    await setup({ open: [quote({ id: 'Q9', status: 'QUOTED', expiresAt: YESTERDAY, linkToken: 'tok' })] })
    fireEvent.click(screen.getByRole('tab', { name: /^Sent/ }))

    expect(screen.getAllByText('Expired').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Re-send Q9' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Convert Q9' })).toBeNull()
  })

  it('leads with the money on the table and a win rate a quiet month cannot break', async () => {
    await setup({ open: [quote({ id: 'Q1', status: 'QUOTED', amountCents: 250_000, expiresAt: TOMORROW })] })

    const strip = within(screen.getByLabelText('Quote totals'))
    const tile = (label: string) => within(strip.getByText(label).closest('.tms-kpi-card') as HTMLElement)
    expect(tile('Open quotes').getByText('$2,500.00')).toBeTruthy()
    expect(tile('Win rate').getByText('0%')).toBeTruthy()
    // Nobody has answered anything, so the reply time is unmeasured rather than zero.
    expect(tile('Median hours to reply').getByText('—')).toBeTruthy()
  })

  it('shows each sent quote as Pending or Expired in one outcome column', async () => {
    await setup({
      open: [
        quote({ id: 'Q1', status: 'QUOTED', expiresAt: TOMORROW }),
        quote({ id: 'Q2', status: 'QUOTED', expiresAt: YESTERDAY }),
      ],
    })
    fireEvent.click(screen.getByRole('tab', { name: /^Sent/ }))
    const outcomes = screen.getAllByTestId('quote-outcome').map((n) => n.textContent)
    expect([...outcomes].sort()).toEqual(['Expired', 'Pending'])
  })

  it('filters Won / Lost by outcome, a converted quote counting as Won', async () => {
    await setup({
      month: [
        quote({ id: 'QW', status: 'WON', shipmentId: 'S1', closedAt: '2026-03-12T00:00:00Z' }),
        quote({ id: 'QL', status: 'LOST', lostReason: 'TOO_HIGH', closedAt: '2026-03-11T00:00:00Z' }),
      ],
    })
    fireEvent.click(screen.getByRole('tab', { name: /^Won \/ Lost/ }))
    await waitFor(() => expect(screen.getAllByTestId('quote-outcome')).toHaveLength(2))

    fireEvent.click(screen.getByText('Outcome is'))
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'WON' } })
    await waitFor(() => expect(screen.getAllByTestId('quote-outcome').map((n) => n.textContent)).toEqual(['Won']))
  })

  it('opens the clearly-labelled demo Customers view and returns to the real list', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: /customers \(demo\)/i }))
    expect(screen.getAllByTestId('demo-badge').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /back to spot quotes/i }))
    expect(screen.getByRole('button', { name: /customers \(demo\)/i })).toBeTruthy()
  })
})
