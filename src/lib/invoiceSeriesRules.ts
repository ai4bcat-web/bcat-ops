// The server-side invoice series rule (Aljex-exit DECIDED-6): imported invoices keep their Aljex
// number, new ones continue from an admin-chosen start that must clear every imported number.
// Used by the finance Lambda (`saveArSettings`). The AR settings screen has its own text-input
// pre-check in `invoiceSeries.ts`; the Lambda is the authority.

/** AppSync Int ceiling. */
export const MAX_INVOICE_NUMBER = 2_147_483_647

export interface InvoiceSeriesFacts {
  start: number
  /** `TmsSettings.nextInvoiceNumber` — the LAST issued number; null/absent = none issued. */
  counter: number | null | undefined
  /** `TmsSettings.maxImportedInvoiceNumber`; null when nothing was imported. */
  maxImported: number | null | undefined
}

/** null = acceptable. */
export function invoiceSeriesError(facts: InvoiceSeriesFacts): string | null {
  const { start } = facts
  if (!Number.isInteger(start) || start < 1) return 'The invoice series start must be a whole number of 1 or more'
  if (start > MAX_INVOICE_NUMBER) return `The invoice series start cannot exceed ${MAX_INVOICE_NUMBER}`
  const max = facts.maxImported
  if (typeof max === 'number' && start <= max) {
    return `The invoice series must start above the highest imported invoice number (${max}); use ${max + 1} or more`
  }
  const counter = typeof facts.counter === 'number' ? facts.counter : 0
  if (start - 1 < counter) {
    return `Invoice numbers have already reached ${counter}; the series can only move forward (start at ${counter + 1} or more)`
  }
  return null
}
