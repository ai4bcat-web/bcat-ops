/**
 * Signed rate confirmation: stamps the carrier's typed signature onto the ORIGINAL rate con PDF bytes
 * (at the Carrier Signature / Date line) and appends a Signing Certificate page.
 *
 * Runs on the server (rate-con-sign-api) from the stored unsigned bytes, never from bytes the browser
 * supplied: the page can be lied to, the S3 object cannot. Takes bytes, returns bytes; it knows nothing
 * about DynamoDB or S3, and does not import the jsPDF layout module (it would bloat the Lambda).
 */
import { createHash } from 'node:crypto'
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'

/**
 * Where the signature and date go on the rate con page, in pdf-lib points (origin bottom-left, letter).
 * MUST equal RATE_CON_SIGNATURE_ANCHOR exported by carrierRateCon.ts (the layout owner); a test pins the two.
 */
export const SIGNATURE_ANCHOR = {
  page: 'last' as const,
  signatureLine: { x: 105.6, y: 792 - 759.2, width: 216.1 },
  dateLine: { x: 390, y: 792 - 759.2, width: 143.4 },
  dateSegments: [{ x: 390, width: 44 }, { x: 439.7, width: 44 }, { x: 489.4, width: 44 }],
}

export interface SigningEvidence {
  /** `Rate Confirmation — PRO 14832` */
  documentTitle: string
  pro: string
  version: number
  /** The signed document's id (ShipmentDocument.id). */
  documentId: string
  signerName: string
  signerEmail: string
  /** ISO instants. */
  sentAt: string | null
  sentBy: string | null
  viewedAt: string | null
  signedAt: string
  ip: string
  userAgent: string
  /** CloudFront-Viewer-* headers only; null when the request carried none. */
  location: string | null
  /** What the carrier filled in: label -> value. */
  details: Record<string, string>
  consentText: string
}

