/**
 * Invoice PDF — the bill the customer receives, in the layout of Ryne's two reference invoices
 * (the BCAT Logistics and Ivan Cartage Co. Aljex invoices): "Original Invoice" and PRO # top right
 * over a boxed grid of hatched header bars, the letterhead and logo top left, PICK UP / CONSIGNEE,
 * REFERENCES / EXTRA PICKS & STOPS, the DESCRIPTION | WEIGHT | RATE | TOTAL table in bold Courier,
 * the TOTAL ----> box, and the customer's mailing address low on the page where a window envelope
 * shows it. The letterhead and logo are fixed per revenue division (`invoiceBrandingFor`); every
 * other field is pulled from the shipment by `invoiceData`.
 *
 * The same bytes serve both callers: the browser renders a preview from this function and
 * `tmsFinanceActions` stores what it returns under `invoices/*`. So nothing here may touch
 * `node:*`, `document` or `canvas` — pdf-lib and `Intl` only. Logos are base64 PNG modules and the
 * hatch is a PDF tiling pattern written through pdf-lib's low-level context: no external assets.
 *
 * Every string is folded to ASCII before it is drawn. Two reasons: the standard PDF fonts
 * encode WinAnsi and throw on anything outside it, and a factored invoice is posted to OTR,
 * whose upload path mangles high bytes (see `amplify/functions/_shared/asciiSafePdf.ts`). The fonts
 * are the unembedded standard Courier-Bold and Helvetica-Bold, as before.
 *
 * What is NOT on this document: carrier pay, cost, margin, or any internal reference. The
 * renderer prints `InvoiceInput` and nothing else, and that type carries none of them.
 */
// Relative, not `@/` — tmsFinanceActions bundles this file by path to render the invoice it
// stores, and the alias does not exist in the function build.
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  PDFRef,
  StandardFonts,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib'
import type { InvoiceInput, InvoiceStop } from './invoiceBuild'
import { invoiceBrandingFor, type InvoiceBranding } from './invoiceBranding'
import { LOGO_PT_PER_PX } from './invoiceLogos'
import type { Address, InvoiceLine, OrderReference } from '../types/tms'

const PAGE = { w: 612, h: 792 } // US Letter, points
const BLACK = rgb(0, 0, 0)

/**
 * The frame, measured off the reference PDFs. Every `y` is distance from the TOP of the page
 * (the unit the rate con uses), every `x` from the left.
 */
const GRID = {
  left: 18.96,
  right: 593.04,
  mid: 306,
  /** Right-hand meta grid. */
  dateSplit: 449.52,
  typeSplits: [401.76, 497.52],
  /** Table column rules: DESCRIPTION | WEIGHT | RATE | TOTAL. */
  cols: [342.96, 407.76, 494.16],
  bar: 12,
  shipTop: 33,
  invTop: 69,
  typeTop: 105,
  custTop: 141,
  custBottom: 201,
  pickTop: 201,
  pickBottom: 273,
  refTop: 273,
  refBottom: 369,
  tableTop: 369,
  tableBottom: 645,
  totalBottom: 669,
}

const MONO_SIZE = 12
const LINE = 12
const LEFT_TEXT = 32.4
const RIGHT_TEXT = 320.4
/** First table row baseline, and the last baseline that still sits inside the table. */
const ROW_START = 396
const ROW_LAST = GRID.tableBottom - 12
const LINEHAUL_PITCH = 72
const ACCESSORIAL_PITCH = 24
const DESC_MAX_W = GRID.cols[0] - LEFT_TEXT - 8
const RATE_RIGHT = 486
const TOTAL_RIGHT = 579.6

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

/**
 * ASCII, upper-cased, runs of blanks collapsed: the reference invoices print every pulled name and
 * address in capitals, and Aljex names arrive with a double space where its export dropped a comma.
 */
const caps = (text: string | null | undefined): string => ascii(text ?? '').replace(/ {2,}/g, ' ').trim().toUpperCase()

/** `MM/DD/YY` from `YYYY-MM-DD`, without going through `Date`. */
function shortDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : ''
}

const chicagoDay = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: '2-digit',
  month: '2-digit',
  day: '2-digit',
})

/**
 * The calendar day a stop is on. FCFS/TBD appointments are a date at 00:00 UTC, so their UTC date
 * is the answer; an exact appointment is an instant, read in the company's zone (Chicago) so the
 * Lambda (UTC) and a browser anywhere print the same day.
 */
