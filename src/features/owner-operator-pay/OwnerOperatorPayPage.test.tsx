// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { OwnerOperatorPayPage } from './OwnerOperatorPayPage'
import type { OwnerOperatorPayRow, OwnerOperatorPayState } from '@/hooks/useOwnerOperatorPay'
import { OWNER_OP_FIRST_PERIOD } from '@/lib/ownerOperatorTrips'
import { weekLabelLong } from '@/features/driver-pay/week'
import type { Driver, DriverPaySetting } from '@/lib/apiClient'
import type { DriverPayStatement } from '@/lib/driverPay'

const useOwnerOperatorPayMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useOwnerOperatorPay', () => ({
  useOwnerOperatorPay: useOwnerOperatorPayMock,
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'staff@example.com' } }),
}))

vi.mock('@/lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apiClient')>()
  return {
    ...actual,
    payCreditsDeployed: () => true,
  }
})

vi.mock('sonner', () => ({ toast: vi.fn() }))

function baseDriver(over: Partial<Driver> = {}): Driver {
  return {
    id: 'd1',
    name: 'Test Driver',
    phone: '+15551234567',
    active: true,
    colorKey: 'driver-1',
    email: 'driver@example.com',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Driver
}

function baseSetting(over: Partial<DriverPaySetting> = {}): DriverPaySetting {
  return {
    id: 's1',
    driverId: 'd1',
    payPercent: 0.42,
    expensesBeforePercent: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as DriverPaySetting
}

function baseStatement(over: Partial<DriverPayStatement> = {}): DriverPayStatement {
  return {
    gross: 0,
    payPercent: 0.42,
    expensesBeforePercent: true,
    driverAmount: 0,
    totalDeductions: 0,
    subtotal: 0,
    totalCredits: 0,
    totalDebits: 0,
    payBeforeCredits: 0,
    checkAmount: 0,
    ...over,
  } as DriverPayStatement
}

function baseRow(over: Partial<OwnerOperatorPayRow> = {}): OwnerOperatorPayRow {
  return {
    driver: baseDriver(over.driver),
    setting: baseSetting(over.setting),
    baseSetting: baseSetting(over.baseSetting),
    trips: over.trips ?? [],
    fuel: 0,
    fuelTxns: [],
    deductions: over.deductions ?? [],
    oneOffs: over.oneOffs ?? [],
    credits: over.credits ?? [],
    debits: over.debits ?? [],
    fixedDebits: over.fixedDebits ?? [],
    statement: baseStatement(over.statement),
  }
}

function basePayState(over: Partial<OwnerOperatorPayState> = {}) {
  return {
    loading: false,
    error: null,
    rows: [] as OwnerOperatorPayRow[],
    unconfigured: [] as Driver[],
    refresh: vi.fn(),
    saveSetting: vi.fn(),
    addDeduction: vi.fn(),
    removeDeduction: vi.fn(),
    addCredit: vi.fn(),
    updateCredit: vi.fn(),
    removeCredit: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime('2026-09-30T12:00:00Z')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OwnerOperatorPayPage', () => {
  it('disables the previous-week control on the first owner-operator period', () => {
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [baseRow()] }))
    render(<OwnerOperatorPayPage />)
    expect(screen.getByRole('button', { name: /previous week/i })).toBeDisabled()
    expect(screen.getByText(weekLabelLong(OWNER_OP_FIRST_PERIOD))).toBeInTheDocument()
  })

  it('renders a driver row with brokerage loads and check amount', () => {
    const row = baseRow({
      trips: [
        {
          id: 't1',
          loadId: 'TMS-123',
          customer: 'Acme',
          origin: 'Chicago, IL',
          destination: 'Detroit, MI',
          miles: 250,
          freightAmount: 450,
          deliveredAt: '2026-09-29T10:00:00Z',
        },
      ],
      statement: baseStatement({
        gross: 450,
        driverAmount: 189,
        subtotal: 450,
        payBeforeCredits: 189,
        checkAmount: 189,
      }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<OwnerOperatorPayPage />)

    expect(screen.getAllByText('Test Driver').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('TMS-123')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Chicago, IL → Detroit, MI')).toBeInTheDocument()
    expect(screen.getByText('250')).toBeInTheDocument()
    expect(screen.getAllByText('$450.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('$189.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Check amount').closest('div')?.parentElement).toHaveTextContent('$189.00')
  })
})
