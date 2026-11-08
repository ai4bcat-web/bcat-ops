// @vitest-environment jsdom
/**
 * `/reports` is quoted at people. These four assertions are about whether it may be.
 *
 * The profit table has to be the lib's grouping of real samples, its totals strip has to
 * be the sum of the rows the office can see, the own-fleet warning has to appear exactly
 * when an own-asset load is in scope, and an empty window has to say it is empty rather
 * than print a column of zeros that reads as a month with no profit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { LaneRateSampleRecord } from '@/types/tms'
import { chicagoDateStr } from '@/lib/date'
import { clearReportCache } from '@/lib/reportsClient'
import { formatMoneyCents } from './reportViews'
import { ReportsPage } from './ReportsPage'

const samplesMock = vi.hoisted(() => vi.fn<(ym: string) => Promise<LaneRateSampleRecord[]>>())

vi.mock('@/lib/apiClient', () => ({
  listLaneSamplesByMonth: samplesMock,
  listQuotesByMonth: vi.fn().mockResolvedValue([]),
  listCommissionsByMonth: vi.fn().mockResolvedValue([]),
  listInvoicesByMonth: vi.fn().mockResolvedValue([]),
  getTmsSettings: vi.fn().mockResolvedValue(null),
  graphqlErrorText: (e: unknown) => String(e),
}))
// The other panels' hooks are their own pages' tests; mounted here they would drag six
// more Lambdas into a test about the profit table.
vi.mock('@/hooks/useStaff', () => ({
  useStaff: () => ({ staff: [], byId: {}, nameOf: () => '—', loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/hooks/useShipments', () => ({ useShipments: () => ({ shipments: [], loading: false, error: null, refresh: vi.fn() }) }))
// The aging shapes come from the real lib rather than a hand-built literal, so an empty
// book here is exactly what an empty book is on `/ar` and `/ap`. A mock factory is
// hoisted above the imports, so it has to reach the lib through `await import`.
vi.mock('@/hooks/useOpenInvoices', async () => {
  const { ageInvoices } = await import('@/lib/arAging')
  const aging = ageInvoices([], '2026-01-01')
  return { useOpenInvoices: () => ({ invoices: [], aging, loading: false, error: null, refresh: vi.fn() }) }
})
vi.mock('@/hooks/useOpenBills', async () => {
  const { ageOpenItems } = await import('@/lib/arAging')
  const aging = ageOpenItems([], '2026-01-01')
  return {
    useOpenBills: () => ({ bills: [], aging, approvedCents: 0, loading: false, error: null, refresh: vi.fn() }),
  }
})
vi.mock('@/hooks/useArWorklist', () => ({ useArWorklist: () => ({ rows: [], loading: false, error: null, refresh: vi.fn() }) }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [], locations: [], loading: false, error: null }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

/** The month the page opens on, so every seeded sample lands inside the default window. */
const MONTH = chicagoDateStr(new Date()).slice(0, 7)

function sample(patch: Partial<LaneRateSampleRecord> = {}): LaneRateSampleRecord {
  return {
    id: 'lrs:1',
    laneKey: 'CHICAGO|IL>DANVILLE|IL',
    date: `${MONTH}-01`,
    loadId: 'l1',
    shipmentId: 's1',
    sampleMonth: MONTH,
    customerId: 'k1',
    customerName: 'Acme Foods',
    carrierId: 'c1',
    carrierName: 'Zed Trucking',
    miles: 100,
    revenueCents: 250_000,
    costCents: 200_000,
    source: 'LOAD',
    sampledAt: `${MONTH}-01T12:00:00.000Z`,
    version: 1,
    ...patch,
  }
}

function seed(rows: LaneRateSampleRecord[]) {
  samplesMock.mockImplementation((ym: string) => Promise.resolve(ym === MONTH ? rows : []))
}

const renderPage = () => render(<MemoryRouter><ReportsPage /></MemoryRouter>)

beforeEach(() => {
  clearReportCache()
  samplesMock.mockReset()
})

