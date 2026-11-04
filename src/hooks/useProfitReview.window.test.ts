// @vitest-environment jsdom
// I5: the Profit Review months read the same off the windowed store as off the whole table.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import { FIXTURE_NOW } from './loadWindowFixture'
import { computeFullAndWindowed } from './loadWindowRun'

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

const { useProfitReview } = await import('./useProfitReview')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FIXTURE_NOW)) })
afterAll(() => { vi.useRealTimers() })

// A fixed instant: the hook keys its memo on it.
const TODAY = new Date(2026, 10, 4, 12)

describe('useProfitReview windowing', () => {
  it('assembles the last 3 months identically from the window', async () => {
    const r = await computeFullAndWindowed({
      render: () => renderHook(() => useProfitReview(3, TODAY)), from: '2026-09-01', to: '2026-11-30',
      pick: (s) => ({ months: s.months, unattributedFuel: s.unattributedFuel }), settled: (s) => !s.loading && s.months.length === 3,
    })
    expect(r.full.months.some((m) => m.revenue > 0)).toBe(true)
    expect(r.windowedCount).toBeLessThan(r.fullCount)
    expect(r.windowed).toEqual(r.full)
  })
})
