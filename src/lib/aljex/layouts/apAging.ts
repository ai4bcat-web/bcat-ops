/**
 * AP_AGING layout: the Aljex "AP aging" report (one row per open carrier bill).
 *
 * Decisions (STEP_AW_MERGE_READINESS, Ryne round 3):
 *  - key = Pro # + Vendor ID (Vendor ID is the Aljex Carrier ID); BCAT bill number = `<PRO>-<vendor>`;
 *  - `Vend Invoice #` is kept as a reference only (`aljexVendorInvoiceRef`), never as the bill number;
 *  - `Amount Paid` IS the bill amount (the bills are unpaid): it is read as the open balance, never as a payment;
 *  - Check/Draft: C = check, D = direct deposit (the cell can carry a prefix letter, the LAST letter is the code);
 *  - Pay to differs from Vendor -> the bill is payable to the pay-to (the carrier's remit-to / factor).
 *
 * Pure: no I/O. The file has unique header names, so columns are found by normalised header text. This module
 * also owns the small CSV helpers the other two AP/active layouts share.
 */
import { createCsvParser } from '../csv'
import { parseAljexDate } from '../dates'
import { formatCents, parseMoney } from '../money'
import { normalizeHeader } from '../layout'
import { normalizePro } from '../../proNumber'

export const AP_AGING_LAYOUT_ID = 'aljex-ap-aging-v1'

/** Columns that must never reach a stage or a report from any Aljex file (counts of rows only, elsewhere). */
const SENSITIVE_HEADER_KEYS = new Set(['fed ss no', 'bank account', 'routing no', 'web password'])

export class LayoutHeaderError extends Error {
  readonly code: 'MISSING_COLUMNS' | 'SENSITIVE_COLUMNS'
  readonly columns: string[]
  constructor(layoutId: string, code: 'MISSING_COLUMNS' | 'SENSITIVE_COLUMNS', columns: string[]) {
    super(code === 'MISSING_COLUMNS' ? `${layoutId}: missing columns ${columns.join(', ')}` : `${layoutId}: refusing a file that still carries sensitive columns (${columns.join(', ')})`)
    this.code = code
    this.columns = columns
  }
}

/** Parse a whole CSV text into rows (header row first). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  const parser = createCsvParser((r) => rows.push(r))
  parser.write(text)
  parser.end()
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Resolve required headers to indexes; refuses sensitive headers and missing required ones. */
export function resolveHeaders<K extends string>(layoutId: string, header: string[], required: Record<K, string>): Record<K, number> {
  const norm = header.map(normalizeHeader)
  const sensitive = header.filter((_, i) => SENSITIVE_HEADER_KEYS.has(norm[i]))
  if (sensitive.length) throw new LayoutHeaderError(layoutId, 'SENSITIVE_COLUMNS', sensitive)
  const out = {} as Record<K, number>
  const missing: string[] = []
  for (const key of Object.keys(required) as K[]) {
    const at = norm.indexOf(normalizeHeader(required[key]))
    if (at < 0) missing.push(required[key])
    else out[key] = at
  }
  if (missing.length) throw new LayoutHeaderError(layoutId, 'MISSING_COLUMNS', missing)
  return out
}

/** Optional header lookup (-1 when absent). */
export function optionalHeader(header: string[], name: string): number {
  return header.map(normalizeHeader).indexOf(normalizeHeader(name))
}

export const cell = (row: string[], at: number): string => (at >= 0 ? (row[at] ?? '').trim() : '')

/** Lenient name key for comparing party names across files (case, punctuation, spacing, a trailing INC/LLC). */
export function nameKey(name: string | null | undefined): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface LayoutFinding {
  code: string
  rowNumber?: number
  pro?: string
  /** Non-PII detail only (column names, ids, counts). */
  detail?: string
}

export type ApAgingBucket = 'D0_30' | 'D31_60' | 'D61_90' | 'D91_120' | 'D121_PLUS'
export const AP_AGING_BUCKETS: readonly ApAgingBucket[] = ['D0_30', 'D31_60', 'D61_90', 'D91_120', 'D121_PLUS']
export const AP_AGING_BUCKET_LABEL: Record<ApAgingBucket, string> = {
  D0_30: '0-30',
  D31_60: '31-60',
  D61_90: '61-90',
  D91_120: '91-120',
  D121_PLUS: '120+',
}
const BUCKET_COLUMNS: Array<[ApAgingBucket, string]> = [
  ['D0_30', '0 - 30 Days'],
  ['D31_60', '31 - 60 Days'],
  ['D61_90', '61 - 90 Days'],
  ['D91_120', '91 - 120 Days'],
  ['D121_PLUS', '120 Days or More'],
]

