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

// The real camera needs a media pipeline jsdom does not have. This stand-in exposes the
// two things the picker wires: a captured page, and Done pressed from inside the camera.
vi.mock('./ScanCamera', () => ({
  ScanCamera: (props: { onCapture: (p: unknown) => void; onDone?: (p: unknown) => void; captured?: number }) => (
    <div data-testid="camera">
      <span>captured {props.captured ?? 0}</span>
      <button type="button" onClick={() => props.onCapture({ fileName: 'shot-1.jpg', contentType: 'image/jpeg', byteSize: 10, blob: new Blob(['a']) })}>cam-add</button>
      <button type="button" onClick={() => props.onDone?.({ fileName: 'shot-2.jpg', contentType: 'image/jpeg', byteSize: 10, blob: new Blob(['b']) })}>cam-done-with-page</button>
      <button type="button" onClick={() => props.onDone?.(null)}>cam-done</button>
    </div>
  ),
}))

// preparePage normalizes images through a canvas, which jsdom cannot do.
vi.mock('./imagePrep', () => ({
  // prepareFile decides for itself whether a file can be downscaled, and falls back to the
  // original when it cannot — the picker only has to keep what it is handed.
  prepareFile: vi.fn(async (file: File) => ({
    fileName: file.name,
    contentType: file.type || 'image/jpeg',
    byteSize: file.size,
    blob: file,
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

  it('still points at a phone scanner app, which reads best of all', () => {
    render(<PagePicker onDone={vi.fn()} />)
    expect(screen.getByText(/Already scanned it with Notes or Google Drive/i)).toBeInTheDocument()
  })

  it('offers scanning with the camera as well as uploading', () => {
    render(<PagePicker onDone={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Scan it with the camera/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upload the document/i })).toBeInTheDocument()
  })

  it('leads with Upload — a page already scanned elsewhere is the best version there is', () => {
    const { container } = render(<PagePicker onDone={vi.fn()} />)
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '')
    const upload = labels.findIndex((t) => /Upload the document/i.test(t))
    const scan = labels.findIndex((t) => /Scan it with the camera/i.test(t))
    expect(upload).toBeGreaterThanOrEqual(0)
    expect(scan).toBeGreaterThan(upload)
  })

  it('does not open the camera until it is asked to', () => {
    // getUserMedia on mount would prompt for the camera on a screen the driver may only
    // be passing through, and a denied prompt is remembered by the browser.
    render(<PagePicker onDone={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Take the photo/i })).toBeNull()
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

  it('Done inside the camera sends every page, including the shot on screen', async () => {
    const onDone = vi.fn()
    render(<PagePicker onDone={onDone} onCancel={vi.fn()} busy={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Scan it with the camera/ }))
    fireEvent.click(screen.getByText('cam-add'))
    await waitFor(() => expect(screen.getByText('captured 1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('cam-done-with-page'))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(onDone.mock.calls[0][0].map((p: { fileName: string }) => p.fileName)).toEqual(['shot-1.jpg', 'shot-2.jpg'])
    expect(screen.queryByTestId('camera')).toBeNull()
  })

  it('Done inside the camera with nothing in hand sends nothing', () => {
    const onDone = vi.fn()
    render(<PagePicker onDone={onDone} onCancel={vi.fn()} busy={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Scan it with the camera/ }))
    fireEvent.click(screen.getByText('cam-done'))
    expect(onDone).not.toHaveBeenCalled()
  })

  it('can be backed out of', () => {
    const onCancel = vi.fn()
    render(<PagePicker onDone={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
