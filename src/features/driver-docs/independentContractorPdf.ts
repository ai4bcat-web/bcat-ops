/**
 * Renders a completed "Statement of Independent Contractor Status — Wisconsin" to a PDF
 * (jsPDF). Used to store the signed form on the driver's compliance record and to hand a
 * blank/preview copy to the office. The typed name is the e-signature; a footer records
 * when and by whom it was captured.
 */
import jsPDF from 'jspdf'
import { IC_STATUS_STATEMENTS, IC_STATUS_TITLE, type ICStatusValues } from '@/lib/driverDocs'

function fmtDate(d?: string): string {
  if (!d) return '________________'
  const dt = new Date(`${d}T12:00:00`)
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function buildICStatusPdf(v: ICStatusValues, opts?: { capturedAt?: string }): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = doc.internal.pageSize.getWidth()
  const M = 54
  const contentW = W - M * 2
  let y = 56

  doc.setFont('helvetica', 'bold').setFontSize(13)
  doc.text(IC_STATUS_TITLE.toUpperCase(), W / 2, y, { align: 'center' })
  y += 22
  doc.setFont('helvetica', 'italic').setFontSize(9)
  doc.text('NOTE: Each paragraph is initialed if “yes”.', M, y)
  y += 18

  doc.setFontSize(9)
  IC_STATUS_STATEMENTS.forEach((s, i) => {
    const initial = v.initials[i] ? initialsOf(v.printName || v.signature) : ''
    const lines = doc.splitTextToSize(`${i + 1}. ${s}`, contentW - 46) as string[]
    const blockH = lines.length * 11 + 8
    if (y + blockH > 740) { doc.addPage(); y = 56 }
    doc.setFont('helvetica', 'bold').text(initial || '____', M, y)
    doc.setFont('helvetica', 'normal').text(lines, M + 40, y)
    y += blockH
  })

  y += 8
  if (y > 660) { doc.addPage(); y = 56 }
  doc.setDrawColor(150)
  // Contractor signature block
  const line = (label: string, value: string, yy: number) => {
    doc.setFont('helvetica', 'normal').setFontSize(10).text(value || '', M, yy - 2)
    doc.line(M, yy + 2, M + 280, yy + 2)
    doc.setFontSize(8).setTextColor(90).text(label, M, yy + 13); doc.setTextColor(0)
  }
  line('Print or Type Name of Sole Proprietor', v.printName, y); doc.setFontSize(10).text(`Dated: ${fmtDate(v.date)}`, M + 320, y - 2); y += 34
  doc.setFont('helvetica', 'italic').setFontSize(11).text(v.signature || '', M, y - 2); doc.setFont('helvetica', 'normal')
  doc.line(M, y + 2, M + 280, y + 2); doc.setFontSize(8).setTextColor(90).text('Signature of Sole Proprietor (typed e-signature)', M, y + 13); doc.setTextColor(0); y += 34
  line('Federal Employer Tax Identification #', v.ein, y); y += 40

  // Motor carrier acknowledgement
  doc.setFont('helvetica', 'bold').setFontSize(11).text('MOTOR CARRIER’S ACKNOWLEDGEMENT AND RECEIPT OF STATEMENT', M, y); y += 16
  doc.setFont('helvetica', 'normal').setFontSize(9)
  doc.text(doc.splitTextToSize('The above-named owner-operator has entered into a written contract with us and the terms of the contract and our relationship are accurately stated.', contentW) as string[], M, y); y += 30
  doc.setFontSize(10).text(v.carrierName || '', M, y); y += 22
  line('Print or Type Name', v.carrierBy, y); doc.setFontSize(10).text(`Date: ${fmtDate(v.carrierDate)}`, M + 320, y - 2); y += 34
  line('Signature / Title', v.carrierTitle, y); y += 30

  const cap = opts?.capturedAt ?? new Date().toISOString()
  doc.setFontSize(7).setTextColor(120)
  doc.text(`Electronically completed and signed via BCAT Ops · captured ${cap}`, M, 772)
  return doc
}

function initialsOf(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).map((p) => p[0]?.toUpperCase() ?? '').join('').slice(0, 4)
}

/** Convenience: the PDF as a File ready for uploadComplianceDocument. */
export function icStatusPdfFile(v: ICStatusValues, driverName: string): File {
  const blob = buildICStatusPdf(v).output('blob')
  const safe = driverName.trim().replace(/[^\w.\-]+/g, '_') || 'driver'
  return new File([blob], `IC-Status-WI-${safe}.pdf`, { type: 'application/pdf' })
}

/** Base64 (no data-URI prefix) of the rendered PDF — for POSTing to the signing endpoint. */
export function icStatusPdfBase64(v: ICStatusValues): string {
  const uri = buildICStatusPdf(v).output('datauristring')
  return uri.slice(uri.indexOf(',') + 1)
}
