// @vitest-environment jsdom
/**
 * Upload only. No viewfinder, and no shortcut into the phone's camera either.
 *
 * The live-video screen gave drivers a black screen on real phones. The straight-to-camera
 * shortcut that replaced it went too: a photo taken in the moment is the worst version of
 * a POD, since nothing crops it, straightens it or checks it is readable first. The scanner
 * app already on the phone does all of that and produces one PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PagePicker } from './PagePicker'
import { MAX_SCAN_PAGES } from '../driverApi'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// preparePage normalizes images through a canvas, which jsdom cannot do.
vi.mock('./imagePrep', () => ({
  preparePage: vi.fn(async (_src: unknown, fileName: string) => ({
    fileName,
    contentType: fileName.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
    byteSize: 100,
    blob: new Blob(['x'], { type: fileName.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' }),
  })),
}))

function pick(testId: string, files: File[]) {
  const input = screen.getByTestId(testId) as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  fireEvent.change(input)
}

const pdf = (name = 'POD.pdf') => new File(['%PDF-1.4'], name, { type: 'application/pdf' })

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x')
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('PagePicker', () => {
  it('offers one route only: upload', () => {
    render(<PagePicker onDone={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Upload the document/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /photo/i })).toBeNull()
    // No <video>, so there is nothing that can render black.
    expect(document.querySelector('video')).toBeNull()
  })

  it('never shortcuts straight into the camera', () => {
    // capture="environment" opens the camera with no chance to crop or check the page.
    render(<PagePicker onDone={vi.fn()} />)
    expect(screen.queryByTestId('camera-input')).toBeNull()
    expect(screen.getByTestId('library-input')).not.toHaveAttribute('capture')
  })

  it('tells drivers to scan it first', () => {
    render(<PagePicker onDone={vi.fn()} />)
    expect(screen.getByText(/Scan it first with the app on your phone/i)).toBeInTheDocument()
  })

  it('cannot send nothing', () => {
    render(<PagePicker onDone={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^Done/ })).toBeDisabled()
  })

  it('takes a scanner app PDF whole and sends it', async () => {
    const onDone = vi.fn()
    render(<PagePicker onDone={onDone} />)

    pick('library-input', [pdf('scan.pdf')])

    await waitFor(() => expect(screen.getByText('1 page ready')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Done (1)' }))
    expect(onDone).toHaveBeenCalledWith([
      expect.objectContaining({ fileName: 'scan.pdf', contentType: 'application/pdf' }),
    ])
  })

  it('accepts several pages and lets one be removed', async () => {
    render(<PagePicker onDone={vi.fn()} />)

    pick('library-input', [pdf('a.pdf'), pdf('b.pdf')])
    await waitFor(() => expect(screen.getByText('2 pages ready')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Remove page 1' }))
    await waitFor(() => expect(screen.getByText('1 page ready')).toBeInTheDocument())
  })

  it('stops at the page cap instead of silently dropping extras', async () => {
    render(<PagePicker onDone={vi.fn()} />)

    pick('library-input', Array.from({ length: MAX_SCAN_PAGES + 3 }, (_, i) => pdf(`p${i}.pdf`)))

    await waitFor(() => expect(screen.getByText(`${MAX_SCAN_PAGES} pages ready`)).toBeInTheDocument())
    expect(screen.getByText(/most pages we can send at once/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upload the document/ })).toBeDisabled()
  })

  it('can be backed out of', () => {
    const onCancel = vi.fn()
    render(<PagePicker onDone={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
