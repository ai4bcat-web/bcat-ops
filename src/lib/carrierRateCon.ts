/**
 * Carrier rate confirmation - the document a booked carrier signs, laid out to match BCAT's
 * reference rate con (PRO 14832) page for page: the logo and remit-from block, the FROM /
 * CARRIER boxes, equipment strip, CHARGES + DISPATCH NOTES, numbered PICK / STOP blocks, the
 * fixed legal terms (`carrierRateConTerms.ts`) and the signature / date footer on every page.
 *
 * Built in the browser from the shipment bundle, mailed by SEND_RATE_CON, and stamped with the
 * typed signature by the public signing page (`stampSignature`, below, which appends one page and
 * never touches these). Pure pdf-lib and `Intl`: no `node:*`, DOM or canvas, so a Lambda may
 * bundle it. Imports are relative for the same reason.
 *
 * Every string is folded to ASCII before it is drawn: the standard PDF fonts encode WinAnsi and
 * throw on anything outside it.
 *
 * Only CARRIER-side money and CARRIER-visible references belong on this page: the carrier must
 * never read what the customer pays. Callers filter before handing the stops and charges over.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import type { CarrierRecord, LoadCarrierRecord } from '../types/tms'
import { RATE_CON_LOGO_HEIGHT, RATE_CON_LOGO_PNG_BASE64, RATE_CON_LOGO_WIDTH } from './carrierRateConLogo'
import { RATE_CON_TERMS } from './carrierRateConTerms'
import type { RateConRevision } from './rateConRevision'

const PAGE_W = 612
const PAGE_H = 792
/** The y a page's body starts at, just under the header box (flow coordinates run down from the top). */
const BODY_TOP = 189.6
/** Nothing but the footer may sit below this. */
const CONTENT_BOTTOM = 715
const ROW = 12
/** Air between the bottom of the CHARGES / NOTES boxes and the first PICK rule. */
const SECTION_GAP = 11.1
/** Left margin of the appended acceptance page (`stampSignature`). */
const M = 40
const MONO_ROW = 9
const COURIER = 0.6

/** Appointments are stored as Chicago wall clock (see `src/lib/date.ts`). */
const APPT_TZ = 'America/Chicago'
/** The reference prints its issue stamp in Eastern time and labels it EST all year. */
const STAMP_TZ = 'America/New_York'

const ink = rgb(0, 0, 0)
const soft = rgb(0.33, 0.33, 0.33)
const hatch = rgb(0.82, 0.82, 0.82)
const white = rgb(1, 1, 1)
const revised = rgb(0.75, 0.05, 0.05)

/** Punctuation the standard fonts cannot encode, mapped to what a printer reads the same. */
const FOLD: Record<string, string> = {
  '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u00b7': '-', '\u2022': '*',
  '\u2018': "'", '\u2019': "'", '\u201a': ',', '\u201c': '"', '\u201d': '"',
  '\u2026': '...', '\u00a0': ' ', '\u2044': '/', '\u20ac': 'EUR', '\u00a3': 'GBP',
}