function stopDate(stop: InvoiceStop | undefined): string {
  if (!stop?.apptAt) return ''
  if (stop.apptType === 'fcfs' || stop.apptType === 'tbd') return shortDate(stop.apptAt)
  const at = new Date(stop.apptAt)
  return Number.isNaN(at.getTime()) ? '' : chicagoDay.format(at)
}

/** Whole dollars and cents from integer cents; no grouping, as on the reference invoices. */
function money(centsValue: number): string {
  const negative = centsValue < 0
  const abs = Math.abs(Math.trunc(centsValue))
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function cityLine(city: string | null | undefined, state: string | null | undefined, zip: string | null | undefined, comma: boolean): string {
  const region = [caps(state), caps(zip)].filter(Boolean).join(' ')
  return [caps(city), region].filter(Boolean).join(comma ? ', ' : ' ')
}

/** Name, street, city line of a billing address; the box holds three. */
function partyLines(name: string, address: Address | null | undefined, comma: boolean): string[] {
  const street = [address?.street, address?.street2].map(caps).filter(Boolean).join(' ')
  return [caps(name), street, cityLine(address?.city, address?.state, address?.zip, comma)].filter(Boolean)
}

function stopLines(stop: InvoiceStop | undefined): string[] {
  if (!stop) return []
  const lines = [caps(stop.name), caps(stop.street), cityLine(stop.city, stop.state, stop.zip, false)].filter(Boolean)
  const refs = (stop.refs ?? []).map((ref) => ascii(ref).trim()).filter(Boolean)
  lines.push(`Ref # ${refs.join('/')}`.trimEnd())
  return lines
}

/** Reference codes that mean "just a reference number" print as the plain `Ref #`. */
const GENERIC_REF: Record<string, true> = { REF: true, REFERENCE: true, CUSTOMER_REF: true }
const OWNED_ELSEWHERE: Record<string, true> = { PICKUP_REF: true, CONSIGNEE_REF: true, CONTAINER: true }

function referenceLines(references: readonly OrderReference[]): string[] {
  const out: string[] = []
  for (const ref of references) {
    if (ref.level === 'STOP' || OWNED_ELSEWHERE[ref.code]) continue
    const value = ascii(ref.value).trim()
    if (!value) continue
    const name = GENERIC_REF[ref.code] || ref.code.startsWith('ADDITIONAL_REF_')
      ? 'Ref'
      : ascii(ref.label || ref.code).replace(/_/g, ' ').trim()
    out.push(`${name} # ${value}`)
  }
  return out
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

/** At most `max` lines: the rest is folded into the last one with a visible cut. */
function clampLines(font: PDFFont, lines: string[], size: number, maxW: number, max: number): string[] {
  if (lines.length <= max) return lines.map((line) => fit(font, line, size, maxW))
  const kept = lines.slice(0, max).map((line) => fit(font, line, size, maxW))
  kept[max - 1] = fit(font, `${lines[max - 1]} ...`, size, maxW)
  return kept
}

interface Fonts {
  mono: PDFFont
  sans: PDFFont
}

interface Doc {
  pdf: PDFDocument
  fonts: Fonts
  logo: PDFImage
  hatch: PDFRef
  branding: InvoiceBranding
  page: PDFPage
}

/** A top-measured baseline is `PAGE.h - y` from the bottom. */
const flip = (y: number): number => PAGE.h - y

function text(d: Doc, value: string, x: number, baseline: number, size: number, font: PDFFont): void {
  if (!value) return
  d.page.drawText(ascii(value), { x, y: flip(baseline), size, font, color: BLACK })
}

function textRight(d: Doc, value: string, right: number, baseline: number, size: number, font: PDFFont): void {
  const s = ascii(value)
  text(d, s, right - font.widthOfTextAtSize(s, size), baseline, size, font)
}

function textCentered(d: Doc, value: string, x0: number, x1: number, baseline: number, size: number, font: PDFFont): void {
  const s = ascii(value)
  text(d, s, (x0 + x1) / 2 - font.widthOfTextAtSize(s, size) / 2, baseline, size, font)
}

function vLine(d: Doc, x: number, y0: number, y1: number, thickness = 0.425): void {
  d.page.drawLine({ start: { x, y: flip(y0) }, end: { x, y: flip(y1) }, thickness, color: BLACK })
}

function box(d: Doc, x0: number, x1: number, top: number, bottom: number, thickness = 0.425): void {
  d.page.drawRectangle({ x: x0, y: flip(bottom), width: x1 - x0, height: bottom - top, borderColor: BLACK, borderWidth: thickness })
}

/**
 * The gray hatch of the reference header bars: a 1.92 pt tiling pattern of two staggered 0.5 pt
 * dots (about a fifth ink), registered once per document and referenced from each page.
 */
function registerHatch(pdf: PDFDocument): PDFRef {
  const stream = pdf.context.stream('0 g 0 0 0.5 0.5 re f 0.96 0.96 0.5 0.5 re f', {
    Type: 'Pattern',
    PatternType: 1,
    PaintType: 1,
    TilingType: 1,
    BBox: [0, 0, 1.92, 1.92],
    XStep: 1.92,
    YStep: 1.92,
    Resources: {},
  })
  return pdf.context.register(stream)
}

function installHatch(d: Doc): void {
  const resources = d.page.node.Resources()
  if (!resources) return
  let patterns = resources.lookupMaybe(PDFName.of('Pattern'), PDFDict)
  if (!patterns) {
    patterns = d.pdf.context.obj({})
    resources.set(PDFName.of('Pattern'), patterns)
  }
  patterns.set(PDFName.of('Hatch'), d.hatch)
}

/** A hatched bar `GRID.bar` tall, outlined, with its heading centered in each of its cells. */
function bar(d: Doc, x0: number, x1: number, top: number, headings: { label: string; from: number; to: number }[], height = GRID.bar): void {
  d.page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.NonStrokingColorspace, [PDFName.of('Pattern')]),
    PDFOperator.of(PDFOperatorNames.NonStrokingColorN, [PDFName.of('Hatch')]),
    PDFOperator.of(PDFOperatorNames.AppendRectangle, [
      PDFNumber.of(x0),
      PDFNumber.of(flip(top + height)),
      PDFNumber.of(x1 - x0),
      PDFNumber.of(height),
    ]),
    PDFOperator.of(PDFOperatorNames.FillNonZero),
    popGraphicsState(),
  )
  box(d, x0, x1, top, top + height)
  for (const h of headings) textCentered(d, h.label, h.from, h.to, top + 8.88, 8, d.fonts.sans)
}

