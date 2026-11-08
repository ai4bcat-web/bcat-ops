// @vitest-environment jsdom
// I5: loaded-vs-empty miles for a range read the same off the windowed store as off the
// whole table, including a load picked up the month before the range.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import { FIXTURE_NOW } from './loadWindowFixture'
import { computeFullAndWindowed } from './loadWindowRun'

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))
vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  ...(await import('./loadWindowFixture')).fixtureApi,
  listTimeClockEntries: () => Promise.resolve([]),
}))
vi.mock('./useTruckOdometer', () => ({ fetchOdometerDays: () => Promise.resolve([]) }))
vi.mock('./useDrivers', async () => {
  const { FIXTURE_DRIVERS } = await import('./loadWindowFixture')
  return { useDrivers: () => ({ drivers: FIXTURE_DRIVERS }) }
})

const { useDeadhead } = await import('./useDeadhead')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FIXTURE_NOW)) })
afterAll(() => { vi.useRealTimers() })

describe('useDeadhead windowing', () => {
  it.each([
    ['2026-10-19', '2026-11-04'],
    ['2026-10-25', '2026-11-03'],
  ])('%s → %s: same days and totals from the window', async (from, to) => {
    const r = await computeFullAndWindowed({
      render: () => renderHook(() => useDeadhead(from, to)), from, to,
      pick: (d) => ({ days: d.days, all: d.all, byDriver: d.byDriver, byCustomer: d.byCustomer, byMonth: d.byMonth }),
      settled: (d) => !d.loading && d.days.length > 0,
    })
    expect(r.full.days.length).toBeGreaterThan(1)
    expect(r.windowedCount).toBeLessThan(r.fullCount)
    expect(r.windowed).toEqual(r.full)
  })
})
