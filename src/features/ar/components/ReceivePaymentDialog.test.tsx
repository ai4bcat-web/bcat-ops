// @vitest-environment jsdom
/**
 * The money arithmetic on the cash-receipt form, through the real planner.
 *
 * `planPayment` is deliberately NOT mocked: the point of these tests is that what a
 * person reads before posting is what `RECORD_PAYMENT` would decide, so the dialog is
 * driven with real invoices and real credits and the footer is read back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ReceivePaymentDialog } from './ReceivePaymentDialog'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const { listInvoicesByCustomer, listArPaymentsByCustomer, recordPayment } = vi.hoisted(() => ({
  listInvoicesByCustomer: vi.fn(),
  listArPaymentsByCustomer: vi.fn(),
  recordPayment: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => ({
  listInvoicesByCustomer,
  listArPaymentsByCustomer,
  recordPayment,
  graphqlErrorText: (err: unknown) => (err instanceof Error ? err.message : 'failed'),
}))

const WHEN = { createdBy: 'ar@bcat.test', updatedBy: 'ar@bcat.test', version: 1 }

function invoice(id: string, number: string, balanceCents: number, dueAt: string): InvoiceRecord {
  return {
    id,
    number,
    orderId: `ord-${id}`,
    shipmentId: 'shp-1',
    customerId: 'cust-1',
    status: 'ISSUED',
    invoiceDate: dueAt,
    issuedAt: `${dueAt}T12:00:00.000Z`,
    issuedBy: 'ar@bcat.test',
    dueAt,
    termsDays: 30,
    invoiceMonth: dueAt.slice(0, 7),
    subtotalCents: balanceCents,
    totalCents: balanceCents,
    paidCents: 0,
    writtenOffCents: 0,
    balanceCents,
    arOpen: 'OPEN',
    ...WHEN,
  }
}

const INVOICES: InvoiceRecord[] = [
  invoice('inv-1', 'INV-000001', 100_000, '2026-01-10'),
  invoice('inv-2', 'INV-000002', 250_000, '2026-02-10'),
]

/** An unspent credit memo, and an older cheque whose reference can be typed again. */
const PAYMENTS: ArPaymentRecord[] = [
  {
    id: 'pay-credit', customerId: 'cust-1', kind: 'CREDIT_MEMO', receivedAt: '2026-01-05T12:00:00.000Z',
    reference: 'CM-9', amountCents: 25_000, appliedCents: 0, unappliedCents: 25_000, createdBy: 'ar@bcat.test',
  },
  {
    id: 'pay-old', customerId: 'cust-1', kind: 'PAYMENT', receivedAt: '2025-12-01T12:00:00.000Z',
    method: 'CHECK', reference: 'CHK-555', amountCents: 50_000, appliedCents: 50_000, unappliedCents: 0,
    createdBy: 'ar@bcat.test',
  },
]

/** The same account after that credit memo was issued by mistake and reversed. */
const PAYMENTS_AFTER_REVERSAL: ArPaymentRecord[] = [
  { ...PAYMENTS[0], reversedByPaymentId: 'pay-rev' },
  PAYMENTS[1],
  {
    id: 'pay-rev', customerId: 'cust-1', kind: 'REVERSAL', receivedAt: '2026-01-06T12:00:00.000Z',
    reversesPaymentId: 'pay-credit', amountCents: -25_000, appliedCents: 0, unappliedCents: 0,
    createdBy: 'ar@bcat.test',
  },
]

function renderDialog() {
  return render(
    <ReceivePaymentDialog customerId="cust-1" customerName="Acme Foods" onClose={vi.fn()} onDone={vi.fn()} />,
  )
}

/** Waits for the account to load, then returns the amount box. */
async function openForm(): Promise<HTMLInputElement> {
  return await screen.findByLabelText('Payment amount') as HTMLInputElement
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function total(label: string): string {
  return screen.getByLabelText(label).textContent ?? ''
}

function postButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement
}

beforeEach(() => {
  vi.clearAllMocks()
  listInvoicesByCustomer.mockResolvedValue(INVOICES)
  listArPaymentsByCustomer.mockResolvedValue(PAYMENTS)
})

