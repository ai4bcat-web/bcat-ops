// @vitest-environment jsdom
/**
 * The editor's job here is to open on the customer it was sent to.
 *
 * A customer's profile links to `/quotes/new?customerId=…`, so the one thing worth
 * asserting about a blank quote is that the link lands: the Customer picker shows that
 * customer, which is what makes the pricing defaults and the default charge lines
 * `SAVE_QUOTE` applies the right ones. The matching rule is that a saved quote ignores
 * the parameter — the row's own customer is the truth. The rest of the page is priced by
 * `priceQuoteLines` and asserted in `quoteViews.test.ts` without a browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QuoteDetail } from './QuoteDetail'
import type { CustomerRecord, QuoteRecord } from '@/types/tms'

const quoteMock = vi.hoisted(() => vi.fn())
const directoryMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useQuote', () => ({ useQuote: quoteMock }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: directoryMock }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/apiClient', () => ({
  acceptCounter: vi.fn().mockResolvedValue({}),
  cancelQuote: vi.fn().mockResolvedValue({}),
  getTmsSettings: vi.fn().mockResolvedValue({ id: 'tms', marginFloorBps: 1_000 }),
  graphqlErrorText: (e: unknown) => String(e),
  restoreQuote: vi.fn().mockResolvedValue({}),
  saveQuote: vi.fn().mockResolvedValue({}),
}))
// The panel and the dialogs read their own data; here they would only drag the lane
// statistics and the shipment Lambda into a test about which customer is picked.
vi.mock('./components/LaneHistoryPanel', () => ({ LaneHistoryPanel: () => null }))
vi.mock('./components/ConvertQuoteDialog', () => ({ ConvertQuoteDialog: () => null }))
vi.mock('./components/CounterDialog', () => ({ CounterDialog: () => null }))
vi.mock('./components/DuplicateQuoteDialog', () => ({ DuplicateQuoteDialog: () => null }))
vi.mock('./components/MarkLostDialog', () => ({ MarkLostDialog: () => null }))
vi.mock('./components/SendQuoteDialog', () => ({ SendQuoteDialog: () => null }))

const CUSTOMERS: CustomerRecord[] = [
  { id: 'CUST-1', name: 'Acme Freight' },
  { id: 'CUST-2', name: 'Borealis Foods' },
]

function quote(patch: Partial<QuoteRecord> & { id: string }): QuoteRecord {
  return {
    side: 'SELL',
    status: 'DRAFT',
    quoteDate: '2026-03-10',
    quoteMonth: '2026-03',
    amountCents: 150_000,
    rounds: 1,
    createdBy: 'rep@bcat',
    updatedBy: 'rep@bcat',
    version: 1,
    ...patch,
  }
}

function setup(entry: string, path: string, row: QuoteRecord | null = null) {
  quoteMock.mockReturnValue({
    quote: row,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })
  directoryMock.mockReturnValue({ customers: CUSTOMERS })
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path={path} element={<QuoteDetail />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('the quote editor', () => {
  it('opens a new quote on the customer the link named', async () => {
    setup('/quotes/new?customerId=CUST-2', '/quotes/new')
    const picker = await screen.findByLabelText<HTMLSelectElement>('Customer')
    expect(picker.value).toBe('CUST-2')
  })

  it('leaves the picker empty when the link named nobody', async () => {
    setup('/quotes/new', '/quotes/new')
    const picker = await screen.findByLabelText<HTMLSelectElement>('Customer')
    expect(picker.value).toBe('')
  })

  it('keeps a saved quote on its own customer whatever the query string says', async () => {
    setup('/quotes/Q-7?customerId=CUST-2', '/quotes/:id', quote({ id: 'Q-7', customerId: 'CUST-1' }))
    const picker = await screen.findByLabelText<HTMLSelectElement>('Customer')
    expect(picker.value).toBe('CUST-1')
  })
})
