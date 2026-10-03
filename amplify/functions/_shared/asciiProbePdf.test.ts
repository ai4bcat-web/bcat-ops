/**
 * The two files that answer whether OTR's ingress mangles binary.
 *
 * They reject our PODs reporting 1,852,054 bytes of a 1,018,923-byte file — what those
 * bytes become after a UTF-8 decode and re-encode. Everything we control has been matched
 * to their documented example and the number has not moved.
 *
 * So: one PDF with no byte above 0x7F, which a UTF-8 round trip cannot alter, and one
 * identical document carrying high bytes, which it must. Both have to be REAL PDFs, or a
 * rejection says nothing — which is what these pin.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { asciiProbePdf, highByteProbePdf, jpegProbe } from './asciiProbePdf'

describe('asciiProbePdf', () => {
  it('contains no byte a UTF-8 round trip could change', () => {
    // The entire point. One high byte anywhere and the experiment proves nothing.
    const { bytes, highBytes } = asciiProbePdf()
    expect(highBytes).toBe(0)
    expect(bytes.every((b) => b < 0x80)) .toBe(true)
  })

  it('is a real, openable, single-page PDF', async () => {
    const doc = await PDFDocument.load(asciiProbePdf().bytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it('survives a UTF-8 round trip byte for byte', () => {
    // Demonstrated rather than asserted by reasoning: this is the file's whole job.
    const { bytes } = asciiProbePdf()
    const roundTripped = new TextEncoder().encode(new TextDecoder().decode(bytes))
    expect(roundTripped).toEqual(bytes)
  })

  it('writes a cross-reference table whose offsets point at the objects', () => {
    // Hand-assembled, so this is the part that would quietly rot.
    const text = new TextDecoder().decode(asciiProbePdf().bytes)
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
    const firstObj = Number(/\n(\d{10}) 00000 n/.exec(text)![1])
    expect(text.slice(firstObj, firstObj + 7)).toBe('1 0 obj')
  })
})

describe('highByteProbePdf', () => {
  it('carries high bytes, so a UTF-8 round trip has to change it', () => {
    const { bytes, highBytes } = highByteProbePdf()
    expect(highBytes).toBe(256)
    const roundTripped = new TextEncoder().encode(new TextDecoder().decode(bytes))
    expect(roundTripped.length).toBeGreaterThan(bytes.length)
  })

  it('is still a real, openable PDF', async () => {
    // The high bytes sit after %%EOF, so any reader still opens it. Only the byte count
    // can give it away — which is exactly what OTR's error reports.
    const doc = await PDFDocument.load(highByteProbePdf().bytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it('is small enough that a size mismatch cannot be anything else', () => {
    // Under a kilobyte: no chunking, no limits, no compression to explain a difference.
    expect(highByteProbePdf().bytes.length).toBeLessThan(2048)
    expect(asciiProbePdf().bytes.length).toBeLessThan(2048)
  })
})

describe('jpegProbe', () => {
  it('is a real JPEG, so a rejection means something', async () => {
    const { bytes } = jpegProbe()
    expect(bytes.subarray(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]))
    expect(bytes.subarray(bytes.length - 2)).toEqual(new Uint8Array([0xff, 0xd9]))
    // Decodable, not just correctly bracketed.
    const { Jimp } = await import('jimp')
    const img = await Jimp.read(Buffer.from(bytes))
    expect(img.bitmap.width).toBeGreaterThan(0)
  })

  it('is small enough that size cannot explain a failure', () => {
    expect(jpegProbe().bytes.length).toBeLessThan(2048)
  })
})
