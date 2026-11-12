/**
 * Step AW stage D: how a customer is billed (Docs/tms-build/AW-CDE-plan.md D.1, STEP_AW_MERGE_READINESS.md
 * rounds 2 and 3). Pure: the Aljex importer preview, the Billing setup screen, the customer form and the
 * directory Lambda all read the same rules.
 */
import { normalizeCustomerName } from './customerDuplicates'

export type BillingMethod = 'FACTOR' | 'MANUAL'
export const BILLING_METHODS: readonly BillingMethod[] = ['FACTOR', 'MANUAL']

/** The e-billing address Aljex uses for factored customers (the old factoring e-mail bridge). */
export const FACTOR_BILLING_EMAIL = 'ivanfactoring@bcatcorp.com'
/** Internal address that also means FACTOR (UNITED PLASTICS, TOMBO LOGISTICS): round 3. */
export const FACTOR_INTERNAL_EMAIL = 'invoicefactoring@bcatcorp.com'
export const INTERNAL_EMAIL_DOMAIN = '@bcatcorp.com'

export const DEFAULT_TERMS_DAYS = 30
export const DANISCO_TERMS_DAYS = 120
/** Aljex Customer Account #s that carry the Danisco 120-day terms. */
export const DANISCO_ACCOUNTS: readonly string[] = ['100338', '100629']
const DANISCO_NAME_KEYS: readonly string[] = ['danisco us', 'danisco usa']

const EMAIL_RE = /^[^\s@,;<>()[\]]+@[^\s@,;<>()[\]]+\.[^\s@,;<>()[\]]+$/

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim())
}

/** Split on commas, semicolons and whitespace; lowercased, de-duplicated, order kept. */
export function parseEmailList(text: string): string[] {
  const out: string[] = []
  for (const part of String(text ?? '').split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase()
    if (e && !out.includes(e)) out.push(e)
  }
  return out
}

/** Every To address for a manual invoice: the primary AP e-mail first, then the extras, lowercased and de-duplicated. */
export function allApEmails(c: { apEmail?: string | null; apEmailsExtra?: string[] | null } | null | undefined): string[] {
  const out: string[] = []
  for (const raw of [c?.apEmail, ...(c?.apEmailsExtra ?? [])]) {
    const e = String(raw ?? '').trim().toLowerCase()
    if (e && !out.includes(e)) out.push(e)
  }
  return out
}

export function isInternalEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(INTERNAL_EMAIL_DOMAIN)
}

export function isDanisco(accountNumber: string | null | undefined, name: string | null | undefined): boolean {
  const acct = String(accountNumber ?? '').trim()
  if (acct && DANISCO_ACCOUNTS.includes(acct)) return true
  return DANISCO_NAME_KEYS.includes(normalizeCustomerName(name ?? ''))
}

/** Net 30 unless the Aljex row carries its own terms; Danisco (both accounts and name variants) is 120. */
export function paymentTermsFor(row: { accountNumber?: string | null; name?: string | null; aljexTermsDays?: number | null }): number {
  if (isDanisco(row.accountNumber, row.name)) return DANISCO_TERMS_DAYS
  const t = row.aljexTermsDays
  return t != null && Number.isInteger(t) && t >= 0 ? t : DEFAULT_TERMS_DAYS
}

export type SeedAction = 'IMPORT_CUSTOMER' | 'IMPORT_LOCATION' | 'EXCLUDE'

export interface AljexBillingRow {
  accountNumber: string
  name: string
  /** Aljex `E-Billing Email`. */
  eBillingEmail?: string | null
  /** Aljex `Status`: N = inactive. */
  status?: string | null
  aljexTermsDays?: number | null
}

export interface BillingSeed {
  action: SeedAction
  /** Why the row is excluded / becomes a Location. */
  reason: string | null
  billingMethod: BillingMethod | null
  apEmail: string | null
  /** Written so the Missing filter finds the row; null = nothing to review. */
  billingNeedsReview: string | null
  paymentTermsDays: number | null
}

export const TEST_CUSTOMER_ACCOUNT = '100003'

export function isExcludedTestCustomer(accountNumber: string | null | undefined, name: string | null | undefined): boolean {
  if (String(accountNumber ?? '').trim() === TEST_CUSTOMER_ACCOUNT) return true
  const n = String(name ?? '').trim()
  return /^zz/i.test(n) || /\btest\b/i.test(n)
}

