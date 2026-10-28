/**
 * The bill of lading — the receipt for freight that travels with the driver.
 *
 * Built in the browser from `bolData`, saved by SAVE_GENERATED_DOCUMENT, and handed
 * to a dock. The layout follows the rate confirmation (`src/lib/carrierRateCon.ts`):
 * jsPDF in points on letter stock, a black header band, `jspdf-autotable` for the
 * freight grid.
 *
 * Browser only — the Lambdas never import this file, so `@/` paths are fine here
 * (unlike the shared pure libs, which must stay relative for the esbuild bundle).
 *
 * There is no money on this page because `BolInput` has no field that could carry
 * any. That is the whole design: a shipper, a driver and a consignee read this, and
 * none of them is entitled to what anybody paid.
 */
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { generatedFilename } from '@/lib/shipmentDocuments'
import type { BolInput, BolParty } from '@/lib/documentData'

/** `jspdf-autotable` writes the finished table's geometry back onto the doc it drew into. */
interface AutoTabled { lastAutoTable: { finalY: number } }

const M = 40
const FOOT_ROOM = 56

/** The same name the generated file gets in S3, so a download matches its key. */
export function bolFilename(shipmentNumber: string, version: number): string {
  return generatedFilename('BOL', shipmentNumber, version)
}