/** Original Invoice / PRO # and the number, top right. */
function drawTitle(d: Doc, input: InvoiceInput, pro: string): void {
  text(d, 'Original Invoice', GRID.mid, 25.8, 18, d.fonts.sans)
  text(d, 'PRO #', 481.44, 24.6, 14, d.fonts.sans)
  // Five digits at 17.13 pt end at 597.3; a longer number shrinks to the same right edge.
  const proText = caps(pro)
  const size = Math.min(17.1333, 73 / Math.max(1, proText.length * 0.6))
  textRight(d, proText, 597.3, 24, size, d.fonts.mono)
  // The AR number is not on the Aljex layout; it rides small above the logo so the bill can still be quoted.
  const ident = `INVOICE ${caps(input.number)}`
  text(d, ident, 24.96, 14, 7, d.fonts.sans)
}

function drawMeta(d: Doc, input: InvoiceInput): void {
  const first = input.stops.find((stop) => stop.kind === 'PICKUP')
  const last = [...input.stops].reverse().find((stop) => stop.kind === 'DELIVERY')
  const { mid, right, dateSplit, typeSplits } = GRID

  bar(d, mid, right, GRID.shipTop, [
    { label: 'SHIP DATE', from: mid, to: dateSplit },
    { label: 'DELIVERY DATE', from: dateSplit, to: right },
  ])
  box(d, mid, right, GRID.shipTop, GRID.invTop)
  vLine(d, dateSplit, GRID.shipTop, GRID.invTop)
  textCentered(d, stopDate(first), mid, dateSplit, 60, MONO_SIZE, d.fonts.mono)
  textCentered(d, stopDate(last), dateSplit, right, 60, MONO_SIZE, d.fonts.mono)

  bar(d, mid, right, GRID.invTop, [
    { label: 'INVOICE DATE', from: mid, to: dateSplit },
    { label: 'DUE DATE', from: dateSplit, to: right },
  ])
  box(d, mid, right, GRID.invTop, GRID.typeTop)
  vLine(d, dateSplit, GRID.invTop, GRID.typeTop)
  textCentered(d, shortDate(input.invoiceDate), mid, dateSplit, 96, MONO_SIZE, d.fonts.mono)
  textCentered(d, shortDate(input.dueAt), dateSplit, right, 96, MONO_SIZE, d.fonts.mono)

  bar(d, mid, right, GRID.typeTop, [
    { label: 'SHIPMENT TYPE', from: mid, to: typeSplits[0] },
    { label: 'CONT / TRAILER #', from: typeSplits[0], to: typeSplits[1] },
    { label: 'MILES / CLASS', from: typeSplits[1], to: right },
  ])
  box(d, mid, right, GRID.typeTop, GRID.custTop)
  for (const x of typeSplits) vLine(d, x, GRID.typeTop, GRID.custTop)
  text(d, caps(input.shipmentType), RIGHT_TEXT, 132, MONO_SIZE, d.fonts.mono)
  text(d, fit(d.fonts.mono, caps(input.contTrailer), MONO_SIZE, typeSplits[1] - typeSplits[0] - 18), typeSplits[0] + 14.4, 132, MONO_SIZE, d.fonts.mono)
  const miles = typeof input.miles === 'number' && input.miles > 0 ? String(Math.round(input.miles)) : ''
  text(d, miles, typeSplits[1] + 10.08, 132, MONO_SIZE, d.fonts.mono)

  bar(d, mid, right, GRID.custTop, [{ label: 'CUSTOMER', from: mid, to: right }])
  box(d, mid, right, GRID.custTop, GRID.custBottom)
  partyLines(input.billTo.name, input.billTo.address, false).slice(0, 3).forEach((line, i) => {
    text(d, fit(d.fonts.mono, line, MONO_SIZE, right - RIGHT_TEXT - 6), RIGHT_TEXT, 168 + i * LINE, MONO_SIZE, d.fonts.mono)
  })
}

