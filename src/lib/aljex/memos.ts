/**
 * CRED/DEBT memo rows are AR adjustment lines on the invoice of the load whose PRO is the memo's
 * `Reference #` (DECIDED-1). They never create a Shipment/Order/Load/ProClaim. A memo whose
 * reference has no invoice is an orphan and is reported (never silently dropped, never applied).
 * Pure: pass the unique, error-free rows of one file.
 */
import type { CanonicalRow } from './canonical'
import { hasInvoice } from './classify'

export interface MemoAdjustment {
  memoPro: string
  kind: 'CRED' | 'DEBT'
  /** CRED negative, DEBT positive. */
  signedAmountCents: number
  description: string
  postedInfo: string
  /** Invoice Date of the memo row (YYYY-MM-DD) or null. */
  date: string | null
}

export type MemoOrphanReason = 'NO_REFERENCE' | 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_INVOICED'

export interface MemoOrphan {
  memoPro: string
  kind: 'CRED' | 'DEBT'
  referencePro: string
  signedAmountCents: number
  reason: MemoOrphanReason
}

export interface ResolvedMemos {
  /** Invoice PRO key (normalizePro of the load PRO) -> its adjustment lines in file order. */
  byInvoice: Map<string, MemoAdjustment[]>
  orphans: MemoOrphan[]
  /** Net adjustment per invoice PRO key. */
  netByInvoice: Map<string, number>
  /** Σ signed amounts of applied / orphaned memos. */
  appliedCents: number
  orphanCents: number
}

export function netAdjustment(adjustments: readonly MemoAdjustment[] | undefined): number {
  return adjustments ? adjustments.reduce((n, a) => n + a.signedAmountCents, 0) : 0
}

export function resolveMemos(rows: readonly CanonicalRow[]): ResolvedMemos {
  const invoiced = new Set<string>()
  const loads = new Set<string>()
  for (const r of rows) {
    if (r.kind !== 'LOAD' || r.errors.length > 0 || r.proKey == null) continue
    loads.add(r.proKey)
    if (hasInvoice(r)) invoiced.add(r.proKey)
  }
  const byInvoice = new Map<string, MemoAdjustment[]>()
  const netByInvoice = new Map<string, number>()
  const orphans: MemoOrphan[] = []
  let appliedCents = 0
  let orphanCents = 0
  for (const r of rows) {
    if (r.kind === 'LOAD' || !r.memo || r.errors.length > 0) continue
    const kind = r.kind === 'MEMO_DEBT' ? 'DEBT' : 'CRED'
    const m = r.memo
    const key = m.referenceProKey
    if (key != null && invoiced.has(key)) {
      const list = byInvoice.get(key) ?? []
      list.push({ memoPro: r.pro, kind, signedAmountCents: m.signedAmountCents, description: m.description, postedInfo: m.postedInfo, date: m.date })
      byInvoice.set(key, list)
      netByInvoice.set(key, (netByInvoice.get(key) ?? 0) + m.signedAmountCents)
      appliedCents += m.signedAmountCents
    } else {
      const reason: MemoOrphanReason = key == null ? 'NO_REFERENCE' : loads.has(key) ? 'REFERENCE_NOT_INVOICED' : 'REFERENCE_NOT_FOUND'
      orphans.push({ memoPro: r.pro, kind, referencePro: m.referencePro, signedAmountCents: m.signedAmountCents, reason })
      orphanCents += m.signedAmountCents
    }
  }
  return { byInvoice, orphans, netByInvoice, appliedCents, orphanCents }
}
