// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InvoiceRecord, ShipmentBundle } from '@/types/tms'
import type { InvoiceAttachmentPlanRow } from '@/lib/invoiceDelivery'

const mocks = vi.hoisted(() => ({ bundle: vi.fn(), prepare: vi.fn(), put: vi.fn(), commit: vi.fn(), voidDoc: vi.fn(), plans: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  getShipmentBundle: mocks.bundle, prepareDocumentUpload: mocks.prepare, putPresignedFile: mocks.put, commitDocument: mocks.commit,
  voidDocument: mocks.voidDoc, getInvoiceAttachmentPlans: mocks.plans, graphqlErrorText: (e: unknown) => String(e),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))
import { InvoiceFilesPanel } from './InvoiceFilesPanel'

const doc = (over: Record<string, unknown>) => ({
  shipmentId: 'shp-1', orderId: 'o-1', status: 'ACTIVE', version: 1, uploadedBy: 'jenny@bcatcorp.com', uploadedAt: '2026-11-18T12:00:00.000Z',
  contentType: 'application/pdf', sizeBytes: 100, s3Key: 'k', audience: 'CUSTOMER', ...over,
})
const bundle = (documents: unknown[]) => ({ shipment: { id: 'shp-1' }, orders: [{ id: 'o-1' }], loadCarriers: [{ id: 'lc-1', status: 'ACTIVE', kind: 'CARRIER', carrierName: 'SHERIFAJ' }], loads: [], documents }) as unknown as ShipmentBundle

const invoice = (over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id: 'inv-1', number: '20073', orderId: 'o-1', shipmentId: 'shp-1', shipmentNumber: '20073', customerId: 'c', customerName: 'INTEGRITY',
  status: 'ISSUED', totalCents: 110000, paidCents: 0, writtenOffCents: 0, balanceCents: 110000, sentCount: 0, ...over,
} as InvoiceRecord)
const plan = (over: Partial<InvoiceAttachmentPlanRow> = {}) => ({ invoiceId: 'inv-1', invoicePdf: 'ATTACHED', pod: 'ATTACHED', rateCon: 'ATTACHED', count: 1, totalBytes: 1, carrierPayFlags: [], items: [], ...over }) as InvoiceAttachmentPlanRow

const DOCS = [
  doc({ id: 'pod-1', type: 'POD', name: 'POD 20073.pdf' }),
  doc({ id: 'rc-1', type: 'RATE_CON', name: 'Customer rate con.pdf' }),
  // Never shown or offered: BCAT's own rate confirmation to a carrier holds carrier pay.
  doc({ id: 'bcat-1', type: 'BCAT_RATE_CON', name: 'BCAT Rate Confirmation 20073.pdf', loadCarrierId: 'lc-1', source: 'GENERATED', audience: 'CARRIER' }),
  doc({ id: 'rc-gen', type: 'RATE_CON', name: 'Carrier e-sign rate con.pdf', loadCarrierId: 'lc-1', source: 'CARRIER_PORTAL' }),
  doc({ id: 'pod-void', type: 'POD', name: 'old voided pod.pdf', status: 'VOID' }),
  doc({ id: 'pod-sup', type: 'POD', name: 'superseded pod.pdf', status: 'SUPERSEDED' }),
]

beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  mocks.bundle.mockResolvedValue(bundle(DOCS))
  mocks.plans.mockResolvedValue([plan()])
  mocks.prepare.mockResolvedValue({ uploadUrl: 'https://s3/put', s3Key: 'shipment-docs/shp-1/sdoc-new-new.pdf', documentId: 'sdoc-new' })
  mocks.put.mockResolvedValue(undefined)
  mocks.commit.mockResolvedValue({})
})

describe('InvoiceFilesPanel', () => {
  it('lists the active POD and the customer rate confirmation only: never BCAT or carrier rate cons, nor retired files', async () => {
    render(<InvoiceFilesPanel invoice={invoice()} plan={plan()} onChanged={vi.fn()} />)
    expect(await screen.findByTestId('invoice-file-pod-1')).toBeTruthy()
    expect(screen.getByTestId('invoice-file-rc-1')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/BCAT Rate Confirmation|Carrier e-sign|old voided pod|superseded pod/)
  })

  it('Replace files the new file as a supersede, tells the page and re-reads', async () => {
    const onChanged = vi.fn()
    render(<InvoiceFilesPanel invoice={invoice()} plan={plan()} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Replace POD 20073.pdf' }))
    fireEvent.change(screen.getByLabelText('Document file'), { target: { files: [new File(['%PDF'], 'pod-new.pdf', { type: 'application/pdf' })] } })
    fireEvent.click(screen.getByRole('button', { name: /^Replace$/ }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ type: 'POD', replacesDocumentId: 'pod-1' }))
    expect(mocks.voidDoc).not.toHaveBeenCalled()
    // The shipment's files were read again so the list shows the new file.
    expect(mocks.bundle.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('offers Add when a POD or the rate confirmation is missing, with the type fixed', async () => {
    mocks.bundle.mockResolvedValue(bundle([]))
    render(<InvoiceFilesPanel invoice={invoice()} plan={plan({ pod: 'MISSING', rateCon: 'MISSING' })} onChanged={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Add pod' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add rate confirmation' }))
    expect((screen.getByLabelText('Document type') as HTMLSelectElement).value).toBe('RATE_CON')
    expect((screen.getByLabelText('Document type') as HTMLSelectElement).disabled).toBe(true)
  })

  it("does not offer the rate confirmation for a customer whose rate con is not attached to invoices, even with none on file", async () => {
    mocks.bundle.mockResolvedValue(bundle([doc({ id: 'pod-1', type: 'POD', name: 'POD 20073.pdf' })]))
    render(<InvoiceFilesPanel invoice={invoice()} plan={plan({ rateCon: 'NOT_INCLUDED' })} onChanged={vi.fn()} />)
    await screen.findByTestId('invoice-file-pod-1')
    expect(screen.queryByRole('button', { name: /rate confirmation/i })).toBeNull()
    expect(screen.getByText(/not attached to this customer's invoices/)).toBeTruthy()
  })

  it('shows the files but no Replace or Add once the invoice was sent or is with OTR', async () => {
    const { rerender } = render(<InvoiceFilesPanel invoice={invoice({ sentAt: '2026-11-18T13:00:00Z', sentCount: 1 })} plan={plan()} onChanged={vi.fn()} />)
    await screen.findByTestId('invoice-file-pod-1')
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull()
    expect(screen.getByText(/Already sent or with OTR/)).toBeTruthy()
    rerender(<InvoiceFilesPanel invoice={invoice()} factoringItem={{ status: 'PENDING_WITH_OTR', otrInvoiceId: '26192712' }} plan={plan()} onChanged={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull()
  })

  it('reads its own plan when the page did not pass one', async () => {
    render(<InvoiceFilesPanel invoice={invoice()} onChanged={vi.fn()} />)
    await screen.findByTestId('invoice-file-pod-1')
    expect(mocks.plans).toHaveBeenCalledWith(['inv-1'])
  })
})
