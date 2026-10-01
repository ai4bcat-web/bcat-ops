import { describe, it, expect } from 'vitest'
import { PDFDocument, rgb } from 'pdf-lib'
import { pagesToPdf, fitWithin, combinedFileName, type SourcePage } from './pagesToPdf'

/** A real one-page PDF, so the merge path is exercised rather than mocked. */
async function pdfPage(pages = 1): Promise<Blob> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792])
    p.drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(0, 0, 0) })
  }
  return new Blob([(await doc.save()) as BlobPart], { type: 'application/pdf' })
}

/** A real 2x1 PNG — pdf-lib parses the header, so bytes must be valid. */
function pngPage(): Blob {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: 'image/png' })
}

const src = (fileName: string, contentType: string, blob: Blob): SourcePage => ({
  fileName, contentType, blob,
})

describe('fitWithin', () => {
  it('scales to fit and centres, preserving aspect ratio', () => {
    // A tall portrait photo must not be stretched to the page.
    const box = fitWithin(1000, 2000)
    expect(box.height).toBeCloseTo(792)
    expect(box.width).toBeCloseTo(396)
    expect(box.x).toBeCloseTo((612 - 396) / 2)
    expect(box.y).toBeCloseTo(0)
  })

  it('fills the page rather than dividing by zero on a bad image', () => {
    expect(fitWithin(0, 0)).toEqual({ width: 612, height: 792, x: 0, y: 0 })
  })
})

describe('combinedFileName', () => {
  it('dates the file so a folder of PODs sorts', () => {
    const d = new Date('2026-10-01T15:00:00Z')
    expect(combinedFileName('POD', d)).toBe('POD-2026-10-01.pdf')
    expect(combinedFileName('RATECON', d)).toBe('RateCon-2026-10-01.pdf')
  })
})

describe('pagesToPdf', () => {
  it('returns null when there is nothing to combine', async () => {
    expect(await pagesToPdf([], 'POD')).toBeNull()
  })

  it('combines several photos into one PDF, one page each', async () => {
    const out = await pagesToPdf(
      [
        src('a.png', 'image/png', pngPage()),
        src('b.png', 'image/png', pngPage()),
        src('c.png', 'image/png', pngPage()),
      ],
      'POD',
      new Date('2026-10-01T00:00:00Z'),
    )
    expect(out).not.toBeNull()
    expect(out!.contentType).toBe('application/pdf')
    expect(out!.fileName).toBe('POD-2026-10-01.pdf')
    expect(out!.pageCount).toBe(3)

    // It is a real, loadable PDF — not just a blob with the right mime type.
    const reloaded = await PDFDocument.load(new Uint8Array(await out!.blob.arrayBuffer()))
    expect(reloaded.getPageCount()).toBe(3)
  })

  it('passes a lone PDF through untouched rather than re-encoding it', async () => {
    const original = await pdfPage(2)
    const out = await pagesToPdf([src('broker.pdf', 'application/pdf', original)], 'POD')
    expect(out!.blob).toBe(original)          // same object — no re-encode
    expect(out!.fileName).toBe('broker.pdf')  // keeps its own name
    expect(out!.pageCount).toBe(2)
  })

  it('merges a multi-page PDF with photos, keeping every page', async () => {
    const out = await pagesToPdf(
      [
        src('scan.png', 'image/png', pngPage()),
        src('broker.pdf', 'application/pdf', await pdfPage(3)),
        src('last.png', 'image/png', pngPage()),
      ],
      'POD',
    )
    // 1 photo + 3 PDF pages + 1 photo
    expect(out!.pageCount).toBe(5)
  })

  it('treats a .pdf filename as a PDF even when the type is generic', async () => {
    const out = await pagesToPdf(
      [src('paperwork.pdf', 'application/octet-stream', await pdfPage(2))],
      'POD',
    )
    expect(out!.pageCount).toBe(2)
  })
})
