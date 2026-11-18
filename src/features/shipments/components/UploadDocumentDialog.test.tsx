// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ShipmentBundle, ShipmentDocumentRecord } from '@/types/tms'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), put: vi.fn(), commit: vi.fn(), voidDoc: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  prepareDocumentUpload: mocks.prepare, putPresignedFile: mocks.put, commitDocument: mocks.commit, voidDocument: mocks.voidDoc,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))
import { UploadDocumentDialog } from './UploadDocumentDialog'

const bundle = { shipment: { id: 'shp-1' }, orders: [{ id: 'o-1' }], loadCarriers: [], loads: [], documents: [] } as unknown as ShipmentBundle
const oldPod = { id: 'sdoc-old', type: 'POD', name: 'pod-old.pdf', orderId: 'o-1', audience: 'CUSTOMER', status: 'ACTIVE' } as unknown as ShipmentDocumentRecord

const pick = () => {
  const file = new File(['%PDF'], 'pod-new.pdf', { type: 'application/pdf' })
  fireEvent.change(screen.getByLabelText('Document file'), { target: { files: [file] } })
}

beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  mocks.prepare.mockResolvedValue({ uploadUrl: 'https://s3/put', s3Key: 'shipment-docs/shp-1/sdoc-new-pod-new.pdf', documentId: 'sdoc-new' })
  mocks.put.mockResolvedValue(undefined)
  mocks.commit.mockResolvedValue({})
  mocks.voidDoc.mockResolvedValue({})
})

describe('UploadDocumentDialog replace', () => {
  it('supersede mode: the server retires the old file with the new commit, so nothing is voided afterwards', async () => {
    const onSaved = vi.fn()
    render(<UploadDocumentDialog bundle={bundle} replaces={oldPod} supersede lockType onClose={vi.fn()} onSaved={onSaved} />)
    pick()
    fireEvent.change(screen.getByLabelText('Reason for replacing'), { target: { value: 'Clearer copy' } })
    fireEvent.click(screen.getByRole('button', { name: /Replace/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ type: 'POD', replacesDocumentId: 'sdoc-old', replaceReason: 'Clearer copy' }))
    expect(mocks.voidDoc).not.toHaveBeenCalled()
  })

  it('the older replace (Documents tab, Load review) still voids the old file after filing the new one', async () => {
    render(<UploadDocumentDialog bundle={bundle} replaces={oldPod} onClose={vi.fn()} onSaved={vi.fn()} />)
    pick()
    expect(screen.queryByLabelText('Reason for replacing')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Replace/ }))
    await waitFor(() => expect(mocks.voidDoc).toHaveBeenCalledWith({ documentId: 'sdoc-old', reason: 'Replaced by pod-new.pdf' }))
    expect(mocks.commit.mock.calls[0][0]).not.toHaveProperty('replacesDocumentId')
  })

  it('an Add with the type locked cannot be changed to another kind of document', () => {
    render(<UploadDocumentDialog bundle={bundle} initialType="RATE_CON" lockType onClose={vi.fn()} onSaved={vi.fn()} />)
    expect((screen.getByLabelText('Document type') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('Document type') as HTMLSelectElement).value).toBe('RATE_CON')
  })
})
