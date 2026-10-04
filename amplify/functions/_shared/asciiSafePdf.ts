/**
 * Rewrite a PDF so every byte is ASCII (0x00–0x7F).
 *
 * WHY THIS EXISTS
 *
 * OTR's /documents/upload decodes the body as UTF-8 text and re-encodes it before their
 * PDF reader sees it. Measured, not guessed: a 614-byte JPEG came back reported as exactly
 * 976 bytes (433 ASCII + 181 high bytes × 3), and PRO 14538's 1,018,923-byte POD came back
 * as 1,852,054 against a predicted 1,860,973 — the signature of `Encoding.UTF8.GetString`
 * followed by `GetBytes`, where every byte that is not valid UTF-8 becomes U+FFFD (3 bytes).
 *
 * That round trip is LOSSLESS for bytes 0x00–0x7F. So a PDF containing no high bytes
 * arrives byte-for-byte intact even through their defect. Every stream is re-encoded with
 * /ASCIIHexDecode — a filter in the PDF spec since 1.0, which their reader must support —
 * and the binary sniff comment in the header is dropped.
 *
 * Costs roughly 2× the size. That is the price of getting a document through at all, and
 * it should be deleted the day OTR stops mangling bodies.
 */
import { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber } from 'pdf-lib'

const HEX = '0123456789abcdef'

/** PDF ASCIIHexDecode: two hex digits per byte, terminated by '>'. */
function asciiHex(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 2 + 1)
  let i = 0
  for (let n = 0; n < bytes.length; n += 1) {
    const b = bytes[n]
    out[i] = HEX.charCodeAt(b >> 4)
    out[i + 1] = HEX.charCodeAt(b & 0x0f)
    i += 2
  }
  out[i] = 0x3e // '>'
  return out
}

export interface AsciiSafeResult {
  bytes: Uint8Array
  /** High bytes left over. Zero means the document survives a UTF-8 round trip intact. */
  highBytes: number
  streamsRewritten: number
}

export async function toAsciiSafePdf(input: Uint8Array): Promise<AsciiSafeResult> {
  const doc = await PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false })
  let streamsRewritten = 0

  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const encoded = asciiHex(obj.contents)
    const dict = obj.dict

    /*
     * ASCIIHexDecode goes FIRST in the chain: a reader applies filters left to right, so it
     * must un-hex before it reaches the DCTDecode or FlateDecode that was already there.
     */
    const existing = dict.lookup(PDFName.of('Filter'))
    const chain = PDFArray.withContext(doc.context)
    chain.push(PDFName.of('ASCIIHexDecode'))
    if (existing instanceof PDFName) {
      chain.push(existing)
    } else if (existing instanceof PDFArray) {
      for (let i = 0; i < existing.size(); i += 1) chain.push(existing.get(i))
    }
    dict.set(PDFName.of('Filter'), chain)
    dict.set(PDFName.of('Length'), PDFNumber.of(encoded.length))

    doc.context.assign(ref, PDFRawStream.of(dict, encoded))
    streamsRewritten += 1
  }

  /*
   * Object streams and cross-reference streams are themselves Flate-compressed binary, and
   * nothing above can reach inside them — they must not be produced in the first place.
   */
  const saved = await doc.save({ useObjectStreams: false })

  // pdf-lib writes a deliberate run of high bytes as a comment on line 2, so that naive
  // tools treat the file as binary. It is a comment; dropping it changes no content.
  const cleaned = stripHighByteComments(saved)

  let highBytes = 0
  for (let i = 0; i < cleaned.length; i += 1) if (cleaned[i] > 0x7f) highBytes += 1

  return { bytes: cleaned, highBytes, streamsRewritten }
}

/** Drop any `%`-comment line that carries high bytes. Comments hold no document content. */
function stripHighByteComments(bytes: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < bytes.length) {
    let end = i
    while (end < bytes.length && bytes[end] !== 0x0a && bytes[end] !== 0x0d) end += 1
    let lineEnd = end
    while (lineEnd < bytes.length && (bytes[lineEnd] === 0x0a || bytes[lineEnd] === 0x0d)) lineEnd += 1

    let high = false
    for (let n = i; n < end; n += 1) if (bytes[n] > 0x7f) { high = true; break }

    if (!(high && bytes[i] === 0x25)) {
      for (let n = i; n < lineEnd; n += 1) out.push(bytes[n])
    }
    i = lineEnd
  }
  return new Uint8Array(out)
}
