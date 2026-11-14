// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MarkPaidDialog } from './MarkPaidDialog'
import type { InvoiceRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const { recordPayment } = vi.hoisted(() => ({ recordPayment: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  recordPayment,
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : 'failed'),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const inv = (id: string, number: string, customerId: string, balanceCents: number): InvoiceRecord =>
  ({ id, number, customerId, customerName: customerId.toUpperCase(), balanceCents, status: 'ISSUED' } as InvoiceRecord)

beforeEach(() => { recordPayment.mockReset(); recordPayment.mockResolvedValue({ payment: {}, invoices: [], duplicate: false }) })

describe('MarkPaidDialog', () => {
  it('requires a check # for a paper check, then posts one payment per check with partial amounts', async () => {
    const onDone = vi.fn()
    const onClose = vi.fn()
    render(<MarkPaidDialog invoices={[inv('a', '20001', 'acme', 100_00), inv('b', '20002', 'acme', 50_00)]} onClose={onClose} onDone={onDone} />)
    expect(screen.getByTestId('mark-paid-confirm')).toBeDisabled()
    expect(screen.getAllByText('Check # is required for a paper check')).toHaveLength(2)

    fireEvent.change(screen.getByTestId('mark-paid-default-ref'), { target: { value: '5521' } })
    fireEvent.change(screen.getByLabelText('Amount paid for 20002'), { target: { value: '20' } })
    expect(screen.getByText(/\$30\.00 stays open/)).toBeInTheDocument()
    expect(screen.getByTestId('mark-paid-summary')).toHaveTextContent('$120.00')
    expect(screen.getByTestId('mark-paid-summary')).toHaveTextContent('1 partial')

    fireEvent.click(screen.getByTestId('mark-paid-confirm'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(recordPayment).toHaveBeenCalledTimes(1)
    expect(recordPayment.mock.calls[0][0]).toMatchObject({
      customerId: 'acme', method: 'CHECK', reference: '5521', amountCents: 120_00,
      applications: [{ invoiceId: 'a', amountCents: 100_00 }, { invoiceId: 'b', amountCents: 20_00 }],
    })
    expect(onDone).toHaveBeenCalled()
  })

  it('keeps a row that failed, with its error, and removes the ones that posted', async () => {
    recordPayment.mockImplementation((input: { customerId: string }) =>
      input.customerId === 'bad' ? Promise.reject(new Error('Invoice changed')) : Promise.resolve({}))
    const onClose = vi.fn()
    render(<MarkPaidDialog invoices={[inv('a', '20001', 'acme', 100_00), inv('c', '20003', 'bad', 10_00)]} onClose={onClose} onDone={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Default method'), { target: { value: 'ACH' } })
    fireEvent.click(screen.getByTestId('mark-paid-confirm'))
    await waitFor(() => expect(screen.getByText('Invoice changed')).toBeInTheDocument())
    expect(screen.queryByTestId('mark-paid-row-20001')).toBeNull()
    expect(screen.getByTestId('mark-paid-row-20003')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
