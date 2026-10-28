// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { DocumentsSection } from './DocumentsSection'
import type {
  CustomerRecord, LoadCarrierRecord, OrderRecord, ShipmentBundle, ShipmentDocumentRecord, ShipmentLoad,
  ShipmentRecord,
} from '@/types/tms'

const listShipmentDocuments = vi.hoisted(() => vi.fn())
const readyToInvoice = vi.hoisted(() => vi.fn())
const getInvoice = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apiClient', () => ({
  listShipmentDocuments,
  readyToInvoice,
  getInvoice,
  getInvoicePdfUrl: vi.fn(async () => 'https://example.com/invoice.pdf'),
  getTmsSettings: vi.fn(async () => null),
  listDivisions: vi.fn(async () => []),
  listTrackingLinksByShipment: vi.fn(async () => []),
  listCheckCallsByLoad: vi.fn(async () => []),
  getShipmentDocumentUrl: vi.fn(async () => 'https://example.com/doc'),
  getRateConfirmUrl: vi.fn(async () => 'https://example.com/rc'),
  updateDocument: vi.fn(),
  voidDocument: vi.fn(),
  attachDriverDoc: vi.fn(),
  sendUploadLink: vi.fn(),
  revokeUploadLink: vi.fn(),
  emailDocuments: vi.fn(),
  prepareDocumentUpload: vi.fn(),
  commitDocument: vi.fn(),
  putPresignedFile: vi.fn(),
  saveGeneratedDocument: vi.fn(),
}))
// The driver store and the PDF builders are reached through modules that create an
// Amplify client or load jsPDF at import time; neither is what this test is about.
vi.mock('@/lib/driverSubmissionsClient', () => ({
  getDriverDocUrl: vi.fn(async () => 'https://example.com/driver'),
  attachDocs: vi.fn(async () => []),
}))
vi.mock('@/lib/bolPdf', () => ({ buildBolPdf: vi.fn(), bolFilename: vi.fn(() => 'bol.pdf') }))
vi.mock('@/lib/loadSummaryPdf', () => ({
  buildLoadSummaryPdf: vi.fn(), loadSummaryFilename: vi.fn(() => 'load-summary.pdf'),
}))
vi.mock('@/lib/carrierRateCon', () => ({ buildRateConPdf: vi.fn() }))
vi.mock('@/features/loads/LoadDriverDocs', () => ({
  LoadDriverDocs: ({ kind }: { kind: string }) => <div>docs:{kind}</div>,
}))
vi.mock('@/hooks/useLoadDriverDocs', () => ({
  useLoadDriverDocs: () => ({ pods: [], ratecons: [], misc: [], loading: false, error: null, refresh: vi.fn() }),
}))

const WHEN = '2026-04-03T12:00:00.000Z'

