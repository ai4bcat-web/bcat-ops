// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import type { Load } from '@/types'
import type { PodDocument } from '@/types/pods'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
globalThis.DOMRect ??= class { constructor(public x = 0, public y = 0, public width = 0, public height = 0) {} } as never
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

const podsClientMocks = vi.hoisted(() => ({
  getPodConnectionStatus: vi.fn(),
  configurePods: vi.fn(),
  listPods: vi.fn(),
  backfillPods: vi.fn(),
  getPodAssets: vi.fn(),
  assignPod: vi.fn(),
  retryPod: vi.fn(),
  getPodSenderMappings: vi.fn(),
  setPodSenderMapping: vi.fn(),
}))
vi.mock('@/lib/podsClient', () => podsClientMocks)

const loadsFixture: Load[] = [
  {
    id: 'l1', aljexId: '55501', tmsId: 'PO-9', pickupNumber: 'PU-1', customer: 'Metz Logistics',
    originCity: 'Chicago, IL', destinationCity: 'Indianapolis, IN',
    pickupAppt: '2026-09-28T08:00:00Z', deliveryAppt: '2026-09-29T14:00:00Z',
    pickupDriverId: null, deliveryDriverId: null, readyToInvoice: false,
    createdAt: '', updatedAt: '', createdBy: '', updatedBy: '',
  },
]

const setSelectedLoad = vi.fn()
const appStoreState = {
  loads: loadsFixture,
  drivers: [{ id: 'd1', name: 'Ivan Sender', phone: '+17735550101', active: true }],
  setSelectedLoad,
}
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: typeof appStoreState) => unknown) => sel(appStoreState),
}))

const authState = { isAdmin: true, isOwner: true }
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => authState,
}))

vi.mock('@/features/loads/LoadDrawer', () => ({ LoadDrawer: () => null }))
vi.mock('@/lib/download', () => ({ downloadFromUrl: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ graphqlErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)) }))

const { PodsPage } = await import('./PodsPage')

const baseDoc: PodDocument = {
  id: 'p1',
  clientId: 'c1',
  sourceMessageId: 'm1',
  mediaIndex: 0,
  companyName: 'Metz Logistics',
  senderName: 'Ivan Sender',
  senderContact: 'ivan@metz.com',
  receivedAt: '2026-09-28T12:00:00Z',
  referenceNumber: 'REF-1',
  notes: 'Back door delivery',
  isAllowed: true,
  fileName: 'pod1.jpg',
  contentType: 'image/jpeg',
  originalKey: 'orig-key',
  enhancedKey: undefined,
  processingStatus: 'READY',
  processingError: null,
  loadId: null,
  assignedBy: null,
  assignedAt: null,
  version: 1,
  createdAt: '',
  updatedAt: '',
}

function resetMocks() {
  podsClientMocks.getPodConnectionStatus.mockResolvedValue({ configured: true, clientId: 'c1', companyName: 'Metz' })
  podsClientMocks.backfillPods.mockResolvedValue({ queued: true })
  podsClientMocks.listPods.mockResolvedValue({ items: [baseDoc], nextToken: null })
  podsClientMocks.getPodAssets.mockResolvedValue({ item: baseDoc, originalUrl: 'https://test/orig.jpg', enhancedUrl: 'https://test/enh.jpg' })
  podsClientMocks.assignPod.mockResolvedValue({ item: { ...baseDoc, loadId: 'l1', version: 2 } })
  podsClientMocks.retryPod.mockResolvedValue({ item: { ...baseDoc, processingStatus: 'PENDING', version: 2 } })
  podsClientMocks.configurePods.mockResolvedValue({ configured: true, clientId: 'c1', companyName: 'Metz' })
  podsClientMocks.getPodSenderMappings.mockResolvedValue({ items: [] })
  podsClientMocks.setPodSenderMapping.mockResolvedValue({ item: null, deleted: false })
  authState.isAdmin = true
  authState.isOwner = true
  appStoreState.loads = loadsFixture
  confirmSpy.mockClear()
}

beforeEach(() => {
  vi.clearAllMocks()
  resetMocks()
})

