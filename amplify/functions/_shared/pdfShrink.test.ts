import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { shrinkPdfImages } from './pdfShrink'

/** A busy, hard-to-compress RGB picture (a photo's worth of noise over a gradient). */
function noisyRgb(w: number, h: number): Uint8Array {
  const raw = new Uint8Array(w * h * 3)
  let seed = 12345
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const o = (y * w + x) * 3
      raw[o] = ((x * 255) / w + (seed >>> 24) / 4) & 0xff
      raw[o + 1] = ((y * 255) / h + ((seed >>> 16) & 0xff) / 4) & 0xff
      raw[o + 2] = (((x + y) * 255) / (w + h) + ((seed >>> 8) & 0xff) / 4) & 0xff
    }
  }
  return raw
}

/** What macOS Preview wrote for 14918: one lossless Flate picture, no predictor, filling a letter page. */
async function bigScanPdf(w: number, h: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const image = PDFRawStream.of(doc.context.obj({
    Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode',
  }) as never, deflateSync(noisyRgb(w, h)))
  const ref = doc.context.register(image)
  page.node.newXObject('Im1', ref)
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 612 0 0 459 0 166 cm /Im1 Do Q')))
  return doc.save({ useObjectStreams: false })
}

function imagesOf(doc: PDFDocument): { width: number; filter: string }[] {
  const out: { width: number; filter: string }[] = []
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      out.push({ width: Number(String(obj.dict.get(PDFName.of('Width')))), filter: String(obj.dict.get(PDFName.of('Filter'))) })
    }
  }
  return out
}

describe('shrinkPdfImages', () => {
  it('shrinks a big lossless one-page scan to a few hundred KB and keeps the page', async () => {
    const original = await bigScanPdf(2800, 2100)
    expect(original.byteLength).toBeGreaterThan(10_000_000)
    const result = await shrinkPdfImages(original)
    expect(result.changed).toBe(true)
    expect(result.images).toBe(1)
    expect(result.after).toBeLessThan(result.before / 8)
    expect(result.after).toBeLessThan(2_000_000)
    const reloaded = await PDFDocument.load(result.bytes)
    expect(reloaded.getPageCount()).toBe(1)
    expect(imagesOf(reloaded)).toEqual([{ width: 2000, filter: '/DCTDecode' }])
  }, 60_000)

  it('leaves a PDF with only small pictures exactly as it came', async () => {
    const original = await bigScanPdf(120, 90)
    const result = await shrinkPdfImages(original)
    expect(result.changed).toBe(false)
    expect(result.bytes).toBe(original)
  })

  it('hands back the original bytes for something that is not a PDF', async () => {
    const junk = new Uint8Array([1, 2, 3, 4])
    const result = await shrinkPdfImages(junk)
    expect(result.changed).toBe(false)
    expect(result.bytes).toBe(junk)
  })

  it('the harder pass makes it smaller still', async () => {
    const original = await bigScanPdf(2800, 2100)
    const soft = await shrinkPdfImages(original)
    const hard = await shrinkPdfImages(original, { maxSide: 1500, quality: 62 })
    expect(hard.after).toBeLessThan(soft.after)
  }, 60_000)
})
