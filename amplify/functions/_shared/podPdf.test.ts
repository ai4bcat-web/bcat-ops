import { describe, expect, it } from 'vitest'
import { Jimp } from 'jimp'
import { PDFDocument } from 'pdf-lib'
import { exifOrientation, imageToPdf, isPodImage, pdfKeyFor, pdfNameFor } from './podPdf'

async function jpeg(w: number, h: number): Promise<Buffer> {
  const img = new Jimp({ width: w, height: h, color: 0x336699ff })
  return img.getBuffer('image/jpeg')
}

/** Insert an EXIF APP1 segment (big-endian TIFF) carrying just the orientation tag right after the JPEG's SOI. */
function withOrientation(bytes: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // tag 0x0112, SHORT, count 1, value
    0x00, 0x00, 0x00, 0x00, // next IFD
  ])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])
  const len = payload.length + 2
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]), payload])
  return Buffer.concat([bytes.subarray(0, 2), seg, bytes.subarray(2)])
}

describe('podPdf', () => {
  it('names and keys', () => {
    expect(isPodImage('IMAGE/JPEG')).toBe(true)
    expect(isPodImage('application/pdf')).toBe(false)
    expect(isPodImage('image/webp')).toBe(false)
    expect(pdfKeyFor('shipment-docs/s1/pod-1.JPG')).toBe('shipment-docs/s1/pod-1.pdf')
    expect(pdfKeyFor('shipment-docs/s1/pod-1')).toBe('shipment-docs/s1/pod-1.pdf')
    expect(pdfNameFor('POD 20018.jpeg')).toBe('POD 20018.pdf')
  })

  it('reads the EXIF orientation, and 1 when there is none', async () => {
    const plain = await jpeg(8, 4)
    expect(exifOrientation(plain)).toBe(1)
    expect(exifOrientation(withOrientation(plain, 6))).toBe(6)
    expect(exifOrientation(Buffer.from('not a jpeg'))).toBe(1)
  })

  it('wraps a landscape photo on one landscape letter page and a portrait one on a portrait page', async () => {
    const wide = await PDFDocument.load(await imageToPdf(await jpeg(128, 64), 'image/jpeg', 'wide'))
    expect(wide.getPageCount()).toBe(1)
    expect(wide.getPage(0).getSize()).toEqual({ width: 792, height: 612 })
    const tall = await PDFDocument.load(await imageToPdf(await jpeg(64, 128), 'image/jpeg'))
    expect(tall.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
  })

  it('a photo stored sideways (EXIF 6) lands on a portrait page', async () => {
    const stored = withOrientation(await jpeg(128, 64), 6) // stored landscape, shown upright it is portrait
    const doc = await PDFDocument.load(await imageToPdf(stored, 'image/jpeg'))
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
  })

  it('copes with a small pooled Buffer (its ArrayBuffer is shared and offset)', async () => {
    const small = Buffer.from(await jpeg(8, 8)) // small buffers come from Node's shared pool
    const doc = await PDFDocument.load(await imageToPdf(small, 'image/jpeg'))
    expect(doc.getPageCount()).toBe(1)
  })

  it('wraps a PNG too', async () => {
    const png = await new Jimp({ width: 10, height: 10, color: 0xffffffff }).getBuffer('image/png')
    const doc = await PDFDocument.load(await imageToPdf(png, 'image/png'))
    expect(doc.getPageCount()).toBe(1)
  })
})
