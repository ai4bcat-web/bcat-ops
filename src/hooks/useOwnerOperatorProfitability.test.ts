// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useOwnerOperatorProfitability, aggregateOwnerOperator } from './useOwnerOperatorProfitability'

const { listLoads, listDriverPaySettings, listDriverPayDeductions, listDriverPayCredits } = vi.hoisted(() => ({
  listLoads: vi.fn(),
  listDriverPaySettings: vi.fn(),
  listDriverPayDeductions: vi.fn(),
  listDriverPayCredits: vi.fn(),
}))

vi.mock('@/lib/apiClient', () => ({
  listLoads: () => listLoads(),
  listDriverPaySettings: () => listDriverPaySettings(),
  listDriverPayDeductions: () => listDriverPayDeductions(),
  listDriverPayCredits: () => listDriverPayCredits(),
}))

vi.mock('./useDrivers', () => ({ useDrivers: () => ({ drivers: [{ id: 'd1', name: 'Chad', type: 'company' }] }) }))
vi.mock('./useFuelTransactions', () => ({ useFuelTransactions: () => ({ transactions: [] }) }))

beforeEach(() => {
  listLoads.mockReset()
  listDriverPaySettings.mockReset()
  listDriverPayDeductions.mockReset()
  listDriverPayCredits.mockReset()
  listDriverPayDeductions.mockResolvedValue([])
  listDriverPayCredits.mockResolvedValue([])
})

const load = (id: string, deliveryAppt: string, rate: number) => ({
  id, tmsId: id, deliveryDriverId: 'd1', deliveryAppt, rate,
})

const setting = (fixedExpenses: unknown[], payPercent: number, expensesBeforePercent: boolean) => ({
  id: 's1',
  driverId: 'd1',
  payGroup: 'OWNER_OPERATOR',
  payPercent,
  expensesBeforePercent,
  fixedExpenses,
  active: true,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
})

describe('useOwnerOperatorProfitability', () => {
  it('turns a delivered week into company profit = revenue − driver check − expenses', async () => {
    // $4,000 freight delivered Wed 9/30 → the 9/27 pay week. Deductions are the 2%
    // factoring fee ($80) plus a $20 ELD charge, so the check is 0.88 × 4000 − 100
    // = 3420 and the company keeps 4000 − 3420 − 100.
    listLoads.mockResolvedValue([load('L1', '2026-09-30T14:00:00Z', 400_000)])
    listDriverPaySettings.mockResolvedValue([setting([{ label: 'ELD', amount: 20 }], 0.88, false)])

    const { result } = renderHook(() => useOwnerOperatorProfitability())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.rows).toHaveLength(1)
    const r = result.current.rows[0]
    expect(r.periodStart).toBe('2026-09-27')
    expect(r.driverName).toBe('Chad')
    expect(r.gross).toBe(4_000)
    expect(r.driverPay).toBe(3_420)
    expect(r.expenses).toBe(100)
    expect(r.profit).toBe(480)
    expect(r.profit).toBe(r.gross - r.driverPay - r.expenses)
  })

  it('contributes nothing for a week before the owner-operator changeover', async () => {
    // Delivered Wed 9/23 — that week still settles on the Amazon statement.
    listLoads.mockResolvedValue([load('L1', '2026-09-23T14:00:00Z', 400_000)])
    listDriverPaySettings.mockResolvedValue([setting([{ label: 'ELD', amount: 20 }], 0.88, false)])

    const { result } = renderHook(() => useOwnerOperatorProfitability())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.rows).toEqual([])
    expect(result.current.weeks).toEqual([])
    expect(aggregateOwnerOperator(result.current.rows, '2026-09-20', '2026-09-20').profit).toBe(0)
  })

  it('counts the companyAmount of an after-split fixed charge as a company expense', async () => {
    listLoads.mockResolvedValue([load('L1', '2026-09-30T14:00:00Z', 400_000)])
    listDriverPaySettings.mockResolvedValue([setting([
      { label: 'ELD', amount: 20 },
      { label: 'Lease', amount: 496, afterPercent: true, companyAmount: 496 },
    ], 0.5, true)])

    const { result } = renderHook(() => useOwnerOperatorProfitability())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const r = result.current.rows[0]
    // Deductions = $80 factoring fee + $20 ELD; 0.5 × (4000 − 100) = 1950, less the
    // $496 lease debit the driver bears in full.
    expect(r.driverPay).toBe(1_454)
    // Driver-side deductions ($100 + $496) plus the company's own $496 lease share.
    expect(r.expenses).toBe(100 + 496 + 496)
    expect(r.profit).toBe(4_000 - 1_454 - 1_092)
  })

  it('skips inactive settings and pay groups that are not owner-operator', async () => {
    listLoads.mockResolvedValue([load('L1', '2026-09-30T14:00:00Z', 400_000)])
    listDriverPaySettings.mockResolvedValue([
      { ...setting([], 0.88, false), active: false },
      { ...setting([], 0.88, false), id: 's2', payGroup: 'BOX_TRUCK' },
    ])

    const { result } = renderHook(() => useOwnerOperatorProfitability())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.rows).toEqual([])
  })

  it('sums several loads in the same week into one driver-week row', async () => {
    listLoads.mockResolvedValue([
      load('L1', '2026-09-28T14:00:00Z', 200_000),
      load('L2', '2026-10-02T14:00:00Z', 200_000),
    ])
    listDriverPaySettings.mockResolvedValue([setting([], 1, false)])

    const { result } = renderHook(() => useOwnerOperatorProfitability())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0].gross).toBe(4_000)
  })
})
