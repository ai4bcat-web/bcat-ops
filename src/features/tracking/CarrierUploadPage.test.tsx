// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { CarrierUploadView } from '@/types/tms'

const fetchCarrierUpload = vi.hoisted(() => vi.fn())
const requestUpload = vi.hoisted(() => vi.fn())
const commitUpload = vi.hoisted(() => vi.fn())
const putPresignedFile = vi.hoisted(() => vi.fn())
const calls = vi.hoisted(() => [] as string[])

vi.mock('@/lib/trackingClient', () => ({
  TRACKING_API_URL: 'https://tracking.example',
  TrackingError: class TrackingError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
  fetchCarrierUpload,
  requestUpload,
  commitUpload,
}))

// The portal shares the staff PUT helper, and apiClient drags the whole Amplify data
// client in with it; the page only ever calls this one function.
vi.mock('@/lib/apiClient', () => ({ putPresignedFile }))

// Imported after the mocks are registered, exactly as CarrierPingPage.test does: a
// static import would bind the real trackingClient (and its amplify_outputs.json)
// before vi.mock could replace it.
const { CarrierUploadPage } = await import('./CarrierUploadPage')
const { TrackingError } = await import('@/lib/trackingClient')

const VIEW: CarrierUploadView = {
  broker: { name: 'BCAT Logistics' },
  loadNumber: 'S-1001-1',
  carrierName: 'Roadrunner Freight',
  stops: [
    { type: 'pickup', name: 'Shipper dock', city: 'Joliet', state: 'IL', appt: '2026-10-20T14:00:00.000Z' },
    { type: 'delivery', name: 'Consignee dock', city: 'Dallas', state: 'TX', appt: '2026-10-22T09:00:00.000Z' },
  ],
  needed: [
    { type: 'POD', label: 'Proof of delivery', satisfied: false },
    { type: 'CARRIER_INVOICE', label: 'Carrier invoice', satisfied: true },
  ],
  uploads: [
    { id: 'sdoc-1', type: 'CARRIER_INVOICE', name: 'invoice-7781.pdf', sizeBytes: 220_000, uploadedAt: '2026-10-22T18:30:00.000Z', reviewStatus: 'PENDING' },
  ],
  expiresAt: '2026-11-21T18:30:00.000Z',
  acceptedTypes: ['application/pdf', 'image/png', 'image/jpeg'],
  maxBytes: 15 * 1024 * 1024,
  contactPhone: '(224) 875-6477',
  generatedAt: '2026-10-22T19:00:00.000Z',
}

