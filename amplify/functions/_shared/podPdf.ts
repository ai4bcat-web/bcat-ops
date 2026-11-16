/**
 * A proof of delivery is kept as a PDF (Ryne 2026-11-10: "anytime a proof of delivery comes through to a load, it should get converted to
 * PDF"), and so is a rate confirmation (Ryne 2026-11-16: "any pod or rate con that gets uploaded should be automatically converted to pdf
 * if its not one. this should be the version that lives in the shipment"). A phone photo or a screenshot arrives as a JPEG or PNG; this
 * wraps it, upright, on one letter page. TIFF, GIF and BMP are decoded with Jimp (first page) and wrapped the same way. A PDF stays as it
 * is; HEIC and WEBP have no decoder in the Lambda, so they stay as they came and the row says it could not be converted.
 *
 * Pure bytes in, bytes out (`imageToPdf`), plus `convertStoredPodImage`, the S3 step the document writers use. Neither ever throws into the
 * caller's upload: a failed conversion returns null and the original file is filed exactly as it came.
 */
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { PDFDocument, degrees } from 'pdf-lib'
import { shrinkPdfImages } from './pdfShrink'

const PAGE_LONG = 792
const PAGE_SHORT = 612
const MARGIN = 18

export const POD_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png'] as const
/** Decoded with Jimp, re-encoded as a JPEG, then wrapped like a photo. */
export const DECODED_IMAGE_TYPES = ['image/tiff', 'image/tif', 'image/gif', 'image/bmp', 'image/x-ms-bmp'] as const
/** Image types nothing in the Lambda can read: kept as the original, flagged as not converted. */
export const UNCONVERTIBLE_IMAGE_TYPES = ['image/heic', 'image/heif', 'image/webp', 'image/avif'] as const

/** The longest side a decoded image is re-encoded at: readable on a letter page, small enough to e-mail. */
const MAX_DECODED_SIDE = 2400

const lower = (contentType: string | null | undefined) => String(contentType ?? '').toLowerCase().split(';')[0].trim()

/** A file this module turns into a PDF (JPEG, PNG, TIFF, GIF, BMP). */
export function isPodImage(contentType: string | null | undefined): boolean {
  const t = lower(contentType)
  return (POD_IMAGE_TYPES as readonly string[]).includes(t) || (DECODED_IMAGE_TYPES as readonly string[]).includes(t)
}

/** Any image that is not a PDF: what a POD or rate confirmation should not stay as. */
export function isNonPdfImage(contentType: string | null | undefined): boolean {
  const t = lower(contentType)
  return t.startsWith('image/')
}

/** JPEG or PNG bytes for a decoded image type (first page of a TIFF), scaled so the long side is at most MAX_DECODED_SIDE. */
async function decodeToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  const { Jimp } = await import('jimp')
  const img = await Jimp.read(Buffer.from(bytes))
  const long = Math.max(img.width, img.height)
  if (long > MAX_DECODED_SIDE) {
    if (img.width >= img.height) img.resize({ w: MAX_DECODED_SIDE })
    else img.resize({ h: MAX_DECODED_SIDE })
  }
  return new Uint8Array(await img.getBuffer('image/jpeg', { quality: 82 }))
}

/** The EXIF orientation of a JPEG (1 when there is none or it is not a JPEG): phones store a sideways photo with an orientation flag. */
export function exifOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1
  let i = 2
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) return 1
    const marker = bytes[i + 1]
    const size = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker === 0xe1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66) {
      const t = i + 10 // TIFF header starts after "Exif\0\0"
      const little = bytes[t] === 0x49
      const u16 = (o: number) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1])
      const u32 = (o: number) => (little
        ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
        : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0)
      const ifd = t + u32(t + 4)
      const count = u16(ifd)
      for (let n = 0; n < count; n += 1) {
        const entry = ifd + 2 + n * 12
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8)
          return value >= 1 && value <= 8 ? value : 1
        }
      }
      return 1
    }
    if (marker === 0xda) return 1 // start of scan: no more headers
    i += 2 + size
  }
  return 1
}

/** Clockwise degrees to turn the stored pixels so the picture is upright (mirrored variants are treated as their plain rotation). */
function rotationOf(orientation: number): 0 | 90 | 180 | 270 {
  if (orientation === 3 || orientation === 4) return 180
  if (orientation === 6 || orientation === 5) return 90
  if (orientation === 8 || orientation === 7) return 270
  return 0
}

