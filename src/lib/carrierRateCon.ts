/**
 * Carrier rate confirmation — the document a booked carrier signs.
 *
 * Built in the browser from the shipment bundle, mailed as a PDF attachment by
 * SEND_RATE_CON, and stamped with the typed signature by the public signing page.
 * The layout follows the driver-pay statement (`src/lib/payPdf.ts`): jsPDF in
 * points on letter stock, a black header band, `jspdf-autotable` for the grids.
 *
 * Browser only — the Lambdas never import this file, so `@/` paths are fine here
 * (unlike the shared pure libs, which must stay relative for the esbuild bundle).
 *
 * Only CARRIER-side money and CARRIER-visible references belong on this page: the
 * carrier must never read what the customer pays. Callers filter before handing the
 * stops and charges over.
 */
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { CarrierRecord, Division, LoadCarrierRecord, RateConRequiredField } from '@/types/tms'

/** `jspdf-autotable` writes the finished table's geometry back onto the doc it drew into. */
interface AutoTabled { lastAutoTable: { finalY: number } }

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const cents = (n: number) => money(n / 100)

const M = 40
const FOOT_ROOM = 56

const REQUIRED_FIELD_LABELS: Record<RateConRequiredField, string> = {
  DRIVER_NAME: 'Driver name',
  DRIVER_PHONE: 'Driver phone',
  TRUCK_NUMBER: 'Truck number',
  TRAILER_NUMBER: 'Trailer number',
  PICKUP_ETA: 'Pickup ETA',
  PLATES: 'Plates',
  VIN: 'VIN',
}

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
  instructions?: string | null
}

export interface RateConInput {
  division: Division | null
  carrier: Pick<CarrierRecord, 'name' | 'mcNumber' | 'dotNumber' | 'phone' | 'email'>
  loadCarrier: LoadCarrierRecord
  loadNumber: string
  equipmentType?: string | null
  commodity?: string | null
  weightLbs?: number | null
  stops: RateConStop[]
  /** CARRIER-side charge lines only. */
  charges: { label: string; amountCents: number }[]
  totalCents: number
  quickPay?: { days: number; feeBps: number; feeCents: number; netCents: number } | null
  paymentTermsDays?: number | null
  terms: string
  requiredFields: RateConRequiredField[]
}

/** `${loadNumber}` is the broker's number, `${version}` the re-send counter. */
export function rateConFilename(loadNumber: string, version: number): string {
  return `rate-con-${loadNumber}-v${version}.pdf`
}

/** Base64 (no data-URI prefix) of a built doc — for emailing and for the sign API. */
export function rateConPdfBase64(doc: jsPDF): string {
  return doc.output('datauristring').split('base64,')[1] ?? ''
}

/**
 * Split the stops into legs. A leg ends at its last delivery: the next pickup after a
 * delivery starts a new one. Multi-pick / multi-drop stays one leg. An empty stop list
 * still yields one (empty) leg so the document always has exactly one page per leg.
 */
function legsOf(stops: RateConStop[]): RateConStop[][] {
  const legs: RateConStop[][] = []
  let current: RateConStop[] = []
  let delivered = false
  for (const stop of stops) {
    if (stop.kind === 'PICKUP' && delivered) {
      legs.push(current)
      current = []
      delivered = false
    }
    if (stop.kind === 'DELIVERY') delivered = true
    current.push(stop)
  }
  legs.push(current)
  return legs
}

