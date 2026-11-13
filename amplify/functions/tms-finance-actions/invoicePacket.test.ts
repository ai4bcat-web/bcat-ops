/**
 * The invoice and its PODs go out as one PDF: invoice first, every POD page after it, and a
 * POD that cannot be merged refuses the packet by name instead of vanishing from it.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { Jimp } from 'jimp'
import { combineInvoicePacket, packetPartKind, PodMergeError } from './invoicePacket'

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