/** A picture bigger than this (stored bytes) is re-encoded lighter before it is wrapped: a 12-megapixel phone photo is 3-5 MB, a screenshot PNG can be 20 MB. */
const LIGHTEN_PNG_ABOVE = 1_000_000
const LIGHTEN_JPEG_ABOVE = 2_000_000
/** The longest side a wrapped picture keeps: sharp on a letter page, a few hundred KB. */
const MAX_EMBED_SIDE = 2000

/**
 * A lighter, upright JPEG for a big JPEG or PNG, or null when it is already small. Jimp turns a phone photo upright from its EXIF tag as it
 * reads it, so the re-encoded picture needs no tag; a PNG's transparency is flattened onto white.
 */
export async function lightenImage(bytes: Uint8Array, contentType: string): Promise<Uint8Array | null> {
  const png = /png/i.test(contentType)
  if (bytes.length < (png ? LIGHTEN_PNG_ABOVE : LIGHTEN_JPEG_ABOVE)) return null
  const { Jimp } = await import('jimp')
  const img = await Jimp.read(Buffer.from(bytes))
  if (Math.max(img.width, img.height) > MAX_EMBED_SIDE) {
    if (img.width >= img.height) img.resize({ w: MAX_EMBED_SIDE })
    else img.resize({ h: MAX_EMBED_SIDE })
  }
  let encoded: Buffer
  if (png) {
    const flat = new Jimp({ width: img.width, height: img.height, color: 0xffffffff })
    flat.composite(img, 0, 0)
    encoded = await flat.getBuffer('image/jpeg', { quality: 75 })
  } else encoded = await img.getBuffer('image/jpeg', { quality: 75 })
  const jpeg = new Uint8Array(encoded)
  return jpeg.length < bytes.length ? jpeg : null
}

/** One letter page (portrait or landscape to match the picture), the picture upright and centred. */
export async function imageToPdf(bytes: Uint8Array, contentType: string, title?: string, lightened = false): Promise<Uint8Array> {
  if ((DECODED_IMAGE_TYPES as readonly string[]).includes(lower(contentType))) {
    return imageToPdf(await decodeToJpeg(bytes), 'image/jpeg', title, true)
  }
  if (!lightened) {
    const lighter = await lightenImage(bytes, contentType).catch(() => null)
    if (lighter) return imageToPdf(lighter, 'image/jpeg', title, true)
  }
  const png = /png/i.test(contentType)
  const doc = await PDFDocument.create()
  if (title) doc.setTitle(title)
  // pdf-lib reads `bytes.buffer` from offset 0: a Node Buffer from the shared pool has an offset, so hand it a copy with its own buffer.
  const data = Uint8Array.from(bytes)
  const img = png ? await doc.embedPng(data) : await doc.embedJpg(data)
  const turn = png ? 0 : rotationOf(exifOrientation(data))
  const sideways = turn === 90 || turn === 270
  const shownW = sideways ? img.height : img.width
  const shownH = sideways ? img.width : img.height
  const landscape = shownW > shownH
  const pageW = landscape ? PAGE_LONG : PAGE_SHORT
  const pageH = landscape ? PAGE_SHORT : PAGE_LONG
  const scale = Math.min((pageW - 2 * MARGIN) / shownW, (pageH - 2 * MARGIN) / shownH)
  const w = img.width * scale // the stored image's own width and height at that scale
  const h = img.height * scale
  const boxW = sideways ? h : w
  const boxH = sideways ? w : h
  const ox = (pageW - boxW) / 2
  const oy = (pageH - boxH) / 2
  const page = doc.addPage([pageW, pageH])
  // pdf-lib turns an image counter-clockwise about its lower-left corner: place that corner so the turned picture lands in the box.
  if (turn === 90) page.drawImage(img, { x: ox, y: oy + boxH, width: w, height: h, rotate: degrees(-90) })
  else if (turn === 180) page.drawImage(img, { x: ox + boxW, y: oy + boxH, width: w, height: h, rotate: degrees(180) })
  else if (turn === 270) page.drawImage(img, { x: ox + boxW, y: oy, width: w, height: h, rotate: degrees(90) })
  else page.drawImage(img, { x: ox, y: oy, width: w, height: h })
  return doc.save()
}

/** `…/photo.jpg` → `…/photo.pdf`; a key with no image extension gets `.pdf` appended. Deterministic, so a retried commit finds its own file. */
const IMAGE_EXT = /\.(jpe?g|png|tiff?|gif|bmp|heic|heif|webp|avif)$/i

