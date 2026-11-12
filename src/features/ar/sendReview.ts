/** Who an invoice goes to on Send, as SEND_INVOICE / SEND_TO_FACTOR decide it. */
import { allApEmails } from '@/lib/billingMethod'
import type { CustomerRecord, InvoiceRecord, TmsSettings } from '@/types/tms'

/** The address SES sends from (amplify/backend.ts FROM_ADDRESS). */
export const INVOICE_FROM_ADDRESS = 'ai4bcat@gmail.com'

export function isFactoredInvoice(inv: InvoiceRecord, customer: CustomerRecord | undefined): boolean {
  return Boolean(inv.factored || inv.factoringItemId || customer?.billingMethod === 'FACTOR')
}

/** To and CC for a manual send, as SEND_INVOICE decides them. */
export function manualRecipients(customer: CustomerRecord | undefined, settings: TmsSettings | null): { to: string[]; cc: string[] } {
  const to = allApEmails(customer)
  const cc = [...(customer?.invoiceCopyEmails ?? []), ...(settings?.invoiceAlwaysCopyEmails ?? [])]
    .map((e) => e.trim().toLowerCase())
    .filter((e, i, all) => e && all.indexOf(e) === i && !to.includes(e))
  return { to, cc }
}

