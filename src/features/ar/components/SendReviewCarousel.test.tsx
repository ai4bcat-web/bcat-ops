// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CustomerRecord, InvoiceRecord } from '@/types/tms'

const { sendInvoice, sendToFactor } = vi.hoisted(() => ({ sendInvoice: vi.fn(), sendToFactor: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  getInvoicePdfUrl: () => Promise.resolve('blob:pdf'),
  getTmsSettings: () => Promise.resolve({ invoiceAlwaysCopyEmails: ['invoices@bcatcorp.com'] }),
  graphqlErrorText: (e: unknown) => String(e),
  sendInvoice,
  sendToFactor,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { SendReviewCarousel } from './SendReviewCarousel'

const inv = (id: string, customerId: string): InvoiceRecord => ({
  id, number: id, orderId: `o-${id}`, shipmentId: `s-${id}`, shipmentNumber: id, customerId, customerName: customerId,
  status: 'ISSUED', invoiceDate: '2026-11-12', issuedAt: '2026-11-12T12:00:00Z', issuedBy: 'x', dueAt: '2026-12-12', termsDays: 30,
  invoiceMonth: '2026-11', subtotalCents: 175_000, totalCents: 175_000, paidCents: 0, writtenOffCents: 0, balanceCents: 175_000,
  createdBy: 'x', updatedBy: 'x', version: 1, pdfKey: 'invoices/x.pdf',
  references: [{ code: 'PO', value: 'FR-113188-3', level: 'ORDER', visibility: 'CUSTOMER' }],
})
const customers = new Map<string, CustomerRecord>([
  ['royal', { id: 'royal', name: 'Royal', apEmail: 'ap@royal.test', billingMethod: 'MANUAL' } as CustomerRecord],
  ['tql', { id: 'tql', name: 'TQL', billingMethod: 'FACTOR' } as CustomerRecord],
])

describe('SendReviewCarousel', () => {
  it('pages through the batch showing the whole e-mail, and sends each the right way', async () => {
    sendInvoice.mockResolvedValue({ emailStatus: 'SENT', to: ['ap@royal.test'] })
    sendToFactor.mockResolvedValue({})
    render(<MemoryRouter><SendReviewCarousel invoices={[inv('20027', 'royal'), inv('20028', 'tql')]} customerById={customers}
      shipmentsById={new Map()} onClose={vi.fn()} onDone={vi.fn()} /></MemoryRouter>)
    expect(screen.getByLabelText('Page').textContent).toBe('1 of 2')
    expect(screen.getByLabelText('Invoice to').textContent).toBe('ap@royal.test')
    await waitFor(() => expect(screen.getByLabelText('Invoice cc').textContent).toBe('invoices@bcatcorp.com'))
    expect(screen.getByLabelText('Invoice subject').textContent).toBe('Invoice for Pro # 20027 Attached from BCAT Logistics Corporation')
    expect(screen.getByLabelText('Invoice attachment').textContent).toBe('Invoice 20027 FR-113188-3.pdf')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByLabelText('Page').textContent).toBe('2 of 2')
    expect(screen.getByLabelText('Goes to OTR')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send invoices' }))
    await waitFor(() => expect(screen.getAllByLabelText('Send results').length).toBeGreaterThan(0))
    expect(sendInvoice).toHaveBeenCalledWith({ invoiceId: '20027' })
    expect(sendToFactor).toHaveBeenCalledWith({ invoiceId: '20028' })
  })
})
