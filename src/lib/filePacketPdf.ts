/**
 * Builds one merged PDF packet for a driver or a truck — a cover sheet of details
 * followed by every document on file, so a whole record can be emailed or printed in
 * a single attachment.
 *
 * PDFs are copied page-for-page (jsPDF can't do that, which is why this uses pdf-lib);
 * JPG/PNG are embedded as full pages. Anything else — HEIC in particular, which iPhones
 * produce and browsers can't decode — gets a placeholder page naming the file, so the
 * packet never silently omits something.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { COMPANY_NAME } from './branding'

const PAGE = { w: 612, h: 792 }   // US Letter, points
const M = 48

export interface PacketField {
  label: string
  value: string
}

export interface PacketItem {
  label:  string
  s3Key:  string
  /** Shown under the item's heading, e.g. "Expires 03/2027". */
  note?:  string
}

export interface PacketInput {
  title:    string          // "Zak Mendoza" / "Truck 214"
  subtitle: string          // "Driver file" / "Truck file"
  fields:   PacketField[]
  items:    PacketItem[]
  /** Resolves an S3 key to a fetchable URL (presigned). */
  getUrl:   (s3Key: string) => Promise<string>
  /** Stamped on the cover; passed in so this stays deterministic/testable. */
  generatedAt: string
}

export type PacketItemOutcome = 'pdf' | 'image' | 'placeholder' | 'failed'

export interface PacketResult {
  bytes: Uint8Array
  /** Per-item outcome so the caller can warn about anything that didn't embed. */
  outcomes: { label: string; outcome: PacketItemOutcome }[]
}

const extOf = (key: string) => (key.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()

export const isPdfKey   = (key: string) => extOf(key) === 'pdf'
export const isImageKey = (key: string) => ['jpg', 'jpeg', 'png'].includes(extOf(key))
/** Accepted on upload but not embeddable by any browser-side PDF library. */
export const isUnembeddableKey = (key: string) => ['heic', 'heif'].includes(extOf(key))

function drawHeading(page: PDFPage, font: PDFFont, text: string, note?: string) {
  page.drawText(text, { x: M, y: PAGE.h - M, size: 13, font, color: rgb(0.07, 0.09, 0.13) })
  if (note) {
    page.drawText(note, { x: M, y: PAGE.h - M - 16, size: 9.5, font, color: rgb(0.45, 0.45, 0.45) })
  }
}

/** Fits an image inside the printable area, preserving aspect ratio. */
function fitBox(w: number, h: number, maxW: number, maxH: number) {
  const scale = Math.min(maxW / w, maxH / h, 1)
  return { w: w * scale, h: h * scale }
}

export async function buildFilePacket(input: PacketInput): Promise<PacketResult> {
  const doc = await PDFDocument.create()
  doc.setTitle(`${input.title} — ${input.subtitle}`)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const outcomes: PacketResult['outcomes'] = []

  // ── Cover sheet ───────────────────────────────────────────────────────────────
  const cover = doc.addPage([PAGE.w, PAGE.h])
  cover.drawRectangle({ x: 0, y: PAGE.h - 92, width: PAGE.w, height: 92, color: rgb(0, 0, 0) })
  cover.drawText(COMPANY_NAME, { x: M, y: PAGE.h - 46, size: 20, font: bold, color: rgb(1, 1, 1) })
  cover.drawText(input.subtitle, { x: M, y: PAGE.h - 68, size: 11, font, color: rgb(0.85, 0.85, 0.85) })

  let y = PAGE.h - 132
  cover.drawText(input.title, { x: M, y, size: 22, font: bold, color: rgb(0.07, 0.09, 0.13) })
  y -= 34

  for (const f of input.fields) {
    cover.drawText(f.label.toUpperCase(), { x: M, y, size: 8.5, font, color: rgb(0.55, 0.55, 0.55) })
    cover.drawText(f.value || '—', { x: M + 150, y, size: 11, font: bold, color: rgb(0.07, 0.09, 0.13) })
    y -= 22
  }

  y -= 14
  cover.drawText('CONTENTS', { x: M, y, size: 8.5, font, color: rgb(0.55, 0.55, 0.55) })
  y -= 18
  if (input.items.length === 0) {
    cover.drawText('No documents on file yet.', { x: M, y, size: 11, font, color: rgb(0.55, 0.55, 0.55) })
    y -= 18
  }
  for (const [i, item] of input.items.entries()) {
    cover.drawText(`${i + 1}.  ${item.label}${item.note ? `  ·  ${item.note}` : ''}`, {
      x: M, y, size: 10.5, font, color: rgb(0.07, 0.09, 0.13),
    })
    y -= 16
    if (y < M + 40) break   // the contents list is a summary; the pages themselves follow
  }

  cover.drawText(`Generated ${input.generatedAt}`, {
    x: M, y: M, size: 8.5, font, color: rgb(0.55, 0.55, 0.55),
  })

  // ── One section per document ──────────────────────────────────────────────────
  for (const item of input.items) {
    try {
      if (isUnembeddableKey(item.s3Key)) {
        const page = doc.addPage([PAGE.w, PAGE.h])
        drawHeading(page, bold, item.label, item.note)
        page.drawText('This file is in HEIC format and cannot be shown inside a PDF.', {
          x: M, y: PAGE.h / 2, size: 11, font, color: rgb(0.4, 0.4, 0.4),
        })
        page.drawText('Download it individually from the Files page.', {
          x: M, y: PAGE.h / 2 - 18, size: 11, font, color: rgb(0.4, 0.4, 0.4),
        })
        outcomes.push({ label: item.label, outcome: 'placeholder' })
        continue
      }

      const url = await input.getUrl(item.s3Key)
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())

      if (isPdfKey(item.s3Key)) {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
        const pages = await doc.copyPages(src, src.getPageIndices())
        pages.forEach((p) => doc.addPage(p))
        outcomes.push({ label: item.label, outcome: 'pdf' })
        continue
      }

      const img = extOf(item.s3Key) === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
      const page = doc.addPage([PAGE.w, PAGE.h])
      drawHeading(page, bold, item.label, item.note)
      const box = fitBox(img.width, img.height, PAGE.w - M * 2, PAGE.h - M * 2 - 48)
      page.drawImage(img, {
        x: (PAGE.w - box.w) / 2,
        y: (PAGE.h - 48 - box.h) / 2,
        width: box.w,
        height: box.h,
      })
      outcomes.push({ label: item.label, outcome: 'image' })
    } catch (err) {
      console.error('[filePacket] could not embed', item.label, err)
      const page = doc.addPage([PAGE.w, PAGE.h])
      drawHeading(page, bold, item.label, item.note)
      page.drawText('This document could not be added to the packet.', {
        x: M, y: PAGE.h / 2, size: 11, font, color: rgb(0.7, 0.15, 0.15),
      })
      page.drawText('Download it individually from the Files page.', {
        x: M, y: PAGE.h / 2 - 18, size: 11, font, color: rgb(0.4, 0.4, 0.4),
      })
      outcomes.push({ label: item.label, outcome: 'failed' })
    }
  }

  return { bytes: await doc.save(), outcomes }
}

/** "zak-mendoza-driver-file-2026-08-05.pdf" */
export function packetFilename(title: string, kind: 'driver' | 'truck', dateIso: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${slug}-${kind}-file-${dateIso}.pdf`
}
