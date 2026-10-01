// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
      amount: 612.5,
    },
  ],
  grossPay: 1260,
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
}

beforeEach(() => {
  vi.clearAllMocks()
  resetMocks()
})

describe('SettlementPage', () => {
  it('defaults to the most recent week and shows the check amount from the API', async () => {
    render(<SettlementPage />)
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
    render(<SettlementPage />)
    await waitFor(() => expect(screen.getByText('No trips this week')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByText('LOAD-101')).toBeNull()
    expect(screen.getAllByText('$0.00')).toHaveLength(3)
  })

  it('renders deductions using the same sign convention as the staff page', async () => {
    render(<SettlementPage />)
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
    render(<SettlementPage />)

    await waitFor(() => expect(screen.getByText('Factoring fee (2%)')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText('Blocked')).toBeTruthy()
    expect(screen.getByText('14452')).toBeTruthy()
    expect(screen.getByText('missing')).toBeTruthy() // POD not on file
    expect(screen.getByText('on file')).toBeTruthy() // rate con present
  })

  it('renders a retryable error when the weeks call fails', async () => {
    driverApiMocks.fetchSettlementWeeks.mockRejectedValueOnce(new Error('Network down'))
    render(<SettlementPage />)

    await waitFor(() => expect(screen.getByText(/Network down/)).toBeTruthy(), { timeout: 5000 })
    const retry = screen.getByRole('button', { name: /Retry/i })
    expect(retry).toBeTruthy()

    fireEvent.click(retry)
    await waitFor(() => expect(screen.getAllByText('$1,065.00')).toHaveLength(2), { timeout: 5000 })
    expect(driverApiMocks.fetchSettlementWeeks).toHaveBeenCalledTimes(2)
  })

  it('renders a retryable error when the statement call fails', async () => {
    driverApiMocks.fetchSettlement.mockRejectedValueOnce(new Error('Statement error'))
    render(<SettlementPage />)

    await waitFor(() => expect(screen.getByText(/Statement error/)).toBeTruthy(), { timeout: 5000 })
    const retry = screen.getByRole('button', { name: /Retry/i })
    fireEvent.click(retry)

    await waitFor(() => expect(screen.getAllByText('$1,065.00')).toHaveLength(2), { timeout: 5000 })
    expect(driverApiMocks.fetchSettlement).toHaveBeenCalledTimes(2)
  })
})