/** Logo and the fixed company block, top left. */
function drawLetterhead(d: Doc): void {
  const { logo, branding } = d
  const w = branding.logo.width * LOGO_PT_PER_PX
  const h = branding.logo.height * LOGO_PT_PER_PX
  d.page.drawImage(logo, { x: 24.96, y: flip(GRID.shipTop + h), width: w, height: h })
  text(d, branding.name, LEFT_TEXT, 132, MONO_SIZE, d.fonts.mono)
  branding.addressLines.forEach((line, i) => text(d, line, LEFT_TEXT, 144 + i * LINE, MONO_SIZE, d.fonts.mono))
  text(d, branding.phone, LEFT_TEXT, 180, MONO_SIZE, d.fonts.mono)
}

function drawParties(d: Doc, input: InvoiceInput): void {
  const { left, right, mid } = GRID
  const first = input.stops.find((stop) => stop.kind === 'PICKUP')
  const last = [...input.stops].reverse().find((stop) => stop.kind === 'DELIVERY')
  const colW = mid - left - 20

  bar(d, left, right, GRID.pickTop, [
    { label: 'PICK UP', from: left, to: mid },
    { label: 'CONSIGNEE', from: mid, to: right },
  ])
  box(d, left, right, GRID.pickTop, GRID.pickBottom)
  vLine(d, mid, GRID.pickTop, GRID.pickBottom)
  stopLines(first).slice(0, 4).forEach((line, i) => text(d, fit(d.fonts.mono, line, MONO_SIZE, colW), LEFT_TEXT, 228 + i * LINE, MONO_SIZE, d.fonts.mono))
  stopLines(last).slice(0, 4).forEach((line, i) => text(d, fit(d.fonts.mono, line, MONO_SIZE, colW), RIGHT_TEXT, 228 + i * LINE, MONO_SIZE, d.fonts.mono))

  bar(d, left, right, GRID.refTop, [
    { label: 'REFERENCES', from: left, to: mid },
    { label: 'EXTRA PICKS & STOPS', from: mid, to: right },
  ])
  box(d, left, right, GRID.refTop, GRID.refBottom)
  vLine(d, mid, GRID.refTop, GRID.refBottom)
  const rows = 6
  clampLines(d.fonts.mono, referenceLines(input.references), MONO_SIZE, colW, rows)
    .forEach((line, i) => text(d, line, LEFT_TEXT, 300 + i * LINE, MONO_SIZE, d.fonts.mono))
  const extra = input.stops.slice(1, -1).map((stop) =>
    `${stop.kind === 'PICKUP' ? 'PICK' : 'DROP'} ${[caps(stop.name), cityLine(stop.city, stop.state, null, false)].filter(Boolean).join(' ')}`,
  )
  clampLines(d.fonts.mono, extra, MONO_SIZE, colW, rows)
    .forEach((line, i) => text(d, line, RIGHT_TEXT, 300 + i * LINE, MONO_SIZE, d.fonts.mono))
}

