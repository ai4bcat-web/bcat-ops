/**
 * Step AG §6 — matching and the exact auto-apply rules. Pure.
 *
 * `rankCandidates` scores every open AP target against one extraction (additive signals, clamped
 * to [0,1], 2 dp; each signal is recorded so a reviewer sees *why*). `decide` applies the strict
 * AUTO conditions A1–A9 (A9, the conditional write, is the store's) and otherwise returns the
 * review reason. A wrong auto-apply is the worst outcome here, so every doubt queues.
 */
import {
  AMBIGUITY_MARGIN,
  AUTO_APPLY_MIN_FLOOR,
  LOW_CONFIDENCE_CAP,
  MEDIUM_CONFIDENCE_CAP,
} from './constants'
import { planBillUpdate, planVendorUpdate, type BillPlan, type VendorPlan } from './applyPlan'
import {
  amountRelation,
  assignmentStrongPros,
  billStrongPros,
  digitsOf,
  isPlaceholderBill,
  nameDice,
  namesOverlap,
  normalizeRef,
  sameName,
} from './refs'
import type {
  ApExtraction,
  ApInboxConfig,
  ApReviewReason,
  Candidate,
  CandidateVeto,
  Ledger,
  LedgerCarrier,
  Signal,
} from './types'

const round2 = (n: number): number => Math.round(n * 100) / 100

const POINTS = {
  PRO: 0.6,
  REF: 0.25,
  INVOICE_NO: 0.55,
  CARRIER_ID: 0.25,
  CARRIER_NAME: 0.2,
  CARRIER_FUZZY: 0.1,
  CARRIER_CONTRADICTS: -0.6,
  AMOUNT_EXACT: 0.1,
  AMOUNT_EXACT_ALONE: 0.35,  // replaces (not adds to) AMOUNT_EXACT when nothing else identifies the target
  AMOUNT_FAR: -0.25,
  VENDOR_EXACT: 0.25,
  VENDOR_FUZZY: 0.1,
} as const

interface CarrierRef {
  carrierId: string
  carrierName?: string | null
  carrierMc?: string | null
  remitToName?: string | null
}

function carrierSignals(ext: ApExtraction, ref: CarrierRef, ledger: Ledger): { signals: Signal[]; contradicts: boolean; remit: string | null } {
  const carrier: LedgerCarrier = ledger.carriers[ref.carrierId] ?? { id: ref.carrierId, name: ref.carrierName ?? '', mcNumber: ref.carrierMc ?? null }
  const signals: Signal[] = []
  const emailMc = ext.issuer.mc
  const emailDot = ext.issuer.dot
  const carMc = digitsOf(carrier.mcNumber ?? ref.carrierMc)
  const carDot = digitsOf(carrier.dotNumber)
  let contradicts = false

  const mcHit = emailMc != null && carMc != null && emailMc === carMc
  const dotHit = emailDot != null && carDot != null && emailDot === carDot
  if (mcHit) signals.push({ key: 'CARRIER_MC', points: POINTS.CARRIER_ID, detail: `MC ${emailMc} matches the carrier on file` })
  else if (dotHit) signals.push({ key: 'CARRIER_DOT', points: POINTS.CARRIER_ID, detail: `DOT ${emailDot} matches the carrier on file` })
  if ((emailMc != null && carMc != null && emailMc !== carMc) || (emailDot != null && carDot != null && emailDot !== carDot)) contradicts = true

  const names = [carrier.name, carrier.dbaName, carrier.legalName, ref.carrierName, ...(carrier.aliases ?? [])].filter((n): n is string => !!n)
  const issuer = ext.issuer.name
  if (issuer) {
    if (names.some((n) => sameName(n, issuer))) signals.push({ key: 'CARRIER_NAME', points: POINTS.CARRIER_NAME, detail: `Issuer "${issuer}" is the carrier's name` })
    else if (names.some((n) => nameDice(n, issuer) >= 0.85)) signals.push({ key: 'CARRIER_FUZZY', points: POINTS.CARRIER_FUZZY, detail: `Issuer "${issuer}" is close to the carrier's name` })
  }

  // The mail's MC / DOT / exact name resolves to a different carrier in the directory.
  if (!contradicts) {
    for (const other of Object.values(ledger.carriers)) {
      if (other.id === ref.carrierId) continue
      const mcOther = emailMc != null && digitsOf(other.mcNumber) === emailMc
      const dotOther = emailDot != null && digitsOf(other.dotNumber) === emailDot
      const nameOther = !mcHit && !dotHit && issuer != null && sameName(other.name, issuer) && !names.some((n) => sameName(n, issuer))
      if (mcOther || dotOther || nameOther) {
        contradicts = true
        break
      }
    }
  }
  if (contradicts) signals.push({ key: 'CARRIER_CONTRADICTS', points: POINTS.CARRIER_CONTRADICTS, detail: 'The mail names a different carrier than the one on this bill' })
  return { signals, contradicts, remit: carrier.remitToName ?? ref.remitToName ?? null }
}

