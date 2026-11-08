/**
 * Revenue differences on ENRICH (Ryne, Option 1 + refinement). A PRO already in BCAT whose Order.revenueCents differs
 * from the Aljex Invoice Amount is no longer a conflict: the INVOICE is written, Order.revenueCents / Load.rate / every
 * Load, Shipment, LoadFinancials and LoadCharge field stay BCAT's (ENRICH never writes them).
 *
 * Which amount the Invoice carries (the only decision here):
 *  - FULLY PAID  = the PRO is NOT in the open AR report (`--ar-file`, column `Pro #`; membership only, the file is read
 *    locally and never printed) AND the Aljex big export shows money received (Paid Amount 1..3, i.e. the AR_PAYMENT
 *    rows the importer creates; `money.paymentsReceivedCents` > 0). The Invoice then carries the amount ACTUALLY PAID
 *    (total = paid, balance 0, status PAID; short pay and overpay alike). The difference stays an internal finding
 *    (state PAID, basis PAID_AMOUNT) and is NOT on the review CSV.
 *  - OUTSTANDING = the PRO is in the open AR report (state OPEN, or PARTIAL when part of it was paid) -> the Invoice
 *    carries the Aljex invoice amount; the row IS on the review CSV.
 *  - PRO not in the AR report but nothing received, or the AR report was not supplied -> the safe fallback: the Aljex
 *    amount wins and the row stays on the review CSV. A missing file never drops a row from the review list.
 * The reconcile bridge records the paid-amount rows as the explained item `explained:PAID_AMOUNT_USED:invoiceTotal`.
 */
import type { EngineStore } from '../../../../src/types/tms'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import { csvLine } from './report'
import { readJson, stageKey } from './stage'
import type { Finding } from './types'

export const REVENUE_DIFFERS = 'ENRICH_REVENUE_DIFFERS'
export const PAID_AMOUNT_EXPLAINED_KEY = 'explained:PAID_AMOUNT_USED:invoiceTotal'

export interface RevenueDifference {
  pro: string
  /** Order.revenueCents (BCAT, unchanged). */
  bcatCents: number
  /** Aljex Invoice Amount. */
  aljexCents: number
  /** aljexCents - bcatCents. */
  diffCents: number
  /** Aljex Invoice Amount (= aljexCents), named for the PAID findings. */
  invoiceCents: number
  /** Money received per the Aljex export. */
  paidCents: number
  /** Open balance of the written invoice. */
  balanceCents: number
  dueDate: string
  state: 'OPEN' | 'PARTIAL' | 'PAID'
  basis: 'PAID_AMOUNT' | 'ALJEX_AMOUNT'
  customer: string
  billTo: string
}

export const arOpenKey = (root: string): string => stageKey(root, 'ar-open-pros.json')
export const planRevenueKey = (root: string): string => stageKey(root, 'plan-revenue-differences.json')

/** The open-AR PRO set stored next to the stage by the CLI; null = this run has no AR report. */
export async function readArOpen(store: EngineStore, root: string): Promise<ReadonlySet<string> | null> {
  try {
    return new Set(await readJson<string[]>(store, arOpenKey(root)))
  } catch {
    return null
  }
}

/** Fully paid per the rule in the file header. */
export function paidAmountApplies(row: CanonicalRow, arOpen: ReadonlySet<string> | null): boolean {
  return arOpen != null && !arOpen.has(row.proKey as string) && row.money.paymentsReceivedCents > 0
}

export function revenueDifferenceOf(f: Finding): RevenueDifference | null {
  if (f.code !== REVENUE_DIFFERS || !f.detail) return null
  try {
    return JSON.parse(f.detail) as RevenueDifference
  } catch {
    return null
  }
}

export const onReviewList = (d: RevenueDifference): boolean => d.basis !== 'PAID_AMOUNT'

export interface RevenueDifferenceSummary {
  total: number
  absCents: number
  netCents: number
  higher: number
  lower: number
  paid: { count: number; absCents: number; shortCount: number; shortCents: number; overCount: number; overCents: number }
  partial: { count: number; absCents: number }
  outstanding: { count: number; absCents: number }
  onReviewCsv: number
  open: number
  paidState: number
}

