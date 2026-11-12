/** Open AP by revenue division as breakdown rows for the Payables summary. */
import type { TmsBreakdownRow } from '@/features/tms/kit/TmsBreakdownCard'
import { formatCents } from '@/lib/invoiceBuild'
import type { ApDivisionSlice } from '../apQueue'

const bills = (n: number) => `${n} ${n === 1 ? 'bill' : 'bills'}`

/** Division rows with their sub-divisions indented beneath; the division row carries the subtotal. */
export function apDivisionRows(slices: ApDivisionSlice[], divisionName: (code: string | null) => string, totalCents: number): TmsBreakdownRow[] {
  const share = (cents: number) => (totalCents > 0 ? cents / totalCents : null)
  const tops = slices.filter((s) => !s.subdivision).sort((a, b) => b.cents - a.cents)
  const rows: TmsBreakdownRow[] = []
  for (const top of tops) {
    const subs = slices.filter((s) => s.subdivision && s.division === top.division).sort((a, b) => b.cents - a.cents)
    rows.push({ key: top.key, label: divisionName(top.division), value: formatCents(top.cents), share: share(top.cents), kind: subs.length ? 'group' : 'row', title: bills(top.count) })
    for (const sub of subs) {
      rows.push({ key: sub.key, label: divisionName(sub.subdivision), value: formatCents(sub.cents), share: share(sub.cents), kind: 'sub', title: bills(sub.count) })
    }
  }
  return rows
}

