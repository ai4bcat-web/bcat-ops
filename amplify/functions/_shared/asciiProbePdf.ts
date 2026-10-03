/**
 * A minimal PDF built entirely from bytes below 0x80, and a twin that is identical except
 * for a run of high bytes.
 *
 * OTR rejects our PODs reporting a byte count 1.82x the file we send — exactly what those
 * bytes become after a UTF-8 decode and re-encode. Everything we control has been matched
 * to their documented example and the number has not moved, so the remaining question is
 * whether their ingress mangles binary at all. These two files answer it: the ASCII one
 * survives a UTF-8 round trip unchanged by construction, the other cannot.
 *
 * Written by hand rather than with pdf-lib because pdf-lib emits a binary marker comment
 * (four bytes >= 0x80) immediately after the header, which is the very thing being tested.
 * Offsets are computed as the file is assembled, so the xref table is correct.
 */

/** Page content: one line of text, so the file is a real document and not a stub. */
function contentStream(text: string): string {
  return `BT /F1 18 Tf 72 700 Td (${text}) Tj ET\n`
}

export interface ProbePdf {
  bytes: Uint8Array
  fileName: string
  /** How many bytes are >= 0x80. The ASCII probe's whole point is that this is zero. */
  highBytes: number
}

function countHighBytes(bytes: Uint8Array): number {
  let n = 0
  for (const b of bytes) if (b >= 0x80) n++
  return n
}

/**
 * Build a valid single-page PDF from `objects`, computing the cross-reference offsets.
 * `trailerExtra` lets the caller append a comment after %%EOF without disturbing them.
 */
function assemble(objects: string[], tail = ''): Uint8Array {
  const header = '%PDF-1.4\n'
  let body = ''
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(header.length + body.length)
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefStart = header.length + body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`

  return new TextEncoder().encode(header + body + xref + trailer + tail)
}

function pageObjects(text: string): string[] {
  const stream = contentStream(text)
  return [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
}

/** Every byte below 0x80. A UTF-8 round trip cannot change it. */
export function asciiProbePdf(): ProbePdf {
  const bytes = assemble(pageObjects('BCAT ASCII probe - no byte above 7F'))
  return { bytes, fileName: 'bcat-ascii-probe.pdf', highBytes: countHighBytes(bytes) }
}

/**
 * The same document with a trailing comment of high bytes — the identical content, in a
 * file a UTF-8 round trip must corrupt. Appended AFTER %%EOF so the PDF stays valid and
 * every reader still opens it; only the byte count can give it away.
 */
export function highByteProbePdf(): ProbePdf {
  const marker = Array.from({ length: 256 }, (_, i) => 0x80 + (i % 0x80))
  const base = assemble(pageObjects('BCAT high-byte probe'), '%')
  const bytes = new Uint8Array(base.length + marker.length + 1)
  bytes.set(base)
  bytes.set(marker, base.length)
  bytes[bytes.length - 1] = 0x0a
  return { bytes, fileName: 'bcat-highbyte-probe.pdf', highBytes: countHighBytes(bytes) }
}

/**
 * A tiny, valid JPEG.
 *
 * OTR's documentation says the endpoint takes PDF, PNG or JPEG. Every failure so far has
 * been a PDF, and the one that got furthest died inside IronPDF — their PDF reader. If an
 * image lands where a PDF does not, that is both an answer and a way through: the cleanup
 * pipeline already produces a JPEG per page, so a POD could go up as images.
 *
 * Hand-assembled rather than drawn, so it is a few hundred bytes and has no dependency.
 */
export function jpegProbe(): ProbePdf {
  // A 1x1 baseline JPEG: SOI, APP0/JFIF, quantisation, frame, Huffman, scan, EOI.
  const base64 =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIi' +
    'EmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9PjsBCgsLDg0OHBAQHDsoIig7Ozs7Ozs7Ozs7Ozs7' +
    'Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O//AABEIAAgACAMBEQACEQEDEQH/xA' +
    'GiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFB' +
    'BhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVl' +
    'dYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TF' +
    'xsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBg' +
    'cICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEK' +
    'FiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFho' +
    'eIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery' +
    '8/T19vf4+fr/2gAMAwEAAhEDEQA/APP6AP8A/9k='
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
  let high = 0
  for (const b of bytes) if (b >= 0x80) high++
  return { bytes, fileName: 'bcat-probe.jpg', highBytes: high }
}
