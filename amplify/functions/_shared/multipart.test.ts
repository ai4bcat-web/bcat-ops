/**
 * Every document we have ever sent OTR has been rejected — a null reference, or a byte
 * count matching nothing anyone sent. Handing `fetch` a FormData makes undici STREAM the
 * body: Transfer-Encoding chunked, no Content-Length. That is legal HTTP and plenty of
 * .NET parsers handle it badly, which is the last thing on our side we had not changed.
 *
 * These pin the encoding, because a multipart body assembled by hand is exactly the thing
 * that rots quietly: one wrong CRLF and a server sees a filename as file content.
 */
import { describe, it, expect } from 'vitest'
import { buildMultipart } from './multipart'

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x80, 0x00, 0xfe])

function asText(b: Buffer): string {
  return b.toString('latin1')
}

describe('buildMultipart', () => {
  it('carries the file byte for byte', () => {
    // The failure that started all this: OTR opened 1,852,054 bytes of a 1,018,923-byte
    // PDF. Nothing in here may touch the bytes.
    const { body } = buildMultipart([{ name: 'file', fileName: 'pod.pdf', bytes: PDF }])
    const start = body.indexOf(Buffer.from(PDF))
    expect(start).toBeGreaterThan(-1)
    expect(body.subarray(start, start + PDF.length)).toEqual(Buffer.from(PDF))
  })

  it('copies only the view it was given, not its backing buffer', () => {
    const backing = new Uint8Array([0xaa, 0xbb, 0x25, 0x50, 0x44, 0x46, 0xcc, 0xdd])
    const { body } = buildMultipart([
      { name: 'file', fileName: 'x.pdf', bytes: backing.subarray(2, 6) },
    ])
    expect(body.includes(Buffer.from([0xaa, 0xbb]))).toBe(false)
    expect(body.includes(Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBe(true)
  })

  it('keeps the parts in the order they were given', () => {
    // A streaming parser that wants the invoice id before it consumes the file will not
    // find it if the file comes last.
    const { body } = buildMultipart([
      { name: 'file', fileName: 'pod.pdf', bytes: PDF },
      { name: 'DocumentType', value: 'invoice-file-upload' },
      { name: 'invoiceid', value: '16222565' },
    ])
    const text = asText(body)
    expect(text.indexOf('name="file"')).toBeLessThan(text.indexOf('name="DocumentType"'))
    expect(text.indexOf('name="DocumentType"')).toBeLessThan(text.indexOf('name="invoiceid"'))
  })

  it('separates every header and part with CRLF, as the format requires', () => {
    const { body, boundary } = buildMultipart([{ name: 'invoiceid', value: '1' }])
    const text = asText(body)
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true)
    expect(text).toContain('Content-Disposition: form-data; name="invoiceid"\r\n\r\n1\r\n')
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true)
  })

  it('omits the part type when none is given, as OTR’s own example does', () => {
    const { body } = buildMultipart([{ name: 'file', fileName: 'pod.pdf', bytes: PDF }])
    expect(asText(body)).not.toContain('Content-Type:')
  })

  it('includes it when one is given', () => {
    const { body } = buildMultipart([
      { name: 'file', fileName: 'pod.pdf', contentType: 'application/pdf', bytes: PDF },
    ])
    expect(asText(body)).toContain('Content-Type: application/pdf\r\n')
  })

  it('announces the boundary it actually used', () => {
    const { contentType, boundary } = buildMultipart([{ name: 'a', value: 'b' }])
    expect(contentType).toBe(`multipart/form-data; boundary=${boundary}`)
    // Nothing in a PDF can collide with it.
    expect(boundary).toMatch(/^----BCATFormBoundary[0-9a-f]{24}$/)
  })

  it('cannot have a filename end the header early', () => {
    const { body } = buildMultipart([
      { name: 'file', fileName: 'po"d\r\n.pdf', bytes: PDF },
    ])
    expect(asText(body)).toContain('filename="po_d__.pdf"')
  })
})
