/**
 * The totals beside the Payables tabs, shown on every tab as two list cards: what is open and where
 * it sits on the ladder, what is late and due this week (opens the cash-requirements report), who it
 * is paid to, quick pay this month, how fast we pay; and open AP by revenue division (each row a filter).
 */
import { TmsListCard, breakdownListRows } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import type { ApSummary } from '../apQueue'
import { apDivisionRows } from './apDivisionRows'

const bills = (n: number) => `${n} ${n === 1 ? 'bill' : 'bills'}`

export function ApSummaryStrip({ summary, divisionName, division, onDivision, onCashRequirements, onTab }: {
  summary: ApSummary
  divisionName: (code: string | null) => string
  /** The active division filter key, or null. */
  division: string | null
  onDivision: (key: string | null) => void
  onCashRequirements: () => void
  onTab: (tab: 'expected' | 'aging' | 'selected') => void
}) {
  const s = summary
  const days = (n: number | null) => (n == null ? null : `${n} d`)
  const rows = apDivisionRows(s.byDivision, divisionName, s.open.cents)
  return (
    <>
      <TmsListCard
        title="Payables"
        aria-label="Open payables"
        testId="ap-summary"
        rows={[
          { key: 'open', label: 'Open AP', value: formatCents(s.open.cents), sub: bills(s.open.count) },
          { key: 'expected', label: 'Expected', value: formatCents(s.expected.cents), sub: bills(s.expected.count), title: `${bills(s.expected.count)} · needs invoice date`, tone: s.expected.count ? 'warn' : 'default', onClick: () => onTab('expected') },
          { key: 'aging', label: 'Aging', value: formatCents(s.aging.cents), sub: bills(s.aging.count), onClick: () => onTab('aging') },
          { key: 'selected', label: 'Selected', value: formatCents(s.selected.cents), sub: bills(s.selected.count), title: `${bills(s.selected.count)} · next payment run`, onClick: () => onTab('selected') },
          { key: 'past-due', label: 'Past due', value: formatCents(s.pastDue.cents), sub: bills(s.pastDue.count), tone: s.pastDue.cents > 0 ? 'bad' : 'default', onClick: onCashRequirements },
          { key: 'next7', label: 'Due next 7 days', value: formatCents(s.dueNext7.cents), sub: bills(s.dueNext7.count), title: `${bills(s.dueNext7.count)} · opens cash requirements`, onClick: onCashRequirements },
          { key: 'factor', label: 'Pay to factor', value: formatCents(s.payToFactor.cents), sub: bills(s.payToFactor.count) },
          { key: 'direct', label: 'Pay direct', value: formatCents(s.payDirect.cents), sub: bills(s.payDirect.count) },
          {
            key: 'quick',
            label: 'Quick pay this month',
            value: formatCents(s.quickPay.feeCents),
            sub: bills(s.quickPay.count),
            title: `${bills(s.quickPay.count)} · 6%: ${formatCents(s.quickPay.fee6Cents)} · 3%: ${formatCents(s.quickPay.fee3Cents)}`,
          },
          { key: 'days-pay', label: 'Avg days to pay carriers', value: days(s.avgDaysToPay), sub: 'last 90 d', title: `Invoice → paid, last 90 days${s.avgDaysToPayCount ? ` · ${bills(s.avgDaysToPayCount)}` : ''}` },
          { key: 'days-inv', label: 'Delivery → carrier invoice', value: days(s.avgDaysToInvoice), sub: 'avg', title: s.avgDaysToInvoiceCount ? `Average · ${bills(s.avgDaysToInvoiceCount)}` : 'Average' },
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
    </>
  )
}
