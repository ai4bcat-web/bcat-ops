/**
 * Owner-operator settlement PDF — the same branded statement the Amazon page sends,
 * laid out for brokerage loads: PRO, customer, route, miles, freight, the driver's
 * share, and whether the load is on this check or held for its POD. Used for the PDF
 * button and the email attachment on the Owner Operator Settlements page.
 */
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { OwnerOperatorPayRow } from '@/hooks/useOwnerOperatorPay'
import { tripPayAmount, FACTORING_FEE_LABEL } from '@/lib/driverPay'
import { creditLineLabel } from '@/lib/payCredits'
import { ratePerMile } from '@/lib/ownerOperatorTrips'
import { PAY_HOLD_LABEL } from '@/lib/payHold'
import { weekLabelLong } from '@/features/driver-pay/week'
import { loadImage, COMPANY_NAME } from '@/lib/payPdf'
import ivanLogo from '@/assets/ivan-cartage-logo.png'
export { pdfToBase64 } from '@/lib/payPdf'

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const pct = (n: number) => `${Math.round(n * 100)}%`

export function ownerOperatorPdfFilename(row: Pick<OwnerOperatorPayRow, 'driver'>, periodStart: string): string {
  return `settlement-${row.driver.name.replace(/\s+/g, '-')}-${periodStart}.pdf`
}

/** The rows of the loads table, as printed. Exported so the figures can be pinned without rendering a PDF. */
export function ownerOperatorPdfRows(row: OwnerOperatorPayRow): string[][] {
  const held = new Map(row.heldTrips.map((h) => [h.trip.id, h.reason]))
  return row.trips.map((t) => {
    const pro = String(t.readiness?.payload.InvoiceNo ?? '').trim() || '—'
    const rpm = ratePerMile(t.freightAmount, t.miles)
    const reason = held.get(t.id)
    return [
      pro,
      t.customer || '—',
      [t.origin, t.destination].filter(Boolean).join('  ->  ') || '—',
      t.miles != null ? t.miles.toLocaleString() : '—',
      money(t.freightAmount),
      rpm != null ? `$${rpm.toFixed(2)}` : '—',
      reason ? `Held — ${PAY_HOLD_LABEL[reason]}` : 'On this check',
      money(reason ? 0 : tripPayAmount(t.freightAmount, row.setting)),
    ]
  })
}

