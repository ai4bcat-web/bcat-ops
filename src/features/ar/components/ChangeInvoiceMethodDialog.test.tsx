// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { setInvoiceMethod } = vi.hoisted(() => ({ setInvoiceMethod: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ setInvoiceMethod, graphqlErrorText: (err: unknown) => String((err as Error)?.message ?? err) }))
const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { ChangeInvoiceMethodDialog } from './ChangeInvoiceMethodDialog'
import type { CustomerRecord, InvoiceRecord } from '@/types/tms'

const invoice = {
  id: '14916', number: '14916', status: 'ISSUED', customerId: 'apt', customerName: 'APT INC', factored: true, factoringItemId: '14916',
  sentCount: 0, paidCents: 0, writtenOffCents: 0,
} as unknown as InvoiceRecord
const customer = { id: 'apt', name: 'APT INC', billingMethod: 'MANUAL', apEmail: 'logistics@aptransport.com' } as unknown as CustomerRecord

describe('ChangeInvoiceMethodDialog', () => {
  beforeEach(() => { setInvoiceMethod.mockReset(); toast.success.mockReset(); toast.warning.mockReset() })

  it('offers the other method, follows the customer by default, and says nothing is sent', async () => {
    const onChanged = vi.fn()
    const onClose = vi.fn()
    setInvoiceMethod.mockResolvedValue({ invoice: { ...invoice, factored: false }, changed: true, customerChanged: false, from: 'FACTOR', to: 'MANUAL', warnings: [] })
    render(<ChangeInvoiceMethodDialog invoice={invoice} customer={customer} factoringRow={{ status: 'NEED_TO_FACTOR' }} onClose={onClose} onChanged={onChanged} />)
    expect(screen.getByTestId('change-method-effect').textContent).toMatch(/leaves the OTR queue/)
    expect(screen.getByTestId('change-method-effect').textContent).toMatch(/Nothing is sent/)
    fireEvent.click(screen.getByTestId('change-method-save'))
    await waitFor(() => expect(setInvoiceMethod).toHaveBeenCalledWith({ invoiceId: '14916', method: 'MANUAL', scope: 'customer' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  it('sends "this invoice only" and surfaces the server warnings', async () => {
    setInvoiceMethod.mockResolvedValue({ invoice, changed: true, customerChanged: false, from: 'FACTOR', to: 'MANUAL', warnings: ['No remit-to is set for this division'] })
    render(<ChangeInvoiceMethodDialog invoice={invoice} customer={customer} factoringRow={null} onClose={vi.fn()} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/This invoice only/))
    fireEvent.click(screen.getByTestId('change-method-save'))
    await waitFor(() => expect(setInvoiceMethod).toHaveBeenCalledWith({ invoiceId: '14916', method: 'MANUAL', scope: 'invoice' }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('No remit-to is set for this division'))
  })

  it('warns when switching to manual for a customer with no AP e-mail', () => {
    render(<ChangeInvoiceMethodDialog invoice={invoice} customer={{ ...customer, apEmail: null } as unknown as CustomerRecord} factoringRow={null} onClose={vi.fn()} onChanged={vi.fn()} />)
    expect(screen.getByText(/no AP e-mail on file/)).toBeTruthy()
  })

  it('explains why an invoice already with OTR cannot change', () => {
    render(<ChangeInvoiceMethodDialog invoice={invoice} customer={customer} factoringRow={{ status: 'PENDING_WITH_OTR', otrInvoiceId: '26170636' }} onClose={vi.fn()} onChanged={vi.fn()} />)
    expect(screen.queryByTestId('change-method-body')).toBeNull()
    expect(screen.getByText(/already with OTR/)).toBeTruthy()
  })
})