/** Aljex's own bucketing: whole days from the aging date to the report date (the file's `Days` column). */
export function apAgingBucketOfDays(days: number): ApAgingBucket {
  if (days <= 30) return 'D0_30'
  if (days <= 60) return 'D31_60'
  if (days <= 90) return 'D61_90'
  if (days <= 120) return 'D91_120'
  return 'D121_PLUS'
}

export type AljexPayMethod = 'CHECK' | 'DIRECT_DEPOSIT'

/** Check/Draft cell -> pay method. The Aljex cell may carry a leading hold flag, the final letter is the code. */
export function parsePayMethod(value: string | null | undefined): AljexPayMethod | null {
  const code = String(value ?? '').trim().toUpperCase().slice(-1)
  if (code === 'C') return 'CHECK'
  if (code === 'D') return 'DIRECT_DEPOSIT'
  return null
}

/** The bill number BCAT uses for an Aljex AP bill. */
export function apBillNumber(proKey: string, vendorId: string): string {
  return `${proKey}-${vendorId}`
}

export interface ApAgingBill {
  rowNumber: number
  /** Normalised PRO (`normalizePro`). */
  proKey: string
  pro: string
  vendorId: string
  vendorName: string
  payToName: string
  /** Pay to is a different party than the vendor (factored carrier). */
  payToDiffers: boolean
  billNumber: string
  /** `Vend Invoice #`: reference only. */
  vendorInvoiceRef: string
  vendorInvoiceDate: string | null
  /** `Aging Date` (the bill date in BCAT). */
  agingDate: string
  dueDate: string
  /** Whole days as Aljex reports them. */
  days: number
  bucket: ApAgingBucket
  /** `Amount Paid` column: the bill amount, open balance. */
  amountCents: number
  payMethod: AljexPayMethod | null
  customerName: string
  customerAccount: string
  holds: string[]
  note: string
}

export interface ApAgingParse {
  layoutId: typeof AP_AGING_LAYOUT_ID
  rows: number
  bills: ApAgingBill[]
  /** Rows skipped: a repeated (PRO, vendor) key keeps the first, the rest are listed. */
  duplicates: ApAgingBill[]
  /** Rows that could not be read (no PRO, no vendor, bad amount/date). */
  rejected: Array<{ rowNumber: number; reason: string }>
  totalCents: number
  byBucket: Record<ApAgingBucket, number>
  payMethodCounts: Record<AljexPayMethod | 'UNKNOWN', number>
  payToDiffersCount: number
  findings: LayoutFinding[]
}

const REQUIRED = {
  vendor: 'Vendor',
  payTo: 'Pay to',
  pro: 'Pro #',
  agingDate: 'Aging Date',
  dueDate: 'Due Date',
  vendorInvoice: 'Vend Invoice #',
  days: 'Days',
  amount: 'Amount Paid',
  vendorId: 'Vendor ID',
  checkDraft: 'Check/Draft',
} as const

const holdFlag = (v: string): boolean => /^(y|yes|true|x|1)$/i.test(v.trim())

