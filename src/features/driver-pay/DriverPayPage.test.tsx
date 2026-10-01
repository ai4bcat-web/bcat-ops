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
    totalDeductions: 0, factoringFee: 0, subtotal: 0, totalCredits: 0, totalDebits: 0,
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
  it('lists the factoring fee at $0.00 on a week with no trips', () => {
    useAmazonPayMock.mockReturnValue(payState([row()]))
    render(<DriverPayPage />)

    expect(screen.getByText(FACTORING_FEE_LABEL).parentElement).toHaveTextContent('($0.00)')
  })

  it('lists the factoring fee alongside the week’s other deductions', () => {
    useAmazonPayMock.mockReturnValue(payState([row({
      deductions: [{ label: 'INSURANCE (weekly)', amount: 400 }],
      statement: statement({ gross: 2000, factoringFee: 40, totalDeductions: 440, driverAmount: 655.2, checkAmount: 655.2 }),
    })]))
    render(<DriverPayPage />)

    expect(screen.getByText(FACTORING_FEE_LABEL).parentElement).toHaveTextContent('($40.00)')
    expect(screen.getByText('INSURANCE (weekly)')).toBeInTheDocument()
  })

  it('exports the factoring fee line even when it is $0.00', async () => {
    useAmazonPayMock.mockReturnValue(payState([row()]))
    render(<DriverPayPage />)

    expect(await csvFromExportClick()).toContain('"Factoring fee (2%)","0"')
  })
})
