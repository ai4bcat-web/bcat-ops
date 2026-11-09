/**
 * What a NEW customer must carry before it is saved (Ryne's New Customer form). Pure: the form
 * (field errors, the "Missing: ..." list) and the directory Lambda (CREATE only) read the same rules,
 * so the two cannot drift. Editing an existing customer never runs these.
 */
import { isValidEmail } from './billingMethod'

/** Ivan Cartage, the top-level OwnershipDivision a new customer's revenue defaults to. */
export const DEFAULT_NEW_CUSTOMER_DIVISION = 'ASSETS'
/** $1,000,000, as integer cents (Customer.creditLimitCents). */
export const DEFAULT_NEW_CUSTOMER_CREDIT_LIMIT_CENTS = 100_000_000
/** Every customer invoice is copied here; the form pre-fills it and the server forces it into the stored list. */
export const REQUIRED_INVOICE_COPY_EMAIL = 'invoices@bcatcorp.com'

/** Ryne's wording for the two stored methods. */
export const BILLING_METHOD_CHOICES = [
  { value: 'FACTOR', label: 'Factor' },
  { value: 'MANUAL', label: 'Invoice manually' },
] as const

export type NewCustomerField = 'name' | 'address' | 'billingMethod' | 'defaultDivisionKey' | 'apEmail' | 'invoiceCopyEmails'

export interface NewCustomerProblem {
  field: NewCustomerField
  /** Short name for the "Missing: ..." list. */
  label: string
  /** The inline error under the field. */
  message: string
}

export interface NewCustomerFields {
  name?: string | null
  billingAddress?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null
  billingMethod?: string | null
  defaultDivisionKey?: string | null
  apEmail?: string | null
  invoiceCopyEmails?: string[] | null
}

const blank = (v: string | null | undefined): boolean => !(v ?? '').trim()

/** The copy list as stored: lower-cased, de-duplicated, with the always-copy address first. */
export function withRequiredCopyEmail(list: readonly string[] | null | undefined): string[] {
  const out: string[] = [REQUIRED_INVOICE_COPY_EMAIL]
  for (const e of list ?? []) {
    const lower = String(e).trim().toLowerCase()
    if (lower && !out.includes(lower)) out.push(lower)
  }
  return out
}

/** Everything wrong with a new customer, in form order. Empty = ready to save. */
export function newCustomerProblems(c: NewCustomerFields): NewCustomerProblem[] {
  const out: NewCustomerProblem[] = []
  if (blank(c.name)) out.push({ field: 'name', label: 'Name', message: 'Name is required' })
  const a = c.billingAddress
  if (blank(a?.street) || blank(a?.city) || blank(a?.state) || blank(a?.zip)) {
    out.push({ field: 'address', label: 'Address', message: 'Address is required: street, city, state and ZIP' })
  }
  const method = (c.billingMethod ?? '').trim()
  if (!method) out.push({ field: 'billingMethod', label: 'Billing method', message: 'Choose Factor or Invoice manually' })
  else if (!BILLING_METHOD_CHOICES.some((m) => m.value === method)) {
    out.push({ field: 'billingMethod', label: 'Billing method', message: 'Choose Factor or Invoice manually' })
  }
  if (blank(c.defaultDivisionKey)) out.push({ field: 'defaultDivisionKey', label: 'Default rev division', message: 'Choose a default rev division' })
  const ap = (c.apEmail ?? '').trim()
  if (!ap) out.push({ field: 'apEmail', label: 'AP e-mail 1', message: 'Accounts payable e-mail 1 is required' })
  else if (!isValidEmail(ap)) out.push({ field: 'apEmail', label: 'AP e-mail 1', message: 'Enter a valid e-mail address' })
  const bad = (c.invoiceCopyEmails ?? []).filter((e) => !isValidEmail(e))
  if (bad.length) out.push({ field: 'invoiceCopyEmails', label: 'AP copy-to e-mail', message: `Not a valid e-mail: ${bad.join(', ')}` })
  return out
}

/** `Missing: Billing method, AP e-mail 1` — null when nothing is missing. */
export function missingSummary(problems: readonly NewCustomerProblem[]): string | null {
  return problems.length ? `Missing: ${problems.map((p) => p.label).join(', ')}` : null
}
