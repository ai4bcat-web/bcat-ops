/**
 * The invoice and its PODs go out as one PDF: invoice first, every POD page after it, and a
 * POD that cannot be merged refuses the packet by name instead of vanishing from it.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { Jimp } from 'jimp'
import { deflateSync } from 'node:zlib'
import { PDFName, PDFRawStream } from 'pdf-lib'
import { combineInvoicePacket, compressionNote, packetPartKind, PodMergeError } from './invoicePacket'

async function pdf(pages: number, size: [number, number] = [612, 792]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage(size)
  return doc.save()
}

async function image(mime: 'image/jpeg' | 'image/png', width = 1200, height = 1600): Promise<Uint8Array> {
  const img = new Jimp({ width, height, color: 0x8899aaff })
  return new Uint8Array(await img.getBuffer(mime))
}

const invoice = async () => ({ name: 'Invoice 20027 PO1.pdf', bytes: await pdf(1, [612, 700]), contentType: 'application/pdf' })

describe('combineInvoicePacket', () => {
  it('puts the invoice first, then every page of every POD', async () => {
    const out = await combineInvoicePacket(await invoice(), [
      { name: 'POD stop 1.pdf', bytes: await pdf(2), contentType: 'application/pdf' },
      { name: 'POD stop 2.pdf', bytes: await pdf(1), contentType: 'application/pdf' },
    ])
    const merged = await PDFDocument.load(out.bytes)
    expect(merged.getPageCount()).toBe(4)
    // The invoice's own (700pt tall) page leads.
    expect(merged.getPage(0).getSize().height).toBe(700)
    expect(out.pages).toEqual([
      { name: 'Invoice 20027 PO1.pdf', pages: 1 },
      { name: 'POD stop 1.pdf', pages: 2 },
      { name: 'POD stop 2.pdf', pages: 1 },
    ])
  })

  it('turns a JPEG or PNG POD into a page scaled to fit a letter page', async () => {
    const out = await combineInvoicePacket(await invoice(), [
      { name: 'pod.jpg', bytes: await image('image/jpeg'), contentType: 'image/jpeg' },
      // Labelled octet-stream by a phone: the bytes decide.
      { name: 'pod', bytes: await image('image/png', 300, 200), contentType: 'application/octet-stream' },
    ])
    const merged = await PDFDocument.load(out.bytes)
    expect(merged.getPageCount()).toBe(3)
    const big = merged.getPage(1).getSize()
    expect(big.width).toBeLessThanOrEqual(612)
    expect(big.height).toBeLessThanOrEqual(792)
    expect(merged.getPage(2).getSize()).toEqual({ width: 300, height: 200 })
  })

  it('refuses the packet, naming the POD, when one cannot be merged', async () => {
    const heic = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])
    await expect(combineInvoicePacket(await invoice(), [{ name: 'IMG_0042.HEIC', bytes: heic, contentType: 'image/heic' }]))
      .rejects.toThrow(PodMergeError)
    await expect(combineInvoicePacket(await invoice(), [{ name: 'broken.pdf', bytes: new TextEncoder().encode('%PDF-1.4 garbage'), contentType: 'application/pdf' }]))
      .rejects.toThrow(/POD_MERGE_FAILED: The POD "broken.pdf"/)
  })
})

describe('packetPartKind', () => {
  it('reads the bytes before the label', async () => {
    expect(packetPartKind({ name: 'x.pdf', contentType: 'image/jpeg', bytes: await pdf(1) })).toBe('pdf')
    expect(packetPartKind({ name: 'x', contentType: '', bytes: await image('image/jpeg', 10, 10) })).toBe('jpg')
    expect(packetPartKind({ name: 'x.heic', contentType: 'image/heic', bytes: new Uint8Array([1, 2, 3, 4]) })).toBeNull()
  })
})

/** A one-page POD that is one big lossless picture (the 14918 shape: Preview wrapping a screenshot). */
async function bigScanPod(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const w = 2400
  const h = 1800
  const raw = new Uint8Array(w * h * 3)
  let seed = 5
  for (let i = 0; i < raw.length; i += 1) { seed = (seed * 1664525 + 1013904223) >>> 0; raw[i] = (((i / 3) % w) / 9 + Math.floor(i / 3 / w) / 11 + (seed >>> 29)) & 0xff }
  const stream = PDFRawStream.of(doc.context.obj({
    Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode',
  }) as never, deflateSync(raw))
  page.node.newXObject('Im1', doc.context.register(stream))
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 612 0 0 459 0 166 cm /Im1 Do Q')))
  return doc.save({ useObjectStreams: false })
}

describe('combineInvoicePacket: a POD too big for one e-mail', () => {
  it('lightens the POD picture in the packet only when the packet is over the limit, and says which POD', async () => {
    const pod = await bigScanPod()
    expect(pod.byteLength).toBeGreaterThan(3_000_000)
    const part = { name: '14918 POD.pdf', bytes: pod, contentType: 'application/pdf' }
    const before = new Uint8Array(pod)

    const plain = await combineInvoicePacket(await invoice(), [part])
    expect(plain.bytes.byteLength).toBeGreaterThan(3_000_000)
    expect(plain.compressed).toBeUndefined()

    const lighter = await combineInvoicePacket(await invoice(), [part], { shrinkAbove: 2_000_000 })
    expect(lighter.bytes.byteLength).toBeLessThan(plain.bytes.byteLength / 3)
    expect(lighter.compressed).toHaveLength(1)
    expect(lighter.compressed![0]).toMatchObject({ name: '14918 POD.pdf', before: pod.byteLength })
    expect(lighter.pages).toEqual([{ name: 'Invoice 20027 PO1.pdf', pages: 1 }, { name: '14918 POD.pdf', pages: 1 }])
    expect((await PDFDocument.load(lighter.bytes)).getPageCount()).toBe(2)
    // the POD passed in (the one kept in the shipment) is untouched
    expect(part.bytes).toBe(pod)
    expect(Buffer.compare(Buffer.from(pod), Buffer.from(before))).toBe(0)
    expect(compressionNote(lighter.compressed)).toMatch(/14918 POD\.pdf compressed from \d+\.\d MB to \d+\.\d MB for e-mail/)
  }, 60_000)

  it('does nothing when the packet already fits, and says nothing', async () => {
    const part = { name: 'POD.pdf', bytes: await pdf(1), contentType: 'application/pdf' }
    const out = await combineInvoicePacket(await invoice(), [part], { shrinkAbove: 8 * 1024 * 1024 })
    expect(out.compressed).toBeUndefined()
    expect(compressionNote(out.compressed)).toBeNull()
  })
})