/** ASCII only: accents stripped to their base letter, typographic punctuation folded, the rest dropped. */
export function foldAscii(text: string): string {
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
 * Where the carrier signs: the footer line every page carries. pdf-lib coordinates (points, origin
 * bottom-left), so a stamper can draw a typed signature on `page: 'last'` without re-parsing the PDF.
 * `y` is the line itself; text sits just above it. The date is three segments (M / D / Y).
 */
export const RATE_CON_SIGNATURE_ANCHOR = {
  page: 'last',
  signatureLine: { x: 105.6, y: 792 - 759.2, width: 216.1 },
  dateLine: { x: 390, y: 792 - 759.2, width: 143.4 },
  dateSegments: [
    { x: 390, width: 44 },
    { x: 439.7, width: 44 },
    { x: 489.4, width: 44 },
  ],
} as const

export interface RateConStop {
  kind: 'PICKUP' | 'DELIVERY'
  name?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  apptAt?: string | null
  apptEnd?: string | null
  apptType?: string | null
  /** CARRIER-visible references only. */
  references?: { label: string; value: string }[]
  /** Printed as "Appt Notes". */
  instructions?: string | null
  /** Dock hours, printed as "Hours : ...". */
  hours?: string | null
}

/** The BCAT person the carrier calls: the FROM box. */
export interface RateConRep {
  name?: string | null
  phone?: string | null
  email?: string | null
}

export interface RateConInput {
  /** The carrier profile; `fax` prints when the profile has one. */
  carrier: Pick<CarrierRecord, 'name' | 'mcNumber' | 'dotNumber' | 'phone'> & { fax?: string | null }
  /** The assignment: truck, trailer and driver come from it. */
  loadCarrier: Pick<LoadCarrierRecord, 'truckNumber' | 'trailerNumber' | 'driverName' | 'driverPhone'>
  rep?: RateConRep | null
  /** Printed as the PRO #. */
  loadNumber: string
  /** The stamp under the title; now when omitted. */
  issuedAt?: Date
  equipmentType?: string | null
  commodity?: string | null
  weightLbs?: number | null
  miles?: number | null
  pieces?: number | null
  stops: RateConStop[]
  /** CARRIER-side charge lines only. */
  charges: { label: string; amountCents: number }[]
  totalCents: number
  /** Order special instructions + rate-con notes, printed in DISPATCH NOTES. */
  notes?: string
  /** Version 2 and up: "REVISED - REV n" in the header and a CHANGES block above the stops. */
  revision?: RateConRevision | null
}

/** BCAT's main line: the FROM box prints it when the rep has no number of their own. */
export const RATE_CON_COMPANY_PHONE = '(847) 450-0899'

/**
 * The FROM box: the booked rep (assignment first, then the load), else whoever is building the
 * document. Each identifier is a Cognito username or an e-mail; the first one that names a person
 * wins. Name and phone come from the user directory (matched on e-mail or profile id); an
 * identifier that is an e-mail but not in the directory still prints, bare.
 */
export function rateConRepOf(
  profiles: readonly { id?: string | null; email: string; name?: string | null; phone?: string | null }[],
  ...ids: (string | null | undefined)[]
): RateConRep | null {
  for (const raw of ids) {
    const key = raw?.trim()
    if (!key) continue
    const lower = key.toLowerCase()
    const profile = profiles.find((p) => p.email.toLowerCase() === lower || (p.id != null && p.id === key))
    if (profile) return { name: profile.name ?? null, phone: profile.phone ?? null, email: key.includes('@') ? key : profile.email }
    if (key.includes('@')) return { name: null, phone: null, email: key }
  }
  return null
}

/**
 * Aljex stores a charge's four-letter code in the label (`MAC`, `LHS`, `DETN`). The carrier reads
 * the words; an unknown label prints as typed, never cut.
 */
const CHARGE_LABELS: Record<string, string> = {
  MAC: 'MACROPOINT ACCEPTANCE', LHS: 'LINE HAUL SERVICE', CHAS: 'CHASSIS', STOR: 'STORAGE', WRHS: 'WAREHOUSING',
  DETN: 'DETENTION', DTL: 'DETENTION LOADING', DTU: 'DETENTION UNLOADING', PRPL: 'PRE-PULL',
  TORD: 'TRUCK ORDERED NOT USED', MISC: 'MISCELLANEOUS', STOP: 'STOP OFF', LATE: 'LATE DELIVERY',
  SCAL: 'SCALE', LAYO: 'LAYOVER', LUMP: 'LUMPER', PERM: 'PERMIT', DEMU: 'DEMURRAGE', TARP: 'TARP',
  RAMP: 'RAMP', GATE: 'GATE FEE', LABR: 'LABOR', DOCK: 'DOCK FEE',
}

export function rateConChargeLabel(label: string): string {
  const text = foldAscii(label).replace(/\s+/g, ' ').trim().toUpperCase()
  return CHARGE_LABELS[text] ?? text
}

/** The two free-text order fields the rate con prints, blank-safe and in print order. */
export function joinRateConNotes(special?: string | null, rateCon?: string | null): string {
  return [special, rateCon].map((s) => s?.trim()).filter(Boolean).join('\n\n')
}

/** `${loadNumber}` is the broker's number, `${version}` the re-send counter. */
export function rateConFilename(loadNumber: string, version: number): string {
  return `rate-con-${loadNumber}-v${version}.pdf`
}

/** Base64 (no data-URI prefix) of a built doc - for emailing and for the sign API. */
export function rateConPdfBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// -- formatting ---------------------------------------------------------------------------------

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** `(847) 450-0899 (p)`; anything that is not ten digits prints as typed. */
function phoneOf(raw: string | null | undefined, tag: 'p' | 'f' | null): string {
  const text = foldAscii(raw ?? '').trim()
  if (!text) return ''
  const digits = text.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  const pretty = ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : text
  return tag ? `${pretty} (${tag})` : pretty
}

function zonedParts(at: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  return Object.fromEntries(parts.map((p) => [p.type, p.value]))
}

/** `10/26/26 13:34:25` in Eastern time. */
function stampOf(at: Date): string {
  const p = zonedParts(at, STAMP_TZ)
  return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute}:${p.second}`
}

/** `10/29/26 @ 11:00`, `10/29/26` (date-only), `10/29/26 @ 08:00 - 12:00`, `10/29/26 FCFS`, `10/29/26 FCFS 07:00 - 16:00`, `TBD`. */
function apptOf(stop: RateConStop): string {
  if (!stop.apptAt) return stop.apptType === 'tbd' ? 'TBD' : ''
  const start = new Date(stop.apptAt)
  if (Number.isNaN(start.getTime())) return ''
  const s = zonedParts(start, APPT_TZ)
  const date = `${s.month}/${s.day}/${s.year}`
  if (stop.apptType === 'tbd') return `${date} TBD`
  const time = `${s.hour}:${s.minute}`
  const end = (stop.apptType === 'range' || stop.apptType === 'fcfs') && stop.apptEnd ? new Date(stop.apptEnd) : null
  if (stop.apptType === 'fcfs') {
    if (!end || Number.isNaN(end.getTime())) return `${date} FCFS`
    const e = zonedParts(end, APPT_TZ)
    return `${date} FCFS ${time} - ${e.hour}:${e.minute}`
  }
  if (time === '00:00') return date
  if (end && !Number.isNaN(end.getTime())) {
    const e = zonedParts(end, APPT_TZ)
    return `${date} @ ${time} - ${e.hour}:${e.minute}`
  }
  return `${date} @ ${time}`
}

/** Greedy word wrap on a monospaced column count; a word wider than the box is broken. Blank lines are kept. */
function wrapMono(text: string, cols: number): string[] {
  const out: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const paragraph = foldAscii(raw).replace(/\s+/g, ' ')
    const words = paragraph.trim().split(' ').filter(Boolean)
    if (!words.length) { out.push(''); continue }
    let line = ''
    for (let word of words) {
      while (word.length > cols) {
        if (line) { out.push(line); line = '' }
        out.push(word.slice(0, cols))
        word = word.slice(cols)
      }
      const next = line ? `${line} ${word}` : word
      if (next.length <= cols) line = next
      else { out.push(line); line = word }
    }
    if (line) out.push(line)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

// -- drawing ------------------------------------------------------------------------------------

interface Fonts {
  helv: PDFFont
  helvBold: PDFFont
  mono: PDFFont
  monoBold: PDFFont
  monoBoldOblique: PDFFont
}

interface Ctx {
  pdf: PDFDocument
  fonts: Fonts
  logo: PDFImage
  input: RateConInput
  stamp: string
  page: PDFPage
  /** Flow cursor: distance from the top of the page. */
  y: number
}

/** Text with its top edge at `top` (distance from the page top, as a text extractor reports it). */
function put(
  page: PDFPage, text: string, x: number, top: number, font: PDFFont, size: number,
  opts: { color?: ReturnType<typeof rgb>; align?: 'left' | 'right' | 'center' } = {},
): void {
  const s = foldAscii(text)
  if (!s) return
  const width = font.widthOfTextAtSize(s, size)
  const left = opts.align === 'right' ? x - width : opts.align === 'center' ? x - width / 2 : x
  page.drawText(s, { x: left, y: PAGE_H - top - size * (font.name.startsWith('Courier') ? 0.63 : 0.72), size, font, color: opts.color ?? ink })
}

function hline(page: PDFPage, x1: number, x2: number, y: number, thickness = 0.45): void {
  page.drawLine({ start: { x: x1, y: PAGE_H - y }, end: { x: x2, y: PAGE_H - y }, thickness, color: ink })
}

function box(page: PDFPage, x1: number, y1: number, x2: number, y2: number, fill?: ReturnType<typeof rgb>): void {
  page.drawRectangle({
    x: x1, y: PAGE_H - y2, width: x2 - x1, height: y2 - y1,
    borderColor: ink, borderWidth: 0.45, ...(fill ? { color: fill } : {}),
  })
}

/** Shrink a mono string to fit `maxW`, then cut it. */
function fitMono(text: string, maxW: number, size: number): { text: string; size: number } {
  const s = foldAscii(text)
  let sz = size
  while (sz > 7 && s.length * COURIER * sz > maxW) sz -= 0.5
  const cols = Math.floor(maxW / (COURIER * sz))
  return { text: s.length > cols ? s.slice(0, cols) : s, size: sz }
}

/** Value text in the left-hand strip: centred in a narrow box when it fits, else left-aligned at the box start. */
function stripValue(page: PDFPage, text: string, x0: number, boxW: number, top: number, font: PDFFont): void {
  const s = foldAscii(text)
  if (!s) return
  const w = font.widthOfTextAtSize(s, 8)
  put(page, s, w <= boxW ? x0 + (boxW - w) / 2 : x0, top, font, 8)
}

function drawFooter(ctx: Ctx): void {
  const { page, fonts, input } = ctx
  put(page, 'Carrier Signature', 26.6, 751.7, fonts.helv, 10)
  hline(page, 105.6, 321.7, 759.2, 0.5)
  put(page, 'Date', 366, 751.7, fonts.helv, 10)
  hline(page, 390, 434, 759.2, 0.5)
  hline(page, 439.7, 483.7, 759.2, 0.5)
  hline(page, 489.4, 533.4, 759.2, 0.5)
  put(page, '/', 436.8, 751.7, fonts.helv, 10)
  put(page, '/', 486.5, 751.7, fonts.helv, 10)
  put(page, 'M', 409.9, 761.1, fonts.helv, 7)
  put(page, 'D', 457.7, 761.1, fonts.helv, 7)
  put(page, 'Send Carrier Bills to the Address Above', 60, 769.7, fonts.helvBold, 10)
  put(page, 'PRO #', 306, 769.7, fonts.helvBold, 10)
  put(page, input.loadNumber, 351.6, 767.8, fonts.mono, 10)
  put(page, 'must appear on all Invoices', 414, 769.7, fonts.helvBold, 10)
}

/** Everything that repeats on every page above the body: title, logo, remit-from, FROM and CARRIER boxes. */
function drawHeader(ctx: Ctx): void {
  const { page, fonts, input } = ctx
  const { helvBold, mono, monoBold } = fonts

  put(page, 'PRO #', 306, 15, helvBold, 12)
  put(page, input.loadNumber, 366, 13, monoBold, 17)
  put(page, 'Rate Confirmation', 450, 12, helvBold, 15 * (139 / helvBold.widthOfTextAtSize('Rate Confirmation', 15)))
  put(page, ctx.stamp, 450, 29, mono, 10)
  put(page, '(EST)', 564, 29, mono, 10)
  if (input.revision) {
    put(page, `REVISED - REV ${input.revision.number}`, 306, 31, helvBold, 10, { color: revised })
  }

  page.drawImage(ctx.logo, { x: 25, y: PAGE_H - 33 - 72, width: 191, height: 72 })
  put(page, 'BCAT LOGISTICS', 30, 137, mono, 10)
  put(page, '1193 E HIGGINS RD', 30, 149, mono, 10)
  put(page, 'ELK GROVE VILLAGE IL 60007', 30, 173, mono, 10)

  box(page, 306, 45, 594, 105)
  box(page, 306, 45, 594, 189)
  hline(page, 18, 306, 189)
  ;[...'FROM'].forEach((ch, i) => put(page, ch, 294, 51 + i * 12, helvBold, 10, { align: 'center' }))
  ;[...'CARRIER'].forEach((ch, i) => put(page, ch, 294, 109 + i * 10.85, helvBold, 10, { align: 'center' }))

  const rep = input.rep
  // Name and phone are the point of the box: without a directory name the box still says who, and
  // without a number it gives the company line.
  const repName = fitMono(foldAscii(rep?.name?.trim() || 'BCAT Logistics').toUpperCase(), 276, 10)
  put(page, repName.text, 312, 53, mono, repName.size)
  put(page, phoneOf(rep?.phone?.trim() || RATE_CON_COMPANY_PHONE, 'p'), 312, 65, mono, 10)
  const repEmail = fitMono(rep?.email ?? '', 276, 10)
  put(page, repEmail.text, 312, 89, mono, repEmail.size)

  const carrier = fitMono(foldAscii(input.carrier.name).toUpperCase(), 276, 10)
  put(page, carrier.text, 312, 113, mono, carrier.size)
  put(page, phoneOf(input.carrier.phone, 'p'), 312, 125, mono, 10)
  put(page, phoneOf(input.carrier.fax, 'f'), 312, 137, mono, 10)
  put(page, 'MC #', 311, 149, helvBold, 9)
  put(page, input.carrier.mcNumber ?? '', 354, 149, mono, 10)
  put(page, 'DOT', 311, 161, helvBold, 9)
  put(page, input.carrier.dotNumber ?? '', 348, 161, mono, 10)
  put(page, 'Driver', 311, 173, helvBold, 9)
  const driver = fitMono(foldAscii(input.loadCarrier.driverName ?? '').toUpperCase(), 96, 10)
  put(page, driver.text, 348, 173, mono, driver.size)
  put(page, 'Truck #', 488, 149, helvBold, 9.6, { align: 'right' })
  put(page, 'Trailer #', 488, 161, helvBold, 9.6, { align: 'right' })
  put(page, 'Cell #', 488, 173, helvBold, 9.6, { align: 'right' })
  put(page, fitMono(input.loadCarrier.truckNumber ?? '', 98, 10).text, 494, 149, mono, 10)
  put(page, fitMono(input.loadCarrier.trailerNumber ?? '', 98, 10).text, 494, 161, mono, 10)
  put(page, phoneOf(input.loadCarrier.driverPhone, null), 494, 173, mono, 10)
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.pdf.addPage([PAGE_W, PAGE_H])
  drawHeader(ctx)
  drawFooter(ctx)
  ctx.y = BODY_TOP
}

/** The equipment strip, CHARGES and DISPATCH NOTES. A notes box too long for the page continues on the next. */
function drawDetails(ctx: Ctx): void {
  const { fonts, input } = ctx
  const label = (text: string, right: number, top: number) => put(ctx.page, text, right, top, fonts.helvBold, 9.3, { align: 'right' })
  label('Size & Type:', 96, 194)
  label('Pieces:', 95, 206)
  label('Description:', 300, 194)
  label('Weight:', 300, 206)
  put(ctx.page, 'Miles:', 430, 194, fonts.helvBold, 10)
  stripValue(ctx.page, (input.equipmentType ?? '').toUpperCase(), 109, 34, 196, fonts.mono)
  stripValue(ctx.page, input.pieces != null ? String(input.pieces) : '', 109, 34, 208, fonts.mono)
  stripValue(ctx.page, (input.commodity ?? '').toUpperCase(), 306, 34, 196, fonts.mono)
  stripValue(ctx.page, input.weightLbs != null ? String(input.weightLbs) : '', 306, 34, 208, fonts.mono)
  stripValue(ctx.page, input.miles != null ? String(input.miles) : '', 474, 18, 196, fonts.mono)

  const size = 8.5
  const chargeLines = input.charges.map((c) => ({
    label: wrapMono(rateConChargeLabel(c.label), 25),
    amount: money(c.amountCents),
  }))
  const chargeRows = chargeLines.reduce((n, c) => n + Math.max(1, c.label.length), 0)
  const notes = wrapMono(input.notes ?? '', 70)

  let top = 218.5
  const lead = (): void => {
    box(ctx.page, 20.4, top, 595.3, top + 8.8, hatch)
  }
  // First chunk: both boxes. `room` is what the page leaves for the rows between the bars.
  const rowsRoom = Math.floor((CONTENT_BOTTOM - top - 8.8 - 10.7 - 17.5) / MONO_ROW)
  const firstNotes = Math.max(chargeRows, Math.min(notes.length, rowsRoom))
  const rowsFirst = Math.max(chargeRows, firstNotes, 1)
  lead()
  put(ctx.page, 'CHARGES', 123.7, 219, fonts.helvBold, 8, { align: 'center' })
  put(ctx.page, 'DISPATCH NOTES', 411, 219, fonts.helvBold, 8, { align: 'center' })
  const bodyTop = top + 8.8
  const bodyBottom = bodyTop + rowsFirst * MONO_ROW + 10.7
  box(ctx.page, 20.4, bodyTop, 227, bodyBottom)
  hline(ctx.page, 161.6, 161.6, bodyTop) // no-op anchor kept out of the way; the divider is a rule below
  ctx.page.drawLine({ start: { x: 161.6, y: PAGE_H - bodyTop }, end: { x: 161.6, y: PAGE_H - bodyBottom }, thickness: 0.45, color: ink })
  box(ctx.page, 227, bodyTop, 595.3, bodyBottom)
  let rowTop = bodyTop + 8.7
  for (const c of chargeLines) {
    c.label.forEach((l, i) => put(ctx.page, l, 28, rowTop + i * MONO_ROW, fonts.mono, size))
    put(ctx.page, c.amount, 224.4, rowTop, fonts.mono, size, { align: 'right' })
    rowTop += Math.max(1, c.label.length) * MONO_ROW
  }
  notes.slice(0, firstNotes).forEach((l, i) => put(ctx.page, l, 235, bodyTop + 8.7 + i * MONO_ROW, fonts.mono, size))

  const totalTop = bodyBottom
  box(ctx.page, 20.4, totalTop, 227, totalTop + 17.5)
  ctx.page.drawLine({ start: { x: 161.6, y: PAGE_H - totalTop }, end: { x: 161.6, y: PAGE_H - totalTop - 17.5 }, thickness: 0.45, color: ink })
  put(ctx.page, 'TOTAL RATE', 28, totalTop + 4.5, fonts.mono, size)
  put(ctx.page, money(input.totalCents), 224.4, totalTop + 4.5, fonts.mono, size, { align: 'right' })
  ctx.y = totalTop + 17.5 + SECTION_GAP

  let rest = notes.slice(firstNotes)
  while (rest.length) {
    newPage(ctx)
    top = ctx.y + 4
    box(ctx.page, 227, top, 595.3, top + 8.8, hatch)
    put(ctx.page, 'DISPATCH NOTES (CONT.)', 411, top + 0.5, fonts.helvBold, 8, { align: 'center' })
    const room = Math.floor((CONTENT_BOTTOM - top - 8.8 - 10.7) / MONO_ROW)
    const chunk = rest.slice(0, room)
    rest = rest.slice(room)
    const bottom = top + 8.8 + chunk.length * MONO_ROW + 10.7
    box(ctx.page, 227, top + 8.8, 595.3, bottom)
    chunk.forEach((l, i) => put(ctx.page, l, 235, top + 8.8 + 8.7 + i * MONO_ROW, fonts.mono, size))
    ctx.y = bottom + SECTION_GAP
  }
}

/** Revisions only: when this version was issued and what changed since the one before it. */
function drawRevision(ctx: Ctx): void {
  const revision = ctx.input.revision
  if (!revision) return
  const { fonts } = ctx
  const size = 8.5
  const issued = `Revision ${revision.number} issued ${stampOf(revision.at)} (EST). This replaces revision ${revision.number - 1}; only this version can be signed.`
  const lines = [
    ...wrapMono(issued, 100),
    ...(revision.changes.length
      ? revision.changes.flatMap((c) => wrapMono(`- ${c}`, 100))
      : ['- Changes from the previous revision were not recorded.']),
  ]
  let rest = lines
  let first = true
  while (rest.length) {
    const needed = 8.8 + 2 * MONO_ROW + 10.7
    if (ctx.y + needed > CONTENT_BOTTOM) newPage(ctx)
    const top = ctx.y
    box(ctx.page, 20.4, top, 595.3, top + 8.8, hatch)
    put(ctx.page, first ? `CHANGES SINCE REV ${revision.number - 1}` : `CHANGES SINCE REV ${revision.number - 1} (CONT.)`, 306, top + 0.5, fonts.helvBold, 8, { align: 'center', color: revised })
    const room = Math.max(1, Math.floor((CONTENT_BOTTOM - top - 8.8 - 10.7) / MONO_ROW))
    const chunk = rest.slice(0, room)
    rest = rest.slice(room)
    const bottom = top + 8.8 + chunk.length * MONO_ROW + 10.7
    box(ctx.page, 20.4, top + 8.8, 595.3, bottom)
    chunk.forEach((l, i) => put(ctx.page, l, 28, top + 8.8 + 8.7 + i * MONO_ROW, fonts.mono, size))
    ctx.y = bottom + SECTION_GAP
    first = false
  }
}

/** `STOP_REF` (a stored reference code) prints as the reference's own "Ref #"; other codes lose their underscores. */
function refLabelOf(label: string): string {
  const text = foldAscii(label).replace(/_/g, ' ').trim()
  return !text || /^(stop )?ref$/i.test(text) ? 'Ref' : text
}

/** One PICK n / STOP n block: facility on the left, appointment / refs / notes on the right. */
function drawStop(ctx: Ctx, stop: RateConStop, ordinal: number): void {
  const { fonts } = ctx
  const left = [
    stop.name ?? '',
    stop.address ?? '',
    [stop.city, [stop.state, stop.zip].filter(Boolean).join(' ')].filter(Boolean).join(' '),
  ].map((l) => foldAscii(l).toUpperCase()).filter(Boolean)
  if (stop.hours?.trim()) left.push(`Hours : ${foldAscii(stop.hours).trim()}`)

  const right: { label: string; value: string; valueX: number }[] = []
  const appt = apptOf(stop)
  if (appt) right.push({ label: 'Appointment', value: appt, valueX: 376 })
  for (const ref of stop.references ?? []) {
    right.push({ label: `${refLabelOf(ref.label)} #`, value: foldAscii(ref.value), valueX: 456 })
  }
  const notes = foldAscii(stop.instructions ?? '').replace(/\s+/g, ' ').trim()
  const noteLines = notes ? wrapMono(notes, 50) : []
  noteLines.forEach((l, i) => right.push({ label: i === 0 ? 'Appt Notes:' : '', value: l, valueX: 456 }))

  const lines = Math.max(left.length, right.length ? right.length + 1 : 0, 1)
  const height = 18.4 + lines * ROW + 5.6
  if (ctx.y + height > CONTENT_BOTTOM) newPage(ctx)
  const rule = ctx.y
  hline(ctx.page, 18, 592.1, rule)
  const pick = stop.kind === 'PICKUP'
  if (!pick) ctx.page.drawRectangle({ x: 18, y: PAGE_H - rule - 17.4, width: 47.6, height: 17.4, color: ink })
  const labelColor = pick ? ink : white
  put(ctx.page, pick ? 'PICK' : 'STOP', 23, rule + 5.4, fonts.helvBold, 11, { color: labelColor })
  put(ctx.page, String(ordinal), pick ? 57 : 55, rule + 5.4, fonts.mono, 10, { color: labelColor })

  left.forEach((l, i) => put(ctx.page, l, 68, rule + 18.4 + i * ROW, fonts.mono, 8.5))
  right.forEach((r, i) => {
    const top = rule + 18.4 + (i + 1) * ROW
    if (r.label) put(ctx.page, r.label, r.valueX - 4, top, fonts.monoBold, 8.5, { align: 'right' })
    put(ctx.page, r.value, r.valueX, top, fonts.mono, 8.5, { color: soft })
  })
  ctx.y = rule + height
}

