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
})
