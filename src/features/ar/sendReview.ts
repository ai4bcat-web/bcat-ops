/** Who an invoice goes to on Send, as SEND_INVOICE / SEND_TO_FACTOR decide it. */
import { allApEmails } from '@/lib/billingMethod'
import type { CustomerRecord, InvoiceRecord, TmsSettings } from '@/types/tms'
import type { InvoiceAttachmentPlanRow } from '@/lib/invoiceDelivery'

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

/**
 * Why one invoice cannot be e-mailed as it stands, or null. Factored invoices go to OTR and
 * carry none of these. `packetError` is what building the combined PDF said, once known.
 */
export function sendBlockers(input: {
  factored: boolean
  to: readonly string[]
  plan: InvoiceAttachmentPlanRow | undefined
  openFlags: number
  packetError?: string | null
}): string[] {
  if (input.factored) return []
  const out: string[] = []
  if (input.to.length === 0) out.push('No AP e-mail on file')
  const plan = input.plan
  if (plan && !plan.error) {
    if (plan.pod === 'MISSING') out.push('No POD on file')
    for (const name of plan.unmergeablePods ?? []) out.push(`POD "${name}" cannot be merged into the invoice PDF (not a PDF, JPG or PNG)`)
    if (plan.tooBig) out.push('Attachments over 10 MB')
  }
  if (input.openFlags > 0) out.push('Carrier pay found in an attachment')
  if (input.packetError) out.push(input.packetError)
  return out
}
