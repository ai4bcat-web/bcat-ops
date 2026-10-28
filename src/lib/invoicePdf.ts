/**
 * Invoice PDF — the bill the customer receives.
 *
 * The same bytes serve both callers: the browser renders a preview from this function and
 * `tmsFinanceActions` stores what it returns under `invoices/*`. So nothing here may touch
 * `node:*`, `document` or `canvas` — pdf-lib and `Intl` only. That rules out
 * `jspdf-autotable` (DOM-bound, and jsPDF cannot be handed back as bytes without a shim),
 * which is why the line-item table is laid out by hand: every column has a fixed box, money
 * is right-aligned off a measured string width, and a long description wraps to two lines
 * and then truncates rather than running under the rate.
 *
 * Every string is folded to ASCII before it is drawn. Two reasons: the standard PDF fonts
 * encode WinAnsi and throw on anything outside it, and a factored invoice is posted to OTR,
 * whose upload path mangles high bytes (see `amplify/functions/_shared/asciiSafePdf.ts`).
 *
 * What is NOT on this document: carrier pay, cost, margin, or any internal reference. The
 * renderer prints `InvoiceInput` and nothing else, and that type carries none of them.
 */
// Relative, not `@/` — tmsFinanceActions bundles this file by path to render the invoice it
// stores, and the alias does not exist in the function build.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { InvoiceInput, InvoiceStop } from './invoiceBuild'
import type { Address } from '../types/tms'

const PAGE = { w: 612, h: 792 } // US Letter, points
const M = 40
const HEADER_H = 70
/** First baseline under the header band — the rate con's `drawParties` start. */
const BODY_TOP = 100
const FOOT_ROOM = 56
const CONTENT_W = PAGE.w - M * 2

const WHITE = rgb(1, 1, 1)
const BLACK = rgb(0, 0, 0)
const BAND = rgb(15 / 255, 23 / 255, 42 / 255)
const BAND_TEXT = rgb(190 / 255, 200 / 255, 215 / 255)
const MUTED = rgb(107 / 255, 114 / 255, 128 / 255)
const BODY = rgb(55 / 255, 65 / 255, 81 / 255)
const INK = rgb(31 / 255, 41 / 255, 55 / 255)
const ZEBRA = rgb(247 / 255, 248 / 255, 250 / 255)
const RULE = rgb(203 / 255, 213 / 255, 225 / 255)
const NOTICE_FILL = rgb(254 / 255, 249 / 255, 231 / 255)
const NOTICE_EDGE = rgb(202 / 255, 138 / 255, 4 / 255)

/** Column boxes for the charge table. Money columns are named by their right edge. */
const COL = {
  code: { x: M + 4, w: 52 },
  label: { x: M + 62, w: 236 },
  count: { right: 392 },
  rate: { right: 470 },
  amount: { right: PAGE.w - M - 4 },
}
const LABEL_SIZE = 8.5
const LABEL_LINE = 10.5
const LABEL_MAX_LINES = 2

const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const cents = (n: number) => moneyFmt.format(n / 100)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Punctuation the standard fonts cannot encode, mapped to what a printer reads the same. */
const FOLD: Record<string, string> = {
  '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u00b7': '-', '\u2022': '*',
  '\u2018': "'", '\u2019': "'", '\u201a': ',', '\u201c': '"', '\u201d': '"',
  '\u2026': '...', '\u00a0': ' ', '\u2044': '/', '\u20ac': 'EUR', '\u00a3': 'GBP',
}

/**
 * ASCII only: accents are stripped to their base letter, typographic punctuation folded,
 * and anything still outside 0x20–0x7E dropped. A name is better bare than undrawable.
 */
function ascii(text: string): string {
  let out = ''
  for (const ch of text.normalize('NFKD')) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x20 && code <= 0x7e) out += ch
    else if (FOLD[ch] !== undefined) out += FOLD[ch]
    else if (code === 0x09 || code === 0x0a || code === 0x0d) out += ' '
  }
  return out
}

