import { isValidEmail } from './billingMethod'

export type EmailState = 'OK' | 'MISSING' | 'INVALID'
export type InvoiceEmailState = EmailState | 'FACTORED_QUEUE_ONLY'
export interface InvoiceEmailFields { billingMethod?: string | null; apEmail?: string | null }
export interface RemitEmailFields { carrierId: string; payeeEmail?: string | null; recipientType?: string | null; factorName?: string | null; accountName?: string | null; method?: string | null; isPreferred?: boolean | null; status?: string | null }

/**
 * How a carrier is paid and to whom (Ryne 2026-11-10): "Factor: <factor name>" when the preferred (else first active) payment method pays a
 * factor, else "Manual: <payee>" with the method (ACH, check ...). Falls back to the carrier's own factor link; blank when nothing is on file.
 */
export function carrierPayToText(carrier: { name: string; factorPaymentMethodId?: string | null }, methods: readonly RemitEmailFields[]): string {
  const live = methods.filter((m) => m.status !== 'INACTIVE')
  const m = live.find((x) => x.isPreferred) ?? live[0]
  if (!m) return carrier.factorPaymentMethodId ? 'Factor' : ''
  if (m.recipientType === 'FACTOR') return `Factor: ${m.factorName?.trim() || 'factoring company'}`
  const payee = m.accountName?.trim() || carrier.name
  return `Manual: ${payee}${m.method ? ` (${m.method})` : ''}`
}

function addressState(email: string | null | undefined): EmailState {
  if (!email?.trim()) return 'MISSING'
  return isValidEmail(email) ? 'OK' : 'INVALID'
}

/** Client-side flags only: do not change the finance Lambda's release/send gates. */
export function customerInvoiceEmailState(customer: InvoiceEmailFields): InvoiceEmailState {
  const state = addressState(customer.apEmail)
  return state !== 'OK' && customer.billingMethod === 'FACTOR' ? 'FACTORED_QUEUE_ONLY' : state
}

/** Directory completeness, not payment routing: any stored payee address counts, regardless of method status. */
export function carrierRemitEmailState(carrier: { id: string }, paymentMethods: readonly RemitEmailFields[]): EmailState {
  let state: EmailState = 'MISSING'
  for (const method of paymentMethods) {
    if (method.carrierId !== carrier.id) continue
    const next = addressState(method.payeeEmail)
    if (next === 'OK') return 'OK'
    if (next === 'INVALID') state = 'INVALID'
  }
  return state
}

/** One linear join, not a payment-method scan per carrier. */
export function groupRemitMethods(methods: readonly RemitEmailFields[]): Map<string, RemitEmailFields[]> {
  const grouped = new Map<string, RemitEmailFields[]>()
  for (const method of methods) {
    const group = grouped.get(method.carrierId)
    if (group) group.push(method)
    else grouped.set(method.carrierId, [method])
  }
  return grouped
}

export const invoiceEmailLabels: Record<InvoiceEmailState, string> = {
  OK: 'Invoice e-mail ready', MISSING: 'Missing invoice e-mail', INVALID: 'Invalid invoice e-mail', FACTORED_QUEUE_ONLY: 'Missing invoice e-mail — needed for factored billing',
}
export const remitEmailLabels: Record<EmailState, string> = {
  OK: 'Remittance e-mail ready', MISSING: 'Missing remittance e-mail', INVALID: 'Invalid remittance e-mail',
}
/** Future AR/AP post-all callers supply their evaluated state; every non-ready row is accounted for. */
export function partitionForPostAll<T extends { id: string; emailState: InvoiceEmailState }>(rows: readonly T[]): {
  ready: T[]; skipped: { id: string; reason: string }[]
} {
  const ready: T[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const row of rows) {
    if (row.emailState === 'OK') ready.push(row)
    else skipped.push({ id: row.id, reason: row.emailState === 'FACTORED_QUEUE_ONLY' ? 'Factored: use the factoring queue' : row.emailState === 'INVALID' ? 'Invalid e-mail address' : 'Missing e-mail address' })
  }
  return { ready, skipped }
}