const TOKEN = 'Hq3Zn7Lp0vWx9TbKcRdYu1Ms4Ae6Gi2J'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/track/u/${TOKEN}`]}>
      <Routes><Route path="/track/u/:token" element={<CarrierUploadPage />} /></Routes>
    </MemoryRouter>,
  )
}

/** A File jsdom will report with the given type and size, without the bytes. */
function fakeFile(name: string, type: string, sizeBytes: number): File {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: sizeBytes })
  return file
}

async function pick(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  fireEvent.change(input)
}

const sendButton = () => screen.getByRole('button', { name: /Send this document/ })

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  fetchCarrierUpload.mockImplementation(async () => { calls.push('fetch'); return VIEW })
  requestUpload.mockImplementation(async () => {
    calls.push('request')
    return { uploadUrl: 'https://s3.example/put', s3Key: 'shipment-docs/shp-1/sdoc-2-pod.pdf', documentId: 'sdoc-2' }
  })
  putPresignedFile.mockImplementation(async () => { calls.push('put') })
  commitUpload.mockImplementation(async () => { calls.push('commit'); return { ok: true, documentId: 'sdoc-2' } })
})

describe('CarrierUploadPage', () => {
  it('shows what is still missing and what already landed', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())

    // "Proof of delivery" is also one of the select's options, so the checklist is
    // read inside its own card.
    const checklist = screen.getByText('We still need').parentElement as HTMLElement
    expect(within(checklist).getByText('Proof of delivery').style.textDecoration).toBe('none')
    expect(within(checklist).getByText('Carrier invoice').style.textDecoration).toBe('line-through')
    expect(screen.getByRole('option', { name: 'Proof of delivery' })).toBeTruthy()

    expect(screen.getByText('Received — being reviewed')).toBeTruthy()
    expect(screen.getByText('invoice-7781.pdf')).toBeTruthy()
    expect(screen.getByText(/Being reviewed/)).toBeTruthy()
    expect(screen.getByText(/This link stops working/)).toBeTruthy()
    expect(screen.getByText('(224) 875-6477')).toBeTruthy()
  })

  it('shows the server wording for a dead link and offers no way to upload', async () => {
    fetchCarrierUpload.mockRejectedValue(new TrackingError(404, 'This upload link is no longer active. Call dispatch for a new one.'))
    renderPage()
    await waitFor(() => expect(screen.getByText(/no longer active. Call dispatch/)).toBeTruthy())
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('refuses an oversized file before touching the network', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())

    await pick(fakeFile('huge-pod.pdf', 'application/pdf', 18 * 1024 * 1024))
    fireEvent.click(sendButton())

    await waitFor(() => expect(screen.getByText(/The limit is 15 MB/)).toBeTruthy())
    expect(requestUpload).not.toHaveBeenCalled()
    expect(putPresignedFile).not.toHaveBeenCalled()
  })

  it('signs, sends the bytes, commits and re-reads the view, in that order', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())
    calls.length = 0

    await pick(fakeFile('pod.pdf', 'application/pdf', 1_200_000))
    fireEvent.click(sendButton())

    await waitFor(() => expect(screen.getByText(/we have pod.pdf/)).toBeTruthy())
    expect(calls).toEqual(['request', 'put', 'commit', 'fetch'])
    expect(requestUpload.mock.calls[0][1]).toEqual({ type: 'POD', name: 'pod.pdf', contentType: 'application/pdf', sizeBytes: 1_200_000 })
    expect(putPresignedFile.mock.calls[0][0]).toBe('https://s3.example/put')
    expect(commitUpload.mock.calls[0][1]).toMatchObject({ documentId: 'sdoc-2', s3Key: 'shipment-docs/shp-1/sdoc-2-pod.pdf', type: 'POD' })
  })

  it('retries the commit once when the bytes have not landed yet', async () => {
    commitUpload.mockImplementationOnce(async () => {
      calls.push('commit-409')
      throw new TrackingError(409, 'The file has not landed yet')
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())
    calls.length = 0

    await pick(fakeFile('pod.jpg', 'image/jpeg', 800_000))
    fireEvent.click(sendButton())

    await waitFor(() => expect(screen.getByText(/we have pod.jpg/)).toBeTruthy(), { timeout: 5000 })
    expect(calls).toEqual(['request', 'put', 'commit-409', 'commit', 'fetch'])
    expect(screen.queryByText('The file has not landed yet')).toBeNull()
  })

  it('shows a 429 as the server wrote it and does not retry it', async () => {
    commitUpload.mockRejectedValue(new TrackingError(429, 'This link has received all the files it can. Call dispatch.'))
    renderPage()
    await waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())

    await pick(fakeFile('pod.pdf', 'application/pdf', 900_000))
    fireEvent.click(sendButton())

    await waitFor(() => expect(screen.getByText('This link has received all the files it can. Call dispatch.')).toBeTruthy())
    expect(commitUpload).toHaveBeenCalledTimes(1)
  })

  it('leaks nothing about the customer, the money or the references', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())

    const text = document.body.textContent ?? ''
    for (const leak of ['Acme', 'Customer', 'Rate', 'Margin', '$', 'Invoice total', 'PO #', 'Reference']) {
      expect(text).not.toContain(leak)
    }
  })
})