/** One row of the charge table, resolved before any page is touched so pagination can measure it. */
interface Row {
  description: string[]
  weight: string
  rate: string
  total: string
  pitch: number
}

function describeLine(line: InvoiceLine): string {
  const label = (line.label ?? '').trim() || line.code.replace(/_/g, ' ')
  return label
}

function buildRows(d: Doc, input: InvoiceInput): Row[] {
  const haulAt = Math.max(0, input.lines.findIndex((line) => line.code === 'LINEHAUL'))
  const weight = typeof input.weightLbs === 'number' && input.weightLbs > 0 ? String(Math.round(input.weightLbs)) : ''
  return input.lines.map((line, index) => {
    const isHaul = index === haulAt
    const text = isHaul ? (input.freightDescription?.trim() || describeLine(line)) : describeLine(line)
    const description = wrapText(d.fonts.mono, caps(text), MONO_SIZE, DESC_MAX_W)
    const rate = line.calculatedBy === 'PERCENT' ? line.amountCents : line.rateCents
    return {
      description: description.length > 0 ? description : [''],
      weight: isHaul ? weight : '',
      rate: money(rate),
      total: money(line.amountCents),
      pitch: Math.max(isHaul ? LINEHAUL_PITCH : ACCESSORIAL_PITCH, description.length * LINE + LINE),
    }
  })
}

/** Split rows over pages: a row stays whole, and a page ends where the next row's last baseline would cross the table. */
function paginate(rows: Row[]): Row[][] {
  const pages: Row[][] = [[]]
  let y = ROW_START
  for (const row of rows) {
    const lastBaseline = y + (row.description.length - 1) * LINE
    if (lastBaseline > ROW_LAST && pages[pages.length - 1].length > 0) {
      pages.push([])
      y = ROW_START
    }
    pages[pages.length - 1].push(row)
    y += row.pitch
  }
  return pages
}

function drawTable(d: Doc, rows: Row[]): void {
  const { left, right, cols } = GRID
  bar(d, left, right, GRID.tableTop, [
    { label: 'DESCRIPTION', from: left, to: cols[0] },
    { label: 'WEIGHT', from: cols[0], to: cols[1] },
    { label: 'RATE', from: cols[1], to: cols[2] },
    { label: 'TOTAL', from: cols[2], to: right },
  ])
  box(d, left, right, GRID.tableTop, GRID.tableBottom)
  for (const x of cols) vLine(d, x, GRID.tableTop, GRID.tableBottom)

  let y = ROW_START
  for (const row of rows) {
    row.description.forEach((line, i) => text(d, line, LEFT_TEXT, y + i * LINE, MONO_SIZE, d.fonts.mono))
    if (row.weight) {
      const x = Math.min(363.6, cols[1] - 6 - d.fonts.mono.widthOfTextAtSize(row.weight, MONO_SIZE))
      text(d, row.weight, x, y, MONO_SIZE, d.fonts.mono)
    }
    textRight(d, row.rate, RATE_RIGHT, y, MONO_SIZE, d.fonts.mono)
    textRight(d, row.total, TOTAL_RIGHT, y, MONO_SIZE, d.fonts.mono)
    y += row.pitch
  }
}

/** ACCOUNT NUMBER and the TOTAL ----> box; only the last page carries the total. */
function drawTotal(d: Doc, input: InvoiceInput, last: boolean): void {
  const { cols, right } = GRID
  const account = caps(input.accountNumber)
  if (account) text(d, `ACCOUNT NUMBER ${account}`, 24, 660, 10, d.fonts.mono)

  bar(d, cols[0], cols[2], GRID.tableBottom, [], GRID.totalBottom - GRID.tableBottom)
  box(d, cols[0], right, GRID.tableBottom, GRID.totalBottom)
  if (!last) {
    textCentered(d, 'CONTINUED ON NEXT PAGE', cols[0], right, 661.56, 9, d.fonts.sans)
    return
  }
  text(d, 'TOTAL', 366, 661.56, 11, d.fonts.sans)
  text(d, '-----', 453.6, 660, 10, d.fonts.mono)
  const arrow = [
    { x: 474.96, y: 651 },
    { x: 486.96, y: 657 },
    { x: 474.96, y: 663 },
  ]
  d.page.drawSvgPath(`M ${arrow[0].x} ${arrow[0].y} L ${arrow[1].x} ${arrow[1].y} L ${arrow[2].x} ${arrow[2].y} Z`, {
    x: 0,
    y: PAGE.h,
    color: BLACK,
    borderColor: BLACK,
    borderWidth: 0.425,
  })
  text(d, '$', 501.6, 661.56, 11, d.fonts.sans)
  textRight(d, money(input.totalCents), 580.8, 660, MONO_SIZE, d.fonts.mono)
}

