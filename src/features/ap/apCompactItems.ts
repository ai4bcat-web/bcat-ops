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
    { key: 'past-due', label: 'Past due', value: formatCents(s.pastDue.cents), sub: bills(s.pastDue.count), tone: s.pastDue.cents > 0 ? 'bad' : 'default' },
  ]
}
