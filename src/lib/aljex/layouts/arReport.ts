/**
 * AR_REPORT layout: the Aljex "AR aging by invoice" report (one row per open invoice, 44 columns).
 *
 * Decisions (STEP_AW_MERGE_READINESS, "Aljex AR report received"):
 *  - key = `Pro #` (= the invoice number; the PRO is the BCAT invoice number too);
 *  - the open amount of an invoice is the SUM OF ITS FIVE AGING BUCKETS (cross-check: Invoice Amount - Previous Payments);
 *  - `Balance Due`, `Total Exposure` and `Unbilled` repeat a CUSTOMER-level total on every row: they are never read here;
 *  - `Invoice Date` and `Due Date` are kept as Aljex has them (Danisco keeps its 90-day Aljex terms on carried-over rows);
 *  - the customer is identified by `Customer Account #`, the bill-to party by `Bill to Account #` (never by name);
 *  - `Previous Payments` is money already received (3 partially paid invoices);
 *  - contact columns (phone, fax, e-mail, contact), collector, dispatcher, sales rep and notes are not read.
 *
 * Pure: no I/O. Columns are found by normalised header text.
 */
import { parseAljexDate } from '../dates'
import { parseMoney } from '../money'
import { normalizePro } from '../../proNumber'
import {
  AP_AGING_BUCKETS as AR_BUCKETS,
  AP_AGING_BUCKET_LABEL as AR_BUCKET_LABEL,
  apAgingBucketOfDays as arBucketOfDays,
  LayoutHeaderError,
  cell,
  nameKey,
  optionalHeader,
  parseCsvRows,
  resolveHeaders,
  type ApAgingBucket as ArBucket,
  type LayoutFinding,
} from './apAging'

export { AR_BUCKETS, AR_BUCKET_LABEL, arBucketOfDays }
export type { ArBucket }

export const AR_REPORT_LAYOUT_ID = 'aljex-ar-report-v1'

const BUCKET_COLUMNS: Array<[ArBucket, string]> = [
  ['D0_30', '0 - 30 Days'],
  ['D31_60', '31 - 60 Days'],
  ['D61_90', '61 - 90 Days'],
  ['D91_120', '91 - 120 Days'],
  ['D121_PLUS', '120 Days or More'],
]

const REQUIRED = {
  pro: 'Pro #',
  invoiceDate: 'Invoice Date',
  dueDate: 'Due Date',
  billTo: 'Bill to',
  billToAccount: 'Bill to Account #',
  customer: 'Customer',
  customerAccount: 'Customer Account #',
  invoiceAmount: 'Invoice Amount',
  days: 'Days',
  previousPayments: 'Previous Payments',
} as const

export interface ArBillToAddress {
  street: string
  city: string
  state: string
  zip: string
}

export interface ArReportInvoice {
  rowNumber: number
  /** Normalised PRO (`normalizePro`) = the invoice key. */
  proKey: string
  /** The PRO as the file prints it = the invoice number. */
  pro: string
  invoiceDate: string
  /** Aljex's due date, kept as is. */
  dueDate: string
  /** Whole days as Aljex reports them (from the invoice date to the report date). */
  days: number
  /** Bucket by `days` (what the aging groups use). */
  bucket: ArBucket
  /** The amount in each aging column. */
  bucketCents: Record<ArBucket, number>
  /** SUM of the five aging buckets = the open amount. */
  openCents: number
  /** `Invoice Amount` column. */
  invoiceCents: number
  /** `Previous Payments` column (0 when blank). */
  previousPaidCents: number
  customerName: string
  customerAccount: string
  billToName: string
  billToAccount: string
  /** The bill-to party is not the customer (different account, or no accounts and different names). */
  billToDiffers: boolean
  /** The `Bill to` text is not the `Customer` text as printed (Aljex's own "62 invoices bill a different party" count; most are formatting only). */
  billToNameDiffers: boolean
  billToAddress: ArBillToAddress | null
  customerRef: string
  /** `Customer Terms` (days) as printed, null when blank. */
  customerTermsDays: number | null
  revenueType: string
}

