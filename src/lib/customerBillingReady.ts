/**
 * Every customer must be billable before a load leaves Load Review (Ryne 2026-11-16): a billing method (Factor or
 * Manual invoice) and at least one AP / invoice e-mail, factored customers included. Pure and import-free, so the
 * board, Load Review and the tms-shipment-actions Lambda read the same rule. The AP e-mail can be waived per customer
 * (customerApEmailRequired in reviewRequirements.ts; Ryne 2026-11-16: AUTO SHIPPER); callers pass that in.
 */
export type CustomerBillingGapCode = 'CUSTOMER_BILLING_METHOD' | 'CUSTOMER_AP_EMAIL'

export interface CustomerBillingFacts {
  name?: string | null
  billingMethod?: string | null
  factored?: boolean | null
  apEmail?: string | null
  apEmailsExtra?: readonly (string | null)[] | null
}

export const CUSTOMER_BILLING_GAP_MESSAGE: Record<CustomerBillingGapCode, string> = {
  CUSTOMER_BILLING_METHOD: 'Customer has no billing method (Factor or Manual invoice)',
  CUSTOMER_AP_EMAIL: 'Customer has no AP e-mail',
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The customer's AP e-mails that look like addresses, primary first. */
export function customerApEmails(customer: CustomerBillingFacts | null | undefined): string[] {
  if (!customer) return []
  return [customer.apEmail, ...(customer.apEmailsExtra ?? [])]
    .map((v) => (v ?? '').trim())
    .filter((v) => EMAIL.test(v))
}

/** Factor or Manual. A legacy `factored` flag counts as Factor, as isFactorBilled reads it. */
export function customerBillingMethod(customer: CustomerBillingFacts | null | undefined): 'FACTOR' | 'MANUAL' | null {
  if (!customer) return null
  if (customer.billingMethod === 'FACTOR' || customer.billingMethod === 'MANUAL') return customer.billingMethod
  return customer.factored === true ? 'FACTOR' : null
}

/** What the customer is missing to be billed. No customer = nothing here (the NO_CUSTOMER check owns that). */
export function customerBillingGaps(
  customer: CustomerBillingFacts | null | undefined,
  opts: { apEmailRequired?: boolean } = {},
): CustomerBillingGapCode[] {
  if (!customer) return []
  const gaps: CustomerBillingGapCode[] = []
  if (!customerBillingMethod(customer)) gaps.push('CUSTOMER_BILLING_METHOD')
  if (opts.apEmailRequired !== false && customerApEmails(customer).length === 0) gaps.push('CUSTOMER_AP_EMAIL')
  return gaps
}

/** The Invoice method column: "Factor", "Manual invoice", or '' when the customer has none set. */
export function customerInvoiceMethodText(customer: CustomerBillingFacts | null | undefined): string {
  const method = customerBillingMethod(customer)
  return method === 'FACTOR' ? 'Factor' : method === 'MANUAL' ? 'Manual invoice' : ''
}

/** The AP email column: the first AP address, "Not required" for a waived customer with none, else ''. */
export function customerApEmailText(customer: CustomerBillingFacts | null | undefined, opts: { apEmailRequired?: boolean } = {}): string {
  return customerApEmails(customer)[0] ?? (customer && opts.apEmailRequired === false ? 'Not required' : '')
}

/** "Factor · ap@x.com" for the Customer column; "Manual invoice · AP e-mail: not required" when waived and blank. */
export function customerBillingSummary(
  customer: CustomerBillingFacts | null | undefined,
  opts: { apEmailRequired?: boolean } = {},
): string {
  const method = customerBillingMethod(customer)
  const email = customerApEmails(customer)[0] ?? (customer && opts.apEmailRequired === false ? 'AP e-mail: not required' : null)
  return [method === 'FACTOR' ? 'Factor' : method === 'MANUAL' ? 'Manual invoice' : null, email].filter(Boolean).join(' · ')
}