export function parseApAging(rows: string[][]): ApAgingParse {
  if (rows.length === 0) throw new LayoutHeaderError(AP_AGING_LAYOUT_ID, 'MISSING_COLUMNS', Object.values(REQUIRED))
  const header = rows[0]
  const c = resolveHeaders(AP_AGING_LAYOUT_ID, header, REQUIRED)
  const invDate = optionalHeader(header, 'Vend Invoice Date')
  const customer = optionalHeader(header, 'Customer')
  const customerAcct = optionalHeader(header, 'Customer Account #')
  const bucketAt = BUCKET_COLUMNS.map(([b, name]) => [b, optionalHeader(header, name)] as const)
  const holdAt = [['PJ_HOLD', optionalHeader(header, 'PJ Hold')], ['SUPER_HOLD', optionalHeader(header, 'Super Hold')], ['PENDING_CLAIM', optionalHeader(header, 'Peding Claim')]] as const
  const noteAt = optionalHeader(header, 'Latest AP Note')

  const out: ApAgingParse = {
    layoutId: AP_AGING_LAYOUT_ID,
    rows: rows.length - 1,
    bills: [],
    duplicates: [],
    rejected: [],
    totalCents: 0,
    byBucket: { D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_PLUS: 0 },
    payMethodCounts: { CHECK: 0, DIRECT_DEPOSIT: 0, UNKNOWN: 0 },
    payToDiffersCount: 0,
    findings: [],
  }
  const seen = new Set<string>()
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const rowNumber = i + 1
    const pro = cell(r, c.pro)
    const proKey = normalizePro(pro)
    const vendorId = cell(r, c.vendorId)
    const reject = (reason: string): void => {
      out.rejected.push({ rowNumber, reason })
      out.findings.push({ code: 'AP_ROW_REJECTED', rowNumber, pro, detail: reason })
    }
    if (!proKey) {
      reject('PRO missing')
      continue
    }
    if (!vendorId) {
      reject('Vendor ID missing')
      continue
    }
    const amount = parseMoney(cell(r, c.amount))
    if (amount.cents == null || amount.cents <= 0) {
      reject('amount missing or not positive')
      continue
    }
    const aging = parseAljexDate(cell(r, c.agingDate))
    const due = parseAljexDate(cell(r, c.dueDate))
    if (!aging.date || !due.date) {
      reject('aging/due date unreadable')
      continue
    }
    const days = Number.parseInt(cell(r, c.days), 10)
    const filled = bucketAt.filter(([, at]) => at >= 0 && cell(r, at) !== '')
    const bucket = Number.isFinite(days) ? apAgingBucketOfDays(days) : (filled[0]?.[0] ?? 'D0_30')
    if (filled.length !== 1 || filled[0][0] !== bucket) out.findings.push({ code: 'AP_BUCKET_COLUMN_MISMATCH', rowNumber, pro, detail: `days=${cell(r, c.days)}` })
    else if (parseMoney(cell(r, filled[0][1])).cents !== amount.cents) out.findings.push({ code: 'AP_BUCKET_AMOUNT_MISMATCH', rowNumber, pro })

    const vendorName = cell(r, c.vendor)
    const payToName = cell(r, c.payTo) || vendorName
    const method = parsePayMethod(cell(r, c.checkDraft))
    const holds = holdAt.filter(([, at]) => at >= 0 && holdFlag(cell(r, at))).map(([k]) => k)
    const bill: ApAgingBill = {
      rowNumber,
      proKey,
      pro,
      vendorId,
      vendorName,
      payToName,
      payToDiffers: nameKey(payToName) !== nameKey(vendorName),
      billNumber: apBillNumber(proKey, vendorId),
      vendorInvoiceRef: cell(r, c.vendorInvoice),
      vendorInvoiceDate: parseAljexDate(cell(r, invDate)).date,
      agingDate: aging.date,
      dueDate: due.date,
      days: Number.isFinite(days) ? days : 0,
      bucket,
      amountCents: amount.cents,
      payMethod: method,
      customerName: cell(r, customer),
      customerAccount: cell(r, customerAcct),
      holds,
      note: cell(r, noteAt),
    }
    if (seen.has(bill.billNumber)) {
      out.duplicates.push(bill)
      out.findings.push({ code: 'AP_DUPLICATE_KEY', rowNumber, pro, detail: 'same PRO + vendor repeated, first row kept' })
      continue
    }
    seen.add(bill.billNumber)
    if (!method) out.findings.push({ code: 'AP_PAY_METHOD_UNKNOWN', rowNumber, pro })
    if (holds.length) out.findings.push({ code: 'AP_HOLD', rowNumber, pro, detail: holds.join(',') })
    out.bills.push(bill)
    out.totalCents += bill.amountCents
    out.byBucket[bucket] += bill.amountCents
    out.payMethodCounts[method ?? 'UNKNOWN'] += 1
    if (bill.payToDiffers) out.payToDiffersCount += 1
  }
  return out
}

export const parseApAgingCsv = (text: string): ApAgingParse => parseApAging(parseCsvRows(text))

export const centsText = (cents: number): string => formatCents(cents).replace(/,/g, '')
