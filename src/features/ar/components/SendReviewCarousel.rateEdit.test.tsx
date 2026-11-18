// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CustomerRecord, InvoiceRecord, ShipmentBundle } from '@/types/tms'

const mocks = vi.hoisted(() => ({ bundle: vi.fn(), recalc: vi.fn(), revise: vi.fn(), plans: vi.fn(), prepare: vi.fn(), commit: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  getShipmentBundle: mocks.bundle, recalcCharges: mocks.recalc, reviseInvoice: mocks.revise,
  getInvoicePdfUrl: () => Promise.resolve('blob:pdf'),
  getTmsSettings: () => Promise.resolve({}),
  graphqlErrorText: (e: unknown) => String(e),
  sendInvoice: vi.fn(), sendToFactor: vi.fn(),
  prepareDocumentUpload: mocks.prepare, putPresignedFile: vi.fn().mockResolvedValue(undefined), commitDocument: mocks.commit, voidDocument: vi.fn(),
  getInvoiceAttachmentPlans: mocks.plans,
  previewInvoicePacket: (input: { invoiceId: string }) => Promise.resolve({ invoiceId: input.invoiceId, name: 'Invoice.pdf', url: 'blob:packet', pages: [], separate: [], error: null }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { SendReviewCarousel } from './SendReviewCarousel'

const line = (over: Record<string, unknown>) => ({
  orderId: 'o-1', loadId: 'load-1', loadCarrierId: null, label: null, calculatedBy: 'FLAT', count: 1, release: null, note: null,
  createdBy: 'x', createdAt: 't', updatedAt: 't', ...over,
})
const bundleFor = (shipmentId: string, cents: number) => ({
  shipment: { id: shipmentId, version: 2 }, orders: [{ id: `o-${shipmentId}` }], loads: [{ id: 'load-1' }], loadCarriers: [],
  documents: [{ id: `pod-${shipmentId}`, shipmentId, type: 'POD', name: `POD ${shipmentId}.pdf`, status: 'ACTIVE', uploadedBy: 'x', uploadedAt: '2026-11-18T12:00:00.000Z' }],
  charges: [line({ id: `c-${shipmentId}`, side: 'CUSTOMER', code: 'LINEHAUL', label: 'Linehaul', rateCents: cents, amountCents: cents, isRate: true, sortOrder: 0 })],
  financials: [{ id: 'load-1', frozenAt: null }],
}) as unknown as ShipmentBundle

const inv = (id: string, cents: number, over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id, number: id, orderId: `o-${id}`, shipmentId: id, shipmentNumber: id, customerId: 'royal', customerName: 'Royal',
  status: 'ISSUED', invoiceDate: '2026-11-18', issuedAt: '2026-11-18T12:00:00Z', issuedBy: 'x', dueAt: '2026-12-18', termsDays: 30,
  invoiceMonth: '2026-11', subtotalCents: cents, totalCents: cents, paidCents: 0, writtenOffCents: 0, balanceCents: cents,
  createdBy: 'x', updatedBy: 'x', version: 1, pdfKey: 'invoices/x.pdf', ...over,
} as InvoiceRecord)
const customers = new Map<string, CustomerRecord>([['royal', { id: 'royal', name: 'Royal', apEmail: 'ap@royal.test', billingMethod: 'MANUAL' } as CustomerRecord]])

const open = (invoices: InvoiceRecord[], extra: Partial<Parameters<typeof SendReviewCarousel>[0]> = {}) => render(
  <MemoryRouter><SendReviewCarousel invoices={invoices} customerById={customers} shipmentsById={new Map()} canEditAmount onClose={vi.fn()} onDone={vi.fn()} {...extra} /></MemoryRouter>,
)

beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  mocks.plans.mockResolvedValue(['100', '200'].map((id) => ({ invoiceId: id, invoicePdf: 'ATTACHED', pod: 'ATTACHED', rateCon: 'NOT_INCLUDED', count: 1, totalBytes: 1, carrierPayFlags: [], items: [] })))
  mocks.bundle.mockImplementation(async (id: string) => bundleFor(id, id === '100' ? 100_000 : 200_000))
  mocks.recalc.mockResolvedValue({})
  mocks.prepare.mockResolvedValue({ uploadUrl: 'https://s3/put', s3Key: 'shipment-docs/100/sdoc-new-new.pdf', documentId: 'sdoc-new' })
  mocks.commit.mockResolvedValue({})
})

describe('SendReviewCarousel: edit the amount before sending', () => {
  it('shows the batch total, edits one invoice in place, marks it Edited and moves the total', async () => {
    mocks.revise.mockResolvedValue({ invoice: inv('100', 125_000), revision: 1 })
    const onEdited = vi.fn()
    open([inv('100', 100_000), inv('200', 200_000)], { onEdited })
    expect(screen.getByLabelText('Batch total').textContent).toContain('$3,000.00')
    expect(screen.queryByText('Edited')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit amount of invoice 100' }))
    const amount = await screen.findByLabelText('Linehaul amount')
    fireEvent.change(amount, { target: { value: '1250' } })
    fireEvent.blur(amount)
    fireEvent.click(screen.getByRole('button', { name: 'Save amount' }))
    await waitFor(() => expect(onEdited).toHaveBeenCalledWith('100'))
    expect(mocks.recalc).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: '100', changeReason: 'Rate edited before sending' }))
    await waitFor(() => expect(screen.getByLabelText('Batch total').textContent).toContain('$3,250.00'))
    expect(screen.getByText('Edited')).toBeTruthy()
    expect(screen.getByRole('status', { name: 'Batch summary' }).textContent).toContain('2 ready')
  })

  it('does not offer the edit for someone who cannot release, a sent invoice or one already with OTR', async () => {
    open([inv('100', 100_000, { sentAt: '2026-11-18T13:00:00Z', sentCount: 1 })])
    expect(screen.queryByRole('button', { name: /Edit amount of invoice/ })).toBeNull()
    cleanup()
    open([inv('100', 100_000, { factoringItemId: 'f1' })], { factorByItemId: new Map([['f1', { id: 'f1', otrInvoiceId: '26192712' } as never]]) })
    expect(screen.queryByRole('button', { name: /Edit amount of invoice/ })).toBeNull()
    cleanup()
    open([inv('100', 100_000)], { canEditAmount: false })
    expect(screen.queryByRole('button', { name: /Edit amount of invoice/ })).toBeNull()
  })

  it('keeps the Edited mark for an amount changed earlier in the list', () => {
    open([inv('100', 100_000)], { editedIds: new Set(['100']) })
    expect(screen.getByText('Edited')).toBeTruthy()
  })

  it('arrow keys typed in the amount box do not turn the page behind it', async () => {
    open([inv('100', 100_000), inv('200', 200_000)])
    fireEvent.click(screen.getByRole('button', { name: 'Edit amount of invoice 100' }))
    const amount = await screen.findByLabelText('Linehaul amount')
    fireEvent.keyDown(amount, { key: 'ArrowRight' })
    expect(screen.getByLabelText('Page').textContent).toBe('1 of 2')
  })

  it('Replace files opens the same editor with the files, replaces a POD, and re-reads the plans and the preview', async () => {
    open([inv('100', 100_000), inv('200', 200_000)])
    await waitFor(() => expect(mocks.plans).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Replace files of invoice 100' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Replace POD 100.pdf' }))
    fireEvent.change(screen.getByLabelText('Document file'), { target: { files: [new File(['%PDF'], 'pod-new.pdf', { type: 'application/pdf' })] } })
    fireEvent.click(screen.getByRole('button', { name: /^Replace$/ }))
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: '100', type: 'POD', replacesDocumentId: 'pod-100' })))
    // The attachment plans (and so the blockers and the e-mail's attachment list) were read again.
    await waitFor(() => expect(mocks.plans.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('offers no Replace files for a sent invoice or someone who cannot release', () => {
    open([inv('100', 100_000, { sentAt: '2026-11-18T13:00:00Z', sentCount: 1 })])
    expect(screen.queryByRole('button', { name: /Replace files of invoice/ })).toBeNull()
    cleanup()
    open([inv('100', 100_000)], { canEditAmount: false })
    expect(screen.queryByRole('button', { name: /Replace files of invoice/ })).toBeNull()
  })
})
