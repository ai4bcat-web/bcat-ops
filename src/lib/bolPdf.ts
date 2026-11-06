/**
 * The bill of lading — the receipt for freight that travels with the driver.
 *
 * Built in the browser from `buildBolModel` (`src/lib/bolModel.ts`), saved by
 * SAVE_GENERATED_DOCUMENT, and handed to a dock. The header is the shared letterhead
 * (`src/lib/pdfLetterhead.ts`, same as the rate confirmation): jsPDF in points on
 * letter stock, `jspdf-autotable` for the grids.
 *
 * Browser only — the Lambdas never import this file, so `@/` paths are fine here
 * (unlike the shared pure libs, which must stay relative for the esbuild bundle).
 *
 * There is no money on this page unless the model carries `rates` (a customer copy),
 * and the model only carries them when the caller asked for them.
 */
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { fetchDivisionLogoDataUrl } from '@/lib/divisionLogo'
import { drawLetterhead, resolveLetterhead } from '@/lib/pdfLetterhead'
import type { HeaderLogo } from '@/lib/pdfLetterhead'
import type { BolCarrier, BolInput, BolParty } from '@/lib/bolModel'

/** `jspdf-autotable` writes the finished table's geometry back onto the doc it drew into. */
interface AutoTabled { lastAutoTable: { finalY: number } }

export interface BuildBolOptions {
  /** Resolves a Division.logoKey to a PNG/JPEG data URL, or null. Defaults to the S3 loader. */
  loadLogo?: (logoKey: string) => Promise<string | null>
}

const M = 40
const FOOT_ROOM = 44
/** Where the body starts on every page: under the band and the scope line. */
const BODY_TOP = 104

const GREY = [107, 114, 128] as const
const INK = [55, 65, 81] as const

