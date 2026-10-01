// @vitest-environment jsdom
// The Amazon and owner-operator statements must never both charge one driver-week's
// expenses. This pins BOTH sides of the changeover against the same fixtures, because a
// gate added to one hook alone is exactly how the double-charge came back.
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { OWNER_OP_FIRST_PERIOD } from '@/lib/ownerOperatorTrips'

const BEFORE = '2026-09-20' // last Amazon-owned week
const FIRST = OWNER_OP_FIRST_PERIOD // '2026-09-27'

const trips = [
  { id: 't1', driverId: 'drv-1', periodStart: BEFORE, freightAmount: 1000, status: 'Completed' },
  { id: 't2', driverId: 'drv-1', periodStart: FIRST, freightAmount: 1000, status: 'Completed' },
]
const loads = [{
  id: 'l1', tmsId: 'TMS-1', customer: 'Broker', miles: 100, rate: 100000,
  deliveryAppt: `${FIRST}T17:00:00Z`, deliveryDriverId: 'drv-1',
  originCity: 'Chicago, IL', destinationCity: 'Detroit, MI',
}]
const settings = [{
  id: 's1', driverId: 'drv-1', payGroup: 'AMAZON', payPercent: 0.5,
  expensesBeforePercent: true, active: true, fuelCardNumber: '00056',
  fixedExpenses: [{ label: 'INSURANCE', amount: 400, from: '2026-01-01' }],
  updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
}]
const drivers = [{ id: 'drv-1', name: 'Amazon Driver', type: 'driver', active: true }]
const adjustments = [BEFORE, FIRST].flatMap((periodStart) => [
  { id: `credit-${periodStart}`, driverId: 'drv-1', periodStart, kind: 'CREDIT', label: 'Reimbursement', amount: 100, createdAt: periodStart },
  { id: `debit-${periodStart}`, driverId: 'drv-1', periodStart, kind: 'DEBIT', label: 'Advance', amount: 50, createdAt: periodStart },
])

vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig() as object),
  listAmazonTrips: () => Promise.resolve(trips),
  listLoads: () => Promise.resolve(loads),
  listDriverPaySettings: () => Promise.resolve(settings),
  listDriverPayDeductions: () => Promise.resolve([]),
  listDriverPayCredits: () => Promise.resolve(adjustments),
}))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers, updateDriver: vi.fn() }) }))
vi.mock('@/hooks/useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

const { useAmazonPay } = await import('./useAmazonPay')
const { useOwnerOperatorPay } = await import('./useOwnerOperatorPay')

const labels = (ded: { label: string }[]) => ded.map((d) => d.label)

describe('weekly charge ownership', () => {
  it('charges the week before the changeover on the Amazon statement only', async () => {
    const { result } = renderHook(() => useAmazonPay(BEFORE))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(labels(result.current.rows[0].deductions)).toContain('INSURANCE')
    expect(result.current.rows[0].statement.checkAmount).toBe(340)
  })

  it('does not charge the first owner-operator week on the Amazon statement', async () => {
    const { result } = renderHook(() => useAmazonPay(FIRST))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    // The Amazon trips still pay out; only the per-week charges have moved.
    expect(labels(result.current.rows[0].deductions)).not.toContain('INSURANCE')
    expect(result.current.rows[0].statement.checkAmount).toBeCloseTo(490, 2)
  })

  it('charges that same week on the owner-operator statement instead', async () => {
    const { result } = renderHook(() => useOwnerOperatorPay(FIRST))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(labels(result.current.rows[0].deductions)).toContain('INSURANCE')
    expect(result.current.rows[0].statement.checkAmount).toBe(340)
  })
})
