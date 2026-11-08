/**
 * A change typed on a factoring-queue row that already bills an invoice (Step AW D.4).
 *
 * Such a change must reach the whole system, so it is not a queue-local field save: it goes to
 * finance `SYNC_FACTORING_CHANGE {proNumber, changes, changeReason}` (apiClient.syncFactoringChange),
 * which updates the invoice, the order revenue and the charge line, and audits all of them.
 * This is the pure mapping from the one field a person typed to that action's `changes`.
 */
import type { OtrRequiredField } from '@/lib/otrInvoice'

export interface FactoringChanges {
  invoiceAmountCents?: number
  poNumber?: string
  otrManualFields?: Record<string, string>
}

/** "1,234.50" or "$1234.5" to cents; null when it is not a positive amount. */
export function dollarsToCents(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const cents = Math.round(Number(cleaned) * 100)
  return cents > 0 ? cents : null
}

/** The `changes` payload for one typed field, or an error sentence for the person typing. */
export function factoringChangesFor(
  field: OtrRequiredField | 'CustomerName',
  value: string,
): { ok: true; changes: FactoringChanges } | { ok: false; error: string } {
  const text = value.trim()
  if (field === 'InvoiceAmount') {
    const cents = dollarsToCents(text)
    if (cents == null) return { ok: false, error: 'Enter the invoice amount in dollars, for example 1250.00' }
    return { ok: true, changes: { invoiceAmountCents: cents } }
  }
  if (field === 'PoNumber') return { ok: true, changes: { poNumber: text } }
  return { ok: true, changes: { otrManualFields: { [field]: text } } }
}
