// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// "This week" is 2026-09-27; the newest imported trips are the week before.
const trips = [
  { id: 't1', driverId: 'drv-1', periodStart: '2026-09-13', freightAmount: 500, status: 'Completed' },
  { id: 't2', driverId: 'drv-1', periodStart: '2026-09-20', freightAmount: 700, status: 'Completed' },
]
const settings = [{
  id: 's1', driverId: 'drv-1', payGroup: 'AMAZON', payPercent: 0.88,
  expensesBeforePercent: false, active: true,
  updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
}]
const drivers = [{ id: 'drv-1', name: 'Amazon Driver', type: 'driver', active: true }]

vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  listAmazonTrips: () => Promise.resolve(trips),
  listDriverPaySettings: () => Promise.resolve(settings),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
}))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers, updateDriver: vi.fn() }) }))
vi.mock('@/hooks/useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

const { useAmazonPay } = await import('./useAmazonPay')

describe('useAmazonPay default week', () => {
  beforeAll(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date('2026-09-30T12:00:00Z')) })
  afterAll(() => { vi.useRealTimers() })

  it('opens on the newest week that has trips when the current week is empty', async () => {
    // Twice now this read as "the Amazon settlement history is gone": the current week has
    // no imported trips, so every driver renders deductions-only as a negative check.
    const { result } = renderHook(() => useAmazonPay(null))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.periodStart).toBe('2026-09-20')
    expect(result.current.tripCount).toBe(1)
  })

  it('honours an explicitly picked week over the derived default', async () => {
    const { result } = renderHook(() => useAmazonPay('2026-09-13'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.periodStart).toBe('2026-09-13')
  })
})