export interface SignedRateCon {
  bytes: Uint8Array
  /** sha-256 hex of the unsigned PDF exactly as it was sent. */
  unsignedSha256: string
  pages: number
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const ZONE = 'America/New_York'

/** `Nov 9, 2026 3:04:05 PM EST` */
export function formatInstant(iso: string | null): string {
  if (!iso) return 'Not recorded'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Not recorded'
  return d.toLocaleString('en-US', { timeZone: ZONE, dateStyle: 'medium', timeStyle: 'medium' }) + ' ' +
    (new Intl.DateTimeFormat('en-US', { timeZone: ZONE, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? 'ET')
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  const push = (word: string) => {
    // A token longer than the line (hash, user agent) is cut by character.
    let rest = word
    while (font.widthOfTextAtSize(rest, size) > maxWidth) {
      let n = rest.length
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n--
      lines.push(rest.slice(0, n))
      rest = rest.slice(n)
    }
    return rest
  }
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue }
    if (line) lines.push(line)
    line = push(word)
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

/** Shrink the font until `text` fits `width`. */
function fit(text: string, font: PDFFont, size: number, width: number): number {
  let s = size
  while (s > 6 && font.widthOfTextAtSize(text, s) > width) s -= 0.5
  return s
}

function stampLine(page: PDFPage, name: string, signedAt: string, italic: PDFFont, plain: PDFFont): void {
  const { signatureLine, dateSegments } = SIGNATURE_ANCHOR
  const size = fit(name, italic, 18, signatureLine.width - 4)
  page.drawText(name, { x: signatureLine.x + 2, y: signatureLine.y + 3, size, font: italic, color: rgb(0.05, 0.13, 0.45) })
  page.drawText(`e-signed ${formatInstant(signedAt)}`, { x: signatureLine.x + 2, y: signatureLine.y - 8, size: 5.5, font: plain, color: rgb(0.4, 0.4, 0.4) })
  const d = new Date(signedAt)
  const part = (type: string) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, [type]: type === 'year' ? 'numeric' : '2-digit' }).format(d)
  const values = [part('month'), part('day'), part('year')]
  dateSegments.forEach((segment, i) => {
    const w = plain.widthOfTextAtSize(values[i], 11)
    page.drawText(values[i], { x: segment.x + (segment.width - w) / 2, y: SIGNATURE_ANCHOR.dateLine.y + 3, size: 11, font: plain, color: rgb(0.05, 0.13, 0.45) })
  })
}

function certificate(pdf: PDFDocument, ev: SigningEvidence, unsignedSha256: string, regular: PDFFont, bold: PDFFont, italic: PDFFont): void {
  const page = pdf.addPage([612, 792])
  const M = 48
  const W = 612 - M * 2
  const ink = rgb(0.1, 0.12, 0.18)
  const muted = rgb(0.4, 0.43, 0.5)
  page.drawRectangle({ x: 0, y: 722, width: 612, height: 70, color: rgb(0.08, 0.1, 0.16) })
  page.drawText('SIGNING CERTIFICATE', { x: M, y: 748, size: 18, font: bold, color: rgb(1, 1, 1) })
  page.drawText('Electronic signature record', { x: M, y: 731, size: 9, font: regular, color: rgb(0.8, 0.82, 0.88) })

  let y = 696
  const section = (title: string) => {
    y -= 8
    page.drawText(title, { x: M, y, size: 9, font: bold, color: muted })
    page.drawLine({ start: { x: M, y: y - 4 }, end: { x: M + W, y: y - 4 }, thickness: 0.5, color: rgb(0.8, 0.82, 0.86) })
    y -= 18
  }
  const row = (label: string, value: string, f: PDFFont = regular) => {
    page.drawText(label, { x: M, y, size: 9, font: bold, color: ink })
    const lines = wrap(value || '-', f, 9, W - 130)
    for (const line of lines) {
      page.drawText(line, { x: M + 130, y, size: 9, font: f, color: ink })
      y -= 12.5
    }
    y -= 2.5
  }

  section('DOCUMENT')
  row('Title', ev.documentTitle)
  row('PRO #', ev.pro)
  row('Version', `v${ev.version}`)
  row('Document ID', ev.documentId)
  row('SHA-256 (unsigned PDF)', unsignedSha256)

  section('SIGNER')
  page.drawText(ev.signerName, { x: M + 130, y: y - 2, size: 20, font: italic, color: rgb(0.05, 0.13, 0.45) })
  page.drawText('Signature (typed name adopted as signature)', { x: M, y, size: 9, font: bold, color: ink })
  y -= 28
  row('Name', ev.signerName)
  row('E-mail', ev.signerEmail)
  for (const [label, value] of Object.entries(ev.details)) row(label, value)

  section('TIMELINE')
  row('Sent', `${formatInstant(ev.sentAt)}${ev.sentBy ? ` by ${ev.sentBy}` : ''}`)
  row('Viewed', formatInstant(ev.viewedAt))
  row('Signed', formatInstant(ev.signedAt))

  section('SIGNING SESSION')
  row('IP address', ev.ip)
  row('Location', ev.location ?? 'Not available')
  row('User agent', ev.userAgent || 'Not available')

  section('CONSENT')
  for (const line of wrap(ev.consentText, regular, 9, W)) {
    page.drawText(line, { x: M, y, size: 9, font: regular, color: ink })
    y -= 12.5
  }
  page.drawText('This certificate is part of the signed document. The hash above identifies the exact PDF the signer was shown.', { x: M, y: 40, size: 7, font: regular, color: muted })
}

/** Stamp the signature on the last page of `unsigned`, append the certificate, return the new bytes. */
export async function buildSignedRateCon(unsigned: Uint8Array, ev: SigningEvidence): Promise<SignedRateCon> {
  const unsignedSha256 = sha256Hex(unsigned)
  const pdf = await PDFDocument.load(unsigned)
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const italic = await pdf.embedFont(StandardFonts.TimesRomanBoldItalic)
  const pages = pdf.getPages()
  stampLine(pages[pages.length - 1], ev.signerName, ev.signedAt, italic, regular)
  certificate(pdf, ev, unsignedSha256, regular, bold, italic)
  const bytes = await pdf.save()
  return { bytes, unsignedSha256, pages: pdf.getPageCount() }
}
