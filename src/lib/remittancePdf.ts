/**
 * Remittance advice — what the carrier (or their factor) receives when we send money.
 *
 * The AP twin of `invoicePdf.ts`, and it obeys the same two rules. The same bytes serve
 * both callers: the browser renders a preview from `buildRemittancePdf` and
 * `tmsFinanceActions` stores what it returns under `remittances/*`, so nothing here may
 * touch `node:*`, `document` or `canvas` — pdf-lib and `Intl` only. And every string is
 * folded to ASCII, because the standard PDF fonts encode WinAnsi and throw on anything
 * outside it.
 *
 * What is NOT on this document: the customer's rate, the margin, any internal note, and
 * any bank detail beyond the method word. A remittance leaves the building addressed to
 * the payee, so `RemittanceData` carries nothing it may not print — `remittanceData` is
 * the filter, and everything below it only draws what that type holds.
 */
// Relative, not `@/` — tmsFinanceActions bundles this file by path to render the
// remittance it stores, and the alias does not exist in the function build.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type {
  Address,
  ApPaymentMethod,
  ApPaymentRecord,
  ApRemitTo,
  CarrierBillRecord,
  CarrierRecord,
  Division,
} from '../types/tms'

const PAGE = { w: 612, h: 792 } // US Letter, points
const M = 40
const HEADER_H = 70
/** First baseline under the header band — the invoice's `drawParties` start. */
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

/** Column boxes for the bill table. Money columns are named by their right edge. */
const COL = {
  bill: { x: M + 4, w: 86 },
  shipment: { x: M + 94, w: 76 },
  load: { x: M + 174, w: 70 },
  gross: { right: 368 },
  fee: { right: 434 },
  credit: { right: 500 },
  paid: { right: PAGE.w - M - 4 },
}
const ROW_SIZE = 8.5

const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const cents = (n: number) => moneyFmt.format(n / 100)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const METHOD_LABEL: Record<ApPaymentMethod, string> = {
  ACH: 'ACH',
  WIRE: 'Wire',
  CHECK: 'Check',
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  EFT: 'EFT',
  OTHER: 'Other',
}

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