/** `YYYY-MM-DD` without going through `Date`, which would shift the day west of UTC. */
function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return ascii(iso) || '-'
  const month = MONTHS[Number(m[2]) - 1] ?? m[2]
  return `${month} ${Number(m[3])}, ${m[1]}`
}

/** An appointment is a real instant, so it is formatted in the reader's zone. */
function apptOf(stop: InvoiceStop): string {
  if (!stop.apptAt) return ''
  const at = new Date(stop.apptAt)
  if (Number.isNaN(at.getTime())) return ''
  const date = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date} ${time}`
}

function addressLines(address: Address | null | undefined): string[] {
  if (!address) return []
  const cityLine = [address.city, [address.state, address.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ')
  return [address.street ?? '', cityLine].filter((line): line is string => Boolean(line))
}

function termsLabel(termsDays: number): string {
  return termsDays > 0 ? `Net ${termsDays}` : 'Due on receipt'
}

/** Truncate to fit `maxW`, marking the cut so nobody reads a clipped word as the whole one. */
function fit(font: PDFFont, text: string, size: number, maxW: number): string {
  const s = ascii(text)
  if (font.widthOfTextAtSize(s, size) <= maxW) return s
  let cut = s.length
  while (cut > 0 && font.widthOfTextAtSize(`${s.slice(0, cut)}...`, size) > maxW) cut -= 1
  return `${s.slice(0, cut).trimEnd()}...`
}

/** Greedy word wrap; a single word wider than the box is broken on the character. */
function wrapText(font: PDFFont, text: string, size: number, maxW: number): string[] {
  const words = ascii(text).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) <= maxW) {
      line = next
      continue
    }
    if (line) lines.push(line)
    let rest = word
    while (font.widthOfTextAtSize(rest, size) > maxW) {
      let cut = rest.length
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxW) cut -= 1
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    line = rest
  }
  if (line) lines.push(line)
  return lines
}

function clamp(font: PDFFont, lines: string[], size: number, maxW: number, maxLines: number): string[] {
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = fit(font, `${kept[maxLines - 1]} ${lines[maxLines]}`, size, maxW)
  return kept
}

/** The in-flight document. `y` is distance from the TOP of the page, as in `carrierRateCon`. */
interface Doc {
  pdf: PDFDocument
  font: PDFFont
  bold: PDFFont
  page: PDFPage
  y: number
}

function textAt(d: Doc, text: string, x: number, y: number, size: number, font: PDFFont, color = BODY): void {
  const s = ascii(text)
  if (!s) return
  d.page.drawText(s, { x, y: PAGE.h - y, size, font, color })
}

function rightAt(d: Doc, text: string, right: number, y: number, size: number, font: PDFFont, color = BODY): void {
  const s = ascii(text)
  if (!s) return
  d.page.drawText(s, { x: right - font.widthOfTextAtSize(s, size), y: PAGE.h - y, size, font, color })
}

/** A filled band whose `top` is measured from the top of the page. */
function band(d: Doc, top: number, height: number, color = ZEBRA, x = M, width = CONTENT_W): void {
  d.page.drawRectangle({ x, y: PAGE.h - top - height, width, height, color })
}

function rule(d: Doc, y: number, from = M, to = PAGE.w - M): void {
  d.page.drawLine({ start: { x: from, y: PAGE.h - y }, end: { x: to, y: PAGE.h - y }, thickness: 0.5, color: RULE })
}

function sectionLabel(d: Doc, text: string, x = M): void {
  textAt(d, text, x, d.y, 9, d.bold, MUTED)
  d.y += 14
}

/** Who is billing, which invoice. Repeated at the top of every page. */
function drawHeader(d: Doc, input: InvoiceInput): void {
  d.page.drawRectangle({ x: 0, y: PAGE.h - HEADER_H, width: PAGE.w, height: HEADER_H, color: BLACK })
  const name = input.broker.legalName || input.broker.name || 'Broker'
  textAt(d, fit(d.bold, name, 16, CONTENT_W - 180), M, 34, 16, d.bold, WHITE)
  const ids = [
    input.broker.mcNumber ? `MC ${input.broker.mcNumber}` : '',
    input.broker.dotNumber ? `DOT ${input.broker.dotNumber}` : '',
  ]
    .filter(Boolean)
    .join('  -  ')
  if (ids) textAt(d, ids, M, 50, 9, d.font, BAND_TEXT)
  rightAt(d, 'INVOICE', PAGE.w - M, 32, 13, d.bold, WHITE)
  rightAt(d, `Invoice ${input.number}`, PAGE.w - M, 48, 10, d.font, BAND_TEXT)
}

function newPage(d: Doc, input: InvoiceInput): void {
  d.page = d.pdf.addPage([PAGE.w, PAGE.h])
  drawHeader(d, input)
  d.y = BODY_TOP
}

/** Reserve `h` points, continuing onto a fresh page if they are gone. */
function room(d: Doc, input: InvoiceInput, h: number): void {
  if (d.y + h <= PAGE.h - FOOT_ROOM) return
  newPage(d, input)
}

/** Remit-to on the left, who we are billing on the right. */
function drawParties(d: Doc, input: InvoiceInput): void {
  const right = PAGE.w / 2 + 10
  const colW = PAGE.w / 2 - M - 10
  textAt(d, 'REMIT TO', M, d.y, 9, d.bold, MUTED)
  textAt(d, 'BILL TO', right, d.y, 9, d.bold, MUTED)
  d.y += 14

  const remit = [input.remitTo.name, ...addressLines(input.remitTo.address), input.remitTo.email ?? '']
    .filter(Boolean)
    .map(String)
  const billTo = [input.billTo.name, ...addressLines(input.billTo.address), input.billTo.email ?? '']
    .filter(Boolean)
    .map(String)

  const rows = Math.max(remit.length, billTo.length, 1)
  for (let i = 0; i < rows; i += 1) {
    const font = i === 0 ? d.bold : d.font
    if (remit[i]) textAt(d, fit(font, remit[i], 10, colW), M, d.y + i * 13, 10, font, i === 0 ? INK : BODY)
    if (billTo[i]) textAt(d, fit(font, billTo[i], 10, colW), right, d.y + i * 13, 10, font, i === 0 ? INK : BODY)
  }
  d.y += rows * 13 + 12
}

/** Number, dates and terms in four cells — what an AP clerk reads first. */
function drawMeta(d: Doc, input: InvoiceInput): void {
  const cells: Array<[string, string]> = [
    ['INVOICE NUMBER', input.number],
    ['INVOICE DATE', formatDate(input.invoiceDate)],
    ['DUE DATE', formatDate(input.dueAt)],
    ['TERMS', termsLabel(input.termsDays)],
  ]
  const cellW = CONTENT_W / cells.length
  rule(d, d.y)
  d.y += 14
  cells.forEach(([label, value], i) => {
    const x = M + i * cellW
    textAt(d, label, x, d.y, 7.5, d.bold, MUTED)
    textAt(d, fit(d.bold, value, 11, cellW - 10), x, d.y + 15, 11, d.bold, INK)
  })
  d.y += 24
  rule(d, d.y)
  d.y += 18
}

/** The shipment this bill covers and where the freight went. */
function drawShipment(d: Doc, input: InvoiceInput): void {
  room(d, input, 40)
  sectionLabel(d, 'SHIPMENT')
  textAt(d, input.shipmentNumber || '-', M, d.y, 11, d.bold, INK)
  if (input.customerName) {
    rightAt(d, fit(d.font, input.customerName, 10, CONTENT_W / 2), PAGE.w - M, d.y, 10, d.font, BODY)
  }
  d.y += 16

  const apptW = 150
  const stopW = CONTENT_W - apptW - 12
  for (let i = 0; i < input.stops.length; i += 1) {
    const stop = input.stops[i]
    room(d, input, 16)
    const where = [stop.name ?? '', [stop.city, stop.state].filter(Boolean).join(', ')].filter(Boolean).join(' - ')
    const text = `${i + 1}. ${stop.kind === 'PICKUP' ? 'Pickup' : 'Delivery'}   ${where || '-'}`
    textAt(d, fit(d.font, text, 9.5, stopW), M, d.y, 9.5, d.font, BODY)
    const appt = apptOf(stop)
    if (appt) rightAt(d, fit(d.font, appt, 9.5, apptW), PAGE.w - M, d.y, 9.5, d.font, MUTED)
    d.y += 13
  }
  d.y += 8
}

function drawReferences(d: Doc, input: InvoiceInput): void {
  if (!input.references.length) return
  // Wrapping collapses runs of spaces, so the separator has to be a character.
  const text = input.references.map((r) => `${r.label || r.code}: ${r.value}`).join(' | ')
  const lines = wrapText(d.font, text, 9.5, CONTENT_W)
  room(d, input, lines.length * 13 + 20)
  sectionLabel(d, 'REFERENCES')
  for (const line of lines) {
    textAt(d, line, M, d.y, 9.5, d.font, BODY)
    d.y += 13
  }
  d.y += 8
}

/** Repeated whenever the charge table continues on a new page. */
function drawTableHead(d: Doc): void {
  band(d, d.y, 18, BAND)
  const baseline = d.y + 12.5
  textAt(d, 'CODE', COL.code.x, baseline, LABEL_SIZE, d.bold, WHITE)
  textAt(d, 'DESCRIPTION', COL.label.x, baseline, LABEL_SIZE, d.bold, WHITE)
  rightAt(d, 'QTY', COL.count.right, baseline, LABEL_SIZE, d.bold, WHITE)
  rightAt(d, 'RATE', COL.rate.right, baseline, LABEL_SIZE, d.bold, WHITE)
  rightAt(d, 'AMOUNT', COL.amount.right, baseline, LABEL_SIZE, d.bold, WHITE)
  d.y += 24
}

function drawCharges(d: Doc, input: InvoiceInput): void {
  room(d, input, 70)
  drawTableHead(d)

  input.lines.forEach((line, i) => {
    const labelLines = clamp(
      d.font,
      wrapText(d.font, line.label || line.code, LABEL_SIZE, COL.label.w),
      LABEL_SIZE,
      COL.label.w,
      LABEL_MAX_LINES,
    )
    const height = Math.max(17, labelLines.length * LABEL_LINE + 7)
    if (d.y + height > PAGE.h - FOOT_ROOM) {
      newPage(d, input)
      drawTableHead(d)
    }
    const top = d.y
    if (i % 2 === 1) band(d, top - 4, height, ZEBRA)
    const baseline = top + 8
    textAt(d, fit(d.bold, line.code, LABEL_SIZE, COL.code.w), COL.code.x, baseline, LABEL_SIZE, d.bold, INK)
    labelLines.forEach((text, n) => {
      textAt(d, text, COL.label.x, baseline + n * LABEL_LINE, LABEL_SIZE, d.font, BODY)
    })
    rightAt(d, String(line.count), COL.count.right, baseline, LABEL_SIZE, d.font, BODY)
    rightAt(d, cents(line.rateCents), COL.rate.right, baseline, LABEL_SIZE, d.font, BODY)
    rightAt(d, cents(line.amountCents), COL.amount.right, baseline, LABEL_SIZE, d.font, INK)
    d.y = top + height
  })

  d.y += 2
  rule(d, d.y, PAGE.w - M - 260)
}

function drawTotals(d: Doc, input: InvoiceInput): void {
  room(d, input, 64)
  d.y += 18
  const labelRight = PAGE.w - M - 120
  rightAt(d, 'Subtotal', labelRight, d.y, 10, d.font, BODY)
  rightAt(d, cents(input.subtotalCents), COL.amount.right, d.y, 10, d.font, BODY)
  d.y += 10
  rule(d, d.y, PAGE.w - M - 260)
  d.y += 18
  rightAt(d, 'TOTAL DUE', labelRight, d.y, 11, d.bold, INK)
  rightAt(d, cents(input.totalCents), COL.amount.right, d.y, 13, d.bold, INK)
  d.y += 22
}

/** The factor's assignment notice must be on the face of the invoice, not a cover note. */
function drawFactorNotice(d: Doc, input: InvoiceInput): void {
  const notice = input.factorNoticeText
  if (!notice) return
  const innerW = CONTENT_W - 20
  const lines = wrapText(d.font, notice, 9, innerW)
  const height = lines.length * 12 + 28
  room(d, input, height + 12)
  const top = d.y
  d.page.drawRectangle({
    x: M,
    y: PAGE.h - top - height,
    width: CONTENT_W,
    height,
    color: NOTICE_FILL,
    borderColor: NOTICE_EDGE,
    borderWidth: 0.8,
  })
  textAt(d, 'NOTICE OF ASSIGNMENT', M + 10, top + 15, 8.5, d.bold, INK)
  lines.forEach((line, i) => {
    textAt(d, line, M + 10, top + 30 + i * 12, 9, d.font, INK)
  })
  d.y = top + height + 14
}

function drawTerms(d: Doc, input: InvoiceInput): void {
  const terms = input.termsText || `${termsLabel(input.termsDays)}. Payment due per the terms of the rate agreement.`
  const lines = wrapText(d.font, terms, 8, CONTENT_W)
  room(d, input, lines.length * 10 + 24)
  sectionLabel(d, 'TERMS')
  lines.forEach((line, i) => {
    textAt(d, line, M, d.y + i * 10, 8, d.font, MUTED)
  })
  d.y += lines.length * 10 + 6
}

/** Drawn last, when the page count is finally known. */
function drawPageNumbers(d: Doc): void {
  const pages = d.pdf.getPages()
  pages.forEach((page, i) => {
    const text = `Page ${i + 1} of ${pages.length}`
    page.drawText(text, {
      x: PAGE.w - M - d.font.widthOfTextAtSize(text, 8),
      y: 28,
      size: 8,
      font: d.font,
      color: MUTED,
    })
  })
}

/**
 * Render the invoice. One page while the lines fit; the charge table continues onto as many
 * pages as it needs, each carrying the header band and the column heads, and every page is
 * numbered once the count is known.
 */
export async function buildInvoicePdf(input: InvoiceInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  pdf.setTitle(ascii(`Invoice ${input.number}`))
  pdf.setAuthor(ascii(input.broker.legalName || input.broker.name || 'Broker'))
  pdf.setSubject(ascii(`Invoice ${input.number} - ${input.billTo.name}`))

  const d: Doc = { pdf, font, bold, page: pdf.addPage([PAGE.w, PAGE.h]), y: BODY_TOP }
  drawHeader(d, input)
  drawParties(d, input)
  drawMeta(d, input)
  drawShipment(d, input)
  drawReferences(d, input)
  drawCharges(d, input)
  drawTotals(d, input)
  drawFactorNotice(d, input)
  drawTerms(d, input)
  drawPageNumbers(d)

  return pdf.save()
}

/** `INV-000123-v2.pdf` — the stored key and the e-mail attachment name. */
export function invoiceFilename(number: string, version: number): string {
  const safe = ascii(number)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|-+$/g, '')
  const v = Math.max(1, Math.trunc(Number.isFinite(version) ? version : 1))
  return `${safe || 'invoice'}-v${v}.pdf`
}
