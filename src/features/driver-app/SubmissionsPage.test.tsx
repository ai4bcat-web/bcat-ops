// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SubmissionsPage from './SubmissionsPage'
import type { SubmissionSummary } from './driverApi'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
globalThis.DOMRect ??= class {
  constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
} as never
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

const apiMocks = vi.hoisted(() => {
  class DriverApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'DriverApiError'
    }
  }
  return {
    fetchSubmissions: vi.fn(),
    fetchDocUrl: vi.fn(),
    // The page mounts the current-load card and the unattached-POD list alongside the
    // submissions, so their calls have to be mockable too.
    fetchCurrentLoad: vi.fn(),
    fetchRecentLoads: vi.fn(),
    attachSubmissionToLoad: vi.fn(),
    DriverApiError,
  }
})

vi.mock('@/features/driver-app/driverApi', () => apiMocks)

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <SubmissionsPage />
    </MemoryRouter>,
  )
}

describe('SubmissionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.fetchDocUrl.mockResolvedValue('https://example.com/doc.jpg')
    // Neutral defaults: no load running, no loads to pick. Each has its own tests.
    apiMocks.fetchCurrentLoad.mockResolvedValue(null)
    apiMocks.fetchRecentLoads.mockResolvedValue([])
  })

  it('renders a retryable error instead of an infinite spinner when fetch fails', async () => {
    apiMocks.fetchSubmissions.mockRejectedValue(
      new apiMocks.DriverApiError(500, 'Server error'),
    )

    renderWithRouter()

    expect(screen.getByText(/Loading submissions/i)).toBeTruthy()

    await waitFor(() => expect(screen.getByText('Server error')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy()
    expect(screen.queryByText(/Loading submissions/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Try again/i }))
    await waitFor(() => expect(apiMocks.fetchSubmissions).toHaveBeenCalledTimes(2))
  })

  it('lists submissions newest-first', async () => {
    const summaries: SubmissionSummary[] = [
      {
        id: 'old',
        status: 'NEW',
        referenceNumber: 'OLD-REF',
        createdAt: '2024-01-01T00:00:00.000Z',
        docs: [],
      },
      {
        id: 'new',
        status: 'NOTIFIED',
        referenceNumber: 'NEW-REF',
        createdAt: '2024-01-02T00:00:00.000Z',
        docs: [],
      },
    ]
    apiMocks.fetchSubmissions.mockResolvedValue(summaries)

    renderWithRouter()

    await waitFor(() => expect(screen.getAllByTestId('submission-title').length).toBe(2))

    const titles = screen.getAllByTestId('submission-title')
    // The submission with the later createdAt timestamp should appear first.
    expect(titles[0]?.textContent).toContain('NEW-REF')
    expect(titles[1]?.textContent).toContain('OLD-REF')
  })

  it('shows an empty state when the driver has no submissions', async () => {
    apiMocks.fetchSubmissions.mockResolvedValue([])

    renderWithRouter()

    await waitFor(() => expect(screen.getByText(/No submissions yet/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Scan a rate confirmation/i })).toBeTruthy()
  })

  describe('a POD waiting for a load', () => {
    const unattachedPod = (over: Partial<SubmissionSummary> = {}): SubmissionSummary => ({
      id: 'sub-1',
      status: 'NEW',
      loadId: null,
      referenceNumber: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      docs: [{ id: 'd1', kind: 'POD', fileName: 'POD-1.pdf', contentType: 'application/pdf', pageNumber: 1, uploadedAt: '2026-10-01T10:00:00.000Z' }],
      ...over,
    }) as SubmissionSummary

    it('says nothing at all when every POD is already on a load', async () => {
      apiMocks.fetchSubmissions.mockResolvedValue([unattachedPod({ loadId: 'load-1' })])
      renderWithRouter()
      await waitFor(() => expect(apiMocks.fetchSubmissions).toHaveBeenCalled())

      expect(screen.queryByText(/not on a load yet/i)).toBeNull()
    })

    it('surfaces a POD with no load and offers to attach it', async () => {
      apiMocks.fetchSubmissions.mockResolvedValue([unattachedPod()])
      renderWithRouter()

      expect(await screen.findByText(/1 POD is not on a load yet/i)).toBeTruthy()
      expect(screen.getByRole('button', { name: /Choose load/i })).toBeTruthy()
      // The loads are not fetched until a driver actually opens the picker.
      expect(apiMocks.fetchRecentLoads).not.toHaveBeenCalled()
    })

    it('ignores a submission carrying only a rate confirmation', async () => {
      // A rate con with no load is the office's problem, not something the driver can fix.
      apiMocks.fetchSubmissions.mockResolvedValue([
        unattachedPod({ docs: [{ id: 'd1', kind: 'RATECON', fileName: 'rc.pdf', contentType: 'application/pdf', pageNumber: 1, uploadedAt: '2026-10-01T10:00:00.000Z' }] } as Partial<SubmissionSummary>),
      ])
      renderWithRouter()
      await waitFor(() => expect(apiMocks.fetchSubmissions).toHaveBeenCalled())

      expect(screen.queryByText(/not on a load yet/i)).toBeNull()
    })

    it('attaches the POD to the load the driver picks, and stops asking', async () => {
      apiMocks.fetchSubmissions.mockResolvedValue([unattachedPod()])
      apiMocks.fetchRecentLoads.mockResolvedValue([
        { id: 'load-9', proNumber: '13364', lane: 'Mesa → Tempe', customer: 'Broker X', deliveryAppt: '2026-10-01T02:15:00.000Z' },
      ])
      apiMocks.attachSubmissionToLoad.mockResolvedValue({ submissionId: 'sub-1', loadId: 'load-9', proNumber: '13364' })

      renderWithRouter()
      fireEvent.click(await screen.findByRole('button', { name: /Choose load/i }))

      const pick = await screen.findByRole('button', { name: /PRO 13364/ })
      fireEvent.click(pick)

      await waitFor(() => expect(apiMocks.attachSubmissionToLoad).toHaveBeenCalledWith('sub-1', 'load-9'))
      // The waiting notice goes away without a refetch — the row now has a load.
      await waitFor(() => expect(screen.queryByText(/not on a load yet/i)).toBeNull())
      expect(apiMocks.fetchSubmissions).toHaveBeenCalledTimes(1)
    })

    it('keeps the POD listed when attaching fails, so it is not lost', async () => {
      apiMocks.fetchSubmissions.mockResolvedValue([unattachedPod()])
      apiMocks.fetchRecentLoads.mockResolvedValue([
        { id: 'load-9', proNumber: '13364', lane: 'Mesa → Tempe', customer: null, deliveryAppt: null },
      ])
      apiMocks.attachSubmissionToLoad.mockRejectedValue(new Error('Not found'))

      renderWithRouter()
      fireEvent.click(await screen.findByRole('button', { name: /Choose load/i }))
      fireEvent.click(await screen.findByRole('button', { name: /PRO 13364/ }))

      await waitFor(() => expect(apiMocks.attachSubmissionToLoad).toHaveBeenCalled())
      expect(screen.getByText(/1 POD is not on a load yet/i)).toBeTruthy()
    })

    it('says so plainly when the driver has no built loads to attach to', async () => {
      apiMocks.fetchSubmissions.mockResolvedValue([unattachedPod()])
      apiMocks.fetchRecentLoads.mockResolvedValue([])

      renderWithRouter()
      fireEvent.click(await screen.findByRole('button', { name: /Choose load/i }))

      expect(await screen.findByText(/None of your loads are built yet/i)).toBeTruthy()
    })
  })
})