function remitMismatch(ext: ApExtraction, targetRemit: string | null): boolean {
  if (!ext.remitTo || !targetRemit) return false
  const probes = [ext.remitTo.name, ext.remitTo.text].filter((p): p is string => !!p)
  if (probes.length === 0) return false
  return !probes.some((p) => namesOverlap(p, targetRemit))
}

function finish(
  ext: ApExtraction,
  base: Omit<Candidate, 'score' | 'signals' | 'vetoes'>,
  signals: Signal[],
  vetoes: CandidateVeto[],
): Candidate {
  let score = signals.reduce((sum, s) => sum + s.points, 0)
  score = Math.max(0, Math.min(1, score))
  if (ext.confidence === 'medium') score = Math.min(score, MEDIUM_CONFIDENCE_CAP)
  if (ext.confidence === 'low') score = Math.min(score, LOW_CONFIDENCE_CAP)
  if (ext.kind === 'CREDIT_MEMO' && !vetoes.includes('CREDIT')) vetoes.push('CREDIT')
  return { ...base, score: round2(score), signals, vetoes }
}

/** Candidates worth showing: some identifying signal, best first, at most 10. */
export function rankCandidates(ext: ApExtraction, ledger: Ledger): Candidate[] {
  const out: Candidate[] = []
  const extPros = ext.pros
  const extRefs = [...extPros, ...ext.otherRefs.map((r) => normalizeRef(r)).filter((r): r is string => !!r)]
  const invNo = normalizeRef(ext.invoiceNumber)

  const idSignals = (strong: string[], weak: string[]): Signal[] => {
    const s: Signal[] = []
    const hit = extPros.find((p) => strong.includes(p))
    if (hit) s.push({ key: 'PRO', points: POINTS.PRO, detail: `PRO ${hit} is this load's PRO` })
    const refHit = extRefs.find((r) => weak.some((w) => normalizeRef(w) === r))
    if (refHit) s.push({ key: 'REF', points: POINTS.REF, detail: `Reference ${refHit} is on this load` })
    return s
  }
  const amountSignal = (signals: Signal[], ref: number | null): void => {
    const rel = amountRelation(ext.amountCents, ref)
    const identified = signals.some((s) => s.key === 'PRO' || s.key === 'REF' || s.key === 'INVOICE_NO')
    if (rel === 'EXACT') {
      const points = identified ? POINTS.AMOUNT_EXACT : POINTS.AMOUNT_EXACT_ALONE
      signals.push({ key: 'AMOUNT_EXACT', points, detail: `Amount matches within tolerance` })
    } else if (rel === 'NEAR') signals.push({ key: 'AMOUNT_NEAR', points: 0, detail: 'Amount within 25%' })
    else if (rel === 'FAR') signals.push({ key: 'AMOUNT_FAR', points: POINTS.AMOUNT_FAR, detail: 'Amount differs by more than 25%' })
  }
  const identifying = (signals: Signal[]): boolean =>
    signals.some((s) => s.key === 'PRO' || s.key === 'REF' || s.key === 'INVOICE_NO' || s.key === 'VENDOR_NAME' || s.key.startsWith('CARRIER_') && s.key !== 'CARRIER_CONTRADICTS')

  for (const bill of ledger.bills) {
    const signals = idSignals(billStrongPros(bill), bill.refs ?? [])
    const placeholder = isPlaceholderBill(bill)
    if (!placeholder && invNo && normalizeRef(bill.billNumber) === invNo) {
      signals.push({ key: 'INVOICE_NO', points: POINTS.INVOICE_NO, detail: `Invoice # ${ext.invoiceNumber} is already on this bill` })
    }
    const carrier = carrierSignals(ext, { carrierId: bill.carrierId, carrierName: bill.carrierName, carrierMc: bill.carrierMc, remitToName: bill.remitToName }, ledger)
    signals.push(...carrier.signals)
    amountSignal(signals, bill.billedCents)
    if (!identifying(signals)) continue
    const vetoes: CandidateVeto[] = []
    if (carrier.contradicts) vetoes.push('CARRIER_CONTRADICTS')
    if (remitMismatch(ext, carrier.remit)) vetoes.push('REMIT_MISMATCH')
    if (bill.status === 'PARTIAL') vetoes.push('STATUS')
    out.push(finish(ext, {
      targetKind: 'CARRIER_BILL', targetId: bill.id, billId: bill.id, loadCarrierId: bill.loadCarrierId, shipmentId: bill.shipmentId,
      shipmentNumber: bill.shipmentNumber ?? undefined, carrierId: bill.carrierId, carrierName: bill.carrierName ?? undefined, status: bill.status,
    }, signals, vetoes))
  }

  for (const a of ledger.assignments) {
    const signals = idSignals(assignmentStrongPros(a), a.refs ?? [])
    const carrier = carrierSignals(ext, { carrierId: a.carrierId, carrierName: a.carrierName }, ledger)
    signals.push(...carrier.signals)
    amountSignal(signals, a.rateCents)
    if (!identifying(signals)) continue
    const vetoes: CandidateVeto[] = []
    if (carrier.contradicts) vetoes.push('CARRIER_CONTRADICTS')
    if (remitMismatch(ext, carrier.remit)) vetoes.push('REMIT_MISMATCH')
    out.push(finish(ext, {
      targetKind: 'LOAD_CARRIER', targetId: a.loadCarrierId, loadCarrierId: a.loadCarrierId, shipmentId: a.shipmentId,
      shipmentNumber: a.shipmentNumber ?? undefined, carrierId: a.carrierId, carrierName: a.carrierName ?? undefined, status: 'AWAITING_INVOICE',
    }, signals, vetoes))
  }

  for (const v of ledger.vendorPayables) {
    const signals: Signal[] = []
    if (invNo && normalizeRef(v.invoiceNumber) === invNo) signals.push({ key: 'INVOICE_NO', points: POINTS.INVOICE_NO, detail: `Invoice # ${ext.invoiceNumber} is on this payable` })
    const issuer = ext.issuer.name
    if (issuer && v.vendor) {
      if (sameName(v.vendor, issuer)) signals.push({ key: 'VENDOR_NAME', points: POINTS.VENDOR_EXACT, detail: `Vendor "${v.vendor}" matches the sender` })
      else if (nameDice(v.vendor, issuer) >= 0.85) signals.push({ key: 'VENDOR_NAME', points: POINTS.VENDOR_FUZZY, detail: `Vendor "${v.vendor}" is close to the sender` })
    }
    amountSignal(signals, v.amount)
    if (!identifying(signals)) continue
    out.push(finish(ext, {
      targetKind: 'VENDOR_PAYABLE', targetId: v.id, vendorName: v.vendor ?? undefined, status: v.status,
    }, signals, []))
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 10)
}