function apptText(party: Pick<BolParty, 'appt' | 'apptEnd' | 'apptType'>): string {
  if (!party.appt) return party.apptType ? `${party.apptType} — TBD` : 'TBD'
  const at = new Date(party.appt)
  if (Number.isNaN(at.getTime())) return 'TBD'
  const time = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const end = party.apptEnd ? new Date(party.apptEnd) : null
  const window = end && !Number.isNaN(end.getTime()) ? `${time(at)} – ${time(end)}` : time(at)
  const date = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${date}  ${window}${party.apptType ? `  ${party.apptType}` : ''}`
}

function dayText(iso: string): string {
  const at = new Date(`${iso}T12:00:00`)
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function partyLines(party: BolParty): string[] {
  const lines = [party.name, ...party.address.split('\n')].filter(Boolean)
  if (party.contact) lines.push(party.contact)
  lines.push(`Appointment: ${apptText(party)}`)
  for (const ref of party.refs) lines.push(`${ref.label}: ${ref.value}`)
  if (party.alsoPickedUp.length > 0) lines.push(`Also picked up at: ${party.alsoPickedUp.join('; ')}`)
  return lines
}

const weightText = (lbs: number | null): string => (lbs != null ? `${lbs.toLocaleString('en-US')} lbs` : '—')
const centsText = (c: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100)

/**
 * Build the bill of lading. Pages break wherever the content needs it — a long item
 * list takes the letterhead onto each new page — and the signature block always
 * closes the document on the last page.
 */
export async function buildBolPdf(input: BolInput, options: BuildBolOptions = {}): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const logo: HeaderLogo | null = await resolveLetterhead(
    doc,
    { logoKey: input.broker.logoKey },
    options.loadLogo ?? fetchDivisionLogoDataUrl,
  )
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const contentW = W - M * 2

  // autotable's didDrawPage fires on the page the table starts on too, so a page's
  // letterhead is drawn once, whoever reaches the page first.
  const headed = new Set<number>()
  const header = () => {
    const page = doc.getCurrentPageInfo().pageNumber
    if (headed.has(page)) return
    headed.add(page)
    drawLetterhead(doc, {
      legalName: input.broker.legalName,
      ids: [
        input.broker.mc ? `MC ${input.broker.mc}` : '',
        input.broker.dot ? `DOT ${input.broker.dot}` : '',
      ].filter(Boolean).join('  ·  '),
      detail: [input.broker.address.replace(/\n/g, ', '), input.broker.phone ?? ''].filter(Boolean).join('  ·  '),
      title: 'BILL OF LADING',
      subtitle: `BOL ${input.bolNumber}  ·  ${dayText(input.date)}`,
      logo,
    })
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...INK)
    doc.text(input.scopeLabel, M, 88, { maxWidth: contentW })
  }

  header()
  let y = BODY_TOP

  /** Reserve `h` points on the current page, continuing onto a fresh one if they are gone. */
  const room = (h: number) => {
    if (y + h <= H - FOOT_ROOM) return
    doc.addPage()
    header()
    y = BODY_TOP
  }

  const label = (caption: string, x = M, at = y) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(...GREY)
    doc.text(caption, x, at)
  }
  const body = (size = 10) => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(size)
    doc.setTextColor(...INK)
  }
  const paragraph = (caption: string, content: string, size = 9) => {
    body(size)
    const lines = doc.splitTextToSize(content, contentW) as string[]
    const lead = size + 2
    room(24 + lines.length * lead)
    label(caption)
    y += 13
    body(size)
    doc.text(lines, M, y)
    y += lines.length * lead + 10
  }
  const table = (head: string[], rows: string[][], opts: { foot?: string[][]; widths?: Record<number, number> } = {}) => {
    room(50)
    autoTable(doc, {
      startY: y,
      head: [head],
      body: rows,
      foot: opts.foot,
      showFoot: 'lastPage',
      theme: 'striped',
      headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 8.5, halign: 'left' },
      footStyles: { fillColor: [243, 244, 246], textColor: [31, 41, 55], fontSize: 8.5, fontStyle: 'bold' },
      bodyStyles: { fontSize: 8.5, textColor: [31, 41, 55], valign: 'top' },
      columnStyles: Object.fromEntries(Object.entries(opts.widths ?? {}).map(([k, w]) => [k, { cellWidth: w }])),
      margin: { top: BODY_TOP, left: M, right: M, bottom: FOOT_ROOM },
      tableWidth: contentW,
      didDrawPage: header,
    })
    y = (doc as jsPDF & AutoTabled).lastAutoTable.finalY + 16
  }

  // ── Customer · bill to · PO ─────────────────────────────────────────────────
  const third = contentW / 3
  label('CUSTOMER')
  label('BILL TO', M + third)
  label('CUSTOMER PO', M + third * 2)
  body()
  doc.text(input.customer.name || '—', M, y + 14, { maxWidth: third - 10 })
  doc.text(input.customer.billTo || '—', M + third, y + 14, { maxWidth: third - 10 })
  doc.text(input.customer.poRef || '—', M + third * 2, y + 14, { maxWidth: third - 10 })
  y += 36

  // ── Ship from · ship to ─────────────────────────────────────────────────────
  const right = W / 2 + 10
  const half = W / 2 - M - 10
  const shipper = partyLines(input.shipper).flatMap((l) => doc.splitTextToSize(l, half) as string[])
  const consignee = partyLines(input.consignee).flatMap((l) => doc.splitTextToSize(l, half) as string[])
  const rows = Math.max(shipper.length, consignee.length)
  room(30 + rows * 13)
  label('SHIP FROM')
  label('SHIP TO', right)
  y += 14
  body()
  for (let i = 0; i < rows; i++) {
    if (shipper[i]) doc.text(shipper[i], M, y + i * 13)
    if (consignee[i]) doc.text(consignee[i], right, y + i * 13)
  }
  y += rows * 13 + 12

  // ── Stops (master) ──────────────────────────────────────────────────────────
  if (input.stops.length > 0) {
    table(
      ['Stop', 'Location', 'Appointment', 'References'],
      input.stops.map((s) => [
        `${s.seq}. ${s.kind === 'PICKUP' ? 'Pickup' : 'Delivery'}`,
        [s.name, s.cityState].filter(Boolean).join(', ') || '—',
        apptText({ appt: s.appt, apptEnd: null, apptType: null }),
        s.refs.map((r) => `${r.label}: ${r.value}`).join('\n') || '—',
      ]),
      { widths: { 0: 62, 2: 130, 3: 120 } },
    )
  }

  // ── Carrier ─────────────────────────────────────────────────────────────────
  const sealBlank = input.chips.includes('Seal required')
  const sealOf = (c: BolCarrier) => c.sealNumber ?? (sealBlank ? '________' : '—')
  if (input.carriers.length > 0) {
    table(
      ['Carrier', 'MC', 'Driver', 'Truck', 'Trailer', 'Seal'],
      input.carriers.map((c) => [
        [c.name || '—', c.covers ? `Covers: ${c.covers}` : ''].filter(Boolean).join('\n'),
        c.mc ?? '—',
        [c.driverName, c.driverPhone].filter(Boolean).join('\n') || '—',
        c.truckNumber ?? '—',
        c.trailerNumber ?? '—',
        sealOf(c),
      ]),
      { widths: { 1: 52, 3: 56, 4: 56, 5: 62 } },
    )
  } else {
    label('CARRIER')
    y += 14
    body()
    doc.text(`To be assigned${sealBlank ? '          Seal ________' : ''}`, M, y)
    y += 22
  }

  // ── Freight ─────────────────────────────────────────────────────────────────
  const pieces = input.totals.pieces
  table(
    ['Qty', 'Unit', 'Description', 'Weight', 'Class', 'NMFC', 'Hazmat'],
    input.lines.map((l) => [
      l.qty != null ? String(l.qty) : '—',
      l.unit || '—',
      l.description || '—',
      weightText(l.weightLbs),
      l.freightClass || '—',
      l.nmfc || '—',
      l.hazmat || '—',
    ]),
    {
      foot: [[
        pieces != null ? String(pieces) : '—', 'Total', '', weightText(input.totals.weightLbs), '', '', '',
      ]],
      widths: { 0: 34, 1: 52, 3: 62, 4: 40, 5: 48, 6: 78 },
    },
  )
  y -= 6
  if (input.linesNote) {
    body(8.5)
    doc.text(input.linesNote, M, y)
    y += 14
  }
  if (input.declaredValue) {
    room(18)
    body(9)
    doc.text(`Declared value: ${input.declaredValue}`, M, y)
    y += 16
  }
  y += 4

  // ── Requirements, references, notes ─────────────────────────────────────────
  if (input.chips.length > 0) paragraph('REQUIREMENTS', input.chips.join('   ·   '), 10)
  if (input.references.length > 0) {
    paragraph('REFERENCES', input.references.map((r) => `${r.label}: ${r.value}`).join('     '))
  }
  if (input.bolNotes) paragraph('BOL NOTES', input.bolNotes)
  if (input.specialInstructions) paragraph('SPECIAL INSTRUCTIONS', input.specialInstructions)

  // ── Charges (customer copy only) ────────────────────────────────────────────
  if (input.rates) {
    room(30)
    body(9)
    doc.setFont('helvetica', 'bold')
    doc.text('Customer copy — contains rates', M, y)
    y += 8
    table(
      ['Charges', 'Amount'],
      input.rates.lines.map((l) => [l.label, centsText(l.amountCents)]),
      { foot: [['Total', centsText(input.rates.totalCents)]], widths: { 1: 90 } },
    )
  }

  // ── Conditions ──────────────────────────────────────────────────────────────
  const terms = [input.terms.trim(), input.receiptLineEs ?? ''].filter(Boolean).join('\n')
  if (terms) {
    body(8)
    const lines = doc.splitTextToSize(terms, contentW) as string[]
    room(26 + lines.length * 10)
    label('CONDITIONS')
    y += 13
    body(8)
    doc.text(lines, M, y)
    y += lines.length * 10 + 12
  }

  // ── Signatures ──────────────────────────────────────────────────────────────
  // Three hands touch the freight, so three sign for it: the shipper tendering, the
  // driver taking possession (one block per carrier), the consignee receiving.
  const block = (col: number, title: string, fields: string[], extra: string[]) => {
    const x = M + col * third
    const w = third - 18
    label(title, x, y)
    let at = y + 28
    doc.setDrawColor(...GREY)
    for (const field of fields) {
      doc.line(x, at, x + w, at)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(...GREY)
      doc.text(field, x, at + 9)
      at += 28
    }
    body(8)
    for (const line of extra) {
      doc.text(line, x, at - 6, { maxWidth: w })
      at += 11
    }
  }
  const BLOCK_H = 132
  room(BLOCK_H + 18)
  doc.setDrawColor(229, 231, 235)
  doc.line(M, y, W - M, y)
  y += 16
  label('SIGNATURES')
  y += 12
  const signed = ['Signature', 'Print name', 'Date / time']
  const drivers = input.carriers.length > 0 ? input.carriers : [null]
  block(0, 'SHIPPER', signed, [`Pieces tendered: ${pieces ?? '____'}`])
  block(1, drivers[0]?.name ? `CARRIER / DRIVER — ${drivers[0].name}` : 'CARRIER / DRIVER', signed, [
    drivers[0]?.driverName ? `Driver: ${drivers[0].driverName}` : 'Driver: ____________',
  ])
  block(2, 'CONSIGNEE', signed, [
    'Pieces received: ______   [ ] in good order',
    '[ ] exceptions: ____________________',
  ])
  y += BLOCK_H
  for (const extra of drivers.slice(1)) {
    room(BLOCK_H)
    block(1, `CARRIER / DRIVER — ${extra?.name ?? ''}`, signed, [
      extra?.driverName ? `Driver: ${extra.driverName}` : 'Driver: ____________',
    ])
    y += BLOCK_H
  }

  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(156, 163, 175)
    doc.text(`${input.broker.legalName} — bill of lading ${input.bolNumber}`, M, H - 24)
    doc.text(`Page ${page} of ${pages}`, W - M, H - 24, { align: 'right' })
  }
  return doc
}
