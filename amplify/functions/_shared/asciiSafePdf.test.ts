import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFRawStream, PDFName, PDFArray } from 'pdf-lib'
import { toAsciiSafePdf, wrapImageInPdf } from './asciiSafePdf'
import { sniffDoc, withExt } from './sniffDoc'

/** A PDF with a real binary (Flate) image stream, like a scanned POD. */
async function makeBinaryPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([200, 200])
  // A PNG with high bytes in its compressed data, embedded as a Flate image stream.
  const png = await doc.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  page.drawImage(png, { x: 10, y: 10, width: 100, height: 100 })
  page.drawText('POD', { size: 24 })
  return doc.save({ useObjectStreams: false })
}

/** Exactly what OTR's endpoint does to the body: decode as UTF-8, re-encode. */
function otrRoundTrip(bytes: Uint8Array): Uint8Array {
  return new TextEncoder().encode(new TextDecoder('utf-8').decode(bytes))
}

describe('toAsciiSafePdf', () => {
  it('removes every high byte, so OTR cannot corrupt it', async () => {
    const raw = await makeBinaryPdf()
    expect([...raw].some((b) => b > 0x7f)).toBe(true) // the problem, demonstrated

    const { bytes, highBytes, streamsRewritten } = await toAsciiSafePdf(raw)

    expect(highBytes).toBe(0)
    expect(streamsRewritten).toBeGreaterThan(0)
    expect([...bytes].every((b) => b <= 0x7f)).toBe(true)
  })

  it('survives OTR’s UTF-8 round trip byte for byte, and still opens', async () => {
    const { bytes } = await toAsciiSafePdf(await makeBinaryPdf())

    const through = otrRoundTrip(bytes)
    expect(through.length).toBe(bytes.length)
    expect(Buffer.compare(Buffer.from(through), Buffer.from(bytes))).toBe(0)

    // The document is still readable on the far side — the only thing that matters to OTR.
    const reopened = await PDFDocument.load(through, { ignoreEncryption: true })
    expect(reopened.getPageCount()).toBe(1)
  })

  it('shows what the round trip does to an untreated PDF', async () => {
    /*
     * The control, and the reason OTR reported "Invalid or corrupt pdf format". pdf-lib is
     * lenient enough to still parse the wreckage, so the damage is asserted where it
     * actually lands: the image bytes, and the inflated length OTR quotes back at us.
     */
    const raw = await makeBinaryPdf()
    const through = otrRoundTrip(raw)
    expect(through.length).toBeGreaterThan(raw.length)

    const before = await PDFDocument.load(raw, { ignoreEncryption: true })
    const after = await PDFDocument.load(through, { ignoreEncryption: true })
    const streamBytes = (d: PDFDocument) =>
      d.context
        .enumerateIndirectObjects()
        .filter(([, o]) => o instanceof PDFRawStream)
        .map(([, o]) => Buffer.from((o as PDFRawStream).contents))

    const origs = streamBytes(before)
    const wrecked = streamBytes(after)
    expect(origs.length).toBeGreaterThan(0)
    // Not one stream comes through intact.
    expect(wrecked.some((b, i) => origs[i] && b.equals(origs[i]))).toBe(false)
  })

  it('recovers the original stream bytes exactly after the round trip', async () => {
    const raw = await makeBinaryPdf()
    const before = await PDFDocument.load(raw, { ignoreEncryption: true })
    const originals = before.context
      .enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFRawStream)
      .map(([, o]) => (o as PDFRawStream).contents)

    const { bytes } = await toAsciiSafePdf(raw)
    const after = await PDFDocument.load(otrRoundTrip(bytes), { ignoreEncryption: true })
    const streams = after.context
      .enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFRawStream)
      .map(([, o]) => o as PDFRawStream)

    expect(streams).toHaveLength(originals.length)
    streams.forEach((s, i) => {
      // ASCIIHexDecode must come first, or the reader un-filters in the wrong order.
      const filters = s.dict.lookup(PDFName.of('Filter'))
      const first = filters instanceof PDFArray ? filters.get(0) : filters
      expect(String(first)).toBe('/ASCIIHexDecode')

      const hex = Buffer.from(s.contents).toString('latin1').replace(/[^0-9a-fA-F]/g, '')
      expect(Buffer.from(hex, 'hex').equals(Buffer.from(originals[i]))).toBe(true)
    })
  })
})

describe('sniffDoc', () => {
  it('reads the real format rather than trusting the name', () => {
    expect(sniffDoc(Buffer.from('%PDF-1.7\n'))?.ext).toBe('pdf')
    expect(sniffDoc(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg')
    expect(sniffDoc(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext).toBe('png')
    expect(sniffDoc(Buffer.from('not a document'))).toBeNull()
  })

  it('renames a JPEG that was about to be sent as a PDF', () => {
    // The live bug: enhanced PODs can be .enhanced.jpg, and we named every upload .pdf.
    expect(withExt('POD-14538.pdf', 'jpg')).toBe('POD-14538.jpg')
    expect(withExt('POD-14538', 'pdf')).toBe('POD-14538.pdf')
  })
})

describe('wrapImageInPdf', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
    'base64',
  )

  it('turns an image into a one-page PDF at the scan’s own size', async () => {
    /*
     * OTR feeds everything to a PDF reader whatever we declare, so a JPEG POD must arrive
     * already wrapped. The page matches the image pixel for pixel — nothing resampled.
     */
    const out = await wrapImageInPdf(PNG, 'png')
    expect(Buffer.from(out.subarray(0, 4)).toString()).toBe('%PDF')

    const doc = await PDFDocument.load(out, { ignoreEncryption: true })
    expect(doc.getPageCount()).toBe(1)
    const page = doc.getPage(0)
    expect(page.getWidth()).toBe(8)
    expect(page.getHeight()).toBe(8)
  })

  it('produces something the ASCII-safe pass can then make survivable', async () => {
    // The two steps compose: wrap the image, then strip every high byte.
    const { bytes, highBytes } = await toAsciiSafePdf(await wrapImageInPdf(PNG, 'png'))
    expect(highBytes).toBe(0)
    const through = new TextEncoder().encode(new TextDecoder('utf-8').decode(bytes))
    expect(Buffer.compare(Buffer.from(through), Buffer.from(bytes))).toBe(0)
    expect((await PDFDocument.load(through, { ignoreEncryption: true })).getPageCount()).toBe(1)
  })
})