export interface Decision {
  outcome: 'AUTO' | 'REVIEW'
  reason: ApReviewReason | null
  /** Best suggestion (shown even when the mail is queued). */
  top: Candidate | null
  /** At most 3, for the stored match record. */
  candidates: Candidate[]
  /** Review item whose PDF should still be attached to the target (NO_BILL_YET, CONFLICT). */
  attach: boolean
  /** The field plan for `top` when it is a bill / payable. */
  plan: BillPlan | VendorPlan | null
}

const carrierPoints = (c: Candidate): number =>
  c.signals.filter((s) => s.key === 'CARRIER_MC' || s.key === 'CARRIER_DOT' || s.key === 'CARRIER_NAME').reduce((n, s) => n + s.points, 0)

/** §6.4 — AUTO iff every condition holds; otherwise the first failing reason. */
export function decide(
  ext: ApExtraction,
  candidates: Candidate[],
  ledger: Ledger,
  config: Pick<ApInboxConfig, 'autoApply' | 'autoApplyMinScore' | 'reviewMinScore' | 'maxAutoAppliesPerRun'>,
  run: { autoApplied: number },
): Decision {
  const shown = candidates.slice(0, 3)
  const review = (reason: ApReviewReason, top: Candidate | null, extra: Partial<Decision> = {}): Decision =>
    ({ outcome: 'REVIEW', reason, top, candidates: shown, attach: false, plan: null, ...extra })

  if (ext.kind === 'CREDIT_MEMO') return review('CREDIT', candidates[0] ?? null)
  if (ext.kind !== 'INVOICE') return review('AI_UNSURE', candidates[0] ?? null)

  const ranked = candidates.filter((c) => c.score >= config.reviewMinScore)
  const top = ranked[0]
  if (!top) return review('NO_MATCH', candidates[0] ?? null)
  if (top.vetoes.includes('REMIT_MISMATCH')) return review('REMIT_MISMATCH', top)
  if (top.vetoes.includes('STATUS')) return review('STATUS', top)
  if (top.vetoes.includes('CREDIT')) return review('CREDIT', top)
  if (top.vetoes.includes('CARRIER_CONTRADICTS')) return review('NO_MATCH', top)
  const second = ranked[1]
  if (second && second.score > top.score - AMBIGUITY_MARGIN) return review('AMBIGUOUS', top)
  if (ext.confidence === 'low') return review('AI_UNSURE', top)

  const minScore = Math.max(config.autoApplyMinScore, AUTO_APPLY_MIN_FLOOR)
  const hasId = top.signals.some((s) => s.key === 'PRO' || s.key === 'INVOICE_NO')
  const corroborated = top.targetKind === 'VENDOR_PAYABLE'
    ? top.signals.some((s) => s.key === 'INVOICE_NO') && top.signals.some((s) => s.key === 'VENDOR_NAME' && s.points >= POINTS.VENDOR_EXACT)
    : hasId && carrierPoints(top) >= POINTS.CARRIER_NAME
  const extOk = ext.confidence === 'high' && ext.invoiceNumber != null && (ext.invoiceDate != null || ext.dueDate != null || ext.amountCents != null)
  if (top.score < minScore || !corroborated || !extOk) return review('LOW_CONFIDENCE', top)

  if (top.targetKind === 'LOAD_CARRIER') return review('NO_BILL_YET', top, { attach: true })
  if (!config.autoApply) return review('AUTO_OFF', top)
  if (run.autoApplied >= config.maxAutoAppliesPerRun) return review('RUN_CAP', top)

  let plan: BillPlan | VendorPlan
  if (top.targetKind === 'CARRIER_BILL') {
    const bill = ledger.bills.find((b) => b.id === top.targetId)
    if (!bill) return review('CHANGED_UNDERFOOT', top)
    plan = planBillUpdate(bill, ext, { mode: 'AUTO' })
  } else {
    const vendor = ledger.vendorPayables.find((v) => v.id === top.targetId)
    if (!vendor) return review('CHANGED_UNDERFOOT', top)
    plan = planVendorUpdate(vendor, ext, { mode: 'AUTO' })
  }
  if (plan.conflicts.length > 0) return review('CONFLICT', top, { attach: true, plan })
  return { outcome: 'AUTO', reason: null, top, candidates: shown, attach: true, plan }
}
