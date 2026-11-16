/**
 * Change the customer on an issued invoice (Ryne 2026-11-16): "change the customer on an invoice that was
 * already sent and then resend it manually to the correct customer".
 *
 * The invoice keeps its number, lines, amount and invoice date. What follows the customer is re-derived the
 * same way GENERATE_INVOICE derives it: the bill-to, the terms and due date, the remit-to and the factored
 * flag (a brokered load is never factored). A sent invoice becomes 'Rev N', like REVISE_INVOICE. Nothing is
 * e-mailed: the screen opens the normal send review afterwards and a person presses Send.
 *
 * Pure: the screen previews with it and CHANGE_INVOICE_CUSTOMER writes with it, so they cannot disagree.
 * Relative imports only: the finance Lambda bundles this file by path.
 */
import type { BillToParty, CustomerRecord, Division, InvoiceBillTo, InvoiceRecord, RemitTo, TmsSettings } from '../types/tms'
import { dueDateFor, invoiceTermsDays, remitToFor } from './invoiceBuild'
import { isFactoredLoad } from './factorBilling'

/** The factoring queue row as far as this decision reads it. */
export interface ChangeFactoringRow {
  id: string
  status?: string | null
  otrInvoiceId?: string | number | null
  source?: string | null
}

export type ChangeInvoice = Pick<InvoiceRecord,
  'id' | 'number' | 'status' | 'customerId' | 'customerName' | 'billToId' | 'invoiceDate' | 'paidCents' | 'writtenOffCents'
  | 'factoringItemId' | 'sentAt' | 'markedSentAt' | 'sentCount' | 'termsDays' | 'dueAt' | 'factored'
> & { revision?: number | null; legacyImported?: boolean | null; markedSentNote?: string | null }

export type ChangeTarget = Pick<CustomerRecord, 'id' | 'name' | 'billingMethod' | 'factored' | 'paymentTermsDays' | 'billingAddress' | 'billingEmail' | 'billToParties'>
  & { mergedIntoId?: string | null; active?: boolean | null; status?: string | null }

/** What happens to the invoice's factoring queue row. */
export type FactoringChange =
  /** No row, and the new customer is not factored: nothing to do. */
  | 'NONE'
  /** The row stays and now names the new customer (both factored, nothing submitted). */
  | 'RETARGET'
  /** The new customer is billed manually: the unsubmitted row is parked (ARCHIVED) and unlinked, like a void does. */
  | 'ARCHIVE'
  /** The new customer is factored but there is no row yet: Factor from Ready to invoice / the drawer makes one. */
  | 'FACTOR_NEXT'

export interface InvoiceCustomerChangePlan {
  customerId: string
  customerName: string
  billToId: string | null
  billTo: InvoiceBillTo
  termsDays: number
  termsText: string
  dueAt: string
  remitTo: RemitTo
  factored: boolean
  sent: boolean
  revision: number
  factoring: FactoringChange
}

export const CHANGE_CUSTOMER_CARRIED_OVER =
  'This invoice was carried over from Aljex (history); change the customer in Aljex, not here'

const SUBMITTED_FACTORING = new Set(['FACTORED', 'PENDING_WITH_OTR'])

export function isInvoiceSent(invoice: Pick<InvoiceRecord, 'sentAt' | 'markedSentAt' | 'sentCount'>): boolean {
  return Boolean(invoice.sentAt || invoice.markedSentAt || (invoice.sentCount ?? 0) > 0)
}

/** Why this invoice's customer cannot be changed here, or null. Same guards as REVISE_INVOICE, plus OTR. */
export function invoiceCustomerChangeRefusal(
  invoice: ChangeInvoice,
  factoringRow: ChangeFactoringRow | null,
): string | null {
  if (invoice.status === 'VOID') return 'That invoice is void'
  if (invoice.legacyImported === true || (typeof invoice.markedSentNote === 'string' && invoice.markedSentNote.startsWith('Carried over from Aljex'))) {
    return CHANGE_CUSTOMER_CARRIED_OVER
  }
  if ((invoice.paidCents ?? 0) > 0 || (invoice.writtenOffCents ?? 0) > 0) {
    return 'Money has been applied to this invoice; issue a credit memo and a replacement invoice instead of changing its customer'
  }
  if (factoringRow?.otrInvoiceId) {
    return `This invoice is with OTR as invoice ${String(factoringRow.otrInvoiceId)}; change the customer at OTR`
  }
  if (factoringRow && SUBMITTED_FACTORING.has(String(factoringRow.status ?? ''))) {
    return 'This invoice has been submitted to OTR; change the customer at OTR'
  }
  return null
}

