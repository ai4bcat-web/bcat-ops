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

  it('draws the headline figures, the takeaways and a bar per rep, with the full table one click away', async () => {
    fetchRollup.mockResolvedValue(window(['2026-10', '2026-11'].map((m) => row(m))))
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: ['2026-10', '2026-11'].map(repMonth) })
    render(<BrokerageSection />)

    // Two months of 2 loads each: revenue $3,000 a month, expense $2,400, so $1,200 profit overall (20%).
    await waitFor(() => expect(screen.getByTestId('brokerage-total-revenue')).toHaveTextContent('$6,000'))
    expect(screen.getByTestId('brokerage-total-profit')).toHaveTextContent('$1,200')
    expect(screen.getByTestId('brokerage-total-profit-pct')).toHaveTextContent('20.0%')
    expect(screen.getByTestId('brokerage-total-loads')).toHaveTextContent('4')
    expect(screen.getByTestId('brokerage-data-start')).toHaveTextContent('Data starts October 2026')
    expect(screen.getByTestId('brokerage-month-chart')).toBeInTheDocument()
    expect(screen.getByTestId('brokerage-insights')).toHaveTextContent('Nov so far')

    // One bar per Brokerage rep, biggest profit first; Assets loads are not in it.
    await waitFor(() => expect(screen.getAllByTestId('brokerage-rep-bar')).toHaveLength(2))
    const rows = screen.getAllByTestId('brokerage-rep-bar')
    expect(rows[0]).toHaveTextContent('Ryne B')
    expect(rows[0]).toHaveTextContent('$800')
    expect(rows[1]).toHaveTextContent('Ivan Cartage')

    // Clicking a rep opens their month-by-month numbers.
    fireEvent.click(within(rows[0]).getByRole('button'))
    const detail = within(rows[0]).getByTestId('brokerage-rep-detail')
    expect(detail).toHaveTextContent('Oct 26')
    expect(detail).toHaveTextContent('Nov 26 · to date')

    // The old rep-by-month table is behind the summary and still ties to the month figures.
    expect(screen.getByTestId('brokerage-table-details')).toBeInTheDocument()
    expect(screen.getByTestId('brokerage-tie')).toHaveAttribute('data-ok', 'true')
    expect(screen.getByTestId('brokerage-help')).toHaveTextContent('Profit margin = profit ÷ revenue')
  })

  it('switches the figure and the division on the rep chart', async () => {
    fetchRollup.mockResolvedValue(window(['2026-10', '2026-11'].map((m) => row(m))))
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: ['2026-10', '2026-11'].map(repMonth) })
    render(<BrokerageSection />)
    await waitFor(() => expect(screen.getAllByTestId('brokerage-rep-bar')).toHaveLength(2))
    const chart = screen.getByTestId('brokerage-rep-chart')

    fireEvent.click(within(within(chart).getByRole('group', { name: 'Figure' })).getByRole('button', { name: 'Loads' }))
    expect(screen.getAllByTestId('brokerage-rep-bar')[0]).toHaveTextContent('2')

    // Assets holds Ryne's nine loads a month, 18 in all.
    fireEvent.click(within(within(chart).getByRole('group', { name: 'Division' })).getByRole('button', { name: 'Assets' }))
    expect(screen.getAllByTestId('brokerage-rep-bar')).toHaveLength(1)
    expect(screen.getAllByTestId('brokerage-rep-bar')[0]).toHaveTextContent('18')
  })

  it('shows a rep caller only their own figures and never reads the company rollup rows', async () => {
    fetchRep.mockResolvedValue({
      scope: 'OWN', repKey: 'i:ryne@bcatcorp.com',
      months: ['2026-10', '2026-11'].map((month) => ({ month, computedAt: '2026-11-09T14:50:00Z', rep: { 'BROKERAGE|': { 'i:ryne@bcatcorp.com': fin(1, 100_000, 60_000) } } })),
    })
    render(<BrokerageSection />)
    await waitFor(() => expect(screen.getByTestId('brokerage-total-revenue')).toHaveTextContent('$2,000'))
    expect(fetchRollup).not.toHaveBeenCalled()
    expect(screen.getByTestId('brokerage-total-profit')).toHaveTextContent('$800')
    expect(screen.getByTestId('brokerage-total-profit-pct')).toHaveTextContent('40.0%')
    await waitFor(() => expect(screen.getAllByTestId('brokerage-rep-bar')).toHaveLength(1))
    expect(screen.queryByText('Ivan Cartage')).not.toBeInTheDocument()
  })

  it('shows a dash for profit % where a month has no revenue', async () => {
    fetchRollup.mockResolvedValue(window([row('2026-10', { fin: {} })]))
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: [{ month: '2026-10', computedAt: '2026-11-09T14:50:00Z', rep: {} }] })
    render(<BrokerageSection />)
    await waitFor(() => expect(screen.getByTestId('brokerage-total-profit-pct')).toHaveTextContent('—'))
  })

  it('says the rep split is not ready when a month has no per-rep object yet, and keeps the month view', async () => {
    fetchRollup.mockResolvedValue(window([row('2026-10')]))
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: [] })
    render(<BrokerageSection />)
    expect(await screen.findByTestId('brokerage-month-chart')).toBeInTheDocument()
    expect(screen.getByTestId('brokerage-rep-chart')).toHaveTextContent('sales-rep split is not ready')
  })

  it('draws no figures when the rollup is not trustworthy (empty source, stale or missing rows)', async () => {
    fetchRollup.mockResolvedValue(null)
    fetchRep.mockResolvedValue({ scope: 'ALL', repKey: null, months: [] })
    render(<BrokerageSection />)
    expect(await screen.findByTestId('brokerage-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('brokerage-month-chart')).not.toBeInTheDocument()
  })
})
