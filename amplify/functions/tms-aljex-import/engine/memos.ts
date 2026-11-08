/**
 * CRED/DEBT memo rows are adjustment lines on the invoice of the load whose PRO is their Reference #
 * (DECIDED-1). This module resolves them once at STAGE (against the invoices the load phase will really
 * write) and does the invoice arithmetic every writer shares, so the Invoice row, the AR ledger and the
 * reconciliation can never disagree.
 */
import type { EngineRow } from '../../../../src/types/tms'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import type { DateWindow } from '../../../../src/lib/aljex/dates'
import type { AljexProfile } from '../../../../src/lib/aljex/profile'
import { resolveMemos, type MemoAdjustment, type MemoOrphan } from '../../../../src/lib/aljex/memos'
import { rowFacts } from './facts'
import type { StagedMemos } from './types'
import { stableId } from './util'

/**
 * Resolve the memos of a file. A reference only counts when the load really gets an invoice: an
 * invoiced load that is void or has no customer writes none, so its memos are orphans too.
 */
export function resolveStagedMemos(rows: readonly CanonicalRow[], profile: AljexProfile, window: DateWindow): StagedMemos {
  const writes = new Set<string>()
  for (const r of rows) if (r.kind === 'LOAD' && r.proKey && r.customer.account !== '' && rowFacts(r, profile, window).invoice) writes.add(r.proKey)
  const base = resolveMemos(rows)
  const byInvoice: Record<string, MemoAdjustment[]> = {}
  const orphans: MemoOrphan[] = [...base.orphans]
  let appliedCents = 0
  let orphanCents = base.orphanCents
  for (const [key, list] of base.byInvoice) {
    if (writes.has(key)) {
      byInvoice[key] = list
      appliedCents += list.reduce((n, m) => n + m.signedAmountCents, 0)
      continue
    }
    for (const m of list) {
      orphans.push({ memoPro: m.memoPro, kind: m.kind, referencePro: key, signedAmountCents: m.signedAmountCents, reason: 'REFERENCE_NOT_INVOICED' })
      orphanCents += m.signedAmountCents
    }
  }
  return { byInvoice, orphans, appliedCents, orphanCents }
}

export const memoNet = (adjustments: readonly MemoAdjustment[] | undefined): number => (adjustments ?? []).reduce((n, m) => n + m.signedAmountCents, 0)

export interface InvoiceMath {
  /** Net of the memo adjustment lines. */
  adjustmentCents: number
  /** What Aljex's own Bal Due says the memos do not explain (0 when the identity holds or Bal Due is blank). */
  residualCents: number
  totalCents: number
  paymentsCents: number
  /** Payments applied to the invoice (never above the total). */
  paidAppliedCents: number
  /** Overpayment kept as unapplied customer money. */
  surplusCents: number
  balanceCents: number
  status: 'PAID' | 'PARTIAL' | 'ISSUED'
}

/**
 * Invoice = Invoice Amount + memo adjustments (+ a reported residual when Bal Due is not explained by
 * them, so the invoice always ties to Aljex's open balance to the cent).
 */
export function invoiceMath(row: CanonicalRow, adjustmentCents: number, opts: { paidAmount?: boolean } = {}): InvoiceMath {
  const m = row.money
  const base = m.invoiceAmountCents + adjustmentCents
  // paidAmount (revenue differs, fully paid per the AR report): the invoice shows the money actually received, Bal Due 0.
  const balDue = opts.paidAmount ? 0 : m.balDueCents
  const residualCents = balDue == null ? 0 : balDue + m.paymentsReceivedCents - base
  const totalCents = base + residualCents
  const paymentsCents = m.paymentsReceivedCents
  const surplusCents = Math.max(0, paymentsCents - Math.max(totalCents, 0))
  const paidAppliedCents = paymentsCents - surplusCents
  const balanceCents = Math.max(0, totalCents - paidAppliedCents)
  const status = balanceCents === 0 ? 'PAID' : paidAppliedCents > 0 ? 'PARTIAL' : 'ISSUED'
  return { adjustmentCents, residualCents, totalCents, paymentsCents, paidAppliedCents, surplusCents, balanceCents, status }
}

/** The invoice lines the memos and the residual add (charge lines come from the load's own charge rows). */
export function adjustmentLines(key: string, loadId: string, adjustments: readonly MemoAdjustment[] | undefined, residualCents: number): EngineRow[] {
  const line = (id: string, label: string, cents: number): EngineRow => ({ chargeId: stableId('chg', id), loadId, code: 'ADJUSTMENT', label, calculatedBy: 'FLAT', rateCents: cents, count: 1, amountCents: cents })
  const out = (adjustments ?? []).map((m) => line(`${key}:MEMO:${m.memoPro}`, `${m.kind === 'CRED' ? 'Credit' : 'Debit'} memo ${m.memoPro}`, m.signedAmountCents))
  if (residualCents !== 0) out.push(line(`${key}:RESIDUAL`, 'Aljex balance adjustment', residualCents))
  return out
}
