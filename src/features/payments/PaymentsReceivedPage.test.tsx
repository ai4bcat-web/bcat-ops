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

import { PaymentsReceivedPage } from './PaymentsReceivedPage'

describe('Payments Received page', () => {
  it('opens on Outstanding: Manually invoiced and Factored (OTR), factored ticks pre-fill at 98%', async () => {
    render(<MemoryRouter><PaymentsReceivedPage /></MemoryRouter>)
    const out = await screen.findByTestId('payments-outstanding')
    const manual = within(out).getByTestId('outstanding-section-manual')
    const factored = within(out).getByTestId('outstanding-section-factored')
    expect(within(manual).getAllByText('TANAGER LOGISTICS').length).toBeGreaterThan(0)
    expect(within(manual).getAllByTestId('outstanding-days-to-pay').map((e) => e.textContent)).toContain('No terms · pays in 42 days avg')
    fireEvent.click(within(manual).getAllByLabelText('Select 14200')[0])
    expect(within(manual).getByTestId('receive-bar')).toBeTruthy()
    expect((within(manual).getAllByLabelText('Amount paid on 14200')[0] as HTMLInputElement).value).toBe('500.00')
    fireEvent.click(within(factored).getAllByLabelText('Select 14201')[0])
    expect((within(factored).getAllByLabelText('Amount paid on 14201')[0] as HTMLInputElement).value).toBe('294.00')
    fireEvent.change(within(factored).getByLabelText('OTR remittance or ACH reference'), { target: { value: 'OTR-9' } })
    fireEvent.click(within(within(factored).getByTestId('receive-bar-factored')).getByTestId('receive-payments'))
    expect((await screen.findByTestId('receive-fee-summary')).textContent).toBe('Received $294.00 · OTR fee 2% $6.00 · Invoice total $300.00')
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

  it('works on one customer: ?customer= shows only theirs, in both sections, with a chip and the customer bar', async () => {
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
    expect(await screen.findByTestId('outstanding-no-match')).toBeTruthy()
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
