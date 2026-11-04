// @vitest-environment jsdom
// I5: every range of the dashboard (current + previous period) reads the same off the
// windowed store as off the whole table.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook } from '@testing-library/react'
import { invalidateLists, peekList } from '@/lib/listCache'
import { FIXTURE_NOW } from './loadWindowFixture'
import { computeFullAndWindowed } from './loadWindowRun'

vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  ...(await import('./loadWindowFixture')).fixtureApi,
}))

const { useDashboardMetrics } = await import('./useDashboardMetrics')

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FIXTURE_NOW)) })
afterAll(() => { vi.useRealTimers() })

// The padded window each key needs: from the previous period's start to this period's end.
const RANGES = {
  'today': ['2026-11-03', '2026-11-04'],
  'this-week': ['2026-10-26', '2026-11-08'],
  'this-month': ['2026-10-10', '2026-11-20'],
  'this-quarter': ['2026-07-10', '2026-12-20'],
  'this-year': ['2025-02-01', '2026-12-20'],
} as const

// Drivers with equal counts come out in load-array order, which the window does not
// preserve (open loads first, then month by month) — so compare ties by driver id.
const tieOrder = (m: ReturnType<typeof useDashboardMetrics>) => ({
  ...m,
  loadsPerDriver: [...m.loadsPerDriver].sort((a, b) => b.count - a.count || a.driverId.localeCompare(b.driverId)),
  driverPerformance: [...m.driverPerformance].sort((a, b) => b.totalLoads - a.totalLoads || a.driver.id.localeCompare(b.driver.id)),
})

describe('useDashboardMetrics windowing', () => {
  it.each(Object.entries(RANGES))('%s: same metrics from the window', async (key, [from, to]) => {
    const r = await computeFullAndWindowed({
      render: () => { invalidateLists(); return renderHook(() => useDashboardMetrics(key as keyof typeof RANGES)) }, from, to,
      pick: tieOrder, settled: () => peekList('legacy:needsInvoiceBacklog') !== undefined,
    })
    // `needsInvoice` is all-history; it must not lose the old delivered-uninvoiced load.
    expect(r.windowed).toEqual(r.full)
    expect(r.full.needsInvoice).toBeGreaterThan(0)
    if (key === 'this-month') {
      expect(r.full.totalLoads).toBeGreaterThan(0)
      expect(r.windowedCount).toBeLessThan(r.fullCount)
    }
  })
})
