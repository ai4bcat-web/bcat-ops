/** Open AR by division as breakdown rows for the Invoicing summary. */
import type { TmsBreakdownRow } from '@/features/tms/kit/TmsBreakdownCard'
import { formatCents } from '@/lib/invoiceBuild'
import type { ArDivisionSlice } from './arSummary'

const invoices = (n: number) => `${n} ${n === 1 ? 'invoice' : 'invoices'}`

/**
 * Division rows, sub-divisions indented under a group row that carries their subtotal. A division
 * with no sub-division slices is a single row. The group row filters on the division-only slice
 * when one exists; otherwise it is shown but not selectable.
 */
export function divisionRows(slices: ArDivisionSlice[], totalCents: number): TmsBreakdownRow[] {
  const share = (cents: number) => (totalCents > 0 ? cents / totalCents : null)
  const groups = new Map<string, ArDivisionSlice[]>()
  for (const slice of slices) groups.set(slice.division, [...(groups.get(slice.division) ?? []), slice])
  const sum = (group: ArDivisionSlice[]) => group.reduce((n, s) => n + s.cents, 0)
  const rows: TmsBreakdownRow[] = []
  for (const [division, group] of [...groups.entries()].sort((a, b) => sum(b[1]) - sum(a[1]))) {
    const subs = group.filter((s) => s.subLabel).sort((a, b) => b.cents - a.cents)
    const own = group.find((s) => !s.subLabel)
    const label = group[0]?.divisionLabel ?? division
    if (subs.length === 0) {
      const cents = own?.cents ?? 0
      rows.push({ key: own?.key ?? division, label, value: formatCents(cents), share: share(cents), title: own ? invoices(own.count) : undefined })
      continue
    }
    const groupCents = sum(group)
    rows.push({
      key: own?.key ?? `${division}:group`,
      label,
      value: formatCents(groupCents),
      share: share(groupCents),
      kind: 'group',
      readOnly: !own,
      title: own ? `${label} without a sub-division: ${formatCents(own.cents)}` : undefined,
    })
    for (const sub of subs) {
      rows.push({ key: sub.key, label: sub.subLabel ?? sub.label, value: formatCents(sub.cents), share: share(sub.cents), kind: 'sub', title: invoices(sub.count) })
    }
  }
  return rows
}

