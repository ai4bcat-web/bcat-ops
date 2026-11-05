// @vitest-environment jsdom
// I5: the monthly buckets are the same off the windowed store as off the whole table.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import { FIXTURE_NOW } from './loadWindowFixture'
import { computeFullAndWindowed } from './loadWindowRun'

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) })) // apiClient builds its client at import
vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  ...(await import('./loadWindowFixture')).fixtureApi,
}))

const { useMonthlyMetrics } = await import('./useMonthlyMetrics')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FIXTURE_NOW)) })
afterAll(() => { vi.useRealTimers() })

describe('useMonthlyMetrics windowing', () => {
  it('buckets the last 6 months + current identically from the window', async () => {
    const r = await computeFullAndWindowed({
      render: () => renderHook(() => useMonthlyMetrics(6)), from: '2026-05-01', to: '2026-11-30',
      pick: (m) => m, settled: (m) => m.currentMonth !== null,
    })
    expect(r.windowedCount).toBeLessThan(r.fullCount)
    expect(r.full.months.some((b) => b.loads > 0)).toBe(true)
    expect(r.windowed).toEqual(r.full)
  })
})