/** The legal terms, flowed line by line from wherever the stops ended, across as many pages as it takes. */
function drawTerms(ctx: Ctx): void {
  const { fonts } = ctx
  hline(ctx.page, 18, 592.1, ctx.y)
  let top = ctx.y + 6.5
  let printedHere = 0
  for (const line of RATE_CON_TERMS) {
    if (top + 10.8 > CONTENT_BOTTOM) {
      if (printedHere > 0) {
        put(ctx.page, '(Rate Confirmation Details on Next Page)', 306, 726.5, fonts.monoBold, 12, { align: 'center' })
      }
      newPage(ctx)
      top = 196.1
      printedHere = 0
    }
    put(ctx.page, line, 66, top, fonts.monoBoldOblique, 10)
    top += 10.8
    printedHere += 1
  }
}

/**
 * Build the rate confirmation as PDF bytes.
 *
 * Throws when `totalCents` disagrees with the charge lines - a rate con whose printed total is
 * not the sum of what it lists is the one document we may never send.
 */
export async function buildRateConPdf(input: RateConInput): Promise<Uint8Array> {
  const summed = input.charges.reduce((total, c) => total + c.amountCents, 0)
  if (summed !== input.totalCents) {
    throw new Error(
      `Rate confirmation total ${money(input.totalCents)} does not match its charge lines (${money(summed)})`,
    )
  }
  const pdf = await PDFDocument.create()
  const fonts: Fonts = {
    helv: await pdf.embedFont(StandardFonts.Helvetica),
    helvBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
    monoBoldOblique: await pdf.embedFont(StandardFonts.CourierBoldOblique),
  }
  const logo = await pdf.embedPng(RATE_CON_LOGO_PNG_BASE64)
  if (logo.width !== RATE_CON_LOGO_WIDTH || logo.height !== RATE_CON_LOGO_HEIGHT) {
    throw new Error('Rate confirmation logo asset does not match its declared size')
  }
  const ctx: Ctx = {
    pdf, fonts, logo, input,
    stamp: stampOf(input.issuedAt ?? new Date()),
    page: pdf.addPage([PAGE_W, PAGE_H]),
    y: BODY_TOP,
  }
  drawHeader(ctx)
  drawFooter(ctx)
  drawDetails(ctx)
  drawRevision(ctx)

  let picks = 0
  let drops = 0
  for (const stop of input.stops) {
    drawStop(ctx, stop, stop.kind === 'PICKUP' ? ++picks : ++drops)
  }
  drawTerms(ctx)
  return pdf.save()
}