function apptText(appt: string | null): string {
  if (!appt) return 'TBD'
  const at = new Date(appt)
  if (Number.isNaN(at.getTime())) return 'TBD'
  const date = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date}  ${time}`
}

/** Black band at the top of every page: who tendered, which BOL, which shipment. */
function drawHeader(doc: jsPDF, input: BolInput): void {
  const W = doc.internal.pageSize.getWidth()
  doc.setFillColor(0, 0, 0)
  doc.rect(0, 0, W, 70, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(input.broker.name, M, 34)
  const ids = [
    input.broker.mc ? `MC ${input.broker.mc}` : '',
    input.broker.phone ?? '',
  ].filter(Boolean).join('  ·  ')
  if (ids) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(190, 200, 215)
    doc.text(ids, M, 50)
  }
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text('BILL OF LADING', W - M, 32, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(190, 200, 215)
  doc.text(`BOL ${input.bolNumber}  ·  Shipment ${input.shipmentNumber}`, W - M, 48, { align: 'right' })
}

/** One party block. Returns how many lines it drew, so the taller side sets the next y. */
function partyLines(party: BolParty): string[] {
  const lines = [party.name, ...party.address.split('\n')].filter(Boolean)
  if (party.contact) lines.push(party.contact)
  lines.push(`Appointment: ${apptText(party.appt)}`)
  for (const ref of party.refs) lines.push(`${ref.label}: ${ref.value}`)
  return lines
}

/**
 * Build the bill of lading. One page, continuing onto a second only when the freight,
 * the notes and the conditions genuinely need it; the signature block always closes
 * the document.
 */
export async function buildBolPdf(input: BolInput): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()

  drawHeader(doc, input)
  let y = 100

  /** Reserve `h` points on the current page, continuing onto a fresh one if they are gone. */
  const room = (h: number) => {
    if (y + h <= H - FOOT_ROOM) return
    doc.addPage()
    drawHeader(doc, input)
    y = 100
  }

  // ── Bill to ─────────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text('CUSTOMER', M, y)
  y += 14
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(55, 65, 81)
  doc.text([input.customer.name, input.customer.billTo ? `Bill to: ${input.customer.billTo}` : '']
    .filter(Boolean).join('     '), M, y)
  y += 24

  // ── Ship from · ship to ─────────────────────────────────────────────────────
  const right = W / 2 + 10
  const shipper = partyLines(input.shipper)
  const consignee = partyLines(input.consignee)
  room(28 + Math.max(shipper.length, consignee.length) * 13)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text('SHIP FROM', M, y)
  doc.text('SHIP TO', right, y)
  y += 14
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(55, 65, 81)
  const rows = Math.max(shipper.length, consignee.length)
  for (let i = 0; i < rows; i++) {
    if (shipper[i]) doc.text(shipper[i], M, y + i * 13, { maxWidth: W / 2 - M - 10 })
    if (consignee[i]) doc.text(consignee[i], right, y + i * 13, { maxWidth: W / 2 - M - 10 })
  }
  y += rows * 13 + 14

  // ── Carrier ─────────────────────────────────────────────────────────────────
  if (input.carrier) {
    const carrier = [
      input.carrier.name,
      input.carrier.mc ? `MC ${input.carrier.mc}` : '',
      input.carrier.driverName ? `Driver: ${input.carrier.driverName}` : '',
      input.carrier.truckNumber ? `Truck: ${input.carrier.truckNumber}` : '',
      input.carrier.trailerNumber ? `Trailer: ${input.carrier.trailerNumber}` : '',
    ].filter(Boolean).join('     ')
    room(32)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(107, 114, 128)
    doc.text('CARRIER', M, y)
    y += 14
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(55, 65, 81)
    doc.text(carrier, M, y, { maxWidth: W - M * 2 })
    y += 22
  }

  // ── Freight ─────────────────────────────────────────────────────────────────
  room(60)
  autoTable(doc, {
    startY: y,
    head: [['Qty', 'Handling', 'Description', 'Weight', 'Class', 'NMFC', 'Hazmat']],
    body: input.freight.length > 0
      ? input.freight.map((item) => [
        String(item.qty),
        item.handlingUnit,
        item.description || '—',
        item.weightLbs != null ? `${item.weightLbs.toLocaleString()} lbs` : '—',
        item.freightClass || '—',
        item.nmfc || '—',
        item.hazmat ? `UN${item.hazmat.un} · ${item.hazmat.hazClass}` : '—',
      ])
      : [['—', '—', 'See attached manifest', '—', '—', '—', '—']],
    theme: 'striped',
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 8.5, halign: 'left' },
    bodyStyles: { fontSize: 8.5, textColor: [31, 41, 55], valign: 'top' },
    columnStyles: {
      0: { cellWidth: 34 }, 1: { cellWidth: 58 }, 3: { cellWidth: 62 },
      4: { cellWidth: 40 }, 5: { cellWidth: 48 }, 6: { cellWidth: 78 },
    },
    // A freight list long enough to break takes the letterhead onto the next page with
    // it; `margin.top` is where the table resumes under that band.
    margin: { top: 100, left: M, right: M },
    didDrawPage: () => drawHeader(doc, input),
    tableWidth: W - M * 2,
  })
  y = (doc as jsPDF & AutoTabled).lastAutoTable.finalY + 20

  // ── Special requirements and the customer's instructions ────────────────────
  if (input.specialRequirements.length > 0) {
    room(30)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(107, 114, 128)
    doc.text('SPECIAL REQUIREMENTS', M, y)
    y += 14
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(55, 65, 81)
    doc.text(input.specialRequirements.join('     '), M, y, { maxWidth: W - M * 2 })
    y += 22
  }

  if (input.customerNotes) {
    const lines = doc.splitTextToSize(input.customerNotes, W - M * 2) as string[]
    room(26 + lines.length * 11)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(107, 114, 128)
    doc.text('SHIPPING INSTRUCTIONS', M, y)
    y += 14
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(55, 65, 81)
    doc.text(lines, M, y)
    y += lines.length * 11 + 12
  }

  // ── Conditions ──────────────────────────────────────────────────────────────
  if (input.terms.trim()) {
    const lines = doc.splitTextToSize(input.terms.trim(), W - M * 2) as string[]
    room(26 + lines.length * 10)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(107, 114, 128)
    doc.text('CONDITIONS', M, y)
    y += 14
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(75, 85, 99)
    doc.text(lines, M, y)
    y += lines.length * 10 + 14
  }

  // ── Signatures ──────────────────────────────────────────────────────────────
  // Three hands touch the freight, so three sign for it: the shipper tendering, the
  // driver taking possession, the consignee receiving.
  room(96)
  doc.setDrawColor(229, 231, 235)
  doc.line(M, y, W - M, y)
  y += 20
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text('SIGNATURES', M, y)
  y += 22
  const third = (W - M * 2) / 3
  const captions = ['Shipper / date', 'Driver / date', 'Consignee / date']
  doc.setDrawColor(107, 114, 128)
  captions.forEach((caption, i) => {
    const x = M + i * third
    doc.line(x, y + 2, x + third - 20, y + 2)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(107, 114, 128)
    doc.text(caption, x, y + 16)
  })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(156, 163, 175)
  doc.text(`${input.broker.name} — bill of lading ${input.bolNumber}`, M, H - 28)
  return doc
}
