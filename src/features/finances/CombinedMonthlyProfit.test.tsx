import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as AmazonProfitability from '@/hooks/useAmazonProfitability'
import type * as OwnerOpProfitability from '@/hooks/useOwnerOperatorProfitability'

// The hooks are stubbed, but their modules load for real so the aggregate functions
// and the AMAZON_CONTRIBUTES_TO_COMPANY_TOTALS switch under test stay real.
vi.mock('@/lib/apiClient', () => ({
  listLoads: () => Promise.resolve([]),
  listAmazonTrips: () => Promise.resolve([]),
  listDriverPaySettings: () => Promise.resolve([]),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
}))

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))

vi.mock('@/hooks/useFleetMonthlyNet', () => ({
  useFleetMonthlyNet: () => ({ revenue: 10_000, net: 1_000, loading: false }),
}))

vi.mock('@/hooks/useAmazonProfitability', async (importOriginal) => {
  const actual = await importOriginal<typeof AmazonProfitability>()
  return {
    ...actual,
    useAmazonProfitability: () => ({
      loading: false,
      error: null,
      weeks: ['2026-09-06'],
      refresh: () => {},
      rows: [{ periodStart: '2026-09-06', driverId: 'a1', driverName: 'Amazon Driver', gross: 20_000, driverPay: 10_000, expenses: 1_000, profit: 9_000 }],
    }),
  }
})

vi.mock('@/hooks/useOwnerOperatorProfitability', async (importOriginal) => {
  const actual = await importOriginal<typeof OwnerOpProfitability>()
  return {
    ...actual,
    useOwnerOperatorProfitability: () => ({
      loading: false,
      error: null,
      weeks: ['2026-09-06'],
      refresh: () => {},
      rows: [{ periodStart: '2026-09-06', driverId: 'o1', driverName: 'Owner Op', gross: 4_000, driverPay: 3_420, expenses: 100, profit: 480 }],
    }),
  }
})

import { CombinedMonthlyProfit } from './CombinedMonthlyProfit'

beforeEach(() => {
  // Mid-September 2026 so monthRange(0) fully contains the 9/6–9/12 pay week.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
})
afterEach(() => { vi.useRealTimers() })

describe('CombinedMonthlyProfit', () => {
  it('counts the local fleet and owner operators, but not Amazon', () => {
    const html = renderToStaticMarkup(<CombinedMonthlyProfit />)

    // $1,000 Ivan net + $480 owner-operator profit. Amazon's $9,000 stays out.
    expect(html).toContain('$1,480')
    expect(html).not.toContain('$10,480')
  })

  it('still shows the Amazon figure, labelled as not counted', () => {
    const html = renderToStaticMarkup(<CombinedMonthlyProfit />)

    expect(html).toContain('$9,000')
    expect(html).toContain('not counted')
  })

  it('breaks the combined total out by contributing source', () => {
    const html = renderToStaticMarkup(<CombinedMonthlyProfit />)

    expect(html).toContain('Owner operators (profit)')
    expect(html).toContain('$480')
    expect(html).toContain('$1,000')
  })
})
