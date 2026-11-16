// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TrackingPodBox } from './TrackingPodBox'
import { DocumentsCard } from '@/features/shipments/form/cards/DocumentsCard'
import { emptyValues, NO_LOCKS } from '@/features/shipments/form/model'
import { makeCtx, makeForm, savedBundle } from '@/features/shipments/form/sections/ah5TestKit'
import type { ShipmentBundle } from '@/types/tms'

const api = vi.hoisted(() => ({
  getShipmentDocumentUrl: vi.fn(async () => 'https://example.invalid/doc'),
  getIntakeLoad: vi.fn(async () => null),
  attachIntakeFiles: vi.fn(async () => ({ attached: 0, available: 0 })),
  prepareDocumentUpload: vi.fn(async () => ({ uploadUrl: 'https://s3.invalid/put', documentId: 'sdoc-new', s3Key: 'shipment-docs/s/sdoc-new-pod.pdf' })),
  putPresignedFile: vi.fn(async () => undefined),
  commitDocument: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('@/features/shipments/components/BolDialog', () => ({ BolDialog: () => null }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const pdf = () => new File(['x'], 'pod.pdf', { type: 'application/pdf' })
const podDoc = (over: Record<string, unknown> = {}) => ({
  id: 'sdoc-new', name: 'pod.pdf', audience: 'ALL', status: 'ACTIVE', type: 'POD', s3Key: 'shipment-docs/s/sdoc-new-pod.pdf',
  contentType: 'application/pdf', uploadedBy: 'ann@example.invalid', uploadedAt: '2026-11-16T15:00:00.000Z', source: 'UPLOAD', ...over,
})

describe('TrackingPodBox', () => {
  it('NEED with an Upload POD button when the load has no POD', () => {
    render(<TrackingPodBox bundle={savedBundle({ documents: [] }) as ShipmentBundle} onUploaded={vi.fn()} />)
    expect(screen.getByTestId('tracking-pod').getAttribute('data-presence')).toBe('MISSING')
    expect(screen.getByTestId('tracking-pod-state').textContent).toBe('NEED')
    expect(screen.getByTestId('tracking-pod-upload').textContent).toContain('Upload POD')
  })

  it('On file, with the file listed, when a POD is on the shipment', () => {
    render(<TrackingPodBox bundle={savedBundle({ documents: [podDoc()] }) as ShipmentBundle} onUploaded={vi.fn()} />)
    expect(screen.getByTestId('tracking-pod-state').textContent).toBe('On file')
    expect(screen.getByTestId('tracking-pod-view-sdoc-new').textContent).toContain('pod.pdf')
  })

  it('uploads through the editor\'s path (presign, PUT, COMMIT_DOCUMENT type POD on the order), and the new bundle reaches the caller', async () => {
    const before = savedBundle({ documents: [] }) as ShipmentBundle
    const after = { ...before, documents: [podDoc()] } as unknown as ShipmentBundle
    api.commitDocument.mockResolvedValueOnce({ bundle: after })
    const onUploaded = vi.fn()
    render(<TrackingPodBox bundle={before} onUploaded={onUploaded} />)
    fireEvent.change(screen.getByTestId('tracking-pod-input'), { target: { files: [pdf()] } })
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(after))
    expect(api.prepareDocumentUpload).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: before.shipment.id, type: 'POD' }))
    expect(api.commitDocument).toHaveBeenCalledWith(expect.objectContaining({
      shipmentId: before.shipment.id, type: 'POD', audience: 'ALL', orderId: before.orders[0]?.id ?? null,
    }))
  })

  it('one upload: the bundle it returns shows the POD as on file in both the tracking box and the shipment editor\'s Documents', async () => {
    const before = savedBundle({ documents: [] }) as ShipmentBundle
    const after = { ...before, documents: [podDoc()] } as unknown as ShipmentBundle
    api.commitDocument.mockResolvedValueOnce({ bundle: after })
    let latest: ShipmentBundle = before
    const { unmount } = render(<TrackingPodBox bundle={before} onUploaded={(b) => { latest = b }} />)
    fireEvent.change(screen.getByTestId('tracking-pod-input'), { target: { files: [pdf()] } })
    await waitFor(() => expect(latest).toBe(after))
    unmount()

    render(<TrackingPodBox bundle={latest} onUploaded={vi.fn()} />)
    expect(screen.getByTestId('tracking-pod-state').textContent).toBe('On file')
    const ctx = makeCtx({ mode: 'edit', bundle: latest })
    const values = { ...emptyValues(), docs: { queued: [] } }
    render(<DocumentsCard values={values} update={vi.fn()} form={makeForm(values)} ctx={ctx} issues={[]} mode={ctx.mode} locked={NO_LOCKS} />)
    expect(screen.getByTestId('card-documents-slot-POD').getAttribute('data-on-file')).toBe('true')
  })
})
