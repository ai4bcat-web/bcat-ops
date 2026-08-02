/**
 * Box-truck driver-pay PDF statement (Ivan Cartage biweekly). Mirrors payPdf.ts but
 * with box-truck columns (PRO #, customer, gross profit) and the 14-day period label.
 */
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { BoxTruckPayRow } from '@/hooks/useBoxTruckPay'
import { tripPayAmount } from '@/lib/driverPay'
import { periodLabelLong } from '@/lib/biweekly'
import ivanLogo from '@/assets/ivan-cartage-logo.png'

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const pct = (n: number) => `${Math.round(n * 100)}%`

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

export function boxTruckPdfFilename(row: BoxTruckPayRow, periodStart: string): string {
  return `pay-${row.driver.name.replace(/\s+/g, '-')}-${periodStart}.pdf`
}

export { pdfToBase64 } from '@/lib/payPdf'

export async function buildBoxTruckPayStatementPdf(row: BoxTruckPayRow, periodStart: string): Promise<jsPDF> {
  const { driver, setting, trips, statement, deductions } = row
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = doc.internal.pageSize.getWidth()
  const M = 40

  // Header band — Ivan Cartage logo on a white chip (the logo art has black
  // elements), falling back to a text wordmark if the image can't load.
  doc.setFillColor(0, 0, 0)
  doc.rect(0, 0, W, 64, 'F')
  let logoDrawn = false
  try {
    const img = await loadImage(ivanLogo)
    const h = 30
    const w = (img.width / img.height) * h
    doc.setFillColor(255, 255, 255)
    doc.roundedRect(M - 8, 12, w + 16, 40, 5, 5, 'F')
    doc.addImage(img, 'PNG', M, 17, w, h)
    logoDrawn = true
  } catch { /* logo optional — wordmark fallback below */ }
  if (!logoDrawn) {
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18)
    doc.text('IVAN CARTAGE', M, 38)
  }
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10)
  doc.text('Box-Truck Pay Statement', W - M, 38, { align: 'right' })

  // Driver + period
  doc.setTextColor(11, 13, 18)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14)
  doc.text(driver.name, M, 92)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(90, 90, 90)
  doc.text(`${periodLabelLong(periodStart)}  ·  ${pct(setting.payPercent)} of net after expenses`, M, 108)

  // Shipments table
  const fmtDate = (d?: string | null) => (d ? d.slice(5, 10) : '—')
  autoTable(doc, {
    startY: 122,
    head: [['Date', 'Aljex PRO #', 'PU / TMS #', 'Customer', 'Status', 'Gross Profit', 'Driver Amt']],
    body: trips.map((t) => [
      fmtDate(t.date), t.aljexPro ?? '—', t.proNumber ?? '—', t.customer ?? '—', t.status ?? '—',
      money(t.grossProfit), money(tripPayAmount(t.grossProfit, setting)),
    ]),
    foot: [['', '', '', '', 'Gross', money(statement.gross), money(statement.driverAmount)]],
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: [17, 24, 39], textColor: 255 },
    footStyles: { fillColor: [243, 244, 246], textColor: [11, 13, 18], fontStyle: 'bold' },
    columnStyles: { 5: { halign: 'right' }, 6: { halign: 'right' } },
    margin: { left: M, right: M },
  })

  // Deductions + check
  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(11, 13, 18)
  doc.text('Deductions', M, y); y += 6
  autoTable(doc, {
    startY: y,
    body: [
      ...deductions.map((d) => [d.label, `(${money(d.amount)})`]),
      ['Total deductions', `(${money(statement.totalDeductions)})`],
    ],
    styles: { fontSize: 9.5, cellPadding: 4 },
    columnStyles: { 1: { halign: 'right', textColor: [220, 38, 38] } },
    margin: { left: M, right: M },
    theme: 'plain',
  })

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 16
  doc.setFillColor(243, 244, 246); doc.roundedRect(M, y, W - M * 2, 40, 6, 6, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(11, 13, 18)
  doc.text('CHECK AMOUNT', M + 14, y + 25)
  doc.setTextColor(21, 128, 61)
  doc.text(money(statement.checkAmount), W - M - 14, y + 25, { align: 'right' })

  return doc
}