export interface ArReportParse {
  layoutId: typeof AR_REPORT_LAYOUT_ID
  rows: number
  invoices: ArReportInvoice[]
  /** A repeated PRO keeps the first row; the rest are listed here. */
  duplicates: ArReportInvoice[]
  /** Rows that could not be read. */
  rejected: Array<{ rowNumber: number; reason: string }>
  /** Σ open amount (sum of the aging buckets). */
  totalCents: number
  byBucket: Record<ArBucket, number>
  /** Σ Invoice Amount, Σ Previous Payments, and how many invoices are partially paid. */
  invoiceTotalCents: number
  previousPaidCents: number
  partialCount: number
  billToDiffersCount: number
  /** Rows whose `Bill to` text differs from `Customer` as printed (the figure Ryne quotes: 62). `billToDiffersCount` compares accounts. */
  billToNameDiffersCount: number
  termsCounts: Record<string, number>
  revenueTypeCounts: Record<string, number>
  findings: LayoutFinding[]
}

const intOrNull = (s: string): number | null => {
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

export function parseArReport(rows: string[][]): ArReportParse {
  if (rows.length === 0) throw new LayoutHeaderError(AR_REPORT_LAYOUT_ID, 'MISSING_COLUMNS', Object.values(REQUIRED))
  const header = rows[0]
  const c = resolveHeaders(AR_REPORT_LAYOUT_ID, header, REQUIRED)
  const bucketAt = BUCKET_COLUMNS.map(([b, name]) => [b, optionalHeader(header, name)] as const)
  const missingBuckets = BUCKET_COLUMNS.filter((_, i) => bucketAt[i][1] < 0).map(([, name]) => name)
  if (missingBuckets.length) throw new LayoutHeaderError(AR_REPORT_LAYOUT_ID, 'MISSING_COLUMNS', missingBuckets)
  const at = {
    address: optionalHeader(header, 'Address'),
    address2: optionalHeader(header, 'Address 2'),
    city: optionalHeader(header, 'City'),
    state: optionalHeader(header, 'State'),
    zip: optionalHeader(header, 'Zip'),
    ref: optionalHeader(header, 'Customer Ref #'),
    terms: optionalHeader(header, 'Customer Terms'),
    revType: optionalHeader(header, 'Revenue Type'),
  }

  const out: ArReportParse = {
    layoutId: AR_REPORT_LAYOUT_ID,
    rows: rows.length - 1,
    invoices: [],
    duplicates: [],
    rejected: [],
    totalCents: 0,
    byBucket: { D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_PLUS: 0 },
    invoiceTotalCents: 0,
    previousPaidCents: 0,
    partialCount: 0,
    billToDiffersCount: 0,
    billToNameDiffersCount: 0,
    termsCounts: {},
    revenueTypeCounts: {},
    findings: [],
  }
  const seen = new Set<string>()
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const rowNumber = i + 1
    const pro = cell(r, c.pro)
    const proKey = normalizePro(pro)
    const reject = (reason: string): void => {
      out.rejected.push({ rowNumber, reason })
      out.findings.push({ code: 'AR_ROW_REJECTED', rowNumber, pro, detail: reason })
    }
    if (!proKey) {
      reject('PRO missing')
      continue
    }
    const invoiceDate = parseAljexDate(cell(r, c.invoiceDate)).date
    if (!invoiceDate) {
      reject('invoice date unreadable')
      continue
    }
    const invoiceAmount = parseMoney(cell(r, c.invoiceAmount)).cents
    if (invoiceAmount == null) {
      reject('invoice amount unreadable')
      continue
    }
    const previous = parseMoney(cell(r, c.previousPayments)).cents ?? 0
    const bucketCents: Record<ArBucket, number> = { D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_PLUS: 0 }
    let bad = false
    for (const [b, col] of bucketAt) {
      const raw = cell(r, col)
      if (raw === '') continue
      const m = parseMoney(raw)
      if (m.cents == null) bad = true
      else bucketCents[b] = m.cents
    }
    if (bad) {
      reject('aging bucket amount unreadable')
      continue
    }
    const openCents = AR_BUCKETS.reduce((n, b) => n + bucketCents[b], 0)
    if (openCents <= 0) {
      reject('no open amount in the aging buckets')
      continue
    }
    const customerAccount = cell(r, c.customerAccount)
    if (!customerAccount) out.findings.push({ code: 'AR_NO_CUSTOMER_ACCOUNT', rowNumber, pro })
    const customerName = cell(r, c.customer)
    const billToName = cell(r, c.billTo) || customerName
    const billToAccount = cell(r, c.billToAccount) || customerAccount
    const days = intOrNull(cell(r, c.days))
    const bucket = arBucketOfDays(days ?? 0)
    const rowBucket = AR_BUCKETS.filter((b) => bucketCents[b] !== 0)
    if (days == null) out.findings.push({ code: 'AR_DAYS_MISSING', rowNumber, pro })
    else if (rowBucket.length !== 1 || rowBucket[0] !== bucket) out.findings.push({ code: 'AR_BUCKET_DAYS_MISMATCH', rowNumber, pro, detail: `days=${days}` })
    if (invoiceAmount - previous !== openCents) out.findings.push({ code: 'AR_AMOUNT_MISMATCH', rowNumber, pro, detail: 'invoice amount minus previous payments differs from the aging buckets; the buckets win' })
    const dueParsed = parseAljexDate(cell(r, c.dueDate)).date
    const termsDays = intOrNull(cell(r, at.terms))
    let dueDate = dueParsed
    if (!dueDate) {
      // Aljex always prints a due date; a blank one falls back to invoice date + the customer's terms.
      const d = new Date(`${invoiceDate}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + (termsDays ?? 30))
      dueDate = d.toISOString().slice(0, 10)
      out.findings.push({ code: 'AR_DUE_DATE_DERIVED', rowNumber, pro })
    }
    const billToDiffers = customerAccount && billToAccount ? customerAccount !== billToAccount : nameKey(billToName) !== nameKey(customerName)
    const street = [cell(r, at.address), cell(r, at.address2)].filter(Boolean).join(', ')
    const addr: ArBillToAddress = { street, city: cell(r, at.city), state: cell(r, at.state), zip: cell(r, at.zip) }
    const inv: ArReportInvoice = {
      rowNumber,
      proKey,
      pro,
      invoiceDate,
      dueDate,
      days: days ?? 0,
      bucket,
      bucketCents,
      openCents,
      invoiceCents: invoiceAmount,
      previousPaidCents: previous,
      customerName,
      customerAccount,
      billToName,
      billToAccount,
      billToDiffers,
      billToNameDiffers: billToName !== customerName,
      billToAddress: addr.street || addr.city || addr.state || addr.zip ? addr : null,
      customerRef: cell(r, at.ref),
      customerTermsDays: termsDays,
      revenueType: cell(r, at.revType).toUpperCase(),
    }
    if (seen.has(proKey)) {
      out.duplicates.push(inv)
      out.findings.push({ code: 'AR_DUPLICATE_KEY', rowNumber, pro, detail: 'same PRO repeated, first row kept' })
      continue
    }
    seen.add(proKey)
    out.invoices.push(inv)
    out.totalCents += openCents
    for (const b of AR_BUCKETS) out.byBucket[b] += bucketCents[b]
    out.invoiceTotalCents += invoiceAmount
    out.previousPaidCents += previous
    if (previous > 0) out.partialCount += 1
    if (billToDiffers) out.billToDiffersCount += 1
    if (inv.billToNameDiffers) out.billToNameDiffersCount += 1
    const t = termsDays == null ? 'none' : String(termsDays)
    out.termsCounts[t] = (out.termsCounts[t] ?? 0) + 1
    const rt = inv.revenueType || 'none'
    out.revenueTypeCounts[rt] = (out.revenueTypeCounts[rt] ?? 0) + 1
  }
  return out
}

export const parseArReportCsv = (text: string): ArReportParse => parseArReport(parseCsvRows(text))
