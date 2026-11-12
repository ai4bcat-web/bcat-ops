// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ScanPage from './ScanPage'
import type { PendingPage } from '../driverApi'

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))

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
    }
  }
  class ResumableDriverApiError extends DriverApiError {}
  return {
    submitMisc: vi.fn(),
    submitStandalonePod: vi.fn(),
    submitPod: vi.fn(),
    fetchSubmissions: vi.fn(),
    fetchCurrentLoad: vi.fn(),
    attachSubmissionToLoad: vi.fn(),
    DriverApiError,
    ResumableDriverApiError,
  }
})
vi.mock('@/features/driver-app/driverApi', () => apiMocks)
vi.mock('../useDriverProgram', () => ({ useDriverProgram: () => 'PAPERWORK' }))

// PagePicker does real file and canvas work; stand in a button that hands back two pages.
const pickerProps = vi.hoisted(() => ({ photos: undefined as boolean | undefined }))
vi.mock('./PagePicker', () => ({
  PagePicker: ({ onDone, photos }: { onDone: (pages: PendingPage[]) => void; photos?: boolean }) => {
    pickerProps.photos = photos
    return (
      <button type="button" onClick={() => onDone(makePages(2))} data-testid="capture-done">
        Capture pages
      </button>
    )
  },
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

const currentLoad = {
  id: 'lod-1', proNumber: '20027', lane: 'Cicero to Newton', originCity: null, destinationCity: null,
  pickupAppt: null, deliveryAppt: null, customer: null, hasRateConfirmation: false, hasPod: true,
  requiredDocs: [
    { type: 'POD', label: 'Proof of delivery', done: true },
    { type: 'LUMPER_RECEIPT', label: 'Lumper receipt', done: false },
  ],
}

describe('ScanPage — Additional document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    apiMocks.fetchCurrentLoad.mockResolvedValue(currentLoad)
    apiMocks.submitMisc.mockResolvedValue('sub-1')
    apiMocks.attachSubmissionToLoad.mockResolvedValue(undefined)
  })

  it('offers Additional document next to the POD, and never a rate confirmation', () => {
    renderAt('/driver/scan')
    expect(screen.getByRole('button', { name: /POD \(delivery receipt\)/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Additional document/ })).toBeInTheDocument()
    expect(screen.queryByText(/rate con/i)).toBeNull()
  })

  it('lists what this load needs first, then sends the pages typed, against the current load', async () => {
    renderAt('/driver/scan')
    fireEvent.click(screen.getByRole('button', { name: /Additional document/ }))
    expect(await screen.findByText('Needed for this load')).toBeInTheDocument()
    expect(screen.getByText('The office is waiting on this')).toBeInTheDocument()
    // The rate confirmation is the office's to collect: never offered.
    expect(screen.queryByText(/Rate confirmation/)).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /Lumper receipt/ })[0])
    // A document is scanned like a page, not kept as a photo.
    fireEvent.click(await screen.findByTestId('capture-done'))
    expect(pickerProps.photos).toBe(false)

    expect(screen.getByText(/Document:/).parentElement).toHaveTextContent('Lumper receipt')
    await waitFor(() => expect(screen.getByLabelText('Load / PRO #')).toHaveValue('20027'))
    fireEvent.click(screen.getByRole('button', { name: 'Send to office' }))

    await waitFor(() => expect(apiMocks.submitMisc).toHaveBeenCalledTimes(1))
    expect(apiMocks.submitMisc.mock.calls[0][0]).toMatchObject({ docType: 'LUMPER_RECEIPT', referenceNumber: '20027' })
    expect(apiMocks.submitMisc.mock.calls[0][0].pages).toHaveLength(2)
    expect(await screen.findByText('The office has your lumper receipt.')).toBeInTheDocument()
  })

  it("sends 'Other' untyped, with the driver's note", async () => {
    renderAt('/driver/scan')
    fireEvent.click(screen.getByRole('button', { name: /Additional document/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^Other/ }))
    fireEvent.click(await screen.findByTestId('capture-done'))
    fireEvent.change(screen.getByLabelText('What is it?'), { target: { value: 'gate pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to office' }))
    await waitFor(() => expect(apiMocks.submitMisc).toHaveBeenCalledTimes(1))
    const input = apiMocks.submitMisc.mock.calls[0][0]
    expect(input.docType).toBeUndefined()
    expect(input.note).toBe('gate pass')
  })

  it('opens straight on the camera from a Send link on the load card, and links it to that load', async () => {
    renderAt('/driver/scan?kind=doc&docType=LUMPER_RECEIPT&pro=20027&loadId=lod-1')
    fireEvent.click(await screen.findByTestId('capture-done'))
    fireEvent.click(screen.getByRole('button', { name: 'Send to office' }))
    await waitFor(() => expect(apiMocks.submitMisc).toHaveBeenCalledTimes(1))
    expect(apiMocks.submitMisc.mock.calls[0][0]).toMatchObject({ docType: 'LUMPER_RECEIPT', referenceNumber: '20027' })
    await waitFor(() => expect(apiMocks.attachSubmissionToLoad).toHaveBeenCalledWith('sub-1', 'lod-1'))
  })

  it('ignores a docType it does not know, or the rate confirmation, and asks instead', async () => {
    renderAt('/driver/scan?kind=doc&docType=RATE_CON&pro=20027')
    expect(await screen.findByText('What is this document?')).toBeInTheDocument()
  })
})
