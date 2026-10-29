// @vitest-environment jsdom
/** The collection queue must show missing paperwork without letting the UI bypass billing's gate. */
import '@testing-library/jest-dom/vitest'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DocumentsWorkstation } from './DocumentsWorkstation'
import { evaluateReleaseGate, releaseGateError } from '@/lib/releaseGate'
import type { ShipmentBundle, ShipmentDocumentRecord, CustomerRecord } from '@/types/tms'
import type { ShipmentRow } from '../shipmentViews'

const api = vi.hoisted(() => ({
  getShipmentBundle: vi.fn(), getShipmentDocumentUrl: vi.fn(), getTmsSettings: vi.fn(),
  readyToInvoice: vi.fn(), previewInvoice: vi.fn(),
  saveShipmentView: vi.fn(), archiveShipmentView: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ isAdmin: true, isOwner: false, user: { email: 'ops@test.com', groups: ['ADMIN'] } }) }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers }) }))
vi.mock('@/hooks/useShipments', () => ({ useShipments: () => ({ shipments: rows, loading: false, error: null, refresh: vi.fn() }) }))
vi.mock('@/hooks/useStaff', () => ({ useStaff: () => ({ me: null, nameOf: () => 'Staff' }) }))
const views: never[] = []
vi.mock('@/features/tms/useShipmentViews', () => ({ useShipmentViews: () => ({ views, refresh: vi.fn() }) }))
vi.mock('@/hooks/useDocumentReviewQueue', () => ({ useDocumentReviewQueue: () => ({ pendingCount: 3 }) }))

let customers: CustomerRecord[]
let rows: ShipmentRow[]
let bundle: ShipmentBundle
function document(type: ShipmentDocumentRecord['type'], patch: Partial<ShipmentDocumentRecord> = {}): ShipmentDocumentRecord {
  return {
    id: type, shipmentId: 'S1', orderId: 'O1', loadId: 'L1', type, name: `${type}.pdf`,
    s3Key: `shipment-docs/S1/${type}.pdf`, contentType: 'application/pdf', sizeBytes: 2048,
    source: 'GENERATED', audience: 'ALL', status: 'ACTIVE', version: 1,
    uploadedBy: 'ops@test.com', uploadedAt: '2026-10-01T15:00:00Z', createdBy: 'ops@test.com', ...patch,
  }
}
function gate() {
  return evaluateReleaseGate({
    shipment: bundle.shipment, order: bundle.orders[0], documents: bundle.documents,
    legs: [{ kind: 'OWN_ASSET', status: 'ACTIVE' }], requiredDocTypes: [],
    requiredReferenceCodes: [], openIncidentCount: 0,
  })
}
function showPage() { render(<MemoryRouter><DocumentsWorkstation /></MemoryRouter>) }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  customers = [{ id: 'C1', name: 'Acme', requiredDocsForInvoice: ['POD'] } as CustomerRecord]
  rows = [{ id: 'S1', number: 'PRO-100', status: 'DELIVERED', customerId: 'C1', customerName: 'Acme',
    docsMissing: ['POD'], deliveredAt: '2026-10-01T14:00:00Z', mode: 'FTL', source: 'MANUAL',
    createdAt: '', updatedAt: '', createdBy: '', updatedBy: '' }]
  bundle = {
    shipment: rows[0], orders: [{ id: 'O1', shipmentId: 'S1', arStatus: 'DOCS_NEEDED', references: [], updatedAt: 'order-version' }],
    loads: [{ id: 'L1', orderId: 'O1' }], loadCarriers: [], documents: [document('BOL')], charges: [], financials: [],
  } as unknown as ShipmentBundle
  api.getShipmentBundle.mockImplementation(async () => bundle)
  api.getTmsSettings.mockResolvedValue({ defaultRequiredDocs: ['TEMP_LOG'] })
  api.previewInvoice.mockImplementation(async () => ({ releaseGate: gate() }))
  api.getShipmentDocumentUrl.mockResolvedValue('https://example.test/BOL.pdf')
  api.readyToInvoice.mockImplementation(async () => {
    const result = gate()
    if (!result.ok) throw releaseGateError(result.missing)
    bundle = { ...bundle, orders: [{ ...bundle.orders[0], readyToInvoiceAt: '2026-10-01T16:00:00Z', arStatus: 'UNBILLED' }] }
    return { bundle, releaseGate: result }
  })
})
afterEach(cleanup)

