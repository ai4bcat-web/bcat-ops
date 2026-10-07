// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Settlement, SettlementWeek } from '../driverApi'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
globalThis.DOMRect ??= class {
  constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
} as never
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

const driverApiMocks = vi.hoisted(() => ({
  fetchSettlementWeeks: vi.fn(),
  fetchSettlement: vi.fn(),
  // The page also hosts the unattached-POD list and the send-anyway actions.
  fetchSubmissions: vi.fn(),
  fetchRecentLoads: vi.fn(),
  attachSubmissionToLoad: vi.fn(),
}))

vi.mock('../driverApi', () => ({
  ...driverApiMocks,
  DriverApiError: class DriverApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'DriverApiError'
    }
  },
}))

// Dynamic import is required here so the component evaluates AFTER vi.mock has
// replaced the driver API module. Static import would cache the real module first.
const { SettlementPage } = await import('./SettlementPage')

const weeksFixture: SettlementWeek[] = [
  { weekStart: '2026-09-20', gross: 1200, net: 900, tripCount: 2 },
  { weekStart: '2026-09-27', gross: 1500, net: 1100, tripCount: 3 },
]

const baseSettlement: Settlement = {
  weekStart: '2026-09-27',
  weekLabel: 'Sep 27 – Oct 3, 2026',
  trips: [
    {
      id: 't1',
      date: '2026-09-28',
      loadId: 'LOAD-101',
      origin: 'Chicago, IL',
      destination: 'Indianapolis, IN',
      miles: 185,
      rate: 3.5,
      freight: 647.5,
      amount: 647.5,
    },
    {
      id: 't2',
      date: '2026-09-29',
      loadId: 'LOAD-102',
      origin: 'Indianapolis, IN',
      destination: 'Columbus, OH',
      miles: 175,
      rate: 3.5,
      freight: 612.5,
      amount: 612.5,
    },
  ],
  grossPay: 1260,
  driverAmount: 1260,
  payPercent: 1,
  heldFreight: 0,
  deductions: [
    { label: 'Fuel', amount: 120 },
    { label: 'Toll refund', amount: -15 },
  ],
  credits: [{ label: 'Detention', amount: 40 }],
  debits: [{ label: 'Cash advance', amount: 100 }],
  checkAmount: 1065,
}

function resetMocks() {
  driverApiMocks.fetchSettlementWeeks.mockResolvedValue(weeksFixture)
  driverApiMocks.fetchSettlement.mockResolvedValue(baseSettlement)
  // Nothing waiting to be attached is the normal state; its own tests cover the rest.
  driverApiMocks.fetchSubmissions.mockResolvedValue([])
  driverApiMocks.fetchRecentLoads.mockResolvedValue([])
}

/*
 * Pinned to a Thursday inside the 2026-09-27 pay week. The page now defaults to
 * whatever week it actually is, so leaving this to the real clock would have
 * these tests start failing the moment the week turned.
 */
