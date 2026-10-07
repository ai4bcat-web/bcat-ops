// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DriverPayPage } from './DriverPayPage'
import type { DriverPayRow } from '@/hooks/useAmazonPay'
import { FACTORING_FEE_LABEL, type DriverPayStatement } from '@/lib/driverPay'
import type { Driver } from '@/types'
import type { DriverPaySetting } from '@/lib/apiClient'

const useAmazonPayMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useAmazonPay', () => ({
  useAmazonPay: useAmazonPayMock,
  periodEnd: (periodStart: string) => periodStart,
}))
vi.mock('@/hooks/useAmazonPayMasters', () => ({
  useAmazonPayMasters: () => ({ masters: [], loading: false, archive: vi.fn(), download: vi.fn(), remove: vi.fn() }),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'staff@example.com' } }) }))
vi.mock('@/hooks/useDrivers', () => ({ useDrivers: () => ({ drivers: [] }) }))
vi.mock('@/lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiClient')>()),
  payCreditsDeployed: () => true,
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

const WEEK = '2026-09-20'

const driver = { id: 'd1', name: 'Amazon Driver', active: true, colorKey: 'driver-1' } as Driver
const setting = { id: 's1', driverId: 'd1', payPercent: 0.42, expensesBeforePercent: true } as DriverPaySetting

function statement(over: Partial<DriverPayStatement> = {}): DriverPayStatement {
  return {
    gross: 0, payPercent: 0.42, expensesBeforePercent: true, driverAmount: 0,
    // Amazon: never factored, so the statement carries no fee line.
    totalDeductions: 0, factoringFee: 0, factoringFeePct: 0, subtotal: 0, totalCredits: 0, totalDebits: 0,
    payBeforeCredits: 0, checkAmount: 0, ...over,
  } as DriverPayStatement
}

function row(over: Partial<DriverPayRow> = {}): DriverPayRow {
  return {
    driver, setting, baseSetting: setting,
    trips: [], fuel: 0, fuelTxns: [], deductions: [], oneOffs: [],
    credits: [], debits: [], fixedDebits: [],
    statement: statement(), duplicateTripIds: new Set<string>(),
    ...over,
  } as DriverPayRow
}

function payState(rows: DriverPayRow[]) {
  return {
    loading: false, error: null, rows, allTrips: [], tripCount: 0, periodStart: WEEK,
    unconfigured: [] as Driver[], refresh: vi.fn(),
    addTrip: vi.fn(), updateTrip: vi.fn(), removeTrip: vi.fn(), clearWeek: vi.fn(),
    saveSetting: vi.fn(), addDeduction: vi.fn(), removeDeduction: vi.fn(),
    addCredit: vi.fn(), updateCredit: vi.fn(), removeCredit: vi.fn(),
  }
}

function csvFromExportClick(): Promise<string> {
  const blobs: Blob[] = []
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:test' }
  URL.revokeObjectURL = () => {}
  try {
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
    return blobs[0].text()
  } finally {
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
  }
}

beforeEach(() => { vi.clearAllMocks() })

describe('DriverPayPage deductions', () => {
  it('shows NO factoring fee line on an Amazon week with no trips — Amazon is never factored', () => {
    useAmazonPayMock.mockReturnValue(payState([row()]))
    render(<DriverPayPage />)

    expect(screen.queryByText(FACTORING_FEE_LABEL)).toBeNull()
    expect(screen.getByText(/No deductions\./)).toBeInTheDocument()
  })

  it('lists the week’s other deductions without a factoring fee', () => {
    useAmazonPayMock.mockReturnValue(payState([row({
      deductions: [{ label: 'INSURANCE (weekly)', amount: 400 }],
      statement: statement({ gross: 2000, totalDeductions: 400, driverAmount: 672, checkAmount: 672 }),
    })]))
    render(<DriverPayPage />)

    expect(screen.queryByText(FACTORING_FEE_LABEL)).toBeNull()
    expect(screen.getByText('INSURANCE (weekly)')).toBeInTheDocument()
    expect(screen.getByText('Total deductions').parentElement).toHaveTextContent('($400.00)')
  })

  it('exports no factoring fee line for an Amazon statement', async () => {
    useAmazonPayMock.mockReturnValue(payState([row()]))
    render(<DriverPayPage />)

    const csv = await csvFromExportClick()
    expect(csv).not.toContain('Factoring fee')
    expect(csv).toContain('"Total deductions","0"')
  })
})
