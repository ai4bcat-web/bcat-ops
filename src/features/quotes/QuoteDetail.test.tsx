// @vitest-environment jsdom
/**
 * The editor's job here is to open on the customer it was sent to, and — since Step K —
 * on the proposal a QUOTE run read out of an e-mail.
 *
 * A customer's profile links to `/quotes/new?customerId=…`, so the one thing worth
 * asserting about a blank quote is that the link lands: the Customer picker shows that
 * customer, which is what makes the pricing defaults and the default charge lines
 * `SAVE_QUOTE` applies the right ones. The matching rule is that a saved quote ignores
 * the parameter — the row's own customer is the truth. The rest of the page is priced by
 * `priceQuoteLines` and asserted in `quoteViews.test.ts` without a browser.
 *
 * `?run=…` is the agent's only door into a quote, so what is asserted is the whole of it:
 * what a proposal seeds, that a spent run seeds nothing and says so, and that Save raises
 * the quote here — under the operator's identity, with `workflowRunId` — before the run is
 * linked to the id that came back. A failed link leaves the quote saved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QuoteDetail } from './QuoteDetail'
import { getWorkflowRun, linkWorkflowRun, priceFromMarket, saveQuote } from '@/lib/apiClient'
import type { MarketRateResult } from '@/lib/apiClient'
import { toast } from 'sonner'
import type { QuotePricingResult } from '@/lib/quotes'
import type { CustomerRecord, QuoteRecord, WorkflowRunRecord } from '@/types/tms'

const quoteMock = vi.hoisted(() => vi.fn())
const directoryMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useQuote', () => ({ useQuote: quoteMock }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: directoryMock }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/apiClient', () => ({
  acceptCounter: vi.fn().mockResolvedValue({}),
  cancelQuote: vi.fn().mockResolvedValue({}),
  getTmsSettings: vi.fn().mockResolvedValue({ id: 'tms', marginFloorBps: 1_000 }),
  getWorkflowRun: vi.fn().mockResolvedValue(null),
  graphqlErrorText: (e: unknown) => String(e),
  linkWorkflowRun: vi.fn().mockResolvedValue({}),
  priceFromMarket: vi.fn(),
  restoreQuote: vi.fn().mockResolvedValue({}),
  saveQuote: vi.fn().mockResolvedValue({}),
}))
// The panel and the dialogs read their own data; here they would only drag the lane
// statistics and the shipment Lambda into a test about which customer is picked.
vi.mock('./components/LaneHistoryPanel', () => ({ LaneHistoryPanel: () => null }))
vi.mock('./components/PushToDatCard', () => ({
  PushToDatCard: (p: { quoteId: string; disabled?: boolean }) => <div data-testid="push-dat-mock" data-quote={p.quoteId} data-disabled={String(!!p.disabled)} />,
}))
// Echoes what the page hands the panel: the panel's own sections are tested in RateIntelligencePanel.test.
vi.mock('./components/RateIntelligencePanel', () => ({
  RateIntelligencePanel: (p: { lane: { originCity?: string; destinationCity?: string } | null; equipmentType: string | null; excludeQuoteId: string | null }) => (
    <div data-testid="rate-intel-mock" data-lane={p.lane ? `${p.lane.originCity}>${p.lane.destinationCity}` : ''} data-equipment={p.equipmentType ?? ''} data-exclude={p.excludeQuoteId ?? ''} />
  ),
}))
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
      <Routes>
        <Route path={path} element={<QuoteDetail />} />
        {/* Saving a new quote navigates to it; a stub keeps the router off the console. */}
        <Route path="/tms/rates/:id" element={<div data-testid="saved-quote" />} />
      </Routes>
    </MemoryRouter>,
  )
}

const RUN_ID = 'wf:QUOTE:abc123'

