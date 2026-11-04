// @vitest-environment jsdom
// I5: owner-operator profitability (every pay week since the first period) is the same
// off the windowed store as off the whole table.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import { FIXTURE_NOW } from './loadWindowFixture'
import { computeFullAndWindowed } from './loadWindowRun'

const setting = {
  id: 's-oo', driverId: 'd-oo', payGroup: 'OWNER_OPERATOR', payPercent: 0.8,
  expensesBeforePercent: true, active: true, fixedExpenses: [],
  updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
}

vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  ...(await import('./loadWindowFixture')).fixtureApi,
  listDriverPaySettings: () => Promise.resolve([setting]),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
}))
vi.mock('./useDrivers', async () => {
  const { FIXTURE_DRIVERS } = await import('./loadWindowFixture')
  return { useDrivers: () => ({ drivers: FIXTURE_DRIVERS }) }
})
vi.mock('./useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

const { useOwnerOperatorProfitability } = await import('./useOwnerOperatorProfitability')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FIXTURE_NOW)) })
afterAll(() => { vi.useRealTimers() })

describe('useOwnerOperatorProfitability windowing', () => {
  it('reports the same weeks and rows from the window', async () => {
    const r = await computeFullAndWindowed({
      render: () => renderHook(() => useOwnerOperatorProfitability()), from: '2026-09-27', to: '2026-11-04',
      pick: (s) => ({ weeks: s.weeks, rows: s.rows }), settled: (s) => !s.loading && s.rows.length > 0,
    })
    expect(r.full.weeks.length).toBeGreaterThan(1)
    expect(r.windowedCount).toBeLessThan(r.fullCount)
    expect(r.windowed).toEqual(r.full)
  })
})
