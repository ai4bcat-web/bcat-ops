// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LoadReviewDocuments } from './LoadReviewDocuments'

const mocks = vi.hoisted(() => ({
  bundle: vi.fn(), docs: vi.fn(), prepare: vi.fn(), put: vi.fn(), commit: vi.fn(), voidDoc: vi.fn(), url: vi.fn(),
}))

vi.mock('@/lib/apiClient', () => ({
  getShipmentBundle: mocks.bundle,
  getTmsSettings: vi.fn(async () => ({ defaultRequiredDocs: ['BOL', 'POD', 'LUMPER_RECEIPT'] })),
  listShipmentDocuments: mocks.docs,
  getShipmentDocumentUrl: mocks.url,
  prepareDocumentUpload: mocks.prepare,
  putPresignedFile: mocks.put,
  commitDocument: mocks.commit,
  voidDocument: mocks.voidDoc,
}))
vi.mock('@/lib/driverSubmissionsClient', () => ({ getDriverDocUrl: vi.fn(async () => 'https://example.com/driver') }))
vi.mock('@/lib/podDownload', () => ({ downloadPodAsPdf: vi.fn() }))
vi.mock('@/hooks/useDirectory', () => ({ useDirectory: () => ({ customers: [{ id: 'c-1', requiredDocsForInvoice: [] }] }) }))

const bundle = {
  shipment: { id: 'shp-1', customerId: 'c-1', legacyImported: false },
  orders: [{ id: 'o-1', customerId: 'c-1', updatedAt: 'u' }],
  loads: [{ id: 'load-1', orderId: 'o-1' }],
  loadCarriers: [],
  charges: [],
  financials: [],
  documents: [],
}
const pod = {
  id: 'd-pod', shipmentId: 'shp-1', orderId: 'o-1', loadId: null, loadCarrierId: null, type: 'POD', name: 'pod-signed.pdf', s3Key: 'k/pod',
  contentType: 'application/pdf', sizeBytes: 2048, source: 'UPLOAD', audience: 'ALL', status: 'ACTIVE', version: 1,
  uploadedBy: 'arcie@bcatcorp.com', uploadedAt: '2026-11-11T10:00:00Z',
}
const pdf = () => new File(['x'], 'bol.pdf', { type: 'application/pdf' })

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.bundle.mockResolvedValue(bundle)
  mocks.docs.mockResolvedValue([pod])
  mocks.url.mockResolvedValue('https://example.com/doc')
  mocks.prepare.mockResolvedValue({ uploadUrl: 'https://s3/put', documentId: 'sdoc-new', s3Key: 'shipment-docs/shp-1/sdoc-new-bol.pdf' })
  mocks.put.mockResolvedValue(undefined)
  mocks.commit.mockResolvedValue({})
  mocks.voidDoc.mockResolvedValue({})
})

const pick = (file: File) => fireEvent.change(screen.getByLabelText('Document file'), { target: { files: [file] } })

describe('LoadReviewDocuments', () => {
  it('lists what is on file for a required type and marks the missing one with an Upload button', async () => {
    render(<LoadReviewDocuments shipmentId="shp-1" onChanged={vi.fn(async () => {})} />)
    expect(await screen.findByText('pod-signed.pdf')).toBeTruthy()
    expect(screen.getByText('Missing')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Upload lumper receipt/i })).toBeTruthy()
    // A BOL is optional (Ryne 2026-11-12): not listed as required even when the org default names it.
    expect(screen.queryByRole('button', { name: /Upload bill of lading/i })).toBeNull()
    expect(screen.getAllByRole('button', { name: /Replace/ })).toHaveLength(1)
  })

  it('uploads the missing type, then tells the drawer to re-run the review', async () => {
    const onChanged = vi.fn(async () => {})
    render(<LoadReviewDocuments shipmentId="shp-1" onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: /Upload lumper receipt/i }))
    pick(pdf())
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 'shp-1', type: 'LUMPER_RECEIPT', name: 'bol.pdf' }))
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ type: 'LUMPER_RECEIPT', orderId: 'o-1' }))
    expect(mocks.voidDoc).not.toHaveBeenCalled()
  })

  it('replace files the new document first, then voids the old one in the same section', async () => {
    const onChanged = vi.fn(async () => {})
    render(<LoadReviewDocuments shipmentId="shp-1" onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: /Replace/ }))
    pick(pdf())
    fireEvent.click(screen.getAllByRole('button', { name: 'Replace' }).at(-1)!)
    await waitFor(() => expect(mocks.voidDoc).toHaveBeenCalledTimes(1))
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ type: 'POD' }))
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ type: 'POD', orderId: 'o-1' }))
    expect(mocks.voidDoc).toHaveBeenCalledWith({ documentId: 'd-pod', reason: 'Replaced by bol.pdf' })
    expect(mocks.commit.mock.invocationCallOrder[0]).toBeLessThan(mocks.voidDoc.mock.invocationCallOrder[0])
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('keeps the new file and says so when the old one cannot be voided', async () => {
    mocks.voidDoc.mockRejectedValue(new Error('Forbidden: VOID_DOCUMENT requires owner, ADMIN, or the person who filed the document'))
    const onChanged = vi.fn(async () => {})
    render(<LoadReviewDocuments shipmentId="shp-1" onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: /Replace/ }))
    pick(pdf())
    fireEvent.click(screen.getAllByRole('button', { name: 'Replace' }).at(-1)!)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(mocks.commit).toHaveBeenCalledTimes(1)
  })

  it('offers nothing to change once the load is released', async () => {
    render(<LoadReviewDocuments shipmentId="shp-1" readOnly onChanged={vi.fn(async () => {})} />)
    expect(await screen.findByText('pod-signed.pdf')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Replace|Upload/ })).toBeNull()
  })
})
