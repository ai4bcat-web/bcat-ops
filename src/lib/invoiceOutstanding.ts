/**
 * What counts as owed, and what counts as sent (Ryne 2026-11-19: "any time an invoice goes out, whether to
 * factor or by manual e-mail, that payment record shows as outstanding, regardless of what happens with OTR
 * rejecting it").
 *
 * Two rules, one place, so Open AR, Aging, Invoiced, the dashboard's AR card, the statements and the
 * data-safety totals cannot drift apart:
 *
 *   OUTSTANDING   an invoice is owed while it is ISSUED or PARTIAL and still has a balance. Nothing about OTR
 *                 (Dead, Duplicate, rejected, reset to Need to factor, resubmitted, archived, converted to
 *                 manual) changes that. Only a payment, a credit, a write-off or a void ends it.
 *
 *   SENT          an invoice has gone out once it was e-mailed, marked sent by hand, or handed to OTR. The
 *                 OTR leg is remembered on the invoice itself (`factorSubmittedAt`) and, for rows that
 *                 predate it, read from the queue row's OTR history. It must never depend on the queue
 *                 row's CURRENT status alone: a row put back to Need to factor, archived, or given a new
 *                 OTR invoice still tells us the invoice went out, and a sent invoice that fell back to
 *                 "draft" would drop out of Open AR.
 */
import type { FactoringItem } from '@/types'
import type { InvoiceRecord } from '@/types/tms'

/** The invoice statuses that are still owed. The `arOpen` index and the data-safety totals use the same two. */
export const OUTSTANDING_INVOICE_STATUSES: readonly string[] = ['ISSUED', 'PARTIAL']

export function isOutstandingInvoice(inv: Pick<InvoiceRecord, 'status' | 'balanceCents'>): boolean {
  return OUTSTANDING_INVOICE_STATUSES.includes(String(inv.status ?? '')) && Number(inv.balanceCents ?? 0) > 0
}

/** The slice of an invoice the sent rule reads. */
export type SentInvoiceFields = Partial<Pick<InvoiceRecord, 'sentAt' | 'markedSentAt' | 'sentCount' | 'factorSubmittedAt'>>

/** The slice of a queue row the sent rule reads. */
export type SentFactorItemFields = Partial<Pick<FactoringItem, 'status' | 'otrInvoiceId' | 'otrSubmittedAt' | 'otrPriorInvoices'>>

/** The queue row shows OTR was ever given this invoice, even if it has since been reset, archived or replaced. */
export function factorItemWasSubmitted(item: SentFactorItemFields | null | undefined): boolean {
  if (!item) return false
  if (item.otrInvoiceId || item.otrSubmittedAt) return true
  if (Array.isArray(item.otrPriorInvoices) && item.otrPriorInvoices.length > 0) return true
  return item.status === 'PENDING_WITH_OTR' || item.status === 'FACTORED'
}

/** Sent to the customer, or handed to OTR, at any time. Never un-sent by what OTR does afterwards. */
export function isInvoiceSentToCustomerOrFactor(inv: SentInvoiceFields, factorItem?: SentFactorItemFields | null): boolean {
  if (inv.sentAt || inv.markedSentAt || (inv.sentCount ?? 0) > 0) return true
  if (inv.factorSubmittedAt) return true
  return factorItemWasSubmitted(factorItem)
}
