// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { changeInvoiceCustomer, getTmsSettings } = vi.hoisted(() => ({ changeInvoiceCustomer: vi.fn(), getTmsSettings: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  changeInvoiceCustomer,
  getTmsSettings,
  graphqlErrorText: (err: unknown) => String((err as Error)?.message ?? err),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ChangeInvoiceCustomerDialog } from './ChangeInvoiceCustomerDialog'
import type { CustomerRecord, InvoiceRecord } from '@/types/tms'

const invoice = {
  id: '14937', number: '14937', status: 'ISSUED', customerId: 'old', customerName: 'Old Co', shipmentId: 's1', orderId: 'o1',
  invoiceDate: '2026-11-10', dueAt: '2026-12-10', totalCents: 100_000, balanceCents: 100_000, paidCents: 0, writtenOffCents: 0,
  sentAt: '2026-11-10T12:00:00Z', sentCount: 1, factored: false,
} as unknown as InvoiceRecord
const customers = [
  { id: 'old', name: 'Old Co' },
  { id: 'new', name: 'New Co', billingMethod: 'MANUAL', paymentTermsDays: 45, apEmail: 'ap@new.co', apEmailsExtra: ['ap2@new.co'] },
] as unknown as CustomerRecord[]

describe('ChangeInvoiceCustomerDialog', () => {
  beforeEach(() => { changeInvoiceCustomer.mockReset(); getTmsSettings.mockResolvedValue({ defaultPaymentTermsDays: 30 }) })

  it('previews the new bill-to, AP e-mails, terms and due date, saves with a reason, then offers Review & send (nothing is sent)', async () => {
    const onReviewSend = vi.fn()
    changeInvoiceCustomer.mockResolvedValue({ invoice: { ...invoice, customerId: 'new', customerName: 'New Co', revision: 2 }, wholeShipment: true })
    render(<ChangeInvoiceCustomerDialog invoice={invoice} customers={customers} shipment={undefined} factoringRow={null} onClose={vi.fn()} onChanged={vi.fn()} onReviewSend={onReviewSend} />)
    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: 'new' } })
    fireEvent.click(screen.getByRole('button', { name: 'New Co' }))
    const preview = screen.getByLabelText('What changes')
    expect(preview.textContent).toContain('ap@new.co, ap2@new.co')
    expect(preview.textContent).toContain('Net 45')
    expect(preview.textContent).toContain('Rev 2')
    const save = screen.getByRole('button', { name: 'Change customer' })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Billed the wrong customer' } })
    fireEvent.click(save)
    await waitFor(() => expect(changeInvoiceCustomer).toHaveBeenCalledWith({ invoiceId: '14937', customerId: 'new', billToId: null, reason: 'Billed the wrong customer' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review and send' }))
    expect(onReviewSend).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'new' }))
  })

  it('explains why an invoice with OTR cannot be moved', () => {
    render(<ChangeInvoiceCustomerDialog invoice={invoice} customers={customers} shipment={undefined} factoringRow={{ id: 'f', otrInvoiceId: '26152964', status: 'NEED_TO_FACTOR' }} onClose={vi.fn()} onChanged={vi.fn()} onReviewSend={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toMatch(/OTR/)
  })
})
