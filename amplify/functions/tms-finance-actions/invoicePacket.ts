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

/**
 * Invoice first, then each POD. Returns the merged bytes and the page count each part
 * contributed (the review shows "Invoice · 1 page, POD 1 · 2 pages").
 */
export async function combineInvoicePacket(
  invoice: PacketPart,
  pods: readonly PacketPart[],
): Promise<{ bytes: Uint8Array; pages: { name: string; pages: number }[] }> {
  const out = await PDFDocument.create()
  const pages: { name: string; pages: number }[] = []
  pages.push({ name: invoice.name, pages: await appendPart(out, invoice) })
  for (const pod of pods) {
    try {
      pages.push({ name: pod.name, pages: await appendPart(out, pod) })
    } catch (err) {
      throw new PodMergeError(pod.name, err instanceof Error ? err.message : String(err))
    }
  }
  const bytes = await out.save({ useObjectStreams: false })
  return { bytes, pages }
}
