/**
 * Get the photographs back out of a PDF, so a POD that arrived as a PDF can still be
 * cleaned up.
 *
 * The cleanup pipeline (scan.ts) works on JPEG and PNG. Everything that reaches it as a
 * PDF was returned ORIGINAL_ONLY and sent to the broker exactly as it was taken — crooked,
 * shadowed, half a desk in the frame. That covers most PODs: a driver's phone wraps a
 * photo in a PDF, a scanner app exports one, and our own merge produces one.
 *
 * Rasterizing the whole PDF would need a renderer in the Lambda and would flatten a real
 * scanner-app PDF — which is already deskewed and carries selectable text — into a worse
 * picture of itself. So this does the narrower, safer thing: it pulls out the embedded
 * IMAGE for pages that are nothing but an image, and leaves every other page alone.
 *
 * A page is a candidate only when all of this holds:
 *   - it draws no text (no text-showing operator in its content stream), and
 *   - it has exactly one image XObject, and
 *   - that image is actually DRAWN across essentially the whole page.
 *
 * The last one is measured from the content stream's transformation matrix, not guessed
 * from the image's own aspect ratio: a 600x800 logo stamped into a 100x40 corner has
 * exactly the aspect of a full-page photo, and guessing would have rewritten letterheads.
 *
 * That is precisely the "photo wrapped in a PDF" shape, and precisely not a scanner-app
 * page with a text layer or a broker's typeset rate confirmation.
 */
