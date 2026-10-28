/**
 * The load summary — one internal page (or three) describing everything the office
 * knows about a shipment: both sides of the money, the margin, every reference, the
 * assignments that bounced and the incidents still open.
 *
 * Built in the browser from `loadSummaryData` and saved by SAVE_GENERATED_DOCUMENT,
 * with the same layout vocabulary as the rate confirmation
 * (`src/lib/carrierRateCon.ts`): jsPDF in points on letter stock, a black header
 * band, `jspdf-autotable` for the grids.
 *
 * Browser only — the Lambdas never import this file, so `@/` paths are fine here
 * (unlike the shared pure libs, which must stay relative for the esbuild bundle).
 *
 * Every page says INTERNAL out loud. `LoadSummaryInput` is assembled with no regard
 * for audience on purpose, so the only safeguard that matters is that nobody mails
 * this document out: `canEmailTo` refuses an INTERNAL row, and the generated
 * LOAD_SUMMARY row is written with `audience INTERNAL`.
 */
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { generatedFilename } from '@/lib/shipmentDocuments'
import type { LoadSummaryInput, LoadSummaryReference } from '@/lib/documentData'

/** `jspdf-autotable` writes the finished table's geometry back onto the doc it drew into. */
interface AutoTabled { lastAutoTable: { finalY: number } }

// Same formatting as the rate confirmation, so two documents about one shipment never
// disagree about how a number looks.
const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const cents = (n: number) => money(n / 100)

const M = 40
const FOOT_ROOM = 56

/** The same name the generated file gets in S3, so a download matches its key. */
export function loadSummaryFilename(loadNumber: string, version: number): string {
  return generatedFilename('LOAD_SUMMARY', loadNumber, version)
}