describe('ReportsPage profit panel', () => {
  it('groups the window samples and totals exactly what it shows', async () => {
    seed([
      sample({ id: 'lrs:1', customerId: 'k1', customerName: 'Acme Foods', revenueCents: 250_000, costCents: 200_000 }),
      sample({ id: 'lrs:2', customerId: 'k1', customerName: 'Acme Foods', revenueCents: 150_000, costCents: 100_000 }),
      sample({ id: 'lrs:3', customerId: 'k2', customerName: 'Borden Mills', revenueCents: 300_000, costCents: 290_000 }),
    ])

    renderPage()

    const table = await screen.findByRole('table', { name: 'Profit by group' })
    const acme = within(table).getByText('Acme Foods').closest('tr')
    const borden = within(table).getByText('Borden Mills').closest('tr')
    expect(acme).not.toBeNull()
    expect(borden).not.toBeNull()

    // Two loads folded into one customer row: $4,000 revenue, $3,000 cost, $1,000 profit.
    expect(within(acme as HTMLElement).getByText(formatMoneyCents(400_000))).toBeTruthy()
    expect(within(acme as HTMLElement).getByText(formatMoneyCents(100_000))).toBeTruthy()
    expect(within(borden as HTMLElement).getByText(formatMoneyCents(10_000))).toBeTruthy()

    // The strip is the sum of those rows, not a second arithmetic over the samples.
    const strip = screen.getByLabelText('Profit totals')
    expect(within(strip).getByText(formatMoneyCents(700_000))).toBeTruthy()
    expect(within(strip).getByText(formatMoneyCents(590_000))).toBeTruthy()
    expect(within(strip).getByText(formatMoneyCents(110_000))).toBeTruthy()
    expect(within(strip).getByText('3')).toBeTruthy()
  })

  it('says nothing about own fleet when every load was brokered', async () => {
    seed([sample()])

    renderPage()

    await screen.findByRole('table', { name: 'Profit by group' })
    expect(screen.queryByText(/own trucks/)).toBeNull()
  })

  it('warns that own-fleet margin is not comparable when an own-asset load is in scope', async () => {
    seed([sample(), sample({ id: 'lrs:2', assignmentKind: 'OWN_ASSET', carrierId: null, carrierName: null })])

    renderPage()

    await screen.findByRole('table', { name: 'Profit by group' })
    expect(screen.getByText(/own trucks/)).toBeTruthy()
    expect(screen.getByText(/Own-fleet profitability lives on Finances/)).toBeTruthy()
  })

  it('reports an empty window as empty instead of printing zeros', async () => {
    seed([])

    renderPage()

    expect(await screen.findByText('No delivered loads in this window.')).toBeTruthy()
    expect(screen.queryByLabelText('Profit totals')).toBeNull()
    expect(screen.queryByRole('table', { name: 'Profit by group' })).toBeNull()
  })
})

describe('ReportsPage panels', () => {
  it('says what is missing on every panel rather than printing zeros', async () => {
    seed([])

    renderPage()
    await screen.findByText('No delivered loads in this window.')

    const expected: [string, string][] = [
      ['Pipeline', 'No shipments on the board.'],
      ['AR', 'Nothing is owed to us.'],
      ['AP', 'We owe nothing.'],
      ['Quotes', 'No customer quotes in this window.'],
      ['Commissions', 'No commissions were triggered in this window.'],
    ]

    for (const [tab, sentence] of expected) {
      fireEvent.click(screen.getByRole('tab', { name: tab }))
      expect(await screen.findByText(sentence)).toBeTruthy()
    }

    // The AR panel is three answers, not one: nothing owed, nothing waiting to be
    // billed, nobody carrying exposure.
    fireEvent.click(screen.getByRole('tab', { name: 'AR' }))
    expect(await screen.findByText('No delivered load is waiting to be billed.')).toBeTruthy()
    expect(screen.getByText('No customer is carrying exposure.')).toBeTruthy()
  })
})