describe('DocumentsWorkstation', () => {
  it('shows an outline POD and reports the gate refusal when release is attempted', async () => {
    showPage()
    const row = screen.getByTestId('doc-row-S1')
    expect(await within(row).findByTestId('chip-POD')).toHaveAttribute('data-present', 'false')
    expect(within(row).getByTestId('chip-POD')).toHaveClass('border-dashed')
    expect(within(row).getByTestId('chip-BOL')).toHaveAttribute('data-present', 'true')
    fireEvent.click(row)
    fireEvent.click(await screen.findByRole('button', { name: 'Release to billing' }))
    const refusal = await screen.findByTestId('release-refusal')
    expect(refusal).toHaveTextContent(gate().missing[0].message)
    expect(api.readyToInvoice).toHaveBeenCalledWith({ orderId: 'O1', expectedUpdatedAt: 'order-version' })
    expect(screen.getByRole('link', { name: /Carrier-upload review/ })).toHaveAttribute('href', '/tms/documents/review')
  })

  it('shows complete paperwork as solid chips and releases through the action', async () => {
    rows[0] = { ...rows[0], docsMissing: [] }
    bundle.documents.push(document('POD', { source: 'CARRIER_PORTAL', reviewStatus: 'ACCEPTED' }))
    showPage()
    expect(screen.queryByTestId('doc-row-S1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Missing documents' }))
    const row = await screen.findByTestId('doc-row-S1')
    expect(await within(row).findByTestId('chip-POD')).toHaveAttribute('data-present', 'true')
    expect(within(row).getByTestId('chip-BOL')).toHaveAttribute('data-present', 'true')
    fireEvent.click(row)
    fireEvent.click(await screen.findByRole('button', { name: 'Release to billing' }))
    expect(await screen.findByTestId('doc-released')).toHaveTextContent('Already released')
    expect(screen.queryByTestId('release-refusal')).not.toBeInTheDocument()
  })

  it('uses the customer list rather than org defaults and adds a carrier rate confirmation', async () => {
    customers[0] = { ...customers[0], requiredDocsForInvoice: ['WEIGHT_TICKET'] }
    bundle.loadCarriers = [{ id: 'LC1', loadId: 'L1', status: 'ACTIVE', rateConStatus: 'SIGNED' }] as ShipmentBundle['loadCarriers']
    showPage()
    const row = screen.getByTestId('doc-row-S1')
    expect(await within(row).findByTestId('chip-WEIGHT_TICKET')).toHaveAttribute('data-present', 'false')
    expect(within(row).getByTestId('chip-BOL')).toHaveAttribute('data-present', 'true')
    expect(within(row).getByTestId('chip-POD')).toHaveAttribute('data-present', 'false')
    expect(within(row).getByTestId('chip-RATE_CON')).toHaveAttribute('data-present', 'true')
    expect(within(row).queryByTestId('chip-TEMP_LOG')).not.toBeInTheDocument()
  })

  it('keeps a pending carrier upload missing and opens a filed document using its signed URL', async () => {
    bundle.documents.push(document('POD', { source: 'CARRIER_PORTAL', reviewStatus: 'PENDING' }))
    showPage()
    const row = screen.getByTestId('doc-row-S1')
    expect(await within(row).findByTestId('chip-POD')).toHaveAttribute('data-present', 'false')
    fireEvent.click(row)
    const list = await screen.findByTestId('doc-file-list')
    expect(list).toHaveTextContent('waiting on review')
    fireEvent.click(within(list).getAllByRole('button', { name: 'View' })[0])
    await waitFor(() => expect(api.getShipmentDocumentUrl).toHaveBeenCalledWith('shipment-docs/S1/BOL.pdf'))
    expect(await screen.findByTitle('BOL · BOL.pdf')).toHaveAttribute('src', 'https://example.test/BOL.pdf')
  })
  it('does not count complete documents as ready when the server finds another billing blocker', async () => {
    bundle.documents.push(document('POD'))
    api.previewInvoice.mockResolvedValue({ releaseGate: { ok: false, missing: [{ code: 'OPEN_EXCEPTIONS', message: 'Open exception' }] } })
    showPage()
    expect(await within(screen.getByTestId('doc-row-S1')).findByTestId('chip-POD')).toHaveAttribute('data-present', 'true')
    expect(screen.getByTestId('doc-counts')).toHaveTextContent('0 ready to release')
  })

  it('attributes a present POD to the active assignment, not a newer bounced carrier file', async () => {
    bundle.loadCarriers = [{ id: 'active', loadId: 'L1', status: 'ACTIVE' }, { id: 'bounced', loadId: 'L1', status: 'BOUNCED' }] as ShipmentBundle['loadCarriers']
    bundle.documents.push(
      document('POD', { id: 'good', loadCarrierId: 'active', source: 'UPLOAD' }),
      document('POD', { id: 'old-carrier', loadCarrierId: 'bounced', source: 'CARRIER_PORTAL', reviewStatus: 'ACCEPTED', uploadedAt: '2026-10-02T15:00:00Z' }),
    )
    showPage()
    const chip = await within(screen.getByTestId('doc-row-S1')).findByTestId('chip-POD')
    expect(chip).toHaveAttribute('data-present', 'true')
    expect(chip).toHaveTextContent('uploaded by staff')
    expect(chip).not.toHaveTextContent('sent by the carrier')
  })
})
