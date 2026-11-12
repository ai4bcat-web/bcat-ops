/**
 * Accounting page access (Ryne 2026-11-12): "choose which specific accounting pages
 * users can have access to. If they have access to the page, they can perform any
 * action on that page."
 *
 * One rule, shared by the screens and the Lambdas: the owner and the Cognito ADMIN
 * group open every accounting page; anyone else needs that page's `page-<key>` group,
 * and holding it opens every action on the page — viewing, editing, sending, posting
 * payments. There is no second "may post" layer behind the page any more.
 *
 * Two things stay admin-only because they are not actions *on* the page: the settings
 * that configure a desk (SAVE_*_SETTINGS) and moving an invoiced shipment to another
 * customer. Deleting a factoring row also stays with the people who run factoring.
 *
 * Pure: no store, no network, relative imports only — the Lambdas bundle this by path.
 */
import { OWNER_EMAIL } from './auth/admin'

export interface AccountingPage {
  key: string
  label: string
  /** What holding the page lets someone do, in one line for the Users page. */
  covers: string
}

/** The accounting pages Ryne grants per user, in the order the Users page lists them. */
export const ACCOUNTING_PAGES: readonly AccountingPage[] = [
  { key: 'loadReview', label: 'Load review', covers: 'Check delivered loads and move them to billing' },
  { key: 'invoicing', label: 'Accounts receivable / Invoicing', covers: 'Generate, preview, edit, send and factor invoices; record payments, credits and write-offs' },
  { key: 'factoring', label: 'Factoring', covers: 'The OTR queue: submit, resend and set customer-paid dates' },
  { key: 'carrierPay', label: 'Accounts payable', covers: 'Carrier bills: dates, approve, select for payment, pay and send remittance' },
  { key: 'vendorAp', label: 'Vendor AP queue', covers: 'Office and vendor bills' },
  { key: 'ownerOperatorPay', label: 'Owner operator settlements', covers: 'Owner operator and Amazon-week settlements' },
  { key: 'driverPayBoxTrucks', label: 'Box truck settlements', covers: 'Box truck driver settlements' },
  { key: 'hours', label: 'Employee hours', covers: 'Time cards, PTO days and hourly pay' },
  { key: 'commissions', label: 'Commissions', covers: 'Run, approve and pay sales commissions' },
  { key: 'finances', label: 'Finances', covers: 'Expenses, financial operations and profit review' },
  { key: 'cashCheckIn', label: 'Weekly cash check-in', covers: 'The weekly cash check-in' },
]

export const ACCOUNTING_PAGE_KEYS: readonly string[] = ACCOUNTING_PAGES.map((p) => p.key)

/**
 * Older grants that still open an accounting page, so nobody loses access when the
 * model changes. `billingRelease` was "Release to billing / Send invoice": it is
 * read as Load review + Invoicing. Invoicing also opens Factoring, because the
 * factoring queue is moving into the Invoicing page.
 */
const IMPLIED_BY: Record<string, readonly string[]> = {
  loadReview: ['billingRelease'],
  invoicing: ['billingRelease'],
  factoring: ['invoicing', 'billingRelease'],
}

export function isOwnerOrAdmin(groups: readonly string[] | null | undefined, email: string | null | undefined): boolean {
  return (groups ?? []).includes('ADMIN') || (email ?? '').trim().toLowerCase() === OWNER_EMAIL
}

/** Whether the caller may use an accounting page — and so every action on it. */
export function hasAccountingPage(
  groups: readonly string[] | null | undefined,
  email: string | null | undefined,
  key: string,
): boolean {
  if (isOwnerOrAdmin(groups, email)) return true
  const list = groups ?? []
  if (list.includes(`page-${key}`)) return true
  return (IMPLIED_BY[key] ?? []).some((k) => list.includes(`page-${k}`))
}

export function accountingPageLabel(key: string): string {
  return ACCOUNTING_PAGES.find((p) => p.key === key)?.label ?? key
}

/** The refusal both the screens and the Lambdas show: it names the page. */
export function accountingAccessMessage(key: string): string {
  return `You need access to ${accountingPageLabel(key)} (Settings > Users).`
}
