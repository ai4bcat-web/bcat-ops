// @vitest-environment jsdom
// I5: a fleet P&L range reads the same off the windowed store as off the whole table.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import { FIXTURE_NOW } from './loadWindowFixture'
import { computeFullAndWindowed } from './loadWindowRun'

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) })) // apiClient builds its client at import

vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  ...(await import('./loadWindowFixture')).fixtureApi,
  listDriverPaySettings: () => Promise.resolve([]),
}))
const mocked = async () => (await import('./fleetWindowMocks')).fleetWindowMocks
vi.mock('./useDrivers', async () => { const m = await mocked(); return { useDrivers: () => m.drivers } })
vi.mock('./useTrucks', async () => { const m = await mocked(); return { useTrucks: () => m.trucks } })
vi.mock('./useFuelTransactions', async () => { const m = await mocked(); return { useFuelTransactions: () => m.fuel } })
vi.mock('./useExpenseData', async () => { const m = await mocked(); return { useExpenseData: () => m.exp } })
vi.mock('./useTruckMileage', async () => { const m = await mocked(); return { useTruckMileage: () => m.mileage } })
vi.mock('./useDriverPay', async () => { const m = await mocked(); return { useDriverPay: () => m.pay } })
vi.mock('./useCurrentInsurance', async () => { const m = await mocked(); return { useCurrentInsurance: () => m.insurance } })
vi.mock('./useFleetFixedCosts', async () => { const m = await mocked(); return { useFleetFixedCosts: () => m.fixedCosts } })

const { useFleetProfitability } = await import('./useFleetProfitability')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FIXTURE_NOW)) })
afterAll(() => { vi.useRealTimers() })

// October (loads picked up the month before, delivered in it) and a week across the
// UTC month edge.
describe('useFleetProfitability windowing', () => {
  it.each([
    ['2026-10-01', '2026-10-31'],
    ['2026-10-28', '2026-11-03'],
  ])('%s → %s: same roll-up from the window', async (start, end) => {
    const range = { start, end }
    const r = await computeFullAndWindowed({
      render: () => renderHook(() => useFleetProfitability(range, 'LOCAL')), from: start, to: end,
      pick: (s) => ({ data: s.data, members: s.members }), settled: (s) => !s.loading,
    })
    expect(r.full.data?.rollup.revenue).toBeGreaterThan(0)
    expect(r.windowedCount).toBeLessThan(r.fullCount)
    expect(r.windowed).toEqual(r.full)
  })
})
