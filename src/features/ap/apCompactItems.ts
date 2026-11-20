import type { TmsSummaryChip } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import type { ApSummary } from './apQueue'

const bills = (n: number) => `${n} ${n === 1 ? 'bill' : 'bills'}`

/** The Payables headline numbers shown while the cards are collapsed; each is a row of the Payables card. */
export function apCompactItems(s: ApSummary): TmsSummaryChip[] {
  return [
    { key: 'open', label: 'Open AP', value: formatCents(s.open.cents), sub: bills(s.open.count) },
    { key: 'expected', label: 'Expected', value: formatCents(s.expected.cents), sub: bills(s.expected.count), tone: s.expected.count ? 'warn' : 'default' },
    { key: 'aging', label: 'Aging', value: formatCents(s.aging.cents), sub: bills(s.aging.count) },
    { key: 'selected', label: 'Selected', value: formatCents(s.selected.cents), sub: bills(s.selected.count) },
    { key: 'past-due', label: 'Past due', value: formatCents(s.pastDue.cents), sub: s.expectedLate.count > 0 ? `${bills(s.pastDue.count)} · +${s.expectedLate.count} expected, not invoiced` : bills(s.pastDue.count), tone: s.pastDue.cents > 0 ? 'bad' : 'default' },
    { key: 'next7', label: 'Due within 7 days', value: formatCents(s.dueNext7.cents), sub: bills(s.dueNext7.count) },
  ]
}
