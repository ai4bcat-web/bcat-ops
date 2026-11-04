// @vitest-environment jsdom
// I5: a truck's week (miles + revenue by delivery day) is the same off the windowed store
// as off the whole table.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import { FIXTURE_NOW } from './loadWindowFixture'
import { computeFullAndWindowed } from './loadWindowRun'

vi.mock('aws-amplify/data', () => ({
  generateClient: () => ({ graphql: () => Promise.resolve({ data: { listTruckOdometerDayByWeekStart: { items: [] } } }) }),
}))
vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  ...(await import('./loadWindowFixture')).fixtureApi,
}))
vi.mock('./useTrucks', () => {
  const trucks = [
    { id: 't1', unitNumber: '009', type: 'truck', active: true },
    { id: 't2', unitNumber: '010', type: 'truck', active: true },
  ]
  return { useTrucks: () => ({ trucks }) }
})
vi.mock('./useDrivers', async () => {
  const { FIXTURE_DRIVERS } = await import('./loadWindowFixture')
  return { useDrivers: () => ({ drivers: FIXTURE_DRIVERS }) }
})

const { useTruckOdometer } = await import('./useTruckOdometer')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FIXTURE_NOW)) })
afterAll(() => { vi.useRealTimers() })

// Sun→Sat weeks: one delivering a load picked up the month before, one with the UTC
// month-edge deliveries.
describe('useTruckOdometer windowing', () => {
  it.each([
    ['2026-09-27', '2026-10-03'],
    ['2026-11-01', '2026-11-07'],
  ])('week %s: same truck revenue from the window', async (week, to) => {
    const r = await computeFullAndWindowed({
      render: () => renderHook(() => useTruckOdometer(week)), from: week, to,
      pick: (s) => s.trucks, settled: (s) => !s.loading,
    })
    expect(r.full.some((t) => t.revenue > 0)).toBe(true)
    expect(r.windowedCount).toBeLessThan(r.fullCount)
    expect(r.windowed).toEqual(r.full)
  })
})
