/**
 * How an unsent invoice is billed — through the factor (OTR) or by hand to the customer — and when that
 * can still be changed (Ryne 2026-11-16: "I changed the customer profile to manually invoice, but it's
 * still showing as factor").
 *
 * An invoice takes its method from its customer when it is made, then keeps it: the printed remit-to, the
 * `factored` flag, the factoring queue row and the order's pointer to that row all copy the decision. This
 * module says when the copy may still follow the customer (a draft that never left the building) and what
 * marks a method somebody chose for ONE invoice, so a later customer edit does not undo it.
 *
 * Pure: relative imports only, because the finance Lambda bundles this file by path.
 */
import { isFactoredLoad } from './factorBilling'

export type InvoiceMethod = 'FACTOR' | 'MANUAL'

/** Fired on `window` when unsent drafts followed a customer's new billing method; the AR and Factoring pages re-read. */
export const INVOICE_METHOD_SYNCED_EVENT = 'tms:invoice-method-synced'

/** `FactoringItem.manualReason` values that record who decided the method. Free text on the row; nothing else reads them. */
export const METHOD_PIN_FACTOR = 'PIN_FACTOR' // a NEED_TO_FACTOR row: this invoice was put through the factor by hand
export const METHOD_PIN_MANUAL = 'PIN_MANUAL' // an ARCHIVED row: this invoice was taken out of the queue by hand
export const METHOD_FOLLOWED_CUSTOMER = 'CUSTOMER_METHOD' // an ARCHIVED row: the customer's method changed and the draft followed

interface InvoiceSlice {
  status?: string | null
  factored?: boolean | null
  factoringItemId?: string | null
  sentAt?: string | null
  markedSentAt?: string | null
  sentCount?: number | null
  paidCents?: number | null
  writtenOffCents?: number | null
}

interface ItemSlice {
  status?: string | null
  otrInvoiceId?: string | null
  manualReason?: string | null
}

const present = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''

/** A queue row that has been handed to OTR, or paid, or invoiced by hand and e-mailed — the factoring side is finished or in OTR's hands. */
const LOCKED_ITEM_STATUSES = new Set(['PENDING_WITH_OTR', 'FACTORED', 'INVOICED_MANUALLY'])

/** What the invoice is today: through the factor when it says so or still points at a queue row. */
export function currentInvoiceMethod(invoice: Pick<InvoiceSlice, 'factored' | 'factoringItemId'>): InvoiceMethod {
  return invoice.factored === true || present(invoice.factoringItemId) ? 'FACTOR' : 'MANUAL'
}

/** What the customer's profile says this load should be billed as (brokered loads are never factored). */
export function methodForLoad(
  customer: { billingMethod?: string | null; factored?: boolean | null } | null | undefined,
  revDivision: string | null | undefined,
): InvoiceMethod {
  return isFactoredLoad(customer as Parameters<typeof isFactoredLoad>[0], revDivision) ? 'FACTOR' : 'MANUAL'
}

/** Someone chose this invoice's method by hand ("this invoice only"); a customer edit leaves it alone. */
export function isMethodPinned(item: Pick<ItemSlice, 'manualReason'> | null | undefined): boolean {
  return item?.manualReason === METHOD_PIN_FACTOR || item?.manualReason === METHOD_PIN_MANUAL
}

/**
 * Why this invoice's method can no longer be changed in place, or null when it can. The invoice must never have
 * been e-mailed or marked sent, nothing paid or written off, and the queue row (if any) must not be in OTR's hands:
 * once the customer or OTR has the bill, the remit-to on it is a fact.
 */
export function methodChangeBlocker(invoice: InvoiceSlice, item: ItemSlice | null | undefined): string | null {
  if (invoice.status !== 'ISSUED') {
    return invoice.status === 'PAID' ? 'This invoice is already paid.' : `This invoice is ${String(invoice.status ?? 'not open').toLowerCase()}, so its method is fixed.`
  }
  if (present(invoice.sentAt) || present(invoice.markedSentAt) || (invoice.sentCount ?? 0) > 0) {
    return 'This invoice has already gone to the customer; void and re-issue it to bill it another way.'
  }
  if ((invoice.paidCents ?? 0) > 0 || (invoice.writtenOffCents ?? 0) > 0) {
    return 'Money has already been taken on this invoice.'
  }
  if (item) {
    if (present(item.otrInvoiceId)) return 'This invoice is already with OTR.'
    if (LOCKED_ITEM_STATUSES.has(String(item.status))) return 'This invoice is already with OTR or invoiced by hand.'
  }
  return null
}

/** True when the "Change method" link applies: an unsent draft whose queue row is not in OTR's hands. */
export function canChangeMethod(invoice: InvoiceSlice, item?: ItemSlice | null): boolean {
  return methodChangeBlocker(invoice, item ?? null) === null
}
