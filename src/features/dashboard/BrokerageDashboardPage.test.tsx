// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { BrokerageSection } from './BrokerageDashboardPage'
import type { MonthPayload, RollupRow, RollupWindow } from '@/lib/dashboardRollup'

const NOW = new Date('2026-11-09T15:00:00Z')

const fetchRollup = vi.hoisted(() => vi.fn())
const fetchRep = vi.hoisted(() => vi.fn())
vi.mock('@/lib/brokerageRepRollupClient', () => ({ fetchBrokerageRepRollup: fetchRep }))
vi.mock('@/lib/dashboardRollupClient', async (orig) => ({ ...(await orig() as object), fetchRollup }))
vi.mock('@/lib/apiClient', () => ({
  listOwnershipDivisions: async () => [],
  listUserProfiles: async () => [
    { id: 'ryne@bcatcorp.com', email: 'ryne@bcatcorp.com', name: 'Ryne B' },
    { id: 'grp-ivan', email: 'ivan@x.test', name: 'Ivan Cartage' },
  ],
}))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/features/tms/kit/TmsScrollPage', () => ({ TmsScrollPage: ({ title, children }: { title: string; children: ReactNode }) => <main><h1>{title}</h1>{children}</main> }))
// jsdom has no layout: the chart needs a sized container, which a test cannot give it.
vi.mock('recharts', async (orig) => ({ ...(await orig() as object), ResponsiveContainer: ({ children }: { children: ReactNode }) => <div data-testid="chart">{children}</div> }))


const fin = (n: number, rev: number, cost: number) => ({ n, rev, cost, prof: rev - cost })
function row(month: string, over: Partial<MonthPayload> = {}): RollupRow<MonthPayload> {
  return {
    id: `M:${month}`, schemaVersion: 1, computedAt: '2026-11-09T14:50:00Z',
    payload: {
      v: 1, month, ship: {}, ...over,
      fin: over.fin ?? { [`${month}-10`]: { 'BROKERAGE|': fin(2, 300_000, 240_000), 'ASSETS|': fin(9, 9_000_000, 1) } },
    },
  }
}
const window = (months: RollupRow<MonthPayload>[]): RollupWindow => ({ months, live: null })

