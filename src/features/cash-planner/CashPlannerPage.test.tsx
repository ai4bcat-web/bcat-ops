// @vitest-environment jsdom
/**
 * The Cash planner is believed about one thing: it never pays. It lists what to pay from the bank balances typed in,
 * oldest bill first, keeps the buffer, and its one button only selects approved bills for the pay run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CarrierBillRecord } from '@/types/tms'
import type { VendorPayable } from '@/types/vendorAp'
import { readAmount, readInputs } from '@/lib/cashPlanner'
import { CashPlannerPage } from './CashPlannerPage'

const openBillsMock = vi.hoisted(() => vi.fn())
const vendorMock = vi.hoisted(() => vi.fn())
const selectMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/hooks/useOpenBills', () => ({ useOpenBills: openBillsMock }))
vi.mock('@/hooks/useVendorPayables', () => ({ useVendorPayables: vendorMock }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'ryne@bcatcorp.com' } }) }))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => String(e),
  listCarrierPaymentInfo: vi.fn().mockResolvedValue([]),
  getFactorRemitEmails: vi.fn().mockResolvedValue({}),
  selectBillsForPayment: selectMock,
}))

const bill = (n: number, dueAt: string, dollars: number, status: CarrierBillRecord['status'] = 'TO_BE_PAID'): CarrierBillRecord => ({
  id: `bill-${n}`, shipmentNumber: String(14000 + n), carrierName: `Carrier ${n}`, payeeKind: 'CARRIER', status, dueAt, balanceCents: dollars * 100,
} as unknown as CarrierBillRecord)

const vendorBill = (id: string, name: string, dollars: number, due: string): VendorPayable => ({
  id, status: 'NEED_TO_PAY', source: 'EMAIL', subject: name, vendor: name, invoiceNumber: id, amount: dollars * 100, dueDate: due,
  attachments: [], receivedAt: '2026-10-10T12:00:00Z', createdAt: '2026-10-10T12:00:00Z', updatedAt: '2026-10-10T12:00:00Z',
})

function openBills(bills: CarrierBillRecord[]) {
  openBillsMock.mockReturnValue({ bills, loading: false, error: null, refresh: vi.fn().mockResolvedValue(undefined) })
}

function renderPage() {
  return render(<MemoryRouter><CashPlannerPage /></MemoryRouter>)
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  vendorMock.mockReturnValue({ items: [], loading: false, error: null })
  openBills([bill(1, '2026-09-17', 1300), bill(2, '2026-09-26', 1000), bill(3, '2026-10-14', 10_000)])
  selectMock.mockResolvedValue({ selected: ['bill-1', 'bill-2'], skipped: [] })
})

describe('amounts', () => {
  it('reads typed money and ignores anything else', () => {
    expect(readAmount('$1,250.50')).toBe(1250.5)
    expect(readAmount('abc')).toBe(0)
    expect(readAmount('-5')).toBe(0)
    expect(readInputs({ bcatCash: '20000', ivanCash: '', bcatBuffer: '5000', ivanBuffer: '', driverSettlements: '', cardBalance: '', cardApr: '', otherObligations: '', transfer: '' })).toMatchObject({ bcatCash: 20000, cardApr: null })
  })
})

describe('CashPlannerPage', () => {
  it('asks for the bank balances before it plans anything', () => {
    renderPage()
    expect(screen.getByText(/Enter the two bank balances/)).toBeTruthy()
    expect(screen.queryByTestId('cash-plan-summary')).toBeNull()
  })

  it('pays the oldest bills inside the cash above the buffer and leaves the rest waiting', () => {
    renderPage()
    type('BCAT bank balance', '8300')
    type('BCAT: keep at least', '5000')
    const table = screen.getByRole('table', { name: 'Bills to pay this week' })
    // 8,300 − 5,000 = 3,300 spendable: the two oldest bills (2,300) fit, the 10,000 one does not.
    expect(within(table).getByText('PRO 14001')).toBeTruthy()
    expect(within(table).getByText('PRO 14002')).toBeTruthy()
    expect(within(table).queryByText('PRO 14003')).toBeNull()
    const waits = screen.getByRole('table', { name: 'Bills that wait for cash' })
    expect(within(waits).getByText('PRO 14003')).toBeTruthy()
    expect(screen.getByTestId('cash-plan-summary').textContent).toContain('$2,300.00')
  })

  it('plans Ivan: settlements first, vendor bills, then the card, and keeps the buffer', () => {
    vendorMock.mockReturnValue({ items: [vendorBill('60067129', 'Vanguard Truck Leasing', 994.32, '2026-09-28')], loading: false, error: null })
    renderPage()
    type('Ivan bank balance', '68000')
    type('Driver settlements owed', '7000')
    type('Credit card balance', '7000')
    const ivan = screen.getByRole('table', { name: 'Ivan payments' })
    const rows = within(ivan).getAllByRole('row').slice(1).map((r) => r.textContent ?? '')
    expect(rows[0]).toContain('Driver settlements')
    expect(rows[1]).toContain('Vanguard Truck Leasing #60067129')
    expect(rows[2]).toContain('Credit card')
    expect(rows[2]).toContain('Pay in full')
  })

  it('selects only the bills in the plan, after a confirmation, and pays nothing', async () => {
    renderPage()
    type('BCAT bank balance', '8300')
    type('BCAT: keep at least', '5000')
    fireEvent.click(screen.getByTestId('select-plan-bills'))
    expect(selectMock).not.toHaveBeenCalled()
    expect(screen.getByText(/Nothing is paid/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, select them' }))
    await waitFor(() => expect(selectMock).toHaveBeenCalledWith({ billIds: ['bill-1', 'bill-2'] }))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
  })

  it('never offers to select a bill that is still in review', () => {
    openBills([bill(1, '2026-09-17', 500, 'IN_REVIEW')])
    renderPage()
    type('BCAT bank balance', '9000')
    expect(screen.queryByTestId('select-plan-bills')).toBeNull()
    expect(screen.getByRole('table', { name: 'Bills to approve first' })).toBeTruthy()
  })

  it('remembers the last numbers on this browser', () => {
    const first = renderPage()
    type('Ivan bank balance', '68000')
    first.unmount()
    renderPage()
    expect((screen.getByLabelText('Ivan bank balance') as HTMLInputElement).value).toBe('68000')
  })
})
