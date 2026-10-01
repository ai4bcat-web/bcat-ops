// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ScanPage from './ScanPage'
import type { PendingPage } from '../driverApi'

const mockUseIsMobile = vi.fn(() => false)

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockUseIsMobile(),
}))

function makePages(count: number): PendingPage[] {
  return Array.from({ length: count }, (_, i) => ({
    fileName: `scan-${i + 1}.jpg`,
    contentType: 'image/jpeg',
    byteSize: 5000 + i,
    blob: new Blob(['x'], { type: 'image/jpeg' }),
  }))
}

const apiMocks = vi.hoisted(() => {
  class DriverApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'DriverApiError'
    }
  }

  class ResumableDriverApiError extends DriverApiError {
    submissionId: string
    kind: 'RATECON' | 'POD'
    constructor(status: number, message: string, submissionId: string, kind: 'RATECON' | 'POD') {
      super(status, message)
      this.submissionId = submissionId
      this.kind = kind
      this.name = 'ResumableDriverApiError'
    }
  }

  return {
    submitRatecon: vi.fn(),
    submitStandalonePod: vi.fn(),
    submitPod: vi.fn(),
    fetchSubmissions: vi.fn(),
    DriverApiError,
    ResumableDriverApiError,
  }
})

vi.mock('@/features/driver-app/driverApi', () => apiMocks)

// CameraCapture is heavy (mediaDevices, canvas). Replace it with a simple control that just
// fires onDone with a fixed set of pages when the driver taps "Capture".
vi.mock('./CameraCapture', () => ({
  CameraCapture: ({ onDone }: { onDone: (pages: PendingPage[]) => void }) => (
    <button type="button" onClick={() => onDone(makePages(2))} data-testid="capture-done">
      Capture pages
    </button>
  ),
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/driver/scan" element={<ScanPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ScanPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.fetchSubmissions.mockResolvedValue([])
  })

  it('submits a multi-page ratecon with one API call', async () => {
    apiMocks.submitRatecon.mockResolvedValue('ratecon-sub')

    renderAt('/driver/scan')

    fireEvent.click(screen.getByRole('button', { name: /Rate confirmation/i }))
    fireEvent.click(await screen.findByTestId('capture-done'))

    await screen.findByRole('button', { name: /Send to office/i })
    fireEvent.change(screen.getByLabelText(/Reference #/i), { target: { value: 'RC-123' } })
    fireEvent.click(screen.getByRole('button', { name: /Send to office/i }))

    await waitFor(() => expect(apiMocks.submitRatecon).toHaveBeenCalledTimes(1))
    const args = apiMocks.submitRatecon.mock.calls[0][0]
    expect(args.pages).toHaveLength(2)
    expect(args.referenceNumber).toBe('RC-123')
    expect(args.resumeFromId).toBeUndefined()
  })

  it('submits a standalone POD when the load is not listed', async () => {
    apiMocks.fetchSubmissions.mockResolvedValue([
      { id: 'existing', referenceNumber: 'OLD', createdAt: '2024-01-01T00:00:00.000Z', status: 'NEW', docs: [] },
    ])
    apiMocks.submitStandalonePod.mockResolvedValue('pod-sub')

    renderAt('/driver/scan')

    fireEvent.click(screen.getByRole('button', { name: /POD/i }))
    await screen.findByText(/Choose a load for this POD/i)

    // Use the standalone reference path instead of picking the existing load.
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. VRID or load number/i), {
      target: { value: 'NEW-LOAD' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Continue with reference/i }))

    fireEvent.click(await screen.findByTestId('capture-done'))

    await screen.findByRole('button', { name: /Send to office/i })
    fireEvent.click(screen.getByRole('button', { name: /Send to office/i }))

    await waitFor(() => expect(apiMocks.submitStandalonePod).toHaveBeenCalledTimes(1))
    const args = apiMocks.submitStandalonePod.mock.calls[0][0]
    expect(args.pages).toHaveLength(2)
    expect(args.referenceNumber).toBe('NEW-LOAD')
  })

  it('retries a failed upload without creating a second submission', async () => {
    apiMocks.submitRatecon
      .mockRejectedValueOnce(new apiMocks.ResumableDriverApiError(500, 'Upload failed', 'abc-123', 'RATECON'))
      .mockResolvedValueOnce('ratecon-sub')

    renderAt('/driver/scan')

    fireEvent.click(screen.getByRole('button', { name: /Rate confirmation/i }))
    fireEvent.click(await screen.findByTestId('capture-done'))

    await screen.findByRole('button', { name: /Send to office/i })
    fireEvent.click(screen.getByRole('button', { name: /Send to office/i }))

    await waitFor(() => expect(apiMocks.submitRatecon).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry upload/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Retry upload/i }))

    await waitFor(() => expect(apiMocks.submitRatecon).toHaveBeenCalledTimes(2))
    const first = apiMocks.submitRatecon.mock.calls[0][0]
    const second = apiMocks.submitRatecon.mock.calls[1][0]
    expect(first.resumeFromId).toBeUndefined()
    expect(second.resumeFromId).toBe('abc-123')
  })
})