export function summarizeRevenueDifferences(list: readonly RevenueDifference[]): RevenueDifferenceSummary {
  const s: RevenueDifferenceSummary = {
    total: list.length,
    absCents: 0,
    netCents: 0,
    higher: 0,
    lower: 0,
    paid: { count: 0, absCents: 0, shortCount: 0, shortCents: 0, overCount: 0, overCents: 0 },
    partial: { count: 0, absCents: 0 },
    outstanding: { count: 0, absCents: 0 },
    onReviewCsv: 0,
    open: 0,
    paidState: 0,
  }
  for (const d of list) {
    s.absCents += Math.abs(d.diffCents)
    s.netCents += d.diffCents
    if (d.diffCents > 0) s.higher += 1
    else if (d.diffCents < 0) s.lower += 1
    if (d.state === 'PAID') s.paidState += 1
    else s.open += 1
    if (d.basis === 'PAID_AMOUNT') {
      const gap = d.paidCents - d.invoiceCents
      s.paid.count += 1
      s.paid.absCents += Math.abs(gap)
      if (gap < 0) {
        s.paid.shortCount += 1
        s.paid.shortCents += -gap
      } else if (gap > 0) {
        s.paid.overCount += 1
        s.paid.overCents += gap
      }
    } else {
      s.onReviewCsv += 1
      const bucket = d.state === 'PARTIAL' ? s.partial : s.outstanding
      bucket.count += 1
      bucket.absCents += Math.abs(d.diffCents)
    }
  }
  return s
}

/** The two lines the runner parses (plus the all-rows totals the earlier expectation used). */
export function summaryLines(s: RevenueDifferenceSummary, explainedCents: number | null): string[] {
  const p = s.paid
  return [
    `revenueDifferences: total ${s.total}, paid ${p.count} (absCents ${p.absCents}, shortCount ${p.shortCount}, shortCents ${p.shortCents}, overCount ${p.overCount}, overCents ${p.overCents}), partial ${s.partial.count} (absCents ${s.partial.absCents}), outstanding ${s.outstanding.count} (absCents ${s.outstanding.absCents}), onReviewCsv ${s.onReviewCsv}`,
    `revenueDifferencesAll: count ${s.total}, absCents ${s.absCents}, netCents ${s.netCents}, higher ${s.higher}, lower ${s.lower}, open ${s.open}, paid ${s.paidState}`,
    `paidAmountUsed: invoices ${p.count}, explainedCents ${explainedCents ?? 'n/a'}`,
  ]
}

const dollars = (cents: number): string => `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`

const ACTION: Record<string, string> = {
  OPEN: 'Outstanding in Aljex: confirm which amount is right with the customer; the invoice follows Aljex, BCAT revenue is unchanged',
  PARTIAL: 'Part paid in Aljex: confirm the amount, collect the open balance; the invoice follows Aljex, BCAT revenue is unchanged',
  PAID: 'Marked paid in Aljex but the open-AR report was not supplied or shows nothing received: confirm the amount; the invoice follows Aljex',
}

export const REVENUE_CSV_HEADER = ['PRO', 'BCAT value ($)', 'Aljex invoice ($)', 'difference ($)', 'Aljex higher/lower', 'open balance ($)', 'due date', 'invoice state', 'customer', 'bill-to', 'suggested action', 'Ryne note', 'Status']

/** The review CSV: rows still on the review list, absolute difference descending. PII (names): written outside the repo, mode 600. */
export function revenueDifferencesCsv(list: readonly RevenueDifference[]): { csv: string; rows: number } {
  const rows = list.filter(onReviewList).sort((a, b) => Math.abs(b.diffCents) - Math.abs(a.diffCents) || a.pro.localeCompare(b.pro))
  const lines = rows.map((d) => csvLine([d.pro, dollars(d.bcatCents), dollars(d.aljexCents), dollars(d.diffCents), d.diffCents > 0 ? 'Aljex higher' : d.diffCents < 0 ? 'Aljex lower' : 'same', dollars(d.balanceCents), d.dueDate, d.state, d.customer, d.billTo, ACTION[d.state], '', '']))
  return { csv: `${[csvLine(REVENUE_CSV_HEADER), ...lines].join('\n')}\n`, rows: rows.length }
}

/** Every ENRICH_REVENUE_DIFFERS detail of a findings list, one per PRO. */
export function collectRevenueDifferences(findings: readonly Finding[]): RevenueDifference[] {
  const byPro = new Map<string, RevenueDifference>()
  for (const f of findings) {
    const d = revenueDifferenceOf(f)
    if (d) byPro.set(d.pro, d)
  }
  return [...byPro.values()]
}