describe('Brokerage cards under the Dashboard', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); fetchRollup.mockReset(); fetchRep.mockReset() })
  afterEach(() => { vi.useRealTimers() })

  const repMonth = (month: string) => ({
    month, computedAt: '2026-11-09T14:50:00Z',
    rep: { 'BROKERAGE|': { 'i:ryne@bcatcorp.com': fin(1, 100_000, 60_000), 'i:grp-ivan': fin(1, 200_000, 180_000) }, 'ASSETS|': { 'i:ryne@bcatcorp.com': fin(9, 9_000_000, 1) } },
  })

  it('draws the month table with a totals row and the rep table that ties to it', async () => {
    fetchRollup.mockResolvedValue(window(['2026-10', '2026-11'].map((m) => row(m))))
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: ['2026-10', '2026-11'].map(repMonth) })
    render(<BrokerageSection />)

    const monthTable = await screen.findByTestId('brokerage-month-table')
    expect(within(screen.getByTestId('brokerage-month-total')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Total', '4', '$6,000', '$4,800', '$1,200', '20.0%'])
    // The month table starts at October 2026 (the new system's data start): October and November, no older months.
    expect(within(monthTable).getAllByRole('row').length).toBeLessThan(8)
    expect(screen.getByTestId('brokerage-data-start')).toHaveTextContent('Data starts October 2026')

    // Rep view: reps down the side, October and November across (the data start), Brokerage only. Profit is the default figure.
    await waitFor(() => expect(screen.getByTestId('brokerage-rep-widget')).toBeInTheDocument())
    const reps = screen.getAllByTestId('brokerage-rep-row').map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))
    // Each month: profit 400 / 200; the Total column carries the margin under the figure.
    expect(reps[0]).toEqual(['Ryne B', '$400', '$400', '$80040.0%'])
    expect(reps[1]).toEqual(['Ivan Cartage', '$200', '$200', '$40010.0%'])
    expect(within(screen.getByTestId('brokerage-rep-total')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Total', '$600', '$600', '$1,20020.0%'])
    expect(screen.queryByTestId('brokerage-rep-none')).not.toBeInTheDocument()
    expect(screen.getByTestId('brokerage-tie')).toHaveAttribute('data-ok', 'true')
    expect(screen.getByTestId('brokerage-help')).toHaveTextContent('Profit % = profit ÷ revenue')
  })

  it('shows all four figures per rep, switches the figure and the division, and keeps the columns tied to the month view', async () => {
    fetchRollup.mockResolvedValue(window(['2026-10', '2026-11'].map((m) => row(m))))
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: ['2026-10', '2026-11'].map(repMonth) })
    render(<BrokerageSection />)
    await screen.findByTestId('brokerage-rep-table')

    fireEvent.click(within(screen.getByRole('group', { name: 'Figure' })).getByRole('button', { name: 'All four' }))
    const ryne = screen.getAllByTestId('brokerage-rep-row')[0]
    expect(ryne).toBeInTheDocument()
    const table = screen.getByTestId('brokerage-rep-table')
    for (const label of ['Loads', 'Gross revenue', 'Expenses', 'Profit']) expect(within(table).getAllByText(label).length).toBeGreaterThan(0)

    fireEvent.click(within(screen.getByRole('group', { name: 'Figure' })).getByRole('button', { name: 'Loads' }))
    expect(within(screen.getAllByTestId('brokerage-rep-row')[0]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Ryne B', '1', '1', '2'])

    // Assets holds Ryne's nine loads a month; the tie-out line belongs to Brokerage only.
    fireEvent.click(within(screen.getByRole('group', { name: 'Division' })).getByRole('button', { name: 'Assets' }))
    expect(within(screen.getAllByTestId('brokerage-rep-row')[0]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Ryne B', '9', '9', '18'])
    expect(screen.queryByTestId('brokerage-tie')).not.toBeInTheDocument()
  })

  it('shows the change from the month before for finished months and none for the month in progress', async () => {
    vi.setSystemTime(new Date('2026-12-09T15:00:00Z'))
    const f = (rev: number, cost: number) => fin(1, rev, cost)
    const months = ['2026-10', '2026-11', '2026-12']
    fetchRollup.mockResolvedValue(window(months.map((m) => row(m))))
    fetchRep.mockResolvedValue({
      scope: 'ALL', repKey: null,
      months: months.map((month, i) => ({ month, computedAt: '2026-12-09T14:50:00Z', rep: { 'BROKERAGE|': { 'i:ryne@bcatcorp.com': f([100_000, 150_000, 300_000][i], 50_000) } } })),
    })
    render(<BrokerageSection />)
    await screen.findByTestId('brokerage-rep-table')
    fireEvent.click(within(screen.getByRole('group', { name: 'Figure' })).getByRole('button', { name: 'Revenue' }))
    const cells = within(screen.getAllByTestId('brokerage-rep-row')[0]).getAllByRole('cell')
    // October has nothing before it, November is +50% on October, December is still in progress.
    expect(within(cells[1]).queryByTestId('rep-month-delta')).not.toBeInTheDocument()
    expect(within(cells[2]).getByTestId('rep-month-delta')).toHaveTextContent('+50%')
    expect(within(cells[3]).queryByTestId('rep-month-delta')).not.toBeInTheDocument()
    expect(screen.getByText(/Dec 26 · to date/)).toBeInTheDocument()
  })

  it('shows a rep caller only their own figures and never reads the company rollup rows', async () => {
    fetchRep.mockResolvedValue({
      scope: 'OWN', repKey: 'i:ryne@bcatcorp.com',
      months: ['2026-10', '2026-11'].map((month) => ({ month, computedAt: '2026-11-09T14:50:00Z', rep: { 'BROKERAGE|': { 'i:ryne@bcatcorp.com': fin(1, 100_000, 60_000) } } })),
    })
    render(<BrokerageSection />)
    expect(await screen.findByTestId('brokerage-month-table')).toBeInTheDocument()
    expect(fetchRollup).not.toHaveBeenCalled()
    expect(within(screen.getByTestId('brokerage-month-total')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Total', '2', '$2,000', '$1,200', '$800', '40.0%'])
    await waitFor(() => expect(screen.getAllByTestId('brokerage-rep-row')).toHaveLength(1))
    expect(screen.queryByText('Ivan Cartage')).not.toBeInTheDocument()
  })

  it('shows a dash for profit % where a month has no revenue', async () => {
    fetchRollup.mockResolvedValue(window([row('2026-10', { fin: {} })]))
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: [{ month: '2026-10', computedAt: '2026-11-09T14:50:00Z', rep: {} }] })
    render(<BrokerageSection />)
    const total = await screen.findByTestId('brokerage-month-total')
    expect(within(total).getAllByRole('cell')[5]).toHaveTextContent('—')
    expect(screen.getByTestId('brokerage-total-profit-pct')).toHaveTextContent('—')
  })

  it('says the rep split is not ready when a month has no per-rep object yet, and keeps the month view', async () => {
    fetchRollup.mockResolvedValue(window([row('2026-10')]))
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: [] })
    render(<BrokerageSection />)
    expect(await screen.findByTestId('brokerage-month-table')).toBeInTheDocument()
    expect(screen.getByTestId('brokerage-rep-widget')).toHaveTextContent('sales-rep split is not ready')
  })

  it('draws no figures when the rollup is not trustworthy (empty source, stale or missing rows)', async () => {
    fetchRollup.mockResolvedValue(null)
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: [] })
    render(<BrokerageSection />)
    expect(await screen.findByTestId('brokerage-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('brokerage-month-table')).not.toBeInTheDocument()
  })
})
