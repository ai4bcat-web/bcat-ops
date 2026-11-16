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
import { pastDeliveryOf, registerReadyForReview } from './boardChips'
import { pushRefusals, requirementsForRow, reviewFactsOfRow } from './batchReview'
import type { FormIssue, SectionKey } from './form/sectionProps'
import { missingTargetOf } from './form/missingTargets'
import { MISSING_DOC_LABEL, docCellOf, openFactorGaps, openMissingDocs, registerRowText, type ShipmentRow } from './shipmentViews'

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

/**
 * Whether a POD is on file, as the server's push reads it (reviewFacts: any POD document that counts as present, a
 * driver's page awaiting review included). The board knows it from the order's document gate (docCellOf); null when
 * the gate has never run for this load, so the board cannot say.
 */
export function podFactOfRow(row: ShipmentRow): boolean | null {
  const cell = docCellOf(row, 'POD')
  if (cell === 'PRESENT' || cell === 'REVIEW') return true
  if (cell === 'MISSING') return false
  if (cell === 'NA' && Array.isArray(row.docsPresent)) return row.docsPresent.includes('POD')
  return reviewFactsOfRow(row).podReceived ?? null
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

  // (a) Push to load review, read as the server's push reads it: the POD fact from the shipment's documents (the same
  // presence as the editor's POD box and the board's POD cell; a driver's page awaiting review counts).
  const facts = { ...reviewFactsOfRow(row), podReceived: podFactOfRow(row) }
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

/**
 * Ready to move to Load Review (Ryne 2026-11-16): a load Push to load review would accept, never one the server's push
 * (pushToReviewVerdict) would refuse. It must be delivered, still on the board (its order at DOCS_NEEDED, not in review
 * or released), linked to a customer, and show nothing in REQS: REQS already holds every push requirement (the customer's
 * Load Review list, car-shipping and asset rules, billing method and AP e-mail) and, for a factored customer, the OTR
 * fields the server push also refuses on (factorReviewReasons). The POD must be known to be on file whenever the
 * load's requirements ask for one: when the board cannot tell (the document gate never ran), the load is not listed.
 */
export function readyForReviewOf(row: ShipmentRow, src: BoardReqSources = boardSources): boolean {
  if (row.voidedAt || row.deletedAt || row.status === 'CANCELED' || row.legacyImported === true) return false
  if (row.status !== 'DELIVERED' || hasLeftOperations(row)) return false
  if (row.arStatus !== 'DOCS_NEEDED' || !row.customerId) return false
  if (requirementsForRow(row, src).includes('podReceived') && podFactOfRow(row) !== true) return false
  if (boardReqsOf(row, src).length > 0) return false
  return pushRefusals([row], src).length === 0
}
registerReadyForReview((row) => readyForReviewOf(row))

/** "2 NEED" for the cell, empty when complete. */
export function boardReqsText(reqs: readonly BoardReq[]): string {
  return reqs.length > 0 ? `${reqs.length} NEED` : ''
}

/** Which card an item the form cannot point at belongs to, so the card's badge counts it. */
function sectionOfReq(key: string): SectionKey {
  if (key === 'salesRep' || key === 'revDivision') return 'roles'
  if (key.startsWith('doc:')) return 'documents'
  if (key === 'po' || key.startsWith('customer:')) return 'customer'
  if (key.startsWith('factor:')) {
    const code = key.slice(7)
    return code.startsWith('DELIVERY') ? 'consignee' : code.startsWith('PICKUP') ? 'pickup' : 'customer'
  }
  return 'rates'
}

/**
 * The editor's What's missing list: EXACTLY the REQS items (the chip's count is the list's length, Ryne 2026-11-16).
 * An item the form can point at (the PO, a factoring field, a document box) focuses that field; one it cannot (sales
 * rep, division, rate, expense, a customer setting, a document the form does not ask for on this load) is still
 * listed, with a plain line on how to fix it and, for customer settings, a link to the customer. Nothing is dropped:
 * when the item is fixed, the board row the editor re-reads after every save no longer has it.
 */
export function reqsAsIssues(
  reqs: readonly BoardReq[],
  formSees: readonly FormIssue[],
  allIssues: readonly FormIssue[],
  customerId?: string | null,
): FormIssue[] {
  const byLabel = (label: string) => {
    const want = label.trim().toLowerCase()
    return [...formSees, ...allIssues].find((i) => i.label.trim().toLowerCase() === want)
  }
  return reqs.map((req): FormIssue => {
    // What lives on the customer is fixed in the customer dialog, not on a field of the load.
    if (req.key.startsWith('customer:') || req.key === 'factor:CUSTOMER_MC' || req.key === 'factor:BILLING_METHOD') return fallbackIssue(req, customerId)
    const match = req.key.startsWith('doc:')
      ? formSees.find((i) => i.id === `documents:${req.key.slice(4)}`)
      : req.key === 'po'
        ? formSees.find((i) => i.id === 'customer:ref:po') ?? allIssues.find((i) => i.id === 'customer:ref:po') ?? byLabel('PO')
        : byLabel(req.label)
    if (match) return { ...match, label: req.label }
    return fallbackIssue(req, customerId)
  })
}

/** An item the form has no issue for: still listed, pointing at the closest place to fix it. */
function fallbackIssue(req: BoardReq, customerId?: string | null): FormIssue {
  const base = { id: `req:${req.key}`, label: req.label, message: req.label, severity: 'warn' as const }
  const target = missingTargetOf(req.key, Boolean(customerId))
  if (target) {
    return {
      ...base, section: sectionOfReq(req.key), fieldKey: target.fieldKey, hint: target.hint,
      ...(target.fallbackKeys ? { fallbackKeys: target.fallbackKeys } : {}),
      ...(target.action ? { action: target.action } : {}),
    }
  }
  return { ...base, section: sectionOfReq(req.key), fieldKey: '', hint: undefined }
}
