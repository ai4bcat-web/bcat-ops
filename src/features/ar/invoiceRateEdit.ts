/**
 * Edit what the customer is charged from the draft invoice itself, before it is sent (Ryne, 2026-11-18).
 *
 * The shipment's customer charges stay the one source of the number (invoice lines, the order's revenue, the dashboard's
 * money record and what OTR is told all read them), so an edit goes through the same RECALC_CHARGES the Load review
 * Charges card saves with. That action is the post-invoice change rule's: it needs a reason and leaves a
 * POST_INVOICE_CHANGE entry (who, when, reason, before and after) on the Shipment, the Order and the Invoice. The invoice is
 * then revised in place (REVISE_INVOICE re-reads the lines, keeps the hand credits/debits, recomputes the total and
 * re-renders the PDF, factored stamp included). Carrier pay is never read or shown here: its lines go back untouched.
 */
import type { FactoringItem } from '@/types'
import type { InvoiceRecord, ShipmentBundle } from '@/types/tms'
import { getShipmentBundle, recalcCharges, reviseInvoice } from '@/lib/apiClient'
import { chargeSignature, totalsOf, toRecalc, type ChargeDraft } from '@/features/tms/loadReview/chargesEdit'

export const DEFAULT_RATE_EDIT_REASON = 'Rate edited before sending'

const isSent = (inv: InvoiceRecord): boolean => Boolean(inv.sentAt || inv.markedSentAt || (inv.sentCount ?? 0) > 0)

/** Why this invoice's amount cannot be edited here, or null. Same guards as REVISE_INVOICE, plus sent and OTR. */
export function rateEditBlock(inv: InvoiceRecord, factoringItem: Pick<FactoringItem, 'otrInvoiceId'> | null | undefined): string | null {
  if (inv.status === 'VOID') return 'This invoice is void.'
  if (inv.status === 'PAID' || inv.status === 'PARTIAL' || (inv.paidCents ?? 0) > 0 || (inv.writtenOffCents ?? 0) > 0) {
    return 'A payment is applied to this invoice. Change it with a credit memo.'
  }
  if (factoringItem?.otrInvoiceId) return 'This invoice is with OTR. Change it from the factoring queue.'
  if (isSent(inv)) return 'This invoice was already sent. Change the amount with a credit or debit; it saves as a new revision.'
  return null
}

/** The customer-side lines as typed, or the first reason a save would be refused. */
export function validateCustomerLines(bundle: ShipmentBundle, drafts: ChargeDraft[], adjustmentsCents: number): string | null {
  const customer = drafts.filter((d) => d.side === 'CUSTOMER')
  if (customer.length === 0) return 'The invoice needs at least one charge.'
  for (const d of customer) {
    if (!d.code.trim()) return 'Every line needs a name.'
    if (!(d.rateCents > 0)) return `${d.label || d.code}: the amount must be more than zero. Remove the line instead.`
  }
  if (totalsOf(bundle, drafts).revenueCents + adjustmentsCents <= 0) return 'The invoice total must be more than zero. Void the invoice instead.'
  return null
}

/** What the hand credits and debits on an invoice come to, signed. */
export function adjustmentsCentsOf(inv: InvoiceRecord): number {
  return (inv.adjustments ?? []).reduce((sum, a) => sum + (a.kind === 'CREDIT' ? -a.amountCents : a.amountCents), 0)
}

/** The charges were saved on the shipment but the invoice could not be re-made from them. */
export class InvoiceNotRegeneratedError extends Error {
  constructor(detail: string) {
    super(`The charges were saved on the shipment, but the invoice was not regenerated (${detail}). Press Regenerate PDF on the invoice.`)
    this.name = 'InvoiceNotRegeneratedError'
  }
}

export async function saveInvoiceRates(args: {
  invoice: InvoiceRecord
  drafts: ChargeDraft[]
  /** `chargeSignature` of the bundle the drafts were made from. */
  signature: string
  reason: string
}): Promise<{ invoice: InvoiceRecord; beforeCents: number; afterCents: number }> {
  const { invoice } = args
  const reason = args.reason.trim()
  if (reason.length < 5) throw new Error('Say why the amount changed (at least 5 characters).')
  const fresh = await getShipmentBundle(invoice.shipmentId)
  // Only a change to the charge lines themselves is a real conflict; the shipment's version moves for many other reasons.
  if (chargeSignature(fresh) !== args.signature) {
    throw new Error('These charges were changed somewhere else since you opened them. Close this and open it again.')
  }
  const input = toRecalc(args.drafts)
  if (!input.ok) throw new Error(input.message)
  await recalcCharges({ shipmentId: invoice.shipmentId, expectedVersion: fresh.shipment.version ?? 0, charges: input.charges, changeReason: reason })
  try {
    const { invoice: revised } = await reviseInvoice({ invoiceId: invoice.id, adjustments: invoice.adjustments ?? [], reason })
    return { invoice: revised, beforeCents: invoice.totalCents, afterCents: revised.totalCents }
  } catch (err) {
    throw new InvoiceNotRegeneratedError(err instanceof Error ? err.message : String(err))
  }
}
