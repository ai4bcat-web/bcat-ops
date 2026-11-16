/**
 * The board's REQS column (Ryne 2026-11-16): one list of what a load still needs, made of
 *  (a) everything that would stop "Push to load review" (the same pieces pushRefusals reads: the customer's
 *      Load Review requirements via evaluateReviewRequirements, asset rules included, and the customer's billing
 *      gaps: billing method, AP e-mail, …), and
 *  (b) when the customer factors, what OTR needs (openFactorGaps: PO, rate, stop city/state/ZIP, MC, billing method)
 *      plus the documents the board counts (openMissingDocs: the outside rate con on factored / asset loads, a
 *      factored load's POD once delivered).
 * Overlaps collapse (the reference # and the factoring PO are one item; a billing method gap is one item).
 *
 * Stage-gated: the POD (review's "POD not received" and the factoring POD) only counts once the load has delivered
 * or is past its delivery date. "Only delivered loads can go to Load review" is never an item: the status column
 * says that. Everything else (PO, rate, expense, rep, division, stops, customer setup, the outside rate con) can be
 * fixed from booking on, so it counts at every stage.
 */
import { CUSTOMER_BILLING_GAP_MESSAGE } from '@/lib/customerBillingReady'
import { FACTOR_GAP_LABEL, type FactorGapCode } from '@/lib/factorReadyAtCreate'
import { evaluateReviewRequirements, type ReviewRequirement } from '@/lib/reviewRequirements'
import { hasLeftOperations } from '@/lib/shipmentLists'
import { pastDeliveryOf } from './boardChips'
import { requirementsForRow, reviewFactsOfRow } from './batchReview'
import type { FormIssue, SectionKey } from './form/sectionProps'
import { MISSING_DOC_LABEL, openFactorGaps, openMissingDocs, registerRowText, type ShipmentRow } from './shipmentViews'

export interface BoardReq {
  /** Stable id, also how the editor's rail matches an item to the field it focuses. */
  key: string
  label: string
}

export interface BoardReqSources {
  customers: ReadonlyArray<{ id: string; reviewRequirements?: string[] | null }>
  orgDefault: readonly string[] | null | undefined
}

/** Delivered, or past the delivery date: the point from which the POD is owed. */
export function podStage(row: ShipmentRow, nowMs: number): boolean {
  return row.status === 'DELIVERED' || pastDeliveryOf(row, nowMs) != null
}

/** Review requirement → the item it is (shared with the factoring list where they overlap). */
const REVIEW_ITEM: Record<ReviewRequirement, BoardReq | null> = {
  revDivision: { key: 'revDivision', label: 'Revenue division' },
  referenceNumber: { key: 'po', label: 'PO / reference #' },
  podReceived: { key: 'doc:POD', label: MISSING_DOC_LABEL.POD },
  // Never fails on its own (the document checks own the rate con: openMissingDocs below).
  rateConReceived: null,
  // A per-customer switch too: the customer billing gaps below report a missing AP e-mail (customerBillingReady).
  apEmail: null,
  salesRep: { key: 'salesRep', label: 'Sales rep' },
  revenueEntered: { key: 'customerRate', label: 'Customer rate' },
  expenseEntered: { key: 'expense', label: 'Carrier cost / expense' },
  profitEntered: { key: 'profit', label: 'Profit (needs revenue and expense)' },
}

/** Factoring gap → item; the PO and the rate share the review items' keys so they count once. */
function factorItem(code: FactorGapCode): BoardReq {
  if (code === 'PO_MISSING') return REVIEW_ITEM.referenceNumber!
  if (code === 'RATE_MISSING') return REVIEW_ITEM.revenueEntered!
  return { key: `factor:${code}`, label: FACTOR_GAP_LABEL[code] }
}

