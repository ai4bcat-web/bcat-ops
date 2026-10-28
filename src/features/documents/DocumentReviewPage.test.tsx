// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DocumentReviewPage } from './DocumentReviewPage'
import type { ShipmentBundle, ShipmentDocumentRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const pending: ShipmentDocumentRecord[] = [{
  id: 'sdoc-1',
  shipmentId: 'S1',
  loadId: 'L1',
  loadCarrierId: 'LC1',
  // What the carrier picked on their phone — the reviewer may disagree.
  type: 'POD',
  name: 'pod-scan.pdf',
  s3Key: 'shipment-docs/S1/sdoc-1-pod-scan.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2 * 1024 * 1024,
  source: 'CARRIER_PORTAL',
  audience: 'ALL',
  status: 'ACTIVE',
  version: 1,
  reviewStatus: 'PENDING',
  uploadedBy: 'link:a1b2c3d4',
  uploadedAt: '2026-03-02T15:04:00.000Z',
  createdBy: 'link:a1b2c3d4',
}]

const bundle = {
  shipment: { id: 'S1', number: 'SHP-1001' },
  orders: [],
  loads: [{ id: 'L1', loadNumber: 'SHP-1001-1', carrierName: 'Blue Line Transport' }],
  loadCarriers: [{ id: 'LC1', carrierName: 'Blue Line Transport' }],
  charges: [],
  financials: [],
  documents: [],
} as unknown as ShipmentBundle

const { listDocumentReviewQueue, getShipmentBundle, reviewDocument } = vi.hoisted(() => ({
  listDocumentReviewQueue: vi.fn(),
  getShipmentBundle: vi.fn(),
  reviewDocument: vi.fn(),
}))

vi.mock('@/lib/apiClient', () => ({
  listDocumentReviewQueue,
  getShipmentBundle,
  getShipmentDocumentUrl: vi.fn(async () => 'https://example.test/pod-scan.pdf'),
  reviewDocument,
}))

beforeEach(() => {
  listDocumentReviewQueue.mockReset().mockResolvedValue(pending)
  getShipmentBundle.mockReset().mockResolvedValue(bundle)
  reviewDocument.mockReset().mockResolvedValue({ bundle, document: pending[0] })
})

function renderPage() {
  render(<MemoryRouter><DocumentReviewPage /></MemoryRouter>)
}

describe('DocumentReviewPage', () => {
  it('lists a pending upload with the type the carrier claimed and who sent it', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByText('pod-scan.pdf')).toBeTruthy())
    expect(screen.getByText('Proof of delivery')).toBeTruthy()
    expect(screen.getByText('2.0 MB')).toBeTruthy()
    // The load number and the carrier come from the shipment bundle, not the document row.
    await waitFor(() => expect(screen.getByText('SHP-1001-1')).toBeTruthy())
    expect(screen.getByText('Blue Line Transport')).toBeTruthy()
  })

  it('accepts with the type the reviewer confirmed, not the one the carrier chose', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('pod-scan.pdf')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Accept/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Confirmed document type'), {
      target: { value: 'LUMPER_RECEIPT' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(reviewDocument).toHaveBeenCalledTimes(1))
    expect(reviewDocument.mock.calls[0][0]).toEqual({
      documentId: 'sdoc-1',
      decision: 'ACCEPT',
      type: 'LUMPER_RECEIPT',
    })
  })

  it('refuses to reject until a note says why', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('pod-scan.pdf')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Reject/ }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Reject' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('Rejection note'), {
      target: { value: 'Page 2 is cut off' },
    })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await waitFor(() => expect(reviewDocument).toHaveBeenCalledTimes(1))
    expect(reviewDocument.mock.calls[0][0]).toEqual({
      documentId: 'sdoc-1',
      decision: 'REJECT',
      note: 'Page 2 is cut off',
    })
  })
})