/**
 * Seed a customer's billing method from the Aljex row.
 * - TEST CUSTOMER (100003) and ZZ/test names are excluded; GUEST SUPPLY imports like any other.
 * - Status N becomes a Location with no method.
 * - ivanfactoring@ and invoicefactoring@ -> FACTOR (no AP e-mail: the factor handles it).
 * - Any other internal @bcatcorp.com address -> MANUAL, AP e-mail NOT set (it is BCAT's own address),
 *   flagged for review so release refuses until a real AP address is entered.
 * - Any other address -> MANUAL with that address as the AP e-mail.
 * - No address at all -> no method, flagged.
 */
export function seedFromAljexRow(row: AljexBillingRow): BillingSeed {
  const none = { billingMethod: null, apEmail: null, billingNeedsReview: null, paymentTermsDays: null }
  if (isExcludedTestCustomer(row.accountNumber, row.name)) {
    return { action: 'EXCLUDE', reason: 'test customer', ...none }
  }
  if (String(row.status ?? '').trim().toUpperCase() === 'N') {
    return { action: 'IMPORT_LOCATION', reason: 'inactive Aljex customer', ...none }
  }
  const paymentTermsDays = paymentTermsFor(row)
  const email = String(row.eBillingEmail ?? '').trim().toLowerCase()
  const base = { action: 'IMPORT_CUSTOMER' as const, reason: null, paymentTermsDays }
  if (!email) {
    return { ...base, billingMethod: null, apEmail: null, billingNeedsReview: 'no e-billing address in Aljex' }
  }
  if (email === FACTOR_BILLING_EMAIL || email === FACTOR_INTERNAL_EMAIL) {
    return { ...base, billingMethod: 'FACTOR', apEmail: null, billingNeedsReview: null }
  }
  if (isInternalEmail(email)) {
    return { ...base, billingMethod: 'MANUAL', apEmail: null, billingNeedsReview: 'internal billing address: real AP e-mail needed' }
  }
  if (!isValidEmail(email)) {
    return { ...base, billingMethod: 'MANUAL', apEmail: null, billingNeedsReview: 'e-billing address is not a valid e-mail' }
  }
  return { ...base, billingMethod: 'MANUAL', apEmail: email, billingNeedsReview: null }
}

export type BillingIssue = 'METHOD_UNSET' | 'AP_EMAIL_MISSING' | 'NEEDS_REVIEW'

export interface BillingFields {
  billingMethod?: BillingMethod | null
  apEmail?: string | null
  billingNeedsReview?: string | null
}

/** What stops a customer being released to billing (the Billing setup "Missing" filter is issues.length > 0). */
export function billingIssues(c: BillingFields): BillingIssue[] {
  const issues: BillingIssue[] = []
  if (!c.billingMethod) issues.push('METHOD_UNSET')
  else if (c.billingMethod === 'MANUAL' && !(c.apEmail ?? '').trim()) issues.push('AP_EMAIL_MISSING')
  if ((c.billingNeedsReview ?? '').trim()) issues.push('NEEDS_REVIEW')
  return issues
}

/** Validation shared by the form and the Lambda: MANUAL needs a valid AP e-mail; every copy address must be valid. */
export function validateBillingFields(c: BillingFields & { invoiceCopyEmails?: string[] | null; apEmailsExtra?: string[] | null }): Record<string, string> {
  const errors: Record<string, string> = {}
  if (c.billingMethod && !BILLING_METHODS.includes(c.billingMethod)) errors.billingMethod = 'Choose Factor or Manual'
  const ap = (c.apEmail ?? '').trim()
  if (c.billingMethod === 'MANUAL' && !ap) errors.apEmail = 'Manual billing needs the customer’s AP e-mail'
  else if (ap && !isValidEmail(ap)) errors.apEmail = 'Enter a valid e-mail address'
  const badExtra = (c.apEmailsExtra ?? []).filter((e) => !isValidEmail(e))
  if (badExtra.length) errors.apEmailsExtra = `Not a valid e-mail: ${badExtra.join(', ')}`
  const bad = (c.invoiceCopyEmails ?? []).filter((e) => !isValidEmail(e))
  if (bad.length) errors.invoiceCopyEmails = `Not a valid e-mail: ${bad.join(', ')}`
  return errors
}
