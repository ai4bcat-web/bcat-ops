import { TmsBadge } from '@/features/tms/kit'
import { stateOf } from '@/lib/billingSetupCsv'
import type { BillingMethod } from '@/lib/billingMethod'
import { customerInvoiceEmailState, invoiceEmailLabels, remitEmailLabels, type InvoiceEmailFields, type EmailState } from '@/lib/emailReadiness'

export function InvoiceEmailBadge({ customer }: { customer: InvoiceEmailFields }) {
  const state = customerInvoiceEmailState(customer)
  return <TmsBadge tone={state === 'FACTORED_QUEUE_ONLY' ? 'gray' : state === 'OK' ? 'green' : 'orange'}>{invoiceEmailLabels[state]}</TmsBadge>
}

export function RemitEmailBadge({ state, suggestion }: { state: EmailState; suggestion?: string | null }) {
  return <span><TmsBadge tone={state === 'OK' ? 'green' : 'orange'}>{remitEmailLabels[state]}</TmsBadge>{state !== 'OK' && suggestion?.trim() && <span className="tms-muted"> Suggested: {suggestion.trim()}</span>}</span>
}

/** Billing method flag: Factor / Manual are quiet facts, "Not set" blocks release to billing and is flagged orange. */
export function BillingMethodBadge({ customer }: { customer: { billingMethod?: BillingMethod | null } }) {
  const state = stateOf({ id: '', name: '', billingMethod: customer.billingMethod })
  return <TmsBadge tone={state === 'NOT_SET' ? 'orange' : state === 'FACTOR' ? 'blue' : 'green'}>{state === 'NOT_SET' ? 'Billing method not set' : state === 'FACTOR' ? 'Factor' : 'Manual'}</TmsBadge>
}