function stamp(iso: string | null): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  const date = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date} ${time}`
}

function referenceText(refs: LoadSummaryReference[]): string {
  return refs.map((ref) => `${ref.label}: ${ref.value}`).join('\n') || '—'
}

/** Black band at the top of every page, with the internal marking beside the title. */
function drawHeader(doc: jsPDF, input: LoadSummaryInput): void {
  const W = doc.internal.pageSize.getWidth()
  doc.setFillColor(0, 0, 0)
  doc.rect(0, 0, W, 70, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(`Shipment ${input.shipmentNumber}`, M, 34)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(190, 200, 215)
  doc.text(`${input.customer.name}  ·  ${input.mode}  ·  ${input.status.replace(/_/g, ' ')}`, M, 50)
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text('LOAD SUMMARY', W - M, 32, { align: 'right' })
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(248, 113, 113)
  doc.text('INTERNAL — NOT FOR CUSTOMERS OR CARRIERS', W - M, 48, { align: 'right' })
}

/**
 * Build the load summary. Sections follow the order somebody picking the shipment up
 * reads them in: who and what, where it went, what it sold and bought, who hauled it,
 * and what went wrong.
 */
export async function buildLoadSummaryPdf(input: LoadSummaryInput): Promise<jsPDF> {
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

  const heading = (label: string) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(107, 114, 128)
    doc.text(label, M, y)
    y += 14
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(55, 65, 81)
  }

  const grid = (head: string[], body: string[][], columnStyles: Record<number, { cellWidth: number }> = {}) => {
    room(60)
    autoTable(doc, {
      startY: y,
      head: [head],
      body: body.length > 0 ? body : [head.map(() => '—')],
      theme: 'striped',
      headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 8, halign: 'left' },
      bodyStyles: { fontSize: 8, textColor: [31, 41, 55], valign: 'top' },
      columnStyles,
      // A table long enough to break carries the band and the internal marking onto the
      // page it breaks onto; `margin.top` is where it resumes under that band.
      margin: { top: 100, left: M, right: M },
      didDrawPage: () => drawHeader(doc, input),
      tableWidth: W - M * 2,
    })
    y = (doc as jsPDF & AutoTabled).lastAutoTable.finalY + 18
  }

  // ── Customer and equipment ──────────────────────────────────────────────────
  const facts = [
    input.customer.billTo ? `Bill to: ${input.customer.billTo}` : '',
    input.customer.contact ? `Contact: ${input.customer.contact}` : '',
    input.customer.paymentTermsDays != null ? `Terms: net ${input.customer.paymentTermsDays}` : '',
    input.equipment.type ? `Equipment: ${input.equipment.type}` : '',
    input.equipment.lengthFt != null ? `${input.equipment.lengthFt} ft` : '',
    input.equipment.commodity ? `Commodity: ${input.equipment.commodity}` : '',
    input.equipment.weightLbs != null ? `Weight: ${input.equipment.weightLbs.toLocaleString()} lbs` : '',
    ...input.equipment.specialRequirements,
  ].filter(Boolean)
  if (facts.length > 0) {
    const lines = doc.splitTextToSize(facts.join('     '), W - M * 2) as string[]
    room(26 + lines.length * 13)
    heading('CUSTOMER · EQUIPMENT')
    doc.text(lines, M, y)
    y += lines.length * 13 + 10
  }

  // ── Legs ────────────────────────────────────────────────────────────────────
  if (input.loads.length > 0) {
    grid(
      ['Leg', 'Load', 'Status', 'Equipment', 'Carrier', 'Miles'],
      input.loads.map((load) => [
        String(load.leg),
        load.loadNumber,
        (load.status ?? '—').replace(/_/g, ' '),
        load.equipmentType ?? '—',
        load.carrierName ?? '—',
        load.miles != null ? load.miles.toLocaleString() : '—',
      ]),
      { 0: { cellWidth: 30 }, 5: { cellWidth: 48 } },
    )
  }

  // ── Stops, with the clocks as they were actually stamped ────────────────────
  grid(
    ['Stop', 'Location', 'Appointment', 'In', 'Out', 'References'],
    input.stops.map((stop, i) => [
      // The number is the stop's place on the route; the leg only has to be named when
      // there is more than one of them.
      [`${i + 1}. ${stop.kind === 'PICKUP' ? 'Pickup' : 'Delivery'}`,
        input.loads.length > 1 ? stop.loadNumber : ''].filter(Boolean).join('\n'),
      [stop.name, stop.address].filter(Boolean).join('\n') || '—',
      [stamp(stop.appt), stop.apptType].filter(Boolean).join('\n'),
      stamp(stop.arrivedAt),
      stamp(stop.departedAt),
      referenceText(stop.refs),
    ]),
    { 0: { cellWidth: 56 }, 2: { cellWidth: 78 }, 3: { cellWidth: 62 }, 4: { cellWidth: 62 } },
  )

  // ── References, with the visibility that decided where else they appear ─────
  if (input.references.length > 0) {
    grid(
      ['Reference', 'Value', 'Level', 'Visibility'],
      input.references.map((ref) => [ref.label, ref.value, ref.level, ref.visibility]),
      { 2: { cellWidth: 92 }, 3: { cellWidth: 72 } },
    )
  }

  // ── Both sides of the money ─────────────────────────────────────────────────
  const chargeRows = (side: typeof input.customerCharges) =>
    side.map((charge) => [
      charge.label,
      charge.loadNumber ?? '—',
      charge.note ?? '—',
      cents(charge.amountCents),
    ])
  const chargeColumns = { 1: { cellWidth: 70 }, 3: { cellWidth: 80, halign: 'right' as const } }

  room(60)
  autoTable(doc, {
    startY: y,
    head: [['Customer charge', 'Load', 'Note', 'Amount']],
    body: chargeRows(input.customerCharges),
    foot: [['REVENUE', '', '', cents(input.revenueCents)]],
    theme: 'striped',
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 8, halign: 'left' },
    footStyles: { fillColor: [243, 244, 246], textColor: [17, 24, 39], fontStyle: 'bold' },
    bodyStyles: { fontSize: 8, textColor: [31, 41, 55] },
    columnStyles: chargeColumns,
    margin: { top: 100, left: M, right: M },
    didDrawPage: () => drawHeader(doc, input),
    tableWidth: W - M * 2,
  })
  y = (doc as jsPDF & AutoTabled).lastAutoTable.finalY + 14

  room(60)
  autoTable(doc, {
    startY: y,
    head: [['Carrier charge', 'Load', 'Note', 'Amount']],
    body: chargeRows(input.carrierCharges),
    foot: [['COST', '', '', cents(input.costCents)]],
    theme: 'striped',
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 8, halign: 'left' },
    footStyles: { fillColor: [243, 244, 246], textColor: [17, 24, 39], fontStyle: 'bold' },
    bodyStyles: { fontSize: 8, textColor: [31, 41, 55] },
    columnStyles: chargeColumns,
    margin: { top: 100, left: M, right: M },
    didDrawPage: () => drawHeader(doc, input),
    tableWidth: W - M * 2,
  })
  y = (doc as jsPDF & AutoTabled).lastAutoTable.finalY + 16

  room(26)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(17, 24, 39)
  doc.text(
    `Profit ${cents(input.profitCents)}     Margin ${(input.marginBps / 100).toFixed(2)}%`,
    W - M, y, { align: 'right' },
  )
  y += 22

  // ── Who hauled it, including the attempts that failed ───────────────────────
  grid(
    ['Load', '#', 'Assignment', 'Status', 'Driver / equipment', 'Cost', 'Why it ended'],
    input.assignments.map((assignment) => [
      assignment.loadNumber,
      String(assignment.sequence),
      [assignment.carrierName ?? (assignment.kind === 'OWN_ASSET' ? 'Own asset' : '—'),
        assignment.carrierMc ? `MC ${assignment.carrierMc}` : ''].filter(Boolean).join('\n'),
      assignment.status,
      [assignment.driverName, assignment.truckNumber ? `Truck ${assignment.truckNumber}` : '',
        assignment.trailerNumber ? `Trailer ${assignment.trailerNumber}` : ''].filter(Boolean).join('\n') || '—',
      assignment.costCents != null ? cents(assignment.costCents) : '—',
      [assignment.removalReason, assignment.removalNote].filter(Boolean).join(' — ') || '—',
    ]),
    { 1: { cellWidth: 20 }, 3: { cellWidth: 52 }, 5: { cellWidth: 62 } },
  )

  // ── What is still open ──────────────────────────────────────────────────────
  if (input.incidents.length > 0) {
    grid(
      ['When', 'Load', 'Incident', 'Where', 'Note'],
      input.incidents.map((incident) => [
        stamp(incident.at),
        incident.loadNumber ?? '—',
        (incident.type ?? '—').replace(/_/g, ' '),
        [incident.city, incident.state].filter(Boolean).join(', ') || '—',
        incident.note ?? '—',
      ]),
      { 0: { cellWidth: 72 }, 1: { cellWidth: 64 }, 2: { cellWidth: 104 } },
    )
  }

  if (input.internalNotes) {
    const lines = doc.splitTextToSize(input.internalNotes, W - M * 2) as string[]
    room(26 + lines.length * 11)
    heading('INTERNAL NOTES')
    doc.setFontSize(9)
    doc.text(lines, M, y)
    y += lines.length * 11 + 10
  }

  // The marking goes on every page, not only the first: a printed page gets separated
  // from the stack it came in.
  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(156, 163, 175)
    doc.text(
      `Internal load summary — shipment ${input.shipmentNumber} — page ${page} of ${pages}`,
      M, H - 28,
    )
  }
  return doc
}