function addressOf(stop: RateConStop): string {
  const cityLine = [stop.city, [stop.state, stop.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return [stop.name, stop.address, cityLine].filter(Boolean).join('\n') || '—'
}

function apptOf(stop: RateConStop): string {
  if (!stop.apptAt) return stop.apptType ? `${stop.apptType} — TBD` : 'TBD'
  const at = new Date(stop.apptAt)
  if (Number.isNaN(at.getTime())) return 'TBD'
  const date = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const end = stop.apptEnd ? new Date(stop.apptEnd) : null
  const window = end && !Number.isNaN(end.getTime())
    ? `${time} – ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : time
  return [date, window, stop.apptType].filter(Boolean).join('\n')
}

function brokerLines(division: Division | null): { name: string; ids: string; remit: string[] } {
  const name = division?.legalName || division?.name || 'Broker'
  const ids = [
    division?.mcNumber ? `MC ${division.mcNumber}` : '',
    division?.dotNumber ? `DOT ${division.dotNumber}` : '',
  ].filter(Boolean).join('  ·  ')
  const addr = division?.remitToAddress ?? null
  const cityLine = addr
    ? [addr.city, [addr.state, addr.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : ''
  const remit = [
    division?.remitToName || name,
    addr?.street ?? '',
    cityLine,
    division?.remitToEmail ?? '',
  ].filter(Boolean)
  return { name, ids, remit }
}

/** Black band at the top of every page: who is tendering, which load, which leg. */
function drawHeader(doc: jsPDF, input: RateConInput, legIndex: number, legCount: number): void {
  const W = doc.internal.pageSize.getWidth()
  const broker = brokerLines(input.division)
  doc.setFillColor(0, 0, 0)
  doc.rect(0, 0, W, 70, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(broker.name, M, 34)
  if (broker.ids) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(190, 200, 215)
    doc.text(broker.ids, M, 50)
  }
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text('RATE CONFIRMATION', W - M, 32, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(190, 200, 215)
  const label = legCount > 1
    ? `Load ${input.loadNumber}  ·  Leg ${legIndex + 1} of ${legCount}`
    : `Load ${input.loadNumber}`
  doc.text(label, W - M, 48, { align: 'right' })
}

/** Remit-to on the left, the carrier we booked on the right. Returns the next y. */
function drawParties(doc: jsPDF, input: RateConInput): number {
  const W = doc.internal.pageSize.getWidth()
  const broker = brokerLines(input.division)
  const right = W / 2 + 10
  let y = 100

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text('REMIT TO', M, y)
  doc.text('CARRIER', right, y)
  y += 14

  const carrierIds = [
    input.carrier.mcNumber ? `MC ${input.carrier.mcNumber}` : '',
    input.carrier.dotNumber ? `DOT ${input.carrier.dotNumber}` : '',
  ].filter(Boolean).join('  ·  ')
  const carrierLines = [
    input.carrier.name,
    carrierIds,
    input.carrier.phone ?? '',
    input.carrier.email ?? '',
  ].filter(Boolean)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(55, 65, 81)
  const rows = Math.max(broker.remit.length, carrierLines.length)
  for (let i = 0; i < rows; i++) {
    if (broker.remit[i]) doc.text(broker.remit[i], M, y + i * 13)
    if (carrierLines[i]) doc.text(carrierLines[i], right, y + i * 13)
  }
  return y + rows * 13 + 10
}

function drawStops(doc: jsPDF, leg: RateConStop[], startY: number): number {
  const W = doc.internal.pageSize.getWidth()
  autoTable(doc, {
    startY,
    head: [['Stop', 'Location', 'Appointment', 'References', 'Instructions']],
    body: leg.map((s, i) => [
      `${i + 1}. ${s.kind === 'PICKUP' ? 'Pickup' : 'Delivery'}`,
      addressOf(s),
      apptOf(s),
      (s.references ?? []).map((r) => `${r.label}: ${r.value}`).join('\n') || '—',
      s.instructions || '—',
    ]),
    theme: 'striped',
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 8.5, halign: 'left' },
    bodyStyles: { fontSize: 8.5, textColor: [31, 41, 55], valign: 'top' },
    columnStyles: { 0: { cellWidth: 62, fontStyle: 'bold' }, 2: { cellWidth: 92 }, 3: { cellWidth: 92 } },
    margin: { left: M, right: M },
    tableWidth: W - M * 2,
  })
  return (doc as jsPDF & AutoTabled).lastAutoTable.finalY + 22
}

/**
 * Build the rate confirmation. One page per leg; the money, terms and signature follow
 * the last leg's stop table on that same page (a long terms block spills onto a
 * continuation page rather than being clipped).
 *
 * Throws when `totalCents` disagrees with the charge lines — a rate con whose printed
 * total is not the sum of what it lists is the one document we may never send.
 */
export async function buildRateConPdf(input: RateConInput): Promise<jsPDF> {
  const summed = input.charges.reduce((total, c) => total + c.amountCents, 0)
  if (summed !== input.totalCents) {
    throw new Error(
      `Rate confirmation total ${cents(input.totalCents)} does not match its charge lines (${cents(summed)})`,
    )
  }

  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const legs = legsOf(input.stops)

  let y = 0
  for (let i = 0; i < legs.length; i++) {
    if (i > 0) doc.addPage()
    drawHeader(doc, input, i, legs.length)
    y = drawParties(doc, input)
    y = drawStops(doc, legs[i], y)
  }

  /** Reserve `h` points on the current page, continuing onto a fresh one if they are gone. */
  const room = (h: number) => {
    if (y + h <= H - FOOT_ROOM) return
    doc.addPage()
    drawHeader(doc, input, legs.length - 1, legs.length)
    y = 100
  }

  // ── Equipment · commodity · weight ──────────────────────────────────────────
  const freight = [
    input.equipmentType ? `Equipment: ${input.equipmentType}` : '',
    input.commodity ? `Commodity: ${input.commodity}` : '',
    input.weightLbs != null ? `Weight: ${input.weightLbs.toLocaleString()} lbs` : '',
  ].filter(Boolean)
  if (freight.length) {
    room(30)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(107, 114, 128)
    doc.text('FREIGHT', M, y)
    y += 14
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(55, 65, 81)
    doc.text(freight.join('     '), M, y)
    y += 22
  }

  // ── Carrier pay ─────────────────────────────────────────────────────────────
  room(60)
  autoTable(doc, {
    startY: y,
    head: [['Carrier pay', 'Amount']],
    body: input.charges.map((c) => [c.label, cents(c.amountCents)]),
    foot: [['TOTAL', cents(input.totalCents)]],
    theme: 'striped',
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 8.5, halign: 'right' },
    footStyles: { fillColor: [243, 244, 246], textColor: [17, 24, 39], fontStyle: 'bold', halign: 'right' },
    bodyStyles: { fontSize: 9, textColor: [31, 41, 55] },
    columnStyles: { 0: { halign: 'left' }, 1: { halign: 'right', cellWidth: 110 } },
    margin: { left: M, right: M },
    tableWidth: W - M * 2,
  })
  y = (doc as jsPDF & AutoTabled).lastAutoTable.finalY + 16

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  if (input.paymentTermsDays != null) {
    room(16)
    doc.setTextColor(107, 114, 128)
    doc.text(`Payment terms: net ${input.paymentTermsDays} days from receipt of a complete invoice packet.`, M, y)
    y += 14
  }
  // The quick-pay fee is an AP deduction off the settlement, never a charge line on this
  // page — printing it as one would make the agreed rate read as a lower number.
  if (input.quickPay) {
    room(30)
    doc.setTextColor(55, 65, 81)
    const q = input.quickPay
    doc.text(
      `Quick pay elected: ${q.days} day${q.days === 1 ? '' : 's'} at ${(q.feeBps / 100).toFixed(2)}% — fee ${cents(q.feeCents)}, net payable ${cents(q.netCents)}.`,
      M, y,
    )
    y += 12
    doc.setTextColor(107, 114, 128)
    doc.text('Informational only. The fee is deducted at settlement; the agreed rate above is unchanged.', M, y)
    y += 18
  }

  // ── Blanks the carrier fills in before signing ──────────────────────────────
  if (input.requiredFields.length) {
    room(34)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(107, 114, 128)
    doc.text('REQUIRED BEFORE DISPATCH', M, y)
    y += 18
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    const colWidth = (W - M * 2) / 2
    input.requiredFields.forEach((field, i) => {
      const col = i % 2
      if (col === 0) room(26)
      const x = M + col * colWidth
      doc.setTextColor(55, 65, 81)
      doc.text(`${REQUIRED_FIELD_LABELS[field]}:`, x, y)
      doc.setDrawColor(156, 163, 175)
      doc.line(x + 92, y + 2, x + colWidth - 20, y + 2)
      if (col === 1 || i === input.requiredFields.length - 1) y += 22
    })
    y += 4
  }

  // ── Terms ───────────────────────────────────────────────────────────────────
  if (input.terms.trim()) {
    const lines = doc.splitTextToSize(input.terms.trim(), W - M * 2) as string[]
    room(26 + lines.length * 10)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(107, 114, 128)
    doc.text('TERMS', M, y)
    y += 14
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(75, 85, 99)
    doc.text(lines, M, y)
    y += lines.length * 10 + 12
  }

  // ── Signature ───────────────────────────────────────────────────────────────
  room(76)
  doc.setDrawColor(229, 231, 235)
  doc.line(M, y, W - M, y)
  y += 20
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text('CARRIER ACCEPTANCE', M, y)
  y += 20
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(55, 65, 81)
  const half = (W - M * 2) / 2
  doc.setDrawColor(107, 114, 128)
  doc.line(M, y + 2, M + half - 20, y + 2)
  doc.line(M + half, y + 2, W - M, y + 2)
  y += 14
  doc.setFontSize(8)
  doc.setTextColor(107, 114, 128)
  doc.text('Signature / printed name', M, y)
  doc.text('Date', M + half, y)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(156, 163, 175)
  doc.text(
    `${brokerLines(input.division).name} — rate confirmation for load ${input.loadNumber}`,
    M, H - 28,
  )
  return doc
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
