/**
 * The customer's aging statement as a PDF: black and white, the division letterhead (BCAT
 * Logistics, or Ivan Cartage when every open invoice is an Ivan load), every open invoice aged
 * from its invoice date, and the bucket totals. Customer-facing: no cost, carrier pay or margin
 * is passed in, so none can be printed.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { BCAT_LOGO, IVAN_LOGO, LOGO_PT_PER_PX } from './invoiceLogos'
import { STATEMENT_BUCKETS, STATEMENT_BUCKET_LABEL, type AgingStatement } from './agingStatement'

const PAGE = { w: 612, h: 792 }
const M = 36
const INK = rgb(0, 0, 0)
const MUTED = rgb(0.35, 0.35, 0.35)
const ROW = 14

function ascii(text: string): string {
  return text.normalize('NFKD').replace(/[^\x20-\x7E]/g, '')
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`
}

function usDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}

function fit(font: PDFFont, text: string, size: number, maxW: number): string {
  let s = ascii(text)
  if (font.widthOfTextAtSize(s, size) <= maxW) return s
  while (s.length > 1 && font.widthOfTextAtSize(`${s}...`, size) > maxW) s = s.slice(0, -1)
  return `${s}...`
}

interface Col { label: string; x: number; w: number; right?: boolean }
const COLS: Col[] = [
  { label: 'Invoice #', x: M, w: 70 },
  { label: 'PRO #', x: M + 72, w: 58 },
  { label: 'PO #', x: M + 132, w: 92 },
  { label: 'Invoice date', x: M + 226, w: 62 },
  { label: 'Amount', x: M + 290, w: 66, right: true },
  { label: 'Paid', x: M + 358, w: 62, right: true },
  { label: 'Balance', x: M + 422, w: 66, right: true },
  { label: 'Days', x: M + 490, w: 30, right: true },
  { label: 'Aging', x: M + 524, w: 16 + 0 },
]

export async function buildAgingStatementPdf(statement: AgingStatement): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const ivan = statement.companyName === 'IVAN Cartage Co'
  const asset = ivan ? IVAN_LOGO : BCAT_LOGO
  const logo = await pdf.embedPng(asset.base64)

  let page: PDFPage = pdf.addPage([PAGE.w, PAGE.h])
  let y = 0
  const text = (s: string, x: number, size: number, font: PDFFont, color = INK) => page.drawText(ascii(s), { x, y: PAGE.h - y, size, font, color })
  const right = (s: string, rightX: number, size: number, font: PDFFont) => {
    const t = ascii(s)
    page.drawText(t, { x: rightX - font.widthOfTextAtSize(t, size), y: PAGE.h - y, size, font, color: INK })
  }
  const line = (yy: number) => page.drawLine({ start: { x: M, y: PAGE.h - yy }, end: { x: PAGE.w - M, y: PAGE.h - yy }, thickness: 0.6, color: INK })

  const header = () => {
    const w = asset.width * LOGO_PT_PER_PX * 0.8
    const h = asset.height * LOGO_PT_PER_PX * 0.8
    page.drawImage(logo, { x: M, y: PAGE.h - M - h, width: w, height: h })
    y = M + 14
    right('AGING STATEMENT', PAGE.w - M, 16, bold)
    y += 18
    right(`As of ${usDate(statement.asOf)}`, PAGE.w - M, 10, regular)
    y = M + h + 22
    text(statement.companyName.toUpperCase(), M, 9, bold)
    y += 12
    text('1193 E HIGGINS RD, ELK GROVE VILLAGE, IL 60007  ·  (847) 450-0899', M, 8, regular, MUTED)
    y += 22
    text('Customer', M, 8, regular, MUTED)
    y += 13
    text(statement.customerName, M, 12, bold)
    y += 22
    for (const c of COLS) (c.right ? right(c.label, c.x + c.w, 8, bold) : text(c.label, c.x, 8, bold))
    y += 5
    line(y)
    y += ROW
  }
  header()

  for (const row of statement.rows) {
    if (y > PAGE.h - 150) {
      page = pdf.addPage([PAGE.w, PAGE.h])
      header()
    }
    text(fit(regular, row.invoiceNumber, 8, COLS[0].w), COLS[0].x, 8, regular)
    text(fit(regular, row.pro, 8, COLS[1].w), COLS[1].x, 8, regular)
    text(fit(regular, row.po ?? '', 8, COLS[2].w), COLS[2].x, 8, regular)
    text(usDate(row.invoiceDate), COLS[3].x, 8, regular)
    right(money(row.totalCents), COLS[4].x + COLS[4].w, 8, regular)
    right(money(row.paidCents), COLS[5].x + COLS[5].w, 8, regular)
    right(money(row.balanceCents), COLS[6].x + COLS[6].w, 8, bold)
    right(String(row.days), COLS[7].x + COLS[7].w, 8, regular)
    text(STATEMENT_BUCKET_LABEL[row.bucket], COLS[8].x, 8, regular)
    y += ROW
  }
  if (statement.rows.length === 0) {
    text('No open invoices.', M, 9, regular, MUTED)
    y += ROW
  }

  y += 4
  line(y)
  y += 20
  const boxW = (PAGE.w - 2 * M) / (STATEMENT_BUCKETS.length + 1)
  STATEMENT_BUCKETS.forEach((b, i) => {
    const x = M + i * boxW
    page.drawText(`${STATEMENT_BUCKET_LABEL[b]} days`, { x, y: PAGE.h - y, size: 8, font: regular, color: MUTED })
    page.drawText(money(statement.byBucket[b]), { x, y: PAGE.h - y - 14, size: 11, font: bold, color: INK })
  })
  const tx = M + STATEMENT_BUCKETS.length * boxW
  page.drawText('Total due', { x: tx, y: PAGE.h - y, size: 8, font: regular, color: MUTED })
  page.drawText(money(statement.totalCents), { x: tx, y: PAGE.h - y - 14, size: 11, font: bold, color: INK })
  y += 44
  text('Please send remittance to billing@bcatcorp.com. Aging counts days since each invoice date.', M, 8, regular, MUTED)

  return pdf.save()
}
