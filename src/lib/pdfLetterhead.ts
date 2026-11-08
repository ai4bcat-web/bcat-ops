/**
 * The shared letterhead of the broker's generated PDFs (rate confirmation, bill of
 * lading): a black band, the division logo on a white plate when it has a PNG/JPEG
 * one, the legal name and ids, and the document title on the right.
 *
 * Browser only (jsPDF); `@/` paths are fine here.
 */
import type jsPDF from 'jspdf'
import type { Division } from '@/types/tms'

export interface HeaderLogo { dataUrl: string; format: 'PNG' | 'JPEG'; width: number; height: number }

export const LETTERHEAD_MARGIN = 40
export const LETTERHEAD_HEIGHT = 70

const LOGO_BOX_W = 150
const LOGO_BOX_H = 38

/**
 * The division logo fitted into its box, or null. Every failure (no key, loader null or
 * throw, undecodable or non-PNG/JPEG image) is the same fallback: the text header.
 * A logo problem must never fail a send.
 */
export async function resolveLetterhead(
  doc: jsPDF,
  division: Pick<Division, 'logoKey'> | null,
  loadLogo: (logoKey: string) => Promise<string | null>,
): Promise<HeaderLogo | null> {
  const logoKey = division?.logoKey
  if (!logoKey) return null
  try {
    const dataUrl = await loadLogo(logoKey)
    if (!dataUrl) return null
    const props = doc.getImageProperties(dataUrl)
    const format = String(props.fileType).toUpperCase()
    if ((format !== 'PNG' && format !== 'JPEG') || !(props.width > 0) || !(props.height > 0)) return null
    const scale = Math.min(LOGO_BOX_W / props.width, LOGO_BOX_H / props.height)
    return { dataUrl, format, width: props.width * scale, height: props.height * scale }
  } catch {
    return null
  }
}

export interface LetterheadContent {
  legalName: string
  /** `MC … · DOT …`, already joined. */
  ids: string
  /** One printed line under the ids (address, phone); omitted = the rate-con layout. */
  detail?: string
  title: string
  subtitle: string
  logo: HeaderLogo | null
}

/** Black band at the top of one page. */
export function drawLetterhead(doc: jsPDF, content: LetterheadContent): void {
  const M = LETTERHEAD_MARGIN
  const W = doc.internal.pageSize.getWidth()
  const { logo, legalName, ids, detail } = content
  doc.setFillColor(0, 0, 0)
  doc.rect(0, 0, W, LETTERHEAD_HEIGHT, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  const small = (text: string, x: number, y: number, size: number) => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(size)
    doc.setTextColor(190, 200, 215)
    doc.text(text, x, y)
  }
  if (logo) {
    // Brand marks are usually dark: sit it on a white plate inside the black band. The
    // fixed alias embeds the image once however many pages draw the header.
    const plateW = logo.width + 16
    doc.setFillColor(255, 255, 255)
    doc.roundedRect(M - 8, 10, plateW, 50, 5, 5, 'F')
    doc.addImage(logo.dataUrl, logo.format, M, 35 - logo.height / 2, logo.width, logo.height, 'division-logo')
    const x = M + plateW + 10
    doc.setFontSize(11)
    const name = (doc.splitTextToSize(legalName, W - M - 150 - x) as string[])[0] ?? legalName
    doc.text(name, x, detail ? 25 : 32)
    if (ids) small(ids, x, detail ? 38 : 47, 9)
    if (detail) small((doc.splitTextToSize(detail, W - M - 150 - x) as string[])[0] ?? detail, x, 51, 8)
  } else {
    doc.setFontSize(16)
    doc.text(legalName, M, detail ? 28 : 34)
    if (ids) small(ids, M, detail ? 42 : 50, 9)
    if (detail) small((doc.splitTextToSize(detail, W - M - 150 - M) as string[])[0] ?? detail, M, 55, 8)
  }
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text(content.title, W - M, 32, { align: 'right' })
  small(content.subtitle, W - M, 48, 10)
}
