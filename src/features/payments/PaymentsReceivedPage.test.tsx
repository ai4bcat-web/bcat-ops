// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'

const today = new Date()
const ym = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`

vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: () => '',
  reversePayment: vi.fn(),
  recordPayment: vi.fn(),
  writeOffInvoice: vi.fn(),
  getTmsSettings: vi.fn(async () => ({ factorFeeBps: 200 })),
  listShipmentsByNumber: vi.fn(async () => []),
  listArPayments: vi.fn(async (): Promise<ArPaymentRecord[]> => [
    { id: 'p1', customerId: 'c1', kind: 'PAYMENT', receivedAt: `${ym}-02T12:00:00.000Z`, method: 'ACH', reference: 'ACH-77',
      amountCents: 120_000, appliedCents: 120_000, unappliedCents: 0, applications: [{ invoiceId: '14096', amountCents: 120_000 }], createdBy: 'ryne@bcatcorp.com' },
    { id: 'p2', customerId: 'c1', kind: 'PAYMENT', receivedAt: '2020-01-02T12:00:00.000Z', method: 'CHECK', reference: 'old',
      amountCents: 5_000, appliedCents: 5_000, unappliedCents: 0, applications: [], createdBy: 'aljex-import' },
  ]),
  listInvoicesByMonth: vi.fn(async (m: string): Promise<InvoiceRecord[]> => (m === ym
    ? [{ id: '14096', status: 'PAID', paidAt: `${ym}-02T12:00:00.000Z`, totalCents: 120_000, customerId: 'c1' } as InvoiceRecord]
    : [])),
}))
vi.mock('@/lib/paymentsClient', () => ({
  listAljexMemoRows: vi.fn(async () => [{
    id: 'aljex:memo:12002', pro: '12002', kind: 'MEMO_CRED',
    fields: { c5: { h: 'Customer Name', v: 'TANAGER LOGISTICS' }, c13: { h: 'Reference #', v: '11782' }, c15: { h: 'Invoice Date', v: '11/05/25' }, c123: { h: 'Invoice Amount', v: '-50.00' } },
  }]),
}))
vi.mock('@/hooks/useOpenInvoices', () => ({
  useOpenInvoices: () => ({
    invoices: [
      { id: '14200', number: '14200', shipmentNumber: '14200', customerId: 'c1', customerName: 'TANAGER LOGISTICS', status: 'ISSUED',
        invoiceDate: '2026-10-01', dueAt: '2026-10-31', totalCents: 50_000, paidCents: 0, balanceCents: 50_000 },
      { id: '14201', number: '14201', shipmentNumber: '14201', customerId: 'c1', customerName: 'TANAGER LOGISTICS', status: 'ISSUED',
        invoiceDate: '2026-10-02', dueAt: '2026-11-01', totalCents: 30_000, paidCents: 0, balanceCents: 30_000, factored: true },
      { id: '15000', number: '15000', shipmentNumber: '15000', customerId: 'c2', customerName: 'BETA FREIGHT', status: 'ISSUED',
        invoiceDate: '2026-10-03', dueAt: '2026-11-02', totalCents: 20_000, paidCents: 0, balanceCents: 20_000 },
      { id: '15001', number: '15001', shipmentNumber: '15001', customerId: 'c2', customerName: 'BETA FREIGHT', status: 'ISSUED',
        invoiceDate: '2026-09-20', dueAt: '2026-10-20', totalCents: 10_000, paidCents: 0, balanceCents: 10_000 },
    ],
    loading: false, refresh: async () => {},
  }),
}))
vi.mock('@/hooks/useCustomerPaymentFacts', () => ({
  useCustomerPaymentFacts: () => ({ linesByInvoice: new Map(), daysToPayByCustomer: new Map([['c1', { averageDays: 41.6, count: 12 }]]), loading: false }),
}))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [{ id: 'c1', name: 'TANAGER LOGISTICS' }, { id: 'c2', name: 'BETA FREIGHT' }] }) }))
vi.mock('@/features/tms/useOwnershipDivisions', () => ({ useOwnershipDivisions: () => ({ divisions: [] }) }))
vi.mock('@/hooks/useCustomerAr', () => ({ useCustomerAr: () => ({ openCents: 0, unappliedCents: 0, refresh: async () => {} }) }))
vi.mock('@/features/ar/components/ReceivePaymentDialog', () => ({
  ReceivePaymentDialog: (p: { customerId: string; invoiceIds?: string[] }) => <p>Record payment for {p.customerId}: {(p.invoiceIds ?? []).join(',')}</p>,
}))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'ryne@bcatcorp.com', groups: ['ADMIN'] }) }))

import { recordPayment, writeOffInvoice } from '@/lib/apiClient'
import { PaymentsReceivedPage } from './PaymentsReceivedPage'

describe('Payments Received page', () => {
  it('opens on Outstanding as one table with a Type column; factored ticks pre-fill at 98% and get their own OTR bar', async () => {
    render(<MemoryRouter><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    // One flat table: no sections, no per-customer blocks; the Type column says how each was invoiced.
    expect(within(out).queryByTestId('outstanding-section-manual')).toBeNull()
    expect(within(out).queryByTestId('outstanding-group')).toBeNull()
    expect(within(out).getAllByText('TANAGER LOGISTICS').length).toBeGreaterThan(0)
    expect(within(out).getAllByText('Manual').length).toBeGreaterThan(0)
    expect(within(out).getAllByText('Factored (OTR)').length).toBeGreaterThan(0)
    fireEvent.click(within(out).getByLabelText('Select 14200'))
    expect(within(out).getByTestId('receive-bar')).toBeTruthy()
    expect((within(out).getByLabelText('Amount paid on 14200') as HTMLInputElement).value).toBe('500.00')
    fireEvent.click(within(out).getByLabelText('Select 14201'))
    expect((within(out).getByLabelText('Amount paid on 14201') as HTMLInputElement).value).toBe('294.00')
    // Manual and Factored are never received together: two bars, each acting on its own type only.
    expect(within(out).getByTestId('receive-bar')).toBeTruthy()
    const factoredBar = within(out).getByTestId('receive-bar-factored')
    fireEvent.change(within(factoredBar).getByLabelText('Factored (OTR) OTR remittance or ACH reference'), { target: { value: 'OTR-9' } })
    fireEvent.click(within(factoredBar).getByTestId('receive-payments'))
    expect((await screen.findByTestId('receive-fee-summary')).textContent).toBe('Received $294.00 · OTR fee 2% $6.00 · Invoice total $300.00')
  })

  it('the Manual / Factored chips count and filter the table; the summary follows what is shown', async () => {
    render(<MemoryRouter><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    expect(within(out).getByTestId('chip-manual').textContent).toBe('Manual 3')
    expect(within(out).getByTestId('chip-factored').textContent).toBe('Factored (OTR) 1')
    await waitFor(() => expect(within(out).getByTestId('outstanding-summary').textContent).toContain('4 invoices'))
    fireEvent.click(within(out).getByTestId('chip-factored'))
    await waitFor(() => expect(within(out).queryByLabelText('Select 14200')).toBeNull())
    expect(within(out).getByLabelText('Select 14201')).toBeTruthy()
    expect(within(out).getByTestId('outstanding-summary').textContent).toContain('1 invoice')
    fireEvent.click(within(out).getByTestId('chip-factored'))
    await waitFor(() => expect(within(out).getByLabelText('Select 14200')).toBeTruthy())
  })

  it('"In full" accepts a short pay as paid in full: the payment posts at what was received and the rest is closed as a short-pay adjustment', async () => {
    vi.mocked(recordPayment).mockResolvedValue({ payment: {}, invoices: [], duplicate: false } as never)
    vi.mocked(writeOffInvoice).mockResolvedValue({ payment: {}, invoices: [], duplicate: false } as never)
    render(<MemoryRouter><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    fireEvent.click(within(out).getByLabelText('Select 14200'))
    fireEvent.change(within(out).getByLabelText('Amount paid on 14200'), { target: { value: '499.00' } })
    const bar = within(out).getByTestId('receive-bar')
    // Short, not accepted: the rest would stay open.
    fireEvent.change(within(bar).getByLabelText('Manual Check number'), { target: { value: '1042' } })
    fireEvent.click(within(out).getByLabelText('Accept 14200 as paid in full'))
    fireEvent.click(within(bar).getByTestId('receive-payments'))
    expect((await screen.findByTestId('receive-fee-summary')).textContent).toContain('accepted as paid in full (short $1.00)')
    fireEvent.click(screen.getByTestId('receive-confirm'))
    await waitFor(() => expect(writeOffInvoice).toHaveBeenCalledTimes(1))
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 49_900, applications: [{ invoiceId: '14200', amountCents: 49_900 }] }))
    expect(vi.mocked(recordPayment).mock.calls[0][0]).not.toHaveProperty('acceptOverage')
    expect(writeOffInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: '14200', amountCents: 100, reason: 'Short pay accepted as paid in full' }))
  })

  it('"In full" on an overpay posts the extra as accepted, never as credit, and writes nothing off', async () => {
    vi.mocked(recordPayment).mockClear()
    vi.mocked(writeOffInvoice).mockClear()
    vi.mocked(recordPayment).mockResolvedValue({ payment: {}, invoices: [], duplicate: false } as never)
    render(<MemoryRouter><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    fireEvent.click(within(out).getByLabelText('Select 14200'))
    fireEvent.change(within(out).getByLabelText('Amount paid on 14200'), { target: { value: '502.00' } })
    const bar = within(out).getByTestId('receive-bar')
    fireEvent.change(within(bar).getByLabelText('Manual Check number'), { target: { value: '1043' } })
    // Accepted as entered by default: no blocking error, no ticking.
    fireEvent.click(within(bar).getByTestId('receive-payments'))
    expect((await screen.findByTestId('receive-fee-summary')).textContent).toContain('accepted as paid in full (over $2.00)')
    fireEvent.click(screen.getByTestId('receive-confirm'))
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1))
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: 50_200, acceptOverage: true, overageReason: 'Overpay accepted as paid in full', applications: [{ invoiceId: '14200', amountCents: 50_000 }],
    }))
    expect(writeOffInvoice).not.toHaveBeenCalled()
  })

  it('a check is one customer: manual invoices from two customers cannot be received together', async () => {
    render(<MemoryRouter><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    fireEvent.click(within(out).getByLabelText('Select 14200'))
    fireEvent.click(within(out).getByLabelText('Select 15000'))
    expect(within(out).getByTestId('receive-mixed-customers').textContent).toContain('belong to 2 customers')
    expect((within(within(out).getByTestId('receive-bar')).getByTestId('receive-payments') as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists this month by default and ties "Collected this month" to the card computation', async () => {
    render(<MemoryRouter initialEntries={['/tms/payments-received?view=payments']}><PaymentsReceivedPage /></MemoryRouter>)
    const totals = await screen.findByTestId('payments-received-totals')
    await waitFor(() => expect(within(totals).getAllByText('$1,200.00').length).toBeGreaterThan(0))
    expect(within(totals).getByText('Collected this month')).toBeTruthy()
    // One row: the 2020 check and the 2025 Aljex memo fall outside the default range (this month).
    expect(await screen.findByText('1 rows')).toBeTruthy()
    expect(within(totals).getByText('Payments · this month')).toBeTruthy()
  })

  it('opens Record payment from the link other screens use, with the customer and invoices picked', async () => {
    render(<MemoryRouter initialEntries={['/tms/payments-received?record=1&customer=c1&invoice=14096&invoice=14097']}><PaymentsReceivedPage /></MemoryRouter>)
    expect(await screen.findByText('Record payment for c1: 14096,14097')).toBeTruthy()
  })

  it('works on one customer: ?customer= shows only theirs, with a chip and the customer bar', async () => {
    render(<MemoryRouter initialEntries={['/tms/payments-received?customer=c2']}><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    expect(within(out).queryByText('TANAGER LOGISTICS')).toBeNull()
    expect(within(out).getAllByText('BETA FREIGHT').length).toBeGreaterThan(0)
    expect(screen.getByTestId('customer-search-selected').textContent).toContain('BETA FREIGHT')
    expect(within(screen.getByTestId('one-customer-bar')).getByText(/2 open invoices · \$300\.00 open/)).toBeTruthy()
  })

  it('searching a customer and picking one narrows Outstanding; the × brings everyone back', async () => {
    render(<MemoryRouter><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    expect(within(out).getAllByText('TANAGER LOGISTICS').length).toBeGreaterThan(0)
    const box = screen.getByRole('combobox', { name: 'Search customers' })
    fireEvent.change(box, { target: { value: 'beta' } })
    fireEvent.click(await screen.findByText('BETA FREIGHT', { selector: 'span' }))
    await waitFor(() => expect(within(out).queryByText('TANAGER LOGISTICS')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Show all customers' }))
    await waitFor(() => expect(within(out).getAllByText('TANAGER LOGISTICS').length).toBeGreaterThan(0))
  })

  it('searches invoice #, PRO and PO inside Outstanding', async () => {
    render(<MemoryRouter><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    fireEvent.change(screen.getByLabelText('Search invoice, PRO or PO'), { target: { value: '15001' } })
    await waitFor(() => expect(within(out).queryByLabelText('Select 14200')).toBeNull())
    expect(within(out).getAllByLabelText('Select 15001').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText('Search invoice, PRO or PO'), { target: { value: 'nothing-like-it' } })
    expect(await within(out).findByText(/No open invoices match/)).toBeTruthy()
  })

  it('Select all open ticks every open invoice for the customer; a check is applied oldest first', async () => {
    render(<MemoryRouter initialEntries={['/tms/payments-received?customer=c2']}><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    fireEvent.click(within(out).getByTestId('select-all-customer'))
    expect((within(out).getAllByLabelText('Amount paid on 15000')[0] as HTMLInputElement).value).toBe('200.00')
    expect((within(out).getAllByLabelText('Amount paid on 15001')[0] as HTMLInputElement).value).toBe('100.00')
    fireEvent.click(within(out).getByTestId('select-all-customer'))
    expect(within(out).queryByTestId('receive-bar')).toBeNull()
    fireEvent.change(within(out).getByLabelText('Check amount'), { target: { value: '150' } })
    fireEvent.click(within(out).getByTestId('apply-oldest-first'))
    // 15001 is the older invoice: it takes its full $100, 15000 gets the other $50.
    expect((within(out).getAllByLabelText('Amount paid on 15001')[0] as HTMLInputElement).value).toBe('100.00')
    expect((within(out).getAllByLabelText('Amount paid on 15000')[0] as HTMLInputElement).value).toBe('50.00')
    expect(within(out).getByTestId('receive-bar')).toBeTruthy()
  })

  it('asks for the check amount before applying oldest first', async () => {
    render(<MemoryRouter initialEntries={['/tms/payments-received?customer=c2']}><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    fireEvent.click(within(out).getByTestId('apply-oldest-first'))
    expect(within(out).getByRole('alert').textContent).toBe('Enter the check amount first.')
  })
})
