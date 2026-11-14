/**
 * Mark paid (Ryne, 2026-11-14): one or many sent invoices, each with its own paid date, ACH or
 * paper check, check/ref # and amount. The dialog's top fields are defaults that fill every row
 * the user has not edited by hand.
 *
 * Rows that share customer, date, method and reference are one check (or one ACH), so they
 * post as ONE `RECORD_PAYMENT` with an application per invoice — the same path Receive payment
 * uses, so balances, the Paid tab and the audit log stay consistent. A row paying less than its
 * open balance is a partial payment: the invoice stays in Invoiced with the rest open.
 * Amounts over the open balance are refused (an overpayment goes through Receive payment,
 * which can keep it as customer credit).
 */
import type { InvoiceRecord, PaymentApplication } from '@/types/tms'
import { centsFromInput, inputFromCents } from './components/money'

export type MarkPaidMethod = 'ACH' | 'CHECK'

export const MARK_PAID_METHOD_LABEL: Record<MarkPaidMethod, string> = { ACH: 'ACH', CHECK: 'Paper check' }

export interface MarkPaidDefaults {
  /** YYYY-MM-DD or ''. */
  paidOn: string
  method: MarkPaidMethod
  reference: string
}

export interface MarkPaidRow {
  invoiceId: string
  paidOn: string
  method: MarkPaidMethod
  reference: string
  /** Typed dollars. */
  amount: string
  /** Fields the user changed on this row; a new default leaves them alone. */
  edited: { paidOn?: boolean; method?: boolean; reference?: boolean }
}

export function initialRows(invoices: InvoiceRecord[], defaults: MarkPaidDefaults): MarkPaidRow[] {
  return invoices.map((inv) => ({
    invoiceId: inv.id,
    paidOn: defaults.paidOn,
    method: defaults.method,
    reference: defaults.reference,
    amount: inputFromCents(inv.balanceCents),
    edited: {},
  }))
}

/** A new top default flows into every row that has not been edited by hand for that field. */
export function applyDefaults(rows: MarkPaidRow[], defaults: MarkPaidDefaults): MarkPaidRow[] {
  return rows.map((row) => ({
    ...row,
    paidOn: row.edited.paidOn ? row.paidOn : defaults.paidOn,
    method: row.edited.method ? row.method : defaults.method,
    reference: row.edited.reference ? row.reference : defaults.reference,
  }))
}

export function editRow(rows: MarkPaidRow[], invoiceId: string, patch: Partial<Pick<MarkPaidRow, 'paidOn' | 'method' | 'reference' | 'amount'>>): MarkPaidRow[] {
  return rows.map((row) => {
    if (row.invoiceId !== invoiceId) return row
    const edited = { ...row.edited }
    if (patch.paidOn !== undefined) edited.paidOn = true
    if (patch.method !== undefined) edited.method = true
    if (patch.reference !== undefined) edited.reference = true
    return { ...row, ...patch, edited }
  })
}

/** What is wrong with one row, or null. */
export function rowProblem(row: MarkPaidRow, invoice: InvoiceRecord | undefined, today: string): string | null {
  if (!invoice) return 'Invoice not found'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.paidOn)) return 'Paid date as MM/DD/YYYY'
  if (row.paidOn > today) return 'Paid date is in the future'
  if (row.method === 'CHECK' && !row.reference.trim()) return 'Check # is required for a paper check'
  const cents = centsFromInput(row.amount)
  if (cents == null || cents <= 0) return 'Amount paid must be more than $0'
  if (cents > invoice.balanceCents) return 'More than the open balance — use Receive payment for an overpayment'
  return null
}

export function rowCents(row: MarkPaidRow): number {
  return centsFromInput(row.amount) ?? 0
}

export interface MarkPaidPosting {
  /** Stable within one dialog, so a retried post is the same request. */
  key: string
  customerId: string
  receivedAt: string
  method: MarkPaidMethod
  reference?: string
  amountCents: number
  applications: PaymentApplication[]
  invoiceIds: string[]
}

/** Rows grouped into payments: one per customer + date + method + reference. */
export function planPostings(rows: MarkPaidRow[], invoicesById: Map<string, InvoiceRecord>): MarkPaidPosting[] {
  const out = new Map<string, MarkPaidPosting>()
  for (const row of rows) {
    const inv = invoicesById.get(row.invoiceId)
    if (!inv) continue
    const reference = row.reference.trim()
    const key = [inv.customerId, row.paidOn, row.method, reference.toUpperCase()].join('|')
    const cents = rowCents(row)
    const posting = out.get(key) ?? {
      key, customerId: inv.customerId, receivedAt: row.paidOn, method: row.method,
      ...(reference ? { reference } : {}), amountCents: 0, applications: [], invoiceIds: [],
    }
    posting.amountCents += cents
    posting.applications.push({ invoiceId: inv.id, amountCents: cents })
    posting.invoiceIds.push(inv.id)
    out.set(key, posting)
  }
  return [...out.values()]
}
