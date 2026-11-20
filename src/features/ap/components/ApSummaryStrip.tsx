/**
 * The totals above the Payables tabs, shown on every tab in two compact rows like the Factoring tab:
 * a row of headline tiles (open, the ladder, past due and due this week, which opens the
 * cash-requirements report), then a row of short list cards (paid this week and month with quick pay,
 * who it is paid to, how fast we pay, and open AP by revenue division, each row a filter). Other
 * cards for the active tab ride in the second row.
 */
import type { ReactNode } from 'react'
import { TmsListCard, TmsStatRow, breakdownListRows } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import type { ApSummary } from '../apQueue'
import { apDivisionRows } from './apDivisionRows'

const bills = (n: number) => `${n} ${n === 1 ? 'bill' : 'bills'}`

export function ApSummaryStrip({ summary, divisionName, division, onDivision, onCashRequirements, onTab, children }: {
  summary: ApSummary
  divisionName: (code: string | null) => string
  /** The active division filter key, or null. */
  division: string | null
  onDivision: (key: string | null) => void
  onCashRequirements: () => void
  onTab: (tab: 'expected' | 'aging' | 'selected') => void
  /** More cards for the second row (the active tab's card, the profit check, the owed filter). */
  children?: ReactNode
}) {
  const s = summary
  const days = (n: number | null) => (n == null ? null : `${n} d`)
  const rows = apDivisionRows(s.byDivision, divisionName, s.open.cents)
  return (
    <div data-testid="ap-summary">
      <div className="tms-factoring-totals" style={{ padding: '0 8px' }}>
        <TmsStatRow
          aria-label="Open payables and the payment ladder"
          columns="auto"
          compact
          caps
          items={[
            { key: 'open', label: 'Open AP', value: formatCents(s.open.cents), sub: bills(s.open.count), ariaLabel: `Open AP: ${formatCents(s.open.cents)} across ${bills(s.open.count)}` },
            { key: 'expected', label: 'Expected', value: formatCents(s.expected.cents), sub: `${bills(s.expected.count)} · needs invoice date`, tone: s.expected.count ? 'warn' : 'default', onClick: () => onTab('expected') },
            { key: 'aging', label: 'Aging', value: formatCents(s.aging.cents), sub: bills(s.aging.count), onClick: () => onTab('aging') },
            { key: 'selected', label: 'Selected', value: formatCents(s.selected.cents), sub: `${bills(s.selected.count)} · next payment run`, onClick: () => onTab('selected') },
            { key: 'past-due', label: 'Past due', value: formatCents(s.pastDue.cents), sub: bills(s.pastDue.count), tone: s.pastDue.cents > 0 ? 'bad' : 'default', onClick: onCashRequirements },
            { key: 'next7', label: 'Due next 7 days', value: formatCents(s.dueNext7.cents), sub: bills(s.dueNext7.count), onClick: onCashRequirements },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-start gap-2" style={{ padding: '6px 8px 4px' }} data-testid="ap-summary-cards">
        <TmsListCard
          title="Paid"
          aria-label="Paid to carriers"
          testId="ap-paid-card"
          rows={[
            { key: 'paid-week', label: 'Paid this week', value: formatCents(s.paidWeek.cents), sub: bills(s.paidWeek.count), title: `${bills(s.paidWeek.count)} · net paid to carriers since Monday` },
            { key: 'paid-month', label: 'Paid this month', value: formatCents(s.paidMonth.cents), sub: bills(s.paidMonth.count), title: `${bills(s.paidMonth.count)} · net paid to carriers this month` },
            {
              key: 'quick',
              label: 'Quick pay this month',
              value: formatCents(s.quickPay.feeCents),
              sub: bills(s.quickPay.count),
              title: `${bills(s.quickPay.count)} · 6%: ${formatCents(s.quickPay.fee6Cents)} · 3%: ${formatCents(s.quickPay.fee3Cents)}`,
            },
          ]}
        />
        <TmsListCard
          title="Paid to"
          aria-label="Who open payables are paid to"
          testId="ap-payto-card"
          total={formatCents(s.open.cents)}
          rows={[
            { key: 'factor', label: 'Pay to factor', value: formatCents(s.payToFactor.cents), sub: bills(s.payToFactor.count) },
            { key: 'direct', label: 'Pay direct', value: formatCents(s.payDirect.cents), sub: bills(s.payDirect.count) },
            ...(s.fromAljex.count > 0
              ? [{ key: 'aljex', label: 'From Aljex', value: formatCents(s.fromAljex.cents), sub: bills(s.fromAljex.count), title: `${bills(s.fromAljex.count)} brought over from Aljex · counted in every total here` }]
              : []),
          ]}
        />
        <TmsListCard
          title="How fast"
          aria-label="How fast carriers are invoiced and paid"
          testId="ap-speed-card"
          rows={[
            { key: 'days-pay', label: 'Days to pay · carriers', value: days(s.avgDaysToPay), sub: 'last 90 d', title: `Invoice → paid, last 90 days${s.avgDaysToPayCount ? ` · ${bills(s.avgDaysToPayCount)}` : ''}` },
            { key: 'days-inv', label: 'Days to invoice · carriers', value: days(s.avgDaysToInvoice), sub: 'avg', title: s.avgDaysToInvoiceCount ? `Delivery → carrier invoice, average · ${bills(s.avgDaysToInvoiceCount)}` : 'Delivery → carrier invoice, average' },
          ]}
        />
        {rows.length > 0 && (
          <TmsListCard
            title="Open AP by division"
            total={formatCents(s.open.cents)}
            testId="ap-division-card"
            rows={breakdownListRows(rows, division, onDivision)}
          />
        )}
        {children}
      </div>
    </div>
  )
}
