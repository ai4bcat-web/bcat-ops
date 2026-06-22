/**
 * Driver-pay PDF statement — branded weekly statement for one driver.
 *
 * Renders the BCAT logo on a black header band (the logo artwork is light, so it
 * reads on black, matching the app), then the trips table, deductions and the
 * check amount. Used for the "Download PDF" button and as the email attachment.
 */
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { DriverPayRow } from '@/hooks/useAmazonPay'
import { tripPayAmount } from '@/lib/driverPay'
import { weekLabelLong } from '@/features/driver-pay/week'
import bcatLogo from '@/assets/bcat-logo.png'

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

export function payPdfFilename(row: DriverPayRow, periodStart: string): string {
  return `pay-${row.driver.name.replace(/\s+/g, '-')}-${periodStart}.pdf`
}

/** Build the branded statement. Returns the jsPDF doc (call .save() or .output()). */
export async function buildPayStatementPdf(row: DriverPayRow, periodStart: string): Promise<jsPDF> {
  const { driver, setting, trips, statement, deductions } = row
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = doc.internal.pageSize.getWidth()
  const M = 40

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(0, 0, 0)
  doc.rect(0, 0, W, 70, 'F')
  try {
    const img = await loadImage(bcatLogo)
    const h = 34
    const w = (img.width / img.height) * h
    doc.addImage(img, 'PNG', M, 18, w, h)
  } catch { /* logo optional — header still renders */ }
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text('DRIVER PAY STATEMENT', W - M, 32, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(190, 200, 215)
  doc.text(weekLabelLong(periodStart), W - M, 48, { align: 'right' })

  // ── Driver + check amount ───────────────────────────────────────────────────
  let y = 104
  doc.setTextColor(17, 24, 39)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(17)
  doc.text(driver.name, M, y)
  const modeLabel = setting.expensesBeforePercent ? `${pct(setting.payPercent)} after expenses` : `${pct(setting.payPercent)} of gross − expenses`
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(107, 114, 128)
  doc.text(modeLabel + (setting.email ? `  ·  ${setting.email}` : ''), M, y + 16)

  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text('CHECK AMOUNT', W - M, y - 2, { align: 'right' })
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(statement.checkAmount >= 0 ? 21 : 220, statement.checkAmount >= 0 ? 128 : 38, statement.checkAmount >= 0 ? 61 : 38)
  doc.text(money(statement.checkAmount), W - M, y + 18, { align: 'right' })

  // ── Trips table ─────────────────────────────────────────────────────────────
  autoTable(doc, {
    startY: y + 40,
    head: [['Load', 'Route', 'Miles', 'Freight', 'Rate/mi', 'Status', 'Amount']],
    body: trips.map((t) => [
      t.loadId || '—',
      [t.origin, t.destination].filter(Boolean).join(' → ') || '—',
      t.miles != null ? t.miles.toLocaleString() : '—',
      money(t.freightAmount),
      t.ratePerMile != null ? `$${t.ratePerMile.toFixed(2)}` : '—',
      t.status || '—',
      money(tripPayAmount(t.freightAmount, setting)),
    ]),
    foot: [[
      { content: `Gross / driver share (${pct(setting.payPercent)})`, colSpan: 3 },
      { content: money(statement.gross), colSpan: 3 },
      money(statement.driverAmount),
    ]],
    theme: 'striped',
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 8.5, halign: 'right' },
    footStyles: { fillColor: [243, 244, 246], textColor: [17, 24, 39], fontStyle: 'bold', halign: 'right' },
    bodyStyles: { fontSize: 8.5, textColor: [31, 41, 55] },
    columnStyles: {
      0: { halign: 'left', font: 'courier' }, 1: { halign: 'left' },
      2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' },
      5: { halign: 'left' }, 6: { halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: M, right: M },
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 26

  // ── Deductions ──────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text('DEDUCTIONS', M, y)
  y += 14
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  if (deductions.length === 0) {
    doc.setTextColor(107, 114, 128)
    doc.text('No deductions.', M, y)
    y += 14
  } else {
    for (const d of deductions) {
      doc.setTextColor(55, 65, 81)
      doc.text(d.label, M, y)
      doc.setTextColor(220, 38, 38)
      doc.text(`(${money(d.amount)})`, W - M, y, { align: 'right' })
      y += 15
    }
  }

  // ── Totals ──────────────────────────────────────────────────────────────────
  y += 8
  doc.setDrawColor(229, 231, 235)
  doc.line(M, y, W - M, y)
  y += 18
  const totalRow = (label: string, value: string, strong = false, color: [number, number, number] = [17, 24, 39]) => {
    doc.setFont('helvetica', strong ? 'bold' : 'normal')
    doc.setFontSize(strong ? 13 : 10)
    doc.setTextColor(107, 114, 128)
    doc.text(label, W - M - 150, y, { align: 'right' })
    doc.setTextColor(...color)
    doc.text(value, W - M, y, { align: 'right' })
    y += strong ? 22 : 16
  }
  totalRow('Total deductions', `(${money(statement.totalDeductions)})`, false, [220, 38, 38])
  if (setting.expensesBeforePercent) totalRow(`Subtotal × ${pct(setting.payPercent)}`, money(statement.subtotal))
  totalRow('CHECK AMOUNT', money(statement.checkAmount), true, statement.checkAmount >= 0 ? [21, 128, 61] : [220, 38, 38])

  // ── Footer ──────────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(156, 163, 175)
  doc.text('BCAT Logistics — Operations Command Center', M, doc.internal.pageSize.getHeight() - 28)

  return doc
}

/** Base64 (no data-URI prefix) of a built doc — for emailing as an attachment. */
export function pdfToBase64(doc: jsPDF): string {
  return doc.output('datauristring').split('base64,')[1] ?? ''
}