/** The factor's assignment notice must be on the face of the invoice, not a cover note. */
function drawFactorNotice(d: Doc, input: InvoiceInput): void {
  const notice = input.factorNoticeText
  if (!notice) return
  text(d, 'NOTICE OF ASSIGNMENT', 24, 684, 8, d.fonts.sans)
  clampLines(d.fonts.sans, wrapText(d.fonts.sans, notice, 8, 564), 8, 564, 3)
    .forEach((line, i) => text(d, line, 24, 695 + i * 10, 8, d.fonts.sans))
}

/** The customer's mailing address, where the window of a #10 envelope shows it. */
function drawWindowAddress(d: Doc, input: InvoiceInput): void {
  partyLines(input.billTo.name, input.billTo.address, true).forEach((line, i) => {
    text(d, fit(d.fonts.mono, line, MONO_SIZE, 330), i === 0 ? 74.4 : 75.6, 738 + i * LINE, MONO_SIZE, d.fonts.mono)
  })
}

function drawFrame(d: Doc, input: InvoiceInput, pro: string): void {
  drawTitle(d, input, pro)
  drawLetterhead(d)
  drawMeta(d, input)
  drawParties(d, input)
}

/** Draws the heavy outline that joins the meta grid to the table, as the reference has it. */
function drawOutline(d: Doc): void {
  const { left, right, mid, cols } = GRID
  const pts: [number, number][] = [
    [mid, GRID.shipTop],
    [right, GRID.shipTop],
    [right, GRID.totalBottom],
    [cols[0], GRID.totalBottom],
    [cols[0], GRID.tableBottom],
    [left, GRID.tableBottom],
    [left, GRID.custBottom],
    [mid, GRID.custBottom],
    [mid, GRID.shipTop],
  ]
  for (let i = 0; i + 1 < pts.length; i += 1) {
    d.page.drawLine({
      start: { x: pts[i][0], y: flip(pts[i][1]) },
      end: { x: pts[i + 1][0], y: flip(pts[i + 1][1]) },
      thickness: 0.85,
      color: BLACK,
    })
  }
}

/**
 * Render the invoice. One page while the charge rows fit the table; past that the table
 * continues on a fresh page that repeats the frame, and only the last page carries the TOTAL.
 */
export async function buildInvoicePdf(input: InvoiceInput): Promise<Uint8Array> {
  const branding = invoiceBrandingFor(input.divisionKey, input.subdivisionKey)
  const pdf = await PDFDocument.create()
  const fonts: Fonts = {
    mono: await pdf.embedFont(StandardFonts.CourierBold),
    sans: await pdf.embedFont(StandardFonts.HelveticaBold),
  }
  const logo = await pdf.embedPng(branding.logo.base64)
  const hatch = registerHatch(pdf)
  const pro = input.shipmentNumber || input.number
  pdf.setTitle(ascii(`Invoice ${input.number}`))
  pdf.setAuthor(branding.name)
  pdf.setSubject(ascii(`Invoice ${input.number} - ${input.billTo.name}`))

  const d: Doc = { pdf, fonts, logo, hatch, branding, page: pdf.addPage([PAGE.w, PAGE.h]) }
  const pages = paginate(buildRows(d, input))
  pages.forEach((rows, index) => {
    if (index > 0) d.page = pdf.addPage([PAGE.w, PAGE.h])
    installHatch(d)
    const last = index === pages.length - 1
    drawFrame(d, input, pro)
    drawTable(d, rows)
    drawTotal(d, input, last)
    drawOutline(d)
    drawFactorNotice(d, input)
    if (index === 0) drawWindowAddress(d, input)
    if (pages.length > 1) text(d, `PAGE ${index + 1} OF ${pages.length}`, 120, 14, 7, fonts.sans)
  })

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