describe('ReceivePaymentDialog', () => {
  it('states what a part allocation applies and what is left over', async () => {
    renderDialog()
    await openForm()

    type('Payment amount', '1000.00')
    type('Apply to invoice INV-000001', '400.00')

    await waitFor(() => expect(total('Applied total')).toBe('$400.00'))
    expect(total('From credits total')).toBe('$0.00')
    expect(total('Unapplied total')).toBe('$600.00')
    expect(postButton().disabled).toBe(false)
  })

  it('auto-allocates a cheque that matches one invoice exactly, and leaves the rest alone', async () => {
    renderDialog()
    await openForm()

    type('Payment amount', '2500.00')
    fireEvent.click(screen.getByRole('button', { name: /Auto-allocate/ }))

    await waitFor(() => expect(total('Applied total')).toBe('$2,500.00'))
    expect((screen.getByLabelText('Apply to invoice INV-000002') as HTMLInputElement).value).toBe('2500.00')
    expect((screen.getByLabelText('Apply to invoice INV-000001') as HTMLInputElement).value).toBe('')
    expect(total('Unapplied total')).toBe('$0.00')
  })

  it("refuses to post more against an invoice than it owes, and says by how much", async () => {
    renderDialog()
    await openForm()

    type('Payment amount', '2000.00')
    type('Apply to invoice INV-000001', '1500.00')

    await waitFor(() => expect(postButton().disabled).toBe(true))
    expect(screen.getByText('Invoice INV-000001 has $1,000.00 outstanding; $1,500.00 was applied')).toBeTruthy()
  })

  it('lets a credit cover part of the bill so less cash is needed', async () => {
    renderDialog()
    await openForm()

    type('Payment amount', '750.00')
    type('Use credit CM-9', '250.00')
    type('Apply to invoice INV-000001', '1000.00')

    await waitFor(() => expect(total('Applied total')).toBe('$1,000.00'))
    expect(total('From credits total')).toBe('$250.00')
    expect(total('Unapplied total')).toBe('$0.00')
    expect(postButton().disabled).toBe(false)
  })

  it('warns about a reference this customer has used before without blocking the post', async () => {
    renderDialog()
    await openForm()

    type('Payment amount', '1000.00')
    type('Apply to invoice INV-000001', '1000.00')
    type('Payment reference', 'CHK-555')

    await waitFor(() => expect(screen.getByText(/already has a payment with reference/)).toBeTruthy())
    expect(postButton().disabled).toBe(false)
  })

  it('does not offer a credit memo that has been reversed', async () => {
    listArPaymentsByCustomer.mockResolvedValue(PAYMENTS_AFTER_REVERSAL)
    renderDialog()
    await openForm()

    expect(screen.queryByLabelText('Use credit CM-9')).toBeNull()
    expect(screen.queryByText('Available credits')).toBeNull()
  })

  it('refuses a reversed credit that was typed before the reversal was read back', async () => {
    listArPaymentsByCustomer.mockResolvedValueOnce(PAYMENTS)
    const view = render(
      <ReceivePaymentDialog customerId="cust-1" invoiceId="inv-1" onClose={vi.fn()} onDone={vi.fn()} />,
    )
    await openForm()
    type('Use credit CM-9', '250.00')
    await waitFor(() => expect(total('From credits total')).toBe('$250.00'))

    // The next read of the account shows the reversal the office posted meanwhile.
    listArPaymentsByCustomer.mockResolvedValueOnce(PAYMENTS_AFTER_REVERSAL)
    view.rerender(
      <ReceivePaymentDialog customerId="cust-1" invoiceId="inv-2" onClose={vi.fn()} onDone={vi.fn()} />,
    )

    await waitFor(() => expect(screen.queryByLabelText('Use credit CM-9')).toBeNull())
    expect(screen.getByText('Credit CM-9 has been reversed; its money no longer exists')).toBeTruthy()
    expect(total('From credits total')).toBe('$0.00')
    expect(postButton().disabled).toBe(true)
  })
})