export function pdfKeyFor(key: string): string {
  return IMAGE_EXT.test(key) ? key.replace(IMAGE_EXT, '.pdf') : `${key}.pdf`
}

export function pdfNameFor(name: string): string {
  return IMAGE_EXT.test(name) ? name.replace(IMAGE_EXT, '.pdf') : `${name}.pdf`
}

export interface ConvertedPod {
  key: string
  contentType: 'application/pdf'
  name: string
  sizeBytes: number
  /** The image the PDF was made from; it stays in S3 for the record and is never shown or sent. */
  originalKey: string
  originalContentType: string
  /** True when the file was already a PDF and only had its pictures made smaller. */
  compressed?: boolean
}

async function streamBytes(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/** Read a stored photo, write its PDF next to it, return the PDF's key, name and size; null (and the original stays) on any failure. */
export async function convertStoredPodImage(
  s3: S3Client,
  bucket: string,
  input: { key: string; contentType: string; name: string; destKey?: string; type?: string; sizeBytes?: number },
): Promise<ConvertedPod | null> {
  if (shouldShrinkPdf(input.contentType, input.type, input.sizeBytes)) return shrinkStoredPdf(s3, bucket, input)
  if (!isPodImage(input.contentType)) return null
  try {
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: input.key }))
    const body = got.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
    const bytes = body?.transformToByteArray ? await body.transformToByteArray() : await streamBytes(got.Body)
    const pdf = await imageToPdf(bytes, input.contentType, pdfNameFor(input.name))
    const key = input.destKey ?? pdfKeyFor(input.key)
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: pdf, ContentType: 'application/pdf' }))
    return {
      key, contentType: 'application/pdf', name: pdfNameFor(input.name), sizeBytes: pdf.length,
      originalKey: input.key, originalContentType: input.contentType,
    }
  } catch (err) {
    console.warn('[podPdf] kept the original image; conversion failed:', String(err))
    return null
  }
}

/** A POD or customer rate confirmation that is already a PDF is lightened when it is this big (stored bytes). */
const SHRINK_PDF_ABOVE = 3_000_000
const SHRINKABLE_TYPES = new Set(['POD', 'RATE_CON', 'CUSTOMER_RATE_CON'])

export function shouldShrinkPdf(contentType: string | null | undefined, type: string | undefined, sizeBytes: number | undefined): boolean {
  return /pdf/i.test(String(contentType ?? '')) && !!type && SHRINKABLE_TYPES.has(type) && (sizeBytes ?? 0) >= SHRINK_PDF_ABOVE
}

/** `…/scan.pdf` -> `…/scan-small.pdf`: deterministic, so a retried commit finds its own file. */
export function smallPdfKeyFor(key: string): string {
  return `${key.replace(/\.pdf$/i, '')}-small.pdf`
}

/** Read a stored PDF, write the lighter copy next to it, return it; null (the PDF stays as it came) when it was not worth it or anything failed. */
async function shrinkStoredPdf(
  s3: S3Client,
  bucket: string,
  input: { key: string; contentType: string; name: string; destKey?: string },
): Promise<ConvertedPod | null> {
  try {
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: input.key }))
    const body = got.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
    const bytes = body?.transformToByteArray ? await body.transformToByteArray() : await streamBytes(got.Body)
    const shrunk = await shrinkPdfImages(bytes)
    if (!shrunk.changed) return null
    const key = input.destKey ?? smallPdfKeyFor(input.key)
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: shrunk.bytes, ContentType: 'application/pdf' }))
    return {
      key, contentType: 'application/pdf', name: input.name, sizeBytes: shrunk.after,
      originalKey: input.key, originalContentType: 'application/pdf', compressed: true,
    }
  } catch (err) {
    console.warn('[podPdf] kept the PDF as it came; shrinking failed:', String(err))
    return null
  }
}

/**
 * The fields a document row takes from a conversion: the PDF is the file, the image is kept as `originalS3Key`; an image that could not be
 * converted keeps its own key and says so (`pdfConversion: 'FAILED'`), and still counts as present.
 */
export function conversionFields(contentType: string, converted: ConvertedPod | null): Record<string, string> {
  if (converted) {
    return { originalS3Key: converted.originalKey, originalContentType: converted.originalContentType, pdfConversion: converted.compressed ? 'COMPRESSED' : 'CONVERTED' }
  }
  return isNonPdfImage(contentType) ? { pdfConversion: 'FAILED' } : {}
}
