/**
 * The Invoicing status tabs' labels and badges (Ryne 2026-11-15: every badge must tie to a number on
 * the cards). One set of definitions, shared with the Receivables card:
 *  - Invoiced = sent, unpaid invoices. With Billed: All it is "Open AR"; Manually invoiced is
 *    "Pending with shippers"; Factoring is "Factored, open". The label says which.
 *  - Paid = invoices settled in the chosen month by paid date. With Billed: All and this month it is
 *    "Collected this month".
 *  - Aging = the same invoices as "Open AR" (any billing), counted in invoices, not customers.
 *  - Payments, credits and debits live on their own page, Accounting → Payments received (Ryne 2026-11-15).
 *  - Needs review counts loads flagged for a finance check, not invoices.
 */
import type { TmsTab } from '@/features/tms/kit'
import type { TmsSummaryChip } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import type { ArBilledBy } from './arQueue'
import type { ArSummary } from './arSummary'
import type { InvoiceRecord } from '@/types/tms'

interface CountTotal { count: number; total: string }

const INVOICED_LABEL: Record<ArBilledBy, string> = {
  all: 'Invoiced',
  manual: 'Invoiced to shippers',
  factored: 'Invoiced through OTR',
}

const PAID_LABEL: Record<ArBilledBy, (month: string) => string> = {
  all: (m) => `Paid in ${m}`,
  manual: (m) => `Paid by shippers in ${m}`,
  factored: (m) => `Paid through OTR in ${m}`,
}

/** `November 2026` → `Nov`. */
const shortMonth = (label: string) => label.slice(0, 3)

export function arTabs(input: {
  billedBy: ArBilledBy
  /** The Paid tab's month, as `monthLabel` writes it. */
  paidMonthLabel: string
  ready: CountTotal
  invoiced: CountTotal
  paid: CountTotal
  aging: CountTotal
  review: number
}): TmsTab[] {
  const { billedBy } = input
  return [
    { key: 'ready', label: `Ready to invoice · ${input.ready.total}`, count: input.ready.count, testId: 'ar-tab-ready',
      title: 'Released from Load Review, invoice not sent yet. Same as "Ready" on the Ready to invoice card.' },
    { key: 'invoiced', label: `${INVOICED_LABEL[billedBy]} · ${input.invoiced.total} open`, count: input.invoiced.count, testId: 'ar-tab-invoiced',
      title: billedBy === 'all' ? 'Sent and unpaid. Same as "Open AR".'
        : billedBy === 'manual' ? 'Sent to the customer and unpaid. Same as "Pending with shippers". Pick Billed: All to see OTR too.'
          : 'Factored through OTR and unpaid. Same as "Factored, open". Pick Billed: All to see shippers too.' },
    { key: 'paid', label: `${PAID_LABEL[billedBy](shortMonth(input.paidMonthLabel))} · ${input.paid.total}`, count: input.paid.count, testId: 'ar-tab-paid',
      title: `Invoices paid in full in ${input.paidMonthLabel}, by paid date.${billedBy === 'all' ? ' This month it is the same as "Collected this month".' : ''}` },
    { key: 'aging', label: `Aging · ${input.aging.total} open`, count: input.aging.count, testId: 'ar-tab-aging',
      title: 'Every open invoice by age, any billing. Same as "Open AR".' },
    { key: 'review', label: 'Needs review', count: input.review, testId: 'ar-tab-review',
      title: 'Loads flagged for a finance check (not invoices).' },
  ]
}

/** The headline numbers shown when the cards are collapsed; each is a row of the Receivables card. */
export function arCompactItems(summary: ArSummary): TmsSummaryChip[] {
  const inv = (n: number) => `${n} ${n === 1 ? 'invoice' : 'invoices'}`
  return [
    { key: 'open', label: 'Open AR', value: formatCents(summary.openCents), sub: inv(summary.openCount) },
    { key: 'otr', label: 'Factored, open', value: formatCents(summary.pendingOtrCents), sub: inv(summary.pendingOtrCount) },
    { key: 'otr-waiting', label: 'Waiting on OTR approval', value: formatCents(summary.factored.WAITING.cents), sub: inv(summary.factored.WAITING.count) },
    { key: 'shippers', label: 'Pending with shippers', value: formatCents(summary.pendingShippersCents), sub: inv(summary.pendingShippersCount) },
    { key: 'late', label: 'Late', value: formatCents(summary.lateCents), sub: inv(summary.lateCount), tone: summary.lateCents > 0 ? 'bad' : 'default' },
    { key: 'month', label: 'Collected this month', value: formatCents(summary.collectedMonthCents), sub: inv(summary.collectedMonthCount) },
  ]
}

/** Invoices paid in full in `month` (`YYYY-MM`), by paid date, once each: the Paid tab's rows. */
export function paidInMonthOf(invoices: readonly InvoiceRecord[], month: string): InvoiceRecord[] {
  const seen = new Set<string>()
  const out: InvoiceRecord[] = []
  for (const inv of invoices) {
    if (inv.status !== 'PAID' || (inv.paidAt ?? '').slice(0, 7) !== month || seen.has(inv.id)) continue
    seen.add(inv.id)
    out.push(inv)
  }
  return out
}
