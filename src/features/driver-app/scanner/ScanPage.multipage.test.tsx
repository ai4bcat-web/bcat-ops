// @vitest-environment jsdom
/**
 * A driver sending several pages of one POD, from the row on their settlement.
 *
 * Reported from the road: tapping Send on a load showed the scan screen for an instant and
 * then dropped back to the settlement. This walks the whole path the driver takes — arrive
 * with the load's PRO, add three pages, review, send — so that what happens between those
 * steps is pinned rather than described.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const submitStandalonePod = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const submitPod = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const submitRatecon = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const fetchCurrentLoad = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const fetchSubmissions = vi.hoisted(() => vi.fn().mockResolvedValue([]))

vi.mock('../driverApi', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  submitStandalonePod, submitPod, submitRatecon, fetchCurrentLoad, fetchSubmissions,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
// Thumbnails build object URLs; jsdom has no implementation.
URL.createObjectURL = () => 'blob:test'
URL.revokeObjectURL = () => undefined

// useIsMobile reads matchMedia, which jsdom does not implement. Drivers are on phones.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: true, media: query, onchange: null,
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
}))
// prepareFile runs a canvas pipeline jsdom has no backend for; the page shapes are what
// matter here, not the pixels.
vi.mock('./imagePrep', () => ({
  prepareFile: vi.fn(async (file: File) => ({
    fileName: file.name,
    contentType: file.type || 'image/jpeg',
    byteSize: 1234,
    blob: file,
  })),
}))

const ScanPage = (await import('./ScanPage')).default

function openFromSettlementRow(pro = '14538') {
  render(
    <MemoryRouter initialEntries={[`/driver/scan?kind=pod&pro=${pro}`]}>
      <Routes>
        <Route path="/driver/scan" element={<ScanPage />} />
        <Route path="/driver/settlement" element={<div>SETTLEMENT</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

function pick(names: string[]) {
  const input = screen.getByTestId('library-input') as HTMLInputElement
  const files = names.map((n) => new File(['x'], n, { type: 'image/jpeg' }))
  fireEvent.change(input, { target: { files } })
}

beforeEach(() => vi.clearAllMocks())

describe('a driver sending several pages for one shipment', () => {
  it('opens straight on the picker, already aimed at the load they tapped', async () => {
    // Not the load chooser: they came from a row, so the question it asks is answered.
    openFromSettlementRow()
    expect(await screen.findByRole('button', { name: /Upload the document/ })).toBeInTheDocument()
    expect(screen.queryByText('SETTLEMENT')).not.toBeInTheDocument()
  })

  it('stays on the picker after pages are added — it does not bounce back', async () => {
    // The reported symptom. Adding pages must not navigate anywhere.
    openFromSettlementRow()
    await screen.findByRole('button', { name: /Upload the document/ })
    pick(['page1.jpg', 'page2.jpg'])

    await waitFor(() => expect(screen.getByText('2 pages ready')).toBeInTheDocument())
    expect(screen.queryByText('SETTLEMENT')).not.toBeInTheDocument()
  })

  it('accumulates pages across separate picks, which is how a phone picker works', async () => {
    // iOS hands back one batch at a time; a driver adding a third page later must not
    // replace the two already there.
    openFromSettlementRow()
    await screen.findByRole('button', { name: /Upload the document/ })
    pick(['page1.jpg', 'page2.jpg'])
    await waitFor(() => expect(screen.getByText('2 pages ready')).toBeInTheDocument())
    pick(['page3.jpg'])
    await waitFor(() => expect(screen.getByText('3 pages ready')).toBeInTheDocument())
  })

  it('sends every page under the PRO it was opened with', async () => {
    openFromSettlementRow('14538')
    await screen.findByRole('button', { name: /Upload the document/ })
    pick(['a.jpg', 'b.jpg', 'c.jpg'])
    await waitFor(() => expect(screen.getByText('3 pages ready')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }))
    const send = await screen.findByRole('button', { name: /Send/ })
    fireEvent.click(send)

    await waitFor(() => expect(submitStandalonePod).toHaveBeenCalledTimes(1))
    const sent = submitStandalonePod.mock.calls[0][0] as { pages: unknown[]; referenceNumber?: string }
    expect(sent.pages).toHaveLength(3)
    expect(sent.referenceNumber).toBe('14538')
  })

  it('lands on a confirmation the driver has to dismiss, not straight back', async () => {
    // So a driver sees that it sent. The settlement is a tap away, never automatic.
    openFromSettlementRow()
    await screen.findByRole('button', { name: /Upload the document/ })
    pick(['a.jpg'])
    await waitFor(() => expect(screen.getByText('1 page ready')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^Done/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Send/ }))

    expect(await screen.findByText('Sent!')).toBeInTheDocument()
    expect(screen.queryByText('SETTLEMENT')).not.toBeInTheDocument()
  })

  it('goes back to the settlement only when the driver asks to', async () => {
    openFromSettlementRow()
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    fireEvent.click(cancel)
    expect(await screen.findByText('SETTLEMENT')).toBeInTheDocument()
  })
})