export interface RateConSignature {
  name: string
  ip: string
  at: string
  fields: Record<string, string>
}

/**
 * Append EXACTLY ONE page carrying the typed signature, the signer's IP, the timestamp
 * and the values they filled in. The original pages are never rewritten — what the
 * carrier saw is what stays in the file, with the acceptance evidence added at the end.
 */
export async function stampSignature(pdfBytes: Uint8Array, sig: RateConSignature): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(pdfBytes)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.addPage()
  const { width, height } = page.getSize()
  const ink = rgb(0.11, 0.15, 0.22)
  const muted = rgb(0.42, 0.45, 0.5)

  page.drawRectangle({ x: 0, y: height - 70, width, height: 70, color: rgb(0, 0, 0) })
  page.drawText('ELECTRONIC ACCEPTANCE', {
    x: M, y: height - 44, size: 16, font: bold, color: rgb(1, 1, 1),
  })

  let y = height - 110
  page.drawText('Signed by', { x: M, y, size: 9, font: bold, color: muted })
  y -= 22
  page.drawText(sig.name, { x: M, y, size: 18, font: bold, color: ink })
  y -= 20
  page.drawText(`IP address ${sig.ip}`, { x: M, y, size: 10, font, color: muted })
  y -= 14
  page.drawText(`Accepted ${sig.at}`, { x: M, y, size: 10, font, color: muted })
  y -= 34

  const entries = Object.entries(sig.fields)
  if (entries.length) {
    page.drawText('CARRIER DETAILS', { x: M, y, size: 9, font: bold, color: muted })
    y -= 18
    for (const [label, value] of entries) {
      page.drawText(`${label}:`, { x: M, y, size: 10, font: bold, color: ink })
      page.drawText(value || '—', { x: M + 140, y, size: 10, font, color: ink })
      y -= 16
    }
    y -= 14
  }

  page.drawText(
    'This typed signature is the carrier\u2019s electronic acceptance of the rate confirmation on the preceding pages.',
    { x: M, y, size: 8, font, color: muted },
  )
  return pdf.save()
}
