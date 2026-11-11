// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BoxTruckPayPage } from './BoxTruckPayPage'
import type { BoxTruckPayRow } from '@/hooks/useBoxTruckPay'
import { FACTORING_FEE_LABEL, type DriverPayStatement } from '@/lib/driverPay'
import type { Driver } from '@/types'
import type { DriverPaySetting } from '@/lib/apiClient'

const useBoxTruckPayMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useBoxTruckPay', () => ({ useBoxTruckPay: useBoxTruckPayMock }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'staff@example.com' } }) }))
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ graphql: vi.fn(), models: {}, queries: {}, mutations: {} }) })) // apiClient builds its client at import
vi.mock('@/lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiClient')>()),
  payCreditsDeployed: () => true,
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

const driver = { id: 'd1', name: 'Box Driver', active: true, colorKey: 'driver-1' } as Driver
const setting = { id: 's1', driverId: 'd1', payPercent: 0.3, expensesBeforePercent: true } as DriverPaySetting

function statement(over: Partial<DriverPayStatement> = {}): DriverPayStatement {
  return {
    gross: 0, payPercent: 0.3, expensesBeforePercent: true, driverAmount: 0,
    totalDeductions: 0, factoringFee: 0, factoringFeePct: 0.02, subtotal: 0, totalCredits: 0, totalDebits: 0,
    payBeforeCredits: 0, checkAmount: 0, ...over,
  } as DriverPayStatement
}

function row(over: Partial<BoxTruckPayRow> = {}): BoxTruckPayRow {
  return {
    driver, setting, trips: [], fuel: 0, fuelTxns: [], deductions: [], oneOffs: [],
    credits: [], debits: [], fixedDebits: [], statement: statement(), unpulledLoadCount: 0,
    ...over,
  } as BoxTruckPayRow
}

function payState(rows: BoxTruckPayRow[]) {
  return {
    loading: false, error: null, rows, tripCount: 0, unconfigured: [] as Driver[],
    refresh: vi.fn(), pullFromCalendar: vi.fn(), addTrip: vi.fn(), updateTrip: vi.fn(),
    removeTrip: vi.fn(), pushTripToNextPeriod: vi.fn(), clearPeriod: vi.fn(),
    saveSetting: vi.fn(), addDeduction: vi.fn(), removeDeduction: vi.fn(),
    addCredit: vi.fn(), updateCredit: vi.fn(), removeCredit: vi.fn(),
  }
}

beforeEach(() => { vi.clearAllMocks() })

describe('BoxTruckPayPage deductions', () => {
  it('lists the factoring fee at $0.00 on a period with no shipments', () => {
    useBoxTruckPayMock.mockReturnValue(payState([row()]))
    render(<BoxTruckPayPage />)

    expect(screen.getByText(FACTORING_FEE_LABEL).parentElement).toHaveTextContent('($0.00)')
    expect(screen.getByText('Total deductions').parentElement).toHaveTextContent('($0.00)')
  })

  it('exports the factoring fee line even when it is $0.00', async () => {
    useBoxTruckPayMock.mockReturnValue(payState([row()]))
    render(<BoxTruckPayPage />)

    const blobs: Blob[] = []
    const create = URL.createObjectURL
    const revoke = URL.revokeObjectURL
    URL.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:test' }
    URL.revokeObjectURL = () => {}
    // The download is an anchor click; jsdom would try to navigate to the blob URL.
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
      expect(await blobs[0].text()).toContain('"Factoring fee (2%)","0"')
      expect(anchorClick).toHaveBeenCalledTimes(1)
    } finally {
      anchorClick.mockRestore()
      URL.createObjectURL = create
      URL.revokeObjectURL = revoke
    }
  })
})

describe('BoxTruckPayPage trip amounts', () => {
  const trip = { id: 't1', driverId: 'd1', periodStart: '2026-10-28', loadId: 'l1', date: '2026-11-03', aljexPro: '14906', proNumber: 'KJT2610082', customer: 'KROSLAND LOGISTICS', status: 'Delivered', grossProfit: 300, customerRate: null, carrierCost: null } as never

  it('clicking the gross profit or amount opens the editor, and profit follows rate minus cost until it is typed', () => {
    const updateTrip = vi.fn().mockResolvedValue(undefined)
    useBoxTruckPayMock.mockReturnValue({ ...payState([row({ trips: [trip] })]), updateTrip })
    render(<BoxTruckPayPage />)
    fireEvent.click(screen.getByTestId('trip-gross-profit'))
    expect(screen.getByText('Edit shipment')).toBeInTheDocument()
    // An existing trip's profit is the person's number: typing a rate and cost does not overwrite it.
    fireEvent.change(screen.getByPlaceholderText('$1,150.00'), { target: { value: '1150' } })
    fireEvent.change(screen.getByPlaceholderText('$500.00'), { target: { value: '500' } })
    expect((screen.getByPlaceholderText('$650.00') as HTMLInputElement).value).toBe('300')
    fireEvent.change(screen.getByPlaceholderText('$650.00'), { target: { value: '450' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save shipment' }))
    expect(updateTrip).toHaveBeenCalledWith('t1', expect.objectContaining({ grossProfit: 450, customerRate: 1150, carrierCost: 500 }))
  })

  it('a trip with a $0 profit (nothing entered yet) takes its profit from the rate and cost typed in', () => {
    useBoxTruckPayMock.mockReturnValue(payState([row({ trips: [{ ...(trip as object), grossProfit: 0 } as never] })]))
    render(<BoxTruckPayPage />)
    fireEvent.click(screen.getByTestId('trip-gross-profit'))
    fireEvent.change(screen.getByPlaceholderText('$1,150.00'), { target: { value: '1150' } })
    fireEvent.change(screen.getByPlaceholderText('$500.00'), { target: { value: '500' } })
    expect((screen.getByPlaceholderText('$650.00') as HTMLInputElement).value).toBe('650')
  })

  it('a new shipment fills gross profit from rate minus cost', () => {
    useBoxTruckPayMock.mockReturnValue(payState([row()]))
    render(<BoxTruckPayPage />)
    fireEvent.click(screen.getByRole('button', { name: /Add shipment/ }))
    fireEvent.change(screen.getByPlaceholderText('$1,150.00'), { target: { value: '1150' } })
    fireEvent.change(screen.getByPlaceholderText('$500.00'), { target: { value: '500' } })
    expect((screen.getByPlaceholderText('$650.00') as HTMLInputElement).value).toBe('650')
  })
})
