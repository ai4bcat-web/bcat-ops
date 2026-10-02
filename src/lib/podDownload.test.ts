// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { downloadPodAsPdf, pdfFileName } from './podDownload'

const saveBlob = vi.hoisted(() => vi.fn())
vi.mock('./download', () => ({ saveBlob }))

/** A real 2x1 PNG, so the embed path is genuinely exercised. */
function png(): Blob {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: 'image/png' })
}

async function realPdf(): Promise<Blob> {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  return new Blob([(await doc.save()) as BlobPart], { type: 'application/pdf' })
}

function mockFetch(blob: Blob, ok = true, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok, status, blob: async () => blob }) as never
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('pdfFileName', () => {
  it('replaces a known extension rather than appending to it', () => {
    // "POD.jpg.pdf" is what the old naming produced, and it is why nothing would open.
    expect(pdfFileName('POD.jpg')).toBe('POD.pdf')
    expect(pdfFileName('scan.PDF')).toBe('scan.pdf')
    expect(pdfFileName('image.heic')).toBe('image.pdf')
  })

  it('leaves an unfamiliar name alone apart from adding .pdf', () => {
    expect(pdfFileName('POD 14538 signed')).toBe('POD 14538 signed.pdf')
  })

  it('never produces a bare extension', () => {
    expect(pdfFileName('')).toBe('POD.pdf')
    expect(pdfFileName('.jpg')).toBe('POD.pdf')
  })
})

describe('downloadPodAsPdf', () => {
  it('wraps the enhanced JPEG in a real PDF, named .pdf', async () => {
    mockFetch(png())
    await downloadPodAsPdf('https://s3.test/enh.jpg', 'POD-14538.jpg')

    expect(saveBlob).toHaveBeenCalledTimes(1)
    const [blob, name] = saveBlob.mock.calls[0]
    expect(name).toBe('POD-14538.pdf')
    expect(blob.type).toBe('application/pdf')
    // A real, loadable PDF — not a renamed image.
    const reloaded = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()))
    expect(reloaded.getPageCount()).toBe(1)
  })

  it('passes an existing PDF through without re-encoding it', async () => {
    const original = await realPdf()
    mockFetch(original)
    await downloadPodAsPdf('https://s3.test/orig.pdf', 'POD.pdf')

    expect(saveBlob).toHaveBeenCalledWith(original, 'POD.pdf')
  })

  it('saves a format pdf-lib cannot embed under its own name', async () => {
    // A file that opens beats a PDF that does not exist.
    const heic = new Blob(['xx'], { type: 'image/heic' })
    mockFetch(heic)
    await downloadPodAsPdf('https://s3.test/x.heic', 'POD.heic')

    expect(saveBlob).toHaveBeenCalledWith(heic, 'POD.heic')
  })

  it('throws on a bad response so the caller can say so', async () => {
    mockFetch(png(), false, 403)
    await expect(downloadPodAsPdf('https://s3.test/x.jpg', 'POD.jpg')).rejects.toThrow('403')
    expect(saveBlob).not.toHaveBeenCalled()
  })
})

/**
 * "Failed to fetch" is what a browser says when a cross-origin fetch is stopped before it
 * starts — an extension, a proxy, a captive network. It names neither the cause nor the
 * fix, and it reads exactly like a broken button. The file is reachable; only our script's
 * attempt to read it was blocked.
 */
describe('when fetch itself is blocked', () => {
  it('hands the URL to the browser instead of failing', async () => {
    const click = vi.fn()
    const anchor = { href: '', target: '', rel: '', click, remove: vi.fn() } as unknown as HTMLAnchorElement
    vi.spyOn(document, 'createElement').mockReturnValueOnce(anchor)
    vi.spyOn(document.body, 'appendChild').mockImplementationOnce((n) => n)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(downloadPodAsPdf('https://s3.test/enhanced.pdf?sig=x', 'POD-1')).resolves.toBeUndefined()
    expect(anchor.href).toBe('https://s3.test/enhanced.pdf?sig=x')
    expect(click).toHaveBeenCalled()
  })

  it('still reports a real HTTP failure, which a person can act on', async () => {
    // An expired signature or a missing object is a different problem and must not be
    // silently turned into a new tab.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
    await expect(downloadPodAsPdf('https://s3.test/x.pdf', 'POD-1')).rejects.toThrow(/returned 403/)
  })
})
