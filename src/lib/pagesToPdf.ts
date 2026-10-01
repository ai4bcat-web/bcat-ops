/**
 * Combine the pages a driver captured into ONE PDF.
 *
 * The office wants a single document per POD, the way JobsDone delivers them —
 * not eight loose photos someone has to assemble before it can go to a broker
 * or to OTR. Doing it on the phone also means one upload instead of eight,
 * which matters on a truck connection.
 *
 * Inputs are whatever the scanner produced: JPEGs from the camera (imagePrep
 * normalizes every captured image to JPEG) and PDFs a driver picked from files.
 * PDFs are merged page-for-page rather than rasterized, so a broker's own
 * paperwork keeps its text layer.
 *
 * Deliberately NOT re-encoding a lone PDF: a driver who picks a single PDF gets
 * that exact file back, byte for byte. Re-wrapping it would only lose fidelity
 * and time.
 */
import { PDFDocument } from 'pdf-lib'

/** A captured page, matching the scanner's PendingPage minus the server fields. */
export interface SourcePage {
  fileName: string
  contentType: string
  blob: Blob
}

export interface CombinedPdf {
  blob: Blob
  fileName: string
  contentType: 'application/pdf'
  /** How many PDF pages came out — images are one each, PDFs contribute their own. */
  pageCount: number
}

const PDF_TYPE = 'application/pdf'

/** US Letter at 72dpi. Images are fitted to this so a POD prints predictably. */
const PAGE_W = 612
const PAGE_H = 792

function isPdf(p: SourcePage): boolean {
  return p.contentType === PDF_TYPE || /\.pdf$/i.test(p.fileName)
}

/**
 * Scale an image to fit the page while preserving aspect ratio, and centre it.
 * A POD photographed in portrait must not be stretched to landscape.
 */
export function fitWithin(
  imgW: number,
  imgH: number,
  pageW = PAGE_W,
  pageH = PAGE_H,
): { width: number; height: number; x: number; y: number } {
  if (imgW <= 0 || imgH <= 0) return { width: pageW, height: pageH, x: 0, y: 0 }
  const scale = Math.min(pageW / imgW, pageH / imgH)
  const width = imgW * scale
  const height = imgH * scale
  return { width, height, x: (pageW - width) / 2, y: (pageH - height) / 2 }
}

/** `POD-2026-10-01.pdf` — dated, so a folder of them sorts sensibly. */
export function combinedFileName(kind: 'POD' | 'RATECON', now = new Date()): string {
  const d = now.toISOString().slice(0, 10)
  return `${kind === 'POD' ? 'POD' : 'RateCon'}-${d}.pdf`
}

/**
 * Merge pages into one PDF. Returns null when there is nothing to merge, and
 * returns the original blob untouched when the input is a single PDF.
 */
export async function pagesToPdf(
  pages: SourcePage[],
  kind: 'POD' | 'RATECON',
  now = new Date(),
): Promise<CombinedPdf | null> {
  if (!pages.length) return null

  // One PDF in, the same PDF out — no re-encode, no fidelity loss.
  if (pages.length === 1 && isPdf(pages[0])) {
    const bytes = new Uint8Array(await pages[0].blob.arrayBuffer())
    let pageCount = 1
    try {
      pageCount = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount()
    } catch {
      // A PDF we cannot parse still passes through; the office can open it.
    }
    return {
      blob: pages[0].blob,
      fileName: pages[0].fileName,
      contentType: PDF_TYPE,
      pageCount,
    }
  }

  const out = await PDFDocument.create()

  for (const page of pages) {
    const bytes = new Uint8Array(await page.blob.arrayBuffer())

    if (isPdf(page)) {
      // Merge the source's pages so text stays selectable.
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const copied = await out.copyPages(src, src.getPageIndices())
      for (const p of copied) out.addPage(p)
      continue
    }

    // imagePrep normalizes camera captures to JPEG; PNG is still accepted from
    // a file picker. Anything else is embedded as JPEG and will throw if it
    // genuinely is not one, which surfaces as a clear failure rather than a
    // silently corrupt page.
    const embedded =
      page.contentType === 'image/png'
        ? await out.embedPng(bytes)
        : await out.embedJpg(bytes)

    const sheet = out.addPage([PAGE_W, PAGE_H])
    const box = fitWithin(embedded.width, embedded.height)
    sheet.drawImage(embedded, box)
  }

  const bytes = await out.save()
  return {
    blob: new Blob([bytes as BlobPart], { type: PDF_TYPE }),
    fileName: combinedFileName(kind, now),
    contentType: PDF_TYPE,
    pageCount: out.getPageCount(),
  }
}
