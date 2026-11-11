/**
 * A proof of delivery is kept as a PDF (Ryne 2026-11-10: "anytime a proof of delivery comes through to a load, it should get converted to
 * PDF"). A phone photo or a screenshot arrives as a JPEG or PNG; this wraps it, upright, on one letter page. Only JPEG and PNG are touched
 * (a PDF stays as it is; other image types stay as they came and the caller keeps the original).
 *
 * Pure bytes in, bytes out (`imageToPdf`), plus `convertStoredPodImage`, the S3 step the document writers use. Neither ever throws into the
 * caller's upload: a failed conversion returns null and the original file is filed exactly as it came.
 */
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { PDFDocument, degrees } from 'pdf-lib'

const PAGE_LONG = 792
const PAGE_SHORT = 612
const MARGIN = 18

export const POD_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png'] as const

export function isPodImage(contentType: string | null | undefined): boolean {
  return (POD_IMAGE_TYPES as readonly string[]).includes(String(contentType ?? '').toLowerCase())
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

/** One letter page (portrait or landscape to match the picture), the picture upright and centred. */
export async function imageToPdf(bytes: Uint8Array, contentType: string, title?: string): Promise<Uint8Array> {
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
export function pdfKeyFor(key: string): string {
  return /\.(jpe?g|png)$/i.test(key) ? key.replace(/\.(jpe?g|png)$/i, '.pdf') : `${key}.pdf`
}

export function pdfNameFor(name: string): string {
  return /\.(jpe?g|png)$/i.test(name) ? name.replace(/\.(jpe?g|png)$/i, '.pdf') : `${name}.pdf`
}

export interface ConvertedPod { key: string; contentType: 'application/pdf'; name: string; sizeBytes: number }

async function streamBytes(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/** Read a stored photo, write its PDF next to it, return the PDF's key, name and size; null (and the original stays) on any failure. */
export async function convertStoredPodImage(
  s3: S3Client,
  bucket: string,
  input: { key: string; contentType: string; name: string },
): Promise<ConvertedPod | null> {
  if (!isPodImage(input.contentType)) return null
  try {
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: input.key }))
    const body = got.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
    const bytes = body?.transformToByteArray ? await body.transformToByteArray() : await streamBytes(got.Body)
    const pdf = await imageToPdf(bytes, input.contentType, pdfNameFor(input.name))
    const key = pdfKeyFor(input.key)
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: pdf, ContentType: 'application/pdf' }))
    return { key, contentType: 'application/pdf', name: pdfNameFor(input.name), sizeBytes: pdf.length }
  } catch (err) {
    console.warn('[podPdf] kept the original image; conversion failed:', String(err))
    return null
  }
}
