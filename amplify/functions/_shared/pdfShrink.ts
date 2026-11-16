/**
 * Make a PDF whose pages are big pictures small enough to e-mail (Ryne 2026-11-16, invoice 14918: a 22.8 MB proof of delivery, one 5712 x 4284
 * screenshot that macOS Preview had wrapped losslessly, made the invoice e-mail "over 10 MB").
 *
 * Every embedded picture that is big is read back, scaled so its long side is at most `maxSide`, and stored again as a JPEG. The page
 * layout, text, vector art and every small picture are left exactly as they were: a picture is placed on the page by a transform, so
 * fewer pixels in the same box look the same, only lighter.
 *
 * Pure bytes in, bytes out. It never throws into a caller: anything it cannot read stays as it came, and a result that is not clearly
 * smaller is thrown away (`changed: false`, the original bytes).
 */
import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib'

export interface ShrinkOptions {
  /** Longest side, in pixels, a picture is kept at. */
  maxSide?: number
  /** JPEG quality 1-100. */
  quality?: number
  /** Pictures smaller than this (stored bytes) are left alone. */
  minImageBytes?: number
  /** The result must be at least this share smaller than the original, else the original is returned. */
  minSaving?: number
}

export interface ShrinkResult {
  bytes: Uint8Array
  changed: boolean
  before: number
  after: number
  /** Pictures that were re-encoded. */
  images: number
}

/** What a stored POD is shrunk to: readable when printed, a few hundred KB a page. */
export const SHRINK_DEFAULTS = { maxSide: 2000, quality: 72, minImageBytes: 200_000, minSaving: 0.1 } as const
/** The harder pass the invoice e-mail falls back to when a packet is still over the limit. */
export const SHRINK_HARD = { maxSide: 1500, quality: 62, minImageBytes: 100_000, minSaving: 0.05 } as const

/** Largest raw picture (width x height x channels) read back into memory. */
const MAX_RAW_BYTES = 160_000_000

const num = (value: unknown): number | null => (value instanceof PDFNumber ? value.asNumber() : null)

/** The name of a /Filter that is one filter, whether written as a name or a one-item array. */
function singleFilter(dict: PDFDict): string | null {
  const f = dict.get(PDFName.of('Filter'))
  if (f instanceof PDFName) return f.decodeText()
  if (f instanceof PDFArray && f.size() === 1) {
    const only = f.get(0)
    return only instanceof PDFName ? only.decodeText() : null
  }
  return null
}

/** Colour components of an image: DeviceRGB 3, DeviceGray 1, an ICC profile its /N; anything else (CMYK, Indexed, Lab) is not touched. */
function componentsOf(doc: PDFDocument, dict: PDFDict): number | null {
  let cs = dict.get(PDFName.of('ColorSpace'))
  if (cs instanceof PDFRef) cs = doc.context.lookup(cs)
  if (cs instanceof PDFName) {
    const n = cs.decodeText()
    return n === 'DeviceRGB' ? 3 : n === 'DeviceGray' ? 1 : null
  }
  if (cs instanceof PDFArray && cs.size() >= 2) {
    const head = cs.get(0)
    if (head instanceof PDFName && head.decodeText() === 'ICCBased') {
      let profile: unknown = cs.get(1)
      if (profile instanceof PDFRef) profile = doc.context.lookup(profile)
      const dictOf = profile instanceof PDFRawStream ? profile.dict : null
      const n = dictOf ? num(dictOf.get(PDFName.of('N'))) : null
      return n === 1 || n === 3 ? n : null
    }
  }
  return null
}

/** Undo a PNG row predictor (/Predictor 10-15) on inflated image data. */
function unpredict(raw: Uint8Array, columns: number, comps: number, rows: number): Uint8Array | null {
  const rowBytes = columns * comps
  if (raw.length < rows * (rowBytes + 1)) return null
  const out = new Uint8Array(rows * rowBytes)
  for (let y = 0; y < rows; y += 1) {
    const type = raw[y * (rowBytes + 1)]
    const src = y * (rowBytes + 1) + 1
    const dst = y * rowBytes
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= comps ? out[dst + x - comps] : 0
      const up = y > 0 ? out[dst - rowBytes + x] : 0
      const upLeft = y > 0 && x >= comps ? out[dst - rowBytes + x - comps] : 0
      let value = raw[src + x]
      if (type === 1) value += left
      else if (type === 2) value += up
      else if (type === 3) value += (left + up) >> 1
      else if (type === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (type !== 0) return null
      out[dst + x] = value & 0xff
    }
  }
  return out
}

/** Box-filter a w x h picture (comps channels) down to ow x oh, as RGBA. Averaging blocks keeps small print readable. */
function boxScale(src: Uint8Array, w: number, h: number, comps: number, ow: number, oh: number): Uint8Array {
  const out = new Uint8Array(ow * oh * 4)
  for (let oy = 0; oy < oh; oy += 1) {
    const y0 = Math.floor((oy * h) / oh)
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / oh))
    for (let ox = 0; ox < ow; ox += 1) {
      const x0 = Math.floor((ox * w) / ow)
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / ow))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1; y += 1) {
        let i = (y * w + x0) * comps
        for (let x = x0; x < x1; x += 1) {
          if (comps === 3) { r += src[i]; g += src[i + 1]; b += src[i + 2] } else { r += src[i]; g += src[i]; b += src[i] }
          i += comps
          n += 1
        }
      }
      const o = (oy * ow + ox) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = 255
    }
  }
  return out
}