describe('PodsPage', () => {
  it('renders the gallery and lists a POD after sync/list', async () => {
    render(<PodsPage />)
    await waitFor(() => expect(screen.getByText('Metz Logistics')).toBeTruthy())
    expect(screen.getAllByText(/Ivan Sender/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('REF-1')).toBeTruthy()
  })

  it('queues a seven-day scan that does not depend on keeping the page open', async () => {
    render(<PodsPage />)
    const button = await screen.findByRole('button', { name: 'Scan past 7 days' })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Processing continues when you close this page'))
  })

  it('does not claim a scan was queued when the server rejects it', async () => {
    podsClientMocks.backfillPods.mockRejectedValue(new Error('Queue unavailable'))
    render(<PodsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Scan past 7 days' }))
    await screen.findByText(/Queue unavailable/)
    expect(screen.queryByText(/Seven-day scan queued/)).toBeNull()
  })

  it('gates the connection form by role', async () => {
    podsClientMocks.getPodConnectionStatus.mockResolvedValue({ configured: false })
    authState.isAdmin = false
    authState.isOwner = false
    render(<PodsPage />)
    await waitFor(() => expect(screen.getByText(/Ask an admin/)).toBeTruthy())
    expect(screen.queryByText('Connect JobsDone')).toBeNull()
    expect(screen.queryByText('Configure')).toBeNull()
  })

  it('lets an admin connect JobsDone and clears the key after success', async () => {
    podsClientMocks.getPodConnectionStatus.mockResolvedValue({ configured: false })
    render(<PodsPage />)
    await waitFor(() => expect(screen.getByText('Connect JobsDone')).toBeTruthy())
    fireEvent.click(screen.getByText('Connect JobsDone'))

    const clientInput = screen.getByLabelText(/Client ID/i) as HTMLInputElement
    const keyInput = screen.getByLabelText(/API Key/i) as HTMLInputElement
    fireEvent.change(clientInput, { target: { value: 'bcat' } })
    fireEvent.change(keyInput, { target: { value: 'secret-key' } })

    fireEvent.click(screen.getByText('Save connection'))
    await waitFor(() => expect(podsClientMocks.configurePods).toHaveBeenCalledWith({ clientId: 'bcat', apiKey: 'secret-key' }))

    // Form closes and the key is never retained in the UI.
    await waitFor(() => expect(screen.queryByLabelText(/API Key/i)).toBeNull())
    await waitFor(() => expect(screen.getByText(/Connected/)).toBeTruthy())
  })

  it('assigns a POD to a selected load and then unassigns it', async () => {
    render(<PodsPage />)
    await waitFor(() => expect(screen.getByText('Assign')).toBeTruthy())

    fireEvent.click(screen.getAllByText('Assign')[0])
    await waitFor(() => expect(screen.getByText(/Assign shipment/)).toBeTruthy())

    // Pick the only load in the list.
    fireEvent.click(screen.getByText(/Pro #55501/))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Assign$/ }))

    await waitFor(() => expect(podsClientMocks.assignPod).toHaveBeenCalledWith({ id: 'p1', loadId: 'l1', expectedVersion: 1 }))
    await waitFor(() => expect(screen.getAllByText('Unassign').length).toBeGreaterThanOrEqual(1))

    fireEvent.click(screen.getByText('Unassign'))
    await waitFor(() => expect(podsClientMocks.assignPod).toHaveBeenLastCalledWith({ id: 'p1', loadId: null, expectedVersion: 2 }))
  })

  it('offers original and enhanced variants in the preview dialog', async () => {
    render(<PodsPage />)
    await waitFor(() => expect(screen.getByText('View')).toBeTruthy())
    fireEvent.click(screen.getByText('View'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByText('Original').length).toBeGreaterThanOrEqual(1)
    expect(within(dialog).getAllByText('Enhanced').length).toBeGreaterThanOrEqual(1)
    expect(within(dialog).getByAltText('pod1.jpg')).toBeTruthy()
  })

  it('shows retry for failed originals and preserves the original download', async () => {
    const failedDoc: PodDocument = { ...baseDoc, processingStatus: 'FAILED', processingError: 'Unsupported image' }
    podsClientMocks.listPods.mockResolvedValue({ items: [failedDoc], nextToken: null })
    podsClientMocks.getPodAssets.mockResolvedValue({ item: failedDoc, originalUrl: 'https://test/orig.jpg' })
    render(<PodsPage />)
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Original')).toBeTruthy())
    expect(screen.queryByText('Enhanced')).toBeNull()

    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(podsClientMocks.retryPod).toHaveBeenCalledWith({ id: 'p1' }))
  })

  it('surfaces list errors instead of swallowing them', async () => {
    podsClientMocks.listPods.mockRejectedValue(new Error('JobsDone unavailable'))
    render(<PodsPage />)
    await waitFor(() => expect(screen.getByText(/JobsDone unavailable/)).toBeTruthy())
  })
})
