import { describe, expect, it } from 'vitest'
import { Jimp } from 'jimp'
import { PDFDocument } from 'pdf-lib'
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { deflateSync } from 'node:zlib'
import { PDFName, PDFRawStream } from 'pdf-lib'
import { conversionFields, convertStoredPodImage, exifOrientation, imageToPdf, isNonPdfImage, isPodImage, lightenImage, pdfKeyFor, pdfNameFor, shouldShrinkPdf, smallPdfKeyFor } from './podPdf'

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
    expect(isPodImage('image/tiff')).toBe(true)
    expect(isPodImage('image/gif')).toBe(true)
    expect(isNonPdfImage('image/heic')).toBe(true)
    expect(pdfKeyFor('driver-docs/d1/IMG_1.HEIC')).toBe('driver-docs/d1/IMG_1.pdf')
    expect(pdfNameFor('scan.tiff')).toBe('scan.pdf')
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

  it('decodes a TIFF and a GIF onto a letter page', async () => {
    for (const mime of ['image/tiff', 'image/gif'] as const) {
      const img = new Jimp({ width: 60, height: 40, color: 0x996633ff })
      const bytes = await img.getBuffer(mime)
      const pdf = await PDFDocument.load(await imageToPdf(bytes, mime))
      expect(pdf.getPageCount()).toBe(1)
      const { width, height } = pdf.getPage(0).getSize()
      expect(width).toBeGreaterThan(height) // landscape picture, landscape page
    }
  })

  it('stores the PDF where asked, keeps the original key, and reports the fields a row takes', async () => {
    const photo = await jpeg(20, 30)
    const puts: { Key?: string; ContentType?: string }[] = []
    const s3 = { send: async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new Uint8Array(photo) } }
      if (cmd instanceof PutObjectCommand) { puts.push(cmd.input); return {} }
      throw new Error('unexpected')
    } } as unknown as S3Client
    const out = await convertStoredPodImage(s3, 'b', {
      key: 'driver-docs/d1/image.jpg', contentType: 'image/jpeg', name: 'image.jpg', destKey: 'shipment-docs/s1/sdoc-1-image.pdf',
    })
    expect(out?.key).toBe('shipment-docs/s1/sdoc-1-image.pdf')
    expect(out?.name).toBe('image.pdf')
    expect(puts[0]).toMatchObject({ Key: 'shipment-docs/s1/sdoc-1-image.pdf', ContentType: 'application/pdf' })
    expect(conversionFields('image/jpeg', out)).toEqual({ originalS3Key: 'driver-docs/d1/image.jpg', originalContentType: 'image/jpeg', pdfConversion: 'CONVERTED' })
  })

  it('a picture that cannot be read keeps the original and is marked FAILED; a PDF is left alone', async () => {
    const s3 = { send: async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }
      throw new Error('no put expected')
    } } as unknown as S3Client
    const out = await convertStoredPodImage(s3, 'b', { key: 'k.jpg', contentType: 'image/jpeg', name: 'k.jpg' })
    expect(out).toBeNull()
    expect(conversionFields('image/jpeg', out)).toEqual({ pdfConversion: 'FAILED' })
    expect(conversionFields('image/heic', null)).toEqual({ pdfConversion: 'FAILED' })
    expect(conversionFields('application/pdf', null)).toEqual({})
  })

  it('lightens a big photo before wrapping it, and leaves a small one alone', async () => {
    const small = await jpeg(300, 200)
    expect(await lightenImage(small, 'image/jpeg')).toBeNull()
    // A noisy 3000 x 2000 PNG is several MB: it comes out as a JPEG no longer than 2000 px on its long side.
    const big = new Jimp({ width: 3000, height: 2000, color: 0x336699ff })
    let seed = 7
    for (let y = 0; y < 2000; y += 1) {
      for (let x = 0; x < 3000; x += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        big.setPixelColor(((seed >>> 8) | 0xff) >>> 0, x, y)
      }
    }
    const png = await big.getBuffer('image/png')
    expect(png.length).toBeGreaterThan(1_000_000)
    const light = await lightenImage(png, 'image/png')
    expect(light).not.toBeNull()
    expect(light!.length).toBeLessThan(png.length / 3)
    const back = await Jimp.read(Buffer.from(light!))
    expect(Math.max(back.width, back.height)).toBe(2000)
    // and the PDF made from it is small
    const pdf = await imageToPdf(png, 'image/png')
    expect(pdf.length).toBeLessThan(png.length / 3)
  }, 60_000)

  it('shrinks a big POD that is already a PDF, next to the original, and says so on the row', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const w = 2400
    const h = 1800
    const raw = new Uint8Array(w * h * 3)
    let seed = 3
    // a smooth picture with grain: big when stored losslessly, small as a JPEG (pure noise would not shrink)
    for (let i = 0; i < raw.length; i += 1) { seed = (seed * 1664525 + 1013904223) >>> 0; raw[i] = (((i / 3) % w) / 9 + Math.floor(i / 3 / w) / 11 + (seed >>> 29)) & 0xff }
    const image = PDFRawStream.of(doc.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode',
    }) as never, deflateSync(raw))
    page.node.newXObject('Im1', doc.context.register(image))
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 612 0 0 459 0 166 cm /Im1 Do Q')))
    const original = await doc.save({ useObjectStreams: false })
    expect(shouldShrinkPdf('application/pdf', 'POD', original.length)).toBe(true)
    expect(shouldShrinkPdf('application/pdf', 'BOL', original.length)).toBe(false)
    expect(shouldShrinkPdf('application/pdf', 'POD', 100_000)).toBe(false)
    expect(shouldShrinkPdf('image/jpeg', 'POD', original.length)).toBe(false)
    expect(smallPdfKeyFor('shipment-docs/s1/sdoc-1-pod.pdf')).toBe('shipment-docs/s1/sdoc-1-pod-small.pdf')
    const puts: unknown[] = []
    const s3 = { send: async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => original } }
      if (cmd instanceof PutObjectCommand) { puts.push(cmd.input); return {} }
      throw new Error('unexpected')
    } } as unknown as S3Client
    const out = await convertStoredPodImage(s3, 'b', { key: 'shipment-docs/s1/sdoc-1-pod.pdf', contentType: 'application/pdf', name: 'POD.pdf', type: 'POD', sizeBytes: original.length })
    expect(out?.key).toBe('shipment-docs/s1/sdoc-1-pod-small.pdf')
    expect(out!.sizeBytes).toBeLessThan(original.length / 4)
    expect(puts).toHaveLength(1)
    // the original object is never overwritten
    expect(puts[0]).toMatchObject({ Key: 'shipment-docs/s1/sdoc-1-pod-small.pdf' })
    expect(conversionFields('application/pdf', out)).toEqual({ originalS3Key: 'shipment-docs/s1/sdoc-1-pod.pdf', originalContentType: 'application/pdf', pdfConversion: 'COMPRESSED' })
    // a document type that is not a POD or rate confirmation is left alone
    expect(await convertStoredPodImage(s3, 'b', { key: 'k.pdf', contentType: 'application/pdf', name: 'BOL.pdf', type: 'BOL', sizeBytes: original.length })).toBeNull()
  }, 60_000)
})
