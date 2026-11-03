// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ComplianceDocument, Driver } from '@/types'
import type { CarrierDocumentRecord, CarrierRecord } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const driver = { id: 'd1', name: 'Dana Driver', active: true } as Driver
const FAR = '2099-01-01'
const mkDoc = (over: Partial<ComplianceDocument>): ComplianceDocument => ({
  id: 'x', entityType: 'DRIVER', entityId: 'd1', documentType: 'annual_physical', title: 'Physical', s3Key: 'docs/p.pdf',
  status: 'PENDING_REVIEW', uploadedBy: 'DRIVER_PORTAL', expirationDate: FAR,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
})
const pending = mkDoc({ id: 'p' })
const valid = mkDoc({ id: 'v', documentType: 'drug_test', title: 'Drug test', status: 'VALID' })

const auth = { isAdmin: false, isOwner: false, grants: [] as string[] }
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { email: 'staff@bcatcorp.com', userId: 'u1', groups: [] },
    isAdmin: auth.isAdmin, isOwner: auth.isOwner, hasPageAccess: (k: string) => auth.grants.includes(k),
  }),
}))
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ drivers: [driver], equipment: [] }),
}))

const carriersState = { carriers: [] as CarrierRecord[], error: null as string | null }
vi.mock('@/hooks/useCarriers', () => ({
  useCarriers: () => ({ carriers: carriersState.carriers, loading: false, error: carriersState.error, refresh: vi.fn() }),
}))

const approveDocument = vi.fn()
const rejectDocument = vi.fn()
vi.mock('@/hooks/useReviewQueue', () => ({
  useReviewQueue: () => ({ approveDocument, rejectDocument, refresh: vi.fn() }),
}))

const carrierDocsState: { rows: CarrierDocumentRecord[]; fail: boolean } = { rows: [], fail: false }
vi.mock('@/lib/apiClient', () => ({
  listCarrierDocuments: () => (carrierDocsState.fail ? Promise.reject(new Error('boom')) : Promise.resolve(carrierDocsState.rows)),
  getTmsSettings: () => Promise.resolve(null),
  getCarrierDocumentUrl: () => Promise.resolve('https://example.test/c.pdf'),
}))
vi.mock('@/lib/complianceClient', () => ({
  listAllComplianceDocuments: vi.fn().mockResolvedValue([]),
  getComplianceDocUrl: () => Promise.resolve('https://example.test/d.pdf'),
}))

import { __resetForTests } from '@/lib/complianceDocStore'
import { ComplianceOverviewPage } from './ComplianceOverviewPage'

const renderAt = (search: string) => render(
  <MemoryRouter initialEntries={[`/compliance${search}`]}><ComplianceOverviewPage /></MemoryRouter>,
)

beforeEach(() => {
  vi.clearAllMocks()
  auth.isAdmin = false; auth.isOwner = false; auth.grants = ['compliance']
  carriersState.carriers = []; carriersState.error = null
  carrierDocsState.rows = []; carrierDocsState.fail = false
  __resetForTests({ docs: [pending, valid], loaded: true })
})

describe('ComplianceOverviewPage', () => {
  it('?doc= opens the drawer on that document, with Approve and Reject for a permitted user', async () => {
    renderAt('?doc=cd:p')
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(within(drawer).getByRole('button', { name: 'Reject' })).toBeTruthy()
  })

  it('offers no review actions on a valid document', async () => {
    renderAt('?doc=cd:v')
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(within(drawer).queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  it('offers no review actions to a user with neither grant', async () => {
    auth.grants = []
    renderAt('?doc=cd:p')
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(within(drawer).queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  it('never offers review actions on a carrier document', async () => {
    carriersState.carriers = [{ id: 'c1', name: 'Acme Freight' } as CarrierRecord]
    carrierDocsState.rows = [{
      id: 'cdoc', carrierId: 'c1', type: 'W9', name: 'W-9', s3Key: 'c/w9.pdf', contentType: 'application/pdf', sizeBytes: 1,
      source: 'UPLOAD', uploadedBy: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }]
    auth.isAdmin = true
    renderAt('?doc=carrier:cdoc')
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getAllByText('Acme Freight').length).toBeGreaterThan(0)
    expect(within(drawer).queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('Reject cannot be submitted until a non-blank reason is typed, then rejects with it', async () => {
    rejectDocument.mockResolvedValue({ ...pending, status: 'REJECTED', rejectionReason: 'blurry' })
    renderAt('?doc=cd:p')
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    const submit = await screen.findByRole('button', { name: 'Reject document' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '   ' } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  blurry ' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(rejectDocument).toHaveBeenCalledTimes(1))
    expect(rejectDocument).toHaveBeenCalledWith(pending, 'blurry')
  })

  it('Approve calls approveDocument once and the status flips without a refetch', async () => {
    approveDocument.mockResolvedValue({ ...pending, status: 'VALID', verifiedBy: 'staff@bcatcorp.com' })
    renderAt('?doc=cd:p')
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(approveDocument).toHaveBeenCalledTimes(1))
    expect(approveDocument).toHaveBeenCalledWith(pending)
    await waitFor(() => expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Approve' })).toBeNull())
    expect(within(screen.getByRole('dialog')).getByText('Valid')).toBeTruthy()
  })

  it('names a failed carrier read instead of showing an empty table', async () => {
    carrierDocsState.fail = true
    renderAt('')
    expect(await screen.findByText('Carrier documents failed to load')).toBeTruthy()
  })
})
