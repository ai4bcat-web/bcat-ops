import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as AmazonProfitability from '@/hooks/useAmazonProfitability'
import type * as OwnerOpProfitability from '@/hooks/useOwnerOperatorProfitability'

/**
 * Now that Amazon counts, a partial total is a wrong number rather than a slow one.
 *
 * The loading guard was `ivan.loading && amzLoading && ownerOpLoading`, so the card stopped
 * saying "Loading" the moment the FIRST source arrived and showed a total missing the
 * others — then silently jumped. With Amazon excluded that only ever understated by the
 * owner-operator figure; including it makes the gap the largest number on the card.
 */
vi.mock('@/lib/apiClient', () => ({
  listLoads: () => Promise.resolve([]),
  listAmazonTrips: () => Promise.resolve([]),
  listDriverPaySettings: () => Promise.resolve([]),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
}))

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))

// Ivan has arrived; Amazon has not.
vi.mock('@/hooks/useFleetMonthlyNet', () => ({
  useFleetMonthlyNet: () => ({ revenue: 10_000, net: 1_000, loading: false }),
}))

vi.mock('@/hooks/useAmazonProfitability', async (importOriginal) => {
  const actual = await importOriginal<typeof AmazonProfitability>()
  return {
    ...actual,
    useAmazonProfitability: () => ({ loading: true, error: null, weeks: [], refresh: () => {}, rows: [] }),
  }
})

vi.mock('@/hooks/useOwnerOperatorProfitability', async (importOriginal) => {
  const actual = await importOriginal<typeof OwnerOpProfitability>()
  return {
    ...actual,
    useOwnerOperatorProfitability: () => ({ loading: false, error: null, weeks: [], refresh: () => {}, rows: [] }),
  }
})

import { CombinedMonthlyProfit } from './CombinedMonthlyProfit'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
})
afterEach(() => { vi.useRealTimers() })

describe('CombinedMonthlyProfit while a source is still loading', () => {
  it('says it is loading rather than showing a total missing Amazon', () => {
    const html = renderToStaticMarkup(<CombinedMonthlyProfit />)

    expect(html).toContain('Loading')
    // $1,000 is Ivan alone, and presenting it as the company total would be wrong.
    expect(html).not.toContain('$1,000')
  })
})