/** Why this target customer cannot take the invoice, or null. */
export function targetCustomerRefusal(invoice: ChangeInvoice, target: ChangeTarget | null, billToId: string | null): string | null {
  if (!target) return 'Customer not found'
  if (target.mergedIntoId) return 'That customer has been merged into another record'
  if (target.active === false || target.status === 'BLOCKED') return `${target.name} is inactive`
  if (billToId && !(target.billToParties ?? []).some((party) => party.id === billToId)) {
    return `That bill-to is not one of ${target.name}'s bill-to parties`
  }
  if (target.id === invoice.customerId && (billToId ?? null) === (invoice.billToId ?? null)) {
    return 'The invoice is already billed to this customer'
  }
  return null
}

function billToOf(customer: ChangeTarget, billToId: string | null): BillToParty | null {
  const parties = customer.billToParties ?? []
  if (billToId) return parties.find((party) => party.id === billToId) ?? null
  return parties.find((party) => party.isDefault) ?? null
}

/**
 * The new bill-to, terms, due date, remit-to and factored flag for the invoice under `target`.
 * `revDivision` is the shipment's: a BROKERAGE load is never factored (Ryne 2026-11-16).
 */
export function planInvoiceCustomerChange(args: {
  invoice: ChangeInvoice
  target: ChangeTarget
  billToId: string | null
  revDivision: string | null | undefined
  division: Pick<Division, 'name' | 'legalName' | 'remitToName' | 'remitToAddress' | 'remitToEmail'> | null
  settings: Pick<TmsSettings, 'defaultPaymentTermsDays' | 'factorRemitTo' | 'invoiceTerms'> | null
  factoringRow: ChangeFactoringRow | null
}): InvoiceCustomerChangePlan {
  const { invoice, target, settings } = args
  const billTo = billToOf(target, args.billToId)
  const termsDays = invoiceTermsDays(target, billTo, settings)
  const invoiceDate = String(invoice.invoiceDate ?? '').slice(0, 10)
  const dueAt = invoiceDate ? dueDateFor(invoiceDate, termsDays) : (invoice.dueAt ?? '')
  const factored = isFactoredLoad(target, args.revDivision)
  // The remit-to follows the load's factoring, not just the customer's: a brokered load prints BCAT's own.
  const remitTo = remitToFor(args.division, factored ? target : { billingMethod: 'MANUAL', factored: false }, settings)
  const sent = isInvoiceSent(invoice)
  const revision = sent ? (invoice.revision ?? 1) + 1 : (invoice.revision ?? 1)
  const row = args.factoringRow
  const factoring: FactoringChange = row
    ? (factored ? 'RETARGET' : 'ARCHIVE')
    : (factored ? 'FACTOR_NEXT' : 'NONE')
  return {
    customerId: target.id,
    customerName: target.name,
    billToId: billTo?.id ?? null,
    billTo: billTo
      ? { name: billTo.name, address: billTo.address ?? null, email: billTo.email ?? null }
      : { name: target.name, address: target.billingAddress ?? null, email: target.billingEmail ?? null },
    termsDays,
    termsText: settings?.invoiceTerms?.trim() || `Net ${termsDays}`,
    dueAt,
    remitTo,
    factored,
    sent,
    revision,
    factoring,
  }
}

/** The shipment search key with the old customer name swapped for the new one (lower-cased, as the key is built). */
export function retargetSearchKey(searchKey: string | null | undefined, fromName: string | null | undefined, toName: string): string {
  const key = String(searchKey ?? '')
  const from = String(fromName ?? '').trim().toLowerCase()
  const to = toName.trim().toLowerCase()
  if (from && key.includes(from)) return key.split(from).join(to)
  return key.includes(to) ? key : [key, to].filter(Boolean).join(' ')
}
