// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { Load } from '@/types'
import type { ReviewSubmission } from '@/lib/podReview'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const reviewMocks = vi.hoisted(() => ({
  listReviewSubmissions: vi.fn(),
  saveReview: vi.fn(),
  recordReplacementRequest: vi.fn(),
}))
vi.mock('@/lib/podReviewClient', () => reviewMocks)
const dispatchAction = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({
  graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  dispatchAction,
}))
vi.mock('@/lib/podsClient', () => ({ queueDriverPodCheck: vi.fn() }))
vi.mock('@/lib/driverSubmissionsClient', () => ({ getDriverDocUrl: vi.fn(async (k: string) => `https://s3/${k}`) }))
vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))
vi.mock('@/features/driver-docs', () => ({ DriverDocUploadDialog: () => null }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const load: Load = {
  id: 'l1', aljexId: '14729', tmsId: 'PO-9', pickupNumber: 'PU-1', customer: 'Forefront',
  originCity: 'Pleasant Prairie, WI', destinationCity: 'Elk Grove, IL',
  pickupAppt: '2026-10-19T08:00:00Z', deliveryAppt: '2026-10-20T14:00:00Z',
  pickupDriverId: null, deliveryDriverId: null, readyToInvoice: false,
  createdAt: '', updatedAt: '', createdBy: '', updatedBy: '',
}
const updateLoad = vi.fn(async () => {})
const appState = {
  loads: [load],
  drivers: [
    { id: 'd1', name: 'Ivan Driver', phone: '+17735550101', active: true, driverType: 'COMPANY' },
    { id: 'd2', name: 'Olga Owner', phone: '+17735550102', active: true, driverType: 'OWNER_OPERATOR' },
  ],
  setSelectedLoad: vi.fn(),
  updateLoad,
}
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: typeof appState) => unknown) => sel(appState),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { email: 'kel@bcatcorp.com' } }) }))

import { PodsPage } from './PodsPage'

const page = (n: number) => ({
  id: `p${n}`, submissionId: 's1', driverId: 'd1', kind: 'POD' as const, s3Key: `k${n}`, pageNumber: n, uploadedAt: '2026-10-20T15:00:00Z',
  legibility: 'OK' as const,
})

function sub(over: Partial<ReviewSubmission> = {}): ReviewSubmission {
  return {
    id: 's1', driverId: 'd1', driverName: 'Ivan Driver', source: 'PWA', loadId: 'l1', referenceNumber: '14729',
    combinedPodKey: 'driver-docs/d1/s1/POD/combined.pdf', createdAt: '2026-10-20T15:00:00Z',
    docs: [page(1)],
    podCheckStatus: 'DONE',
    podCheck: JSON.stringify({
      checkedAt: '2026-10-20T15:01:00Z', model: 'm',
      addresses: { verdict: 'PASS', pod: { shipper: 'A', consignee: 'B' }, rateCon: { pickup: 'A', delivery: 'B' }, fromLoadStops: false, notes: '' },
      pages: { verdict: 'FAIL', markers: 'Page 1 of 2', statedTotal: 2, received: 1, notes: 'Page 2 is missing' },
      legibility: { verdict: 'PASS', notes: '' }, signed: 'PASS', summary: 'Page 2 is missing.',
    }),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PodsPage review queue', () => {
  it('lists driver-app PODs to review, with the check results, and leaves office uploads out', async () => {
    reviewMocks.listReviewSubmissions.mockResolvedValue([
      sub(),
      sub({ id: 's2', source: 'STAFF', referenceNumber: '99999', loadId: null }),
    ])
    render(<PodsPage />)
    expect(await screen.findByText('14729')).toBeTruthy()
    expect(screen.queryByText('99999')).toBeNull()
    expect(screen.getByText('1 of 2 pages')).toBeTruthy()
    expect(screen.getByTitle('Pages: problem')).toBeTruthy()
    expect(screen.getByText('Ivan driver app', { selector: 'div' })).toBeTruthy()
  })

  it('will not approve a POD with an unticked box and no note', async () => {
    reviewMocks.listReviewSubmissions.mockResolvedValue([sub()])
    render(<PodsPage />)
    fireEvent.click(await screen.findByText('14729'))
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }))
    expect(reviewMocks.saveReview).not.toHaveBeenCalled()
  })

  it('approves a one-page POD when a note explains it, and writes the note to the load', async () => {
    reviewMocks.listReviewSubmissions.mockResolvedValue([sub()])
    reviewMocks.saveReview.mockResolvedValue({ ...sub(), podReviewStatus: 'APPROVED' })
    render(<PodsPage />)
    fireEvent.click(await screen.findByText('14729'))
    fireEvent.click(await screen.findByLabelText(/Addresses match/))
    fireEvent.click(screen.getByLabelText(/Legible/))
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: 'Receiver BOL has no page 2.' } })
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }))
    await waitFor(() => expect(reviewMocks.saveReview).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1', status: 'APPROVED', note: 'Receiver BOL has no page 2.',
      checks: { addresses: true, allPages: false, legible: true }, reviewer: 'kel@bcatcorp.com',
    })))
    expect(updateLoad).toHaveBeenCalledWith('l1', { podNotes: 'Receiver BOL has no page 2.' })
  })

  it('marks a POD as needing replacement without texting anyone — dispatch does that', async () => {
    reviewMocks.listReviewSubmissions.mockResolvedValue([sub()])
    reviewMocks.recordReplacementRequest.mockResolvedValue({ ...sub(), podReviewStatus: 'NEEDS_REPLACEMENT' })
    render(<PodsPage />)
    fireEvent.click(await screen.findByText('14729'))
    fireEvent.click(await screen.findByLabelText(/Addresses match/))
    fireEvent.click(screen.getByLabelText(/Legible/))
    fireEvent.click(screen.getByRole('button', { name: /Request new POD/ }))
    fireEvent.click(screen.getByRole('button', { name: /Mark as needing a new POD/ }))
    await waitFor(() => expect(reviewMocks.recordReplacementRequest).toHaveBeenCalled())
    expect(reviewMocks.recordReplacementRequest.mock.calls[0][0].message).toMatch(/PRO 14729 — we only have 1 of 2 pages/)
    expect(dispatchAction).not.toHaveBeenCalled()
  })
})