function doc(over: Partial<ShipmentDocumentRecord> & Pick<ShipmentDocumentRecord, 'id' | 'type' | 'name'>): ShipmentDocumentRecord {
  return {
    shipmentId: 'shp-1',
    s3Key: `shipment-docs/shp-1/${over.id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 2048,
    source: 'UPLOAD',
    audience: 'ALL',
    status: 'ACTIVE',
    version: 1,
    uploadedBy: 'ryne@bcatcorp.com',
    uploadedAt: WHEN,
    createdBy: 'ryne@bcatcorp.com',
    ...over,
  }
}

const DOCUMENTS: ShipmentDocumentRecord[] = [
  doc({ id: 'sdoc-pod', type: 'POD', name: 'pod-signed.pdf', orderId: 'ord-1', loadId: 'load-1' }),
  doc({ id: 'sdoc-inv', type: 'CARRIER_INVOICE', name: 'blue-sky-invoice.pdf', loadCarrierId: 'lc-1', loadId: 'load-1', source: 'CARRIER_PORTAL', reviewStatus: 'ACCEPTED' }),
  doc({ id: 'sdoc-misc', type: 'OTHER', name: 'dock-note.pdf', audience: 'INTERNAL' }),
]

function bundle(invoiceId: string | null = null): ShipmentBundle {
  const shipment: ShipmentRecord = {
    id: 'shp-1', number: 'S000001', status: 'DELIVERED', customerId: 'cust-1', customerName: 'Acme Freight',
    mode: 'FTL', source: 'MANUAL',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: WHEN, updatedAt: WHEN,
  }
  const order: OrderRecord = {
    id: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1', mode: 'FTL', arStatus: 'DOCS_NEEDED',
    invoiceId, references: [], freight: [],
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: WHEN, updatedAt: WHEN,
  }
  const load: ShipmentLoad = { id: 'load-1', orderId: 'ord-1', stops: [], status: 'DELIVERED', loadNumber: 'S000001-1', leg: 1 }
  const active: LoadCarrierRecord = {
    id: 'lc-1', loadId: 'load-1', shipmentId: 'shp-1', kind: 'CARRIER', status: 'ACTIVE', sequence: 2,
    carrierName: 'Blue Sky Trucking', dispatcherEmail: 'dispatch@bluesky.example', rateConStatus: 'SIGNED',
    createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: WHEN, updatedAt: WHEN,
  }
  const bounced: LoadCarrierRecord = {
    ...active, id: 'lc-2', status: 'BOUNCED', sequence: 1, carrierName: 'Red Hill Transit', rateConStatus: 'NOT_SENT',
  }
  return { shipment, orders: [order], loads: [load], loadCarriers: [bounced, active], charges: [], financials: [], documents: DOCUMENTS }
}

const CUSTOMER = { id: 'cust-1', name: 'Acme Freight', requiredDocsForInvoice: ['POD', 'BOL'] } as CustomerRecord

function renderSection(isAdmin = false, invoiceId: string | null = null) {
  render(
    <DocumentsSection
      bundle={bundle(invoiceId)}
      customer={CUSTOMER}
      locations={[]}
      catalog={[]}
      currentUser="ryne@bcatcorp.com"
      isAdmin={isAdmin}
      onReload={vi.fn(async () => {})}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listShipmentDocuments.mockResolvedValue(DOCUMENTS)
})

describe('DocumentsSection', () => {
  it('files every row into the section it belongs to', async () => {
    renderSection()
    const customer = await screen.findByTestId('documents-customer')
    await waitFor(() => expect(within(customer).getByText('pod-signed.pdf')).toBeTruthy())

    // The row carrying neither an order nor an assignment is the shipment's.
    expect(within(screen.getByTestId('documents-shipment')).getByText('dock-note.pdf')).toBeTruthy()
    expect(within(customer).queryByText('dock-note.pdf')).toBeNull()

    // Carrier: a block per assignment, ACTIVE first and expanded, BOUNCED collapsed —
    // so only the active block shows its rows and its rate confirmation line.
    const carrier = screen.getByTestId('documents-carrier')
    expect(within(carrier).getByText('blue-sky-invoice.pdf')).toBeTruthy()
    expect(within(carrier).getByText('Red Hill Transit')).toBeTruthy()
    expect(within(carrier).getAllByText('Rate confirmation')).toHaveLength(1)
    expect(within(carrier).getByText('signed')).toBeTruthy()
  })

  it('shows the missing required document and refuses to bill without it', async () => {
    renderSection()
    const strip = await screen.findByTestId('required-documents')

    // POD is on file against the order; the customer also asks for a BOL, which is not.
    expect(within(strip).getByText('Proof of delivery')).toBeTruthy()
    expect(within(strip).getByText('pod-signed.pdf')).toBeTruthy()
    expect(within(strip).getByText('Bill of lading')).toBeTruthy()
    expect(within(strip).getByText('missing')).toBeTruthy()
    expect(within(strip).getByText(/1 still missing: Bill of lading/)).toBeTruthy()

    const button = within(strip).getByRole('button', { name: 'Ready to invoice' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('Missing: Bill of lading')
    expect(readyToInvoice).not.toHaveBeenCalled()
  })

  it('offers the admin override only to an admin, and only with a note', async () => {
    renderSection(true)
    const strip = await screen.findByTestId('required-documents')
    expect(within(strip).getByRole('button', { name: 'Override with note' })).toBeTruthy()
  })

  it('keeps the override away from everyone else', async () => {
    renderSection()
    const strip = await screen.findByTestId('required-documents')
    expect(within(strip).queryByRole('button', { name: 'Override with note' })).toBeNull()
  })

  /**
   * The invoice is derived from the order, so it has to survive a Customer section with
   * no document rows in it — the empty-state used to swallow anything that was not a
   * `ShipmentDocument`. It is also not a document: it can be read, never edited.
   */
  it('shows the issued invoice as a derived Customer row that cannot be voided or retyped', async () => {
    listShipmentDocuments.mockResolvedValue([])
    getInvoice.mockResolvedValue({
      id: 'INV-000042', number: 'INV-000042', pdfKey: 'invoices/INV-000042.pdf', pdfVersion: 2,
      issuedAt: WHEN, status: 'ISSUED',
    })
    renderSection(true, 'INV-000042')

    const customer = await screen.findByTestId('documents-customer')
    const line = await within(customer).findByTestId('invoice-line')
    expect(line.textContent).toContain('INV-000042')
    expect(line.textContent).toContain('v2')
    expect(within(line).getByRole('button', { name: /Preview/ })).toBeTruthy()
    expect(within(line).getByRole('button', { name: /Download/ })).toBeTruthy()
    expect(within(line).queryByRole('button', { name: /Void/ })).toBeNull()
    expect(within(line).queryByRole('button', { name: /Retype/ })).toBeNull()
  })

  it('asks for no invoice at all when the order has not been billed', async () => {
    renderSection()
    await screen.findByTestId('documents-customer')
    expect(screen.queryByTestId('invoice-line')).toBeNull()
    expect(getInvoice).not.toHaveBeenCalled()
  })
})
