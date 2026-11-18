// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { InvoiceRecord, ShipmentBundle } from '@/types/tms'

const mocks = vi.hoisted(() => ({ bundle: vi.fn(), recalc: vi.fn(), revise: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  getShipmentBundle: mocks.bundle, recalcCharges: mocks.recalc, reviseInvoice: mocks.revise,
  getInvoiceAttachmentPlans: () => Promise.resolve([]),
  prepareDocumentUpload: vi.fn(), putPresignedFile: vi.fn(), commitDocument: vi.fn(), voidDocument: vi.fn(),
  getInvoicePdfUrl: () => Promise.resolve('blob:pdf'),
  getTmsSettings: () => Promise.resolve({}),
  graphqlErrorText: (e: unknown) => String(e),
  renderInvoicePdf: vi.fn(),
  listInvoicesByCustomer: () => Promise.resolve([]),
  listArPaymentsByCustomer: () => Promise.resolve([]),
  previewInvoicePacket: (input: { invoiceId: string }) => Promise.resolve({ invoiceId: input.invoiceId, name: 'Invoice.pdf', url: 'blob:packet', pages: [], separate: [], error: null }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { InvoiceEditDrawer } from './InvoiceEditDrawer'

const line = (over: Record<string, unknown>) => ({
  orderId: 'o-1', loadId: 'load-1', loadCarrierId: null, label: null, calculatedBy: 'FLAT', count: 1, release: null, note: null,
  createdBy: 'x', createdAt: 't', updatedAt: 't', ...over,
})
const bundle = {
  shipment: { id: 'shp-1', version: 4 }, orders: [{ id: 'o-1' }], loads: [{ id: 'load-1' }], loadCarriers: [],
  charges: [line({ id: 'c1', side: 'CUSTOMER', code: 'LINEHAUL', label: 'Linehaul', rateCents: 110000, amountCents: 110000, isRate: true, sortOrder: 0 })],
  financials: [{ id: 'load-1', frozenAt: null }],
  documents: [{ id: 'pod-1', shipmentId: 'shp-1', type: 'POD', name: 'POD 20073.pdf', status: 'ACTIVE', orderId: 'o-1', uploadedBy: 'x', uploadedAt: '2026-11-18T12:00:00.000Z' }],
} as unknown as ShipmentBundle

const invoice = (over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id: 'inv-1', number: '20073', orderId: 'o-1', shipmentId: 'shp-1', shipmentNumber: '20073', customerId: 'c', customerName: 'INTEGRITY',
  status: 'ISSUED', invoiceDate: '2026-11-18', issuedAt: '2026-11-18T12:00:00Z', issuedBy: 'x', dueAt: '2026-12-18', termsDays: 30,
  invoiceMonth: '2026-11', subtotalCents: 110000, totalCents: 110000, paidCents: 0, writtenOffCents: 0, balanceCents: 110000,
  createdBy: 'x', updatedBy: 'x', version: 1, pdfKey: 'invoices/x.pdf', factored: true,
  lines: [{ chargeId: 'c1', code: 'LINEHAUL', label: 'Linehaul', rateCents: 110000, count: 1, amountCents: 110000 }], ...over,
} as InvoiceRecord)

const drawer = (inv: InvoiceRecord, extra: Partial<Parameters<typeof InvoiceEditDrawer>[0]> = {}) => render(
  <MemoryRouter><InvoiceEditDrawer invoice={inv} customer={undefined} shipment={undefined} factoringItem={undefined} canEdit onClose={vi.fn()} onSaved={vi.fn()} onSend={vi.fn()} {...extra} /></MemoryRouter>,
)

beforeEach(() => { cleanup(); vi.clearAllMocks(); mocks.bundle.mockResolvedValue(bundle); mocks.recalc.mockResolvedValue(bundle) })

describe('InvoiceEditDrawer: edit amounts before sending', () => {
  it('offers Edit amounts on an unsent draft and saves the new amount into the invoice', async () => {
    mocks.revise.mockResolvedValue({ invoice: invoice({ totalCents: 120000, subtotalCents: 120000, lines: [{ chargeId: 'c1', code: 'LINEHAUL', label: 'Linehaul', rateCents: 120000, count: 1, amountCents: 120000 }] }), revision: 1 })
    const onSaved = vi.fn()
    drawer(invoice(), { onSaved })
    expect(screen.queryByText(/Charges come from the shipment/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }))
    const amount = await screen.findByLabelText('Linehaul amount')
    fireEvent.change(amount, { target: { value: '1200' } })
    fireEvent.blur(amount)
    fireEvent.click(screen.getByRole('button', { name: 'Save amount' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(mocks.recalc).toHaveBeenCalledWith(expect.objectContaining({ changeReason: 'Rate edited before sending' }))
    await waitFor(() => expect(screen.queryByTestId('invoice-rate-editor')).toBeNull())
    expect(screen.getAllByText('$1,200.00').length).toBeGreaterThan(0)
  })

  it('shows the amount read-only with the way out once the invoice was sent', () => {
    drawer(invoice({ sentAt: '2026-11-18T13:00:00Z', sentCount: 1, factored: false }))
    expect(screen.queryByRole('button', { name: 'Edit amounts' })).toBeNull()
    expect(screen.getByTestId('rate-edit-block').textContent).toMatch(/already sent.*credit or debit/)
  })

  it('shows it read-only for an invoice already with OTR, and for someone who cannot edit', () => {
    drawer(invoice(), { factoringItem: { otrInvoiceId: '26192712' } as never })
    expect(screen.queryByRole('button', { name: 'Edit amounts' })).toBeNull()
    expect(screen.getByTestId('rate-edit-block').textContent).toMatch(/with OTR/)
    cleanup()
    drawer(invoice(), { canEdit: false })
    expect(screen.queryByRole('button', { name: 'Edit amounts' })).toBeNull()
  })

  it('lists the POD with Replace on a draft, and shows it read-only once the invoice was sent', async () => {
    drawer(invoice())
    expect(await screen.findByRole('button', { name: 'Replace POD 20073.pdf' })).toBeTruthy()
    cleanup()
    drawer(invoice({ sentAt: '2026-11-18T13:00:00Z', sentCount: 1, factored: false }))
    await screen.findByTestId('invoice-file-pod-1')
    expect(screen.queryByRole('button', { name: /^Replace / })).toBeNull()
  })

  it('has no Files section for someone who cannot edit', () => {
    drawer(invoice(), { canEdit: false })
    expect(screen.queryByTestId('invoice-files-panel')).toBeNull()
  })
})
