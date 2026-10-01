// @vitest-environment jsdom
/**
 * There is no in-app camera any more. A live-video capture screen was tried and gave
 * drivers a black screen on real phones — the worst failure this app can have, since it
 * leaves someone at a dock unable to send a signed POD at all.
 *
 * What replaces it is the phone's own camera and file picker, which is also how a scanner
 * app hands over a multi-page PDF. These tests pin that both routes exist, that a PDF is
 * taken whole, and that nothing can be sent empty.
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
  it('offers the phone camera and a file, and never a live viewfinder', () => {
    render(<PagePicker onDone={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Take a photo/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Choose a file or scan/ })).toBeInTheDocument()
    // The whole point: no <video>, so there is nothing that can render black.
    expect(document.querySelector('video')).toBeNull()
  })

  it('opens the phone camera directly rather than a photo library', () => {
    render(<PagePicker onDone={vi.fn()} />)
    expect(screen.getByTestId('camera-input')).toHaveAttribute('capture', 'environment')
    expect(screen.getByTestId('library-input')).not.toHaveAttribute('capture')
  })

  it('points drivers at a scanner app for multi-page documents', () => {
    render(<PagePicker onDone={vi.fn()} />)
    expect(screen.getByText(/use the scanner app on your phone/i)).toBeInTheDocument()
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

    pick('camera-input', [pdf('a.pdf'), pdf('b.pdf')])
    await waitFor(() => expect(screen.getByText('2 pages ready')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Remove page 1' }))
    await waitFor(() => expect(screen.getByText('1 page ready')).toBeInTheDocument())
  })

  it('stops at the page cap instead of silently dropping extras', async () => {
    render(<PagePicker onDone={vi.fn()} />)

    pick('library-input', Array.from({ length: MAX_SCAN_PAGES + 3 }, (_, i) => pdf(`p${i}.pdf`)))

    await waitFor(() => expect(screen.getByText(`${MAX_SCAN_PAGES} pages ready`)).toBeInTheDocument())
    expect(screen.getByText(/most pages we can send at once/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Take a photo/ })).toBeDisabled()
  })

  it('can be backed out of', () => {
    const onCancel = vi.fn()
    render(<PagePicker onDone={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
