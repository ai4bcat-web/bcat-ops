/**
 * Step AG §7.1: what the queue says about an item. Pure; `inboxView` and `LinkBillDialog` render it.
 */
import type { ApWorklistRow } from '@/hooks/useApWorklist'
import type { CarrierBillRecord } from '@/types/tms'
import type { VendorPayable } from '@/types/vendorAp'
import type { ApTargetKind } from './apInboxClient'
import type { ApAppliedRecord, ApInboxItemRecord, ApInboxStatus, ApReviewReason, CandidateVeto, SignalKey } from '@/lib/apInbox/types'

export type InboxChip = 'NEEDS_REVIEW' | 'APPLIED' | 'DONE' | 'DISMISSED'

export const INBOX_CHIPS: { key: InboxChip; label: string; statuses: ApInboxStatus[] }[] = [
  { key: 'NEEDS_REVIEW', label: 'Needs review', statuses: ['NEEDS_REVIEW'] },
  { key: 'APPLIED', label: 'Auto-updated', statuses: ['APPLIED'] },
  { key: 'DONE', label: 'Linked / created', statuses: ['LINKED', 'CREATED'] },
  { key: 'DISMISSED', label: 'Dismissed', statuses: ['DISMISSED'] },
]

/** The history chips look back this far; the queue itself has no bound. */
export const HISTORY_DAYS = 30

export const REASON_LABEL: Record<ApReviewReason, string> = {
  NO_MATCH: 'No match',
  LOW_CONFIDENCE: 'Low confidence',
  AMBIGUOUS: 'Two close matches',
  CONFLICT: 'Differs from the bill',
  CREDIT: 'Credit memo',
  REMIT_MISMATCH: 'Remit-to differs',
  NO_BILL_YET: 'No bill yet',
  STATUS: 'Bill already approved/part-paid',
  RUN_CAP: 'Run limit reached',
  CHANGED_UNDERFOOT: 'Bill changed meanwhile',
  AI_UNSURE: 'Reader unsure',
  AUTO_OFF: 'Auto-update is off',
}

export const SIGNAL_LABEL: Record<SignalKey, string> = {
  PRO: 'PRO number matches',
  REF: 'Reference matches',
  INVOICE_NO: 'Invoice number matches',
  CARRIER_MC: 'MC number matches',
  CARRIER_DOT: 'DOT number matches',
  CARRIER_NAME: 'Carrier name matches',
  CARRIER_FUZZY: 'Carrier name is close',
  CARRIER_CONTRADICTS: 'Carrier contradicts',
  AMOUNT_EXACT: 'Amount matches',
  AMOUNT_NEAR: 'Amount is near',
  AMOUNT_FAR: 'Amount is far off',
  VENDOR_NAME: 'Vendor name matches',
}

export const VETO_TEXT: Record<CandidateVeto, string> = {
  CARRIER_CONTRADICTS: 'The carrier on the e-mail is not the carrier on this bill.',
  REMIT_MISMATCH: 'Remit-to differs from the carrier on file — verify by phone before paying.',
  STATUS: 'The bill is already past review; only the e-mail can be attached.',
  CREDIT: 'This is a credit memo — it never updates a bill.',
}

/** Signed points, e.g. `+0.60` / `-0.25`. */
export const pointsText = (points: number): string => `${points >= 0 ? '+' : '-'}${Math.abs(points).toFixed(2)}`

/** The identifiers a clerk scans for: PRO numbers first, then other refs. */
export function itemRefs(item: Pick<ApInboxItemRecord, 'extraction'>): string {
  return [...item.extraction.pros, ...item.extraction.otherRefs].join(', ')
}

/** Carrier/vendor · shipment # for the suggested-match cell; null when nothing was suggested. */
export function suggestedLabel(item: Pick<ApInboxItemRecord, 'match'>): string | null {
  const top = item.match?.top
  if (!top) return null
  return [top.carrierName ?? top.vendorName, top.shipmentNumber].filter(Boolean).join(' · ') || top.targetId
}

/** A suggestion below the auto threshold: a person must tick "I checked this" before linking it. */
export function needsConfirm(item: Pick<ApInboxItemRecord, 'reviewReason' | 'match'>, targetId: string | null): boolean {
  const top = item.match?.top
  if (!top) return true
  if (targetId && top.targetId !== targetId) return true
  return item.reviewReason === 'LOW_CONFIDENCE' || item.reviewReason === 'AMBIGUOUS' || top.vetoes.length > 0
}

/** Why an applied item cannot be undone, or null when it can. The Lambda still checks the version. */
export function undoBlockedReason(item: Pick<ApInboxItemRecord, 'status' | 'applied'>): string | null {
  const a: ApAppliedRecord | null | undefined = item.applied
  if (item.status !== 'APPLIED' && item.status !== 'LINKED') return 'Only an applied update can be undone.'
  if (!a || a.fields.length === 0) return 'Nothing was written, so there is nothing to undo.'
  return null
}

export const STATUS_LABEL: Record<ApInboxStatus, string> = {
  NEEDS_REVIEW: 'Needs review',
  APPLIED: 'Auto-updated',
  LINKED: 'Linked',
  CREATED: 'Created',
  DISMISSED: 'Dismissed',
}

export interface TargetOption {
  key: string
  kind: ApTargetKind
  id: string
  label: string
  /** Lower-cased search text. */
  hay: string
}

/** The three open sets the page already holds, flattened into one searchable pick list. */
export function buildTargetOptions(input: {
  bills: readonly CarrierBillRecord[]
  assignments: readonly ApWorklistRow[]
  vendors: readonly VendorPayable[]
}): TargetOption[] {
  const out: TargetOption[] = []
  for (const b of input.bills) {
    const label = `Bill · ${b.carrierName ?? b.carrierId} · ${b.shipmentNumber ?? b.loadNumber ?? b.id}${b.billNumber ? ` · #${b.billNumber}` : ' · no invoice #'}`
    out.push({ key: `CARRIER_BILL:${b.id}`, kind: 'CARRIER_BILL', id: b.id, label, hay: `${label} ${b.loadNumber ?? ''}`.toLowerCase() })
  }
  for (const a of input.assignments) {
    const label = `Awaiting invoice · ${a.carrierName} · ${a.shipmentNumber ?? a.loadCarrierId}`
    out.push({ key: `LOAD_CARRIER:${a.loadCarrierId}`, kind: 'LOAD_CARRIER', id: a.loadCarrierId, label, hay: label.toLowerCase() })
  }
  for (const v of input.vendors) {
    if (v.status !== 'NEED_TO_PAY') continue
    const label = `Vendor · ${v.vendor ?? v.subject}${v.invoiceNumber ? ` · #${v.invoiceNumber}` : ''}`
    out.push({ key: `VENDOR_PAYABLE:${v.id}`, kind: 'VENDOR_PAYABLE', id: v.id, label, hay: label.toLowerCase() })
  }
  return out
}