const INSIDE_WEEK_SEP27 = new Date('2026-10-01T12:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(INSIDE_WEEK_SEP27)
  resetMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SettlementPage', () => {
  it('defaults to the current pay week and shows the check amount from the API', async () => {
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)
    // Two sequential fetches (weeks, then the statement) must resolve before the amount
    // renders; the 1s default expires under full-suite load.
    await waitFor(() => expect(screen.getAllByText('$1,065.00')).toHaveLength(2), { timeout: 5000 })
    expect(driverApiMocks.fetchSettlement).toHaveBeenCalledWith('2026-09-27')
  })

  it('shows an empty state when the selected week has no trips', async () => {
    driverApiMocks.fetchSettlement.mockResolvedValue({
      ...baseSettlement,
      trips: [],
      grossPay: 0,
      checkAmount: 0,
    })
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('No trips this week')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByText('LOAD-101')).toBeNull()
    expect(screen.getAllByText('$0.00')).toHaveLength(2)
  })

  it('renders deductions using the same sign convention as the staff page', async () => {
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Fuel')).toBeTruthy(), { timeout: 5000 })

    // Positive deduction is shown in red parentheses, like the staff surface.
    expect(screen.getByText('($120.00)')).toBeTruthy()
    // Negative deduction (refund) is shown as a green positive, like the staff surface.
    expect(screen.getByText('+$15.00')).toBeTruthy()
    expect(screen.getByText('Total deductions')).toBeTruthy()
  })

  it('shows the factoring fee line and per-trip factoring readiness', async () => {
    driverApiMocks.fetchSettlement.mockResolvedValue({
      ...baseSettlement,
      deductions: [{ label: 'Factoring fee (2%)', amount: 25.2 }, ...baseSettlement.deductions],
      trips: [
        {
          ...baseSettlement.trips[0],
          factoring: {
            invoiceNo: '14452',
            poNumber: 'PO-1',
            brokerMc: '123456',
            invoiceAmount: 1260,
            invoiceDate: '2026-09-28',
            fromCity: 'Chicago',
            fromState: 'IL',
            fromZip: '60601',
            toCity: 'Indianapolis',
            toState: 'IN',
            toZip: '46201',
            podPresent: false,
            rateconPresent: true,
            blocked: true,
          },
        },
      ],
    })
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText('Factoring fee (2%)')).toBeTruthy(), { timeout: 5000 })
    // The row is keyed by PRO, and the POD cell is the action that fixes it.
    expect(screen.getByText('14452')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send the POD for 14452' })).toBeTruthy()
    // The rate con is already in, so that cell is a state, not a prompt.
    expect(screen.getByLabelText('rate confirmation on file for 14452')).toBeTruthy()
  })

  it('does not blame the driver for a rate confirmation the office collects', async () => {
    driverApiMocks.fetchSettlement.mockResolvedValue({
      ...baseSettlement,
      trips: [
        {
          ...baseSettlement.trips[0],
          factoring: {
            invoiceNo: '14452', poNumber: 'PO-1', brokerMc: '123456',
            invoiceAmount: 1260, invoiceDate: '2026-09-28',
            fromCity: 'Chicago', fromState: 'IL', fromZip: '60601',
            toCity: 'Indianapolis', toState: 'IN', toZip: '46201',
            podPresent: true,
            rateconPresent: false,
            blocked: true,
          },
        },
      ],
    })
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)

    // Their POD is in, so nothing is asked of them — even though the load cannot be
    // factored yet without the rate confirmation.
    await waitFor(() => expect(screen.getByLabelText('POD on file for 14452')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByRole('button', { name: 'Send the POD for 14452' })).toBeNull()
    // Offered, never demanded: the office normally supplies this one at factoring.
    expect(screen.getByRole('button', { name: 'Send the rate confirmation for 14452' })).toBeTruthy()
  })

  it('renders a retryable error when the weeks call fails', async () => {
    driverApiMocks.fetchSettlementWeeks.mockRejectedValueOnce(new Error('Network down'))
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText(/Network down/)).toBeTruthy(), { timeout: 5000 })
    const retry = screen.getByRole('button', { name: /Retry/i })
    expect(retry).toBeTruthy()

    fireEvent.click(retry)
    await waitFor(() => expect(screen.getAllByText('$1,065.00')).toHaveLength(2), { timeout: 5000 })
    expect(driverApiMocks.fetchSettlementWeeks).toHaveBeenCalledTimes(2)
  })

  it('renders a retryable error when the statement call fails', async () => {
    driverApiMocks.fetchSettlement.mockRejectedValueOnce(new Error('Statement error'))
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText(/Statement error/)).toBeTruthy(), { timeout: 5000 })
    const retry = screen.getByRole('button', { name: /Retry/i })
    fireEvent.click(retry)

    await waitFor(() => expect(screen.getAllByText('$1,065.00')).toHaveLength(2), { timeout: 5000 })
    expect(driverApiMocks.fetchSettlement).toHaveBeenCalledTimes(2)
  })
})

describe('sending paperwork for a load that is not listed', () => {
  it('offers both documents even with no shipments on the statement', async () => {
    // A driver holding a signed POD for a load nobody has built yet cannot act from a row
    // that does not exist, so the way in lives on the page itself.
    driverApiMocks.fetchSettlement.mockResolvedValue({ ...baseSettlement, trips: [] })
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText('No trips this week')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Send a POD/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Send a rate confirmation/ })).toBeTruthy()
    expect(screen.getByText(/Paperwork for a load that is not listed/)).toBeTruthy()
  })

  it('offers a way through when there is no settlement data at all', async () => {
    driverApiMocks.fetchSettlementWeeks.mockResolvedValue([])
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText('No settlement data yet')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Send a POD anyway/ })).toBeTruthy()
  })
})

/*
 * Which week the app opens on, and getting back to older pay.
 *
 * The weeks endpoint returns history newest-first, but "newest row returned" is
 * not the same as "this week": early in a week, before any trip is processed,
 * the newest row with trips is LAST week. Opening there showed a driver a
 * finished, already-paid check as if it were their current pay.
 */
