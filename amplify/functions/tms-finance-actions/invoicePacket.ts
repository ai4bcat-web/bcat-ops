/**
 * The invoice packet (Ryne, 2026-11-12): the invoice and its PODs go out as ONE PDF — the
 * invoice page(s) first, then every POD in packet order. A PDF POD keeps all of its pages;
 * a JPEG or PNG POD becomes one page sized to the photo (scaled down to fit a letter page).
 *
 * A POD that cannot be merged (corrupt, encrypted beyond reading, or a format pdf-lib cannot
 * draw such as HEIC) refuses the whole packet with its name: the customer must never get an
 * invoice that silently dropped its POD.
 */
import { PDFDocument } from 'pdf-lib'
import { lightenImage } from '../_shared/podPdf'
import { SHRINK_DEFAULTS, SHRINK_HARD, shrinkPdfImages } from '../_shared/pdfShrink'

export interface PacketPart {
  name: string
  bytes: Uint8Array
  contentType: string
}

export const POD_MERGE_CODE = 'POD_MERGE_FAILED'

export class PodMergeError extends Error {
  readonly code = POD_MERGE_CODE
  constructor(readonly documentName: string, why: string) {
    super(`${POD_MERGE_CODE}: The POD "${documentName}" could not be added to the invoice PDF (${why}). Replace it with a PDF, JPG or PNG copy, then send.`)
    this.name = 'PodMergeError'
  }
}

/** Letter, in points. Photos larger than this are scaled down to fit; smaller ones keep their size. */
const PAGE_W = 612
const PAGE_H = 792

type PartKind = 'pdf' | 'jpg' | 'png' | null

/** What a part is, from its bytes first (a phone often labels a JPEG as octet-stream), then its type and name. */
export function packetPartKind(part: Pick<PacketPart, 'bytes' | 'contentType' | 'name'>): PartKind {
  const b = part.bytes
  // A PDF header may sit after a few junk bytes; readers accept it anywhere in the first 1 KB.
  for (let i = 0; i + 3 < Math.min(b.length, 1024); i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return 'pdf'
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length > 0) return null
  const type = (part.contentType || '').toLowerCase()
  const name = (part.name || '').toLowerCase()
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf'
  if (/jpe?g/.test(type) || /\.jpe?g$/.test(name)) return 'jpg'
  if (type.includes('png') || name.endsWith('.png')) return 'png'
  return null
}

async function appendPart(out: PDFDocument, part: PacketPart): Promise<number> {
  const kind = packetPartKind(part)
  if (kind === 'pdf') {
    const src = await PDFDocument.load(part.bytes, { ignoreEncryption: true, updateMetadata: false })
    const pages = await out.copyPages(src, src.getPageIndices())
    if (pages.length === 0) throw new Error('it has no pages')
    for (const page of pages) out.addPage(page)
    return pages.length
  }
  if (kind === 'jpg' || kind === 'png') {
    const image = kind === 'jpg' ? await out.embedJpg(part.bytes) : await out.embedPng(part.bytes)
    const scale = Math.min(1, PAGE_W / image.width, PAGE_H / image.height)
    const w = image.width * scale
    const h = image.height * scale
    const page = out.addPage([Math.max(w, 72), Math.max(h, 72)])
    page.drawImage(image, { x: 0, y: 0, width: w, height: h })
    return 1
  }
  throw new Error(`${part.contentType || 'unknown type'} is not a PDF, JPG or PNG`)
}

/** A POD part smaller than this is not worth lightening when the packet has to shrink. */
const SHRINK_PART_ABOVE = 1_000_000

export interface PacketCompression {
  name: string
  before: number
  after: number
}

/** One POD part with its pictures made lighter, or null when it has nothing worth lightening. */
async function lighterPart(pod: PacketPart, hard: boolean): Promise<PacketPart | null> {
  if (pod.bytes.byteLength < SHRINK_PART_ABOVE) return null
  const kind = packetPartKind(pod)
  if (kind === 'pdf') {
    const shrunk = await shrinkPdfImages(pod.bytes, hard ? SHRINK_HARD : SHRINK_DEFAULTS)
    return shrunk.changed ? { ...pod, bytes: shrunk.bytes } : null
  }
  if (kind === 'jpg' || kind === 'png') {
    const lighter = await lightenImage(pod.bytes, kind === 'png' ? 'image/png' : 'image/jpeg')
    return lighter ? { ...pod, bytes: lighter, contentType: 'image/jpeg' } : null
  }
  return null
}

/**
 * Invoice first, then each POD. Returns the merged bytes and the page count each part
 * contributed (the review shows "Invoice · 1 page, POD 1 · 2 pages").
 *
 * `shrinkAbove` (bytes): when the packet comes out bigger than this, the POD pictures are made lighter in the COPY that goes into the
 * packet (the POD kept in the shipment is never touched; Ryne 2026-11-16, a 22.8 MB POD that blocked an invoice e-mail), then lighter
 * still if it needs it. `compressed` says which PODs were lightened, so the review can say so; a POD is never dropped.
 */
export async function combineInvoicePacket(
  invoice: PacketPart,
  pods: readonly PacketPart[],
  options: { shrinkAbove?: number } = {},
): Promise<{ bytes: Uint8Array; pages: { name: string; pages: number }[]; compressed?: PacketCompression[] }> {
  const build = async (parts: readonly PacketPart[]) => {
    const out = await PDFDocument.create()
    const pages: { name: string; pages: number }[] = []
    pages.push({ name: invoice.name, pages: await appendPart(out, invoice) })
    for (const pod of parts) {
      try {
        pages.push({ name: pod.name, pages: await appendPart(out, pod) })
      } catch (err) {
        throw new PodMergeError(pod.name, err instanceof Error ? err.message : String(err))
      }
    }
    const bytes = await out.save({ useObjectStreams: false })
    return { bytes, pages }
  }
  let result = await build(pods)
  const limit = options.shrinkAbove
  if (!limit || result.bytes.byteLength <= limit) return result

  let parts = [...pods]
  const lightened = new Map<string, PacketCompression>()
  for (const hard of [false, true]) {
    const next: PacketPart[] = []
    for (const part of parts) {
      const lighter = await lighterPart(part, hard).catch(() => null)
      if (lighter) {
        const first = lightened.get(part.name)
        lightened.set(part.name, { name: part.name, before: first?.before ?? part.bytes.byteLength, after: lighter.bytes.byteLength })
        next.push(lighter)
      } else next.push(part)
    }
    parts = next
    if (lightened.size === 0) break
    result = await build(parts)
    if (result.bytes.byteLength <= limit) break
  }
  return lightened.size ? { ...result, compressed: [...lightened.values()] } : result
}

/** "POD compressed from 22.8 MB to 0.4 MB for e-mail": what the send review says when a POD was lightened for the packet. */
export function compressionNote(compressed: readonly PacketCompression[] | undefined): string | null {
  if (!compressed?.length) return null
  const mb = (n: number) => (Math.round((n / (1024 * 1024)) * 10) / 10).toFixed(1)
  return compressed.map((c) => `${c.name} compressed from ${mb(c.before)} MB to ${mb(c.after)} MB for e-mail`).join('; ')
}