export function boardReqsOf(row: ShipmentRow, src: BoardReqSources, nowMs: number = Date.now()): BoardReq[] {
  if (row.voidedAt || row.deletedAt || row.status === 'CANCELED') return []
  // Imported history is exempt from review and already billed or factored in Aljex.
  if (row.legacyImported === true) return []
  // A load already in Load Review or released to invoicing has left operations: the board asks nothing more of it.
  if (hasLeftOperations(row)) return []
  const pod = podStage(row, nowMs)
  const out = new Map<string, BoardReq>()
  const add = (item: BoardReq | null) => { if (item && !out.has(item.key)) out.set(item.key, item) }

  // (a) Push to load review, read exactly as pushRefusals does.
  const facts = reviewFactsOfRow(row)
  const requirements = requirementsForRow(row, src)
    .filter((key) => key !== 'podReceived' || (pod && facts.podReceived != null))
  for (const f of evaluateReviewRequirements(requirements, facts).failures) add(REVIEW_ITEM[f.requirement])
  // The push skips these on imported history; boardReqsOf already returned for it.
  for (const code of row.customerBillingGaps ?? []) add({ key: `customer:${code}`, label: CUSTOMER_BILLING_GAP_MESSAGE[code] })

  // (b) Factoring / OTR, and the documents the board counts.
  for (const code of openFactorGaps(row)) {
    if (code === 'BILLING_METHOD' && (row.customerBillingGaps ?? []).includes('CUSTOMER_BILLING_METHOD')) continue
    add(factorItem(code))
  }
  for (const doc of openMissingDocs(row)) {
    if (doc === 'POD' && !pod) continue
    add({ key: `doc:${doc}`, label: MISSING_DOC_LABEL[doc] })
  }
  // Profit only follows from the rate and the cost: when either is already listed, profit is not a separate thing to fix.
  if (out.has('customerRate') || out.has('expense')) out.delete('profit')
  return [...out.values()]
}

// The board sets the customers' Load Review lists and the org default once they load (like setFleetDrivers), so the
// grid column's text, sort and filter can read REQS without a React context.
let boardSources: BoardReqSources = { customers: [], orgDefault: null }
export function setBoardReqSources(src: BoardReqSources): void {
  boardSources = src
}
/** REQS with the sources the board registered. */
export function boardReqsOfRow(row: ShipmentRow, nowMs: number = Date.now()): BoardReq[] {
  return boardReqsOf(row, boardSources, nowMs)
}

/** The list as one line ("Sales rep, POD"), for the CSV export and tooltips; empty when complete. */
export function boardReqsListText(reqs: readonly BoardReq[]): string {
  return reqs.map((r) => r.label).join(', ')
}
registerRowText('reqs', (row) => boardReqsListText(boardReqsOfRow(row)))

/** "2 NEED" for the cell, empty when complete. */
export function boardReqsText(reqs: readonly BoardReq[]): string {
  return reqs.length > 0 ? `${reqs.length} NEED` : ''
}

/** Which card an item the form cannot point at belongs to, so the card's badge counts it. */
function sectionOfReq(key: string): SectionKey {
  if (key === 'salesRep' || key === 'revDivision') return 'roles'
  if (key.startsWith('customer:')) return 'customer'
  return 'rates'
}

/**
 * The editor's What's missing list when it was opened from a REQS chip: the chip's own items, so the counts match.
 * An item the form can see for itself (the PO, a factoring field, a document) is kept only while the form still
 * finds it missing, and focuses that field; the rest (sales rep, division, rate, expense, customer setup) stay listed
 * until the shipment is reopened from the board.
 */
export function reqsAsIssues(reqs: readonly BoardReq[], formSees: readonly FormIssue[], allIssues: readonly FormIssue[]): FormIssue[] {
  const byLabel = (label: string) => {
    const want = label.trim().toLowerCase()
    return [...formSees, ...allIssues].find((i) => i.label.trim().toLowerCase() === want)
  }
  const out: FormIssue[] = []
  for (const req of reqs) {
    const formOwned = req.key === 'po' || req.key.startsWith('doc:') || req.key.startsWith('factor:')
    const match = req.key.startsWith('doc:')
      ? formSees.find((i) => i.id === `documents:${req.key.slice(4)}`)
      : req.key === 'po'
        ? formSees.find((i) => i.id === 'customer:ref:po') ?? byLabel('PO')
        : byLabel(req.label)
    if (formOwned) {
      if (match) out.push({ ...match, label: req.label })
      continue
    }
    out.push(match
      ? { ...match, label: req.label }
      : { id: `req:${req.key}`, section: sectionOfReq(req.key), fieldKey: '', label: req.label, message: req.label, severity: 'warn' })
  }
  return out
}
