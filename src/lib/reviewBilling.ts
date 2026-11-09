/**
 * "Review billing" flag (Ryne 2026-11-09, queue item 17): a shipment sitting in Docs needed that came from before the
 * cutover, i.e. an imported Aljex shipment or an original BCAT load (backfilled), is billing history somebody has to
 * decide on (invoice it, or confirm it was billed elsewhere). Shipments created after go-live also pass through Docs
 * needed while waiting for a POD, and are NOT flagged.
 *
 * DERIVED from fields on the row: Order.arStatus === 'DOCS_NEEDED' and (Shipment.legacyImported or Shipment.source
 * 'BACKFILL'). The one qualifier that is not derivable is "Aljex shows no invoice date" (possible unbilled freight):
 * that PRO list is static data (noAljexInvoiceDatePros.ts) and only sharpens the tooltip.
 */
import { NO_ALJEX_INVOICE_DATE_PROS } from './noAljexInvoiceDatePros'

export const REVIEW_BILLING_LABEL = 'Review billing'
export const REVIEW_BILLING_NOTE = 'Pre-cutover shipment still in Docs needed: invoice it, or confirm it was billed elsewhere.'
export const REVIEW_BILLING_NO_INVOICE_NOTE = 'Aljex shows no invoice date for this shipment: possible unbilled freight. Invoice it, or confirm it was billed elsewhere.'

const NO_INVOICE: ReadonlySet<string> = new Set(NO_ALJEX_INVOICE_DATE_PROS)

export interface ReviewBillingFacts {
  arStatus?: string | null
  legacyImported?: boolean | null
  source?: string | null
  number?: string | null
}

export function needsBillingReview(f: ReviewBillingFacts): boolean {
  return f.arStatus === 'DOCS_NEEDED' && (f.legacyImported === true || f.source === 'BACKFILL')
}

/** True when Aljex had no invoice date on a flagged imported shipment (the 41 of Ryne's 62). */
export function noAljexInvoiceDate(f: ReviewBillingFacts): boolean {
  return f.legacyImported === true && NO_INVOICE.has(String(f.number ?? '').trim().replace(/^L/i, ''))
}

export function reviewBillingNote(f: ReviewBillingFacts): string {
  return noAljexInvoiceDate(f) ? REVIEW_BILLING_NO_INVOICE_NOTE : REVIEW_BILLING_NOTE
}
