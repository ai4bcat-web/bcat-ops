// @vitest-environment jsdom
// I5: a box-truck pay period reads the same off the windowed store as off the whole table.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import { FIXTURE_NOW } from './loadWindowFixture'
import { computeFullAndWindowed } from './loadWindowRun'

const setting = (driverId: string) => ({
  id: `s-${driverId}`, driverId, payGroup: 'BOX_TRUCK', payPercent: 0.3,
  expensesBeforePercent: true, active: true, fixedExpenses: [],
  updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
})

vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  ...(await import('./loadWindowFixture')).fixtureApi,
  listBoxTruckTrips: () => Promise.resolve([]),
  listDriverPaySettings: () => Promise.resolve([setting('d-box'), setting('d-local')]),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
}))
vi.mock('./useDrivers', async () => {
  const { FIXTURE_DRIVERS } = await import('./loadWindowFixture')
  return { useDrivers: () => ({ drivers: FIXTURE_DRIVERS, updateDriver: vi.fn() }) }
})
vi.mock('./useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

const { useBoxTruckPay } = await import('./useBoxTruckPay')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FIXTURE_NOW)) })
afterAll(() => { vi.useRealTimers() })

// Wed→Tue periods: one holding the UTC month-edge deliveries, one holding loads picked up
// the month before and delivered inside the period.
describe('useBoxTruckPay windowing', () => {
  it.each([
    ['2026-10-28', '2026-11-10'],
    ['2026-09-30', '2026-10-13'],
  ])('period %s: same rows from the window', async (periodStart, end) => {
    const r = await computeFullAndWindowed({
      render: () => renderHook(() => useBoxTruckPay(periodStart)), from: periodStart, to: end,
      pick: (s) => s.rows.map((row) => ({ id: row.driver.id, unpulled: row.unpulledLoadCount, trips: row.trips, statement: row.statement })),
      settled: (s) => !s.loading && s.rows.length === 2,
    })
    expect(r.full.some((row) => row.unpulled > 0)).toBe(true)
    expect(r.windowedCount).toBeLessThan(r.fullCount)
    expect(r.windowed).toEqual(r.full)
  })
})