async function jpegFromRgba(rgba: Uint8Array, width: number, height: number, quality: number): Promise<Uint8Array> {
  const { Jimp } = await import('jimp')
  const img = new Jimp({ data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height })
  return new Uint8Array(await img.getBuffer('image/jpeg', { quality }))
}

function targetSize(w: number, h: number, maxSide: number): { ow: number; oh: number } {
  const long = Math.max(w, h)
  if (long <= maxSide) return { ow: w, oh: h }
  const scale = maxSide / long
  return { ow: Math.max(1, Math.round(w * scale)), oh: Math.max(1, Math.round(h * scale)) }
}

/** One image stream's replacement JPEG, or null to leave it as it is. */
async function reencode(doc: PDFDocument, stream: PDFRawStream, opts: Required<ShrinkOptions>): Promise<{ jpeg: Uint8Array; w: number; h: number } | null> {
  const dict = stream.dict
  if (dict.has(PDFName.of('SMask')) || dict.has(PDFName.of('Mask')) || dict.has(PDFName.of('ImageMask'))) return null
  const w = num(dict.get(PDFName.of('Width')))
  const h = num(dict.get(PDFName.of('Height')))
  if (!w || !h) return null
  const stored = stream.contents.length
  if (stored < opts.minImageBytes) return null
  const filter = singleFilter(dict)
  const { ow, oh } = targetSize(w, h, opts.maxSide)

  if (filter === 'DCTDecode') {
    // A JPEG that is already near its target size gains little from being re-encoded.
    if (ow === w && oh === h && stored / (w * h) < 0.9) return null
    const { Jimp } = await import('jimp')
    const img = await Jimp.read(Buffer.from(stream.contents))
    if (ow !== w || oh !== h) {
      if (img.width >= img.height) img.resize({ w: ow })
      else img.resize({ h: oh })
    }
    return { jpeg: new Uint8Array(await img.getBuffer('image/jpeg', { quality: opts.quality })), w: img.width, h: img.height }
  }

  if (filter !== 'FlateDecode') return null
  const bpc = num(dict.get(PDFName.of('BitsPerComponent')))
  const comps = componentsOf(doc, dict)
  if (bpc !== 8 || !comps) return null
  // A picture whose raw pixels would not fit in a small Lambda is left alone rather than crashing the upload.
  if (w * h * comps > MAX_RAW_BYTES) return null
  let raw: Uint8Array = inflateSync(Buffer.from(stream.contents))
  let parms = dict.get(PDFName.of('DecodeParms'))
  if (parms instanceof PDFArray && parms.size() === 1) parms = parms.get(0)
  if (parms instanceof PDFRef) parms = doc.context.lookup(parms)
  if (parms instanceof PDFDict) {
    const predictor = num(parms.get(PDFName.of('Predictor'))) ?? 1
    if (predictor >= 10) {
      const columns = num(parms.get(PDFName.of('Columns'))) ?? w
      const colors = num(parms.get(PDFName.of('Colors'))) ?? comps
      if (colors !== comps) return null
      const flat = unpredict(raw, columns, comps, h)
      if (!flat) return null
      raw = flat
    } else if (predictor !== 1) return null
  }
  if (raw.length < w * h * comps) return null
  const rgba = boxScale(raw, w, h, comps, ow, oh)
  return { jpeg: await jpegFromRgba(rgba, ow, oh, opts.quality), w: ow, h: oh }
}

/** The PDF with its big pictures re-encoded smaller; the original bytes back when nothing was gained. */
export async function shrinkPdfImages(bytes: Uint8Array, options: ShrinkOptions = {}): Promise<ShrinkResult> {
  const opts = { ...SHRINK_DEFAULTS, ...options } as Required<ShrinkOptions>
  const before = bytes.byteLength
  const unchanged: ShrinkResult = { bytes, changed: false, before, after: before, images: 0 }
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false })
    let images = 0
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue
      if (obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue
      const next = await reencode(doc, obj, opts).catch(() => null)
      if (!next || next.jpeg.byteLength >= obj.contents.length) continue
      const dict = doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: next.w,
        Height: next.h,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
        Length: next.jpeg.byteLength,
      }) as PDFDict
      doc.context.assign(ref, PDFRawStream.of(dict, next.jpeg))
      images += 1
    }
    if (!images) return unchanged
    const out = await doc.save({ useObjectStreams: false })
    if (out.byteLength > before * (1 - opts.minSaving)) return unchanged
    return { bytes: out, changed: true, before, after: out.byteLength, images }
  } catch (err) {
    console.warn('[pdfShrink] kept the PDF as it came:', String(err))
    return unchanged
  }
}