describe('pay week selection', () => {
  const WEEK_OF_OCT4 = '2026-10-04'
  const INSIDE_WEEK_OCT4 = new Date('2026-10-06T12:00:00Z')

  it('opens on the current week even when the API has no row for it yet', async () => {
    // Trips exist only for earlier weeks — the normal state on a Sunday or Monday.
    vi.setSystemTime(INSIDE_WEEK_OCT4)
    driverApiMocks.fetchSettlement.mockResolvedValue({ ...baseSettlement, weekStart: WEEK_OF_OCT4, trips: [] })

    render(<MemoryRouter><SettlementPage /></MemoryRouter>)

    await waitFor(() => expect(driverApiMocks.fetchSettlement).toHaveBeenCalledWith(WEEK_OF_OCT4), {
      timeout: 5000,
    })
    // Not last week's settled statement, which is what the API listed first.
    expect(driverApiMocks.fetchSettlement).not.toHaveBeenCalledWith('2026-09-27')
  })

  it('offers this week in the picker alongside every historical week', async () => {
    vi.setSystemTime(INSIDE_WEEK_OCT4)
    driverApiMocks.fetchSettlement.mockResolvedValue({ ...baseSettlement, weekStart: WEEK_OF_OCT4, trips: [] })

    render(<MemoryRouter><SettlementPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Pay week')).toBeTruthy(), { timeout: 5000 })

    fireEvent.keyDown(screen.getByLabelText('Pay week'), { key: 'Enter' })

    // The week in progress, plus both weeks that already have pay. Scoped to the
    // open list because the trigger echoes whichever label is selected.
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    const options = within(screen.getByRole('listbox'))
    expect(options.getByText(/10\/4 – 10\/10 · This week/)).toBeTruthy()
    expect(options.getByText(/9\/27 – 10\/3/)).toBeTruthy()
    expect(options.getByText(/9\/20 – 9\/26/)).toBeTruthy()
  })

  it('lets the driver open a historical week and get back to this one', async () => {
    vi.setSystemTime(INSIDE_WEEK_OCT4)
    driverApiMocks.fetchSettlement.mockResolvedValue({ ...baseSettlement, weekStart: WEEK_OF_OCT4, trips: [] })

    render(<MemoryRouter><SettlementPage /></MemoryRouter>)
    await waitFor(() => expect(driverApiMocks.fetchSettlement).toHaveBeenCalledWith(WEEK_OF_OCT4), {
      timeout: 5000,
    })

    // Nothing says "past week" while the current one is showing.
    expect(screen.queryByText('Viewing a past pay week')).toBeNull()

    driverApiMocks.fetchSettlement.mockResolvedValue(baseSettlement) // weekStart 2026-09-27
    fireEvent.keyDown(screen.getByLabelText('Pay week'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText(/9\/27 – 10\/3/)).toBeTruthy())
    fireEvent.click(screen.getByText(/9\/27 – 10\/3/))

    await waitFor(() => expect(driverApiMocks.fetchSettlement).toHaveBeenCalledWith('2026-09-27'), {
      timeout: 5000,
    })
    // An already-paid week must be labelled as one.
    await waitFor(() => expect(screen.getByText('Viewing a past pay week')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'This week' }))
    await waitFor(() => expect(screen.queryByText('Viewing a past pay week')).toBeNull())
  })
})

/**
 * Gross and driver pay on the phone, the way the desktop shows them.
 *
 * An owner operator is paid a percentage, so the number they most want to check is the one
 * it was taken from. The app used to show only the share; now each row carries the freight,
 * the miles and the $/mi beside the pay, and the list ends with the same two totals the
 * desktop footer prints.
 */
describe('freight and rate beside the pay', () => {
  beforeEach(() => { resetMocks() })

  it('shows each load\'s freight, miles and $/mi', async () => {
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)
    await screen.findByText('LOAD-101')
    expect(screen.getAllByText('$647.50').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/185 mi · \$3\.50\/mi/)).toBeInTheDocument()
    expect(screen.getByText(/175 mi · \$3\.50\/mi/)).toBeInTheDocument()
  })

  it('ends the list with the freight total and driver share, like the desktop footer', async () => {
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)
    await screen.findByText('LOAD-101')
    const totals = screen.getByTestId('shipment-totals')
    expect(totals).toHaveTextContent('Freight total / driver share (100%)')
    expect(totals).toHaveTextContent('$1,260.00')
    expect(totals).not.toHaveTextContent(/excludes/)
  })

  it('says what the totals exclude when a load is held for its POD', async () => {
    driverApiMocks.fetchSettlement.mockResolvedValue({
      ...baseSettlement,
      trips: [
        baseSettlement.trips[0],
        { ...baseSettlement.trips[1], onThisCheck: false, heldReason: 'NO_POD', heldLabel: 'POD required',
          factoring: { podPresent: false, rateconPresent: true } },
      ],
      grossPay: 647.5, driverAmount: 647.5, heldFreight: 612.5,
    } as unknown as typeof baseSettlement)
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)
    await screen.findByText('LOAD-101')
    const totals = screen.getByTestId('shipment-totals')
    expect(totals).toHaveTextContent('excludes $612.50 held for POD')
    expect(totals).toHaveTextContent('$647.50')
    // The held row still shows what it would pay, labelled, rather than $0.
    expect(screen.getByText('POD required')).toBeInTheDocument()
  })

  it('shows no totals row when the API did not send them (an older build)', async () => {
    const { driverAmount: _d, payPercent: _p, heldFreight: _h, ...older } = baseSettlement
    driverApiMocks.fetchSettlement.mockResolvedValue(older as typeof baseSettlement)
    render(<MemoryRouter><SettlementPage /></MemoryRouter>)
    await screen.findByText('LOAD-101')
    // Summing the rows here would be a second total that could disagree with the cheque.
    expect(screen.queryByTestId('shipment-totals')).toBeNull()
  })
})
