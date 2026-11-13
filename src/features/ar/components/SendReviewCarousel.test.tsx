// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CustomerRecord, InvoiceRecord } from '@/types/tms'

const { sendInvoice, sendToFactor, getInvoiceAttachmentPlans } = vi.hoisted(() => ({ sendInvoice: vi.fn(), sendToFactor: vi.fn(), getInvoiceAttachmentPlans: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  getInvoicePdfUrl: () => Promise.resolve('blob:pdf'),
  getTmsSettings: () => Promise.resolve({ invoiceAlwaysCopyEmails: ['invoices@bcatcorp.com'] }),
  graphqlErrorText: (e: unknown) => String(e),
  sendInvoice,
  sendToFactor,
  getInvoiceAttachmentPlans,
  previewInvoicePacket: (input: { invoiceId: string }) => Promise.resolve({
    invoiceId: input.invoiceId, name: `Invoice ${input.invoiceId}.pdf`, url: 'blob:packet',
    pages: [{ name: `Invoice ${input.invoiceId}.pdf`, pages: 1 }, { name: 'POD.pdf', pages: 2 }], separate: [{ name: 'BOL.pdf', sizeBytes: 2048 }], error: null,
  }),
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
  ['noap', { id: 'noap', name: 'No AP Co', billingMethod: 'MANUAL' } as CustomerRecord],
])

describe('SendReviewCarousel', () => {
  it('pages through the batch showing the whole e-mail, and sends each the right way', async () => {
    sendInvoice.mockResolvedValue({ emailStatus: 'SENT', to: ['ap@royal.test'] })
    getInvoiceAttachmentPlans.mockResolvedValue([
      { invoiceId: '20027', invoicePdf: 'ATTACHED', pod: 'ATTACHED', rateCon: 'NOT_INCLUDED', count: 2, totalBytes: 2000, carrierPayFlags: [],
        items: [{ documentId: null, name: 'Invoice 20027 FR-113188-3.pdf', type: 'INVOICE_PDF', sizeBytes: 1000 }, { documentId: 'd1', name: 'POD 20027.pdf', type: 'POD', sizeBytes: 1000 }] },
      { invoiceId: '20028', invoicePdf: 'ATTACHED', pod: 'ATTACHED', rateCon: 'NOT_INCLUDED', count: 1, totalBytes: 1000, carrierPayFlags: [], items: [] },
    ])
    sendToFactor.mockResolvedValue({})
    render(<MemoryRouter><SendReviewCarousel invoices={[inv('20027', 'royal'), inv('20028', 'tql')]} customerById={customers}
      shipmentsById={new Map()} onClose={vi.fn()} onDone={vi.fn()} /></MemoryRouter>)
    expect(screen.getByLabelText('Page').textContent).toBe('1 of 2')
    expect(screen.getByLabelText('Invoice to').textContent).toBe('ap@royal.test')
    await waitFor(() => expect(screen.getByLabelText('Invoice cc').textContent).toContain('invoices@bcatcorp.com'))
    // Our own mailbox reads as an internal copy, the customer's AP address does not.
    expect(screen.getByLabelText('Invoice cc').textContent).toContain('Internal')
    expect(screen.getByLabelText('Invoice to').querySelector('.inv-email-chip-to')).toBeTruthy()
    expect(screen.getByLabelText('Email envelope').textContent).toContain('billing@bcatcorp.com')
    expect(screen.getByLabelText('Invoice subject').textContent).toBe('Invoice for Pro # 20027 Attached from BCAT Logistics Corporation')
    await waitFor(() => expect(screen.getByLabelText('Attachment list').textContent).toContain('POD 20027.pdf'))
    expect(screen.getByLabelText('Attachment list').textContent).toContain('Invoice 20027 FR-113188-3.pdf')
    expect(screen.getByLabelText('Invoice attachments').textContent).toContain('never carry a rate confirmation')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByLabelText('Page').textContent).toBe('2 of 2')
    expect(screen.getByLabelText('Goes to OTR')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send invoices' }))
    await waitFor(() => expect(screen.getAllByLabelText('Send results').length).toBeGreaterThan(0))
    expect(sendInvoice).toHaveBeenCalledWith({ invoiceId: '20027' })
    expect(sendToFactor).toHaveBeenCalledWith({ invoiceId: '20028' })
  })

  it('blocks Send while a file shows carrier pay, until it is removed from the e-mail', async () => {
    sendInvoice.mockReset()
    sendInvoice.mockResolvedValue({ emailStatus: 'SENT', to: ['ap@royal.test'] })
    getInvoiceAttachmentPlans.mockResolvedValue([
      { invoiceId: '20027', invoicePdf: 'ATTACHED', pod: 'ATTACHED', rateCon: 'NOT_INCLUDED', count: 3, totalBytes: 3000,
        items: [{ documentId: null, name: 'Invoice 20027.pdf', type: 'INVOICE_PDF', sizeBytes: 1000 }, { documentId: 'd1', name: 'POD.pdf', type: 'POD', sizeBytes: 1000 }, { documentId: 'd9', name: 'Summary.pdf', type: 'OTHER', sizeBytes: 1000 }],
        carrierPayFlags: [{ documentId: 'd9', name: 'Summary.pdf', reason: 'Carrier pay detected: shows the carrier pay amount 1,470.00', hard: false }] },
    ])
    render(<MemoryRouter><SendReviewCarousel invoices={[inv('20027', 'royal')]} customerById={customers}
      shipmentsById={new Map()} onClose={vi.fn()} onDone={vi.fn()} /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Carrier pay detected').textContent).toContain('Carrier pay detected in Summary.pdf'))
    expect((screen.getByRole('button', { name: 'Send invoices' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Summary.pdf from this e-mail' }))
    expect(screen.queryByLabelText('Carrier pay detected')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send invoices' }))
    await waitFor(() => expect(sendInvoice).toHaveBeenCalledWith({ invoiceId: '20027', excludeDocumentIds: ['d9'] }))
  })

  it('shows the invoice as one PDF with its POD pages, and the files that ride separately', async () => {
    getInvoiceAttachmentPlans.mockResolvedValue([
      { invoiceId: '20027', invoicePdf: 'ATTACHED', pod: 'ATTACHED', rateCon: 'NOT_INCLUDED', count: 2, totalBytes: 3000, carrierPayFlags: [],
        items: [{ documentId: null, name: 'Invoice 20027.pdf', type: 'INVOICE_PDF', sizeBytes: 1000 }, { documentId: 'd1', name: 'POD.pdf', type: 'POD', sizeBytes: 1000, inInvoicePdf: true }, { documentId: 'd2', name: 'BOL.pdf', type: 'BOL', sizeBytes: 1000 }] },
    ])
    render(<MemoryRouter><SendReviewCarousel invoices={[inv('20027', 'royal')]} customerById={customers}
      shipmentsById={new Map()} onClose={vi.fn()} onDone={vi.fn()} /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('What the customer receives').textContent).toContain('POD · 2 pages'))
    expect(screen.getByLabelText('What the customer receives').textContent).toContain('POD included')
    expect(screen.getByLabelText('Separate attachments').textContent).toContain('BOL.pdf')
    expect(screen.getByTitle('Invoice 20027.pdf preview').getAttribute('src')).toBe('blob:packet')
    await waitFor(() => expect(screen.getByLabelText('Attachment list').textContent).toContain('pages inside the invoice PDF'))
  })

  it('leaves an invoice that cannot go out of the send, with its reason, and sends the rest', async () => {
    sendInvoice.mockReset()
    sendInvoice.mockResolvedValue({ emailStatus: 'SENT', to: ['ap@royal.test'] })
    getInvoiceAttachmentPlans.mockResolvedValue([
      { invoiceId: '20027', invoicePdf: 'ATTACHED', pod: 'ATTACHED', rateCon: 'NOT_INCLUDED', count: 1, totalBytes: 1000, carrierPayFlags: [], items: [] },
      { invoiceId: '20030', invoicePdf: 'ATTACHED', pod: 'MISSING', rateCon: 'NOT_INCLUDED', count: 1, totalBytes: 1000, carrierPayFlags: [], items: [] },
    ])
    render(<MemoryRouter><SendReviewCarousel invoices={[inv('20027', 'royal'), inv('20030', 'noap')]} customerById={customers}
      shipmentsById={new Map()} onClose={vi.fn()} onDone={vi.fn()} /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send invoices' }).textContent).toBe('Send 1 invoice'))
    fireEvent.click(screen.getByRole('button', { name: 'Next invoice' }))
    expect(screen.getByLabelText('Cannot send').textContent).toContain('No AP e-mail on file')
    expect(screen.getByLabelText('Cannot send').textContent).toContain('No POD on file')
    fireEvent.click(screen.getByRole('button', { name: 'Send invoices' }))
    await waitFor(() => expect(screen.getAllByLabelText('Send results').length).toBeGreaterThan(0))
    expect(sendInvoice).toHaveBeenCalledTimes(1)
    expect(sendInvoice).toHaveBeenCalledWith({ invoiceId: '20027' })
    expect(screen.getAllByLabelText('Send results').map((el) => el.textContent).join(' ')).toContain('Left out: No AP e-mail on file; No POD on file')
  })
})