import {
  PDFDocument,
  PDFRawStream,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib'
import { inflateSync } from 'node:zlib'
import { Jimp } from 'jimp'

export interface ExtractedPhoto {
  /** 0-based page index this came off. */
  pageIndex: number
  bytes: Buffer
  /** Always one the cleanup pipeline accepts. */
  contentType: 'image/jpeg' | 'image/png'
}

/** Below this share of the page, the image is a logo or a signature, not the document. */
const FULL_PAGE_COVERAGE = 0.6
/** Guards against a pathological image blowing the Lambda's memory. */
const MAX_RAW_PIXELS = 30_000_000

/** Text-showing operators. Their presence means the page is more than a photograph. */
const TEXT_OPERATORS = /(^|[\s\]>)])(Tj|TJ|'|")(\s|$)/

/**
 * A PDF name without its leading slash.
 *
 * `PDFName.asString()` returns "/DCTDecode", not "DCTDecode" — comparing against the bare
 * word silently matched nothing, so every page looked like it held no image at all and
 * the whole extraction returned empty.
 */
function asName(v: unknown): string | null {
  return v instanceof PDFName ? v.asString().replace(/^\//, '') : null
}

/** A filter entry may be a single name or an array of them. */
function filtersOf(dict: PDFDict): string[] {
  const f = dict.get(PDFName.of('Filter'))
  if (f instanceof PDFName) return [f.asString().replace(/^\//, '')]
  if (f instanceof PDFArray) {
    return f.asArray().map((e) => asName(e)).filter((n): n is string => n !== null)
  }
  return []
}

function numberOf(dict: PDFDict, key: string): number | null {
  const v = dict.get(PDFName.of(key))
  return v instanceof PDFNumber ? v.asNumber() : null
}

/**
 * Rebuild a PNG from a PDF's raw samples.
 *
 * A FlateDecode image stream is rows of component bytes with no PNG framing, so it cannot
 * be handed to the cleanup pipeline as-is. Jimp writes the PNG; this only has to get the
 * samples into a bitmap in the right order.
 */
async function pngFromRawSamples(
  raw: Buffer,
  width: number,
  height: number,
  components: number,
): Promise<Buffer | null> {
  const expected = width * height * components
  // A short buffer means a predictor or a colour space this does not model. Rather than
  // render a garbled page, decline and let the original stand.
  if (raw.length < expected) return null

  const image = new Jimp({ width, height, color: 0x000000ff })
  const out = image.bitmap.data
  for (let i = 0, p = 0; i < width * height; i++) {
    const s = i * components
    const r = raw[s]
    const g = components >= 3 ? raw[s + 1] : r
    const b = components >= 3 ? raw[s + 2] : r
    out[p++] = r
    out[p++] = g
    out[p++] = b
    out[p++] = 255
  }
  return Buffer.from(await image.getBuffer('image/png'))
}

/**
 * The size each image is drawn at, in page units, keyed by its XObject name.
 *
 * A minimal content-stream interpreter: it tracks the graphics state stack (q/Q) and the
 * current transformation matrix (cm), and records the matrix in force at each `Do`. In
 * PDF an image is drawn into the unit square, so the CTM's own scale IS the drawn size.
 */
function drawnSizes(content: string): Map<string, { width: number; height: number }> {
  type M = [number, number, number, number, number, number]
  const identity: M = [1, 0, 0, 1, 0, 0]
  const mul = (m: M, n: M): M => [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ]

  const out = new Map<string, { width: number; height: number }>()
  let ctm: M = identity
  const stack: M[] = []
  const tokens = content.split(/\s+/)
  const nums: number[] = []
  let lastName: string | null = null

  for (const token of tokens) {
    if (!token) continue
    if (token.startsWith('/')) { lastName = token.slice(1); continue }
    const n = Number(token)
    if (Number.isFinite(n) && /^[-+.\d]/.test(token)) { nums.push(n); continue }

    if (token === 'q') { stack.push(ctm) }
    else if (token === 'Q') { ctm = stack.pop() ?? identity }
    else if (token === 'cm' && nums.length >= 6) {
      ctm = mul(nums.slice(-6) as M, ctm)
    } else if (token === 'Do' && lastName) {
      // Columns of the CTM give the drawn extent of the unit square.
      const width = Math.hypot(ctm[0], ctm[1])
      const height = Math.hypot(ctm[2], ctm[3])
      const prev = out.get(lastName)
      // Keep the largest draw: the same image may be stamped more than once.
      if (!prev || width * height > prev.width * prev.height) out.set(lastName, { width, height })
    }
    nums.length = 0
  }
  return out
}

/** Every content stream of a page, concatenated, or null if any of it is unreadable. */
function contentOf(page: PDFPage): string | null {
  try {
    const contents = page.node.Contents()
    if (!contents) return null
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents]
    const parts: string[] = []
    for (const ref of streams) {
      const stream = page.doc.context.lookup(ref)
      if (!(stream instanceof PDFRawStream)) continue
      parts.push(Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
    }
    return parts.join('\n')
  } catch {
    return null
  }
}

/** The single image XObject a page draws, if it draws exactly one. */
function loneImageOf(page: PDFPage): { name: string; stream: PDFRawStream; dict: PDFDict } | null {
  const resources = page.node.Resources()
  if (!resources) return null
  const xobjects = resources.lookup(PDFName.of('XObject'))
  if (!(xobjects instanceof PDFDict)) return null

  const images: Array<{ name: string; stream: PDFRawStream; dict: PDFDict }> = []
  for (const [key, ref] of xobjects.entries()) {
    const stream = page.doc.context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) continue
    const dict = stream.dict
    if (asName(dict.get(PDFName.of('Subtype'))) !== 'Image') continue
    images.push({ name: key.asString().replace(/^\//, ''), stream, dict })
  }
  return images.length === 1 ? images[0] : null
}

/** True when the page's content stream shows any text. */
function drawsText(content: string): boolean {
  return TEXT_OPERATORS.test(content)
}

/**
 * The photos inside a PDF, one per page that is nothing but a photo.
 *
 * Returns an empty array for a PDF that should be left exactly as it is — which is the
 * right answer for a real scanner-app export and for a broker's typeset paperwork.
 */
export async function extractPagePhotos(pdfBytes: Buffer): Promise<ExtractedPhoto[]> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, throwOnInvalidObject: false })
  const out: ExtractedPhoto[] = []

  for (const [pageIndex, page] of doc.getPages().entries()) {
    // Unreadable content is a reason to leave the page alone, not to rewrite it.
    const content = contentOf(page)
    if (content === null || drawsText(content)) continue
    const found = loneImageOf(page)
    if (!found) continue

    const { stream, dict } = found
    const width = numberOf(dict, 'Width')
    const height = numberOf(dict, 'Height')
    if (!width || !height || width * height > MAX_RAW_PIXELS) continue

    // An image stamped into a corner is a logo or a signature block, not the document.
    // Measured from the content stream, never guessed from the image's own aspect ratio:
    // a 600x800 logo in a 100x40 corner has exactly the shape of a full-page photo.
    const { width: pageW, height: pageH } = page.getSize()
    const drawn = drawnSizes(content).get(found.name)
    if (!drawn) continue
    if (pageW > 0 && pageH > 0 && (drawn.width * drawn.height) / (pageW * pageH) < FULL_PAGE_COVERAGE) {
      continue
    }

    const filters = filtersOf(dict)
    try {
      if (filters.includes('DCTDecode')) {
        // The stream contents already ARE a JPEG file.
        out.push({ pageIndex, bytes: Buffer.from(stream.getContents()), contentType: 'image/jpeg' })
        continue
      }
      if (filters.length === 1 && filters[0] === 'FlateDecode') {
        const colorSpace = asName(dict.get(PDFName.of('ColorSpace')))
        const bits = numberOf(dict, 'BitsPerComponent')
        if (bits !== 8) continue
        const components = colorSpace === 'DeviceRGB' ? 3 : colorSpace === 'DeviceGray' ? 1 : 0
        if (!components) continue
        const raw = inflateSync(Buffer.from(stream.getContents()))
        const png = await pngFromRawSamples(raw, width, height, components)
        if (png) out.push({ pageIndex, bytes: png, contentType: 'image/png' })
        continue
      }
      // JPXDecode, CCITTFaxDecode, JBIG2Decode and friends: leave them be.
    } catch {
      // One unreadable page never costs the rest of the document.
      continue
    }
  }

  return out
}

/** US Letter at 72dpi, matching pagesToPdf so a mixed document stays consistent. */
const PAGE_W = 612
const PAGE_H = 792

/**
 * Put cleaned pages back into a PDF.
 *
 * Pages that were never extracted are copied across untouched, so a document that was
 * half photographs and half a broker's own paperwork keeps the half we had no business
 * rewriting.
 */
export async function rebuildPdfWithPhotos(
  originalBytes: Buffer,
  replacements: Map<number, { bytes: Buffer; contentType: string }>,
): Promise<Buffer> {
  const original = await PDFDocument.load(originalBytes, { ignoreEncryption: true, throwOnInvalidObject: false })
  const out = await PDFDocument.create()
  const pageCount = original.getPageCount()

  for (let i = 0; i < pageCount; i++) {
    const swap = replacements.get(i)
    if (!swap) {
      const [copied] = await out.copyPages(original, [i])
      out.addPage(copied)
      continue
    }
    const embedded = /png/i.test(swap.contentType)
      ? await out.embedPng(swap.bytes)
      : await out.embedJpg(swap.bytes)
    const scale = Math.min(PAGE_W / embedded.width, PAGE_H / embedded.height)
    const w = embedded.width * scale
    const h = embedded.height * scale
    const sheet = out.addPage([PAGE_W, PAGE_H])
    sheet.drawImage(embedded, { x: (PAGE_W - w) / 2, y: (PAGE_H - h) / 2, width: w, height: h })
  }

  return Buffer.from(await out.save())
}
