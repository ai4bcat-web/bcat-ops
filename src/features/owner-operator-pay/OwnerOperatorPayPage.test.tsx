// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { OwnerOperatorPayPage } from './OwnerOperatorPayPage'
import type { OwnerOperatorPayRow, OwnerOperatorPayState } from '@/hooks/useOwnerOperatorPay'
import { OWNER_OP_FIRST_PERIOD } from '@/lib/ownerOperatorTrips'
import { weekLabelLong } from '@/features/driver-pay/week'
import type { Driver } from '@/types'
import type { DriverPaySetting } from '@/lib/apiClient'
import type { DriverPayStatement } from '@/lib/driverPay'
import type { OtrReadiness } from '@/lib/otrInvoice'
import { DRIVER_PORTAL_URL } from '@/lib/driverPortal'

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
    factoringFee: 0,
    subtotal: 0,
    totalCredits: 0,
    totalDebits: 0,
    payBeforeCredits: 0,
    checkAmount: 0,
    ...over,
  } as DriverPayStatement
}

function readiness(over: Partial<OtrReadiness> = {}): OtrReadiness {
  return { ready: false, payload: {}, sources: {}, missingFields: [], missingDocuments: [], warnings: [], ...over }
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
    duplicateTripIds: over.duplicateTripIds ?? new Set<string>(),
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

  it('shows the driver app URL and falls back to the pay-setting email when the driver email is blank', () => {
    const row = baseRow({
      driver: baseDriver({ email: '' }),
      setting: baseSetting({ email: 'pay@example.com' }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<OwnerOperatorPayPage />)

    expect(screen.getByText(DRIVER_PORTAL_URL)).toBeInTheDocument()
    expect(screen.getAllByText('pay@example.com').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/sets their own password/i)).toBeInTheDocument()
  })

  it('prefers the driver record email over the pay-setting email', () => {
    const row = baseRow({
      driver: baseDriver({ email: 'driver@example.com' }),
      setting: baseSetting({ email: 'pay@example.com' }),
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<OwnerOperatorPayPage />)

    expect(screen.queryByText('pay@example.com')).not.toBeInTheDocument()
    expect(screen.getAllByText('driver@example.com').length).toBeGreaterThanOrEqual(1)
  })

  it('surfaces missing factoring fields and summarises ready vs blocked trips', () => {
    const row = baseRow({
      trips: [
        {
          id: 't1',
          loadId: 'TMS-1',
          customer: 'Acme',
          origin: 'Chicago, IL',
          destination: 'Detroit, MI',
          miles: 100,
          freightAmount: 500,
          deliveredAt: '2026-09-29T10:00:00Z',
          readiness: readiness({ missingFields: ['BrokerMC', 'FromZip'], missingDocuments: ['POD'] }),
        },
        {
          id: 't2',
          loadId: 'TMS-2',
          customer: 'Acme',
          origin: 'Chicago, IL',
          destination: 'Detroit, MI',
          miles: 100,
          freightAmount: 500,
          deliveredAt: '2026-09-30T10:00:00Z',
          readiness: readiness({ ready: true, payload: { InvoiceNo: 'PRO2' } }),
        },
      ],
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    render(<OwnerOperatorPayPage />)

    expect(screen.getAllByText('Broker MC').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Origin ZIP').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('1 of 2 ready').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('1 blocked').length).toBeGreaterThanOrEqual(1)
  })

  it('exports every factoring column in the CSV', async () => {
    const row = baseRow({
      trips: [{
        id: 't1',
        loadId: 'TMS-1',
        customer: 'Acme',
        origin: 'Chicago, IL',
        destination: 'Detroit, MI',
        miles: 100,
        freightAmount: 500,
        deliveredAt: '2026-09-29T10:00:00Z',
        readiness: readiness({
          ready: true,
          payload: {
            InvoiceNo: 'PRO9', PoNumber: 'PO9', BrokerMC: '999', InvoiceAmount: 500, InvoiceDate: '2026-09-29',
            FromCity: 'CHICAGO', FromState: 'IL', FromZip: '60601', ToCity: 'DETROIT', ToState: 'MI', ToZip: '48201',
          },
        }),
      }],
    })
    useOwnerOperatorPayMock.mockReturnValue(basePayState({ rows: [row] }))
    const blobs: Blob[] = []
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:test' }
    URL.revokeObjectURL = () => {}
    try {
      render(<OwnerOperatorPayPage />)
      fireEvent.click(screen.getByRole('button', { name: /CSV/i }))
      const text = await blobs[0].text()
      for (const header of [
        'PRO #', 'PO #', 'Broker MC', 'Invoice amount', 'Invoice date',
        'Origin city', 'Origin state', 'Origin ZIP', 'Dest city', 'Dest state', 'Dest ZIP',
        'POD', 'Rate confirmation',
      ]) {
        expect(text).toContain(header)
      }
      expect(text).toContain('PRO9')
      expect(text).toContain('60601')
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })
})
