// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const load = (deliveryAppt: string) => ({
  id: 'l1', tmsId: 'TMS-1', customer: 'Broker', miles: 100, rate: 100000,
  deliveryAppt, deliveryDriverId: 'drv-1',
  originCity: 'Chicago, IL', destinationCity: 'Detroit, MI',
})
const loads = [load('2026-09-29T17:00:00Z'), load('2026-10-06T17:00:00Z')]
loads[1].id = 'l2'

const settings = [{
  id: 's1', driverId: 'drv-1', payGroup: 'AMAZON', payPercent: 0.5,
  expensesBeforePercent: true, active: true, fuelCardNumber: '00056',
  fixedExpenses: [{ label: 'INSURANCE', amount: 400, from: '2026-01-01' }],
  updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
}]
const drivers = [{ id: 'drv-1', name: 'Amazon Driver', type: 'driver', active: true }]

vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  listLoads: () => Promise.resolve(loads),
  listDriverPaySettings: () => Promise.resolve(settings),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
}))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers, updateDriver: vi.fn() }) }))
vi.mock('@/hooks/useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

const { useOwnerOperatorPay } = await import('./useOwnerOperatorPay')

describe('useOwnerOperatorPay', () => {
  it('includes an Amazon driver without requiring a pay-group change', async () => {
    const { result } = renderHook(() => useOwnerOperatorPay('2026-09-27'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.rows[0].driver.name).toBe('Amazon Driver')
  })

  it('carries the first owner-operator week’s expenses, charging them exactly once', async () => {
    // 9/27 is the first owner-operator period, so its charges settle here and NOT on the
    // Amazon statement — one driver-week's insurance must never hit both pages.
    const { result } = renderHook(() => useOwnerOperatorPay('2026-09-27'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.rows[0].deductions.map((d) => d.label)).toContain('INSURANCE')
    // ($1,000 − $400) × 50%.
    expect(result.current.rows[0].statement.checkAmount).toBeCloseTo(300, 2)
  })

  it('keeps an Amazon driver and weekly expenses visible without brokerage loads', async () => {
    const { result } = renderHook(() => useOwnerOperatorPay('2026-10-11'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0].trips).toEqual([])
    expect(result.current.rows[0].statement.checkAmount).toBe(-200)
  })

  it('flags a load whose reference already settled the week before', async () => {
    // Both fixture loads carry TMS-1 in consecutive weeks — the shape a load entered
    // twice takes, which would pay the driver for the same run on two checks.
    const { result } = renderHook(() => useOwnerOperatorPay('2026-10-04'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect([...result.current.rows[0].duplicateTripIds]).toEqual(['l2'])
  })

  it('does not flag the first week, which has no prior settlement to repeat', async () => {
    const { result } = renderHook(() => useOwnerOperatorPay('2026-09-27'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.rows[0].duplicateTripIds.size).toBe(0)
  })
})
