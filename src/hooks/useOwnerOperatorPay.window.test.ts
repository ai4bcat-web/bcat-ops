// @vitest-environment jsdom
// I5: an owner-operator pay week (and the prior week its duplicate check reads) is the
// same off the windowed store as off the whole table.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import { FIXTURE_NOW } from './loadWindowFixture'
import { computeFullAndWindowed } from './loadWindowRun'

// The real apiClient builds its Amplify client on import; stub the client so nothing needs Amplify.configure().
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))

const setting = {
  id: 's-oo', driverId: 'd-oo', payGroup: 'OWNER_OPERATOR', payPercent: 0.8,
  expensesBeforePercent: true, active: true, fixedExpenses: [],
  updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
}

vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  ...(await import('./loadWindowFixture')).fixtureApi,
  listCustomers: () => Promise.resolve([]),
  listLocations: () => Promise.resolve([]),
  listFactoringItems: () => Promise.resolve([]),
  listDriverPaySettings: () => Promise.resolve([setting]),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
}))
vi.mock('@/lib/podsClient', () => ({ listPods: () => Promise.resolve({ items: [], nextToken: null }) }))
vi.mock('@/lib/driverSubmissionsClient', () => ({ listDriverSubmissions: () => Promise.resolve([]) }))
vi.mock('./useDrivers', async () => {
  const { FIXTURE_DRIVERS } = await import('./loadWindowFixture')
  return { useDrivers: () => ({ drivers: FIXTURE_DRIVERS, updateDriver: vi.fn() }) }
})
vi.mock('./useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

const { useOwnerOperatorPay } = await import('./useOwnerOperatorPay')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FIXTURE_NOW)) })
afterAll(() => { vi.useRealTimers() })

// Sun→Sat weeks: one whose prior week holds a load picked up the month before, one
// holding the UTC month-edge delivery.
describe('useOwnerOperatorPay windowing', () => {
  it.each([
    ['2026-10-04', '2026-09-27', '2026-10-10'],
    ['2026-11-01', '2026-10-25', '2026-11-07'],
  ])('week %s: same trips and statement from the window', async (week, from, to) => {
    const r = await computeFullAndWindowed({
      render: () => renderHook(() => useOwnerOperatorPay(week)), from, to,
      pick: (s) => s.rows.map((row) => ({ id: row.driver.id, trips: row.trips, dup: [...row.duplicateTripIds], statement: row.statement })),
      settled: (s) => !s.loading && s.rows.length === 1,
    })
    expect(r.full[0].trips.length).toBeGreaterThan(0)
    expect(r.windowedCount).toBeLessThan(r.fullCount)
    expect(r.windowed).toEqual(r.full)
  })
})
