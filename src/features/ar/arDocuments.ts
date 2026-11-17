/**
 * Ready to Invoice: when a row's POD and rate confirmation may still be replaced or deleted from the
 * AR page (Ryne 2026-11-17). A draft invoice (made when the load moved to billing, never e-mailed, nothing
 * paid, nothing at OTR) is still ours to fix; once it has gone out, its paperwork went with it and a
 * corrected copy is uploaded through the factoring flow or the invoice is revised.
 *
 * Mirrors `invoiceHasGoneOut` in the shipment-actions Lambda, which makes the same call before it voids
 * or retypes a POD / rate con on an invoiced load.
 */
import type { FactoringItem } from '@/types'
import type { InvoiceRecord } from '@/types/tms'

/** Queue rows that have not reached OTR: the invoice behind them is still a draft. */
const NOT_SUBMITTED = new Set<string>(['NEED_TO_FACTOR', 'MANUAL_INVOICE'])

export const DOCS_LOCKED_MESSAGE = 'Already sent or with OTR. Replace the document through the factoring flow, or revise the invoice.'

/** Null when the paperwork may be changed; otherwise the sentence that says why not. */
export function docsLockedReason(
  invoice: Pick<InvoiceRecord, 'status' | 'sentAt' | 'markedSentAt' | 'sentCount' | 'paidCents'> | null | undefined,
  factoringItem?: Pick<FactoringItem, 'status' | 'otrInvoiceId'> | null,
): string | null {
  if (!invoice) return null
  if (invoice.status && invoice.status !== 'ISSUED') return DOCS_LOCKED_MESSAGE
  if (invoice.sentAt || invoice.markedSentAt || (invoice.sentCount ?? 0) > 0) return DOCS_LOCKED_MESSAGE
  if ((invoice.paidCents ?? 0) > 0) return DOCS_LOCKED_MESSAGE
  if (factoringItem && (factoringItem.otrInvoiceId || !NOT_SUBMITTED.has(factoringItem.status))) return DOCS_LOCKED_MESSAGE
  return null
}

/** A blocked-row reason that is about the POD or the rate confirmation: the Why dialog offers the documents. */
export const DOC_FIXABLE = /\bPOD\b|proof of delivery|rate con/i