export async function buildOwnerOperatorStatementPdf(row: OwnerOperatorPayRow, periodStart: string): Promise<jsPDF> {
  const { driver, setting, trips, statement, deductions } = row
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' })
  const W = doc.internal.pageSize.getWidth()
  const M = 40

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(0, 0, 0)
  doc.rect(0, 0, W, 70, 'F')
  let logoDrawn = false
  try {
    const img = await loadImage(ivanLogo)
    const h = 34
    const w = (img.width / img.height) * h
    doc.setFillColor(255, 255, 255)
    doc.roundedRect(M - 8, 13, w + 16, 44, 5, 5, 'F')
    doc.addImage(img, 'PNG', M, 18, w, h)
    logoDrawn = true
  } catch { /* wordmark below */ }
  if (!logoDrawn) {
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(20)
    doc.setCharSpace(1.5)
    doc.text(COMPANY_NAME, M, 44)
    doc.setCharSpace(0)
  }
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text('OWNER OPERATOR SETTLEMENT', W - M, 32, { align: 'right' })
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
  const driverEmail = setting.email || driver.email || ''
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(107, 114, 128)
  doc.text([driverEmail, setting.expensesBeforePercent ? `${pct(setting.payPercent)} of net (after expenses)` : `${pct(setting.payPercent)} of freight − expenses`].filter(Boolean).join('  ·  '), M, y + 16)

  const checkLabelWidth = doc.getStringUnitWidth('CHECK AMOUNT') * 9 / doc.internal.scaleFactor
  const checkAmountWidth = Math.max(checkLabelWidth, doc.getStringUnitWidth(money(statement.checkAmount)) * 22 / doc.internal.scaleFactor)
  const loadsX = W - M - checkAmountWidth - 28
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(107, 114, 128)
  doc.text('LOADS', loadsX, y - 2, { align: 'right' })
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(17, 24, 39)
  doc.text(String(trips.length), loadsX, y + 18, { align: 'right' })

  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(107, 114, 128)
  doc.text('CHECK AMOUNT', W - M, y - 2, { align: 'right' })
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(statement.checkAmount >= 0 ? 21 : 220, statement.checkAmount >= 0 ? 128 : 38, statement.checkAmount >= 0 ? 61 : 38)
  doc.text(money(statement.checkAmount), W - M, y + 18, { align: 'right' })

  // ── Loads table ─────────────────────────────────────────────────────────────
  const foot: Array<Array<string | { content: string; colSpan: number }>> = [
    [{ content: 'Freight total', colSpan: 7 }, money(statement.gross)],
    [{ content: `Driver share (${pct(setting.payPercent)})`, colSpan: 7 }, money(statement.driverAmount)],
  ]
  if (row.heldFreight > 0) foot.push([{ content: 'Held for POD — not on this check', colSpan: 7 }, money(row.heldFreight)])
  autoTable(doc, {
    startY: y + 40,
    head: [['PRO #', 'Customer', 'Route', 'Miles', 'Freight', 'Rate/mi', 'On this check', 'Amount']],
    body: ownerOperatorPdfRows(row),
    foot,
    theme: 'striped',
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 8.5, halign: 'right' },
    footStyles: { fillColor: [243, 244, 246], textColor: [17, 24, 39], fontStyle: 'bold', halign: 'right' },
    bodyStyles: { fontSize: 8.5, textColor: [31, 41, 55] },
    columnStyles: {
      0: { halign: 'left', font: 'courier' }, 1: { halign: 'left' }, 2: { halign: 'left' },
      3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' },
      6: { halign: 'left' }, 7: { halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: M, right: M },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 26

  const section = (title: string) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(107, 114, 128)
    doc.text(title, M, y); y += 14
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10)
  }
  const line = (label: string, value: string, color: [number, number, number]) => {
    doc.setTextColor(55, 65, 81); doc.text(label, M, y)
    doc.setTextColor(...color); doc.text(value, W - M, y, { align: 'right' }); y += 15
  }
  const red: [number, number, number] = [220, 38, 38]
  const green: [number, number, number] = [21, 128, 61]

  // ── Deductions ──────────────────────────────────────────────────────────────
  section('DEDUCTIONS')
  if (statement.factoringFeePct > 0) line(FACTORING_FEE_LABEL, `(${money(statement.factoringFee)})`, red)
  else if (deductions.length === 0) { doc.setTextColor(107, 114, 128); doc.text('No deductions.', M, y); y += 15 }
  for (const d of deductions) line(d.label, `(${money(d.amount)})`, red)

  if (row.credits.length) {
    y += 10; section('CREDITS')
    for (const c of row.credits) line(creditLineLabel(c), `+${money(c.amount)}`, green)
  }
  if (row.fixedDebits.length || row.debits.length) {
    y += 10; section('DEBITS (AFTER NET)')
    for (const d of row.fixedDebits) line(d.label, `(${money(d.amount)})`, red)
    for (const c of row.debits) line(creditLineLabel(c), `(${money(c.amount)})`, red)
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
  totalRow('Total deductions', `(${money(statement.totalDeductions)})`, false, red)
  if (setting.expensesBeforePercent) totalRow(`Subtotal × ${pct(setting.payPercent)}`, money(statement.subtotal))
  if (statement.totalCredits > 0) totalRow('Total credits', `+${money(statement.totalCredits)}`, false, green)
  if (statement.totalDebits > 0) totalRow('Debits (after net)', `(${money(statement.totalDebits)})`, false, red)
  totalRow('CHECK AMOUNT', money(statement.checkAmount), true, statement.checkAmount >= 0 ? green : red)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(156, 163, 175)
  doc.text('Ivan Cartage — owner operator settlement', M, doc.internal.pageSize.getHeight() - 28)
  return doc
}
