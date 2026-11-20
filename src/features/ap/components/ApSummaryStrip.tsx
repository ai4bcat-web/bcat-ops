/**
 * The totals above the Payables tabs, shown on every tab in two compact rows like the Factoring tab: the
 * headline tiles (open, the ladder, past due and due this week, which opens the cash-requirements report),
 * then at most three small cards: paid this week and month, open bills by due date (past due, this week,
 * later) and payees missing payment info. Granular figures (paid-to split, days to pay, division split,
 * quick pay) stay in `ApSummary` and the Reports menu; the division split is the Rev division filter.
 */
import { TmsListCard, TmsStatRow } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import type { DueBucket } from '@/features/ar/owedFilters'
import type { ApSummary } from '../apQueue'

const bills = (n: number) => `${n} ${n === 1 ? 'bill' : 'bills'}`

export function ApSummaryStrip({ summary, due, onDue, missing, onCashRequirements, onTab }: {
  summary: ApSummary
  /** The active due-bucket filter, or null. */
  due: DueBucket | null
  onDue: (bucket: DueBucket | null) => void
  /** Payees whose bills cannot be paid yet; opens the fix-it worklist. Hidden when there are none. */
  missing: { payees: number; cents: number; onOpen: () => void }
  onCashRequirements: () => void
  onTab: (tab: 'expected' | 'aging' | 'selected') => void
}) {
  const s = summary
  // Later is what is open and neither past due nor due this week, so the three rows always add up to Open AP.
  const laterCents = Math.max(0, s.open.cents - s.pastDue.cents - s.dueNext7.cents)
  const laterCount = Math.max(0, s.open.count - s.pastDue.count - s.dueNext7.count)
  const pick = (bucket: DueBucket) => () => onDue(due === bucket ? null : bucket)
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
            { key: 'next7', label: 'Due within 7 days', value: formatCents(s.dueNext7.cents), sub: bills(s.dueNext7.count), onClick: onCashRequirements },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-start gap-2" style={{ padding: '6px 8px 4px' }} data-testid="ap-summary-cards">
        <TmsListCard
          title="Paid"
          aria-label="Paid to carriers"
          testId="ap-paid-card"
          rows={[
            { key: 'paid-week', label: 'This week', value: formatCents(s.paidWeek.cents), sub: bills(s.paidWeek.count), title: `${bills(s.paidWeek.count)} · net paid to carriers since Monday` },
            { key: 'paid-month', label: 'This month', value: formatCents(s.paidMonth.cents), sub: bills(s.paidMonth.count), title: `${bills(s.paidMonth.count)} · net paid to carriers this month` },
          ]}
        />
        <TmsListCard
          title="Open bills by due date"
          total={formatCents(s.open.cents)}
          testId="ap-due-card"
          rows={[
            { key: 'past', label: 'Past due', value: formatCents(s.pastDue.cents), sub: bills(s.pastDue.count), tone: s.pastDue.cents > 0 ? 'bad' : 'default', onClick: pick('past'), active: due === 'past' },
            { key: 'week', label: 'Due this week', value: formatCents(s.dueNext7.cents), sub: bills(s.dueNext7.count), onClick: pick('week'), active: due === 'week' },
            { key: 'later', label: 'Later', value: formatCents(laterCents), sub: bills(laterCount), title: `${bills(laterCount)} · due after this week, or waiting on a due date` },
          ]}
        />
        {missing.payees > 0 && (
          <TmsListCard
            title="Missing payment info"
            testId="ap-missing-card"
            rows={[
              {
                key: 'missing',
                label: missing.payees === 1 ? '1 payee' : `${missing.payees} payees`,
                value: formatCents(missing.cents),
                sub: 'waiting',
                tone: 'warn',
                onClick: missing.onOpen,
                title: 'These payees have no pay-to, or are missing the bank info (or address) their payment method needs. Their bills cannot be paid until it is added. Click to fix each one.',
              },
            ]}
          />
        )}
      </div>
    </div>
  )
}
