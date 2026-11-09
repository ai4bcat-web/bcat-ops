import { TmsBadge } from '@/features/tms/kit'
import { customerInvoiceEmailState, invoiceEmailLabels, remitEmailLabels, type InvoiceEmailFields, type EmailState } from '@/lib/emailReadiness'

export function InvoiceEmailBadge({ customer }: { customer: InvoiceEmailFields }) {
  const state = customerInvoiceEmailState(customer)
  return <TmsBadge tone={state === 'FACTORED_QUEUE_ONLY' ? 'gray' : state === 'OK' ? 'green' : 'orange'}>{invoiceEmailLabels[state]}</TmsBadge>
}

export function RemitEmailBadge({ state, suggestion }: { state: EmailState; suggestion?: string | null }) {
  return <span><TmsBadge tone={state === 'OK' ? 'green' : 'orange'}>{remitEmailLabels[state]}</TmsBadge>{state !== 'OK' && suggestion?.trim() && <span className="tms-muted"> Suggested: {suggestion.trim()}</span>}</span>
}
