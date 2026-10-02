/**
 * Getting photographs back out of a PDF.
 *
 * Most PODs reach us as a PDF — a phone wraps the photo in one, our own merge produces
 * one — and every one of them used to skip the cleanup entirely and go to the broker
 * exactly as it was taken. What matters here is the judgement, not the plumbing: a page
 * that is only a photograph is fair game, and a page a scanner app or a broker produced
 * must be left strictly alone, because our cleanup would make it worse.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { Jimp } from 'jimp'
import { extractPagePhotos, rebuildPdfWithPhotos } from './pdfPhotos'

/** A real JPEG, so pdf-lib parses a real header rather than a stub. */
async function jpeg(width = 600, height = 800): Promise<Buffer> {
  const img = new Jimp({ width, height, color: 0x8899aaff })
  return Buffer.from(await img.getBuffer('image/jpeg'))
}

async function png(width = 400, height = 500): Promise<Buffer> {
  const img = new Jimp({ width, height, color: 0x223344ff })
  return Buffer.from(await img.getBuffer('image/png'))
}

/** One page, one image, filling it — the shape a photographed POD actually has. */
async function photoPdf(image: Buffer, kind: 'jpg' | 'png' = 'jpg'): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const embedded = kind === 'jpg' ? await doc.embedJpg(image) : await doc.embedPng(image)
  const page = doc.addPage([612, 792])
  const scale = Math.min(612 / embedded.width, 792 / embedded.height)
  page.drawImage(embedded, {
    x: (612 - embedded.width * scale) / 2,
    y: (792 - embedded.height * scale) / 2,
    width: embedded.width * scale,
    height: embedded.height * scale,
  })
  return Buffer.from(await doc.save())
}

describe('extractPagePhotos', () => {
  it('finds the photograph on a page that is only a photograph', async () => {
    const found = await extractPagePhotos(await photoPdf(await jpeg()))
    expect(found).toHaveLength(1)
    expect(found[0].pageIndex).toBe(0)
    expect(found[0].contentType).toBe('image/jpeg')
    // The bytes are a real JPEG, ready to hand straight to the cleanup pipeline.
    expect(found[0].bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('rebuilds a PNG from the raw samples a flate-encoded image stores', async () => {
    const found = await extractPagePhotos(await photoPdf(await png(), 'png'))
    expect(found).toHaveLength(1)
    expect(found[0].contentType).toBe('image/png')
    const reread = await Jimp.read(found[0].bytes)
    expect(reread.bitmap.width).toBe(400)
    expect(reread.bitmap.height).toBe(500)
  })

  it('leaves a page with a text layer alone', async () => {
    // A scanner app's export is already deskewed and carries selectable text. Rasterizing
    // it through our cleanup would lose the text and add artefacts — strictly worse.
    const doc = await PDFDocument.create()
    const image = await doc.embedJpg(await jpeg())
    const page = doc.addPage([612, 792])
    page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
    page.drawText('DELIVERED 10/02 — RECEIVED BY J. SMITH', {
      x: 40, y: 60, size: 10,
      font: await doc.embedFont(StandardFonts.Helvetica),
      color: rgb(0, 0, 0),
    })
    expect(await extractPagePhotos(Buffer.from(await doc.save()))).toHaveLength(0)
  })

  it('ignores a logo or a signature rather than mistaking it for the document', async () => {
    // A full-resolution image stamped into a corner. Its own aspect ratio is exactly that
    // of a full-page photo, which is why coverage has to be measured from where it is
    // actually drawn rather than guessed from the image.
    const doc = await PDFDocument.create()
    const image = await doc.embedJpg(await jpeg())
    const page = doc.addPage([612, 792])
    page.drawImage(image, { x: 20, y: 700, width: 120, height: 60 })
    expect(await extractPagePhotos(Buffer.from(await doc.save()))).toHaveLength(0)
  })

  it('ignores a page that draws more than one image', async () => {
    // Two photos on a sheet is a contact sheet or a composed page, not a scan we should
    // be taking apart.
    const doc = await PDFDocument.create()
    const a = await doc.embedJpg(await jpeg())
    const page = doc.addPage([612, 792])
    page.drawImage(a, { x: 0, y: 400, width: 612, height: 392 })
    page.drawImage(a, { x: 0, y: 0, width: 612, height: 392 })
    expect(await extractPagePhotos(Buffer.from(await doc.save()))).toHaveLength(0)
  })

  it('returns nothing at all for a PDF with no images', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([612, 792]).drawText('Rate Confirmation', {
      x: 40, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Helvetica),
    })
    expect(await extractPagePhotos(Buffer.from(await doc.save()))).toHaveLength(0)
  })

  it('reports the page each photograph came off, across a multi-page document', async () => {
    const doc = await PDFDocument.create()
    const image = await doc.embedJpg(await jpeg())
    for (let i = 0; i < 3; i++) {
      const page = doc.addPage([612, 792])
      page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
    }
    const found = await extractPagePhotos(Buffer.from(await doc.save()))
    expect(found.map((f) => f.pageIndex)).toEqual([0, 1, 2])
  })
})

describe('rebuildPdfWithPhotos', () => {
  it('swaps in the cleaned page and copies the rest untouched', async () => {
    const doc = await PDFDocument.create()
    const image = await doc.embedJpg(await jpeg())
    for (let i = 0; i < 3; i++) {
      doc.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
    }
    const original = Buffer.from(await doc.save())

    const rebuilt = await rebuildPdfWithPhotos(
      original,
      new Map([[1, { bytes: await jpeg(), contentType: 'image/jpeg' }]]),
    )
    const out = await PDFDocument.load(rebuilt)
    // Page count is the contract: a cleanup that silently drops a page of a POD is worse
    // than no cleanup at all.
    expect(out.getPageCount()).toBe(3)
  })

  it('keeps every page when nothing was replaced', async () => {
    const original = await photoPdf(await jpeg())
    const out = await PDFDocument.load(await rebuildPdfWithPhotos(original, new Map()))
    expect(out.getPageCount()).toBe(1)
  })
})