/** A QUOTE run as the agent leaves it: COMPLETED, PROPOSED, and applied by nobody. */
function run(patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: RUN_ID,
    agent: 'QUOTE',
    status: 'COMPLETED',
    outcome: 'PROPOSED',
    sourceId: 'gmail:9f2c',
    subject: 'Need a rate Joliet to Dallas Wednesday',
    fromName: 'Dana Platt',
    fromEmail: 'dana@acme.test',
    partyKind: 'CUSTOMER',
    partyId: 'CUST-1',
    partyName: 'Acme Freight',
    partyMatchHow: 'EMAIL',
    proposalKind: 'QUOTE',
    proposal: {
      kind: 'QUOTE',
      customerName: 'Acme Freight',
      origin: { city: 'Joliet', state: 'IL', zip: '60432' },
      destination: { city: 'Dallas', state: 'TX', zip: '75201' },
      pickupDate: '2026-03-18',
      deliveryDate: '2026-03-20',
      equipmentType: '53 van',
      commodity: 'Canned goods',
      weightLbs: 42_000,
      targetRateCents: 185_000,
    },
    createdBy: 'workflow-agent',
    updatedBy: 'workflow-agent',
    version: 3,
    ...patch,
  }
}

/** What `SAVE_QUOTE` answers with, which is the row and what pricing made of it. */
function saved(id: string): { quote: QuoteRecord; pricing: QuotePricingResult } {
  return {
    quote: quote({ id }),
    pricing: {
      customerRateCents: 185_000,
      revenueCents: 185_000,
      carrierRateCents: 0,
      costCents: 0,
      profitCents: 185_000,
      marginBps: 10_000,
      topSpendCents: 166_500,
      targetBuyCents: null,
      lines: [],
      warnings: [],
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('Rate intelligence on the quote page', () => {
  it('is shown for a saved quote with its own lane and equipment, excluding the quote itself', () => {
    setup('/tms/rates/Q000007', '/tms/rates/:id', quote({
      id: 'Q000007',
      equipmentType: 'VAN',
      stops: [
        { id: 's1', type: 'pickup', city: 'Chicago, IL', address: { city: 'Chicago', state: 'IL', zip: '60601' }, appt: '', driverId: null, sequence: 0 },
        { id: 's2', type: 'delivery', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX', zip: '75201' }, appt: '', driverId: null, sequence: 1 },
      ] as unknown as QuoteRecord['stops'],
    }))
    const panel = screen.getByTestId('rate-intel-mock')
    expect(panel).toHaveAttribute('data-lane', 'Chicago>Dallas')
    expect(panel).toHaveAttribute('data-equipment', 'VAN')
    expect(panel).toHaveAttribute('data-exclude', 'Q000007')
  })

  it('offers Push to DAT on an open quote, switched off once it is closed or a shipment', () => {
    setup('/tms/rates/Q000008', '/tms/rates/:id', quote({ id: 'Q000008', status: 'QUOTED' }))
    expect(screen.getByTestId('push-dat-mock')).toHaveAttribute('data-disabled', 'false')
    cleanup()
    setup('/tms/rates/Q000009', '/tms/rates/:id', quote({ id: 'Q000009', status: 'LOST' }))
    expect(screen.getByTestId('push-dat-mock')).toHaveAttribute('data-disabled', 'true')
    cleanup()
    setup('/tms/rates/Q000010', '/tms/rates/:id', quote({ id: 'Q000010', status: 'QUOTED', shipmentId: 'S1' }))
    expect(screen.getByTestId('push-dat-mock')).toHaveAttribute('data-disabled', 'true')
  })
})

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

describe('a quote raised from a spot request', () => {
  it('links back to the request it answers, and only then', async () => {
    const { unmount } = setup('/quotes/Q-8', '/quotes/:id', quote({ id: 'Q-8', customerId: 'CUST-1', spotRequestId: 'sr:u1:m1' }))
    const chip = await screen.findByTestId('quote-spot-chip')
    expect(chip.getAttribute('href')).toBe('/tms/rates/spot?request=sr%3Au1%3Am1')
    unmount()
    setup('/quotes/Q-9', '/quotes/:id', quote({ id: 'Q-9', customerId: 'CUST-1' }))
    await screen.findByLabelText('Customer')
    expect(screen.queryByTestId('quote-spot-chip')).toBeNull()
  })
})

describe('a quote seeded from a QUOTE run', () => {
  it('opens on the customer, lane and dates the proposal states', async () => {
    vi.mocked(getWorkflowRun).mockResolvedValue(run())
    setup(`/quotes/new?run=${RUN_ID}`, '/quotes/new')

    const picker = await screen.findByLabelText<HTMLSelectElement>('Customer')
    // The run matched the sender's own address, so the id is safe to pre-pick.
    await waitFor(() => expect(picker.value).toBe('CUST-1'))
    expect(screen.getByLabelText<HTMLInputElement>('Stop 1 city').value).toBe('Joliet')
    expect(screen.getByLabelText<HTMLInputElement>('Stop 1 state').value).toBe('IL')
    expect(screen.getByLabelText<HTMLInputElement>('Stop 2 city').value).toBe('Dallas')
    expect(screen.getByLabelText<HTMLInputElement>('Stop 1 appointment').value).toBe('2026-03-18T00:00')
    expect(screen.getByLabelText<HTMLInputElement>('Stop 2 appointment').value).toBe('2026-03-20T00:00')
    expect(screen.getByLabelText<HTMLInputElement>('Equipment').value).toBe('53 van')
    expect(screen.getByLabelText<HTMLInputElement>('Weight (lbs)').value).toBe('42000')
    expect(screen.getByLabelText<HTMLInputElement>('Contact e-mail').value).toBe('dana@acme.test')
    // Their target is recorded where the desk reads it, never as a price we quoted.
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Internal/).value).toContain('$1,850.00')
    expect(screen.getByRole('link', { name: RUN_ID }).getAttribute('href')).toBe(`/tms/workflows/runs/${RUN_ID}`)
  })

  it('seeds nothing from a run somebody already applied, and says why', async () => {
    vi.mocked(getWorkflowRun).mockResolvedValue(run({ outcome: 'APPLIED' }))
    setup(`/quotes/new?run=${RUN_ID}`, '/quotes/new')

    expect(await screen.findByText(/is already applied, so nothing was seeded/)).toBeTruthy()
    expect(screen.getByLabelText<HTMLSelectElement>('Customer').value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>('Stop 1 city').value).toBe('')
    expect(screen.queryByRole('link', { name: RUN_ID })).toBeNull()
  })

  it('saves the quote here and then links the run to the id that came back', async () => {
    vi.mocked(getWorkflowRun).mockResolvedValue(run())
    vi.mocked(saveQuote).mockResolvedValue(saved('Q000007'))
    vi.mocked(linkWorkflowRun).mockResolvedValue(run({ outcome: 'APPLIED', quoteId: 'Q000007' }))
    setup(`/quotes/new?run=${RUN_ID}`, '/quotes/new')
    await screen.findByRole('link', { name: RUN_ID })

    fireEvent.click(screen.getByLabelText('Save the quote'))

    await waitFor(() => expect(linkWorkflowRun).toHaveBeenCalled())
    // SAVE_QUOTE is what writes the quote — from here, with the operator's own token —
    // and `intake` is what lands it in REQUESTED. The link is a second, later call.
    expect(vi.mocked(saveQuote).mock.calls[0]?.[0]).toMatchObject({
      intake: true,
      workflowRunId: RUN_ID,
      customerId: 'CUST-1',
    })
    expect(linkWorkflowRun).toHaveBeenCalledWith(RUN_ID, { quoteId: 'Q000007' }, 3)
  })

  it('leaves the quote saved when the run cannot be linked to it', async () => {
    vi.mocked(getWorkflowRun).mockResolvedValue(run())
    vi.mocked(saveQuote).mockResolvedValue(saved('Q000007'))
    vi.mocked(linkWorkflowRun).mockRejectedValue(new Error('LINK_RUN refuses an APPLIED run'))
    setup(`/quotes/new?run=${RUN_ID}`, '/quotes/new')
    await screen.findByRole('link', { name: RUN_ID })

    fireEvent.click(screen.getByLabelText('Save the quote'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(saveQuote).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Q000007 saved'))
    // The row exists, so the page moves on to it rather than offering to save again.
    expect(await screen.findByTestId('saved-quote')).toBeTruthy()
  })
})

describe('market-rate panel', () => {
  const marketQuote = quote({
    id: 'Q-MKT',
    side: 'SELL',
    status: 'DRAFT',
    customerId: 'CUST-1',
    equipmentType: 'VAN',
    miles: 900,
    mode: 'FTL',
    stops: [
      { id: 'pu', type: 'pickup', city: 'Joliet, IL', address: { city: 'Joliet', state: 'IL' }, appt: '', driverId: null, sequence: 0 },
      { id: 'de', type: 'delivery', city: 'Dallas, TX', address: { city: 'Dallas', state: 'TX' }, appt: '', driverId: null, sequence: 1 },
    ],
  } as Partial<QuoteRecord> & { id: string })

  function marketAnswer(stub: boolean): MarketRateResult {
    return {
      answer: {
        averageCents: 180_000,
        lowCents: 170_000,
        highCents: 200_000,
        fuelCents: 18_000,
        perMileCents: 200,
        miles: 900,
        reports: 42,
        days: 1,
        stub,
        source: 'DAT_RATEVIEW',
        message: stub ? 'DAT stub' : 'DAT live',
      },
      targetBps: 2500,
      floorBps: 1200,
      autoReply: false,
      suggestedSellCents: 225_000,
      belowFloor: false,
      floorSellCents: 202_000,
      marginAtSuggested: 2500,
    }
  }

  it('renders the market number, STUB badge, margins, suggested rate and Send suggested', async () => {
    vi.mocked(priceFromMarket).mockResolvedValue(marketAnswer(true))
    setup('/quotes/Q-MKT', '/quotes/:id', marketQuote)

    fireEvent.click(await screen.findByLabelText('Price this lane from the market'))
    await waitFor(() => expect(screen.getByText('$1,800.00')).toBeVisible())
    expect(screen.getByText('STUB')).toBeVisible()
    expect(screen.getByText(/target 25\.00%/)).toBeVisible()
    expect(screen.getByText(/floor 12\.00%/)).toBeVisible()
    expect(screen.getByText('suggested $2,250.00')).toBeVisible()
    expect(screen.getByLabelText('Send the suggested rate')).toBeEnabled()
  })

  it('refuses to auto-send a rate that is below the floor', async () => {
    const below = marketAnswer(false)
    below.belowFloor = true
    below.suggestedSellCents = 190_000
    below.floorSellCents = 202_000
    vi.mocked(priceFromMarket).mockResolvedValue(below)
    setup('/quotes/Q-MKT', '/quotes/:id', marketQuote)

    fireEvent.click(await screen.findByLabelText('Price this lane from the market'))
    await waitFor(() => expect(screen.getByText('suggested $1,900.00')).toBeVisible())
    expect(screen.queryByLabelText('Send the suggested rate')).toBeNull()
    expect(screen.getByText(/Below floor/)).toBeVisible()
    expect(screen.getByText(/raising the rate above \$2,020\.00/)).toBeVisible()
  })

  it('fills the existing send flow when Send suggested is clicked', async () => {
    const answer = marketAnswer(true)
    vi.mocked(priceFromMarket)
      .mockResolvedValueOnce(answer)
      .mockResolvedValueOnce({ ...answer, quote: { ...marketQuote, amountCents: 225_000 } })
    setup('/quotes/Q-MKT', '/quotes/:id', marketQuote)

    fireEvent.click(await screen.findByLabelText('Price this lane from the market'))
    await waitFor(() => expect(screen.getByText('suggested $2,250.00')).toBeVisible())
    fireEvent.click(screen.getByLabelText('Send the suggested rate'))

    await waitFor(() => expect(priceFromMarket).toHaveBeenCalledTimes(2))
    const saveCall = vi.mocked(priceFromMarket).mock.calls[1]?.[0]
    expect(saveCall).toMatchObject({ save: true, expectedUpdatedAt: marketQuote.updatedAt })
    // Refreshing re-renders the page; the send dialog mock is present so the route is stable.
    expect(saveCall).toMatchObject({ quoteId: 'Q-MKT' })
  })
})
