// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) }))

// drv-1: Amazon group, Amazon trips in the overlap week 2026-10-04 and before the changeover. drv-2: Amazon group, no trips after the changeover.
const trips = [
  { id: 't1', driverId: 'drv-1', periodStart: '2026-09-20', freightAmount: 700, status: 'Completed' },
  { id: 't2', driverId: 'drv-1', periodStart: '2026-10-04', freightAmount: 400, status: 'Completed' },
  { id: 't3', driverId: 'drv-2', periodStart: '2026-09-20', freightAmount: 300, status: 'Completed' },
]
const group = (id: string, driverId: string, extra: object = {}) => ({
  id, driverId, payGroup: 'AMAZON', payPercent: 0.88, expensesBeforePercent: false, active: true, updatedAt: '', createdAt: '', ...extra,
})
let settings = [group('s1', 'drv-1'), group('s2', 'drv-2')]
const drivers = [{ id: 'drv-1', name: 'One', type: 'driver', active: true }, { id: 'drv-2', name: 'Two', type: 'driver', active: true }]

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

const names = async (week: string) => {
  const { result } = renderHook(() => useAmazonPay(week))
  await waitFor(() => expect(result.current.loading).toBe(false))
  return result.current.rows.map((r) => `${r.driver.name}${r.amazonOverlap ? '!' : ''}`)
}

describe('Amazon statement across the owner-operator changeover (2026-09-27)', () => {
  it('before the changeover every Amazon-group driver is listed, exactly as before, with no flag', async () => {
    expect(await names('2026-09-20')).toEqual(['One', 'Two'])
  })

  it('from the changeover an Amazon-group driver with NO Amazon trips is on the owner-operator statement, not here', async () => {
    expect(await names('2026-10-11')).toEqual([])
  })

  it('an overlap week keeps the driver who still has Amazon trips (flagged) and drops the one who has none', async () => {
    expect(await names('2026-10-04')).toEqual(['One!'])
  })

  it('a week pinned to Amazon lists the driver even with no trips, unflagged; a pin to owner operator removes an overlap', async () => {
    settings = [
      group('s1', 'drv-1', { rateHistory: [{ from: '2026-10-04', until: '2026-10-11', payPercent: 0.88, expensesBeforePercent: false, payGroup: 'OWNER_OPERATOR' }] }),
      group('s2', 'drv-2', { rateHistory: [{ from: '2026-10-04', until: '2026-10-11', payPercent: 0.88, expensesBeforePercent: false, payGroup: 'AMAZON' }] }),
    ]
    expect(await names('2026-10-04')).toEqual(['Two'])
    settings = [group('s1', 'drv-1'), group('s2', 'drv-2')]
  })
})
