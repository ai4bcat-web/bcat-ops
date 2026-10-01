// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const podState = vi.hoisted(() => ({ items: [] as { loadId?: string | null }[] }))

vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  listLoads: () => Promise.resolve(loads),
  listCustomers: () => Promise.resolve([]),
  listLocations: () => Promise.resolve([]),
  listDriverPaySettings: () => Promise.resolve(settings),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve([]),
}))
vi.mock('@/lib/podsClient', () => ({
  listPods: () => Promise.resolve({ items: podState.items, nextToken: null }),
}))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers, updateDriver: vi.fn() }) }))
vi.mock('@/hooks/useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

// Dynamic import: the vi.mock factories reference `loads`/`settings`/`drivers`, so the
// hook must load AFTER those consts initialize. A static import is hoisted above them
// and would hit the temporal dead zone.
const { useOwnerOperatorPay } = await import('./useOwnerOperatorPay')

beforeEach(() => { podState.items = [] })

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
    const row = result.current.rows[0]
    expect(row.deductions.map((d) => d.label)).toContain('INSURANCE')
    // Every statement also carries the 2% factoring fee on gross ($20 here).
    expect(row.statement.factoringFee).toBeCloseTo(20, 2)
    // ($1,000 − $400 insurance − $20 factoring fee) × 50%.
    expect(row.statement.checkAmount).toBeCloseTo(290, 2)
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

  it('attaches factoring readiness to every trip', async () => {
    const { result } = renderHook(() => useOwnerOperatorPay('2026-09-27'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    const trip = result.current.rows[0].trips[0]
    // The fixture load has no linked Customer, Location, POD or rate con.
    expect(trip.readiness?.ready).toBe(false)
    expect(trip.readiness?.missingFields).toContain('BrokerMC')
    expect(trip.readiness?.missingDocuments).toContain('POD')
  })

  it('counts a POD assigned to the load as present', async () => {
    podState.items = [{ loadId: 'l1' }]
    const { result } = renderHook(() => useOwnerOperatorPay('2026-09-27'))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(result.current.rows[0].trips[0].readiness?.missingDocuments).not.toContain('POD')
  })
})