function addressLines(address: Address | null | undefined): string[] {
  if (!address) return []
  const cityLine = [address.city, [address.state, address.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ')
  return [address.street ?? '', cityLine].filter((line): line is string => Boolean(line))
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

// ── The view model ───────────────────────────────────────────────────────────

/** Who sent the money, printed the way `carrierRateCon` prints the division. */
export interface RemittanceParty {
  name: string
  /** `MC 123456  -  DOT 654321`, or empty when the division carries neither. */
  ids: string
  /** Remit-to name, street, city line and e-mail, in that order, blanks dropped. */
  lines: string[]
}

/** Who was paid: always the carrier, named here so a factor can apply the money. */
export interface RemittancePayee {
  carrierId: string
  name: string
  mcNumber: string | null
}

/** One bill this payment settled, as the payee sees it. */
export interface RemittanceRow {
  billId: string
  /** The carrier's own invoice number — what they will match on. */
  billNumber: string
  shipmentNumber: string
  loadNumber: string
  grossCents: number
  quickPayFeeCents: number
  /** The slice of this row funded by an AP credit rather than by the bank. */
  creditCents: number
  /** What this payment put against the bill, credits included. */
  paidCents: number
}

export interface RemittanceTotals {
  grossCents: number
  quickPayFeeCents: number
  creditCents: number
  paidCents: number
}

export interface RemittanceData {
  payer: RemittanceParty
  payee: RemittancePayee
  /** Where the money actually went; the factor when the bill was assigned. */
  remitTo: ApRemitTo | null
  /** `YYYY-MM-DD` of the payment. */
  date: string
  method: ApPaymentMethod | null
  /** The check or trace number, falling back to the payment id so a row is always named. */
  reference: string
  rows: RemittanceRow[]
  totals: RemittanceTotals
}

export interface RemittanceDataInput {
  payment: ApPaymentRecord
  /** The bills this payment touched; extra bills are ignored, missing ones still print. */
  bills: CarrierBillRecord[]
  carrier?: Pick<CarrierRecord, 'name' | 'mcNumber'> | null
  division?: Pick<
    Division,
    'name' | 'legalName' | 'mcNumber' | 'dotNumber' | 'remitToName' | 'remitToAddress' | 'remitToEmail'
  > | null
}

/** The division block, in `carrierRateCon`'s `brokerLines` shape. */
function payerOf(division: RemittanceDataInput['division']): RemittanceParty {
  const name = division?.legalName || division?.name || 'Broker'
  const ids = [
    division?.mcNumber ? `MC ${division.mcNumber}` : '',
    division?.dotNumber ? `DOT ${division.dotNumber}` : '',
  ]
    .filter(Boolean)
    .join('  -  ')
  const lines = [
    division?.remitToName || name,
    ...addressLines(division?.remitToAddress),
    division?.remitToEmail ?? '',
  ].filter((line): line is string => Boolean(line))
  return { name, ids, lines }
}

/**
 * The payee's view of one payment.
 *
 * Rows are driven by the payment's applications, not by the bills handed in: the totals
 * have to come to exactly what was sent, so a bill the caller failed to load still prints
 * its money under a blank number rather than quietly leaving the page short.
 */
export function remittanceData(input: RemittanceDataInput): RemittanceData {
  const { payment } = input
  const billById = new Map<string, CarrierBillRecord>()
  for (const bill of input.bills) billById.set(bill.id, bill)

  const rows: RemittanceRow[] = []
  const totals: RemittanceTotals = { grossCents: 0, quickPayFeeCents: 0, creditCents: 0, paidCents: 0 }
  for (const application of payment.applications ?? []) {
    const bill = billById.get(application.billId)
    const creditCents = application.creditCents ?? 0
    const row: RemittanceRow = {
      billId: application.billId,
      billNumber: bill?.billNumber ?? '',
      shipmentNumber: bill?.shipmentNumber ?? '',
      loadNumber: bill?.loadNumber ?? '',
      grossCents: bill?.grossCents ?? 0,
      quickPayFeeCents: bill?.quickPayFeeCents ?? 0,
      creditCents,
      paidCents: application.amountCents,
    }
    rows.push(row)
    totals.grossCents += row.grossCents
    totals.quickPayFeeCents += row.quickPayFeeCents
    totals.creditCents += row.creditCents
    totals.paidCents += row.paidCents
  }

  const first = rows.length > 0 ? billById.get(rows[0].billId) : undefined
  const remitTo = payment.remitTo ?? first?.remitTo ?? null
  const carrierId = payment.carrierId
  const carrierName = input.carrier?.name || first?.carrierName || ''
  const mcNumber = input.carrier?.mcNumber ?? first?.carrierMc ?? null

  return {
    payer: payerOf(input.division),
    payee: { carrierId, name: carrierName, mcNumber },
    remitTo,
    date: payment.paidAt.slice(0, 10),
    method: payment.method ?? null,
    reference: payment.reference?.trim() || payment.id,
    rows,
    totals,
  }
}

// ── The page ─────────────────────────────────────────────────────────────────

/** The in-flight document. `y` is distance from the TOP of the page, as in `invoicePdf`. */
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

/** Who sent the money, under which reference. Repeated at the top of every page. */
function drawHeader(d: Doc, data: RemittanceData): void {
  d.page.drawRectangle({ x: 0, y: PAGE.h - HEADER_H, width: PAGE.w, height: HEADER_H, color: BLACK })
  textAt(d, fit(d.bold, data.payer.name, 16, CONTENT_W - 220), M, 34, 16, d.bold, WHITE)
  if (data.payer.ids) textAt(d, data.payer.ids, M, 50, 9, d.font, BAND_TEXT)
  rightAt(d, 'REMITTANCE ADVICE', PAGE.w - M, 32, 13, d.bold, WHITE)
  rightAt(d, `Reference ${data.reference}`, PAGE.w - M, 48, 10, d.font, BAND_TEXT)
}

function newPage(d: Doc, data: RemittanceData): void {
  d.page = d.pdf.addPage([PAGE.w, PAGE.h])
  drawHeader(d, data)
  d.y = BODY_TOP
}

/** Reserve `h` points, continuing onto a fresh page if they are gone. */
function room(d: Doc, data: RemittanceData, h: number): void {
  if (d.y + h <= PAGE.h - FOOT_ROOM) return
  newPage(d, data)
}

/**
 * Who paid on the left, who was paid on the right.
 *
 * On a factored bill the remit-to name is the factor's, so the carrier is named under it:
 * the factor needs to know whose account to credit, and the carrier needs to see that the
 * money went where their assignment said it would.
 */
function drawParties(d: Doc, data: RemittanceData): void {
  const right = PAGE.w / 2 + 10
  const colW = PAGE.w / 2 - M - 10
  textAt(d, 'FROM', M, d.y, 9, d.bold, MUTED)
  textAt(d, 'PAID TO', right, d.y, 9, d.bold, MUTED)
  d.y += 14

  const payee = data.remitTo?.name || data.payee.name || 'Carrier'
  const forCarrier = data.payee.name && data.payee.name !== payee ? `For ${data.payee.name}` : ''
  const paidTo = [
    payee,
    forCarrier,
    data.payee.mcNumber ? `MC ${data.payee.mcNumber}` : '',
    ...addressLines(data.remitTo?.address),
    data.remitTo?.payeeEmail ?? '',
  ].filter((line): line is string => Boolean(line))

  const rows = Math.max(data.payer.lines.length, paidTo.length, 1)
  for (let i = 0; i < rows; i += 1) {
    const font = i === 0 ? d.bold : d.font
    const color = i === 0 ? INK : BODY
    const from = data.payer.lines[i]
    if (from) textAt(d, fit(font, from, 10, colW), M, d.y + i * 13, 10, font, color)
    if (paidTo[i]) textAt(d, fit(font, paidTo[i], 10, colW), right, d.y + i * 13, 10, font, color)
  }
  d.y += rows * 13 + 12
}

/** Date, method, reference and the amount — what an AP clerk at the carrier reads first. */
function drawMeta(d: Doc, data: RemittanceData): void {
  const cells: Array<[string, string]> = [
    ['PAYMENT DATE', formatDate(data.date)],
    ['METHOD', data.method ? METHOD_LABEL[data.method] : '-'],
    ['REFERENCE', data.reference],
    ['TOTAL PAID', cents(data.totals.paidCents)],
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

/** Repeated whenever the bill table continues on a new page. */
function drawTableHead(d: Doc): void {
  band(d, d.y, 18, BAND)
  const baseline = d.y + 12.5
  textAt(d, 'BILL', COL.bill.x, baseline, ROW_SIZE, d.bold, WHITE)
  textAt(d, 'SHIPMENT', COL.shipment.x, baseline, ROW_SIZE, d.bold, WHITE)
  textAt(d, 'LOAD', COL.load.x, baseline, ROW_SIZE, d.bold, WHITE)
  rightAt(d, 'GROSS', COL.gross.right, baseline, ROW_SIZE, d.bold, WHITE)
  rightAt(d, 'QUICK PAY', COL.fee.right, baseline, ROW_SIZE, d.bold, WHITE)
  rightAt(d, 'CREDIT', COL.credit.right, baseline, ROW_SIZE, d.bold, WHITE)
  rightAt(d, 'PAID', COL.paid.right, baseline, ROW_SIZE, d.bold, WHITE)
  d.y += 24
}

function drawRows(d: Doc, data: RemittanceData): void {
  room(d, data, 70)
  drawTableHead(d)

  data.rows.forEach((row, i) => {
    const height = 17
    if (d.y + height > PAGE.h - FOOT_ROOM) {
      newPage(d, data)
      drawTableHead(d)
    }
    const top = d.y
    if (i % 2 === 1) band(d, top - 4, height, ZEBRA)
    const baseline = top + 8
    textAt(d, fit(d.bold, row.billNumber || '-', ROW_SIZE, COL.bill.w), COL.bill.x, baseline, ROW_SIZE, d.bold, INK)
    textAt(d, fit(d.font, row.shipmentNumber, ROW_SIZE, COL.shipment.w), COL.shipment.x, baseline, ROW_SIZE, d.font, BODY)
    textAt(d, fit(d.font, row.loadNumber, ROW_SIZE, COL.load.w), COL.load.x, baseline, ROW_SIZE, d.font, BODY)
    rightAt(d, cents(row.grossCents), COL.gross.right, baseline, ROW_SIZE, d.font, BODY)
    rightAt(d, row.quickPayFeeCents ? `-${cents(row.quickPayFeeCents)}` : '-', COL.fee.right, baseline, ROW_SIZE, d.font, BODY)
    rightAt(d, row.creditCents ? `-${cents(row.creditCents)}` : '-', COL.credit.right, baseline, ROW_SIZE, d.font, BODY)
    rightAt(d, cents(row.paidCents), COL.paid.right, baseline, ROW_SIZE, d.font, INK)
    d.y = top + height
  })

  d.y += 2
  rule(d, d.y, PAGE.w - M - 260)
}

function drawTotals(d: Doc, data: RemittanceData): void {
  room(d, data, 86)
  d.y += 18
  const labelRight = PAGE.w - M - 120
  const lines: Array<[string, string]> = [['Bills gross', cents(data.totals.grossCents)]]
  if (data.totals.quickPayFeeCents) lines.push(['Quick pay fee', `-${cents(data.totals.quickPayFeeCents)}`])
  if (data.totals.creditCents) lines.push(['Credits applied', `-${cents(data.totals.creditCents)}`])
  for (const [label, value] of lines) {
    rightAt(d, label, labelRight, d.y, 10, d.font, BODY)
    rightAt(d, value, COL.paid.right, d.y, 10, d.font, BODY)
    d.y += 14
  }
  d.y -= 4
  rule(d, d.y, PAGE.w - M - 260)
  d.y += 18
  rightAt(d, 'TOTAL PAID', labelRight, d.y, 11, d.bold, INK)
  rightAt(d, cents(data.totals.paidCents), COL.paid.right, d.y, 13, d.bold, INK)
  d.y += 22
}

/** Who to talk to when the money does not match the bills. */
function drawFooterNote(d: Doc, data: RemittanceData): void {
  const contact = data.payer.lines.find((line) => line.includes('@'))
  const note = contact
    ? `Questions about this payment: ${contact}. Please quote reference ${data.reference}.`
    : `Please quote reference ${data.reference} when asking about this payment.`
  const wrapped = wrapText(d.font, note, 8, CONTENT_W)
  room(d, data, wrapped.length * 10 + 24)
  sectionLabel(d, 'REMITTANCE')
  wrapped.forEach((line, i) => {
    textAt(d, line, M, d.y + i * 10, 8, d.font, MUTED)
  })
  d.y += wrapped.length * 10 + 6
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
 * Render the remittance. One page while the bills fit; the table continues onto as many
 * pages as it needs, each carrying the header band and the column heads, and every page
 * is numbered once the count is known.
 */
export async function buildRemittancePdf(data: RemittanceData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  pdf.setTitle(ascii(`Remittance ${data.reference}`))
  pdf.setAuthor(ascii(data.payer.name))
  pdf.setSubject(ascii(`Remittance ${data.reference} - ${data.remitTo?.name || data.payee.name}`))

  const d: Doc = { pdf, font, bold, page: pdf.addPage([PAGE.w, PAGE.h]), y: BODY_TOP }
  drawHeader(d, data)
  drawParties(d, data)
  drawMeta(d, data)
  drawRows(d, data)
  drawTotals(d, data)
  drawFooterNote(d, data)
  drawPageNumbers(d)

  return pdf.save()
}

/** `ACH-88120-v2.pdf` — the stored key and the e-mail attachment name. */
export function remittanceFilename(reference: string, version: number): string {
  const safe = ascii(reference)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|-+$/g, '')
  const v = Math.max(1, Math.trunc(Number.isFinite(version) ? version : 1))
  return `${safe || 'remittance'}-v${v}.pdf`
}
