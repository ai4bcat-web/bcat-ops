/**
 * AP_EXPECTED layout: loads whose carrier cost is expected but not yet billed (Aljex "AP expected").
 *
 * Decisions (Ryne round 3): rows are NOT payables. They become one report line ("expected") and, on a matching
 * shipment, `LoadCarrier.apStatus = AWAITING_INVOICE`. The stale rows (ship date older than 12 months before the
 * cutoff: the 2024/2025 rows) are dropped entirely and only counted ("dropped stale"). A PRO repeated across vendor-name
 * variants keeps one row; the repeats are reported in `duplicates`.
 *
 * Pure: no I/O.
 */
import { addMonths, parseAljexDate } from '../dates'
import { parseMoney } from '../money'
import { normalizePro } from '../../proNumber'
import { cell, LayoutHeaderError, optionalHeader, parseCsvRows, resolveHeaders, type LayoutFinding } from './apAging'

export const AP_EXPECTED_LAYOUT_ID = 'aljex-ap-expected-v1'

/** The Aljex cutoff the layouts default to (Chicago midnight of this date; `TmsSettings.aljexCutoffAt` overrides it). */
export const DEFAULT_ALJEX_CUTOFF = '2026-11-07'
/** An expected row shipped more than this many months before the cutoff is stale. */
export const AP_EXPECTED_STALE_MONTHS = 12

export interface ApExpectedLine {
  rowNumber: number
  proKey: string
  pro: string
  vendorName: string
  payToName: string
  amountCents: number
  shipDate: string | null
  deliveredDate: string | null
  customerName: string
  /** Aljex Carrier ID (blank on 3 rows of the 2026-11-08 file). */
  carrierId: string
  mc: string
  dot: string
}

export interface ApExpectedParse {
  layoutId: typeof AP_EXPECTED_LAYOUT_ID
  rows: number
  /** Rows imported as the `expected` line. */
  expected: ApExpectedLine[]
  expectedCents: number
  /** Dropped entirely (ship date < staleBefore): counted, never listed or carried. */
  droppedStaleCount: number
  droppedStaleCents: number
  /** Repeated PRO among the non-stale rows: the first kept, the rest listed for review. */
  duplicates: ApExpectedLine[]
  rejected: Array<{ rowNumber: number; reason: string }>
  staleBefore: string
  findings: LayoutFinding[]
}

const REQUIRED = { vendor: 'Vendor', pro: 'Pro #', amount: 'Amount', shipDate: 'Ship Date' } as const

export function parseApExpected(rows: string[][], opts: { cutoff?: string } = {}): ApExpectedParse {
  if (rows.length === 0) throw new LayoutHeaderError(AP_EXPECTED_LAYOUT_ID, 'MISSING_COLUMNS', Object.values(REQUIRED))
  const header = rows[0]
  const c = resolveHeaders(AP_EXPECTED_LAYOUT_ID, header, REQUIRED)
  const at = (name: string) => optionalHeader(header, name)
  const payTo = at('Pay to')
  const delivered = at('Delivered Date')
  const customer = at('Customer')
  const carrierId = at('Carrier ID')
  const mc = at('MC #')
  const dot = at('DOT #')
  const staleBefore = addMonths(opts.cutoff ?? DEFAULT_ALJEX_CUTOFF, -AP_EXPECTED_STALE_MONTHS)

  const out: ApExpectedParse = {
    layoutId: AP_EXPECTED_LAYOUT_ID,
    rows: rows.length - 1,
    expected: [],
    expectedCents: 0,
    droppedStaleCount: 0,
    droppedStaleCents: 0,
    duplicates: [],
    rejected: [],
    staleBefore,
    findings: [],
  }
  const seen = new Set<string>()
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const rowNumber = i + 1
    const pro = cell(r, c.pro)
    const proKey = normalizePro(pro)
    const amount = parseMoney(cell(r, c.amount))
    const ship = parseAljexDate(cell(r, c.shipDate)).date
    if (!proKey || amount.cents == null) {
      const reason = !proKey ? 'PRO missing' : 'amount unreadable'
      out.rejected.push({ rowNumber, reason })
      out.findings.push({ code: 'AP_EXPECTED_ROW_REJECTED', rowNumber, pro, detail: reason })
      continue
    }
    if (ship && ship < staleBefore) {
      out.droppedStaleCount += 1
      out.droppedStaleCents += amount.cents
      continue
    }
    const line: ApExpectedLine = {
      rowNumber,
      proKey,
      pro,
      vendorName: cell(r, c.vendor),
      payToName: cell(r, payTo) || cell(r, c.vendor),
      amountCents: amount.cents,
      shipDate: ship,
      deliveredDate: parseAljexDate(cell(r, delivered)).date,
      customerName: cell(r, customer),
      carrierId: cell(r, carrierId),
      mc: cell(r, mc),
      dot: cell(r, dot),
    }
    if (seen.has(proKey)) {
      out.duplicates.push(line)
      out.findings.push({ code: 'AP_EXPECTED_DUPLICATE_PRO', rowNumber, pro, detail: 'PRO repeated, first row kept' })
      continue
    }
    seen.add(proKey)
    if (!line.carrierId) out.findings.push({ code: 'AP_EXPECTED_NO_CARRIER_ID', rowNumber, pro })
    out.expected.push(line)
    out.expectedCents += line.amountCents
  }
  return out
}

export const parseApExpectedCsv = (text: string, opts: { cutoff?: string } = {}): ApExpectedParse => parseApExpected(parseCsvRows(text), opts)

